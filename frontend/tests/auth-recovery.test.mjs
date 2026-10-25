import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');
const axios = require('axios');
const compiled = mkdtempSync(join(tmpdir(), 'prayaas-auth-'));
symlinkSync(join(frontend, 'node_modules'), join(compiled, 'node_modules'), 'dir');
for (const name of ['api', 'auth', 'report-stream', 'report-notebook']) {
  const source = readFileSync(join(frontend, 'lib', `${name}.ts`), 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  writeFileSync(join(compiled, `${name}.js`), result.outputText);
}
process.on('exit', () => rmSync(compiled, { recursive: true, force: true }));
const { default: api, authApi, extractError } = require(join(compiled, 'api.js'));
const auth = require(join(compiled, 'auth.js'));
const { ReportStreamReader } = require(join(compiled, 'report-stream.js'));
const { composeReport, parseSavedReport, clearLocalReport, LOCAL_DRAFT_PREFIX } = require(join(compiled, 'report-notebook.js'));
const user = { id: 1, name: 'Test', email: 'test@example.com', flat_number: 'QA', avatar_color: '#4f8ef7' };
function response(config, status, data = {}) {
  const result = { data, status, statusText: String(status), headers: {}, config };
  if (status >= 400) throw new axios.AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, result);
  return result;
}

test('concurrent expired requests all settle when refresh fails', { timeout: 3000 }, async () => {
  auth.setUser(user);
  auth.setAccessToken('expired');
  let refreshes = 0;
  api.defaults.adapter = async (config) => {
    if (config.url === '/api/auth/refresh') {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response(config, 503);
    }
    return response(config, 401);
  };
  const outcomes = await Promise.allSettled([api.get('/api/groups/my'), api.get('/api/problems')]);
  assert.equal(refreshes, 1);
  assert.ok(outcomes.every((outcome) => outcome.status === 'rejected'));
  assert.equal(auth.getUser(), user, 'A temporary outage must preserve the resident session');
});

test('concurrent expired requests recover with one refresh and new credentials', async () => {
  auth.setUser(user);
  auth.setAccessToken('expired');
  let refreshes = 0;
  api.defaults.adapter = async (config) => {
    if (config.url === '/api/auth/refresh') {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response(config, 200, { access_token: 'fresh', user });
    }
    return response(config, config.headers.Authorization === 'Bearer fresh' ? 200 : 401);
  };
  const responses = await Promise.all([api.get('/api/groups/my'), api.get('/api/problems')]);
  assert.equal(refreshes, 1);
  assert.ok(responses.every((res) => res.status === 200));
});

test('rejected refresh clears the session, while wrong login never refreshes', async () => {
  auth.setUser(user);
  let calls = 0;
  api.defaults.adapter = async (config) => { calls += 1; return response(config, 401); };
  assert.equal(await auth.refreshAccessToken(), false);
  assert.equal(auth.getUser(), null);
  assert.equal(auth.getAccessToken(), null);
  calls = 0;
  await assert.rejects(authApi.login({ email: user.email, password: 'wrong' }));
  assert.equal(calls, 1);
});

test('each protected request retries once and requests have a finite timeout', async () => {
  auth.setUser(user);
  let requests = 0;
  api.defaults.adapter = async (config) => {
    if (config.url === '/api/auth/refresh') return response(config, 200, { access_token: 'fresh', user });
    requests += 1;
    return response(config, 401);
  };
  await assert.rejects(api.get('/api/groups/my'));
  assert.equal(requests, 2);
  assert.equal(api.defaults.timeout, 15000);
  assert.match(extractError(new axios.AxiosError('timeout', 'ECONNABORTED'), 'Failed'), /too long/);
});

test('report stream handles partial chunks, heartbeats and cumulative text once', () => {
  const stages = [];
  const reader = new ReportStreamReader((stage) => stages.push(stage));
  const first = JSON.stringify({ type: 'progress', stage: 'generating' }) + '\n';
  const rest = JSON.stringify({ type: 'heartbeat' }) + '\n' + JSON.stringify({ type: 'complete', draft: { title: 'Report' } }) + '\n';
  const full = first + rest;
  for (let index = 0; index <= full.length; index++) reader.read(full.slice(0, index));
  assert.deepEqual(reader.finish(), { title: 'Report' });
  assert.deepEqual(stages, ['generating']);
});

test('report stream surfaces errors and rejects truncated or malformed responses', () => {
  for (const content of ['{"type":"complete","dra', '{bad json}\n', JSON.stringify({ type: 'error', detail: 'Quota reached' }) + '\n']) {
    const reader = new ReportStreamReader(() => {});
    reader.read(content);
    assert.throws(() => reader.finish(), /interrupted|Quota reached/);
  }
});

const notes = { rawText: 'Lights are out', location: 'Wing B', since: 'Yesterday', impact: '', topic: 'Maintenance', language: 'en' };
test('guided details preserve resident text without inventing missing information', () => {
  assert.equal(composeReport(notes), 'Lights are out\n\nLocation: Wing B\n\nSince: Yesterday');
  assert.equal(composeReport({ ...notes, language: 'hi' }), 'Lights are out\n\nस्थान: Wing B\n\nकब से: Yesterday');
  assert.equal(composeReport({ ...notes, location: '', since: '' }), notes.rawText);
});

test('local snapshots validate size, language, taxonomy, age and editable review', () => {
  const now = Date.now();
  const record = { version: 1, savedAt: now, notes };
  assert.deepEqual(parseSavedReport(JSON.stringify(record), now), record);
  for (const broken of [null, {}, { ...record, savedAt: now + 1 }, { ...record, savedAt: now - 7 * 86400000 },
    { ...record, notes: { ...notes, rawText: 'x'.repeat(5001) } }, { ...record, notes: { ...notes, language: 'bad' } },
    { ...record, notes: { ...notes, topic: 'water' } }, { ...record, notes: { ...notes, review: { title: 'Partial' } } }]) {
    assert.equal(parseSavedReport(JSON.stringify(broken), now), null);
  }
  assert.equal(parseSavedReport('{broken'), null);
  const review = { title: 'Lights need repair', category: 'Maintenance', severity: 'Medium', location: '',
    description_en: 'Lights are out', description_hi: '', affected_residents: '' };
  const result = parseSavedReport(JSON.stringify({ ...record, notes: { ...notes, review: { ...review, solutions: ['stale suggestion'] }, audio: 'private' } }), now);
  assert.deepEqual(result.notes.review, review);
  assert.equal(result.notes.audio, undefined);
});

test('posting clears only the current residents local draft', () => {
  const deleted = [];
  clearLocalReport({ removeItem: key => deleted.push(key) }, 24);
  assert.deepEqual(deleted, [LOCAL_DRAFT_PREFIX + '24']);
});

test('sign-out removes local report snapshots without deleting unrelated preferences', () => {
  const store = { prayaas_user: '{}', prayaas_report_draft_legacy: 'not ours',
    [LOCAL_DRAFT_PREFIX + '1']: 'private', [LOCAL_DRAFT_PREFIX + '2']: 'private', prayaas_language: 'hi' };
  Object.defineProperty(store, 'removeItem', { value: key => delete store[key] });
  globalThis.window = {};
  globalThis.localStorage = store;
  try {
    auth.clearAuth();
    assert.equal(store[LOCAL_DRAFT_PREFIX + '1'], undefined);
    assert.equal(store[LOCAL_DRAFT_PREFIX + '2'], undefined);
    assert.equal(store.prayaas_language, 'hi');
  } finally { delete globalThis.window; delete globalThis.localStorage; }
});
