/**
 * Small pieces shared by the store's queries (src/queries.ts) and the public site's (src/published.ts),
 * with no Node dependencies, so the public site's code can run in a Worker.
 */

/** A request the caller can fix (no such quote, a search with no words): the message says what to do. */
/** An error to show the caller. `data` carries what an API answer needs besides the message (a code, closest passages). */
export class ToolError extends Error {
  constructor(message: string, readonly data?: Record<string, unknown>) {
    super(message);
  }
}

/** Old-site relation names, as people read them; "inverse" pairs are opposites (acceptance, rejection). */
export const RELATION_LABEL: Record<string, string> = { broader: "broader", narrower: "narrower", related: "related", inverse: "opposite" };

/** Relations a concept search can follow. Narrower and broader run the whole chain; related and opposite are one step. */
export const SEARCH_RELATIONS = ["narrower", "broader", "related", "opposite"] as const;
export type SearchRelation = (typeof SEARCH_RELATIONS)[number];

export const RELATION_TYPE: Record<SearchRelation, string> = { narrower: "narrower", broader: "broader", related: "related", opposite: "inverse" };

/** What a concept search keeps. No value means the concept named; `none` means nothing checked. */
export function includeChoice(values: string[] | null): { exact: boolean; include: SearchRelation[] } {
  if (!values) return { exact: true, include: [] };
  const asked = new Set(values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v && v !== "none"));
  return { exact: asked.has("exact"), include: SEARCH_RELATIONS.filter((kind) => asked.has(kind)) };
}

/** One `include` query value for the choices. */
export function includeValue(exact: boolean, include: readonly SearchRelation[]): string {
  return [...(exact ? ["exact" as const] : []), ...include].join(",") || "none";
}

/** The concept when `exact` is set, plus those reached by following each named relation from it. */
export function relatedIds(id: number, edges: { from: number; to: number; type: string }[], include: readonly SearchRelation[], exact = true): number[] {
  const next = new Map<string, Map<number, number[]>>();
  for (const edge of edges) {
    const byFrom = next.get(edge.type) ?? new Map<number, number[]>();
    const list = byFrom.get(edge.from) ?? [];
    list.push(edge.to);
    byFrom.set(edge.from, list);
    next.set(edge.type, byFrom);
  }
  const seen = new Set<number>();
  if (exact) seen.add(id);
  for (const kind of include) {
    const deep = kind === "narrower" || kind === "broader";
    const walked = new Set<number>();
    const queue = [id];
    const step = next.get(RELATION_TYPE[kind]);
    while (queue.length) {
      const current = queue.pop()!;
      if (walked.has(current)) continue;
      walked.add(current);
      for (const to of step?.get(current) ?? []) {
        if (exact || to !== id) seen.add(to);
        if (deep) queue.push(to);
      }
    }
  }
  return [...seen];
}

/** Words and "quoted phrases" as an FTS5 query: every term required, a trailing * kept as a prefix match. */
export function ftsQuery(text: string): string {
  const terms = text.match(/"[^"]+"|\S+/g) ?? [];
  return terms.map((t) => {
    const prefix = t.endsWith("*") && !t.startsWith('"');
    const bare = t.replace(/^"|"$/g, "").replace(/\*$/, "").replace(/"/g, "");
    return bare ? `"${bare}"${prefix ? "*" : ""}` : "";
  }).filter(Boolean).join(" ");
}
