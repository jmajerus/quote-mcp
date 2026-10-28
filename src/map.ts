import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";

/**
 * Serves the concept map's static files at /map/ from QUOTE_MAP_DIR. human-work-map's deploy copies its
 * build there; quote-mcp only serves whatever is in the folder. A path that resolves outside it (`..`,
 * an encoded variant, a symlink) is refused. index.html is revalidated on every load; a file whose name
 * carries a build hash (app-3f9a1c2e.js) can be cached for a year, since a new build gets a new name.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2",
  ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".map": "application/json; charset=utf-8",
};
const HASHED = /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
}

/** The real path of a file inside the folder, or null when it isn't one. */
async function resolveInside(dir: string, relative: string): Promise<string | null> {
  try {
    const root = await fs.realpath(dir);
    let file = await fs.realpath(path.join(root, relative));
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, "index.html");
    const real = await fs.realpath(file);
    return real.startsWith(root + path.sep) && (await fs.stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Answers a /map request; without a map folder there is no map. */
export async function serveMap(dir: string | undefined, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (!dir) return notFound(res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  if (url.pathname === "/map") {
    res.writeHead(301, { location: `/map/${url.search}` }).end();
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname.slice("/map/".length));
  } catch {
    return notFound(res);
  }
  if (relative.includes("\0") || relative.split(/[\\/]/).includes("..")) return notFound(res);
  const file = await resolveInside(dir, relative);
  if (!file) return notFound(res);
  const name = path.basename(file);
  const cache = name.endsWith(".html") || !HASHED.test(name) ? "no-cache" : "public, max-age=31536000, immutable";
  const body = await fs.readFile(file);
  res.writeHead(200, {
    "content-type": TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream", "content-length": body.length,
    "cache-control": cache, "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}
