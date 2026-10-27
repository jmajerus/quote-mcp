/** A title compared loosely: case, accents, punctuation, and a subtitle after ":" ignored (corpus-mcp's rule). */
export function normalizedTitle(title: string | null | undefined): string {
  return String(title ?? "").split(/[:.?!]\s/)[0].toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").replace(/^(the|a|an) /, "").trim();
}

/** Quote text compared loosely, for finding one quote in two sources: its first 120 letters. */
export function quoteKey(text: string | null | undefined): string {
  return String(text ?? "").toLowerCase().replace(/[^a-z]+/g, "").slice(0, 120);
}

/** A concept label as a slug: "work-life balance" → "work-life-balance". */
export function slugify(label: string): string {
  return label.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The first four-digit year in a date string. */
export function yearOf(date: string | null | undefined): string | null {
  return /\b(1[5-9]\d\d|20\d\d)\b/.exec(String(date ?? ""))?.[1] ?? null;
}
