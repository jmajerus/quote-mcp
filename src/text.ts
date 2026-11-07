import { decodeHTMLStrict } from "entities";

/** Words compared loosely: case, accents, punctuation, HTML escapes (a title or name pasted from a web page can keep them), a leading article, and & against "and" don't count. */
function loose(text: string): string {
  return decodeHTMLStrict(text).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/^(the|a|an) /, "");
}

/**
 * Where a subtitle starts: a colon, question or exclamation mark, or a spaced dash, and a bare em dash. A full stop
 * only after a word of four or more, so "Dr. Spock" and "U.S. Labor" keep their words, and just compare whole.
 */
const SUBTITLE = /[:?!]\s|\s[-–—]\s|—|(?<=[\p{L}\d]{4})\.\s/u;

/** A library catalogue's "One Who Is Not Busy, The: Connecting…" as "The One Who Is Not Busy: Connecting…". */
const articleFirst = (title: string) => title.replace(/^(.+?),\s*(the|an?)(?=\s*(?:[:?!]|$))/i, "$2 $1");

/** A title without what booksellers add at its end: "(Signet Classics)", "(2nd Edition)". */
const withoutTrailingNotes = (title: string) => title.replace(/(?:\s*\([^()]*\))+\s*$/, "");

/** A title compared loosely, with its subtitle and any trailing parenthetical left off. */
export function normalizedTitle(title: string | null | undefined): string {
  const whole = articleFirst(decodeHTMLStrict(String(title ?? "")));
  // Before the subtitle's taken off, since a note can hold a colon; and after, for "Work (2nd Edition): Why".
  const short = withoutTrailingNotes(withoutTrailingNotes(whole).split(SUBTITLE)[0]);
  return loose(short) || loose(whole);
}

/** A whole title, subtitle and parentheticals included, compared loosely: for telling editions apart once short titles collide. */
export function fullTitle(title: string | null | undefined): string {
  return loose(articleFirst(decodeHTMLStrict(String(title ?? ""))));
}

/** The surnames in a list of authors: what's before the comma in "Last, First", else the last word. */
function surnames(authors: string[]): Set<string> {
  return new Set(authors.map((a) => loose(a.includes(",") ? a.split(",")[0] : a.trim().split(/\s+/).pop() ?? "")).filter(Boolean));
}

/** Whether two author lists share a surname. */
export function shareAuthor(a: string[], b: string[]): boolean {
  const theirs = surnames(b);
  return [...surnames(a)].some((s) => theirs.has(s));
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
