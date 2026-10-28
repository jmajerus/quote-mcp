import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleApi, handlePublishedApi } from "./api.js";
import { PUBLIC_API } from "./api-routes.js";
import type { DB } from "./db.js";
import { serveMap } from "./map.js";
import type { DrainStatus } from "./drain.js";
import type { Published } from "./published.js";
import type { ConceptSet } from "./sets.js";
import { isSitePath, renderSite } from "./site.js";
import { VERSION, createServer } from "./mcp.js";
import { ToolError, overview } from "./queries.js";
import { renderAdmin } from "./web.js";

/**
 * Streamable HTTP at /mcp (stateless: a fresh server per request, JSON responses), the admin pages at
 * /admin, a read-only JSON API at /api (src/api.ts), the concept map's static files at /map/ when
 * QUOTE_MAP_DIR is set (src/map.ts), a preview of the public site at / when QUOTE_PUBLIC is set
 * (src/site.ts, read from the public snapshot), and /health. Everything is read-only for now, so nothing
 * here needs an identity; Cloudflare Access guards the private hostname, and phase 2's writes will check
 * its token as corpus-mcp does.
 *
 * servePublic is a second listener, for a hostname with no Access in front of it, for those who don't
 * publish to a Worker. It serves the public snapshot and the map and nothing else: no store, so it can
 * show only what was published.
 */

export interface ServeOptions {
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
}


/** What tools/deploy.mjs last installed (branch, commit, when), written beside the store after the restart, so read per request. */
function readDeployed(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.QUOTE_DB ?? "data/quotes.db"), "deployed.json"), "utf8"));
  } catch {
    return null;
  }
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

export function serveHttp(db: DB, options: ServeOptions): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/health") {
        const { quotes, notes } = overview(db);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, quotes, notes, deployed: readDeployed(), ...(options.replica ? { replica: options.replica() } : {}) }));
        return;
      }
      if (await sitePage(options, req, res, url)) return;
      if (url.pathname === "/") {
        res.writeHead(302, { location: "/admin" }).end();
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
      const mcp = createServer(db, options.sets);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  const sets = options.sets?.length ? ` with ${options.sets.length} concept set${options.sets.length === 1 ? "" : "s"}` : "";
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

export async function serveStdio(db: DB, sets: ConceptSet[] = []): Promise<void> {
  await createServer(db, sets).connect(new StdioServerTransport());
}
