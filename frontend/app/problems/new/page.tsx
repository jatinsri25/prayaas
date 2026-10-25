"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { problemsApi, groupsApi, extractError } from "@/lib/api";
import { loadUserFromStorage, getUser, initAuth } from "@/lib/auth";
import type { ReportStage } from "@/lib/report-stream";
import SharedNav from "@/components/SharedNav";
import LanguageSwitch, { useLanguage } from "@/components/LanguageSwitch";
import ReportNotebook from "@/components/ReportNotebook";
import {
  composeReport,
  clearLocalReport,
  type ReportNotes,
} from "@/lib/report-notebook";
import s from "@/components/shared.module.css";
import r from "./report.module.css";

interface Solution {
  action: string;
  responsible_party: string;
  timeline: string;
  priority: number;
}
interface DuplicateMatch {
  problem_id: number;
  title: string;
  similarity: number;
  distance_meters: number | null;
  status: string;
  created_at: string;
}
interface DuplicateWarning {
  is_likely_duplicate: boolean;
  matches: DuplicateMatch[];
}
interface Draft {
  title: string;
  category: string;
  location: string;
  severity: string;
  formatted_description: string;
  description_en?: string;
  description_hi?: string;
  raw_input?: string;
  cache_hit?: boolean;
  affected_residents: string;
  solutions: Solution[];
  confidence_score?: number | null;
  was_escalated?: boolean | null;
  last_model_used?: string | null;
  auto_resolved?: boolean | null;
  duplicate_warning?: DuplicateWarning | null;
}
interface Group {
  id: number;
  name: string;
}

const CATEGORIES = [
  "Infrastructure",
  "Safety",
  "Sanitation",
  "Noise",
  "Maintenance",
  "Security",
  "Utilities",
  "Other",
];
const SEVERITIES = ["Low", "Medium", "High", "Critical"];
const STARTERS = [
  {
    category: "Utilities",
    en: "Water & power",
    hi: "पानी और बिजली",
    prompt:
      "What supply is affected? Is it interrupted or leaking? Where and since when?",
    promptHi:
      "कौन सी सेवा प्रभावित है? आपूर्ति बंद है या रिसाव है? कहां और कब से?",
  },
  {
    category: "Maintenance",
    en: "Repairs",
    hi: "मरम्मत",
    prompt:
      "What needs attention? Describe what you observed, the location, and when it started.",
    promptHi: "किस चीज की मरम्मत चाहिए? आपने क्या देखा, कहां और कब से?",
  },
  {
    category: "Sanitation",
    en: "Waste & cleaning",
    hi: "कचरा और सफाई",
    prompt:
      "Where is waste collecting or cleaning needed? How long has it been there?",
    promptHi: "कचरा कहां जमा है या सफाई कहां चाहिए? कब से यह स्थिति है?",
  },
  {
    category: "Other",
    en: "Something else",
    hi: "अन्य समस्या",
    prompt: "What happened? Where? Since when? Describe only what you know.",
    promptHi: "क्या हुआ? कहां? कब से? केवल वही लिखें जो आप जानते हैं।",
  },
];
interface AIStatus {
  code: string;
  can_attempt: boolean;
  message: string;
  retry_at: string | null;
}

