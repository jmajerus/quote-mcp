import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { ToolError } from "./common.js";
import { type DB, now } from "./db.js";
import { creators } from "./import.js";
import { citekeyOf } from "./csl.js";
import { getQuote } from "./queries.js";
import { quoteKey, yearOf } from "./text.js";
import type { ApiItem } from "./zotero.js";

/**
 * add_quote: a quote saved by an agent (docs/dev-briefs/holdings-and-quotes.md §2.1). For a work with a
 * Calibre book, corpus-mcp checks the words against the book's text first (POST /api/verify): on a
 * match the quote keeps the book's exact wording, status verified, and corpus-mcp keeps its anchor
 * (POST /api/anchors) under the new quote id; with no match nothing is saved and the closest passages
 * come back. A work with no Calibre book, or one with no usable text, is saved transcribed, as a quote
 * typed from a paper book is. An anchor that couldn't be posted leaves the quote flagged anchor_missing,
 * which retryAnchors (run after each import) posts again.
 */

export const DEFAULT_CORPUS_BASE = "http://corpus-mcp.localdomain:8000";
/** corpus-mcp's limit on a quote's words (save_quote's MAX_QUOTE). */
export const MAX_QUOTE = 2000;
const ORIGIN = "agent";
const ANCHOR_MISSING = "anchor_missing";

/** One entry of corpus-mcp's /api/holdings/books feed. */
export interface Book {
  calibre_uuid: string; book_id: string; title: string; authors: string[]; year: string | number | null; citekey: string | null;
  zotero: { library: string; key: string } | null; [field: string]: unknown;
}
export type Verified =
  | { match: true; exact: boolean; text: string; locator: string | null; page_label: string | null; section: string | null; anchor: Record<string, unknown>; book: Book }
  | { match: false; closest: Record<string, unknown>[]; book: Book };

export class CorpusError extends Error {
  /** 0 when corpus-mcp couldn't be reached. */
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> | null = null) {
    super(message);
  }
  get code(): string | undefined {
    return typeof this.body?.error === "string" ? this.body.error : undefined;
  }
}

export interface CorpusClient {
  baseUrl: string;
  verify(request: { book: string; text: string; page?: number }): Promise<Verified>;
  anchor(quoteId: number, anchor: Record<string, unknown>): Promise<unknown>;
  dropAnchor(quoteId: number): Promise<void>;
}

/** corpus-mcp's base URL from CORPUS_BASE, or null when it's "off". */
export function corpusConfig(env: NodeJS.ProcessEnv = process.env): { baseUrl: string } | null {
  const base = env.CORPUS_BASE?.trim() || DEFAULT_CORPUS_BASE;
  return base.toLowerCase() === "off" ? null : { baseUrl: base.replace(/\/+$/, "") };
}

export function corpusClient({ baseUrl, timeoutMs = 20_000, fetchImpl = fetch }: { baseUrl: string; timeoutMs?: number; fetchImpl?: typeof fetch }): CorpusClient {
  const request = async (method: string, path: string, payload?: unknown) => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method, headers: payload === undefined ? {} : { "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new CorpusError(0, `corpus-mcp unreachable at ${baseUrl}: ${(error as Error).message}`);
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new CorpusError(res.status, `corpus-mcp ${method} ${path} answered ${res.status}${body?.error ? `: ${body.error}` : ""}`, body);
    return body as never;
  };
  return {
    baseUrl,
    verify: (r) => request("POST", "/api/verify", r),
    anchor: (quoteId, anchor) => request("POST", "/api/anchors", { quote_id: quoteId, anchor }),
    dropAnchor: async (quoteId) => {
      try {
        await request("DELETE", `/api/anchors/${quoteId}`);
      } catch (error) {
        if (!(error instanceof CorpusError && error.status === 404)) throw error;
      }
    },
  };
}

/** A writable connection to the store, opened on first use; the server's own stays read-only. */
export function storeWriter(file: string): () => DB {
  let db: DB | undefined;
  return () => {
    if (!db) {
      db = new Database(file, { fileMustExist: true });
      db.pragma("busy_timeout = 30000");
      db.pragma("foreign_keys = ON");
    }
    return db;
  };
}

