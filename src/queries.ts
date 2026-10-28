import Database from "better-sqlite3";
import { citekeyOf, zoteroToCsl } from "./csl.js";
import type { DB } from "./db.js";
import { RELATION_LABEL, ToolError, ftsQuery } from "./common.js";
import type { ApiItem } from "./zotero.js";

export { RELATION_LABEL, ToolError, ftsQuery };

/**
 * Read-only queries over the quote store, shared by the MCP tools and the admin pages. Unparsed quotes
 * (grade C, waiting for a person to split them) are left out of search unless asked for. Notes (your own
 * words, with no quoted text) are found beside quotes unless a kind is asked for.
 */


export function openReadOnly(path = process.env.QUOTE_DB ?? "data/quotes.db"): DB {
  try {
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new Error(`Cannot open the quote store ${path} (${(error as Error).message}). Run the import first.`);
  }
}

const json = <T>(v: string | null | undefined, fallback: T): T => (v ? (JSON.parse(v) as T) : fallback);


export interface WorkSummary {
  id: number; title: string; authors: string[]; year: string | null; match: string; zotero_library: string | null; zotero_key: string | null; citekey: string | null;
}

export function workSummary(db: DB, workId: number | null): WorkSummary | null {
  if (workId === null) return null;
  const w = db.prepare("SELECT * FROM works WHERE id = ?").get(workId) as Record<string, unknown> | undefined;
  if (!w) return null;
  return {
    id: w.id as number, title: w.title as string, authors: json(w.authors as string, []), year: (w.year as string) ?? null, match: w.match as string,
    zotero_library: (w.zotero_library as string) ?? null, zotero_key: (w.zotero_key as string) ?? null, citekey: zoteroData(db, w.zotero_library as string, w.zotero_key as string)?.citekey ?? null,
  };
}

function zoteroData(db: DB, library: string | null, key: string | null) {
  if (!library || !key) return null;
  const row = db.prepare("SELECT data FROM zotero_items WHERE library = ? AND key = ?").get(library, key) as { data: string } | undefined;
  if (!row) return null;
  const data = JSON.parse(row.data) as ApiItem["data"] & Record<string, unknown>;
  return { data, citekey: citekeyOf(data) };
}

export function locatorText(kind: string, value: string | null): string | null {
  if (!value) return null;
  if (kind === "kindle") return `Kindle loc. ${value}`;
  return /[–-]/.test(value) ? `pp. ${value}` : `p. ${value}`;
}

// --- Concepts ------------------------------------------------------------------------------------

export interface ConceptRow { id: number; scheme: string; slug: string; label: string }

/** A concept by slug ("job-loss"), label ("job loss"), alternative label, or scheme:slug ("human-work:job-loss"). */
export function findConcept(db: DB, name: string): ConceptRow {
  const [scheme, slug] = name.includes(":") ? name.split(":", 2) : [null, name];
  const rows = db.prepare(`SELECT c.id, s.slug AS scheme, c.slug, c.label, c.alt_labels FROM concepts c JOIN schemes s ON s.id = c.scheme_id
    WHERE (? IS NULL OR s.slug = ?) AND c.status != 'retired'`).all(scheme, scheme) as (ConceptRow & { alt_labels: string })[];
  const n = slug.trim().toLowerCase();
  const hit = rows.find((c) => c.slug === n || c.label.toLowerCase() === n) ?? rows.find((c) => json<string[]>(c.alt_labels, []).some((a) => a.toLowerCase() === n));
  if (!hit) throw new ToolError(`No concept "${name}". list_concepts shows them.`);
  return { id: hit.id, scheme: hit.scheme, slug: hit.slug, label: hit.label };
}

/** A concept and everything narrower than it, at any depth. */
export function withNarrower(db: DB, id: number): number[] {
  const seen = new Set([id]);
  const next = db.prepare("SELECT to_id FROM concept_relations WHERE from_id = ? AND type = 'narrower'");
  for (const current of seen) for (const r of next.all(current) as { to_id: number }[]) seen.add(r.to_id);
  return [...seen];
}