export default function NewProblemPage() {
  const router = useRouter();
  const [language, setLanguage] = useLanguage();
  const hi = language === "hi";
  const [manual, setManual] = useState(false);
  const [step, setStep] = useState<
    "input" | "processing" | "draft" | "posting"
  >("input");
  const [rawText, setRawText] = useState("");
  const [userId, setUserId] = useState<number | null>(null);
  const [topic, setTopic] = useState("Other");
  const [reportLocation, setReportLocation] = useState("");
  const [since, setSince] = useState("");
  const [impact, setImpact] = useState("");
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [myGroups, setMyGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [posting, setPosting] = useState(false);
  const [stage, setStage] = useState<ReportStage>("received");
  const [elapsed, setElapsed] = useState(0);
  const processingRef = useRef<AbortController | null>(null);
  const postingRef = useRef(false);
  const [recording, setRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const init = async () => {
      const stored = loadUserFromStorage();
      if (!stored) {
        router.push("/login");
        return;
      }
      if (!(await initAuth())) return;
      setUserId(getUser()?.id ?? null);
      void refreshAIStatus();
      groupsApi
        .myGroups()
        .then((res) => setMyGroups(res.data))
        .catch(() => {});
    };
    init();
  }, [router]);

  async function refreshAIStatus() {
    setCheckingStatus(true);
    try {
      setAiStatus((await problemsApi.aiStatus()).data);
    } catch {
      setAiStatus({
        code: "unknown",
        can_attempt: true,
        retry_at: null,
        message:
          "Could not read AI status. This does not confirm provider availability.",
      });
    } finally {
      setCheckingStatus(false);
    }
  }

  const notes: ReportNotes = {
    rawText,
    topic,
    location: reportLocation,
    since,
    impact,
    language,
    ...(step === "draft" && draft
      ? {
          review: {
            title: draft.title,
            category: draft.category,
            severity: draft.severity,
            location: draft.location,
            description_en: draft.description_en ?? "",
            description_hi: draft.description_hi ?? "",
            affected_residents: draft.affected_residents,
          },
        }
      : {}),
  };
  const reportText = composeReport(notes);
  const starter =
    STARTERS.find((item) => item.category === topic) ?? STARTERS[3];

  function restoreNotes(saved: ReportNotes) {
    setRawText(saved.rawText);
    setTopic(saved.topic);
    setReportLocation(saved.location);
    setSince(saved.since);
    setImpact(saved.impact);
    setLanguage(saved.language);
    setAudioBlob(null);
    setAudioUrl(null);
    setRecordingTime(0);
    setSelectedGroup(null);
    setError("");
    // Persist only the resident's editable text, not stale AI suggestions/scores.
    setManual(true);
    setDraft(
      saved.review
        ? {
            ...saved.review,
            formatted_description:
              saved.review.description_en || saved.review.description_hi,
            raw_input: composeReport(saved),
            solutions: [],
          }
        : null,
    );
    setStep(saved.review ? "draft" : "input");
  }

  useEffect(() => {
    if (step !== "processing") return;
    const start = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [step]);

  useEffect(
    () => () => {
      processingRef.current?.abort();
      if (timerRef.current) clearInterval(timerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
        recorder.stream.getTracks().forEach((track) => track.stop());
      }
    },
    [],
  );

  useEffect(
    () => () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    },
    [audioUrl],
  );

  const startRecording = async () => {
    try {
      setError("");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(
        () => setRecordingTime((t) => t + 1),
        1000,
      );
    } catch {
      setError("Microphone access denied. Please allow microphone permission.");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const fmt = (sec: number) =>
    `${Math.floor(sec / 60)
      .toString()
      .padStart(2, "0")}:${(sec % 60).toString().padStart(2, "0")}`;

  const handleProcess = async () => {
    if (processingRef.current || recording) return;
    if (!rawText.trim() && !audioBlob) {
      setError("Please describe your problem");
      return;
    }
    if (reportText.length > 5000) {
      setError(
        hi
          ? "विवरण सहित रिपोर्ट 5,000 अक्षरों तक रखें।"
          : "Keep the report, including optional details, within 5,000 characters.",
      );
      return;
    }
    const controller = new AbortController();
    processingRef.current = controller;
    setError("");
    setElapsed(0);
    setStage("received");
    setStep("processing");
    try {
      if (!(await initAuth()))
        throw new Error(
          "Could not restore your session. Please sign in again.",
        );
      if (controller.signal.aborted) return;
      const fd = new FormData();
      if (reportText.trim()) fd.append("raw_text", reportText);
      if (audioBlob) fd.append("audio", audioBlob, "recording.webm");
      const result = await problemsApi.processStream<Draft>(
        fd,
        (next) => {
          if (!controller.signal.aborted) setStage(next);
        },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setManual(false);
        setDraft({
          ...result,
          description_en: result.description_en ?? result.formatted_description,
          description_hi: result.description_hi ?? "",
        });
        setStep("draft");
      }
    } catch (err: unknown) {
      if (!controller.signal.aborted) {
        setError(extractError(err, "AI processing failed. Please try again."));
        setStep("input");
        void refreshAIStatus();
      }
    } finally {
      if (processingRef.current === controller) processingRef.current = null;
    }
  };

  const cancelProcess = () => {
    processingRef.current?.abort();
    processingRef.current = null;
    setStep("input");
  };

  const startManual = () => {
    if (reportText.length > 5000) {
      setError(
        hi
          ? "विवरण सहित रिपोर्ट 5,000 अक्षरों तक रखें।"
          : "Keep the report, including optional details, within 5,000 characters.",
      );
      return;
    }
    processingRef.current?.abort();
    processingRef.current = null;
    setError("");
    setManual(true);
    setDraft({
      title: "",
      category: topic,
      severity: "Medium",
      location: reportLocation,
      affected_residents: impact,
      formatted_description: reportText,
      description_en: hi ? "" : reportText,
      description_hi: hi ? reportText : "",
      raw_input: reportText,
      solutions: [],
    });
    setStep("draft");
  };

  const handlePost = async () => {
    if (!draft || postingRef.current) return;
    const description =
      draft.description_en?.trim() || draft.description_hi?.trim() || "";
    if (!draft.title.trim() || !description) {
      setError(
        hi
          ? "शीर्षक और कम से कम एक भाषा में विवरण लिखें।"
          : "Add a title and a description in at least one language.",
      );
      return;
    }
    postingRef.current = true;
    setError("");
    setPosting(true);
    try {
      const fd = new FormData();
      fd.append("title", draft.title);
      fd.append("formatted_description", description);
      if (draft.description_en?.trim())
        fd.append("description_en", draft.description_en.trim());
      if (draft.description_hi?.trim())
        fd.append("description_hi", draft.description_hi.trim());
      fd.append("input_language", language);
      fd.append("drafting_mode", manual ? "manual" : "ai");
      fd.append("category", draft.category);
      fd.append("severity", draft.severity);
      fd.append("location", draft.location);
      fd.append("affected_residents", draft.affected_residents);
      fd.append("ai_solutions", JSON.stringify(draft.solutions));
      if (draft.raw_input || rawText)
        fd.append("raw_input", draft.raw_input || rawText);
      if (selectedGroup) fd.append("group_id", String(selectedGroup));
      // Do not publish raw recordings containing voices or personal details.
      // Confidence-gated pipeline telemetry — persisted for the admin dashboard
      if (draft.confidence_score != null)
        fd.append("confidence_score", String(draft.confidence_score));
      if (draft.was_escalated != null)
        fd.append("was_escalated", String(draft.was_escalated));
      if (draft.last_model_used)
        fd.append("last_model_used", draft.last_model_used);
      await problemsApi.post(fd);
      try {
        if (userId !== null) clearLocalReport(localStorage, userId);
      } catch {
        /* Browser storage can be disabled. Posting already succeeded. */
      }
      router.push("/dashboard");
    } catch (err: unknown) {
      postingRef.current = false;
      setError(extractError(err, "Failed to post."));
      setStep("draft");
      setPosting(false);
    }
  };

  const updateDraft = (key: keyof Draft, value: string) => {
    if (draft)
      setDraft({
        ...draft,
        [key]: value,
        ...(key === "description_en" ? { formatted_description: value } : {}),
      });
  };

  // ── Processing ────────────────────────────────────────
  if (step === "processing") {
    const stages = [
      ...(audioBlob
        ? [{ id: "transcribing", label: "Transcribe your recording" }]
        : []),
      { id: "preparing", label: "Protect private details" },
      { id: "generating", label: "Create report and action plan" },
      { id: "checking", label: "Check for similar open issues" },
    ];
    const activeIndex = stages.findIndex(
      (item) => item.id === (stage === "refining" ? "generating" : stage),
    );
    return (
      <main className={s.page}>
        <SharedNav active="report" />
        <div className={r.processingWrap}>
          <div className={r.processingInner}>
            <div className={r.aiOrb} aria-hidden="true">
              <span className={r.orbMark}>P</span>
            </div>
            <span className={s.eyebrow}>
              A clearer path to a better society
            </span>
            <h2 style={{ fontSize: 28, fontWeight: 500 }}>
              Turning your report into action
            </h2>
            <p
              style={{
                color: "rgba(232,234,240,0.44)",
                maxWidth: 300,
                fontSize: 14,
                lineHeight: 1.65,
              }}
            >
              One report. Three practical next steps. You can review everything
              before posting.
            </p>
            <div className={r.pipelineSteps} aria-label="Report progress">
              {stages.map((item, i) => (
                <div
                  key={item.id}
                  className={`${r.stepRow} ${i === activeIndex ? r.stepActive : ""}`}
                  aria-current={i === activeIndex ? "step" : undefined}
                >
                  <span className={r.stepNumber}>
                    {i < activeIndex
                      ? "\u2713"
                      : String(i + 1).padStart(2, "0")}
                  </span>
                  {item.label}
                  {i === activeIndex && (
                    <span
                      className={s.spinnerSm}
                      style={{ marginLeft: "auto" }}
                      aria-hidden="true"
                    />
                  )}
                </div>
              ))}
            </div>
            <p className={r.progressNote} role="status">
              {stage === "refining"
                ? "Retrying once to repair the draft format."
                : stage === "received"
                  ? "Connecting securely..."
                  : stages[activeIndex]?.label}
            </p>
            <span className={r.elapsed}>{elapsed}s elapsed</span>
            {elapsed >= 20 && (
              <p className={r.progressNote}>
                Taking a little longer. Your report has not been posted.
              </p>
            )}
            <button
              type="button"
              className={s.secondaryBtn}
              onClick={cancelProcess}
            >
              Cancel and edit
            </button>
            <button type="button" className={s.ghostBtn} onClick={startManual}>
              {hi ? "AI के बिना रिपोर्ट लिखें" : "Continue without AI"}
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ── Draft Review ──────────────────────────────────────
  if (step === "draft" && draft) {
    const sevColor: Record<string, string> = {
      Low: "#4ade80",
      Medium: "#fbbf24",
      High: "#fb7185",
      Critical: "#fecaca",
    };
    const dup = draft.duplicate_warning;

    return (
      <main className={s.page}>
        <SharedNav active="report" />
        <div
          className={s.container}
          style={{ maxWidth: 760, paddingTop: 36, paddingBottom: 72 }}
        >
          <header className={r.reviewHeader} lang={language}>
            <div className={r.reviewToolbar}>
              <span className={r.reviewKicker}>
                {hi ? "02 / पोस्ट करने से पहले" : "02 / Before you share"}
              </span>
              <LanguageSwitch language={language} onChange={setLanguage} />
            </div>
            <h1>{hi ? "अपनी रिपोर्ट जांच लें" : "Review your report"}</h1>
            <p className={r.reviewIntro}>
              {hi
                ? "स्थान, गंभीरता और विवरण जांच लें। साझा करने से पहले नीचे कुछ भी बदल सकते हैं।"
                : "Check the location, urgency and wording. You can change any detail before sharing it with your community."}
            </p>
            <p className={r.reviewAttribution}>
              {manual
                ? hi ? "आपके लिखे विवरण से तैयार" : "Written from your notes"
                : draft.cache_hit
                  ? hi ? "आपके पिछले AI मसौदे से लिया गया" : "From your previous AI draft"
                  : hi ? "AI की मदद से तैयार" : "Prepared with AI assistance"}
            </p>
          </header>

          {dup?.is_likely_duplicate && dup.matches.length > 0 && (
            <div
              style={{
                marginBottom: 18,
                padding: "16px 18px",
                borderRadius: 14,
                background: "rgba(251, 191, 36, 0.08)",
                border: "0.5px solid rgba(251, 191, 36, 0.35)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                <span style={{ fontSize: 18 }}>⚠️</span>
                <strong
                  style={{ color: "#fbbf24", fontSize: 14, fontWeight: 700 }}
                >
                  Possible duplicate ({dup.matches.length} similar open issue
                  {dup.matches.length > 1 ? "s" : ""} found)
                </strong>
              </div>
              <p
                style={{
                  fontSize: 13,
                  color: "rgba(232,234,240,0.66)",
                  margin: "0 0 10px",
                  lineHeight: 1.55,
                }}
              >
                Your report may describe an issue already reported by a
                neighbour. Consider upvoting the existing thread instead of
                creating a new one.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {dup.matches.slice(0, 3).map((m) => (
                  <button
                    key={m.problem_id}
                    type="button"
                    onClick={() => router.push(`/problems/${m.problem_id}`)}
                    style={{
                      textAlign: "left",
                      padding: "8px 12px",
                      borderRadius: 10,
                      border: "0.5px solid rgba(255,255,255,0.06)",
                      background: "rgba(0,0,0,0.18)",
                      color: "#e8eaf0",
                      fontSize: 13,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>
                      #{m.problem_id} · {m.title}
                    </div>
                    <div
                      style={{ fontSize: 11, color: "rgba(232,234,240,0.5)" }}
                    >
                      similarity {(m.similarity * 100).toFixed(1)}%
                      {m.distance_meters != null &&
                        ` · ${m.distance_meters.toFixed(0)}m away`}
                      {" · "}
                      {m.status}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <fieldset disabled={posting} className={r.draftFields}>
            <div className={r.originalNote}>
              <h3>{hi ? "आपके मूल शब्द" : "Your original words"}</h3>
              <p lang={language}>
                {rawText ||
                  draft.raw_input ||
                  (hi
                    ? "कोई लिखित विवरण नहीं दिया गया।"
                    : "No text supplied. Add the details below.")}
              </p>
              {audioBlob && rawText && draft.raw_input && !manual && (
                <>
                  <h3>
                    {hi
                      ? "रिकॉर्डिंग और लिखित विवरण से लिया गया पाठ"
                      : "Text used from your recording and note"}
                  </h3>
                  <p>{draft.raw_input}</p>
                </>
              )}
              <small>
                {hi
                  ? "संपर्क नंबर और ईमेल जैसे निजी विवरण पोस्ट से पहले हटाए जाते हैं। नाम और फ्लैट नंबर स्वयं जांचें।"
                  : "Contact numbers and emails are masked before posting. Check names and flat details yourself."}
              </small>
            </div>
            {/* Title */}
            <div className={r.reviewPanel}>
              <div className={s.formGroup}>
                <label className={s.formLabel} htmlFor="report-title">
                  {hi ? "शीर्षक" : "Title"}
                </label>
                <input
                  id="report-title"
                  maxLength={200}
                  className={s.formInput}
                  value={draft.title}
                  onChange={(e) => updateDraft("title", e.target.value)}
                  style={{ fontSize: 17, fontWeight: 600 }}
                />
              </div>
            </div>

            {/* Meta */}
            <div className={s.grid2}>
              <div className={r.reviewPanel}>
                <div className={s.formGroup}>
                  <label className={s.formLabel} htmlFor="report-category">{hi ? "श्रेणी" : "Category"}</label>
                  <select
                    id="report-category"
                    className={s.formSelect}
                    value={draft.category}
                    onChange={(e) => updateDraft("category", e.target.value)}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className={r.reviewPanel}>
                <div className={s.formGroup}>
                  <label className={s.formLabel} htmlFor="report-severity">
                    {hi ? "गंभीरता" : "Urgency"} /{" "}
                    <span style={{ color: sevColor[draft.severity] }}>
                      {draft.severity}
                    </span>
                  </label>
                  <select
                    id="report-severity"
                    className={s.formSelect}
                    value={draft.severity}
                    onChange={(e) => updateDraft("severity", e.target.value)}
                  >
                    {SEVERITIES.map((sv) => (
                      <option key={sv} value={sv}>
                        {sv}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Location + Affected */}
            <div className={s.grid2}>
              <div className={r.reviewPanel}>
                <div className={s.formGroup}>
                  <label className={s.formLabel} htmlFor="draft-location">{hi ? "स्थान" : "Location"}</label>
                  <input
                    id="draft-location"
                    className={s.formInput}
                    value={draft.location}
                    onChange={(e) => updateDraft("location", e.target.value)}
                  />
                </div>
              </div>
              <div className={r.reviewPanel}>
                <div className={s.formGroup}>
                  <label className={s.formLabel} htmlFor="draft-impact">{hi ? "प्रभावित निवासी" : "Affected residents"}</label>
                  <input
                    id="draft-impact"
                    className={s.formInput}
                    value={draft.affected_residents}
                    onChange={(e) =>
                      updateDraft("affected_residents", e.target.value)
                    }
                  />
                </div>
              </div>
            </div>

            {/* Description */}
            <div className={r.reviewPanel}>
              <h2 className={r.reviewSectionTitle}>{hi ? "विवरण" : "Description"}</h2>
              <p className={r.languageHelp}>
                {hi
                  ? "दोनों विवरण जांचें। एक में बदलाव दूसरे का अनुवाद नहीं करता। केवल एक भाषा में भी पोस्ट कर सकते हैं।"
                  : "Review both versions. Editing one does not retranslate the other. You can also post in just one language."}
              </p>
              <div className={r.bilingualFields}>
                <div className={s.formGroup}>
                  <label htmlFor="description-en" className={s.formLabel}>
                    English
                  </label>
                  <textarea
                    id="description-en"
                    lang="en"
                    className={s.formTextarea}
                    maxLength={5000}
                    value={draft.description_en ?? ""}
                    onChange={(e) =>
                      updateDraft("description_en", e.target.value)
                    }
                    style={{ minHeight: 210 }}
                  />
                </div>
                <div className={s.formGroup}>
                  <label
                    htmlFor="description-hi"
                    className={s.formLabel}
                    lang="hi"
                  >
                    हिंदी
                  </label>
                  <textarea
                    id="description-hi"
                    lang="hi"
                    className={s.formTextarea}
                    maxLength={5000}
                    value={draft.description_hi ?? ""}
                    onChange={(e) =>
                      updateDraft("description_hi", e.target.value)
                    }
                    style={{ minHeight: 210 }}
                  />
                </div>
              </div>
            </div>

            {/* Solutions */}
            {!manual && (
              <section className={r.nextSteps} aria-labelledby="next-steps-title">
                <h2 id="next-steps-title" className={r.reviewSectionTitle}>
                  {hi ? "सुझाए गए अगले कदम" : "Suggested next steps"}
                </h2>
                <ol className={r.actionList} role="list">
                  {draft.solutions.map((sol, i) => (
                    <li key={i} className={r.actionItem}>
                      <span className={r.actionNumber} aria-hidden="true">
                        {String(sol.priority).padStart(2, "0")}
                      </span>
                      <div>
                        <p className={r.actionText}>{sol.action}</p>
                        <dl className={r.actionDetails}>
                          <div>
                            <dt>{hi ? "जिम्मेदारी" : "Suggested owner"}</dt>
                            <dd>{sol.responsible_party}</dd>
                          </div>
                          <div>
                            <dt>{hi ? "समय" : "Suggested timing"}</dt>
                            <dd>{sol.timeline}</dd>
                          </div>
                        </dl>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {/* Post */}
            <div className={r.sharePanel}>
              {myGroups.length > 0 && (
                <div className={s.formGroup} style={{ marginBottom: 20 }}>
                  <label className={s.formLabel}>
                    Post to Group (optional)
                  </label>
                  <select
                    className={s.formSelect}
                    value={selectedGroup ?? ""}
                    onChange={(e) =>
                      setSelectedGroup(
                        e.target.value ? Number(e.target.value) : null,
                      )
                    }
                  >
                    <option value="">Community Feed (All)</option>
                    {myGroups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {error && (
                <div className={s.errorBlock} style={{ marginBottom: 16 }}>
                  {error}
                </div>
              )}
              <div className={r.shareActions}>
                <button
                  id="post-problem-btn"
                  className={`${s.primaryBtn} ${s.btnFull}`}
                  onClick={handlePost}
                  disabled={posting}
                >
                  {posting ? (
                    <span className={s.spinnerSm} />
                  ) : hi ? (
                    "समुदाय में पोस्ट करें"
                  ) : (
                    "Share report"
                  )}
                </button>
                <button
                  type="button"
                  className={s.secondaryBtn}
                  onClick={() => setStep("input")}
                >
                  {hi ? "मूल विवरण पर लौटें" : "Back to notes"}
                </button>
              </div>
            </div>
          </fieldset>
          {!posting && (
            <ReportNotebook
              userId={userId}
              notes={notes}
              onRestore={restoreNotes}
            />
          )}
        </div>
      </main>
    );
  }

  // ── Input ─────────────────────────────────────────────
  return (
    <main className={s.page}>
      <SharedNav active="report" />
      <div
        className={s.container}
        style={{ maxWidth: 680, paddingTop: 42, paddingBottom: 72 }}
      >
        <div className={r.languageRow}>
          <LanguageSwitch language={language} onChange={setLanguage} />
        </div>
        <div style={{ marginBottom: 32 }}>
          <span className={s.eyebrow}>Step 1 of 2</span>
          <h1
            lang={language}
            style={{
              margin: "12px 0 0",
              fontSize: 42,
              fontWeight: 500,
              lineHeight: 1.15,
            }}
          >
            {hi ? "समस्या की रिपोर्ट करें" : "Report a Problem"}
          </h1>
          <p
            style={{
              color: "rgba(232,234,240,0.68)",
              fontSize: 15,
              lineHeight: 1.7,
              marginTop: 10,
              maxWidth: 540,
            }}
          >
            {hi
              ? "हिंदी, हिंग्लिश या अंग्रेजी में अपनी बात लिखें। AI दोनों भाषाओं में मसौदा बनाएगा। AI के बिना भी रिपोर्ट कर सकते हैं।"
              : "Write in English, Hindi or Hinglish. AI drafts both English and Hindi for you to review. Or write and post without AI."}
          </p>
        </div>

        <section className={r.availability} aria-label="AI availability">
          <div className={r.notebookHeading}>
            <span className={s.eyebrow}>
              {hi ? "रिपोर्टिंग हमेशा उपलब्ध" : "Reporting stays open"}
            </span>
            <button
              type="button"
              className={s.ghostBtn}
              disabled={checkingStatus}
              onClick={refreshAIStatus}
            >
              {checkingStatus
                ? hi
                  ? "जांच जारी है"
                  : "Checking"
                : hi
                  ? "स्थिति जांचें"
                  : "Check status"}
            </button>
          </div>
          <p role="status">
            {hi
              ? !aiStatus
                ? "स्थानीय AI स्थिति जांच रहे हैं।"
                : aiStatus.code === "eligible"
                  ? "AI का प्रयास कर सकते हैं। प्रदाता की उपलब्धता मसौदा मांगने पर ही जांची जाती है।"
                  : aiStatus.code === "unknown"
                    ? "AI की स्थिति पता नहीं चली। यह उपलब्धता की पुष्टि नहीं है।"
                    : [
                          "credentials",
                          "model_unavailable",
                          "unconfigured",
                        ].includes(aiStatus.code)
                      ? "AI की सेटिंग ठीक करने के लिए व्यवस्थापक की जरूरत है। बिना AI रिपोर्ट लिख और पोस्ट कर सकते हैं।"
                      : "AI पर अभी सीमा या अस्थायी रोक है। बिना AI रिपोर्ट लिखें; सहेजा AI मसौदा मिल सकता है।"
              : (aiStatus?.message ??
                "Checking local AI configuration and limits.")}
          </p>
          {aiStatus?.retry_at && (
            <small>
              {hi ? "फिर प्रयास कर सकते हैं" : "Next local retry window"}:{" "}
              {new Date(aiStatus.retry_at).toLocaleString(
                hi ? "hi-IN" : "en-IN",
              )}
              .{" "}
              {hi
                ? "उपलब्धता की गारंटी नहीं।"
                : "Not a guarantee of provider recovery."}
            </small>
          )}
        </section>

        <section
          className={r.starters}
          aria-label={hi ? "रिपोर्ट की शुरुआत" : "Report starters"}
        >
          <span className={s.eyebrow}>
            {hi ? "01 / विषय चुनें" : "01 / Find a starting point"}
          </span>
          <div className={r.starterGrid}>
            {STARTERS.map((item) => (
              <button
                key={item.category}
                type="button"
                aria-pressed={topic === item.category}
                onClick={() => setTopic(item.category)}
              >
                {hi ? item.hi : item.en}
              </button>
            ))}
          </div>
          <p>{hi ? starter.promptHi : starter.prompt}</p>
        </section>

        {/* Voice is optional and needs AI; text-first reporting never does. */}
        <details className={r.voiceDetails}>
          <summary>
            {hi
              ? "बोलकर बताएं / AI की जरूरत है"
              : "Prefer to speak? / requires AI"}
          </summary>
          <div style={{ padding: 24 }}>
            <h3
              style={{
                fontSize: 17,
                fontWeight: 500,
                marginBottom: 20,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              🎙️ Voice Recording
              <span
                style={{
                  fontSize: 13,
                  color: "rgba(232,234,240,0.44)",
                  fontWeight: 400,
                }}
              >
                — Speak in any language
              </span>
            </h3>
            <p className={r.languageHelp}>
              {hi
                ? "रिकॉर्डिंग AI प्रदाता को भेजी जाती है। नाम, संपर्क नंबर या किसी अन्य व्यक्ति की आवाज शामिल न करें। रिकॉर्डिंग सार्वजनिक नहीं की जाएगी।"
                : "Recordings are sent to the AI provider for transcription. Avoid names, contact details, and other people's voices. Raw audio is not published."}
            </p>
            <div className={recording ? r.voiceBoxRecording : r.voiceBox}>
              {recording && (
                <div className={r.waveform}>
                  {Array.from({ length: 9 }).map((_, i) => (
                    <div
                      key={i}
                      className={r.waveBar}
                      style={{
                        animationDelay: `${i * 0.1}s`,
                        height: `${8 + ((i * 7) % 28)}px`,
                      }}
                    />
                  ))}
                </div>
              )}
              <button
                className={recording ? r.recordBtnRecording : r.recordBtnIdle}
                onClick={recording ? stopRecording : startRecording}
                id="record-btn"
                type="button"
                aria-label={
                  recording
                    ? hi
                      ? "रिकॉर्डिंग रोकें"
                      : "Stop recording"
                    : hi
                      ? "रिकॉर्डिंग शुरू करें"
                      : "Start recording"
                }
              >
                {recording ? "⏹" : "🎙️"}
              </button>
              <div style={{ textAlign: "center" }}>
                {recording ? (
                  <div>
                    <div
                      style={{
                        color: "#fb7185",
                        fontWeight: 700,
                        fontSize: 17,
                        fontFamily: "monospace",
                      }}
                    >
                      🔴 {fmt(recordingTime)}
                    </div>
                    <div
                      style={{
                        color: "rgba(232,234,240,0.44)",
                        fontSize: 13,
                        marginTop: 4,
                      }}
                    >
                      Tap to stop
                    </div>
                  </div>
                ) : audioUrl ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        color: "#5eead4",
                        fontWeight: 600,
                        fontSize: 14,
                      }}
                    >
                      ✓ Recording ready ({fmt(recordingTime)})
                    </div>
                    <audio
                      src={audioUrl}
                      controls
                      style={{ borderRadius: 8, maxWidth: "100%" }}
                    />
                    <button
                      className={s.ghostBtn}
                      onClick={() => {
                        setAudioBlob(null);
                        setAudioUrl(null);
                        setRecordingTime(0);
                      }}
                    >
                      🗑️ Discard
                    </button>
                  </div>
                ) : (
                  <div
                    style={{ color: "rgba(232,234,240,0.44)", fontSize: 14 }}
                  >
                    Tap the mic to start recording
                  </div>
                )}
              </div>
            </div>
          </div>
        </details>

        {/* Text input */}
        <div className={s.card} style={{ padding: 24, marginBottom: 16 }}>
          <div className={s.formGroup}>
            <label className={s.formLabel} htmlFor="problem-text">
              {hi ? "02 / अपनी समस्या लिखें" : "02 / In your own words"}
            </label>
            <textarea
              id="problem-text"
              className={s.formTextarea}
              lang={language}
              placeholder={hi ? starter.promptHi : starter.prompt}
              value={rawText}
              maxLength={5000}
              onChange={(e) => setRawText(e.target.value)}
              style={{ minHeight: 160 }}
            />
          </div>
          <div className={r.detailsGrid}>
            <div className={s.formGroup}>
              <label htmlFor="report-location" className={s.formLabel}>
                {hi ? "स्थान (वैकल्पिक)" : "Where? (optional)"}
              </label>
              <input
                id="report-location"
                className={s.formInput}
                maxLength={200}
                value={reportLocation}
                onChange={(e) => setReportLocation(e.target.value)}
                placeholder={
                  hi ? "साझा क्षेत्र या विंग" : "Common area or wing"
                }
              />
            </div>
            <div className={s.formGroup}>
              <label htmlFor="report-since" className={s.formLabel}>
                {hi ? "कब से? (वैकल्पिक)" : "Since when? (optional)"}
              </label>
              <input
                id="report-since"
                className={s.formInput}
                maxLength={200}
                value={since}
                onChange={(e) => setSince(e.target.value)}
                placeholder={hi ? "केवल ज्ञात समय लिखें" : "Only if you know"}
              />
            </div>
          </div>
          <div className={s.formGroup}>
            <label htmlFor="report-impact" className={s.formLabel}>
              {hi
                ? "क्या असर पड़ रहा है? (वैकल्पिक)"
                : "Who or what is affected? (optional)"}
            </label>
            <input
              id="report-impact"
              className={s.formInput}
              maxLength={300}
              value={impact}
              onChange={(e) => setImpact(e.target.value)}
              placeholder={
                hi
                  ? "नाम या निजी संपर्क न लिखें"
                  : "Avoid names and personal contact details"
              }
            />
          </div>
          <div className={r.inputFootnote}>
            <span>
              {hi
                ? "खाली जानकारी नहीं गढ़ी जाएगी।"
                : "No guesses. Leave unknown details blank."}
            </span>
            <span aria-live="polite">
              {reportText.length.toLocaleString()} / 5,000
            </span>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className={s.errorBlock}
            style={{ marginBottom: 16 }}
          >
            {error}
          </div>
        )}
        {error && (
          <p className={r.languageHelp}>
            {hi
              ? "AI मसौदा नहीं बना पाया? आपकी बात सुरक्षित है। नीचे दिए विकल्प से बिना AI पोस्ट करें।"
              : "AI drafting unavailable? Your input is still here. Use the manual form below to post without it."}
          </p>
        )}

        <button
          id="process-ai-btn"
          className={`${s.primaryBtn} ${s.btnFull}`}
          onClick={handleProcess}
          disabled={recording || (!rawText.trim() && !audioBlob)}
        >
          {hi ? "AI से द्विभाषी मसौदा बनाएं" : "Create bilingual draft with AI"}
        </button>
        <button
          id="manual-report-btn"
          className={`${s.secondaryBtn} ${s.btnFull}`}
          style={{ marginTop: 12 }}
          onClick={startManual}
          disabled={recording}
        >
          {hi ? "AI के बिना रिपोर्ट लिखें" : "Write report without AI"}
        </button>

        <p
          style={{
            textAlign: "center",
            color: "rgba(232,234,240,0.44)",
            fontSize: 13,
            marginTop: 14,
          }}
        >
          {hi
            ? "दोनों विकल्पों में पोस्ट करने से पहले आप समीक्षा करेंगे।"
            : "Either way, you review everything before anything is posted."}
        </p>
        {!recording && (
          <ReportNotebook
            userId={userId}
            notes={notes}
            onRestore={restoreNotes}
          />
        )}
      </div>
    </main>
  );
}
