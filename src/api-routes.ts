import { ToolError } from "./common.js";
import { NotPublic, type Published } from "./published.js";

/**
 * The JSON API's routes, answered from any source (the store on the LAN, the snapshot for the public
 * site) and returned as a status and body, so the Node server (src/api.ts) and the Worker share them. No
 * Node modules. The routes and fields are a contract with the maps; see src/api.ts.
 */

export class BadRequest extends Error {}

/** What each route returns, now or as a promise. */
export interface Routes {
  graph(): unknown;
  sets(): unknown;
  set(slug: string): unknown;
  concept(slug: string): unknown;
  quotes(slug: string, narrower: boolean, limit: number | undefined, offset: number | undefined): unknown;
}

export interface ApiAnswer { status: number; body: unknown; headers: Record<string, string> }

function integer(params: URLSearchParams, name: string): number | undefined {
  const value = params.get(name);
  if (value === null || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw new BadRequest(`${name} must be a whole number.`);
  return Number(value);
}

function slugOf(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new BadRequest("The name in the path isn't valid.");
  }
}

/** The answer to an /api request. */
export async function answerApi(routes: Routes, method: string, url: URL): Promise<ApiAnswer> {
  const ok = (body: unknown): ApiAnswer => ({ status: 200, body, headers: {} });
  if (method !== "GET") return { status: 405, body: { error: "Method not allowed: the API is read-only." }, headers: { allow: "GET" } };
  try {
    if (url.pathname === "/api/graph") return ok(await routes.graph());
    if (url.pathname === "/api/sets") return ok({ sets: await routes.sets() });
    const set = /^\/api\/sets\/([^/]+)$/.exec(url.pathname);
    if (set) return ok(await routes.set(slugOf(set[1])));
    const m = /^\/api\/concepts\/([^/]+)(\/quotes)?$/.exec(url.pathname);
    if (!m) return { status: 404, body: { error: "Not found." }, headers: {} };
    const p = url.searchParams;
    return ok(await (m[2] ? routes.quotes(slugOf(m[1]), p.get("narrower") !== "false", integer(p, "limit"), integer(p, "offset")) : routes.concept(slugOf(m[1]))));
  } catch (error) {
    if (error instanceof ToolError) return { status: 404, body: { error: error.message }, headers: {} };
    if (error instanceof BadRequest) return { status: 400, body: { error: error.message }, headers: {} };
    if (error instanceof NotPublic) return { status: 403, body: { error: error.message }, headers: {} };
    throw error;
  }
}

/** The routes answered from the public snapshot: counts of public records, and quotes as public records. */
export function publishedRoutes(p: Published): Routes {
  return {
    graph: () => p.graph(),
    sets: () => p.sets(),
    set: async (slug) => (await p.set(slug)).set,
    concept: async (slug) => (await p.concept(slug)).concept,
    quotes: async (slug, narrower, limit, offset) => {
      const concept = await p.findConcept(slug);
      return { concept, ...(await p.quotes({ conceptIds: narrower ? await p.withNarrower(concept.id) : [concept.id], limit, offset })) };
    },
  };
}

/** The public API routes, for a listener that serves only the public site. */
export const PUBLIC_API = /^\/api\/(graph|sets|sets\/[^/]+|concepts\/[^/]+(\/quotes)?)$/;
