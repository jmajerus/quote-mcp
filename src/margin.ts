/**
 * Reads the free text attached to a mark (a margin note, a note on a highlight) as concept tags, prose,
 * or both. Many such notes, especially on a Kindle, only name concepts, the same tagging the paper books
 * got; those become tags rather than a comment.
 *
 *   1. Split on commas, semicolons, and line breaks. If every piece is a concept, it's tags.
 *   2. If every piece is short (up to four words, no sentence punctuation or dash), it's still tags;
 *      pieces that aren't concepts are kept as tags without one, for the unresolved-tags worklist.
 *   3. Otherwise it's prose. Leading pieces that are concepts ("mobbing, false self — compare Goffman",
 *      where a dash also ends a piece) become tags, and the rest stays prose.
 *   4. A word written as `.mobbing` or `.false-self` is always a tag, wherever it is.
 */

export interface MarginReading {
  tags: { tag: string; conceptId: number | null }[];
  prose: string | null;
}

/** A concept's id from a label, alternative label, or slug, ignoring case; null when there's none. */
export type Resolve = (name: string) => number | null;

const SEPARATOR = /\s*[,;\n]\s*/g;
const SEPARATOR_OR_DASH = /\s*(?:[,;\n]|\s[–-]\s|—)\s*/g;
const DOT_TAG = /(?<=^|[\s,;])\.([A-Za-z][\w-]*)(?=$|[\s,;.!?])/g;
const SENTENCE = /[.!?:"“”()[\]—–]|\s-\s/;
export const SHORT_WORDS = 4;

/** The pieces of a text with where each starts, split at the separators. */
function pieces(text: string, separator: RegExp): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = 0;
  for (const m of text.matchAll(separator)) {
    out.push({ text: text.slice(start, m.index), start });
    start = m.index + m[0].length;
  }
  out.push({ text: text.slice(start), start });
  return out.filter((p) => p.text.trim());
}

export function readMargin(raw: string, resolve: Resolve): MarginReading {
  const tags: MarginReading["tags"] = [];
  const seen = new Set<string>();
  const add = (tag: string, conceptId: number | null) => {
    if (seen.has(tag.toLowerCase())) return;
    seen.add(tag.toLowerCase());
    tags.push({ tag, conceptId });
  };

  // Rule 4 first, so the rest is read without them.
  const text = raw.replace(DOT_TAG, (_, name: string) => {
    const conceptId = resolve(name) ?? resolve(name.replace(/-/g, " "));
    add(name.replace(/-/g, " "), conceptId);
    return "";
  }).replace(/^[\s,;]+|[\s,;]+$/g, "").replace(/[ \t]{2,}/g, " ");
  let list = pieces(text, SEPARATOR);
  if (!list.length) return { tags, prose: null };

  let resolved = list.map((p) => resolve(p.text.trim()));
  const short = (p: string) => !SENTENCE.test(p) && p.trim().split(/\s+/).length <= SHORT_WORDS;
  if (resolved.every((id) => id !== null) || list.every((p) => short(p.text))) {
    list.forEach((p, i) => add(p.text.trim(), resolved[i]));
    return { tags, prose: null };
  }
  list = pieces(text, SEPARATOR_OR_DASH);
  resolved = list.map((p) => resolve(p.text.trim()));
  let i = 0;
  for (; i < list.length && resolved[i] !== null; i++) add(list[i].text.trim(), resolved[i]);
  return { tags, prose: i < list.length ? text.slice(list[i].start).trim() || null : null };
}