export interface ConceptListing {
  scheme: string; slug: string; label: string; definition: string | null; alt_labels: string[]; status: string; quotes: number;
}

export function listConcepts(db: DB, args: { query?: string; scheme?: string; within?: { scheme: string; slugs: string[] } } = {}): ConceptListing[] {
  const q = args.query ? `%${args.query.toLowerCase()}%` : null;
  const within = args.within ? JSON.stringify(args.within.slugs) : null;
  return (db.prepare(`
    SELECT s.slug AS scheme, c.slug, c.label, c.definition, c.alt_labels, c.status,
      (SELECT COUNT(DISTINCT t.quote_id) FROM quote_tags t JOIN quotes q ON q.id = t.quote_id WHERE t.concept_id = c.id AND q.status != 'unparsed') AS quotes
    FROM concepts c JOIN schemes s ON s.id = c.scheme_id
    WHERE (@scheme IS NULL OR s.slug = @scheme) AND c.status != 'retired'
      AND (@within IS NULL OR (s.slug = @withinScheme AND c.slug IN (SELECT value FROM json_each(@within))))
      AND (@q IS NULL OR lower(c.label) LIKE @q OR lower(c.alt_labels) LIKE @q OR lower(COALESCE(c.definition, '')) LIKE @q)
    ORDER BY c.label`).all({ scheme: args.scheme ?? null, q, within, withinScheme: args.within?.scheme ?? null }) as (Omit<ConceptListing, "alt_labels"> & { alt_labels: string })[])
    .map((c) => ({ ...c, alt_labels: json<string[]>(c.alt_labels, []) }));
}

/**
 * Every concept that isn't retired, with its quote count, and the relations between them: the concept
 * graph in one piece, for the map. `source` is where a concept came from (`drupal:kid:N` for the old
 * site's), which the map uses to place concepts as the old site's layout did.
 */
export function conceptGraph(db: DB) {
  const concepts = (db.prepare(`
    SELECT c.slug, s.slug AS scheme, c.label, c.alt_labels, c.status, c.source,
      (SELECT COUNT(DISTINCT t.quote_id) FROM quote_tags t JOIN quotes q ON q.id = t.quote_id WHERE t.concept_id = c.id AND q.status != 'unparsed') AS quotes
    FROM concepts c JOIN schemes s ON s.id = c.scheme_id WHERE c.status != 'retired' ORDER BY s.slug, c.slug`)
    .all() as { slug: string; scheme: string; label: string; alt_labels: string; status: string; source: string | null; quotes: number }[])
    .map((c) => ({ ...c, alt_labels: json<string[]>(c.alt_labels, []) }));
  const relations = db.prepare(`
    SELECT a.slug AS "from", b.slug AS "to", r.type FROM concept_relations r
    JOIN concepts a ON a.id = r.from_id JOIN concepts b ON b.id = r.to_id
    WHERE a.status != 'retired' AND b.status != 'retired' ORDER BY a.slug, b.slug, r.type`).all() as { from: string; to: string; type: string }[];
  return { concepts, relations };
}