// --- Works ---------------------------------------------------------------------------------------

interface Item { library: string; key: string; data: ApiItem["data"] & Record<string, unknown> }

/** A Zotero item in the mirror by citekey or bare item key, the primary library first. */
function itemByKey(db: DB, key: string, primary: string | null): Item | undefined {
  const row = db.prepare(`SELECT library, key, data FROM zotero_items WHERE deleted = 0 AND parent_key IS NULL
    AND (json_extract(data, '$.citationKey') = @key OR json_extract(data, '$.extra') LIKE @extra OR key = @key)
    ORDER BY library = @primary DESC LIMIT 1`).get({ key, extra: `%Citation Key: ${key}%`, primary }) as { library: string; key: string; data: string } | undefined;
  return row && { library: row.library, key: row.key, data: JSON.parse(row.data) };
}

function item(db: DB, library: string, key: string): Item | undefined {
  const row = db.prepare("SELECT data FROM zotero_items WHERE library = ? AND key = ? AND deleted = 0").get(library, key) as { data: string } | undefined;
  return row && { library, key, data: JSON.parse(row.data) };
}

/** The work for a Zotero item, made from the mirror when the store has none yet. */
function zoteroWork(db: DB, library: string, key: string): number {
  const id = db.prepare(`SELECT id FROM works WHERE zotero_library = ? AND zotero_key = ?
    UNION ALL SELECT work_id FROM work_origins WHERE kind = 'zotero' AND ref = ? LIMIT 1`).pluck().get(library, key, `${library}:${key}`) as number | undefined;
  if (id !== undefined) return id;
  const it = item(db, library, key);
  if (!it) throw new ToolError(`zotero:${library}/${key} isn't in the Zotero mirror yet; the next import (every 30 minutes) brings it in.`);
  const stamp = now();
  const work = db.prepare(`INSERT INTO works (title, authors, year, item_type, isbn, url, zotero_library, zotero_key, match, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'zotero', ?, ?) RETURNING id`).pluck()
    .get(it.data.title ?? "(untitled)", JSON.stringify(creators(it.data)), yearOf(it.data.date), it.data.itemType, it.data.ISBN || null, it.data.url || null, library, key, stamp, stamp) as number;
  db.prepare("INSERT OR IGNORE INTO work_origins (kind, ref, work_id) VALUES ('zotero', ?, ?)").run(`${library}:${key}`, work);
  return work;
}

/** The work for a Calibre book not in Zotero: unmatched, found again by its Calibre UUID. */
function calibreWork(db: DB, book: Book): number {
  const id = db.prepare("SELECT work_id FROM work_origins WHERE kind = 'calibre' AND ref = ?").pluck().get(book.calibre_uuid) as number | undefined;
  if (id !== undefined) return id;
  const stamp = now();
  const work = db.prepare(`INSERT INTO works (title, authors, year, item_type, match, created_at, updated_at) VALUES (?, ?, ?, 'book', 'unmatched', ?, ?) RETURNING id`)
    .pluck().get(book.title, JSON.stringify(book.authors ?? []), book.year == null ? null : String(book.year), stamp, stamp) as number;
  db.prepare("INSERT INTO work_origins (kind, ref, work_id) VALUES ('calibre', ?, ?)").run(book.calibre_uuid, work);
  return work;
}

function bookWork(db: DB, book: Book): number {
  return book.zotero ? zoteroWork(db, book.zotero.library, book.zotero.key) : calibreWork(db, book);
}

/**
 * What a work key names here, and what to ask corpus-mcp for. Keys: quote:<work id>, zotero:<library>/<key>,
 * a citekey or Zotero item key, or a Calibre book (main:42, or its UUID), which only corpus-mcp knows.
 */
interface Target { work?: () => number; book: string | null; label: string }

