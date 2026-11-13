import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { ToolError } from "./common.js";
import { type DB, NEXT_QUOTE_ID, getMeta, now, setMeta } from "./db.js";
import { creators } from "./import.js";
import { citedKey, citekeyOf } from "./csl.js";
import { calibreSource, chapterLocator, getQuote } from "./queries.js";
import { quoteKey, yearOf } from "./text.js";
import { syncLibrary } from "./sync.js";
import { type ApiItem, ZoteroClient, needsKey, zoteroConfig } from "./zotero.js";

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
const ANCHOR_LOST = "anchor_lost";

/** One entry of corpus-mcp's /api/holdings/books feed. */
export interface Book {
  calibre_uuid: string; book_id: string; title: string; authors: string[]; year: string | number | null; citekey: string | null;
  /** The key corpus-mcp's citekey rule gives the book; absent when the metadata blocks one. Sent beside a real citekey too. */
  proposed_citekey?: string;
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
  /** Changes to the anchors corpus-mcp keeps for quotes here, after change number `since` (GET /api/anchors/changes). */
  anchorChanges(since: number): Promise<AnchorChanges>;
  /** corpus-mcp's own saved quotes (GET /api/quotes), for taking them over. */
  quotes(): Promise<CorpusQuote[]>;
  /** The books feed (GET /api/holdings/books), or null when it hasn't changed since the ETag given. */
  booksFeed?(etag?: string): Promise<{ etag: string | null; books: Book[] } | null>;
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
    booksFeed: async (etag) => {
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/api/holdings/books`, { headers: etag ? { "if-none-match": etag } : {}, signal: AbortSignal.timeout(timeoutMs * 3) });
      } catch (error) {
        throw new CorpusError(0, `corpus-mcp unreachable at ${baseUrl}: ${(error as Error).message}`);
      }
      if (res.status === 304) {
        await res.body?.cancel();
        return null;
      }
      const body = (await res.json().catch(() => null)) as { books?: Book[] } | null;
      if (!res.ok || !Array.isArray(body?.books)) throw new CorpusError(res.status, `corpus-mcp GET /api/holdings/books answered ${res.status}`, body as Record<string, unknown> | null);
      return { etag: res.headers.get("etag"), books: body.books };
    },
    verify: (r) => request("POST", "/api/verify", r),
    anchor: (quoteId, anchor) => request("POST", "/api/anchors", { quote_id: quoteId, anchor }),
    anchorChanges: (since) => request("GET", `/api/anchors/changes?since=${since}`),
    // corpus-mcp gives at most 200 a page; read on until total.
    quotes: async () => {
      const all: CorpusQuote[] = [];
      for (;;) {
        const page = (await request("GET", `/api/quotes?limit=200&offset=${all.length}`)) as { total: number; quotes: CorpusQuote[] };
        all.push(...page.quotes);
        if (!page.quotes.length || all.length >= page.total) return all;
      }
    },
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

/** A work key that names nothing in the Zotero mirror, which a sync may bring in. */
export class MirrorMiss extends ToolError {}

interface Item { library: string; key: string; data: ApiItem["data"] & Record<string, unknown> }

/** A Zotero item in the mirror by citekey or bare item key, the primary library first. */
function itemByKey(db: DB, key: string, primary: string | null): Item | undefined {
  const name = citedKey(key);
  const row = db.prepare(`SELECT library, key, data FROM zotero_items WHERE deleted = 0 AND parent_key IS NULL
    AND (json_extract(data, '$.citationKey') = @key OR json_extract(data, '$.extra') LIKE @extra OR key = @key)
    ORDER BY library = @primary DESC LIMIT 1`).get({ key: name, extra: `%Citation Key: ${name}%`, primary }) as { library: string; key: string; data: string } | undefined;
  return row && { library: row.library, key: row.key, data: JSON.parse(row.data) };
}

function item(db: DB, library: string, key: string): Item | undefined {
  const row = db.prepare("SELECT data FROM zotero_items WHERE library = ? AND key = ? AND deleted = 0").get(library, key) as { data: string } | undefined;
  return row && { library, key, data: JSON.parse(row.data) };
}

/** The store's work for a Zotero item, if it has one. */
function knownZoteroWork(db: DB, library: string, key: string): number | undefined {
  return db.prepare(`SELECT id FROM works WHERE zotero_library = ? AND zotero_key = ?
    UNION ALL SELECT work_id FROM work_origins WHERE kind = 'zotero' AND ref = ? LIMIT 1`).pluck().get(library, key, `${library}:${key}`) as number | undefined;
}

/** The store's work for a Calibre book not in Zotero, if add_quote made one. */
function knownCalibreWork(db: DB, uuid: string): number | undefined {
  return db.prepare("SELECT work_id FROM work_origins WHERE kind = 'calibre' AND ref = ?").pluck().get(uuid) as number | undefined;
}

/** The work for a Zotero item the capture page chose, made from the mirror when the store has none yet. */
export function workFromMirror(db: DB, ref: string): number {
  const named = /^zotero:((?:users|groups)\/\d+)\/([A-Z0-9]{8})$/i.exec(ref.trim());
  if (!named) throw new ToolError(`"${ref}" isn't a Zotero item.`);
  return zoteroWork(db, named[1]!, named[2]!.toUpperCase());
}

/** The work for a Zotero item, made from the mirror when the store has none yet. */
function zoteroWork(db: DB, library: string, key: string): number {
  const id = knownZoteroWork(db, library, key);
  if (id !== undefined) return id;
  const it = item(db, library, key);
  if (!it) throw new MirrorMiss(`zotero:${library}/${key} isn't in the Zotero mirror yet; the next import (every 30 minutes) brings it in.`);
  const stamp = now();
  const work = db.prepare(`INSERT INTO works (title, authors, year, item_type, isbn, url, zotero_library, zotero_key, match, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'zotero', ?, ?) RETURNING id`).pluck()
    .get(it.data.title ?? "(untitled)", JSON.stringify(creators(it.data)), yearOf(it.data.date), it.data.itemType, it.data.ISBN || null, it.data.url || null, library, key, stamp, stamp) as number;
  db.prepare("INSERT OR IGNORE INTO work_origins (kind, ref, work_id) VALUES ('zotero', ?, ?)").run(`${library}:${key}`, work);
  return work;
}

/** The work for a Calibre book not in Zotero: unmatched, found again by its Calibre UUID. */
function calibreWork(db: DB, book: Book): number {
  const id = knownCalibreWork(db, book.calibre_uuid);
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
interface Target {
  /** The work, made when the store has none yet; absent for a Calibre book only corpus-mcp can place. */
  work?: () => number;
  /** The work the store already has, looked up without making one. */
  known?: number;
  book: string | null;
  label: string;
}

function target(db: DB, key: string, primary: string | null): Target {
  const k = key.trim();
  const quote = /^quote:(\d+)$/.exec(k);
  if (quote) {
    const id = db.prepare(`SELECT id FROM works WHERE id = ? UNION ALL SELECT work_id FROM work_origins WHERE kind = 'work' AND ref = ? LIMIT 1`)
      .pluck().get(Number(quote[1]), quote[1]) as number | undefined;
    if (id === undefined) throw new ToolError(`No work ${k}.`);
    const w = db.prepare("SELECT match, zotero_library, zotero_key FROM works WHERE id = ?").get(id) as { match: string; zotero_library: string | null; zotero_key: string | null };
    if (w.match === "zotero" && w.zotero_library && w.zotero_key) return { work: () => id, known: id, book: bookKey(db, w.zotero_library, w.zotero_key, primary), label: k };
    // A work add_quote made for a Calibre book not in Zotero is checked against that book again.
    const uuid = db.prepare("SELECT ref FROM work_origins WHERE kind = 'calibre' AND work_id = ? LIMIT 1").pluck().get(id) as string | undefined;
    return { work: () => id, known: id, book: uuid ?? null, label: k };
  }
  const zotero = /^zotero:((?:users|groups)\/\d+)\/([A-Z0-9]{8})$/i.exec(k);
  if (zotero) {
    const [library, itemKey] = [zotero[1], zotero[2].toUpperCase()];
    return { work: () => zoteroWork(db, library, itemKey), known: knownZoteroWork(db, library, itemKey), book: bookKey(db, library, itemKey, primary), label: k };
  }
  const it = itemByKey(db, k, primary);
  if (it) return { work: () => zoteroWork(db, it.library, it.key), known: knownZoteroWork(db, it.library, it.key), book: bookKey(db, it.library, it.key, primary), label: k };
  // A Calibre book's UUID names the work add_quote made for it, if any; otherwise, and for a book id, corpus-mcp says which work it is.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) {
    const known = knownCalibreWork(db, k.toLowerCase()) ?? knownCalibreWork(db, k);
    return { ...(known !== undefined ? { work: () => known, known } : {}), book: k, label: k };
  }
  if (/^[\w-]+:\d+$/.test(k)) return { book: k, label: k };
  throw new MirrorMiss(`No work for "${k}": pass a key from find_work (quote:<id> or zotero:<library>/<key>), a citekey, a Zotero item key, or a Calibre book id.`);
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

export interface AddQuoteOptions {
  corpus: CorpusClient | null; primary?: string | null; actor?: string;
  /**
   * Where the quote came from: an agent (the default), corpus-mcp's own quotes taken over by importCorpusQuotes,
   * or the capture page, where a person speaks a paper book's quote. A capture is saved transcribed and isn't
   * checked against a Calibre text: speech is a draft the person corrects, and a near miss would otherwise save nothing.
   */
  origin?: "agent" | "corpus" | "capture";
  /** Kept with the origin, beside the request: corpus-mcp's record of a quote taken over. */
  source?: Record<string, unknown>;
  /**
   * Brings the Zotero mirror up to date, for a work filed in Zotero since the last import (zoteroRefresher).
   * Resolves to a note when part of it failed, which add_quote adds to a work still missing.
   */
  refreshZotero?: () => Promise<string | undefined | void>;
}

/**
 * Refreshes the Zotero mirror on demand: asks holdings-mcp to refresh its copy first when QUOTE_ZOTERO_API is
 * that copy, then syncs each library from its stored version, as the import does. Concurrent calls share one
 * run. holdings-mcp's answer doesn't stop the sync: its copy may have the item already, and its errors cover
 * feeds other than Zotero. Nothing is held while it waits. Undefined when Zotero isn't set up.
 */
export function zoteroRefresher(writer: () => DB, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): (() => Promise<string | undefined>) | undefined {
  let config: ReturnType<typeof zoteroConfig>;
  try {
    config = zoteroConfig(env);
  } catch {
    return undefined;
  }
  const sources = [...new Set([config.library, ...(env.QUOTE_ZOTERO_SOURCES ?? "").split(",").map((s) => s.trim()).filter(Boolean)])];
  let running: Promise<string | undefined> | undefined;
  const run = async () => {
    const notes: string[] = [];
    if (!needsKey(config.apiBase)) {
      const url = new URL("/api/refresh", config.apiBase);
      try {
        const res = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(60_000) });
        await res.body?.cancel();
        if (!res.ok) notes.push(`holdings-mcp answered ${res.status} to the refresh`);
      } catch (error) {
        notes.push(`holdings-mcp didn't answer the refresh: ${(error as Error).message}`);
      }
    }
    for (const library of sources) {
      try {
        await syncLibrary(writer(), new ZoteroClient({ ...config, library, timeoutMs: 30_000 }), library);
      } catch (error) {
        notes.push(`${library} didn't sync: ${(error as Error).message}`);
      }
    }
    return notes.length ? `${notes.join("; ")}, so the mirror may be behind` : undefined;
  };
  return () => (running ??= run().finally(() => { running = undefined; }));
}

