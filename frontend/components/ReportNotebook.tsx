"use client";

import { useEffect, useState } from "react";
import {
  LOCAL_DRAFT_PREFIX,
  clearLocalReport,
  composeReport,
  parseSavedReport,
  type ReportNotes,
  type SavedReport,
} from "@/lib/report-notebook";
import r from "@/app/problems/new/report.module.css";
import s from "./shared.module.css";

export default function ReportNotebook({
  userId,
  notes,
  onRestore,
}: {
  userId: number | null;
  notes: ReportNotes;
  onRestore: (notes: ReportNotes) => void;
}) {
  const hi = notes.language === "hi";
  const [consent, setConsent] = useState(false);
  const [saved, setSaved] = useState<SavedReport | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (userId === null) return;
    try {
      const record = parseSavedReport(
        localStorage.getItem(`${LOCAL_DRAFT_PREFIX}${userId}`),
      );
      setSaved(record);
      if (!record) clearLocalReport(localStorage, userId);
    } catch {
      setNotice(
        "Local storage is unavailable. Keep this page open while writing.",
      );
    }
  }, [userId]);

  function save() {
    if (!consent || userId === null) return;
    try {
      const record: SavedReport = { version: 1, savedAt: Date.now(), notes };
      if (!parseSavedReport(JSON.stringify(record)))
        throw new Error("Invalid draft");
      localStorage.setItem(
        `${LOCAL_DRAFT_PREFIX}${userId}`,
        JSON.stringify(record),
      );
      setSaved(record);
      setNotice(
        hi
          ? "इस डिवाइस पर सहेजा गया। अगले बदलाव के बाद फिर से सहेजें।"
          : "Saved on this device. Save again after making changes.",
      );
    } catch {
      setNotice(
        hi
          ? "सहेज नहीं पाए। यह पेज खुला रखें।"
          : "Could not save locally. Keep this page open.",
      );
    }
  }

  function remove() {
    if (userId === null) return;
    try {
      clearLocalReport(localStorage, userId);
      setSaved(null);
      setNotice(
        hi
          ? "सहेजी गई कॉपी हटा दी गई। पेज पर लिखा टेक्स्ट नहीं बदला है।"
          : "Saved copy deleted. Your current text is unchanged.",
      );
    } catch {
      setNotice(
        hi
          ? "कॉपी हटा नहीं पाए। ब्राउज़र सेटिंग जांचें।"
          : "Could not delete the saved copy. Check browser storage settings.",
      );
    }
  }

  return (
    <section
      className={r.notebook}
      aria-label={hi ? "स्थानीय मसौदा" : "Local draft"}
    >
      <div className={r.notebookHeading}>
        <span className={s.eyebrow}>
          {hi ? "आपकी नोटबुक" : "Your notebook"}
        </span>
        <span>{hi ? "बिना AI" : "No AI required"}</span>
      </div>
      <p>
        {hi
          ? "टेक्स्ट सिर्फ इस ब्राउज़र में रहेगा, ऑडियो नहीं। साझा डिवाइस पर न सहेजें। 7 दिन बाद कॉपी उपयोग नहीं होगी; पोस्ट या लॉग आउट पर हटा दी जाएगी।"
          : "Text only, in this browser. No recordings. Avoid shared devices. Copies expire after 7 days and are cleared on posting or sign-out."}
      </p>
      <label className={r.saveConsent}>
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        {hi
          ? "इस डिवाइस पर टेक्स्ट सहेजने की अनुमति है"
          : "Allow saving my text on this device"}
      </label>
      <div className={r.notebookActions}>
        <button
          type="button"
          className={s.secondaryBtn}
          onClick={save}
          disabled={
            !consent ||
            userId === null ||
            (!notes.rawText.trim() && !notes.review)
          }
        >
          {hi ? "मसौदा सहेजें" : "Save draft"}
        </button>
        {saved && (
          <>
            <button
              type="button"
              className={s.ghostBtn}
              onClick={() => {
                if (
                  (composeReport(notes).trim() || notes.review) &&
                  !window.confirm(
                    hi
                      ? "वर्तमान टेक्स्ट की जगह सहेजा मसौदा लाएं?"
                      : "Replace the current text with the saved draft?",
                  )
                )
                  return;
                onRestore(saved.notes);
                setNotice(
                  hi
                    ? "मसौदा वापस आ गया। पोस्ट करने से पहले समीक्षा करें।"
                    : "Draft restored. Review before posting; AI suggestions are not stored.",
                );
              }}
            >
              {hi ? "वापस लाएं" : "Restore draft"}
            </button>
            <button type="button" className={s.ghostBtn} onClick={remove}>
              {hi ? "कॉपी हटाएं" : "Delete saved copy"}
            </button>
          </>
        )}
      </div>
      {saved && (
        <small>
          {hi ? "अंतिम बार सहेजा" : "Last saved"}:{" "}
          {new Date(saved.savedAt).toLocaleString(hi ? "hi-IN" : "en-IN")}
        </small>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
