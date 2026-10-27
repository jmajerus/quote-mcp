import mysql from "mysql2/promise";

/**
 * Reads the old workcreatively.org Drupal site from its database dump, read-only: Biblio works with
 * their notes (each note holds one or more quote spans), authors, and keywords; the concept vocabulary
 * with its SKOS relations; and the Quotes module's standalone quotes.
 */

export interface DrupalWork {
  nid: number;
  title: string;
  type: string;
  year: string | null;
  isbn: string | null;
  url: string | null;
  citekey: string | null;
  notes: string;
  authors: string[];
  keywords: string[];
}

export interface DrupalConcept {
  kid: number;
  word: string;
  altLabels: string[];
  definition: string | null;
  /** A WordNet synset URL. */
  closeMatch: string | null;
}

/** rtype as Biblio's SKOS extension stored it: B broader, N narrower, R related, I inverse. */
export interface DrupalRelation { from: string; to: string; type: "B" | "N" | "R" | "I" }

export interface DrupalQuote { nid: number; title: string; body: string; author: string | null; citation: string | null }

export interface DrupalSite {
  works: DrupalWork[];
  concepts: DrupalConcept[];
  relations: DrupalRelation[];
  quotes: DrupalQuote[];
}

export function drupalUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.QUOTE_DRUPAL_URL;
  if (!url) throw new Error("Set QUOTE_DRUPAL_URL, e.g. mysql://user:password@mariadb.localdomain/jmajerus_drp1 (see .env.example).");
  return url;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function loadDrupal(url: string): Promise<DrupalSite> {
  const db = await mysql.createConnection({ uri: url, charset: "utf8mb4" });
  try {
    const q = async <T>(sql: string) => (await db.query(sql))[0] as T[];
    const works = await q<Record<string, unknown>>(`
      SELECT n.nid, n.title, t.name AS type, b.biblio_year, b.biblio_isbn, b.biblio_url, b.biblio_citekey, b.biblio_notes
      FROM node n JOIN biblio b ON b.vid = n.vid LEFT JOIN biblio_types t ON t.tid = b.biblio_type
      WHERE n.type = 'biblio' ORDER BY n.nid`);
    const authors = await q<{ nid: number; name: string }>(`
      SELECT c.nid, COALESCE(NULLIF(TRIM(CONCAT_WS(', ', NULLIF(d.lastname, ''), NULLIF(d.firstname, ''))), ''), d.name) AS name
      FROM biblio_contributor c JOIN biblio_contributor_data d ON d.cid = c.cid JOIN node n ON n.vid = c.vid
      WHERE c.auth_type = 1 ORDER BY c.nid, c.rank`);
    const keywords = await q<{ nid: number; word: string }>(`
      SELECT k.nid, d.word FROM biblio_keyword k JOIN biblio_keyword_data d ON d.kid = k.kid ORDER BY k.nid, d.word`);
    const concepts = await q<Record<string, unknown>>(`SELECT kid, word, altlabel, definition, closeMatch FROM biblio_keyword_data ORDER BY word`);
    const relations = await q<DrupalRelation>(`
      SELECT a.word AS \`from\`, b.word AS \`to\`, s.rtype AS type
      FROM biblio_keyword_skos s JOIN biblio_keyword_data a ON a.kid = s.kid JOIN biblio_keyword_data b ON b.kid = s.related`);
    const quotes = await q<Record<string, unknown>>(`
      SELECT q.nid, r.title, r.body, a.name AS author, q.citation
      FROM quotes q JOIN node_revisions r ON r.vid = q.vid LEFT JOIN quotes_authors a ON a.aid = q.aid ORDER BY q.nid`);

    const byNid = <T extends { nid: number }>(rows: T[], pick: (r: T) => string) => {
      const m = new Map<number, string[]>();
      for (const r of rows) m.set(r.nid, [...(m.get(r.nid) ?? []), pick(r)]);
      return m;
    };
    const authorsOf = byNid(authors, (r) => r.name);
    const keywordsOf = byNid(keywords, (r) => r.word);
    return {
      works: works.map((w) => ({
        nid: Number(w.nid), title: String(w.title), type: text(w.type) ?? "Unknown", year: text(w.biblio_year), isbn: text(w.biblio_isbn),
        url: text(w.biblio_url), citekey: text(w.biblio_citekey), notes: String(w.biblio_notes ?? ""),
        authors: authorsOf.get(Number(w.nid)) ?? [], keywords: keywordsOf.get(Number(w.nid)) ?? [],
      })),
      concepts: concepts.map((c) => ({
        kid: Number(c.kid), word: String(c.word),
        altLabels: (text(c.altlabel) ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        definition: text(c.definition), closeMatch: text(c.closeMatch),
      })),
      relations,
      quotes: quotes.map((r) => ({ nid: Number(r.nid), title: String(r.title), body: String(r.body ?? ""), author: text(r.author), citation: text(r.citation) })),
    };
  } finally {
    await db.end();
  }
}
