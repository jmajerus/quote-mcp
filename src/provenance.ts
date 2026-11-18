import type { DB } from "./db.js";

/**
 * A quote's provenance stamp: one per quote, written when it's saved and never changed, since a quote doesn't
 * evolve the way a Concept Clusters puzzle does (its words are the book's; later changes to tags, comment, or
 * locator are in its history). The stamp is assembled by the server, never reported by the caller.
 *
 * The fact that matters most is `generative`: a quote saved through quote-mcp's MCP tools was saved by an agent,
 * since a person doesn't hand-call add_quote, whether or not the client could be named. A quote typed or spoken
 * on the capture page was saved by a person. Where nothing says which (a Zotero note, which an agent could also
 * have written through Zotero's API), it's null rather than a guess.
 *
 *   channel    how it arrived: mcp (add_quote), capture (the admin capture page), corpus-mcp (one of corpus-mcp's
 *              own quotes, taken over), zotero (a Zotero note), drupal (the old site), or unknown
 *   by         the signed-in person behind the request (Cloudflare Access), "lan", or the importer's name
 *   client     for mcp, what the call presented (client name and version, user agent): observed, not attested,
 *              and through the Authoring Portal possibly the portal's own
 *   inferred   true on a stamp worked out later from the quote's origin, for a quote saved before stamps
 *   detail     reserved for fuller provenance, shaped like Concept Clusters' provenance object
 *              ({ collaboration, contributors: [{ name, model?, reasoning? }] }); null until something fills it
 */
export interface Provenance {
  v: 1;
  generative: boolean | null;
  channel: Channel;
  at: string;
  by: string | null;
  client?: ClientSeen;
  inferred?: true;
  detail: ProvenanceDetail | null;
}

export type Channel = "mcp" | "capture" | "corpus-mcp" | "zotero" | "drupal" | "unknown";

/** What an MCP call presented about its client. Any of it may be missing. */
export interface ClientSeen { name?: string; version?: string; user_agent?: string }

/** Reserved: who contributed, as Concept Clusters records it. Nothing writes it yet. */
export interface ProvenanceDetail {
  collaboration?: string;
  contributors?: { name: string; model?: string; reasoning?: string }[];
}

/** How a quote's number is shown: G before it when a generative agent saved it (G874), # otherwise. */
export function quoteLabel(id: number, generative: boolean | null | undefined): string {
  return `${generative ? "G" : "#"}${id}`;
}

/** A stamp for a quote being saved now. */
export function stamp(channel: Channel, generative: boolean | null, at: string, by: string | null, client?: ClientSeen): Provenance {
  const seen = client && Object.values(client).some(Boolean) ? { client } : {};
  return { v: 1, generative, channel, at, by, ...seen, detail: null };
}

/** corpus-mcp recorded whether each of its quotes was saved by an agent or on its admin page. */
export function corpusGenerative(source: Record<string, unknown> | undefined): boolean | null {
  return source?.source === "agent" ? true : source?.source === "admin" ? false : null;
}

/** A stored stamp, or null for a quote that has none (or one this build can't read). */
export function readProvenance(value: unknown): Provenance | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const p = JSON.parse(value) as Provenance;
    return p && p.v === 1 ? p : null;
  } catch {
    return null;
  }
}

/** The stamp in a few words, for the admin pages. */
export function describeProvenance(p: Provenance | null): string {
  if (!p) return "Not recorded";
  const who = p.generative === true ? "Saved by a generative agent" : p.generative === false ? "Saved by a person" : "Not known whether a person or an agent saved it";
  const how: Record<Channel, string> = {
    mcp: "through quote-mcp's MCP tools", capture: "on the capture page", "corpus-mcp": "in corpus-mcp, then taken over",
    zotero: "from a Zotero note", drupal: "from the old site", unknown: "from an unrecorded source",
  };
  const client = p.client ? [p.client.name && `${p.client.name}${p.client.version ? ` ${p.client.version}` : ""}`, p.client.user_agent && `user agent ${p.client.user_agent}`].filter(Boolean).join(", ") : "";
  return `${who} ${how[p.channel]}${client ? ` (client: ${client})` : ""}${p.by ? ` · ${p.by}` : ""} · ${p.at.slice(0, 16).replace("T", " ")}${p.inferred ? " · inferred from its origin" : ""}`;
}

/**
 * Stamps each quote saved before stamps, from its origin. Not from its number: a person's quote captured or
 * imported after agents began saving them has a higher number than theirs. From its origin: the old site's when it has one (it predates agents), else
 * the earliest that says how it arrived (a split passage also has the origins of the quote it came from). Marked inferred. Returns how many were stamped.
 */
export function backfillProvenance(db: DB): number {
  const rows = db.prepare(`SELECT q.id, q.created_at, q.created_by,
      (SELECT json_object('kind', o.kind, 'source', CASE WHEN o.kind = 'corpus' AND json_valid(o.raw) THEN json_extract(o.raw, '$.source.source') END) FROM quote_origins o
        WHERE o.quote_id = q.id AND o.kind != 'split' ORDER BY o.kind LIKE 'drupal%' DESC, o.imported_at, o.kind LIMIT 1) AS origin
    FROM quotes q WHERE q.provenance IS NULL`).all() as { id: number; created_at: string; created_by: string | null; origin: string | null }[];
  const set = db.prepare("UPDATE quotes SET provenance = ? WHERE id = ?");
  db.transaction(() => {
    for (const r of rows) {
      const o = r.origin ? (JSON.parse(r.origin) as { kind: string; source: string | null }) : null;
      const [channel, generative]: [Channel, boolean | null] =
        o?.kind === "agent" ? ["mcp", true]
        : o?.kind === "capture" ? ["capture", false]
        : o?.kind === "corpus" ? ["corpus-mcp", corpusGenerative({ source: o.source })]
        : o?.kind === "zotero-note" ? ["zotero", null]
        : o?.kind.startsWith("drupal") ? ["drupal", false]
        : ["unknown", null];
      set.run(JSON.stringify({ ...stamp(channel, generative, r.created_at, r.created_by), inferred: true }), r.id);
    }
  })();
  return rows.length;
}
