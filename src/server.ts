import { handleCorpusQuotes } from "./corpus-api.js";
import { handleHoldingsCounts } from "./holdings.js";
import type { Capture } from "./mcp.js";
import { AccessError, authorizeRequest, requestAccessConfig, type RequestAccessConfig } from './http-access.js';
import type { JWTVerifyGetKey } from 'jose';
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleApi, handlePublishedApi } from "./api.js";
import { PUBLIC_API } from "./api-routes.js";
import type { DB } from "./db.js";
import { faviconBytes } from "./favicon.js";
import { serveMap } from "./map.js";
import type { DrainStatus } from "./drain.js";
import type { Published } from "./published.js";
import type { TermSyncStatus } from "./terminology.js";
import { type ConceptSet, currentSets } from "./sets.js";
import { isSitePath, renderSite } from "./site.js";
import { VERSION, createServer } from "./mcp.js";
import { ToolError, overview } from "./queries.js";
import { MAX_AUDIO, MAX_IMAGE, TranscribeError, captureKind, readCapture, transcribeAudio } from "./dictate.js";
import { renderAdmin, saveAdminEdit, saveCaptureForm } from "./web.js";

/**
 * Streamable HTTP at /mcp (stateless: a fresh server per request, JSON responses), the admin pages at
 * /admin, a read-only JSON API at /api (src/api.ts), the concept map's static files at /map/ when
 * QUOTE_MAP_DIR is set (src/map.ts), a preview of the public site at / when QUOTE_PUBLIC is set
 * (src/site.ts, read from the public snapshot), and /health. Proxied/public-host requests now require a verified Access JWT
 * for the MCP or admin audience; direct LAN access and the separate public snapshot listener remain available.
 *
 * servePublic is a second listener, for a hostname with no Access in front of it, for those who don't
 * publish to a Worker. It serves the public snapshot and the map and nothing else: no store, so it can
 * show only what was published.
 */

export interface ServeOptions {
  access?: RequestAccessConfig;
  accessKeys?: JWTVerifyGetKey;
  host: string;
  port: number;
  /** The concept map's built files, served at /map/; without it /map/ is 404. */
  mapDir?: string;
  /** The concept sets (src/sets.ts), for the API and the MCP tools. */
  sets?: ConceptSet[];
  /** The public snapshot, reread when it's rebuilt; without it (QUOTE_PUBLIC=none), / redirects to /admin. */
  snapshot?: () => Promise<Published | null>;
  /** The drain that keeps the snapshot's replica in D1 in step (src/drain.ts), for /health. */
  replica?: () => DrainStatus;
  /** The subscriber that follows terminology-mcp's human-work scheme (src/terminology.ts), for /health. */
  terms?: () => TermSyncStatus;
  /** add_quote's writer and corpus-mcp; without it the MCP server is read-only. */
  capture?: Capture;
}


/** What tools/deploy.mjs last installed (branch, commit, when), written beside the store after the restart, so read per request. */
function readDeployed(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.QUOTE_DB ?? "data/quotes.db"), "deployed.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Answers /favicon.png (and /favicon.ico, which some browsers ask for), or false for any other path. */
function favicon(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (url.pathname !== "/favicon.png" && url.pathname !== "/favicon.ico") return false;
  const body = faviconBytes();
  res.writeHead(200, { "content-type": "image/png", "content-length": body.length, "cache-control": "public, max-age=86400" }).end(req.method === "HEAD" ? undefined : body);
  return true;
}

const NO_SNAPSHOT = "There's no public snapshot yet. Build one with `quote-mcp publish --dry-run`; an import also builds it.";

/** Answers a site page from the snapshot, or false when the path isn't one. */
async function sitePage(options: ServeOptions, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!options.snapshot || !isSitePath(url.pathname)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return true;
  }
  const published = await options.snapshot();
  if (!published) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end(NO_SNAPSHOT);
    return true;
  }
  let html: string | null;
  try {
    html = await renderSite(published, url.pathname, url.searchParams);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    html = null;
  }
  if (html === null) res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  else res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", "x-content-type-options": "nosniff" }).end(req.method === "HEAD" ? undefined : html);
  return true;
}

