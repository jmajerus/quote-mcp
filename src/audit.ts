import type { DB } from "./db.js";
import { PAGE_REFERENCE as PAGE_REF, type ParsedNote, noteText, parseNote } from "./parse.js";

/**
 * Compares each quote with the raw source it was parsed from, read-only. Only what was typed by hand is checked: old-site
 * spans and Zotero notes. A quote saved by add_quote or the capture form has its own structure, so it's only counted.
 */

export const AUDIT_KINDS = {
  several_passages: "several passages in one record, each with its own page",
  held: "may hold several quotes, and can't be split without a person",
  page_in_text: "a page reference left in the text",
  marks_off_pattern: "marks off the pattern: an opening or closing mark missing, or double marks inside the quote",
  no_marks: "no quotation marks of its own",
  lead_in: "words before the opening mark stored in the text",
  comment_differs: "comment isn't what the words outside the marks say",
  locator_differs: "stored page isn't the one the raw gives",
  pages_backward: "pages run backwards",
  passage_gone: "a passage no longer in its note",
  words_lost: "words in the raw that aren't in the record",
  words_added: "words in the record that aren't in the raw",
  words_reordered: "words in a different order from the raw",
} as const;
export type AuditKind = keyof typeof AUDIT_KINDS;

export interface AuditRecord {
  id: number; status: string; edited: boolean; kinds: AuditKind[];
  origin: { kind: string; ref: string }; raw: string;
  stored: { text: string; locator: string | null; comment: string | null };
  parsed: { text?: string; locator?: string; comment?: string; flags: string[]; problems: string[] }[];
  /** Whether the parser now reads the raw as the record has it. */
  matches: boolean;
  lost: string[]; added: string[];
}

interface Row { id: number; text: string; locator: string | null; comment: string | null; chapter_author: string | null; attribution: string | null; status: string; edited: number }

