"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { initAuth, loadUserFromStorage } from "@/lib/auth";
import { extractError } from "@/lib/api";
import { insightsApi, type DigestResponse } from "@/lib/insights";
import SharedNav from "@/components/SharedNav";
import LanguageSwitch, { useLanguage } from "@/components/LanguageSwitch";
import s from "@/components/shared.module.css";
import styles from "../insights.module.css";

export default function CommitteePage() {
  const router = useRouter();
  const [language, setLanguage] = useLanguage();
  const hi = language === "hi";
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [english, setEnglish] = useState("");
  const [hindi, setHindi] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const receive = (value: DigestResponse) => {
    setDigest(value);
    if ("summary_en" in value) {
      setEnglish(value.summary_en);
      setHindi(value.summary_hi);
    }
  };

  useEffect(() => {
    let mounted = true;
    if (!loadUserFromStorage()) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        if (!(await initAuth()))
          throw new Error(
            "Could not restore your session. Please sign in again.",
          );
        const result = await insightsApi.digest();
        if (mounted) receive(result.data);
      } catch (error) {
        if (mounted)
          setError(extractError(error, "Could not load the committee draft."));
      } finally {
        if (mounted) setBusy(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [router]);

  const run = async (action: "generate" | "refresh" | "save") => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action === "save" && digest && "revision" in digest) {
        const result = await insightsApi.saveDigest(
          digest.week_start,
          english,
          hindi,
          digest.revision,
        );
        receive(result.data);
        setNotice(
          hi
            ? "मसौदा सहेजा गया। कोई संदेश नहीं भेजा गया।"
            : "Draft saved. Nothing has been sent.",
        );
      } else
        receive(
          (
            await (action === "generate"
              ? insightsApi.generateDigest()
              : insightsApi.digest())
          ).data,
        );
    } catch (error) {
      setError(
        extractError(
          error,
          "Could not update the draft. Your edits are still here.",
        ),
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!digest || !("snapshot" in digest)) return;
    try {
      await navigator.clipboard.writeText(
        `Committee draft / ${digest.week_start}\n\n${english}\n\n${hindi}\n\nSource reports: ${digest.source_ids.map((id) => `#${id}`).join(", ")}\nDraft only. Review before sharing.`,
      );
      setNotice(
        hi
          ? "मसौदा कॉपी हुआ। भेजने से पहले समीक्षा करें।"
          : "Draft copied. Review before sharing.",
      );
    } catch {
      setError(
        "Clipboard access is unavailable. You can select the draft text directly.",
      );
    }
  };

  return (
    <main className={s.page}>
      <SharedNav active="committee" />
      <div className={styles.content}>
        <Link href="/dashboard" className={styles.back}>
          ← {hi ? "समुदाय की ओर लौटें" : "Back to your neighbourhood"}
        </Link>
        <header className={styles.headingRow}>
          <div>
            <span className={s.eyebrow}>
              {hi ? "समिति का कार्यक्षेत्र" : "For the committee"}
            </span>
            <h1>
              {hi
                ? "सप्ताह की बातें, एक जगह।"
                : "A week of community, in one place."}
            </h1>
            <p>
              {hi
                ? "पिछले पूरे सप्ताह की रिपोर्ट का अंग्रेजी और हिंदी मसौदा। समीक्षा करें, बदलाव करें, फिर स्वयं साझा करें।"
                : "An English and Hindi draft for the last completed week. Review it, edit it, and choose what to share. Nothing is sent automatically."}
            </p>
          </div>
          <LanguageSwitch language={language} onChange={setLanguage} />
        </header>
        {error && (
          <div className={s.errorBlock} role="alert">
            {error}
          </div>
        )}
        {busy && (
          <p
            className={styles.status}
            role="status"
            style={{ margin: "18px 0" }}
          >
            {hi ? "मसौदा तैयार हो रहा है…" : "Working on the committee draft…"}
          </p>
        )}
        {notice && (
          <p className={styles.status} role="status">
            {notice}
          </p>
        )}
        {!digest && !busy && (
          <button className={s.secondaryBtn} onClick={() => run("refresh")}>
            Try again
          </button>
        )}
        {digest?.generation_mode === "not_generated" && (
          <section className={styles.panel}>
            <h2 style={{ fontSize: 30, marginBottom: 15 }}>
              {hi
                ? "इस सप्ताह का मसौदा अभी तैयार नहीं है।"
                : "This weekly draft is not prepared yet."}
            </h2>
            <p className={styles.note}>
              {digest.week_start} to {digest.week_end} · Asia/Kolkata · end
              exclusive
            </p>
            <p className={styles.notice}>
              {hi
                ? "एक सामान्य AI कॉल; गलत प्रारूप पर केवल एक पुनः प्रयास। कोटा न होने पर गिनती पर आधारित मसौदा बनेगा।"
                : "One normal AI call, with one retry only for invalid output. If quota is unavailable, you still get a counts-only draft."}
            </p>
            <button
              className={s.primaryBtn}
              disabled={busy}
              onClick={() => run("generate")}
            >
              {hi ? "साप्ताहिक मसौदा तैयार करें" : "Prepare weekly draft"}
            </button>
          </section>
        )}
        {digest && "snapshot" in digest && (
          <>
            <div className={styles.notice}>
              {digest.week_start} to {digest.snapshot.week_end} · Asia/Kolkata
              <br />
              {hi
                ? "ये इस सप्ताह दर्ज रिपोर्ट की वर्तमान स्थितियां हैं, इस सप्ताह हल हुई सभी समस्याओं की गिनती नहीं।"
                : "These are current statuses of reports created in this week, not all issues resolved during the week."}
            </div>
            <div className={styles.metrics}>
              {[
                ["Reports created", digest.snapshot.total],
                ...Object.entries(digest.snapshot.statuses),
              ].map(([label, count]) => (
                <div key={label} className={styles.metric}>
                  <span>{label}</span>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
            <section className={styles.panel}>
              <div className={styles.resultMeta}>
                <span>
                  {digest.generation_mode === "ai_draft"
                    ? "AI-assisted draft / verify facts"
                    : digest.generation_mode === "preparing"
                      ? "Preparing / refresh shortly"
                      : "Counts-only draft / no AI summary"}
                </span>
                <span>
                  Revision {digest.revision}
                  {digest.edited ? " / human edited" : ""}
                </span>
              </div>
              <div className={styles.editors}>
                <label className={styles.label} htmlFor="digest-en">
                  English
                  <textarea
                    id="digest-en"
                    lang="en"
                    className={s.formTextarea}
                    maxLength={4000}
                    value={english}
                    disabled={busy || digest.generation_mode === "preparing"}
                    onChange={(e) => setEnglish(e.target.value)}
                  />
                </label>
                <label className={styles.label} htmlFor="digest-hi" lang="hi">
                  हिंदी
                  <textarea
                    id="digest-hi"
                    lang="hi"
                    className={s.formTextarea}
                    maxLength={4000}
                    value={hindi}
                    disabled={busy || digest.generation_mode === "preparing"}
                    onChange={(e) => setHindi(e.target.value)}
                  />
                </label>
              </div>
              <div className={styles.actions}>
                <button
                  className={s.primaryBtn}
                  disabled={
                    busy ||
                    digest.generation_mode === "preparing" ||
                    !english.trim() ||
                    !hindi.trim()
                  }
                  onClick={() => run("save")}
                >
                  {hi ? "मसौदा सहेजें" : "Save draft"}
                </button>
                <button
                  className={s.secondaryBtn}
                  disabled={busy || digest.generation_mode === "preparing"}
                  onClick={copy}
                >
                  {hi ? "मसौदा कॉपी करें" : "Copy draft"}
                </button>
                {digest.generation_mode === "preparing" && (
                  <button
                    className={s.secondaryBtn}
                    disabled={busy}
                    onClick={() => run("refresh")}
                  >
                    Refresh status
                  </button>
                )}
              </div>
              <p className={styles.note} style={{ marginTop: 16 }}>
                {hi
                  ? "कोई ईमेल, संदेश या घोषणा अपने आप नहीं भेजी जाती।"
                  : "No emails, vendor messages, or announcements are sent by this page."}
              </p>
            </section>
            <section className={styles.sources}>
              <h2>
                {hi
                  ? "मूल रिपोर्ट की समीक्षा करें"
                  : "Check the source reports."}
              </h2>
              <p className={styles.note}>
                {hi
                  ? "इस संग्रह में गंभीरता और वोट के अनुसार चुनी गई अधिकतम पांच रिपोर्ट हैं।"
                  : "Up to five reports from this snapshot, prioritised by severity and votes."}
              </p>
              {digest.snapshot.issues.map((issue) => (
                <Link key={issue.id} href={`/problems/${issue.id}`}>
                  #{issue.id} · {issue.title} · {issue.status}
                  {digest.source_ids.includes(issue.id) ? " / cited" : ""}
                </Link>
              ))}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