/** Tags resolve to concepts by label, then alternative label, then slug, ignoring case, as the import does. */
export function conceptOf(db: DB, tag: string): number | null {
  const t = tag.toLowerCase();
  const rows = db.prepare("SELECT id, slug, label, alt_labels FROM concepts WHERE status != 'retired'").all() as { id: number; slug: string; label: string; alt_labels: string }[];
  return rows.find((c) => c.label.toLowerCase() === t)?.id ?? rows.find((c) => (JSON.parse(c.alt_labels) as string[]).some((a) => a.toLowerCase() === t))?.id
    ?? rows.find((c) => c.slug === t)?.id ?? null;
}

/** Where corpus-mcp starts looking: the page, or the first of a range ("211-212"). */
const pageOf = (page: string | undefined) => {
  const m = /^\s*(\d+)\s*(?:[-–]\s*\d+\s*)?$/.exec(page ?? "");
  return m && Number(m[1]) >= 1 ? Number(m[1]) : undefined;
};

interface Plan {
  status: "verified" | "transcribed"; work: number; text: string; locatorKind: "page" | "chapter"; locator: string | null; section: string | null;
  position: { section: string | null; page_label: string | null } | null; anchor: Record<string, unknown> | null; book: Book | null; exact: boolean; note: string;
}