function target(db: DB, key: string, primary: string | null): Target {
  const k = key.trim();
  const quote = /^quote:(\d+)$/.exec(k);
  if (quote) {
    const id = db.prepare(`SELECT id FROM works WHERE id = ? UNION ALL SELECT work_id FROM work_origins WHERE kind = 'work' AND ref = ? LIMIT 1`)
      .pluck().get(Number(quote[1]), quote[1]) as number | undefined;
    if (id === undefined) throw new ToolError(`No work ${k}.`);
    const w = db.prepare("SELECT match, zotero_library, zotero_key FROM works WHERE id = ?").get(id) as { match: string; zotero_library: string | null; zotero_key: string | null };
    if (w.match !== "zotero" || !w.zotero_library || !w.zotero_key) return { work: () => id, book: null, label: k };
    return { work: () => id, book: bookKey(db, w.zotero_library, w.zotero_key, primary), label: k };
  }
  const zotero = /^zotero:((?:users|groups)\/\d+)\/([A-Z0-9]{8})$/i.exec(k);
  if (zotero) {
    const [library, itemKey] = [zotero[1], zotero[2].toUpperCase()];
    return { work: () => zoteroWork(db, library, itemKey), book: bookKey(db, library, itemKey, primary), label: k };
  }
  const it = itemByKey(db, k, primary);
  if (it) return { work: () => zoteroWork(db, it.library, it.key), book: bookKey(db, it.library, it.key, primary), label: k };
  // A Calibre book id or UUID: corpus-mcp says which work it is.
  if (/^[\w-]+:\d+$/.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return { book: k, label: k };
  throw new ToolError(`No work for "${k}": pass a key from find_work (quote:<id> or zotero:<library>/<key>), a citekey, a Zotero item key, or a Calibre book id.`);
}

/** How to name a Zotero item to corpus-mcp: by item, in the library it mirrors; by citekey from another. */
function bookKey(db: DB, library: string, key: string, primary: string | null): string {
  if (!primary || library === primary) return `zotero:${library}/${key}`;
  const it = item(db, library, key);
  return (it && citekeyOf(it.data)) ?? `zotero:${library}/${key}`;
}

// --- Saving --------------------------------------------------------------------------------------

export interface AddQuoteArgs {
  work: string;
  text: string;
  /** The page as printed ("211", "211-212"); for a book with text, also where corpus-mcp starts looking. */
  page?: string;
  comment?: string;
  tags?: string[];
  /** Makes a retry return the quote the first call saved. */
  request_id?: string;
}

export interface AddQuoteOptions { corpus: CorpusClient | null; primary?: string | null; actor?: string }

/** Tags resolve to concepts by label, then alternative label, then slug, ignoring case, as the import does. */
function conceptOf(db: DB, tag: string): number | null {
  const t = tag.toLowerCase();
  const rows = db.prepare("SELECT id, slug, label, alt_labels FROM concepts WHERE status != 'retired'").all() as { id: number; slug: string; label: string; alt_labels: string }[];
  return rows.find((c) => c.label.toLowerCase() === t)?.id ?? rows.find((c) => (JSON.parse(c.alt_labels) as string[]).some((a) => a.toLowerCase() === t))?.id
    ?? rows.find((c) => c.slug === t)?.id ?? null;
}

const pageOf = (page: string | undefined) => (page && /^\d+$/.test(page.trim()) ? Number(page.trim()) : undefined);

interface Plan {
  status: "verified" | "transcribed"; work: number; text: string; locator: string | null; section: string | null;
  anchor: Record<string, unknown> | null; book: Book | null; exact: boolean; note: string;
}

/**
 * Saves an agent's quote: verified against the Calibre book when there is one, else transcribed. Returns the
 * quote, or throws ToolError when nothing was saved (no match, several books, an unknown work).
 */
export async function addQuote(db: DB, args: AddQuoteArgs, o: AddQuoteOptions): Promise<Record<string, unknown>> {
  const text = args.text?.trim() ?? "";
  if (!text) throw new ToolError("The quote has no text.");
  if (text.length > MAX_QUOTE) throw new ToolError(`The quote is ${text.length} characters; the limit is ${MAX_QUOTE}. Quote less, or save two.`);
  const requestId = args.request_id?.trim() || randomUUID();
  const earlier = db.prepare("SELECT quote_id FROM quote_origins WHERE kind = ? AND ref = ?").pluck().get(ORIGIN, requestId) as number | undefined;
  if (earlier !== undefined) return { saved: false, reason: "This request_id already saved this quote.", quote: getQuote(db, earlier) };

  const primary = o.primary ?? null;
  const t = target(db, args.work, primary);
  const plan = await planQuote(db, t, text, args.page, o.corpus);

  const existing = db.prepare("SELECT id FROM quotes WHERE work_id = ? AND text_key = ? LIMIT 1").pluck().get(plan.work, quoteKey(plan.text)) as number | undefined;
  if (existing !== undefined) return { saved: false, reason: "The work already has this quote.", quote: getQuote(db, existing) };

  const id = save(db, args, plan, requestId, o.actor ?? ORIGIN);
  let anchored = false;
  const warnings: string[] = [];
  if (plan.anchor && o.corpus) {
    anchored = await postAnchor(db, o.corpus, id, plan.anchor, args.page);
    if (!anchored) warnings.push("corpus-mcp didn't store the anchor; the quote is flagged anchor_missing and the next import posts it again.");
  }
  if (plan.status === "verified" && !plan.exact) warnings.push("The text is the book's wording, which differs from what was sent (quote marks, spacing, or case).");
  if (plan.status === "transcribed") warnings.push(plan.note);
  return { saved: true, status: plan.status, anchored, warnings, quote: getQuote(db, id) };
}

async function planQuote(db: DB, t: Target, text: string, page: string | undefined, corpus: CorpusClient | null): Promise<Plan> {
  const transcribed = (work: number, note: string, book: Book | null = null): Plan =>
    ({ status: "transcribed", work, text, locator: page?.trim() || null, section: null, anchor: null, book, exact: true, note });
  if (!t.book || !corpus) {
    if (!t.work) throw new ToolError(`${t.label} is a Calibre book, and corpus-mcp is off here (CORPUS_BASE).`);
    return transcribed(t.work(), t.book ? "Saved transcribed: corpus-mcp is off here, so the words weren't checked against the book." : "Saved transcribed: the work has no Calibre book to check against.");
  }
  let v: Verified;
  try {
    v = await corpus.verify({ book: t.book, text, ...(pageOf(page) ? { page: pageOf(page) } : {}) });
  } catch (error) {
    if (!(error instanceof CorpusError)) throw error;
    if (error.code === "no-book") {
      if (!t.work) throw new ToolError(`corpus-mcp has no book ${t.label}.`);
      return transcribed(t.work(), "Saved transcribed: there's no Calibre book of this work to check the words against.");
    }
    if (error.code === "no-text") {
      const book = error.body?.book as Book | undefined;
      return transcribed(book ? bookWork(db, book) : t.work!(), "Saved transcribed: the Calibre book has no usable text to check the words against.", book ?? null);
    }
    if (error.code === "ambiguous") {
      const books = (error.body?.books as Book[] | undefined) ?? [];
      throw new ToolError(`${t.label} names ${books.length} Calibre books; pass one's book_id as work: ${books.map((b) => `${b.book_id} (${b.title}${b.year ? `, ${b.year}` : ""})`).join("; ")}. Nothing was saved.`);
    }
    throw new ToolError(`${error.message}. Nothing was saved; try again.`);
  }
  if (!v.match) {
    throw new ToolError(`Not found in ${v.book.title} (${v.book.book_id}). Nothing was saved. The closest passages: ${JSON.stringify(v.closest)}`);
  }
  // The work comes from the book corpus-mcp matched, unless the caller named it and the book isn't in Zotero.
  const work = v.book.zotero ? bookWork(db, v.book) : t.work ? t.work() : calibreWork(db, v.book);
  const locator = v.page_label ? v.locator?.replace(/^pp?\.\s*/, "") ?? v.page_label : null;
  return { status: "verified", work, text: v.text, locator, section: v.locator ? null : v.section, anchor: v.anchor, book: v.book, exact: v.exact, note: "" };
}

function save(db: DB, args: AddQuoteArgs, plan: Plan, requestId: string, actor: string): number {
  const stamp = now();
  const flags = [...(plan.locator ? [] : ["no_locator"]), ...(plan.anchor ? [ANCHOR_MISSING] : [])];
  // A chapter of an EPUB has no page: its section is the place, kept in the comment.
  const comment = [plan.section ? `Section: ${plan.section}` : null, args.comment?.trim() || null].filter(Boolean).join("\n\n") || null;
  const raw = JSON.stringify({ request: { ...args, request_id: requestId }, ...(plan.book ? { book: plan.book } : {}), ...(plan.anchor ? { anchor: plan.anchor } : {}) });
  return db.transaction(() => {
    const id = db.prepare(`INSERT INTO quotes (kind, work_id, text, text_key, locator_kind, locator, comment, status, grade, flags, created_at, created_by, updated_at, updated_by)
      VALUES ('quote', ?, ?, ?, ?, ?, ?, ?, 'A', ?, ?, ?, ?, ?) RETURNING id`).pluck()
      .get(plan.work, plan.text, quoteKey(plan.text), plan.locator ? "page" : "none", plan.locator, comment, plan.status, JSON.stringify(flags), stamp, actor, stamp, actor) as number;
    db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES (?, ?, ?, NULL, ?, ?)").run(ORIGIN, requestId, id, raw, stamp);
    const tags = [...new Set((args.tags ?? []).map((t) => t.trim()).filter(Boolean))];
    for (const tag of tags) db.prepare("INSERT OR IGNORE INTO quote_tags (quote_id, tag, concept_id, origin) VALUES (?, ?, ?, ?)").run(id, tag, conceptOf(db, tag), ORIGIN);
    const how = plan.status === "verified" ? `checked against Calibre book ${plan.book!.book_id}${plan.exact ? "" : "; the wording is the book's"}` : plan.note;
    db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'added', ?, ?, ?, ?)")
      .run(id, stamp, plan.exact ? null : args.text, plan.text, actor, `add_quote: ${how}`);
    db.prepare("INSERT INTO quotes_fts (rowid, text, comment, tags) VALUES (?, ?, ?, ?)").run(id, plan.text, comment ?? "", tags.join(" "));
    return id;
  })();
}

