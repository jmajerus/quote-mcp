import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";

/**
 * Serves the concept maps' static files at /map/ from QUOTE_MAP_DIR. quote-atlas's deploy copies its
 * build there; quote-mcp only serves whatever is in the folder. A path that resolves outside it (`..`,
 * an encoded variant, a symlink) is refused. index.html is revalidated on every load; a file whose name
 * carries a build hash (app-3f9a1c2e.js) can be cached for a year, since a new build gets a new name.
 * Every file has an ETag and Last-Modified, so a revalidation that finds it unchanged is a 304.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2",
  ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".map": "application/json; charset=utf-8",
};
/** A build hash before the extension: eight or more letters, digits, - and _, at least one a digit, so a word like "-positions" isn't one. */
const HASHED = /[.-](?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
}

/** The real path of a file inside the folder (a folder's index.html for a folder), or null when it isn't one. */
async function resolveInside(dir: string, relative: string): Promise<{ file: string; folder: boolean } | null> {
  try {
    const root = await fs.realpath(dir);
    let file = await fs.realpath(path.join(root, relative));
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    const folder = (await fs.stat(file)).isDirectory();
    if (folder) file = path.join(file, "index.html");
    const real = await fs.realpath(file);
    return real.startsWith(root + path.sep) && (await fs.stat(real)).isFile() ? { file: real, folder } : null;
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
  const found = await resolveInside(dir, relative);
  if (!found) return notFound(res);
  if (found.folder && !url.pathname.endsWith("/")) {
    // A map's folder without its slash: its index.html's relative links would resolve one level up.
    res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
    return;
  }
  const file = found.file;
  const name = path.basename(file);
  const cache = name.endsWith(".html") || !HASHED.test(name) ? "no-cache" : "public, max-age=31536000, immutable";
  const stat = await fs.stat(file);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const validators = { etag, "last-modified": stat.mtime.toUTCString(), "cache-control": cache };
  const since = req.headers["if-modified-since"];
  const unchanged = req.headers["if-none-match"]
    ? req.headers["if-none-match"].split(/\s*,\s*/).includes(etag)
    : since !== undefined && Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(since) / 1000);
  if (unchanged) {
    res.writeHead(304, validators).end();
    return;
  }
  const body = await fs.readFile(file);
  res.writeHead(200, {
    "content-type": TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream", "content-length": body.length,
    "x-content-type-options": "nosniff", ...validators,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}