/**
 * Saves an agent's quote: verified against the Calibre book when there is one, else transcribed. Returns the
 * quote, or throws ToolError when nothing was saved (no match, several books, an unknown work).
 */
export async function addQuote(db: DB, args: AddQuoteArgs, o: AddQuoteOptions): Promise<Record<string, unknown>> {
  try {
    return await addQuoteOnce(db, args, o);
  } catch (error) {
    // A work filed in Zotero since the last import: bring the mirror up to date and try once more.
    // Tried whatever the refresh says; what it couldn't do is added only to a work still missing.
    if (!(error instanceof MirrorMiss) || !o.refreshZotero) throw error;
    let note: string | undefined;
    try {
      note = (await o.refreshZotero()) || undefined;
    } catch (refresh) {
      note = `the refresh failed: ${(refresh as Error).message}`;
    }
    try {
      return await addQuoteOnce(db, args, o);
    } catch (again) {
      if (again instanceof MirrorMiss && note) throw new MirrorMiss(`${again.message} (Refreshing the mirror just now: ${note}.)`);
      throw again;
    }
  }
}

async function addQuoteOnce(db: DB, args: AddQuoteArgs, o: AddQuoteOptions): Promise<Record<string, unknown>> {
  const text = args.text?.trim() ?? "";
  if (!text) throw new ToolError("The quote has no text.");
  if (text.length > MAX_QUOTE) throw new ToolError(`The quote is ${text.length} characters; the limit is ${MAX_QUOTE}. Quote less, or save two.`);
  const requestId = args.request_id?.trim() || randomUUID();
  const origin = o.origin ?? ORIGIN;
  const earlier = alreadySaved(db, origin, requestId);
  if (earlier) return earlier;

  const primary = o.primary ?? null;
  const t = target(db, args.work, primary);
  // A retry of words already saved returns them without asking corpus-mcp again. corpus-mcp's own quotes are
  // checked anyway: one whose words are already here is taken over (save), which needs the fresh anchor.
  const same = t.known !== undefined && origin !== "corpus" ? alreadySaved(db, origin, requestId, t.known, text) : undefined;
  if (same) return same;
  const spoken = origin === "capture";
  const plan = await planQuote(db, t, text, args.page, spoken ? null : o.corpus, spoken);

  const saving = save(db, args, plan, requestId, o.actor ?? origin, origin, o.source);
  if (typeof saving !== "number" && !("takenOver" in saving)) return saving;
  const takenOver = typeof saving !== "number";
  const id = typeof saving === "number" ? saving : (saving.takenOver as number);
  let anchored = false;
  const warnings: string[] = [];
  if (plan.anchor && o.corpus) {
    anchored = await postAnchor(db, o.corpus, id, plan.anchor, args.page);
    if (!anchored) warnings.push("corpus-mcp didn't store the anchor; the quote is flagged anchor_missing and the next import posts it again.");
  }
  if (takenOver) return { saved: false, taken_over: true, reason: "The work already had these words; corpus-mcp's quote was joined to it.", anchored, warnings, book: plan.book, quote: getQuote(db, id) };
  if (plan.status === "verified" && !plan.exact) warnings.push("The text is the book's wording, which differs from what was sent (quote marks, spacing, or case).");
  if (plan.status === "transcribed") warnings.push(plan.note);
  return { saved: true, status: plan.status, anchored, warnings, book: plan.book, quote: getQuote(db, id) };
}

