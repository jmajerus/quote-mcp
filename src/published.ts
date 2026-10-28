import fs from "node:fs";
import Database from "better-sqlite3";
import { RELATION_LABEL, ToolError, ftsQuery } from "./queries.js";
import type { Intro } from "./intro.js";

/**
 * Read-only queries over the public snapshot (src/snapshot.ts), for the public pages (src/site.ts) and the
 * public API. They read only the snapshot, never the store, so they can show only what was published.
 */

export class NotPublic extends Error {}

type DB = Database.Database;
type Row = Record<string, unknown>;
const json = <T>(v: unknown, fallback: T): T => (typeof v === "string" && v ? (JSON.parse(v) as T) : fallback);
const ids = (list: number[]) => list.map(Number).join(",");

export interface PublishedWork { id: number; title: string; authors: string[]; year: string | null; citekey: string | null }

export interface PublicRecord {
  id: number;
  kind: "quote" | "note";
  /** What it quotes; empty for a note. */
  text: string;
  /** A note's words. */
  note?: string | null;
  /** A quote's comment, when notes are shared. */
  comment?: string;
  snippet?: string;
  locator: string | null;
  chapter_author: string | null;
  attribution: string | null;
  work: PublishedWork | null;
  concepts: { scheme: string; slug: string; label: string }[];
}

export interface Search {
  query?: string;
  /** Only records tagged with one of these concepts. */
  conceptIds?: number[];
  work?: number;
  /** Newest first, rather than by id (or by page within a work). */
  newest?: boolean;
  limit?: number;
  offset?: number;
}

export interface Collection { scheme: string; intro: Intro; quotes: number; works: number; concepts: number; conceptIds: number[] }

/** A snapshot, opened read-only, with the queries the public site needs. */
export class Published {
  readonly level: "catalogue" | "quotes";
  readonly notes: boolean;
  readonly builtAt: string;
  readonly hash: string;