function listen(server: http.Server, port: number, host: string, what: string): Promise<http.Server> {
  return new Promise((resolve) => server.listen(port, host, () => {
    const a = server.address();
    console.error(`quote-mcp ${VERSION} listening on ${typeof a === "object" && a ? `${a.address}:${a.port}` : port} (${what})`);
    resolve(server);
  }));
}

/** A form or recording posted from the admin pages, taken only from a page this server served. */
function postedFromHere(req: http.IncomingMessage): boolean {
  const from = req.headers.origin ?? req.headers.referer;
  try {
    return Boolean(from) && new URL(from!).host === req.headers.host;
  } catch {
    return false;
  }
}

/** The body, or null when it grows past the limit (the request is then closed). */
async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) {
        req.destroy();
        return null;
      }
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    if (size > limit) return null;
    throw error;
  }
  return Buffer.concat(chunks);
}

function sendHtml(res: http.ServerResponse, answer: { redirect: string } | { status: number; html: string } | null): void {
  if (!answer) res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  else if ("redirect" in answer) res.writeHead(303, { location: answer.redirect }).end();
  else res.writeHead(answer.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(answer.html);
}

/** A recording or a scanned page from the capture editor, read and returned as JSON. */
async function readPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const type = String(req.headers["content-type"] ?? "");
  const kind = captureKind(type);
  if (!kind) {
    res.writeHead(415, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "Send a recording or a page image." }));
    return;
  }
  const body = await readBody(req, kind === "page" ? MAX_IMAGE : MAX_AUDIO);
  if (!body) {
    const error = kind === "page" ? "That page image is too large. Photograph one page." : "That recording is too long. Speak one quote, then stop.";
    res.writeHead(413, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error }));
    return;
  }
  try {
    const read = await readCapture(body, type);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(read));
  } catch (error) {
    if (!(error instanceof TranscribeError)) throw error;
    res.writeHead(422, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify({ error: error.message }));
  }
}

/** A recording from the capture page, transcribed and returned as JSON. */
async function transcribePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const type = String(req.headers["content-type"] ?? "");
  if (!type.startsWith("audio/") && type !== "application/octet-stream") {
    res.writeHead(415, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "Send the recording as audio." }));
    return;
  }
  const body = await readBody(req, MAX_AUDIO);
  if (!body) {
    res.writeHead(413, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "That recording is too long. Speak one quote, then stop." }));
    return;
  }
  try {
    const text = await transcribeAudio(body, type);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify({ text }));
  } catch (error) {
    if (!(error instanceof TranscribeError)) throw error;
    res.writeHead(422, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify({ error: error.message }));
  }
}

/**
 * A form posted from the admin pages: the edit form, or the capture form and its recording. It's taken only from a
 * page this server served (Origin, or failing that Referer, naming this host), so another site can't post it with
 * the person's Access session. Writes go through the writable connection; the redirect's GET then reads them
 * through the read-only one.
 */
async function adminPost(req: http.IncomingMessage, res: http.ServerResponse, path: string, capture: Capture | undefined, editor: string): Promise<void> {
  if (!postedFromHere(req)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Forms are taken only from this server's own pages.");
    return;
  }
  if (!capture) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("Editing isn't set up on this server.");
    return;
  }
  if (path === "/admin/capture/transcribe") {
    await transcribePost(req, res);
    return;
  }
  if (path === "/admin/capture/read") {
    await readPost(req, res);
    return;
  }
  const body = await readBody(req, 64 * 1024);
  if (!body) {
    res.writeHead(413, { "content-type": "text/plain; charset=utf-8" }).end("The form is too large.");
    return;
  }
  const form = new URLSearchParams(body.toString("utf8"));
  if (path === "/admin/capture") {
    sendHtml(res, await saveCaptureForm(capture.writer(), form, editor, { corpus: capture.corpus, primary: capture.primary, refreshZotero: capture.refreshZotero }));
    return;
  }
  sendHtml(res, saveAdminEdit(capture.writer(), path, form, editor));
}