/** The quote this request id, or these words for this work, already saved, as add_quote returns it. */
function alreadySaved(db: DB, origin: string, requestId: string, work?: number, text?: string): Record<string, unknown> | undefined {
  const byRequest = db.prepare("SELECT quote_id FROM quote_origins WHERE kind = ? AND ref = ?").pluck().get(origin, requestId) as number | undefined;
  if (byRequest !== undefined) return { saved: false, reason: "This request_id already saved this quote.", book: calibreSource(db, byRequest)?.book ?? null, quote: getQuote(db, byRequest) };
  if (work === undefined || text === undefined) return undefined;
  const byWords = db.prepare("SELECT id FROM quotes WHERE work_id = ? AND text_key = ? LIMIT 1").pluck().get(work, quoteKey(text)) as number | undefined;
  return byWords !== undefined ? { saved: false, reason: "The work already has this quote.", book: calibreSource(db, byWords)?.book ?? null, quote: getQuote(db, byWords) } : undefined;
}

async function planQuote(db: DB, t: Target, text: string, page: string | undefined, corpus: CorpusClient | null, spoken = false): Promise<Plan> {
  const transcribed = (work: number, note: string, book: Book | null = null): Plan =>
    ({ status: "transcribed", work, text, locatorKind: "page", locator: page?.trim() || null, section: null, position: null, anchor: null, book, exact: true, note });
  // Spoken on the capture page: the words are what was heard, corrected by the person, not a passage to prove against a file.
  if (spoken) {
    if (!t.work) throw new ToolError(`${t.label} isn't a work in the store. Choose the book on the capture page.`);
    return transcribed(t.work(), "Saved transcribed: spoken from the book, not checked against a text.");
  }
  if (!t.book || !corpus) {
    if (!t.work) throw new ToolError(`${t.label} is a Calibre book with no work here yet, and corpus-mcp, which would say which work it is, is off (CORPUS_BASE). Pass the work's key from find_work instead.`);
    return transcribed(t.work(), t.book ? "Saved transcribed: corpus-mcp is off here, so the words weren't checked against the book." : "Saved transcribed: the work has no Calibre book to check against.");
  }
  let v: Verified;
  try {
    v = await corpus.verify({ book: t.book, text, ...(pageOf(page) ? { page: pageOf(page) } : {}) });
  } catch (error) {
    if (!(error instanceof CorpusError)) throw error;
    if (error.code === "no-book") {
      if (!t.work) throw new ToolError(`corpus-mcp has no book ${t.label}.`, { error: "no-book" });
      return transcribed(t.work(), "Saved transcribed: there's no Calibre book of this work to check the words against.");
    }
    if (error.code === "no-text") {
      const book = error.body?.book as Book | undefined;
      return transcribed(book ? bookWork(db, book) : t.work!(), "Saved transcribed: the Calibre book has no usable text to check the words against.", book ?? null);
    }
    if (error.code === "ambiguous") {
      const books = (error.body?.books as Book[] | undefined) ?? [];
      throw new ToolError(`${t.label} names ${books.length} Calibre books; pass one's book_id as work: ${books.map((b) => `${b.book_id} (${b.title}${b.year ? `, ${b.year}` : ""})`).join("; ")}. Nothing was saved.`, { error: "ambiguous", books });
    }
    throw new ToolError(`${error.message}. Nothing was saved; try again.`, { error: "corpus-unavailable" });
  }
  if (!v.match) {
    throw new ToolError(`Not found in ${v.book.title} (${v.book.book_id}). Nothing was saved. The closest passages: ${JSON.stringify(v.closest)}`,
      { error: "no-match", message: `Not found in ${v.book.title} (${v.book.book_id}). Nothing was saved.`, closest: v.closest, book: v.book });
  }
  // The work comes from the book corpus-mcp matched, unless the caller named it and the book isn't in Zotero.
  const work = v.book.zotero ? bookWork(db, v.book) : t.work ? t.work() : calibreWork(db, v.book);
  // A printed page when the book has one; an EPUB has none, and is cited by chapter, from its section.
  const page_ = v.page_label ? v.locator?.replace(/^pp?\.\s*/, "") ?? v.page_label : null;
  const chapter = page_ ? null : chapterLocator(v.section);
  return { status: "verified", work, text: v.text, locatorKind: chapter ? "chapter" : "page", locator: page_ ?? chapter, section: v.locator ? null : v.section,
    position: { section: v.section, page_label: v.page_label }, anchor: v.anchor, book: v.book, exact: v.exact, note: "" };
}

/**
 * Saves the quote, or returns the one a concurrent call with this request id, or these words, saved first. One
 * of corpus-mcp's quotes whose words the work already has is taken over instead: the quote gains the corpus
 * origin and its tags, keeps its own text, and is flagged anchor_missing until the new anchor is posted.
 */
