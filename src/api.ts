import type http from "node:http";
import type { DB } from "./db.js";
import { NotPublic, type Published } from "./published.js";
import { ToolError, conceptGraph, findConcept, getConcept, searchQuotes } from "./queries.js";
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
 * handleApi answers from the store, on the same queries as the MCP tools, so the two can't disagree.
 * handlePublishedApi answers the same routes from the public snapshot (src/published.ts), for the
 * public site: counts of public records, quotes as public records, and 403 for quotes below the
 * quotes level.
 */

class BadRequest extends Error {}

/** What each route returns. */
interface Routes {
  graph(): unknown;
  sets(): unknown;
  set(slug: string): unknown;
  concept(slug: string): unknown;
  quotes(slug: string, narrower: boolean, limit: number | undefined, offset: number | undefined): unknown;
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }).end(JSON.stringify(body));
}

function integer(params: URLSearchParams, name: string): number | undefined {
  const value = params.get(name);
  if (value === null || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw new BadRequest(`${name} must be a whole number.`);
  return Number(value);
}

function slugOf(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new BadRequest("The name in the path isn't valid.");
  }
}

function answer(routes: Routes, req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (req.method !== "GET") {
    send(res, 405, { error: "Method not allowed: the API is read-only." }, { allow: "GET" });
    return;
  }
  try {
    if (url.pathname === "/api/graph") return send(res, 200, routes.graph());
    if (url.pathname === "/api/sets") return send(res, 200, { sets: routes.sets() });
    const set = /^\/api\/sets\/([^/]+)$/.exec(url.pathname);
    if (set) return send(res, 200, routes.set(slugOf(set[1])));
    const m = /^\/api\/concepts\/([^/]+)(\/quotes)?$/.exec(url.pathname);
    if (!m) return send(res, 404, { error: "Not found." });
    const p = url.searchParams;
    send(res, 200, m[2] ? routes.quotes(slugOf(m[1]), p.get("narrower") !== "false", integer(p, "limit"), integer(p, "offset")) : routes.concept(slugOf(m[1])));
  } catch (error) {
    if (error instanceof ToolError) send(res, 404, { error: error.message });
    else if (error instanceof BadRequest) send(res, 400, { error: error.message });
    else if (error instanceof NotPublic) send(res, 403, { error: error.message });
    else throw error;
  }
}

/** Answers an /api request from the store. */
export function handleApi(db: DB, req: http.IncomingMessage, res: http.ServerResponse, url: URL, sets: ConceptSet[] = []): void {
  answer({
    graph: () => conceptGraph(db),
    sets: () => listSets(db, sets),
    set: (slug) => setGraph(db, sets, slug),
    concept: (slug) => getConcept(db, slug),
    quotes: (slug, narrower, limit, offset) => {
      const concept = findConcept(db, slug);
      return { concept, ...searchQuotes(db, { concept: `${concept.scheme}:${concept.slug}`, narrower, limit, offset }) };
    },
  }, req, res, url);
}

/** Answers an /api request from the public snapshot. */
export function handlePublishedApi(p: Published, req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  answer({
    graph: () => p.graph(),
    sets: () => p.sets(),
    set: (slug) => p.set(slug),
    concept: (slug) => p.concept(slug),
    quotes: (slug, narrower, limit, offset) => {
      const concept = p.findConcept(slug);
      return { concept, ...p.quotes({ conceptIds: narrower ? p.withNarrower(concept.id) : [concept.id], limit, offset }) };
    },
  }, req, res, url);
}
