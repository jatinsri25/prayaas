export const LOCAL_DRAFT_PREFIX = "prayaas_report_draft:";
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export const REPORT_CATEGORIES = [
  "Infrastructure",
  "Safety",
  "Sanitation",
  "Noise",
  "Maintenance",
  "Security",
  "Utilities",
  "Other",
];

export interface ReportNotes {
  rawText: string;
  topic: string;
  location: string;
  since: string;
  impact: string;
  language: "en" | "hi";
  review?: {
    title: string;
    category: string;
    severity: string;
    location: string;
    description_en: string;
    description_hi: string;
    affected_residents: string;
  };
}
export interface SavedReport {
  version: 1;
  savedAt: number;
  notes: ReportNotes;
}

export function composeReport(notes: ReportNotes): string {
  const hi = notes.language === "hi";
  return [
    notes.rawText.trim(),
    notes.location.trim() &&
      `${hi ? "स्थान" : "Location"}: ${notes.location.trim()}`,
    notes.since.trim() && `${hi ? "कब से" : "Since"}: ${notes.since.trim()}`,
    notes.impact.trim() && `${hi ? "असर" : "Impact"}: ${notes.impact.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseSavedReport(
  value: string | null,
  now = Date.now(),
): SavedReport | null {
  if (!value || value.length > 24000) return null;
  try {
    const record = JSON.parse(value);
    const notes = record.notes;
    const text = (value: unknown, max: number) =>
      typeof value === "string" && value.length <= max;
    if (
      record.version !== 1 ||
      !Number.isFinite(record.savedAt) ||
      record.savedAt > now ||
      now - record.savedAt >= MAX_AGE ||
      !notes ||
      !["en", "hi"].includes(notes.language) ||
      !REPORT_CATEGORIES.includes(notes.topic) ||
      !text(notes.rawText, 5000) ||
      !text(notes.location, 200) ||
      !text(notes.since, 200) ||
      !text(notes.impact, 300)
    )
      return null;
    const review = notes.review;
    if (
      review &&
      (!text(review.title, 200) ||
        !text(review.location, 200) ||
        !text(review.affected_residents, 300) ||
        !text(review.description_en, 5000) ||
        !text(review.description_hi, 5000) ||
        !REPORT_CATEGORIES.includes(review.category) ||
        !["Low", "Medium", "High", "Critical"].includes(review.severity))
    )
      return null;
    return {
      version: 1,
      savedAt: record.savedAt,
      notes: {
        rawText: notes.rawText,
        topic: notes.topic,
        location: notes.location,
        since: notes.since,
        impact: notes.impact,
        language: notes.language,
        ...(review
          ? {
              review: {
                title: review.title,
                category: review.category,
                severity: review.severity,
                location: review.location,
                description_en: review.description_en,
                description_hi: review.description_hi,
                affected_residents: review.affected_residents,
              },
            }
          : {}),
      },
    };
  } catch {
    return null;
  }
}

export function clearLocalReport(storage: Storage, userId: number) {
  storage.removeItem(`${LOCAL_DRAFT_PREFIX}${userId}`);
}
