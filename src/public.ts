import type { DB } from "./db.js";
import { ToolError, citeQuote, ftsQuery, locatorText, workSummary } from "./queries.js";
import { esc } from "./web.js";

/**
 * What the public site may show of a record, for its pages (src/site.ts) and the public API (src/api.ts).
 * Its own queries and its own record shape, built field by field, so a field added to the store or the
 * admin pages stays private until it's added here.
 *
 * A public record has its text, place, work, and concepts. Notes, and a quote's comment (your own words
 * too), are public only with QUOTE_PUBLIC_NOTES=all, and a note tagged private never is. Status, grade,
 * flags, suspect words, plain tags, origins, and history never are.
 */

export type Level = "none" | "catalogue" | "quotes";

/** The part of the site's settings that decides what's public. */
export interface Visibility { level: Level; notes: boolean }

export class NotPublic extends Error {}

const sharesNotes = (v: Visibility) => v.level === "quotes" && v.notes;

/** The records a level makes public, as a condition on quotes q. Counts at the catalogue level use it too. */
export function visible(v: Visibility): string {
  const notes = sharesNotes(v)
    ? " OR (q.kind = 'note' AND NOT EXISTS (SELECT 1 FROM quote_tags p WHERE p.quote_id = q.id AND p.tag = 'private' COLLATE NOCASE))" : "";
  return `(q.status != 'unparsed' AND (q.kind = 'quote'${notes}))`;
}

// --- Quote text ----------------------------------------------------------------------------------

/**
 * Quote text without the old site's [bib]Key[/bib] markers, in-text citations of its Biblio records; the
 * sentence around them already names the work. For display only: the store keeps the text as imported.
 */
export function plainText(text: string): string {
  return text.replace(/\s*\[bib\][^[\]]*\[\/bib\]/g, "");
}

