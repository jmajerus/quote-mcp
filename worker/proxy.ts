/**
 * The D1 proxy for the drain on the LXC (worker/wrangler.proxy.jsonc), as concept-clusters' d1-proxy:
 * it takes D1's REST API request shape at /query and answers in its response shape, through the
 * database's binding, so a batch costs one hop to Cloudflare rather than a round trip into its API.
 * src/d1-http.ts only changes its endpoint and token (QUOTE_D1_PROXY_URL and QUOTE_D1_PROXY_TOKEN).
 *
 * It runs any SQL it's given, so its bearer token is as powerful as a D1 edit token. Without
 * D1_PROXY_TOKEN set, every request is refused. It's a separate Worker from the public site's, which
 * never writes D1.
 */

type Statement = { sql: string; params?: unknown[] };
type Result = { success: boolean; results?: unknown[]; meta?: unknown };

interface Prepared {
  bind(...values: unknown[]): Prepared;
  all(): Promise<Result>;
}

interface Database {
  prepare(sql: string): Prepared;
  batch(statements: Prepared[]): Promise<Result[]>;
}

export interface ProxyEnv {
  DB: Database;
  D1_PROXY_TOKEN?: string;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const failure = (message: string, status: number) => json({ success: false, errors: [{ message }], result: [] }, status);

const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

async function authorized(request: Request, expected: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) return false;
  // Digests of equal length, so the comparison leaks nothing about the token's length.
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?(a: ArrayBuffer, b: ArrayBuffer): boolean };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(a, b);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const isStatement = (v: unknown): v is Statement =>
  !!v && typeof (v as Statement).sql === "string" && (v as Statement).sql.trim().length > 0 && ((v as Statement).params === undefined || Array.isArray((v as Statement).params));

const prepared = (db: Database, s: Statement) => (s.params?.length ? db.prepare(s.sql).bind(...s.params) : db.prepare(s.sql));

export async function handleProxy(request: Request, env: ProxyEnv): Promise<Response> {
  if (new URL(request.url).pathname !== "/query") return failure("Not found", 404);
  if (request.method !== "POST") return failure("Method not allowed", 405);
  if (!env.D1_PROXY_TOKEN) return failure("The D1 proxy's token isn't configured.", 503);
  if (!(await authorized(request, env.D1_PROXY_TOKEN))) return failure("Unauthorized", 401);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("The request body must be JSON.", 400);
  }
  const batch = body && typeof body === "object" ? (body as { batch?: unknown }).batch : undefined;
  const statements = Array.isArray(batch) ? batch : [body];
  if (!statements.length || !statements.every(isStatement)) return failure("Expected { sql, params? } or { batch: [{ sql, params? }] }.", 400);
  try {
    const results = Array.isArray(batch) ? await env.DB.batch(statements.map((s) => prepared(env.DB, s))) : [await prepared(env.DB, statements[0]).all()];
    return json({ success: true, errors: [], result: results.map((r) => ({ success: r.success, results: r.results ?? [], meta: r.meta ?? {} })) });
  } catch (error) {
    return failure((error as Error).message, 400);
  }
}

export default {
  fetch: (request: Request, env: ProxyEnv) => handleProxy(request, env),
};
