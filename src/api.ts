import type http from "node:http";
import type { DB } from "./db.js";
import { NotPublic, type Visibility, publicCount, publicCounts, publicQuotes } from "./public.js";
import { ToolError, conceptGraph, findConcept, getConcept, searchQuotes, withNarrower } from "./queries.js";
import { type ConceptSet, listSets, setGraph } from "./sets.js";

/**
 * A read-only JSON API at /api, for the concept maps (quote-atlas, served at /map/ from the same
 * origin, so it needs no CORS and no auth of its own). Built on the same queries as the MCP tools, so
 * the two can't disagree. Its routes and response fields are a contract with the maps: add fields, but
 * don't rename or remove them.
 *
 *   GET /api/graph                    every concept (with its quote count and source) and every relation
 *   GET /api/concepts/:slug           one concept, as get_concept returns it; scheme:slug works too
 *   GET /api/concepts/:slug/quotes    its quotes and notes, narrower concepts included unless narrower=false;
 *                                     limit (1–100, default 20) and offset
 *   GET /api/sets                     the concept sets (src/sets.ts), with how many concepts each has
 *   GET /api/sets/:slug               one set as a piece of the graph: /api/graph's shape, with the set's
 *                                     slug, scheme, label, description, definition, and missing slugs
 *
 * On the public listener (`pub` given) the same routes answer with only what's public (src/public.ts):
 * counts of public records, and quotes as public records, or 403 below the quotes level.
 */

class BadRequest extends Error {}

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

/** Answers an /api request. */
/** Concepts with their counts of public records, in place of every record's. */
function recount<T extends { scheme: string; slug: string; quotes: number }>(db: DB, pub: Visibility, concepts: T[]): T[] {
  const n = publicCounts(db, pub);
  return concepts.map((c) => ({ ...c, quotes: n.get(`${c.scheme}:${c.slug}`) ?? 0 }));
}

export function handleApi(db: DB, req: http.IncomingMessage, res: http.ServerResponse, url: URL, sets: ConceptSet[] = [], pub?: Visibility): void {
  if (req.method !== "GET") {
    send(res, 405, { error: "Method not allowed: the API is read-only." }, { allow: "GET" });
    return;
  }
  try {
    if (url.pathname === "/api/graph") {
      const graph = conceptGraph(db);
      send(res, 200, pub ? { ...graph, concepts: recount(db, pub, graph.concepts) } : graph);
      return;
    }
    if (url.pathname === "/api/sets") {
      send(res, 200, { sets: listSets(db, sets) });
      return;
    }
    const set = /^\/api\/sets\/([^/]+)$/.exec(url.pathname);
    if (set) {
      const graph = setGraph(db, sets, slugOf(set[1]));
      send(res, 200, pub ? { ...graph, concepts: recount(db, pub, graph.concepts) } : graph);
      return;
    }
    const m = /^\/api\/concepts\/([^/]+)(\/quotes)?$/.exec(url.pathname);
    if (!m) {
      send(res, 404, { error: "Not found." });
      return;
    }
    const slug = slugOf(m[1]);
    if (!m[2]) {
      const c = getConcept(db, slug);
      send(res, 200, pub ? { ...c, quotes: publicCount(db, pub, [c.id]), quotes_with_narrower: publicCount(db, pub, withNarrower(db, c.id)) } : c);
      return;
    }
    const concept = findConcept(db, slug);
    const p = url.searchParams;
    if (pub) {
      const ids = p.get("narrower") === "false" ? [concept.id] : withNarrower(db, concept.id);
      send(res, 200, { concept, ...publicQuotes(db, pub, { conceptIds: ids, limit: integer(p, "limit"), offset: integer(p, "offset") }) });
      return;
    }
    const quotes = searchQuotes(db, { concept: `${concept.scheme}:${concept.slug}`, narrower: p.get("narrower") !== "false", limit: integer(p, "limit"), offset: integer(p, "offset") });
    send(res, 200, { concept, ...quotes });
  } catch (error) {
    if (error instanceof ToolError) send(res, 404, { error: error.message });
    else if (error instanceof BadRequest) send(res, 400, { error: error.message });
    else if (error instanceof NotPublic) send(res, 403, { error: error.message });
    else throw error;
  }
}
