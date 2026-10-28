import type http from "node:http";
import type { DB } from "./db.js";
import { ToolError, conceptGraph, findConcept, getConcept, searchQuotes } from "./queries.js";

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
    throw new BadRequest("The concept in the path isn't valid.");
  }
}

/** Answers an /api request. */
export function handleApi(db: DB, req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (req.method !== "GET") {
    send(res, 405, { error: "Method not allowed: the API is read-only." }, { allow: "GET" });
    return;
  }
  try {
    if (url.pathname === "/api/graph") {
      send(res, 200, conceptGraph(db));
      return;
    }
    const m = /^\/api\/concepts\/([^/]+)(\/quotes)?$/.exec(url.pathname);
    if (!m) {
      send(res, 404, { error: "Not found." });
      return;
    }
    const slug = slugOf(m[1]);
    if (!m[2]) {
      send(res, 200, getConcept(db, slug));
      return;
    }
    const concept = findConcept(db, slug);
    const p = url.searchParams;
    const quotes = searchQuotes(db, { concept: `${concept.scheme}:${concept.slug}`, narrower: p.get("narrower") !== "false", limit: integer(p, "limit"), offset: integer(p, "offset") });
    send(res, 200, { concept, ...quotes });
  } catch (error) {
    if (error instanceof ToolError) send(res, 404, { error: error.message });
    else if (error instanceof BadRequest) send(res, 400, { error: error.message });
    else throw error;
  }
}