/** *emphasis* as the old site wrote it: a pair of asterisks around words, not a lone one. */
const EMPHASIS = /(^|[\s(“"'‘—–-])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=$|[\s).,;:!?”"'’—–-])/gm;

/** Quote text as HTML: escaped, with the old site's emphasis as <em>. */
export function quoteHtml(text: string): string {
  const t = plainText(text);
  let html = "";
  let last = 0;
  for (const m of t.matchAll(EMPHASIS)) {
    const start = m.index + m[1].length;
    html += `${esc(t.slice(last, start))}<em>${esc(m[2])}</em>`;
    last = m.index + m[0].length;
  }
  return html + esc(t.slice(last));
}

// --- Records -------------------------------------------------------------------------------------

export interface PublicWork { id: number; title: string; authors: string[]; year: string | null; citekey: string | null }

export interface PublicRecord {
  id: number;
  kind: "quote" | "note";
  /** What it quotes; empty for a note. */
  text: string;
  /** A note's words. */
  note?: string | null;
  /** A quote's comment, when notes are shared. */
  comment?: string;
  snippet?: string;
  locator: string | null;
  chapter_author: string | null;
  attribution: string | null;
  work: PublicWork | null;
  concepts: { scheme: string; slug: string; label: string }[];
}

type Row = Record<string, unknown>;

function publicWork(db: DB, id: number | null): PublicWork | null {
  const w = workSummary(db, id);
  return w ? { id: w.id, title: w.title, authors: w.authors, year: w.year, citekey: w.citekey } : null;
}

function record(db: DB, v: Visibility, q: Row, snippet: string | null = null): PublicRecord {
  const note = q.kind === "note";
  const comment = typeof q.comment === "string" && q.comment.trim() ? q.comment.trim() : null;
  const concepts = db.prepare(`SELECT s.slug AS scheme, c.slug, c.label FROM quote_tags t JOIN concepts c ON c.id = t.concept_id JOIN schemes s ON s.id = c.scheme_id
    WHERE t.quote_id = ? AND c.status != 'retired' GROUP BY c.id ORDER BY lower(c.label)`).all(q.id) as PublicRecord["concepts"];
  return {
    id: q.id as number,
    kind: note ? "note" : "quote",
    text: note ? "" : plainText(q.text as string),
    ...(note ? { note: comment } : comment && sharesNotes(v) ? { comment } : {}),
    ...(snippet ? { snippet: plainText(snippet) } : {}),
    locator: locatorText(q.locator_kind as string, (q.locator as string) ?? null),
    chapter_author: (q.chapter_author as string) ?? null,
    attribution: (q.attribution as string) ?? null,
    work: publicWork(db, (q.work_id as number) ?? null),
    concepts,
  };
}

function requireQuotes(v: Visibility): void {
  if (v.level !== "quotes") throw new NotPublic("Quotes aren't public on this site.");
}

/** One public record; a ToolError when there's no such record or it isn't public. */
export function publicRecord(db: DB, v: Visibility, id: number): PublicRecord {
  requireQuotes(v);
  const q = db.prepare(`SELECT q.* FROM quotes q WHERE q.id = ? AND ${visible(v)}`).get(id) as Row | undefined;
  if (!q) throw new ToolError(`No quote ${id}.`);
  return record(db, v, q);
}

export interface PublicSearch {
  query?: string;
  /** Only records tagged with one of these concepts. */
  conceptIds?: number[];
  work?: number;
  /** Newest first, rather than by id (or by page within a work). */
  newest?: boolean;
  limit?: number;
  offset?: number;
}

/** Public records, a page at a time: by words (ranked), concepts, or work (in page order). */
export function publicQuotes(db: DB, v: Visibility, args: PublicSearch) {
  requireQuotes(v);
  const where = [visible(v)];
  const params: Record<string, unknown> = {};
  let from = "quotes q";
  let order = args.newest ? "q.created_at DESC, q.id DESC" : "q.id";
  let snippet = "NULL";
  if (args.query?.trim()) {
    const terms = ftsQuery(args.query);
    if (!terms) throw new ToolError("The search has no words to look for.");
    from = "quotes_fts f JOIN quotes q ON q.id = f.rowid";
    where.push("quotes_fts MATCH @fts");
    // Comments are your own words, so they're searched only when notes are shared.
    params.fts = `${sharesNotes(v) ? "{text comment}" : "text"} : (${terms})`;
    order = "bm25(quotes_fts)";
    snippet = "CASE q.kind WHEN 'note' THEN snippet(quotes_fts, 1, '«', '»', '…', 24) ELSE snippet(quotes_fts, 0, '«', '»', '…', 24) END";
  }
  if (args.conceptIds) where.push(`q.id IN (SELECT quote_id FROM quote_tags WHERE concept_id IN (${args.conceptIds.map(Number).join(",")}))`);
  if (args.work !== undefined) {
    where.push("q.work_id = @work");
    params.work = args.work;
    if (!args.query?.trim()) order = "CAST(q.locator AS INTEGER) IS NULL OR CAST(q.locator AS INTEGER) = 0, CAST(q.locator AS INTEGER), q.id";
  }
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const offset = Math.max(args.offset ?? 0, 0);
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = db.prepare(`SELECT COUNT(*) FROM ${from} ${clause}`).pluck().get(params) as number;
  const rows = db.prepare(`SELECT q.*, ${snippet} AS snippet FROM ${from} ${clause} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(params) as Row[];
  return { total, offset, limit, quotes: rows.map((r) => record(db, v, r, r.snippet as string | null)) };
}

/** Public records tagged with each concept, by "scheme:slug", for the counts the graph and sets give. */
export function publicCounts(db: DB, v: Visibility): Map<string, number> {
  const rows = db.prepare(`SELECT s.slug AS scheme, c.slug, COUNT(DISTINCT q.id) AS n FROM quote_tags t JOIN quotes q ON q.id = t.quote_id
    JOIN concepts c ON c.id = t.concept_id JOIN schemes s ON s.id = c.scheme_id WHERE ${visible(v)} GROUP BY c.id`).all() as { scheme: string; slug: string; n: number }[];
  return new Map(rows.map((r) => [`${r.scheme}:${r.slug}`, r.n]));
}

/** Public records tagged with any of some concepts. */
export function publicCount(db: DB, v: Visibility, conceptIds: number[]): number {
  return db.prepare(`SELECT COUNT(DISTINCT q.id) FROM quotes q JOIN quote_tags t ON t.quote_id = q.id
    WHERE t.concept_id IN (${conceptIds.map(Number).join(",")}) AND ${visible(v)}`).pluck().get() as number;
}

// --- Citing --------------------------------------------------------------------------------------

type Csl = Record<string, unknown>;
type Name = { family?: string; given?: string; literal?: string };

const BIBTEX_TYPE: Record<string, string> = {
  book: "book", chapter: "incollection", "article-journal": "article", "article-magazine": "article", "article-newspaper": "article",
  "paper-conference": "inproceedings", report: "techreport", thesis: "phdthesis", webpage: "online",
};

/** A CSL JSON item as a BibTeX entry, for people who cite from BibTeX rather than Pandoc's CSL. */
export function bibtex(csl: Csl, key: string): string {
  const names = (v: unknown) => (Array.isArray(v) && v.length ? (v as Name[]).map((n) => n.literal ?? [n.family, n.given].filter(Boolean).join(", ")).join(" and ") : undefined);
  const year = ((csl.issued as { "date-parts"?: number[][] } | undefined)?.["date-parts"]?.[0]?.[0])?.toString();
  const type = BIBTEX_TYPE[csl.type as string] ?? "misc";
  const container = type === "incollection" ? "booktitle" : type === "article" ? "journal" : type === "inproceedings" ? "booktitle" : null;
  const fields: [string, unknown][] = [
    ["author", names(csl.author)], ["editor", names(csl.editor)], ["title", csl.title], [container ?? "", container ? csl["container-title"] : undefined],
    ["year", year], ["publisher", csl.publisher], ["address", csl["publisher-place"]], ["edition", csl.edition], ["volume", csl.volume],
    ["number", csl.issue], ["pages", csl.page], ["isbn", csl.ISBN], ["doi", csl.DOI], ["url", csl.URL],
  ];
  const value = (v: unknown) => String(v).replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  const lines = fields.filter(([k, v]) => k && v !== undefined && v !== null && value(v)).map(([k, v]) => `  ${k} = {${value(v)}}`);
  return `@${type}{${key.replace(/[\s,{}]/g, "")},\n${lines.join(",\n")}\n}`;
}

/** How to cite a public record: the Pandoc citation, BibTeX, and CSL JSON for its work. */
export function publicCitation(db: DB, v: Visibility, id: number) {
  publicRecord(db, v, id);
  const c = citeQuote(db, id);
  const key = c.citekey ?? (c.csl?.id as string | undefined) ?? null;
  return { pandoc: c.pandoc, citekey: c.citekey, csl: c.csl, bibtex: c.csl && key ? bibtex(c.csl, key) : null };
}