/** Posts a quote's anchor, verifying again once if corpus-mcp says it's stale; clears anchor_missing when stored. */
async function postAnchor(db: DB, corpus: CorpusClient, id: number, anchor: Record<string, unknown>, page?: string): Promise<boolean> {
  let current = anchor;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await corpus.anchor(id, current);
      const flags = (JSON.parse(db.prepare("SELECT flags FROM quotes WHERE id = ?").pluck().get(id) as string) as string[]).filter((f) => f !== ANCHOR_MISSING);
      db.prepare("UPDATE quotes SET flags = ? WHERE id = ?").run(JSON.stringify(flags), id);
      return true;
    } catch (error) {
      if (!(error instanceof CorpusError)) throw error;
      if (error.code === "stale-anchor") {
        const text = db.prepare("SELECT text FROM quotes WHERE id = ?").pluck().get(id) as string;
        try {
          const v = await corpus.verify({ book: String(current.calibre_uuid), text, ...(pageOf(page) ? { page: pageOf(page) } : {}) });
          if (!v.match) return false;
          current = v.anchor;
        } catch {
          return false;
        }
      } else if (error.status !== 0 && error.status < 500) {
        return false;
      }
    }
  }
  return false;
}

/** Posts the anchors of quotes flagged anchor_missing again. Run after each import. */
export async function retryAnchors(db: DB, corpus: CorpusClient): Promise<{ tried: number; stored: number }> {
  const rows = db.prepare(`SELECT q.id, o.raw FROM quotes q JOIN quote_origins o ON o.quote_id = q.id AND o.kind = ?
    WHERE EXISTS (SELECT 1 FROM json_each(q.flags) WHERE value = ?)`).all(ORIGIN, ANCHOR_MISSING) as { id: number; raw: string }[];
  let stored = 0;
  for (const r of rows) {
    const raw = JSON.parse(r.raw) as { anchor?: Record<string, unknown>; request?: AddQuoteArgs };
    if (raw.anchor && (await postAnchor(db, corpus, r.id, raw.anchor, raw.request?.page))) stored++;
  }
  return { tried: rows.length, stored };
}
