import { PUBLIC_API, answerApi, publishedRoutes } from "../src/api-routes.js";
import { ToolError } from "../src/common.js";
import { Published } from "../src/published.js";
import { isSitePath, renderSite } from "../src/site.js";
import { type D1Database, d1Store } from "./d1.js";

/**
 * The public site as a Cloudflare Worker: the pages (src/site.ts) and the maps' API (src/api-routes.ts),
 * read from the public snapshot's replica in D1, which only quote-mcp's drain writes. The same code the
 * LAN preview runs, with D1 in place of better-sqlite3. The maps' own files are quote-atlas's, on its own
 * route for /map/*; this Worker only sends a bare /map there.
 *
 * Responses can be cached for a minute; each carries the snapshot's hash as its ETag, so a revalidation
 * that finds nothing published since is a 304.
 */

export interface Env {
  DB: D1Database;
}

const NOT_PUBLISHED = "This site hasn't been published yet.";

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

/** The replica, or null when nothing has been published to it yet. */
async function published(env: Env): Promise<Published | null> {
  try {
    const p = await Published.open(d1Store(env.DB));
    return p.hash ? p : null;
  } catch {
    return null;
  }
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/map") return new Response(null, { status: 301, headers: { location: `/map/${url.search}` } });
  const page = isSitePath(url.pathname);
  if (!page && !PUBLIC_API.test(url.pathname)) return text(404, "Not found");
  if (page && request.method !== "GET" && request.method !== "HEAD") return text(405, "Method not allowed", { allow: "GET, HEAD" });

  const p = await published(env);
  if (!p) return text(503, NOT_PUBLISHED, { "retry-after": "60" });
  const etag = `W/"${p.hash.slice(0, 20)}"`;
  const cache = { "cache-control": "public, max-age=60", etag, "x-content-type-options": "nosniff" };
  if (request.headers.get("if-none-match")?.split(/\s*,\s*/).includes(etag)) return new Response(null, { status: 304, headers: cache });

  if (!page) {
    const a = await answerApi(publishedRoutes(p), request.method, url);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json; charset=utf-8", ...(a.status === 200 ? cache : {}), ...a.headers } });
  }
  let html: string | null;
  try {
    html = await renderSite(p, url.pathname, url.searchParams);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    html = null;
  }
  if (html === null) return text(404, "Not found");
  return new Response(request.method === "HEAD" ? null : html, { headers: { "content-type": "text/html; charset=utf-8", ...cache } });
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
};
