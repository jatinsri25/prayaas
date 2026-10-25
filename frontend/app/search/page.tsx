"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { initAuth, loadUserFromStorage } from "@/lib/auth";
import { extractError } from "@/lib/api";
import {
  insightsApi,
  type SearchFilters,
  type SearchResponse,
} from "@/lib/insights";
import SharedNav from "@/components/SharedNav";
import LanguageSwitch, { useLanguage } from "@/components/LanguageSwitch";
import s from "@/components/shared.module.css";
import styles from "../insights.module.css";

const emptyFilters: SearchFilters = {
  status: null,
  category: null,
  location: null,
  keywords: [],
  created_after: null,
  created_before: null,
  sort: "newest",
};
const categories = [
  "Infrastructure",
  "Safety",
  "Sanitation",
  "Noise",
  "Maintenance",
  "Security",
  "Utilities",
  "Other",
];

export default function SearchPage() {
  const router = useRouter();
  const [language, setLanguage] = useLanguage();
  const hi = language === "hi";
  const [mode, setMode] = useState<"ai" | "filters">("ai");
  const [query, setQuery] = useState("");
  const [topics, setTopics] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(emptyFilters);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    let mounted = true;
    if (!loadUserFromStorage()) {
      router.replace("/login");
      return;
    }
    initAuth().then((authenticated) => {
      if (mounted) {
        setReady(authenticated);
        if (!authenticated)
          setError("Could not restore your session. Please sign in again.");
      }
    });
    return () => {
      mounted = false;
      request.current?.abort();
    };
  }, [router]);

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await insightsApi.search(
        mode === "ai"
          ? { query, mode }
          : {
              filters: {
                ...filters,
                keywords: topics
                  .split("|")
                  .map((value) => value.trim())
                  .filter(Boolean),
              },
              mode,
            },
        controller.signal,
      );
      if (!controller.signal.aborted) setResult(response.data);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          extractError(
            error,
            "Search could not be completed. Use basic filters or try again.",
          ),
        );
    } finally {
      if (request.current === controller) {
        setLoading(false);
        request.current = null;
      }
    }
  };
  const changeMode = (next: "ai" | "filters") => {
    request.current?.abort();
    request.current = null;
    if (next === "filters" && result) {
      setFilters(result.filters);
      setTopics(result.filters.keywords.join(" | "));
    }
    setLoading(false);
    setMode(next);
    setResult(null);
    setError("");
  };
  const update = (name: keyof SearchFilters, value: string) =>
    setFilters((current) => ({ ...current, [name]: value || null }));

  return (
    <main className={s.page}>
      <SharedNav active="search" />
      <div className={styles.content}>
        <Link href="/dashboard" className={styles.back}>
          ← {hi ? "समुदाय की ओर लौटें" : "Back to your neighbourhood"}
        </Link>
        <header className={styles.headingRow}>
          <div>
            <span className={s.eyebrow}>
              {hi ? "सही रिपोर्ट, आसानी से" : "Less scrolling. More finding."}
            </span>
            <h1>
              {hi ? "अपनी भाषा में खोजें।" : "Find it in your own words."}
            </h1>
            <p>
              {hi
                ? "अंग्रेजी, हिंदी या हिंग्लिश में खोजें। AI केवल फ़िल्टर बनाता है; परिणाम आपके वास्तविक, उपलब्ध रिकॉर्ड से आते हैं।"
                : "Search in English, Hindi or Hinglish. AI interprets the filters; the results come from real reports you can access."}
            </p>
          </div>
          <LanguageSwitch language={language} onChange={setLanguage} />
        </header>
        <form className={styles.panel} onSubmit={search}>
          <div className={styles.modes} role="group" aria-label="Search mode">
            <button
              type="button"
              aria-pressed={mode === "ai"}
              onClick={() => changeMode("ai")}
            >
              {hi ? "अपनी भाषा में" : "Plain language"}
            </button>
            <button
              type="button"
              aria-pressed={mode === "filters"}
              onClick={() => changeMode("filters")}
            >
              {hi ? "सीधे फ़िल्टर / बिना AI" : "Basic filters / no AI"}
            </button>
          </div>
          {mode === "ai" ? (
            <>
              <div className={styles.searchRow}>
                <label className={styles.label} htmlFor="search-query">
                  {hi
                    ? "कौन सी रिपोर्ट खोज रहे हैं?"
                    : "What are you looking for?"}
                  <input
                    id="search-query"
                    className={s.formInput}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    maxLength={500}
                    minLength={3}
                    required
                    placeholder={
                      hi
                        ? "इस महीने Wing B में पानी की खुली शिकायतें"
                        : "Open water issues in Wing B this month"
                    }
                    lang={language}
                  />
                </label>
                <button
                  type="submit"
                  className={s.primaryBtn}
                  disabled={!ready || loading || query.trim().length < 3}
                >
                  {loading
                    ? hi
                      ? "खोज जारी…"
                      : "Searching…"
                    : hi
                      ? "रिपोर्ट खोजें"
                      : "Find reports"}
                </button>
              </div>
              <div className={styles.examples}>
                {[
                  "Open water issues in Wing B this month",
                  "पिछले महीने हल हुई शिकायतें",
                  "Noise reports with the most votes",
                ].map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setQuery(example)}
                  >
                    {example}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className={styles.filters}>
                <label className={styles.label}>
                  {hi ? "स्थिति" : "Status"}
                  <select
                    className={s.formSelect}
                    value={filters.status || ""}
                    onChange={(e) => update("status", e.target.value)}
                  >
                    <option value="">All</option>
                    {["Open", "In Progress", "Resolved"].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.label}>
                  {hi ? "श्रेणी" : "Category"}
                  <select
                    className={s.formSelect}
                    value={filters.category || ""}
                    onChange={(e) => update("category", e.target.value)}
                  >
                    <option value="">All</option>
                    {categories.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.label}>
                  {hi ? "स्थान" : "Location"}
                  <input
                    className={s.formInput}
                    value={filters.location || ""}
                    onChange={(e) => update("location", e.target.value)}
                    maxLength={100}
                    placeholder="Wing B"
                  />
                </label>
                <label className={styles.label}>
                  {hi
                    ? "अधिकतम 4 विषय (अलग करने के लिए |)"
                    : "Up to 4 topics (separate with |)"}
                  <input
                    className={s.formInput}
                    value={topics}
                    onChange={(e) => setTopics(e.target.value)}
                    maxLength={249}
                    placeholder={hi ? "पानी | water" : "water | पानी"}
                  />
                </label>
                <label className={styles.label}>
                  {hi ? "इस तारीख से" : "Created from (inclusive)"}
                  <input
                    type="date"
                    className={s.formInput}
                    value={filters.created_after || ""}
                    onChange={(e) => update("created_after", e.target.value)}
                  />
                </label>
                <label className={styles.label}>
                  {hi ? "इस तारीख से पहले" : "Created before (exclusive)"}
                  <input
                    type="date"
                    className={s.formInput}
                    value={filters.created_before || ""}
                    onChange={(e) => update("created_before", e.target.value)}
                  />
                </label>
                <label className={styles.label}>
                  {hi ? "क्रम" : "Sort by"}
                  <select
                    className={s.formSelect}
                    value={filters.sort}
                    onChange={(e) =>
                      setFilters({
                        ...filters,
                        sort: e.target.value as SearchFilters["sort"],
                      })
                    }
                  >
                    <option value="newest">
                      {hi ? "सबसे नई" : "Newest first"}
                    </option>
                    <option value="most_votes">
                      {hi ? "सबसे अधिक वोट" : "Most votes"}
                    </option>
                  </select>
                </label>
              </div>
              <button
                type="submit"
                className={s.primaryBtn}
                disabled={!ready || loading}
              >
                {hi ? "फ़िल्टर लगाएं" : "Apply filters"}
              </button>
            </>
          )}
          <p className={styles.note} style={{ marginTop: 18 }}>
            {hi
              ? "फ़िल्टर खोज में कोई AI कॉल नहीं होती। तारीखें भारतीय मानक समय में हैं।"
              : "Basic filters never call AI. Date boundaries use India Standard Time."}
          </p>
        </form>
        {error && (
          <div className={s.errorBlock} role="alert">
            {error}
            {mode === "ai" && (
              <div className={styles.actions}>
                <button
                  className={s.secondaryBtnSm}
                  onClick={() => changeMode("filters")}
                >
                  {hi
                    ? "बिना AI फ़िल्टर इस्तेमाल करें"
                    : "Use basic filters instead"}
                </button>
              </div>
            )}
          </div>
        )}
        {loading && (
          <p className={styles.status} role="status">
            {hi ? "रिपोर्ट खोज रहे हैं…" : "Finding matching reports…"}
          </p>
        )}
        {result && (
          <section aria-label="Search results">
            <p className={styles.note}>
              {result.results.length} {hi ? "रिपोर्ट मिलीं" : "reports found"}
              {result.cache_hit
                ? hi
                  ? " · सहेजे हुए फ़िल्टर"
                  : " · cached interpretation, fresh results"
                : ""}
            </p>
            <div className={styles.applied} aria-label="Applied filters">
              {Object.entries(result.filters)
                .filter(
                  ([, value]) =>
                    value && (!Array.isArray(value) || value.length),
                )
                .map(([name, value]) => (
                  <span key={name}>
                    {name.replaceAll("_", " ")}:{" "}
                    {Array.isArray(value) ? value.join(" / ") : value}
                  </span>
                ))}
            </div>
            <p className={styles.note} style={{ marginBottom: 20 }}>
              {hi
                ? "AI ने गलत फ़िल्टर चुना? सीधे फ़िल्टर में सुधार करें।"
                : "Interpretation not quite right? Switch to basic filters to make it precise."}
            </p>
            {result.results.length ? (
              <div className={styles.results}>
                {result.results.map((report) => (
                  <article key={report.id} className={styles.result}>
                    <div className={styles.resultMeta}>
                      <span>#{report.id}</span>
                      <span>{report.status}</span>
                      <span>{report.category}</span>
                      <span>{report.location}</span>
                      <span>{report.upvotes} votes</span>
                    </div>
                    <h2>
                      <Link href={`/problems/${report.id}`}>
                        {report.title}
                      </Link>
                    </h2>
                    <p lang={hi && report.description_hi ? "hi" : undefined}>
                      {(hi ? report.description_hi : report.description_en) ||
                        report.formatted_description}
                    </p>
                  </article>
                ))}
              </div>
            ) : (
              <div className={styles.empty}>
                <h2>
                  {hi ? "अभी कोई मेल नहीं मिला।" : "No matching reports."}
                </h2>
                <p className={styles.note}>
                  {hi
                    ? "स्थान, तारीख या विषय को थोड़ा बदलकर देखें।"
                    : "Try a broader location, date range, or topic. No results were invented."}
                </p>
              </div>
            )}
            {result.has_more && (
              <p className={styles.notice}>
                Showing the first 50 reports. Narrow your filters to see a
                smaller set.
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
