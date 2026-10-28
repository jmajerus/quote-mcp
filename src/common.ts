/**
 * Small pieces shared by the store's queries (src/queries.ts) and the public site's (src/published.ts),
 * with no Node dependencies, so the public site's code can run in a Worker.
 */

/** A request the caller can fix (no such quote, a search with no words): the message says what to do. */
export class ToolError extends Error {}

/** Old-site relation names, as people read them; "inverse" pairs are opposites (acceptance, rejection). */
export const RELATION_LABEL: Record<string, string> = { broader: "broader", narrower: "narrower", related: "related", inverse: "opposite" };

/** Words and "quoted phrases" as an FTS5 query: every term required, a trailing * kept as a prefix match. */
export function ftsQuery(text: string): string {
  const terms = text.match(/"[^"]+"|\S+/g) ?? [];
  return terms.map((t) => {
    const prefix = t.endsWith("*") && !t.startsWith('"');
    const bare = t.replace(/^"|"$/g, "").replace(/\*$/, "").replace(/"/g, "");
    return bare ? `"${bare}"${prefix ? "*" : ""}` : "";
  }).filter(Boolean).join(" ");
}