const words = (text: string) => (text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2018\u2019]/g, "'").match(/[a-z0-9']+/g) ?? [])
  .map((t) => t.replace(/^'+|'+$/g, "")).filter(Boolean);
const parseOrigin = (o: { kind: string; raw: string }) => parseNote(o.kind === "drupal-quote" ? `<p><span class="quote">${o.raw}</span></p>` : o.raw);
const plainOf = (o: { kind: string; raw: string }) => noteText(o.kind === "drupal-quote" ? `<p>${o.raw}</p>` : o.raw);
/** Which passage of its note a Zotero origin holds: <library>:<key>#2 is the second. (An old-site ref's # is its own span's number.) */
const passageOf = (o: { kind: string; ref: string }) => (o.kind === "zotero-note" ? Number(/#(\d+)$/.exec(o.ref)?.[1] ?? 1) - 1 : 0);

/** What's in `a` beyond what's in `b`, counting repeats. */
function beyond(a: string[], b: string[]): string[] {
  const have = new Map<string, number>();
  for (const t of b) have.set(t, (have.get(t) ?? 0) + 1);
  return a.filter((t) => {
    const n = have.get(t) ?? 0;
    if (n) have.set(t, n - 1);
    return !n;
  });
}

function isSubsequence(part: string[], whole: string[]): boolean {
  let at = 0;
  for (const t of part) {
    while (at < whole.length && whole[at] !== t) at++;
    if (at++ >= whole.length) return false;
  }
  return true;
}

function auditOne(q: Row, origins: { kind: string; ref: string; raw: string }[], isSplit: (o: { kind: string; ref: string }) => boolean, flagged: string[]): AuditRecord {
  // An attribution comes from the source's own fields, not its words.
  const mine = words([q.text, q.comment, q.chapter_author].filter(Boolean).join(" "));
  /** The parts of an origin's note this record stands for: one, once its note has been split into several records. */
  const partsOf = (o: { kind: string; ref: string; raw: string }): ParsedNote[] => {
    const parsed = parseOrigin(o);
    const all = [parsed, ...(parsed.more ?? [])];
    return isSplit(o) ? all.slice(passageOf(o), passageOf(o) + 1) : all;
  };
  const givesPage = (o: { kind: string; ref: string; raw: string }) => (partsOf(o)[0]?.locator?.value ?? null) === q.locator;
  // A quote found in two sources was parsed from one of them: the one closest to it.
  const closest = origins.map((o) => {
    // Once split, the record is compared with its own passage, not the whole note.
    const plain = isSplit(o) ? partsOf(o).map((p) => [p.text, p.commentary].filter(Boolean).join(" ")).join(" ") : plainOf(o);
    const theirs = words(plain.replace(PAGE_REF, " "));
    return { o, plain, theirs, lost: beyond(theirs, mine), added: beyond(mine, words(plain)) };
    // Sources can have the same words, and only one the page.
  }).sort((a, b) => a.lost.length + a.added.length - b.lost.length - b.added.length || Number(givesPage(b.o)) - Number(givesPage(a.o)))[0];
  const { o, plain, theirs, lost, added } = closest;
  const parts = partsOf(o);
  const kinds: AuditKind[] = [];
  if (!parts.length || flagged.includes("passage_gone")) {
    return { id: q.id, status: q.status, edited: !!q.edited, kinds: ["passage_gone"], origin: { kind: o.kind, ref: o.ref }, raw: o.raw, stored: { text: q.text, locator: q.locator, comment: q.comment }, parsed: [], matches: false, lost: [], added: [] };
  }
  const parsed = parts[0];
  const flags = new Set(parts.flatMap((p) => p.flags));
  const first = parts[0];
  const pages = [...plain.matchAll(PAGE_REF)].map((m) => Number(/\d+/.exec(m[0])?.[0] ?? NaN)).filter((n) => !Number.isNaN(n));
  if (parts.length > 1) kinds.push("several_passages");
  if (parsed.problems.length) kinds.push("held");
  if (q.text.match(PAGE_REF)) kinds.push("page_in_text");
  if (flags.has("unbalanced_quotes")) kinds.push("marks_off_pattern");
  if (flags.has("no_marks")) kinds.push("no_marks");
  if (flags.has("lead_in") && q.text !== first.text) kinds.push("lead_in");
  if (parts.length === 1 && !parsed.problems.length && (q.comment ?? "") !== (first.commentary ?? "")) kinds.push("comment_differs");
  if ((q.locator ?? null) !== (first.locator?.value ?? null) && !parsed.problems.length) kinds.push("locator_differs");
  if (pages.some((n, i) => i > 0 && n < pages[i - 1])) kinds.push("pages_backward");
  if (lost.length) kinds.push("words_lost");
  if (added.length) kinds.push("words_added");
  if (!lost.length && !added.length && !isSubsequence(words(q.text.replace(PAGE_REF, " ")), theirs)) kinds.push("words_reordered");
  const matches = parts.length === 1 && q.text === first.text && (q.locator ?? null) === (first.locator?.value ?? null) && (q.comment ?? null) === (first.commentary ?? null);
  return {
    id: q.id, status: q.status, edited: !!q.edited, kinds, origin: { kind: o.kind, ref: o.ref }, raw: o.raw,
    stored: { text: q.text, locator: q.locator, comment: q.comment },
    parsed: parts.map((p) => ({ text: p.text, locator: p.locator?.value, comment: p.commentary, flags: p.flags, problems: p.problems })),
    matches, lost, added,
  };
}

export interface AuditReport {
  quotes: number; checked: number; notTyped: number; clean: number;
  kinds: Record<AuditKind, { count: number; verified: number; edited: number; ids: number[] }>;
  records: AuditRecord[];
}

/** Every typed quote against its raw. */
export function auditStore(db: DB): AuditReport {
  const rows = db.prepare("SELECT id, text, locator, comment, chapter_author, attribution, status, edited, flags FROM quotes WHERE kind = 'quote' ORDER BY id").all() as (Row & { flags: string })[];
  const refs = new Set(db.prepare("SELECT ref FROM quote_origins WHERE kind = 'zotero-note'").pluck().all() as string[]);
  /** A note already stored as several records: it has a numbered origin, or is one. */
  const isSplit = (o: { kind: string; ref: string }) => o.kind === "zotero-note" && (/#\d+$/.test(o.ref) || refs.has(`${o.ref}#2`));
  const originsOf = db.prepare("SELECT kind, ref, raw FROM quote_origins WHERE quote_id = ? AND kind IN ('drupal', 'drupal-quote', 'zotero-note') AND raw IS NOT NULL ORDER BY rowid");
  const records: AuditRecord[] = [];
  for (const q of rows) {
    const origins = originsOf.all(q.id) as { kind: string; ref: string; raw: string }[];
    if (origins.length) records.push(auditOne(q, origins, isSplit, JSON.parse(q.flags) as string[]));
  }
  const kinds = Object.fromEntries(Object.keys(AUDIT_KINDS).map((k) => {
    const hit = records.filter((r) => r.kinds.includes(k as AuditKind));
    return [k, { count: hit.length, verified: hit.filter((r) => r.status === "verified").length, edited: hit.filter((r) => r.edited).length, ids: hit.map((r) => r.id) }];
  })) as AuditReport["kinds"];
  return { quotes: rows.length, checked: records.length, notTyped: rows.length - records.length, clean: records.filter((r) => !r.kinds.length && r.matches).length, kinds, records };
}

/** One quote's raw, stored record, and what the parser reads now, side by side. */
export function auditOf(db: DB, id: number): AuditRecord | null {
  return auditStore(db).records.find((r) => r.id === id) ?? null;
}
