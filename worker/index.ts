import { PUBLIC_API, answerApi, publishedRoutes } from "../src/api-routes.js";
import { ToolError } from "../src/common.js";
import { faviconBytes } from "../src/favicon.js";
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
 * that finds nothing published since is a 304. A Worker's responses aren't kept by Cloudflare's cache on
 * their own, and a page reads thousands of rows (D1's free tier allows five million a day), so the Worker
 * keeps each page and API answer in the colo's cache itself, under the snapshot's hash: past the first
 * view, a request reads only the snapshot's meta, and a new publish is a new hash, so nothing goes stale.
 */

export interface Env {
  DB: D1Database;
}

/** The part of the Worker's context the cache needs: a write that can finish after the response. */
export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

/** The colo's cache, which the Worker runtime has and Node (the tests) doesn't. */
const edge = (): Cache | undefined => (globalThis as { caches?: { default?: Cache } }).caches?.default;

/** How long a colo keeps a snapshot's answer; the hash in its key retires it sooner when there's a new one. */
const KEEP = 86400;

/** Search is the one part of the site without bounds, so crawlers are asked to leave it alone. */
const ROBOTS = "User-agent: *\nDisallow: /search\nDisallow: /api/\n";

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

export async function handle(request: Request, env: Env, ctx?: Context): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/robots.txt") return text(200, ROBOTS, { "cache-control": "public, max-age=86400" });
  if (url.pathname === "/map") return new Response(null, { status: 301, headers: { location: `/map/${url.search}` } });
  if (url.pathname === "/favicon.png" || url.pathname === "/favicon.ico") {
    return new Response(request.method === "HEAD" ? null : faviconBytes(), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
  }
  const page = isSitePath(url.pathname);
  if (!page && !PUBLIC_API.test(url.pathname)) return text(404, "Not found");
  if (page && request.method !== "GET" && request.method !== "HEAD") return text(405, "Method not allowed", { allow: "GET, HEAD" });

  const p = await published(env);
  if (!p) return text(503, NOT_PUBLISHED, { "retry-after": "60" });
  const etag = `W/"${p.hash.slice(0, 20)}"`;
  const cache = { "cache-control": "public, max-age=60", etag, "x-content-type-options": "nosniff" };
  if (request.headers.get("if-none-match")?.split(/\s*,\s*/).includes(etag)) return new Response(null, { status: 304, headers: cache });

  // Always a GET, so a HEAD finds what a GET kept.
  const key = new Request(`${url.origin}/__snapshot/${p.hash.slice(0, 20)}${url.pathname}${url.search}`);
  const kept = await edge()?.match(key);
  if (kept) return new Response(request.method === "HEAD" ? null : kept.body, { status: kept.status, headers: { ...Object.fromEntries(kept.headers), ...cache } });

  const res = await answer(p, request, url, cache);
  if (res.status === 200 && (request.method === "GET" || request.method === "HEAD") && ctx) {
    const c = edge();
    if (c) {
      const copy = new Response(await res.clone().arrayBuffer(), res);
      copy.headers.set("cache-control", `public, max-age=${KEEP}`);
      ctx.waitUntil(c.put(key, copy));
    }
  }
  return request.method === "HEAD" ? new Response(null, res) : res;
}

/** The page or API answer for a request, read from the snapshot. */
async function answer(p: Published, request: Request, url: URL, cache: Record<string, string>): Promise<Response> {
  if (!isSitePath(url.pathname)) {
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
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...cache } });
}

export default {
  fetch: (request: Request, env: Env, ctx: Context) => handle(request, env, ctx),
};
