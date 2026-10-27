import type { DB } from "./db.js";

/**
 * Everything in the store as one JSON document: schemes, concepts and their relations, works, and quotes
 * with their tags, keyword-in-context marks, and origins (raw source HTML included). A backup a person
 * or another program can read without SQLite.
 */
export function exportAll(db: DB) {
  const json = (v: string | null) => (v ? JSON.parse(v) : null);
  const schemes = db.prepare("SELECT id, slug, label, description FROM schemes ORDER BY slug").all();
  const concepts = (db.prepare(`SELECT c.id, s.slug AS scheme, c.slug, c.label, c.alt_labels, c.definition, c.close_match, c.status, c.source
    FROM concepts c JOIN schemes s ON s.id = c.scheme_id ORDER BY s.slug, c.slug`).all() as Record<string, unknown>[])
    .map((c) => ({ ...c, alt_labels: json(c.alt_labels as string) }));
  const relations = db.prepare(`SELECT a.slug AS "from", b.slug AS "to", r.type FROM concept_relations r
    JOIN concepts a ON a.id = r.from_id JOIN concepts b ON b.id = r.to_id ORDER BY a.slug, b.slug`).all();
  const works = (db.prepare("SELECT * FROM works ORDER BY id").all() as Record<string, unknown>[])
    .map((w) => ({ ...w, authors: json(w.authors as string), candidates: json(w.candidates as string | null) }));
  const tags = db.prepare(`SELECT t.tag, c.slug AS concept, t.origin FROM quote_tags t LEFT JOIN concepts c ON c.id = t.concept_id WHERE t.quote_id = ? ORDER BY t.tag`);
  const kwic = db.prepare(`SELECT k.phrase, k.tag, c.slug AS concept FROM quote_kwic k LEFT JOIN concepts c ON c.id = k.concept_id WHERE k.quote_id = ?`);
  const origins = db.prepare("SELECT kind, ref, version, raw, imported_at FROM quote_origins WHERE quote_id = ? ORDER BY kind, ref");
  const quotes = (db.prepare("SELECT * FROM quotes ORDER BY id").all() as Record<string, unknown>[]).map((q) => ({
    ...q, flags: json(q.flags as string), suspects: json(q.suspects as string), edited: Boolean(q.edited),
    tags: tags.all(q.id), kwic: kwic.all(q.id), origins: origins.all(q.id),
  }));
  return { format: "quote-mcp-export/1", exported_at: new Date().toISOString(), schemes, concepts, relations, works, quotes };
}
