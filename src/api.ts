import type http from "node:http";
import type { TLSSocket } from "node:tls";
import { type ApiAnswer, type Routes, answerApi, answerLinking, publishedRoutes } from "./api-routes.js";
import type { DB } from "./db.js";
import type { Published } from "./published.js";
import { conceptGraph, findConcept, getConcept, searchQuotes } from "./queries.js";
import { type ConceptSet, listSets, setGraph } from "./sets.js";

/**
 * A read-only JSON API at /api, for the concept maps (quote-atlas, served at /map/ from the same
 * origin, so it needs no CORS and no auth of its own). Its routes and response fields are a contract
 * with the maps: add fields, but don't rename or remove them.
 *
 *   GET /api/graph                    every concept (with its quote count and source) and every relation
 *   GET /api/concepts/:slug           one concept, as get_concept returns it; scheme:slug works too
 *   GET /api/concepts/:slug/quotes    its quotes and notes, narrower concepts included unless narrower=false;
 *                                     limit (1–100, default 20) and offset
 *   GET /api/sets                     the concept sets (src/sets.ts), with how many concepts each has
 *   GET /api/sets/:slug               one set as a piece of the graph: /api/graph's shape, with the set's
 *                                     slug, scheme, label, description, definition, and missing slugs
 *
 * The routing is in src/api-routes.ts, shared with the Worker. handleApi answers from the store, on the
 * same queries as the MCP tools, so the two can't disagree. handlePublishedApi answers the same routes
 * from the public snapshot (src/published.ts), for the public site: counts of public records, quotes as
 * public records, and 403 for quotes below the quotes level.
 */

function write(res: http.ServerResponse, a: ApiAnswer): void {
  res.writeHead(a.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...a.headers }).end(JSON.stringify(a.body));
}

async function send(res: http.ServerResponse, routes: Routes, req: http.IncomingMessage, url: URL): Promise<void> {
  write(res, await answerApi(routes, req.method ?? "GET", url));
}

/** Answers an /api request from the store. */
export function handleApi(db: DB, req: http.IncomingMessage, res: http.ServerResponse, url: URL, sets: ConceptSet[] = []): Promise<void> {
  return send(res, {
    graph: () => conceptGraph(db),
    sets: () => listSets(db, sets),
    set: (slug) => setGraph(db, sets, slug),
    concept: (slug) => getConcept(db, slug),
    quotes: (slug, narrower, limit, offset) => {
      const concept = findConcept(db, slug);
      return { concept, ...searchQuotes(db, { concept: `${concept.scheme}:${concept.slug}`, narrower, limit, offset }) };
    },
  }, req, url);
}

/** Answers an /api request from the public snapshot. */
export function handlePublishedApi(p: Published, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  return send(res, publishedRoutes(p), req, url);
}

/**
 * Answers /site.json or /api/public/citekeys from the public snapshot, cacheable as the site's pages are and with the
 * snapshot's hash as its ETag, as the Worker answers them. The site's URL is the one the request came in on: the
 * scheme and host a proxy in front reports, else the connection's own (HTTPS on the TLS listener).
 */
export async function handleLinking(p: Published, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const tls = (req.socket as TLSSocket).encrypted === true;
  const proto = String(req.headers["x-forwarded-proto"] ?? (tls ? "https" : "http")).split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0].trim();
  const a = await answerLinking(p, req.method ?? "GET", url.pathname, `${proto}://${host}`);
  if (a.status !== 200) return write(res, a);
  const etag = `W/"${p.hash.slice(0, 20)}"`;
  const cache = { "cache-control": "public, max-age=60", etag, "x-content-type-options": "nosniff" };
  if (req.headers["if-none-match"]?.split(/\s*,\s*/).includes(etag)) {
    res.writeHead(304, cache).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...cache }).end(JSON.stringify(a.body));
}
