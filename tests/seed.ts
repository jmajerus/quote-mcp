import { parse } from "node-html-parser";
import { type DB, NEXT_QUOTE_ID, now } from "../src/db.js";
import { type ImportOptions, type ImportStats, SCHEME, runImport, workMatcher } from "../src/import.js";
import { parseNote, quoteSpans } from "../src/parse.js";
import { quoteKey, slugify } from "../src/text.js";

/**
 * Stores for the tests, holding what the old site's one-time import left: its concepts, works, and quotes, with their
 * `drupal` and `drupal-quote` origins. That import is gone from the code, and real stores still hold its records.
 */

export interface DrupalWork { nid: number; title: string; type: string; year: string | null; isbn: string | null; url: string | null; citekey: string | null; notes: string; authors: string[]; keywords: string[] }
export interface DrupalSite {
  works: DrupalWork[];
  concepts: { kid: number; word: string; altLabels: string[]; definition: string | null; closeMatch: string | null }[];
  relations: { from: string; to: string; type: "B" | "N" | "R" | "I" }[];
  quotes: { nid: number; title: string; body: string; author: string | null; citation: string | null }[];
}

const RELATION = { B: "broader", N: "narrower", R: "related", I: "inverse" } as const;

function seedOldSite(db: DB, site: DrupalSite, primary: string): void {
  const stamp = now();
  db.prepare("INSERT OR IGNORE INTO schemes (slug, label, description, created_at) VALUES (?, ?, ?, ?)").run(SCHEME.slug, SCHEME.label, SCHEME.description, stamp);
  const schemeId = db.prepare("SELECT id FROM schemes WHERE slug = ?").pluck().get(SCHEME.slug) as number;
  const addConcept = db.prepare(`INSERT OR IGNORE INTO concepts (scheme_id, slug, label, alt_labels, definition, close_match, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  if (!db.prepare("SELECT 1 FROM concepts WHERE scheme_id = ? AND term_id IS NOT NULL LIMIT 1").get(schemeId)) {
    for (const c of site.concepts) addConcept.run(schemeId, slugify(c.word), c.word, JSON.stringify(c.altLabels), c.definition, c.closeMatch, `drupal:kid:${c.kid}`, stamp, stamp);
    const idOf = db.prepare("SELECT id FROM concepts WHERE scheme_id = ? AND slug = ?").pluck();
    for (const r of site.relations) {
      const [from, to] = [idOf.get(schemeId, slugify(r.from)), idOf.get(schemeId, slugify(r.to))];
      if (from && to) db.prepare("INSERT OR IGNORE INTO concept_relations (from_id, to_id, type) VALUES (?, ?, ?)").run(from, to, RELATION[r.type]);
    }
  }
  const concepts = db.prepare("SELECT id, slug, label, alt_labels FROM concepts WHERE status != 'retired'").all() as { id: number; slug: string; label: string; alt_labels: string }[];
  const conceptOf = (tag: string) => {
    const t = tag.toLowerCase();
    return concepts.find((c) => c.label.toLowerCase() === t || (JSON.parse(c.alt_labels) as string[]).some((a) => a.toLowerCase() === t) || c.slug === t)?.id ?? null;
  };
  const { candidates, zoteroWork, setOrigin, workByOrigin } = workMatcher(db, primary, stamp);
  const addQuote = (kind: string, ref: string, raw: string, html: string, tags: string[], workId: number | null, attribution: string | null, outside = "") => {
    if (db.prepare("SELECT 1 FROM quote_origins WHERE kind = ? AND ref = ?").get(kind, ref)) return;
    const p = parseNote(html, tags);
    if (p.kind !== "quote") return;
    if (outside) p.commentary = [p.commentary, outside].filter(Boolean).join("\n\n");
    const { id } = db.prepare(`INSERT INTO quotes (id, kind, work_id, text, text_key, locator_kind, locator, chapter_author, comment, attribution, source_url, status, grade, flags, created_at, created_by, updated_at, updated_by)
      VALUES (${NEXT_QUOTE_ID}, 'quote', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, 'import') RETURNING id`).get(workId, p.text ?? "", quoteKey(p.text), p.locator?.kind ?? "none", p.locator?.value ?? null,
      p.chapterAuthor ?? null, p.commentary ?? null, attribution, p.sourceUrl ?? null, p.grade === "C" ? "unparsed" : "transcribed", p.grade ?? null, JSON.stringify(p.flags), stamp, stamp) as { id: number };
    db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES (?, ?, ?, NULL, ?, ?)").run(kind, ref, id, raw, stamp);
    db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'imported', NULL, ?, 'import', ?)").run(id, stamp, raw, `from ${kind} ${ref}`);
    for (const tag of tags) db.prepare("INSERT OR IGNORE INTO quote_tags (quote_id, tag, concept_id, origin) VALUES (?, ?, ?, 'span')").run(id, tag, conceptOf(tag));
    for (const k of p.kwic) db.prepare("INSERT OR IGNORE INTO quote_kwic (quote_id, phrase, tag, concept_id) VALUES (?, ?, ?, ?)").run(id, k.phrase, k.concept, conceptOf(k.concept));
  };
  for (const w of site.works) {
    const root = parse(w.notes);
    const spans = quoteSpans(root);
    if (!spans.length) continue;
    const quotes = spans.map((s) => s.toString());
    const titles = spans.map((s) => s.getAttribute("title") ?? "");
    for (const s of spans) s.remove();
    // Text outside the spans went on the first quote's comment.
    const outside = root.text.trim();
    const known = workByOrigin.get("drupal", String(w.nid)) as { work_id: number } | undefined;
    let workId = known?.work_id;
    if (workId === undefined) {
      const hits = candidates(w.title, w.year, w.authors);
      workId = hits.length === 1 ? zoteroWork(primary, hits[0].key, hits[0].data) : (db.prepare(`INSERT INTO works (title, authors, year, item_type, isbn, url, match, candidates, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(w.title, JSON.stringify(w.authors), w.year, w.type, w.isbn, w.url, hits.length ? "ambiguous" : "unmatched", hits.length ? JSON.stringify(hits.map((h) => h.key)) : null, stamp, stamp) as { id: number }).id;
      setOrigin.run("drupal", String(w.nid), workId);
    }
    for (const [i, html] of quotes.entries()) {
      const tags = titles[i].split(",").map((t) => t.trim()).filter(Boolean);
      const extra = i === 0 ? outside : "";
      addQuote("drupal", `${w.nid}#${i + 1}`, extra ? `${html}\n${extra}` : html, html, tags, workId, null, extra);
    }
  }
  for (const q of site.quotes) addQuote("drupal-quote", String(q.nid), q.body, `<p><span class="quote">${q.body}</span></p>`, [], null, [q.author, q.citation].filter(Boolean).join(", ") || null);
}

/** The store as it would be with the old site's records in it, then a real import of the Zotero notes. */
export function importWithSite(db: DB, { drupal, ...opts }: ImportOptions & { drupal?: DrupalSite }): ImportStats {
  if (drupal) seedOldSite(db, drupal, opts.primary);
  return runImport(db, opts);
}