export function serveHttp(db: DB, options: ServeOptions): Promise<http.Server> {
  const access = options.access ?? requestAccessConfig(process.env, ["quote-mcp", "quote-mcp.localdomain"]);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const auth = await authorizeRequest(req, url.pathname, access, options.accessKeys);
      const via = auth.via;
      if (url.pathname === "/health") {
        const { quotes, notes } = overview(db);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, quotes, notes, deployed: readDeployed(), ...(options.replica ? { replica: options.replica() } : {}), ...(options.terms ? { terms: options.terms() } : {}) }));
        return;
      }
      if (favicon(req, res, url)) return;
      if (await sitePage(options, req, res, url)) return;
      if (url.pathname === "/") {
        res.writeHead(302, { location: "/admin" }).end();
        return;
      }
      if (url.pathname === "/api/holdings/counts") {
        // A feed for holdings-mcp on the LAN, not for a browser behind Access.
        if (via !== "lan") res.writeHead(404, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "Not found." }));
        else handleHoldingsCounts(db, req, res, process.env.QUOTE_ZOTERO_LIBRARY || undefined);
        return;
      }
      if (url.pathname === "/api/corpus/quotes") {
        // For corpus-mcp's reader on the LAN, not for a browser behind Access.
        if (via !== "lan") res.writeHead(404, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "Not found." }));
        else await handleCorpusQuotes(db, options.capture, req, res, url);
        return;
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        await handleApi(db, req, res, url, options.sets);
        return;
      }
      if (url.pathname === "/map" || url.pathname.startsWith("/map/")) {
        await serveMap(options.mapDir, req, res, url);
        return;
      }
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        if (req.method === "POST" && (url.pathname === "/admin/capture" || url.pathname === "/admin/capture/transcribe" || url.pathname === "/admin/capture/read" || /^\/admin\/quotes\/\d+\/edit$/.test(url.pathname))) {
          await adminPost(req, res, url.pathname, options.capture, auth.via === "access" ? (auth.email ?? auth.subject ?? "access") : "lan");
          return;
        }
        if (req.method !== "GET") {
          res.writeHead(405, { allow: "GET" }).end();
          return;
        }
        let html: string | null;
        try {
          html = renderAdmin(db, url.pathname, url.searchParams);
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(error.message);
          return;
        }
        if (html === null) res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        else res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      if (req.method !== "POST") {
        // Stateless: no server-initiated stream (GET) and no sessions to end (DELETE).
        res.writeHead(405, { allow: "POST, OPTIONS", "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null,
        }));
        return;
      }
      const mcp = createServer(db, options.sets, options.capture);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (error instanceof AccessError) {
        if (!res.headersSent) res.writeHead(error.status, {"content-type":"application/json", "cache-control":"no-store"}).end(JSON.stringify({error:error.message}));
        return;
      }
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  const setCount = currentSets(db, options.sets).length;
  const sets = setCount ? ` with ${setCount} concept set${setCount === 1 ? "" : "s"}` : "";
  const site = options.snapshot ? ", the public site's preview at /" : "";
  return listen(server, options.port, options.host, `/mcp, /admin, /api${sets}${options.mapDir ? `, /map/ from ${options.mapDir}` : ""}${site}`);
}

/** The public listener: the public site and the map's API from the snapshot, and the map; 404 for everything else. */
export function servePublic(options: ServeOptions): Promise<http.Server> {
  const { snapshot } = options;
  if (!snapshot) throw new Error("A public port needs QUOTE_PUBLIC (catalogue or quotes).");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (favicon(req, res, url)) return;
      if (await sitePage(options, req, res, url)) return;
      if (PUBLIC_API.test(url.pathname)) {
        const published = await snapshot();
        if (published) await handlePublishedApi(published, req, res, url);
        else res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: NO_SNAPSHOT }));
        return;
      }
      if (url.pathname === "/map" || url.pathname.startsWith("/map/")) {
        await serveMap(options.mapDir, req, res, url);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  return listen(server, options.port, options.host, `public, from the snapshot: /${options.mapDir ? ", /map/" : ""}, /api/graph, /api/concepts, /api/sets`);
}

export async function serveStdio(db: DB, sets: ConceptSet[] = [], capture?: Capture): Promise<void> {
  await createServer(db, sets, capture).connect(new StdioServerTransport());
}
