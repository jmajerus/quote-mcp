import type http from "node:http";
import { addQuote, type AddQuoteArgs } from "./capture.js";
import { ToolError } from "./common.js";
import type { DB } from "./db.js";
import type { Capture } from "./mcp.js";
import { locatorText } from "./queries.js";

/**
 * Routes for corpus-mcp's book reader, on the LAN only (docs/dev-briefs/holdings-and-quotes.md; corpus-mcp's
 * §3.4). The reader keeps highlighting quotes from its anchors and links each to quote-mcp's admin page; these
 * give it the quotes saved from one book, and save a selection as add_quote does.
 *
 *   GET  /api/corpus/quotes?book=<calibre_uuid or book_id>
 *        → { book, quotes: [{ id, kind, text, prose, note?, comment, tags, status, flags, locator, anchor, admin_path }] }
 *   POST /api/corpus/quotes  { work, text, file_page?, page_label?, comment?, tags?, request_id?, by? }
 *        file_page is the reader's page: the 1-based position in the book's file (a number, or a string of one), where
 *        corpus-mcp starts looking. page_label is the number printed on the page. Each one given is checked against
 *        where the passage is found. page is a deprecated name for file_page, kept for one release. null for any
 *        optional field is the same as leaving it out.
 *        → 201 with add_quote's answer when saved (position carries file_page and page_label), 200 when it was
 *          already (saved: false);
 *          422 { error: "no-match", message, closest, book } | { error: "ambiguous", books }
 *            | { error: "page-mismatch", message, given, found, book } | { error, message };
 *          502 { error: "corpus-unavailable" } when verify couldn't be reached
 */

const MAX_BODY = 64 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
}

/**
 * The quotes checked against one Calibre book, by its UUID or corpus-mcp book id, with the anchor kept for each:
 * one query, the fields the reader uses, rather than a full get_quote for each.
 */
export function bookQuotes(db: DB, book: string) {
  const rows = db.prepare(`SELECT q.id, q.kind, q.text, q.comment, q.status, q.flags, q.locator_kind, q.locator, o.raw,
      (SELECT json_group_array(tag) FROM (SELECT tag FROM quote_tags WHERE quote_id = q.id ORDER BY tag)) AS tags
    FROM quote_origins o JOIN quotes q ON q.id = o.quote_id
    WHERE o.kind IN ('agent', 'corpus') AND (json_extract(o.raw, '$.book.calibre_uuid') = @book OR json_extract(o.raw, '$.book.book_id') = @book)
    ORDER BY q.id, json_extract(o.raw, '$.anchor') IS NULL, o.imported_at DESC`).all({ book }) as
    { id: number; kind: string; text: string; comment: string | null; status: string; flags: string; locator_kind: string; locator: string | null; raw: string; tags: string }[];
  const seen = new Set<number>();
  const quotes = [];
  for (const q of rows) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    quotes.push({
      id: q.id, kind: q.kind, text: q.text, prose: q.text, ...(q.kind === "note" ? { note: q.comment } : {}),
      comment: q.comment, tags: JSON.parse(q.tags) as string[], status: q.status, flags: JSON.parse(q.flags) as string[],
      locator: locatorText(q.locator_kind, q.locator), anchor: (JSON.parse(q.raw) as { anchor?: unknown }).anchor ?? null, admin_path: `/admin/quotes/${q.id}`,
    });
  }
  return { book, quotes };
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ToolError("The body is too large.", { error: "bad-request" });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ToolError("The body isn't JSON.", { error: "bad-request" });
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The add_quote arguments in a POST body, or a ToolError saying what's wrong. */
function quoteArgs(body: unknown): AddQuoteArgs & { by?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ToolError("Send { work, text, file_page?, page_label?, comment?, tags?, request_id?, by? }.", { error: "bad-request" });
  const b = body as Record<string, unknown>;
  if (!str(b.work)?.trim()) throw new ToolError("Send the work: a Calibre book id or UUID, a citekey, or a work key.", { error: "bad-request" });
  if (!str(b.text)?.trim()) throw new ToolError("Send the text to save.", { error: "bad-request" });
  // An optional field sent as null is one left out.
  for (const k of ["file_page", "page_label", "page", "comment", "tags", "request_id", "by"]) if (b[k] === null) delete b[k];
  // page is the deprecated name for file_page here: the reader's page.
  const filePage = (k: string) => {
    const v = b[k];
    if (v === undefined) return undefined;
    const n = typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1) return n;
    throw new ToolError(`${k} is a position in the book's file from 1, the reader's page.`, { error: "bad-request" });
  };
  const [file, legacy] = [filePage("file_page"), filePage("page")];
  if (file !== undefined && legacy !== undefined && file !== legacy) {
    throw new ToolError(`page (deprecated; it means file_page here) is ${legacy} but file_page is ${file}. Send file_page alone.`, { error: "page-mismatch" });
  }
  if (b.tags !== undefined && !(Array.isArray(b.tags) && b.tags.every((t) => typeof t === "string"))) throw new ToolError("tags is a list of strings.", { error: "bad-request" });
  for (const k of ["page_label", "comment", "request_id", "by"]) {
    if (b[k] !== undefined && typeof b[k] !== "string") throw new ToolError(`${k} is a string.`, { error: "bad-request" });
  }
  const fp = file ?? legacy;
  return { work: str(b.work)!, text: str(b.text)!, ...(fp !== undefined ? { file_page: fp } : {}), ...(str(b.page_label)?.trim() ? { page_label: str(b.page_label) } : {}),
    comment: str(b.comment), tags: b.tags as string[] | undefined, request_id: str(b.request_id), by: str(b.by)?.trim() || undefined };
}

/** Answers /api/corpus/quotes; the caller has checked the request came over the LAN. */
export async function handleCorpusQuotes(db: DB, capture: Capture | undefined, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  try {
    if (req.method === "GET") {
      const book = url.searchParams.get("book")?.trim();
      if (!book) return send(res, 400, { error: "bad-request", message: "Send ?book=<calibre_uuid or book_id>." });
      return send(res, 200, bookQuotes(db, book));
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "GET, POST", "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "Method not allowed." }));
      return;
    }
    if (!capture) return send(res, 503, { error: "no-capture", message: "Saving quotes isn't set up on this server." });
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return send(res, 415, { error: "bad-request", message: "Send application/json." });
    const { by, ...args } = quoteArgs(await readJson(req));
    const answer = await addQuote(capture.writer(), args, { corpus: capture.corpus, primary: capture.primary, refreshZotero: capture.refreshZotero, actor: `corpus-mcp${by ? `:${by}` : ""}` });
    return send(res, answer.saved ? 201 : 200, answer);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    const code = String(error.data?.error ?? "not-saved");
    // data.message, when there is one, is the message without what the answer carries as data (the closest passages).
    send(res, code === "bad-request" ? 400 : code === "corpus-unavailable" ? 502 : 422, { ...error.data, error: code, message: (error.data?.message as string | undefined) ?? error.message });
  }
}
