import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleApi } from "./api.js";
import type { DB } from "./db.js";
import { serveMap } from "./map.js";
import { VERSION, createServer } from "./mcp.js";
import { ToolError, overview } from "./queries.js";
import { renderAdmin } from "./web.js";

/**
 * Streamable HTTP at /mcp (stateless: a fresh server per request, JSON responses), the admin pages at
 * /admin, a read-only JSON API at /api (src/api.ts), the concept map's static files at /map/ when
 * QUOTE_MAP_DIR is set (src/map.ts), and /health. Everything is read-only for now, so nothing here needs
 * an identity; Cloudflare Access guards the public hostname, and phase 2's writes will check its token
 * as corpus-mcp does.
 */

export interface ServeOptions {
  host: string;
  port: number;
  /** The concept map's built files, served at /map/; without it /map/ is 404. */
  mapDir?: string;
}

/** What tools/deploy.mjs last installed (branch, commit, when), written beside the store after the restart, so read per request. */
function readDeployed(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.QUOTE_DB ?? "data/quotes.db"), "deployed.json"), "utf8"));
  } catch {
    return null;
  }
}

export function serveHttp(db: DB, options: ServeOptions): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/health") {
        const { quotes, notes } = overview(db);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, quotes, notes, deployed: readDeployed() }));
        return;
      }
      if (url.pathname === "/" ) {
        res.writeHead(302, { location: "/admin" }).end();
        return;
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        handleApi(db, req, res, url);
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
      const mcp = createServer(db);
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
  return new Promise((resolve) => server.listen(options.port, options.host, () => {
    const a = server.address();
    console.error(`quote-mcp ${VERSION} listening on ${typeof a === "object" && a ? `${a.address}:${a.port}` : options.port} (/mcp, /admin, /api${options.mapDir ? `, /map/ from ${options.mapDir}` : ""})`);
    resolve(server);
  }));
}

export async function serveStdio(db: DB): Promise<void> {
  await createServer(db).connect(new StdioServerTransport());
}