export function getConcept(db: DB, name: string) {
  const c = findConcept(db, name);
  const row = db.prepare("SELECT definition, alt_labels, close_match, status, source FROM concepts WHERE id = ?").get(c.id) as Record<string, string | null>;
  const relations = db.prepare(`SELECT r.type, o.slug, o.label FROM concept_relations r JOIN concepts o ON o.id = r.to_id WHERE r.from_id = ? ORDER BY r.type, o.label`)
    .all(c.id) as { type: string; slug: string; label: string }[];
  const grouped: Record<string, { slug: string; label: string }[]> = {};
  for (const r of relations) (grouped[RELATION_LABEL[r.type]] ??= []).push({ slug: r.slug, label: r.label });
  const count = (ids: number[]) => (db.prepare(`SELECT COUNT(DISTINCT t.quote_id) FROM quote_tags t JOIN quotes q ON q.id = t.quote_id
    WHERE q.status != 'unparsed' AND t.concept_id IN (${ids.map(() => "?").join(",")})`).pluck().get(...ids) as number);
  return {
    ...c, definition: row.definition, alt_labels: json<string[]>(row.alt_labels, []), wordnet: row.close_match, status: row.status, source: row.source,
    relations: grouped, quotes: count([c.id]), quotes_with_narrower: count(withNarrower(db, c.id)),
  };
}

// --- Quotes --------------------------------------------------------------------------------------


export interface SearchArgs {
  query?: string;
  concept?: string;
  /** Include quotes tagged with narrower concepts too (default true). */
  narrower?: boolean;
  /** Only quotes tagged with one of these concepts: a concept set's, as src/sets.ts works it out. */
  within?: { scheme: string; slugs: string[] };
  tag?: string;
  author?: string;
  work?: string;
  flag?: string;
  status?: "transcribed" | "verified" | "unparsed" | "any";
  kind?: "quote" | "note" | "any";
  limit?: number;
  offset?: number;
}

export function searchQuotes(db: DB, args: SearchArgs) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  let from = "quotes q";
  let order = "q.id";
  let snippet = "NULL";
  if (args.query?.trim()) {
    from = "quotes_fts f JOIN quotes q ON q.id = f.rowid";
    where.push("quotes_fts MATCH @fts");
    const terms = ftsQuery(args.query);
    if (!terms) throw new ToolError("The query has no words to search for.");
    // Words are looked for in what the quote says (and its comment), not in its tags: the concept and
    // tag filters cover those, and a phrase search must tell a source that uses a term from one tagged with it.
    params.fts = `{text comment} : (${terms})`;
    order = "bm25(quotes_fts)";
    // A note's words are its comment; a quote's snippet comes from what it quotes.
    snippet = "CASE q.kind WHEN 'note' THEN snippet(quotes_fts, 1, '«', '»', '…', 24) ELSE snippet(quotes_fts, 0, '«', '»', '…', 24) END";
  }
  if (args.concept) {
    const c = findConcept(db, args.concept);
    const ids = args.narrower === false ? [c.id] : withNarrower(db, c.id);
    where.push(`q.id IN (SELECT quote_id FROM quote_tags WHERE concept_id IN (${ids.join(",")}))`);
  }
  if (args.within) {
    where.push(`q.id IN (SELECT t.quote_id FROM quote_tags t JOIN concepts c ON c.id = t.concept_id JOIN schemes s ON s.id = c.scheme_id
      WHERE s.slug = @withinScheme AND c.slug IN (SELECT value FROM json_each(@withinSlugs)))`);
    params.withinScheme = args.within.scheme;
    params.withinSlugs = JSON.stringify(args.within.slugs);
  }
  if (args.tag) {
    where.push("q.id IN (SELECT quote_id FROM quote_tags WHERE tag = @tag COLLATE NOCASE)");
    params.tag = args.tag;
  }
  if (args.author) {
    where.push("(EXISTS (SELECT 1 FROM works w WHERE w.id = q.work_id AND lower(w.authors) LIKE @author) OR lower(COALESCE(q.attribution, '')) LIKE @author OR lower(COALESCE(q.chapter_author, '')) LIKE @author)");
    params.author = `%${args.author.toLowerCase()}%`;
  }
  if (args.work) {
    where.push(`EXISTS (SELECT 1 FROM works w WHERE w.id = q.work_id AND (lower(w.title) LIKE @work OR w.zotero_key = @workExact OR CAST(w.id AS TEXT) = @workExact
      OR EXISTS (SELECT 1 FROM zotero_items z WHERE z.library = w.zotero_library AND z.key = w.zotero_key AND (json_extract(z.data, '$.citationKey') = @workExact OR json_extract(z.data, '$.extra') LIKE @workExtra))))`);
    params.work = `%${args.work.toLowerCase()}%`;
    params.workExact = args.work;
    params.workExtra = `%Citation Key: ${args.work}%`;
  }
  if (args.flag) {
    where.push("EXISTS (SELECT 1 FROM json_each(q.flags) WHERE value = @flag)");
    params.flag = args.flag;
  }
  if (args.kind && args.kind !== "any") {
    where.push("q.kind = @kind");
    params.kind = args.kind;
  }
  if (args.status && args.status !== "any") {
    where.push("q.status = @status");
    params.status = args.status;
  } else if (!args.status) where.push("q.status != 'unparsed'");

  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const offset = Math.max(args.offset ?? 0, 0);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) FROM ${from} ${clause}`).pluck().get(params) as number;
  const rows = db.prepare(`SELECT q.*, ${snippet} AS snippet FROM ${from} ${clause} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(params) as Record<string, unknown>[];
  return { total, offset, limit, quotes: rows.map((r) => present(db, r, r.snippet as string | null)) };
}

