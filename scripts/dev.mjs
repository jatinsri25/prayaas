import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = join(root, 'backend', 'venv', 'bin', 'python');
const next = join(root, 'frontend', 'node_modules', 'next', 'dist', 'bin', 'next');
const children = [];
let stopping = false;

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  }
  const timeout = setTimeout(() => {
    for (const child of children) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  }, 5000);
  timeout.unref();
}

function start(name, command, args, cwd, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: true });
  children.push(child);
  child.on('error', (error) => { console.error(`${name}: ${error.message}`); stop(1); });
  child.on('exit', (code) => {
    if (!stopping) { console.error(`${name} stopped (${code ?? 'signal'}).`); stop(code || 1); }
  });
}

async function waitFor(url) {
  const deadline = Date.now() + 90000;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch { /* The service is still starting. */ }
    await delay(500);
  }
  throw new Error(`Service did not become ready: ${url}`);
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

try {
  await access(python);
  await access(next);
  for (const port of [8000, 3000]) {
    if (await portInUse(port)) throw new Error(`Port ${port} is in use. Stop the existing service before starting Prayaas.`);
  }
  start('API', python, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000'], join(root, 'backend'));
  await waitFor('http://127.0.0.1:8000/health');
  if (!stopping) {
    start('Frontend', process.execPath, [next, 'dev', '--hostname', '127.0.0.1', '--port', '3000'], join(root, 'frontend'), {
      ...process.env,
      NEXT_PUBLIC_API_URL: '',
      BACKEND_URL: 'http://127.0.0.1:8000',
    });
    await waitFor('http://127.0.0.1:3000/login');
    console.log('\nPrayaas is ready: http://127.0.0.1:3000\nAPI: http://127.0.0.1:8000/docs\nCtrl+C stops both services.');
  }
} catch (error) {
  if (!stopping) console.error(`Could not start Prayaas: ${error.message}\nInstall frontend dependencies and backend/venv as described in README.md.`);
  stop(1);
}
