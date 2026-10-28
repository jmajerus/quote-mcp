import type { Statement } from "./replica.js";

/**
 * D1 over HTTP, for the drain on the LXC: either Cloudflare's REST API (/query on the database) or a
 * d1-proxy Worker (worker/proxy.ts), which speaks the same request and response shapes through its D1
 * binding, one hop instead of a round trip into the API. As concept-clusters' httpD1Database.
 *
 * A batch runs as one transaction. Every statement the drain sends is idempotent (an upsert or a delete
 * by key), so a request whose outcome is unknown (no response, a dropped connection) is simply sent
 * again on the next tick.
 */

export interface D1Config {
  /** The REST API: the account, the database, and an API token with D1 edit. */
  accountId?: string;
  databaseId?: string;
  /** Or the proxy's /query URL. */
  endpoint?: string;
  token: string;
  apiBase?: string;
}

export interface D1Http {
  batch(statements: Statement[]): Promise<unknown[]>;
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

export class D1HttpError extends Error {}

/**
 * The D1 settings in the environment: QUOTE_D1_PROXY_URL and QUOTE_D1_PROXY_TOKEN, or
 * CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and QUOTE_D1_DATABASE_ID. Null when neither is set, and
 * an error naming what's missing when one is set only in part.
 */
export function d1ConfigFrom(env: NodeJS.ProcessEnv): D1Config | null {
  const v = (name: string) => env[name]?.trim() || undefined;
  const endpoint = v("QUOTE_D1_PROXY_URL");
  if (endpoint) {
    const token = v("QUOTE_D1_PROXY_TOKEN");
    if (!token) throw new D1HttpError("QUOTE_D1_PROXY_URL is set but QUOTE_D1_PROXY_TOKEN isn't.");
    return { endpoint: endpoint.endsWith("/query") ? endpoint : `${endpoint.replace(/\/+$/, "")}/query`, token };
  }
  const accountId = v("CLOUDFLARE_ACCOUNT_ID"), token = v("CLOUDFLARE_API_TOKEN"), databaseId = v("QUOTE_D1_DATABASE_ID");
  if (!accountId && !token && !databaseId) return null;
  const missing = [["CLOUDFLARE_ACCOUNT_ID", accountId], ["CLOUDFLARE_API_TOKEN", token], ["QUOTE_D1_DATABASE_ID", databaseId]].filter(([, x]) => !x).map(([n]) => n);
  if (missing.length) throw new D1HttpError(`D1 needs ${missing.join(" and ")} as well.`);
  return { accountId, databaseId, token: token!, apiBase: v("CLOUDFLARE_API_BASE") };
}

export function d1Http(config: D1Config, fetchImpl: typeof fetch = globalThis.fetch): D1Http {
  const endpoint = config.endpoint
    ?? `${(config.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "")}/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;

  async function send(body: unknown): Promise<{ success?: boolean; results?: Record<string, unknown>[] }[]> {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (error) {
      throw new D1HttpError(`D1 request failed: ${(error as Error).message}`);
    }
    const text = await response.text().catch((error: Error) => { throw new D1HttpError(`D1 request failed: ${error.message}`); });
    let payload: { success?: boolean; errors?: { message?: string }[]; result?: { success?: boolean; results?: Record<string, unknown>[] }[] };
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new D1HttpError(`D1 HTTP ${response.status}: the response wasn't JSON.`);
    }
    const errors = (payload.errors ?? []).map((e) => e?.message).filter(Boolean).join("; ");
    if (!response.ok || payload.success === false) throw new D1HttpError(errors || `D1 HTTP ${response.status}`);
    const results = Array.isArray(payload.result) ? payload.result : [];
    if (results.some((r) => r?.success === false)) throw new D1HttpError(errors || "A D1 statement failed.");
    return results;
  }

  return {
    batch: (statements) => send({ batch: statements.map((s) => ({ sql: s.sql, ...(s.params.length ? { params: s.params } : {}) })) }),
    query: async (sql, params = []) => (await send({ sql, ...(params.length ? { params } : {}) }))[0]?.results ?? [],
  };
}