function tagsOf(db: DB, quoteId: number) {
  return db.prepare(`SELECT t.tag, c.slug AS concept, t.origin FROM quote_tags t LEFT JOIN concepts c ON c.id = t.concept_id WHERE t.quote_id = ? ORDER BY t.tag`)
    .all(quoteId) as { tag: string; concept: string | null; origin: string }[];
}

function present(db: DB, q: Record<string, unknown>, snippet: string | null = null) {
  const note = q.kind === "note";
  return {
    id: q.id as number,
    kind: q.kind as "quote" | "note",
    text: q.text as string,
    ...(note ? { note: (q.comment as string) ?? null } : {}),
    ...(snippet ? { snippet } : {}),
    locator: locatorText(q.locator_kind as string, q.locator as string | null),
    chapter_author: (q.chapter_author as string) ?? null,
    attribution: (q.attribution as string) ?? null,
    work: workSummary(db, q.work_id as number | null),
    tags: tagsOf(db, q.id as number),
    status: q.status as string,
    grade: (q.grade as string) ?? null,
    flags: json<string[]>(q.flags as string, []),
  };
}

export function getQuote(db: DB, id: number) {
  const q = db.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!q) throw new ToolError(`No quote or note ${id}.`);
  return {
    ...present(db, q),
    comment: (q.comment as string) ?? null,
    source_url: (q.source_url as string) ?? null,
    suspect_words: json<unknown[]>(q.suspects as string, []),
    kwic: db.prepare("SELECT k.phrase, k.tag, c.slug AS concept FROM quote_kwic k LEFT JOIN concepts c ON c.id = k.concept_id WHERE k.quote_id = ?").all(id),
    origins: db.prepare("SELECT kind, ref, version, imported_at FROM quote_origins WHERE quote_id = ? ORDER BY kind, ref").all(id),
    edited: Boolean(q.edited),
    created_at: q.created_at, updated_at: q.updated_at,
    history: db.prepare("SELECT at, kind, actor, reason FROM history WHERE quote_id = ? ORDER BY id").all(id),
  };
}