  constructor(readonly db: DB) {
    const meta = new Map((db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    this.level = meta.get("level") === "quotes" ? "quotes" : "catalogue";
    this.notes = meta.get("notes") === "all";
    this.builtAt = meta.get("built_at") ?? "";
    this.hash = meta.get("hash") ?? "";
  }

  get quoting(): boolean {
    return this.level === "quotes";
  }

  private requireQuotes(): void {
    if (!this.quoting) throw new NotPublic("Quotes aren't public on this site.");
  }

  intro(key: string): Intro | null {
    return (this.db.prepare("SELECT title, html, summary FROM intros WHERE key = ?").get(key) as Intro | undefined) ?? null;
  }

  get site(): Intro {
    return this.intro("site") ?? { title: "Quotes", html: "", summary: null };
  }

  totals() {
    return this.db.prepare(`SELECT (SELECT COUNT(*) FROM records) AS quotes, (SELECT COUNT(DISTINCT work_id) FROM records) AS works,
      (SELECT COUNT(*) FROM concepts) AS concepts`).get() as { quotes: number; works: number; concepts: number };
  }

  /** Records tagged with no concept, so in no collection yet. */
  untagged(): number {
    return this.db.prepare("SELECT COUNT(*) FROM records r WHERE NOT EXISTS (SELECT 1 FROM record_concepts rc WHERE rc.record_id = r.id)").pluck().get() as number;
  }

  /** Records tagged with each concept, by concept id. */
  conceptCounts(): Map<number, number> {
    const rows = this.db.prepare("SELECT concept_id AS id, COUNT(*) AS n FROM record_concepts GROUP BY concept_id").all() as { id: number; n: number }[];
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  /** Records tagged with any of some concepts. */
  count(conceptIds: number[]): number {
    return this.db.prepare(`SELECT COUNT(DISTINCT record_id) FROM record_concepts WHERE concept_id IN (${ids(conceptIds)})`).pluck().get() as number;
  }

  concepts(scheme: string | null = null) {
    const n = this.conceptCounts();
    return (this.db.prepare(`SELECT c.id, s.slug AS scheme, c.slug, c.label, c.definition FROM concepts c JOIN schemes s ON s.id = c.scheme_id
      WHERE (? IS NULL OR s.slug = ?) ORDER BY lower(c.label)`).all(scheme, scheme) as { id: number; scheme: string; slug: string; label: string; definition: string | null }[])
      .map((c) => ({ ...c, quotes: n.get(c.id) ?? 0 }));
  }

  /** A concept by slug, label, alternative label, or scheme:slug. */
  findConcept(name: string): { id: number; scheme: string; slug: string; label: string } {
    const [scheme, slug] = name.includes(":") ? name.split(":", 2) : [null, name];
    const rows = this.db.prepare(`SELECT c.id, s.slug AS scheme, c.slug, c.label, c.alt_labels FROM concepts c JOIN schemes s ON s.id = c.scheme_id
      WHERE (? IS NULL OR s.slug = ?)`).all(scheme, scheme) as { id: number; scheme: string; slug: string; label: string; alt_labels: string }[];
    const n = slug.trim().toLowerCase();
    const hit = rows.find((c) => c.slug === n || c.label.toLowerCase() === n) ?? rows.find((c) => json<string[]>(c.alt_labels, []).some((a) => a.toLowerCase() === n));
    if (!hit) throw new ToolError(`No concept "${name}".`);
    return { id: hit.id, scheme: hit.scheme, slug: hit.slug, label: hit.label };
  }

  /** A concept and everything narrower than it, at any depth. */
  withNarrower(id: number): number[] {
    const seen = new Set([id]);
    const next = this.db.prepare("SELECT to_id FROM relations WHERE from_id = ? AND type = 'narrower'").pluck();
    for (const current of seen) for (const to of next.all(current) as number[]) seen.add(to);
    return [...seen];
  }

  /** One concept, in get_concept's shape, with counts of public records. */
  concept(name: string) {
    const c = this.findConcept(name);
    const row = this.db.prepare("SELECT definition, alt_labels, wordnet, status, source FROM concepts WHERE id = ?").get(c.id) as Row;
    const relations = this.db.prepare(`SELECT r.type, o.slug, o.label FROM relations r JOIN concepts o ON o.id = r.to_id WHERE r.from_id = ? ORDER BY r.type, o.label`)
      .all(c.id) as { type: string; slug: string; label: string }[];
    const grouped: Record<string, { slug: string; label: string }[]> = {};
    for (const r of relations) (grouped[RELATION_LABEL[r.type] ?? r.type] ??= []).push({ slug: r.slug, label: r.label });
    return {
      ...c, definition: (row.definition as string) ?? null, alt_labels: json<string[]>(row.alt_labels, []), wordnet: (row.wordnet as string) ?? null,
      status: row.status as string, source: (row.source as string) ?? null, relations: grouped, quotes: this.count([c.id]), quotes_with_narrower: this.count(this.withNarrower(c.id)),
    };
  }

  /** Every concept, with its count of public records, and every relation: /api/graph's shape. */
  graph() {
    const n = this.conceptCounts();
    const concepts = (this.db.prepare(`SELECT c.id, c.slug, s.slug AS scheme, c.label, c.alt_labels, c.status, c.source FROM concepts c JOIN schemes s ON s.id = c.scheme_id
      ORDER BY s.slug, c.slug`).all() as Row[]).map(({ id, alt_labels, ...c }) => ({ ...c, alt_labels: json<string[]>(alt_labels, []), quotes: n.get(id as number) ?? 0 }));
    const relations = this.db.prepare(`SELECT a.slug AS "from", b.slug AS "to", r.type FROM relations r JOIN concepts a ON a.id = r.from_id JOIN concepts b ON b.id = r.to_id
      ORDER BY a.slug, b.slug, r.type`).all() as { from: string; to: string; type: string }[];
    return { concepts: concepts as { slug: string; scheme: string; label: string; alt_labels: string[]; status: string; source: string | null; quotes: number }[], relations };
  }

  /** Each scheme with concepts, as a collection: its introduction (or the scheme's label and description) and counts. */
  collections(): Collection[] {
    const schemes = this.db.prepare("SELECT id, slug, label, description FROM schemes ORDER BY lower(label)").all() as { id: number; slug: string; label: string; description: string | null }[];
    const conceptIds = this.db.prepare("SELECT id FROM concepts WHERE scheme_id = ?").pluck();
    return schemes.map((s) => {
      const list = conceptIds.all(s.id) as number[];
      const n = this.db.prepare(`SELECT COUNT(*) AS quotes, COUNT(DISTINCT work_id) AS works FROM records
        WHERE id IN (SELECT record_id FROM record_concepts WHERE concept_id IN (${ids(list)}))`).get() as { quotes: number; works: number };
      const intro = this.intro(`collection:${s.slug}`) ?? { title: s.label, html: s.description ? `<p>${escapeHtml(s.description)}</p>` : "", summary: s.description };
      return { scheme: s.slug, intro, ...n, concepts: list.length, conceptIds: list };
    }).filter((c) => c.concepts > 0);
  }

  /** Whether a collection has an introduction of its own, rather than the scheme's label and description. */
  hasIntro(scheme: string): boolean {
    return this.intro(`collection:${scheme}`) !== null;
  }

  /** Works with public records, by first author, or those quoted under some concepts, with how many records each. */
  works(conceptIds?: number[]) {
    const within = conceptIds ? `AND r.id IN (SELECT record_id FROM record_concepts WHERE concept_id IN (${ids(conceptIds)}))` : "";
    return (this.db.prepare(`SELECT w.id, w.title, w.authors, w.year, COUNT(*) AS quotes FROM records r JOIN works w ON w.id = r.work_id
      WHERE 1 ${within} GROUP BY w.id ORDER BY w.sort`).all() as Row[]).map((w) => ({ ...w, authors: json<string[]>(w.authors, []) })) as
      { id: number; title: string; authors: string[]; year: string | null; quotes: number }[];
  }

  /** One work, with its concepts and how many records each; a ToolError when it has no public records. */
  work(id: number) {
    const w = this.db.prepare(`SELECT w.id, w.title, w.authors, w.year, w.citekey, (SELECT COUNT(*) FROM records r WHERE r.work_id = w.id) AS quotes
      FROM works w WHERE w.id = ?`).get(id) as Row | undefined;
    if (!w) throw new ToolError(`No work ${id}.`);
    const concepts = this.db.prepare(`SELECT s.slug AS scheme, c.slug, c.label, COUNT(*) AS quotes FROM records r JOIN record_concepts rc ON rc.record_id = r.id
      JOIN concepts c ON c.id = rc.concept_id JOIN schemes s ON s.id = c.scheme_id WHERE r.work_id = ? GROUP BY c.id ORDER BY quotes DESC, lower(c.label)`)
      .all(id) as { scheme: string; slug: string; label: string; quotes: number }[];
    return { id, title: w.title as string, authors: json<string[]>(w.authors, []), year: (w.year as string) ?? null, citekey: (w.citekey as string) ?? null, quotes: w.quotes as number, concepts };
  }

  private publishedWork(id: number | null): PublishedWork | null {
    if (id === null) return null;
    const w = this.db.prepare("SELECT id, title, authors, year, citekey FROM works WHERE id = ?").get(id) as Row | undefined;
    return w ? { id: w.id as number, title: w.title as string, authors: json<string[]>(w.authors, []), year: (w.year as string) ?? null, citekey: (w.citekey as string) ?? null } : null;
  }

  private record(r: Row, snippet: string | null = null): PublicRecord {
    const note = r.kind === "note";
    const concepts = this.db.prepare(`SELECT s.slug AS scheme, c.slug, c.label FROM record_concepts rc JOIN concepts c ON c.id = rc.concept_id
      JOIN schemes s ON s.id = c.scheme_id WHERE rc.record_id = ? ORDER BY lower(c.label)`).all(r.id) as PublicRecord["concepts"];
    return {
      id: r.id as number, kind: note ? "note" : "quote", text: r.text as string,
      ...(note ? { note: (r.note as string) ?? null } : r.comment ? { comment: r.comment as string } : {}),
      ...(snippet ? { snippet } : {}),
      locator: (r.locator as string) ?? null, chapter_author: (r.chapter_author as string) ?? null, attribution: (r.attribution as string) ?? null,
      work: this.publishedWork((r.work_id as number) ?? null), concepts,
    };
  }

  /** One record; a ToolError when there's no such record. */
  get(id: number): PublicRecord {
    this.requireQuotes();
    const r = this.db.prepare("SELECT * FROM records WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new ToolError(`No quote ${id}.`);
    return this.record(r);
  }

  /** Records, a page at a time: by words (ranked), concepts, or work (in page order). */
  quotes(args: Search) {
    this.requireQuotes();
    const where = ["1"];
    const params: Record<string, unknown> = {};
    let from = "records r";
    let order = args.newest ? "r.added DESC, r.id DESC" : "r.id";
    let snippet = "NULL";
    if (args.query?.trim()) {
      const terms = ftsQuery(args.query);
      if (!terms) throw new ToolError("The search has no words to look for.");
      from = "records_fts f JOIN records r ON r.id = f.rowid";
      where.push("records_fts MATCH @fts");
      params.fts = terms;
      order = "bm25(records_fts)";
      snippet = "CASE r.kind WHEN 'note' THEN snippet(records_fts, 1, '«', '»', '…', 24) ELSE snippet(records_fts, 0, '«', '»', '…', 24) END";
    }
    if (args.conceptIds) where.push(`r.id IN (SELECT record_id FROM record_concepts WHERE concept_id IN (${ids(args.conceptIds)}))`);
    if (args.work !== undefined) {
      where.push("r.work_id = @work");
      params.work = args.work;
      if (!args.query?.trim()) order = "r.page IS NULL, r.page, r.id";
    }
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const offset = Math.max(args.offset ?? 0, 0);
    const clause = `WHERE ${where.join(" AND ")}`;
    const total = this.db.prepare(`SELECT COUNT(*) FROM ${from} ${clause}`).pluck().get(params) as number;
    const rows = this.db.prepare(`SELECT r.*, ${snippet} AS snippet FROM ${from} ${clause} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(params) as Row[];
    return { total, offset, limit, quotes: rows.map((r) => this.record(r, (r.snippet as string) ?? null)) };
  }

  /** How to cite a record: the Pandoc citation, and BibTeX and CSL JSON for its work. */
  citation(id: number) {
    this.get(id);
    const r = this.db.prepare("SELECT r.pandoc, w.citekey, w.csl, w.bibtex FROM records r LEFT JOIN works w ON w.id = r.work_id WHERE r.id = ?").get(id) as Row;
    return { pandoc: (r.pandoc as string) ?? null, citekey: (r.citekey as string) ?? null, csl: json<Record<string, unknown> | null>(r.csl, null), bibtex: (r.bibtex as string) ?? null };
  }

  /** Every set, with how many concepts it has: /api/sets's shape. */
  sets() {
    return (this.db.prepare(`SELECT t.slug, s.slug AS scheme, t.label, t.description, t.missing, (SELECT COUNT(*) FROM set_concepts sc WHERE sc.set_slug = t.slug) AS concepts
      FROM sets t JOIN schemes s ON s.id = t.scheme_id ORDER BY t.position`).all() as Row[])
      .map((r) => ({ slug: r.slug as string, scheme: r.scheme as string, label: r.label as string, description: (r.description as string) ?? null, concepts: r.concepts as number, missing: json<string[]>(r.missing, []) }));
  }

  /** One set as a piece of the graph: /api/sets/:slug's shape. */
  set(slug: string) {
    const t = this.db.prepare("SELECT t.slug, s.slug AS scheme, t.label, t.description, t.definition, t.missing FROM sets t JOIN schemes s ON s.id = t.scheme_id WHERE t.slug = ?")
      .get(slug.trim().toLowerCase()) as Row | undefined;
    if (!t) throw new ToolError(`No concept set "${slug}".`);
    const members = new Set(this.db.prepare("SELECT c.slug FROM set_concepts sc JOIN concepts c ON c.id = sc.concept_id WHERE sc.set_slug = ?").pluck().all(t.slug) as string[]);
    const graph = this.graph();
    return {
      slug: t.slug as string, scheme: t.scheme as string, label: t.label as string, description: (t.description as string) ?? null,
      definition: json<Record<string, unknown>>(t.definition, {}), missing: json<string[]>(t.missing, []),
      concepts: graph.concepts.filter((c) => c.scheme === t.scheme && members.has(c.slug)),
      relations: graph.relations.filter((r) => members.has(r.from) && members.has(r.to)),
    };
  }

  /** A set's concept ids. */
  setConceptIds(slug: string): number[] {
    return this.db.prepare("SELECT concept_id FROM set_concepts WHERE set_slug = ?").pluck().all(slug) as number[];
  }

  /** The sets a concept is in. */
  setsOf(conceptId: number): { slug: string; label: string }[] {
    return this.db.prepare("SELECT t.slug, t.label FROM set_concepts sc JOIN sets t ON t.slug = sc.set_slug WHERE sc.concept_id = ? ORDER BY t.position").all(conceptId) as never;
  }

  maps(): { name: string; title: string; description: string | null; scheme: string; set: string | null; svg: string | null }[] {
    return this.db.prepare("SELECT name, title, description, scheme, set_slug AS 'set', svg FROM maps ORDER BY position").all() as never;
  }
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * The snapshot at a path, reopened when the file is replaced (a rebuild renames a new file into place),
 * or null when there isn't one yet.
 */
export function snapshotReader(file: string): () => Published | null {
  let open: { ino: number; mtime: number; published: Published } | null = null;
  return () => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    if (!open || open.ino !== stat.ino || open.mtime !== stat.mtimeMs) {
      open?.published.db.close();
      open = { ino: stat.ino, mtime: stat.mtimeMs, published: new Published(new Database(file, { readonly: true, fileMustExist: true })) };
    }
    return open.published;
  };
}