function save(db: DB, args: AddQuoteArgs, plan: Plan, requestId: string, actor: string, origin: string, source?: Record<string, unknown>): number | Record<string, unknown> {
  const stamp = now();
  const flags = [...(plan.locator ? [] : ["no_locator"]), ...(plan.anchor ? [ANCHOR_MISSING] : [])];
  // A chapter of an EPUB has no page: its section is the place, kept in the comment.
  const comment = [plan.section ? `Section: ${plan.section}` : null, args.comment?.trim() || null].filter(Boolean).join("\n\n") || null;
  const raw = JSON.stringify({ request: { ...args, request_id: requestId }, ...(source ? { source } : {}), ...(plan.book ? { book: plan.book } : {}),
    ...(plan.position ? { position: plan.position } : {}), ...(plan.anchor ? { anchor: plan.anchor } : {}) });
  return db.transaction((): number | Record<string, unknown> => {
    if (origin === "corpus") {
      const has = db.prepare("SELECT id FROM quotes WHERE work_id = ? AND text_key = ? LIMIT 1").pluck().get(plan.work, quoteKey(plan.text)) as number | undefined;
      if (has !== undefined && alreadySaved(db, origin, requestId) === undefined) return takeOver(db, has, args, plan, requestId, actor, origin, raw, stamp);
    }
    const earlier = alreadySaved(db, origin, requestId, plan.work, plan.text);
    if (earlier) return earlier;
    const id = db.prepare(`INSERT INTO quotes (id, kind, work_id, text, text_key, locator_kind, locator, comment, status, grade, flags, created_at, created_by, updated_at, updated_by)
      VALUES (${NEXT_QUOTE_ID}, 'quote', ?, ?, ?, ?, ?, ?, ?, 'A', ?, ?, ?, ?, ?) RETURNING id`).pluck()
      .get(plan.work, plan.text, quoteKey(plan.text), plan.locator ? plan.locatorKind : "none", plan.locator, comment, plan.status, JSON.stringify(flags), stamp, actor, stamp, actor) as number;
    db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES (?, ?, ?, NULL, ?, ?)").run(origin, requestId, id, raw, stamp);
    if (plan.book) keepCalibreBook(db, plan.book, stamp);
    const tags = [...new Set((args.tags ?? []).map((t) => t.trim()).filter(Boolean))];
    for (const tag of tags) db.prepare("INSERT OR IGNORE INTO quote_tags (quote_id, tag, concept_id, origin) VALUES (?, ?, ?, ?)").run(id, tag, conceptOf(db, tag), origin);
    const how = plan.status === "verified" ? `checked against Calibre book ${plan.book!.book_id}${plan.exact ? "" : "; the wording is the book's"}` : plan.note;
    const lead = origin === "capture" ? "capture" : "add_quote";
    db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'added', ?, ?, ?, ?)")
      .run(id, stamp, plan.exact ? null : args.text, plan.text, actor, `${lead}: ${how}`);
    db.prepare("INSERT INTO quotes_fts (rowid, text, comment, tags) VALUES (?, ?, ?, ?)").run(id, plan.text, comment ?? "", tags.join(" "));
    return id;
  })();
}

function takeOver(db: DB, id: number, args: AddQuoteArgs, plan: Plan, requestId: string, actor: string, origin: string, raw: string, stamp: string): { takenOver: number } {
  db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES (?, ?, ?, NULL, ?, ?)").run(origin, requestId, id, raw, stamp);
  const tags = [...new Set((args.tags ?? []).map((t) => t.trim()).filter(Boolean))];
  for (const tag of tags) db.prepare("INSERT OR IGNORE INTO quote_tags (quote_id, tag, concept_id, origin) VALUES (?, ?, ?, ?)").run(id, tag, conceptOf(db, tag), origin);
  if (plan.anchor) {
    db.prepare(`UPDATE quotes SET flags = json_insert(flags, '$[#]', ?), updated_at = ?, updated_by = ? WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM json_each(flags) WHERE value = ?)`).run(ANCHOR_MISSING, stamp, actor, id, ANCHOR_MISSING);
  }
  db.prepare("UPDATE quotes_fts SET tags = (SELECT group_concat(tag, ' ') FROM quote_tags WHERE quote_id = ?) WHERE rowid = ?").run(id, id);
  db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'taken_over', NULL, NULL, ?, ?)")
    .run(id, stamp, actor, `take-corpus-quotes: corpus-mcp's quote ${requestId} has these words${plan.book ? `, checked against Calibre book ${plan.book.book_id}` : ""}`);
  return { takenOver: id };
}

/**
 * Posts a quote's anchor, trying a failed connection again and verifying again once if corpus-mcp says the
 * anchor is stale; clears anchor_missing when stored.
 */
