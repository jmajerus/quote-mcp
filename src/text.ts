import { decodeHTMLStrict } from "entities";

/**
 * A value read from outside as text: numbers and buffers as what they say, empty as null. A database column's type
 * isn't ours to assume, so anything else throws, rather than reading as "nothing there".
 */
export function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : Buffer.isBuffer(value) ? value.toString("utf8") : undefined;
  if (text === undefined) throw new Error(`Expected text, and found ${Object.prototype.toString.call(value)}.`);
  return text.trim() || null;
}

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

/** A title compared loosely, with its subtitle left off. */
export function normalizedTitle(title: string | null | undefined): string {
  const whole = decodeHTMLStrict(String(title ?? ""));
  return loose(whole.split(SUBTITLE)[0]) || loose(whole);
}

/** A whole title, subtitle included, compared loosely: for telling editions apart once short titles collide. */
export function fullTitle(title: string | null | undefined): string {
  return loose(String(title ?? ""));
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

/**
 * Text from a Calibre book as running prose, by corpus-mcp's rule (its reflow, kept identical): a line break
 * mid-sentence becomes a space; one after closing punctuation, before anything but a lowercase letter,
 * stays a paragraph break ("\n\n").
 */
export function reflow(text: string): string {
  return text.replace(/[ \t]*\n\s*/g, (brk: string, at: number, all: string) =>
    /[.!?:;"'”’)\]]/.test(all[at - 1] ?? "") && !/\p{Ll}/u.test(all[at + brk.length] ?? "") ? "\n\n" : " ");
}

/** A concept label as a slug: "work-life balance" → "work-life-balance". */
export function slugify(label: string): string {
  return label.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The first four-digit year in a date string. */
export function yearOf(date: string | null | undefined): string | null {
  return /\b(1[5-9]\d\d|20\d\d)\b/.exec(String(date ?? ""))?.[1] ?? null;
}