/** The quote with a CSL JSON item for its work and a locator, ready for Pandoc or a reference manager. */
export function citeQuote(db: DB, id: number) {
  const q = getQuote(db, id);
  const row = db.prepare("SELECT w.* FROM works w JOIN quotes q ON q.work_id = w.id WHERE q.id = ?").get(id) as Record<string, unknown> | undefined;
  const warnings: string[] = [];
  let csl: Record<string, unknown> | null = null;
  let citekey: string | null = null;
  const z = row ? zoteroData(db, row.zotero_library as string, row.zotero_key as string) : null;
  if (row && z) {
    csl = zoteroToCsl(row.zotero_key as string, z.data);
    citekey = z.citekey;
    if (!citekey) warnings.push("The Zotero item has no Better BibTeX citekey yet; the CSL id is its item key.");
  }
  // Several editions in Zotero: offer each, so a citation can name the one the page belongs to.
  const editions = row && !z && row.match === "ambiguous"
    ? json<string[]>(row.candidates as string, []).map((key) => {
      const c = zoteroData(db, firstLibrary(db), key);
      if (!c) return null;
      const year = (c.data.date ?? "").match(/\d{4}/)?.[0] ?? null;
      return { zotero_key: key, year, title: c.data.title ?? null, citekey: c.citekey, csl: zoteroToCsl(key, c.data),
        pandoc: c.citekey ? `[@${c.citekey}${q.locator ? `, ${q.locator}` : ""}]` : null };
    }).filter((e) => e !== null)
    : null;
  if (row && !z) {
    const authors = json<string[]>(row.authors as string, []);
    csl = {
      id: `work-${row.id}`, type: row.item_type === "Book" || row.item_type === "book" ? "book" : "document", title: row.title,
      author: authors.map((a) => { const [family, given] = a.split(/,\s*/, 2); return given ? { family, given } : { literal: a }; }),
      ...(row.year ? { issued: { "date-parts": [[Number(row.year)]] } } : {}), ...(row.isbn ? { ISBN: row.isbn } : {}),
    };
    warnings.push(row.match === "ambiguous"
      ? "Several Zotero items could be this work (different editions); `editions` has each one's citekey and CSL. Cite the edition the page number belongs to; csl here is the old site's record."
      : "This work isn't in Zotero yet; this citation uses the old site's record until it's filed.");
  } else if (!row) {
    warnings.push(q.attribution ? `No work to cite; the quote is attributed to ${q.attribution}.` : "No work to cite.");
  }
  if (q.kind === "note") warnings.push("This is a note (your own words), not a quote: there's no quoted text to cite, only the work and the place.");
  else if (!q.locator) warnings.push("The quote has no page or location.");
  if (q.status === "unparsed") warnings.push("This quote hasn't been split from its note yet; check its text before using it.");
  if (q.flags.includes("ocr_suspect")) warnings.push("Some words may be OCR errors; check them against the book (see suspect_words in get_quote).");
  const kindle = q.locator?.startsWith("Kindle");
  const locator = q.locator && !kindle ? { label: "page", locator: q.locator.replace(/^pp?\. /, "") } : null;
  const pandoc = citekey ? `[@${citekey}${locator ? `, ${q.locator}` : kindle ? `, ${q.locator}` : ""}]` : null;
  return {
    kind: q.kind, quote: q.kind === "note" ? null : q.text, ...(q.kind === "note" ? { note: q.note } : {}), locator, locator_text: q.locator, chapter_author: q.chapter_author, csl, citekey, pandoc, ...(editions ? { editions } : {}),
    ...(q.chapter_author ? { note: `The passage is by ${q.chapter_author}, in an edited volume; cite the chapter if your style needs it.` } : {}),
    warnings,
  };
}

// --- Worklists -----------------------------------------------------------------------------------

export const QUEUES = ["unparsed", "ambiguous_works", "unmatched_works", "unresolved_tags", "no_locator", "ocr_suspect", "unbalanced_quotes", "commentary_mixed", "chapter_author", "kindle_locator", "title_tag_only", "compound_tag"] as const;
export type Queue = (typeof QUEUES)[number];