async function postAnchor(db: DB, corpus: CorpusClient, id: number, anchor: Record<string, unknown>, page?: string): Promise<boolean> {
  let current = anchor;
  let reverified = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await corpus.anchor(id, current);
      const flags = (JSON.parse(db.prepare("SELECT flags FROM quotes WHERE id = ?").pluck().get(id) as string) as string[]).filter((f) => f !== ANCHOR_MISSING);
      db.prepare("UPDATE quotes SET flags = ? WHERE id = ?").run(JSON.stringify(flags), id);
      return true;
    } catch (error) {
      if (!(error instanceof CorpusError)) throw error;
      if (error.code === "stale-anchor") {
        if (reverified) return false;
        reverified = true;
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
  const rows = db.prepare(`SELECT q.id, o.raw FROM quotes q JOIN quote_origins o ON o.quote_id = q.id AND o.kind IN ('agent', 'corpus')
    WHERE EXISTS (SELECT 1 FROM json_each(q.flags) WHERE value = ?)`).all(ANCHOR_MISSING) as { id: number; raw: string }[];
  let stored = 0;
  for (const r of rows) {
    const raw = JSON.parse(r.raw) as { anchor?: Record<string, unknown>; request?: AddQuoteArgs };
    if (raw.anchor && (await postAnchor(db, corpus, r.id, raw.anchor, raw.request?.page))) stored++;
  }
  return { tried: rows.length, stored };
}

// --- corpus-mcp's own quotes ---------------------------------------------------------------------

/** One of corpus-mcp's saved quotes, as GET /api/quotes lists them. */
export interface CorpusQuote {
  id: number; book_id: string; calibre_uuid: string; title: string; text: string; note: string | null; labels: string[];
  page: number | null; status: string; created_by: string | null; created_at: string; [field: string]: unknown;
}

/**
 * Takes over corpus-mcp's quotes (docs/dev-briefs/holdings-and-quotes.md §2.3): each is checked against its
 * book again, as add_quote does, saved with origin "corpus" (its corpus-mcp id as the ref, so a re-run skips
 * it) and its labels as tags exactly as written, and its new anchor posted. A book not in Zotero arrives as an
 * unmatched work carrying the Calibre UUID. Returns each quote's old and new id, or why it wasn't taken.
 */
export async function importCorpusQuotes(db: DB, corpus: CorpusClient, quotes: CorpusQuote[], o: { primary?: string | null; skip?: number[]; dryRun?: boolean } = {}) {
  const results: { corpus_id: number; quote_id?: number; status?: string; anchored?: boolean; taken_over?: boolean; skipped?: string; error?: string }[] = [];
  for (const c of quotes) {
    if (o.skip?.includes(c.id)) { results.push({ corpus_id: c.id, skipped: "asked to skip" }); continue; }
    const taken = db.prepare("SELECT quote_id FROM quote_origins WHERE kind = 'corpus' AND ref = ?").pluck().get(String(c.id)) as number | undefined;
    if (taken !== undefined) { results.push({ corpus_id: c.id, quote_id: taken, skipped: "already taken" }); continue; }
    if (o.dryRun) { results.push({ corpus_id: c.id, skipped: `dry run: would check it against ${c.calibre_uuid} (${c.title})` }); continue; }
    try {
      const r = await addQuote(db, {
        work: c.calibre_uuid, text: c.text, ...(c.page ? { page: String(c.page) } : {}), ...(c.note?.trim() ? { comment: c.note } : {}),
        tags: c.labels, request_id: String(c.id),
      }, { corpus, primary: o.primary, origin: "corpus", actor: `corpus-mcp${c.created_by ? `:${c.created_by}` : ""}`, source: c });
      const q = r.quote as { id: number; status: string };
      results.push({ corpus_id: c.id, quote_id: q.id, status: q.status, anchored: r.anchored as boolean | undefined,
        ...(r.taken_over ? { taken_over: true } : r.saved ? {} : { skipped: r.reason as string }) });
    } catch (error) {
      results.push({ corpus_id: c.id, error: (error as Error).message });
    }
  }
  return results;
}

// --- Following the anchors -----------------------------------------------------------------------

export interface AnchorChange {
  seq: number; quote_id: number; kind: "stored" | "replaced" | "reanchored" | "orphaned" | "found" | "deleted";
  status: string | null; anchor: Record<string, unknown> | null; at: string;
}
export interface AnchorChanges { log: string; changes: AnchorChange[]; last: number }

/**
 * Follows corpus-mcp's anchor changes (docs/dev-briefs/holdings-and-quotes.md §2.4), from the change number
 * kept in meta with the log id it belongs to; a new log id (corpus-mcp's change log was started again) means
 * reading from the start, which is safe, since applying a change twice changes nothing. An orphaned anchor
 * (the book's new file no longer has the words) keeps the quote verified, since it was checked, and flags it
 * anchor_lost for a person; found again, or stored again, clears the flag. Each anchor corpus-mcp now has
 * replaces the one kept with the quote's origin, except an orphaned one's. A deleted anchor changes nothing here. Changes for quotes
 * this store doesn't have are passed over.
 */
export async function followAnchors(db: DB, corpus: CorpusClient): Promise<{ read: number; lost: number; found: number; updated: number; from: number; to: number }> {
  let log = getMeta(db, "corpus_anchor_log");
  let since = Number(getMeta(db, "corpus_anchor_seq") ?? 0);
  const counts = { read: 0, lost: 0, found: 0, updated: 0, from: since, to: since };
  const flagged = (id: number, flag: string) =>
    db.prepare("SELECT 1 FROM quotes q WHERE id = ? AND EXISTS (SELECT 1 FROM json_each(q.flags) WHERE value = ?)").pluck().get(id, flag) !== undefined;
  const setFlag = (id: number, flag: string, on: boolean, stamp: string) => {
    if (flagged(id, flag) === on) return false;
    db.prepare(`UPDATE quotes SET flags = ${on ? "json_insert(flags, '$[#]', ?)" : "(SELECT json_group_array(value) FROM json_each(flags) WHERE value != ?)"},
      updated_at = ?, updated_by = 'corpus-mcp' WHERE id = ?`).run(flag, stamp, id);
    return true;
  };
  for (;;) {
    let page = await corpus.anchorChanges(since);
    if (page.log !== log) {
      if (since !== 0) page = await corpus.anchorChanges((since = 0));
      log = page.log;
      counts.from = 0;
    }
    if (!page.changes.length) break;
    // A page that doesn't move past `since` would be read again forever.
    if (page.changes.at(-1)!.seq <= since) throw new Error(`corpus-mcp's anchor changes after ${since} ended at ${page.changes.at(-1)!.seq}; stopped following them.`);
    db.transaction(() => {
      for (const c of page.changes) {
        counts.read++;
        const origin = db.prepare(`SELECT o.rowid, o.raw FROM quote_origins o JOIN quotes q ON q.id = o.quote_id WHERE o.quote_id = ? AND o.kind IN ('agent', 'corpus')
          AND json_extract(o.raw, '$.anchor') IS NOT NULL ORDER BY o.imported_at DESC LIMIT 1`).get(c.quote_id) as { rowid: number; raw: string } | undefined;
        if (!origin || c.kind === "deleted") continue;
        const stamp = now();
        // An orphaned change carries the last anchor with sha256 null; the one kept stays the last good one.
        if (c.anchor && c.kind !== "orphaned") {
          const raw = JSON.parse(origin.raw) as Record<string, unknown>;
          if (JSON.stringify(raw.anchor) !== JSON.stringify(c.anchor)) {
            db.prepare("UPDATE quote_origins SET raw = ? WHERE rowid = ?").run(JSON.stringify({ ...raw, anchor: c.anchor }), origin.rowid);
            counts.updated++;
          }
        }
        if (c.kind === "orphaned") {
          if (setFlag(c.quote_id, ANCHOR_LOST, true, stamp)) {
            counts.lost++;
            db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'anchor_lost', NULL, NULL, 'corpus-mcp', ?)")
              .run(c.quote_id, stamp, `corpus-mcp change ${c.seq}: the book's file changed and no longer has these words`);
          }
        } else if (setFlag(c.quote_id, ANCHOR_LOST, false, stamp)) {
          counts.found++;
          db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'anchor_found', NULL, NULL, 'corpus-mcp', ?)")
            .run(c.quote_id, stamp, `corpus-mcp change ${c.seq}: ${c.kind === "found" ? "found in the book again" : "anchored again"}`);
        }
      }
      since = page.changes.at(-1)!.seq;
      setMeta(db, "corpus_anchor_log", log!);
      setMeta(db, "corpus_anchor_seq", String(since));
    })();
  }
  // Kept even when no change was read, so a new, empty log's 0 replaces the old log's change number.
  if (log !== undefined) {
    setMeta(db, "corpus_anchor_log", log);
    setMeta(db, "corpus_anchor_seq", String(since));
  }
  counts.to = since;
  return counts;
}

