import { createHash } from "node:crypto";
import type http from "node:http";
import { citekeyOf } from "./csl.js";
import type { DB } from "./db.js";
import { firstLibrary, json } from "./queries.js";

/**
 * The counts feed for holdings-mcp (docs/dev-briefs/holdings-and-quotes.md §1): one entry per work that
 * has quotes or notes, with how many of each and how many quotes are verified. A work matched to one
 * Zotero item is sent by that item, with its citekey; holdings-mcp keys it zotero:<library>/<key>. An
 * unmatched or ambiguous work is sent by its id (holdings-mcp's quote:<id>) with its title, authors,
 * and year, and an ambiguous one with its candidate items as <library>/<key>. Unparsed records aren't
 * counted. Every entry has its work_id, and former_work_ids lists the ids of works since filed into it,
 * so holdings-mcp can move a quote:<id> key to the work's zotero: key. Served at GET
 * /api/holdings/counts, on the LAN only, with a strong ETag.
 */

export const HOLDINGS_COUNTS_VERSION = 1;

interface Counts { quotes: number; notes: number; verified: number }
interface Ids { work_id: number; former_work_ids?: number[] }
export type HoldingsWork =
  | (Ids & { match: "zotero"; zotero: { library: string; key: string }; citekey: string | null } & Counts)
  | (Ids & { match: "unmatched" | "ambiguous"; candidates?: string[]; title: string; authors: string[]; year: string | null } & Counts);

/** The feed's body. Candidates are items in the primary library, the one the import matches works against. */
export function holdingsCounts(db: DB, library: string | null = firstLibrary(db)): { version: number; works: HoldingsWork[] } {
  const rows = db.prepare(`
    SELECT w.id, w.match, w.title, w.authors, w.year, w.zotero_library, w.zotero_key, w.candidates, z.data,
      SUM(q.kind = 'quote') AS quotes, SUM(q.kind = 'note') AS notes, SUM(q.kind = 'quote' AND q.status = 'verified') AS verified,
      (SELECT json_group_array(CAST(o.ref AS INTEGER)) FROM work_origins o WHERE o.kind = 'work' AND o.work_id = w.id) AS former
    FROM works w JOIN quotes q ON q.work_id = w.id AND q.status != 'unparsed'
    LEFT JOIN zotero_items z ON z.library = w.zotero_library AND z.key = w.zotero_key
    GROUP BY w.id ORDER BY w.zotero_library IS NULL, w.zotero_library, w.zotero_key, w.id`).all() as Record<string, unknown>[];
  const works = rows.map((w): HoldingsWork => {
    const counts = { quotes: w.quotes as number, notes: w.notes as number, verified: w.verified as number };
    const former = json<number[]>(w.former as string, []).sort((a, b) => a - b);
    const ids = { work_id: w.id as number, ...(former.length ? { former_work_ids: former } : {}) };
    if (w.match === "zotero") {
      return { ...ids, match: "zotero", zotero: { library: w.zotero_library as string, key: w.zotero_key as string }, citekey: w.data ? citekeyOf(JSON.parse(w.data as string)) : null, ...counts };
    }
    const candidates = json<string[]>(w.candidates as string | null, []);
    return {
      ...ids, match: w.match as "unmatched" | "ambiguous",
      ...(w.match === "ambiguous" ? { candidates: candidates.map((key) => (library ? `${library}/${key}` : key)) } : {}),
      title: w.title as string, authors: json<string[]>(w.authors as string, []), year: (w.year as string) ?? null, ...counts,
    };
  });
  return { version: HOLDINGS_COUNTS_VERSION, works };
}

/** Answers GET /api/holdings/counts: the feed with a strong ETag, or 304 when If-None-Match names it. */
export function handleHoldingsCounts(db: DB, req: http.IncomingMessage, res: http.ServerResponse, library?: string): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "Method not allowed." }));
    return;
  }
  const body = JSON.stringify(holdingsCounts(db, library));
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  const headers = { etag, "cache-control": "no-cache" };
  const match = req.headers["if-none-match"];
  if (match && (match.trim() === "*" || match.split(",").some((t) => t.trim() === etag))) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" }).end(req.method === "HEAD" ? undefined : body);
}