export function worklist(db: DB, queue: Queue, args: { work?: string; limit?: number; offset?: number } = {}) {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const offset = Math.max(args.offset ?? 0, 0);
  if (queue === "ambiguous_works" || queue === "unmatched_works") {
    const match = queue === "ambiguous_works" ? "ambiguous" : "unmatched";
    const total = db.prepare("SELECT COUNT(*) FROM works w WHERE match = ? AND EXISTS (SELECT 1 FROM quotes WHERE work_id = w.id)").pluck().get(match) as number;
    const works = (db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM quotes WHERE work_id = w.id) AS quotes,
      (SELECT ref FROM work_origins WHERE work_id = w.id AND kind = 'drupal') AS drupal_nid
      FROM works w WHERE match = ? AND EXISTS (SELECT 1 FROM quotes WHERE work_id = w.id) ORDER BY quotes DESC, title LIMIT ? OFFSET ?`)
      .all(match, limit, offset) as Record<string, unknown>[]).map((w) => ({
      id: w.id, title: w.title, authors: json(w.authors as string, []), year: w.year, isbn: w.isbn, quotes: w.quotes, drupal_nid: w.drupal_nid,
      candidates: json<string[]>(w.candidates as string, []).map((key) => {
        const z = zoteroData(db, process.env.QUOTE_ZOTERO_LIBRARY ?? null, key) ?? zoteroData(db, firstLibrary(db), key);
        return { key, title: z?.data.title ?? null, date: z?.data.date ?? null, citekey: z?.citekey ?? null };
      }),
    }));
    return { queue, total, offset, limit, works };
  }
  if (queue === "unresolved_tags") {
    const tags = db.prepare(`SELECT tag, COUNT(*) AS quotes, group_concat(quote_id) AS quote_ids FROM quote_tags WHERE concept_id IS NULL GROUP BY tag COLLATE NOCASE ORDER BY quotes DESC, tag`).all() as Record<string, unknown>[];
    return { queue, total: tags.length, offset: 0, limit: tags.length, tags: tags.map((t) => ({ ...t, quote_ids: String(t.quote_ids).split(",").map(Number) })) };
  }
  const status = queue === "unparsed" ? "unparsed" : "any";
  return { queue, ...searchQuotes(db, { status, flag: queue === "unparsed" ? undefined : queue, work: args.work, limit, offset }) };
}

function firstLibrary(db: DB): string | null {
  return (db.prepare("SELECT zotero_library FROM works WHERE zotero_library IS NOT NULL GROUP BY zotero_library ORDER BY COUNT(*) DESC LIMIT 1").pluck().get() as string) ?? null;
}

export function overview(db: DB) {
  const one = (sql: string) => db.prepare(sql).pluck().get() as number;
  const queues: Record<string, number> = {};
  for (const q of QUEUES) {
    if (q === "unparsed") queues[q] = one("SELECT COUNT(*) FROM quotes WHERE status = 'unparsed'");
    else if (q === "ambiguous_works" || q === "unmatched_works") queues[q] = one(`SELECT COUNT(*) FROM works w WHERE match = '${q === "ambiguous_works" ? "ambiguous" : "unmatched"}' AND EXISTS (SELECT 1 FROM quotes WHERE work_id = w.id)`);
    else if (q === "unresolved_tags") queues[q] = one("SELECT COUNT(DISTINCT lower(tag)) FROM quote_tags WHERE concept_id IS NULL");
    else queues[q] = one(`SELECT COUNT(*) FROM quotes q WHERE EXISTS (SELECT 1 FROM json_each(q.flags) WHERE value = '${q}')`);
  }
  return {
    quotes: one("SELECT COUNT(*) FROM quotes WHERE status != 'unparsed' AND kind = 'quote'"),
    notes: one("SELECT COUNT(*) FROM quotes WHERE kind = 'note'"),
    works: one("SELECT COUNT(DISTINCT work_id) FROM quotes WHERE work_id IS NOT NULL"),
    concepts: one("SELECT COUNT(*) FROM concepts WHERE status != 'retired'"),
    schemes: db.prepare("SELECT slug, label FROM schemes ORDER BY slug").all(),
    last_import: db.prepare("SELECT MAX(imported_at) FROM quote_origins").pluck().get(),
    queues,
  };
}