// --- Calibre books -------------------------------------------------------------------------------

/**
 * Keeps corpus-mcp's record of a Calibre book a work here came from, for cite_quote (queries.ts calibreBookOf),
 * under the UUID as the work's origin spells it; the table ignores case either way.
 */
function keepCalibreBook(db: DB, book: Book, stamp = now(), uuid = book.calibre_uuid): void {
  if (!uuid) return;
  db.prepare(`INSERT INTO calibre_books (calibre_uuid, book_id, data, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (calibre_uuid) DO UPDATE SET book_id = excluded.book_id, data = excluded.data, fetched_at = excluded.fetched_at`)
    .run(uuid, book.book_id ?? null, JSON.stringify(book), stamp);
}

/**
 * Brings corpus-mcp's record of each Calibre book a work here came from up to date, from its books feed: a
 * citekey pinned since, or a Zotero item matched, is what cite_quote cites the work by until the work is filed.
 * Run after each import; the feed's ETag is kept, so an unchanged feed is one short request.
 */
export async function refreshCalibreBooks(db: DB, corpus: CorpusClient): Promise<{ books: number; updated: number; unchanged: boolean }> {
  const uuids = db.prepare("SELECT DISTINCT ref FROM work_origins WHERE kind = 'calibre'").pluck().all() as string[];
  if (!uuids.length || !corpus.booksFeed) return { books: uuids.length, updated: 0, unchanged: true };
  const etag = getMeta(db, "corpus_books_etag");
  const feed = await corpus.booksFeed(etag);
  if (!feed) return { books: uuids.length, updated: 0, unchanged: true };
  const wanted = new Map(uuids.map((u) => [u.toLowerCase(), u]));
  let updated = 0;
  const stamp = now();
  db.transaction(() => {
    for (const book of feed.books) {
      const uuid = book.calibre_uuid ? wanted.get(book.calibre_uuid.toLowerCase()) : undefined;
      if (!uuid) continue;
      const before = db.prepare("SELECT data FROM calibre_books WHERE calibre_uuid = ?").pluck().get(uuid) as string | undefined;
      if (before === JSON.stringify(book)) continue;
      keepCalibreBook(db, book, stamp, uuid);
      updated++;
    }
    if (feed.etag) setMeta(db, "corpus_books_etag", feed.etag);
  })();
  return { books: uuids.length, updated, unchanged: false };
}

// --- Chapter locators ----------------------------------------------------------------------------

export interface ChapterFill { id: number; section: string; from: string | null; locator: string; comment_section: boolean }

/**
 * Quotes checked against an EPUB before add_quote kept the chapter as the locator: no locator, and a section in
 * the place corpus-mcp named. Each gets "chap. <n>" (or the section's title), loses no_locator, and a history
 * entry; the "Section: …" line in its comment stays. A chapter locator add_quote or this set is worked out again,
 * and corrected when it differs (a better reading of the section); a page, or a locator a person edited, is left
 * alone. Dry run unless apply.
 */
