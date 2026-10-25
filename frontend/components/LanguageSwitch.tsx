"use client";

import { useEffect, useState } from "react";
import styles from "./language.module.css";

export type Language = "en" | "hi";

export function useLanguage() {
  const [language, setLanguage] = useState<Language>("en");
  useEffect(() => {
    try {
      if (localStorage.getItem("prayaas_language") === "hi") setLanguage("hi");
    } catch {
      /* Preference is optional. */
    }
  }, []);
  const changeLanguage = (next: Language) => {
    setLanguage(next);
    try {
      localStorage.setItem("prayaas_language", next);
    } catch {
      /* Keep the in-memory choice. */
    }
  };
  return [language, changeLanguage] as const;
}

export default function LanguageSwitch({
  language,
  onChange,
}: {
  language: Language;
  onChange: (language: Language) => void;
}) {
  return (
    <div className={styles.switch} role="group" aria-label="Display language">
      <button
        type="button"
        lang="en"
        aria-pressed={language === "en"}
        onClick={() => onChange("en")}
      >
        English
      </button>
      <button
        type="button"
        lang="hi"
        aria-pressed={language === "hi"}
        onClick={() => onChange("hi")}
      >
        हिंदी
      </button>
    </div>
  );
}
