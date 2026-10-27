import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { DB } from "./db.js";
import { VERSION, createServer } from "./mcp.js";
import { ToolError, overview } from "./queries.js";
import { renderAdmin } from "./web.js";

/**
 * Streamable HTTP at /mcp (stateless: a fresh server per request, JSON responses), the admin pages at
 * /admin, and /health. Everything is read-only in phase 1, so nothing here needs an identity; Cloudflare
 * Access guards the public hostname, and phase 2's writes will check its token as corpus-mcp does.
 */

export interface ServeOptions { host: string; port: number }

export function serveHttp(db: DB, options: ServeOptions): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, quotes: overview(db).quotes }));
        return;
      }
      if (url.pathname === "/" ) {
        res.writeHead(302, { location: "/admin" }).end();
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
    console.error(`quote-mcp ${VERSION} listening on ${typeof a === "object" && a ? `${a.address}:${a.port}` : options.port} (/mcp, /admin)`);
    resolve(server);
  }));
}

export async function serveStdio(db: DB): Promise<void> {
  await createServer(db).connect(new StdioServerTransport());
}