export function fillChapterLocators(db: DB, o: { apply?: boolean; ids?: number[]; actor?: string } = {}): ChapterFill[] {
  const rows = db.prepare(`SELECT q.id, q.comment, q.locator, o.raw FROM quotes q JOIN quote_origins o ON o.quote_id = q.id
    WHERE o.kind IN ('agent', 'corpus') AND q.kind = 'quote'
      AND ((q.locator IS NULL AND q.locator_kind = 'none') OR (q.locator_kind = 'chapter' AND q.edited = 0))
      AND COALESCE(json_extract(o.raw, '$.position.section'), json_extract(o.raw, '$.anchor.section')) IS NOT NULL
      AND COALESCE(json_extract(o.raw, '$.position.page_label'), json_extract(o.raw, '$.anchor.page_label')) IS NULL
    ORDER BY q.id, o.imported_at`).all() as { id: number; comment: string | null; locator: string | null; raw: string }[];
  const fills: ChapterFill[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (seen.has(r.id) || (o.ids && !o.ids.includes(r.id))) continue;
    seen.add(r.id);
    const raw = JSON.parse(r.raw) as { position?: { section?: string | null }; anchor?: { section?: string | null } };
    const section = raw.position?.section ?? raw.anchor?.section ?? null;
    const locator = chapterLocator(section);
    if (!section || !locator || locator === r.locator) continue;
    fills.push({ id: r.id, section, from: r.locator === null ? null : `chap. ${r.locator}`, locator: `chap. ${locator}`, comment_section: (r.comment ?? "").includes(`Section: ${section}`) });
  }
  if (!o.apply) return fills;
  const actor = o.actor ?? "migrate";
  db.transaction(() => {
    const stamp = now();
    for (const f of fills) {
      const value = f.locator.slice("chap. ".length);
      const changed = db.prepare(`UPDATE quotes SET locator_kind = 'chapter', locator = ?,
        flags = (SELECT json_group_array(value) FROM json_each(flags) WHERE value != 'no_locator'), updated_at = ?, updated_by = ?
        WHERE id = ? AND ${f.from === null ? "locator IS NULL" : "locator_kind = 'chapter' AND edited = 0 AND locator = ?"}`)
        .run(value, stamp, actor, f.id, ...(f.from === null ? [] : [f.from.slice("chap. ".length)])).changes;
      if (!changed) continue;
      db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'locator', ?, ?, ?, ?)")
        .run(f.id, stamp, JSON.stringify({ locator: f.from }), JSON.stringify({ locator: f.locator }), actor, `The EPUB's chapter, from the section corpus-mcp named: ${f.section}`);
    }
  })();
  return fills;
}

export interface PageFix { id: number; from: string; to: string; edited: boolean; source: "corpus" | "anchor" }

const pageSpan = (label: string, end?: string | null) => (end && end !== label ? `${label}–${end}` : label);

/**
 * Verified quotes whose page isn't the book's printed page now: saved before corpus-mcp labelled the book's
 * pages, or relabelled since (a re-index changes labels without re-anchoring, and followAnchors keeps a new
 * anchor, not the locator). With corpus-mcp, each passage is looked up again (its anchor's text, from its page)
 * for the label it has now; without, or when it isn't found, the newest anchor's label is used. Each gets the
 * printed page ("392", "392–393"), with a history entry; a locator a person edited is listed and left alone.
 * Dry run unless apply.
 */
export async function fillPageLocators(db: DB, corpus: CorpusClient | null, o: { apply?: boolean; ids?: number[]; actor?: string } = {}): Promise<PageFix[]> {
  const rows = db.prepare(`SELECT q.id, q.locator, q.edited, o.raw FROM quotes q JOIN quote_origins o ON o.quote_id = q.id
    WHERE o.kind IN ('agent', 'corpus') AND q.status = 'verified' AND q.locator_kind = 'page' AND q.locator IS NOT NULL
      AND json_extract(o.raw, '$.anchor') IS NOT NULL
    ORDER BY q.id, o.imported_at DESC`).all() as { id: number; locator: string; edited: number; raw: string }[];
  const fixes: PageFix[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    // The newest origin with an anchor is the one followAnchors keeps up to date.
    if (seen.has(r.id) || (o.ids && !o.ids.includes(r.id))) continue;
    seen.add(r.id);
    const a = (JSON.parse(r.raw) as { anchor: { calibre_uuid?: string; text?: string; start_page?: number; page_label?: string | null; end_page_label?: string | null } }).anchor;
    let to = a.page_label ? pageSpan(a.page_label, a.end_page_label) : null;
    let source: PageFix["source"] = "anchor";
    if (corpus && a.calibre_uuid && a.text) {
      try {
        const v = await corpus.verify({ book: a.calibre_uuid, text: a.text, ...(typeof a.start_page === "number" ? { page: a.start_page + 1 } : {}) });
        const now_ = v.match ? (v.anchor as { page_label?: string | null; end_page_label?: string | null }) : null;
        if (now_?.page_label) [to, source] = [pageSpan(now_.page_label, now_.end_page_label), "corpus"];
      } catch (error) {
        if (!(error instanceof CorpusError)) throw error;
      }
    }
    if (!to || r.locator.replace(/-/g, "–") === to) continue;
    fixes.push({ id: r.id, from: r.locator, to, edited: Boolean(r.edited), source });
  }
  if (!o.apply) return fixes;
  const actor = o.actor ?? "migrate";
  db.transaction(() => {
    const stamp = now();
    for (const f of fixes) {
      if (f.edited) continue;
      const changed = db.prepare("UPDATE quotes SET locator = ?, updated_at = ?, updated_by = ? WHERE id = ? AND locator = ? AND edited = 0")
        .run(f.to, stamp, actor, f.id, f.from).changes;
      if (!changed) continue;
      db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'locator', ?, ?, ?, ?)")
        .run(f.id, stamp, JSON.stringify({ locator: `p. ${f.from}` }), JSON.stringify({ locator: `p. ${f.to}` }), actor,
          f.source === "corpus" ? "The printed page corpus-mcp finds the passage on now, not the file's page" : "The printed page corpus-mcp's anchor has, not the file's page");
    }
  })();
  return fixes;
}
