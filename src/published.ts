import { RELATION_LABEL, ToolError, ftsQuery } from "./common.js";
import type { Intro } from "./intro.js";

/**
 * Read-only queries over the public snapshot (src/snapshot.ts), for the public pages (src/site.ts) and the
 * public API. They read only the snapshot, never the store, so they can show only what was published.
 *
 * They go through a small async store, so the same code reads the snapshot with better-sqlite3 on the LAN
 * (src/published-sqlite.ts) and its replica in D1 in the Worker. Parameters are positional (`?`), as D1
 * wants. A page's queries are few and batched where a list would otherwise ask once per row, since each
 * one is a round trip in D1. What doesn't change between requests (the site's introduction, the maps,
 * the collections, the counts) is kept for the life of a Published, which is one snapshot on the LAN and
 * one request in the Worker.
 */

/** The snapshot's database, as the queries need it. */
export interface SnapshotStore {
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
}

export class NotPublic extends Error {}

type Row = Record<string, unknown>;
const json = <T>(v: unknown, fallback: T): T => (typeof v === "string" && v ? (JSON.parse(v) as T) : fallback);
const ids = (list: number[]) => list.map(Number).join(",") || "NULL";

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
export interface PublishedMap { name: string; title: string; description: string | null; scheme: string; set: string | null; svg: string | null }

/** A snapshot, with the queries the public site needs. Open one with Published.open. */
export class Published {
  private readonly memo = new Map<string, Promise<unknown>>();

  private constructor(
    readonly store: SnapshotStore,
    readonly level: "catalogue" | "quotes",
    readonly notes: boolean,
    readonly builtAt: string,
    readonly hash: string,
  ) {}

  static async open(store: SnapshotStore): Promise<Published> {
    const meta = new Map((await store.all<{ key: string; value: string }>("SELECT key, value FROM meta")).map((r) => [r.key, r.value]));
    return new Published(store, meta.get("level") === "quotes" ? "quotes" : "catalogue", meta.get("notes") === "all", meta.get("built_at") ?? "", meta.get("hash") ?? "");
  }

  get quoting(): boolean {
    return this.level === "quotes";
  }

  /** A value computed once for this Published. */
  private once<T>(key: string, make: () => Promise<T>): Promise<T> {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as Promise<T>;
  }

  private requireQuotes(): void {
    if (!this.quoting) throw new NotPublic("Quotes aren't public on this site.");
  }

  private intros(): Promise<Map<string, Intro>> {
    return this.once("intros", async () => new Map((await this.store.all<Intro & { key: string }>("SELECT key, title, html, summary FROM intros"))
      .map(({ key, ...intro }) => [key, intro])));
  }

  async site(): Promise<Intro> {
    return (await this.intros()).get("site") ?? { title: "Quotes", html: "", summary: null };
  }

  /** Whether a collection has an introduction of its own, rather than the scheme's label and description. */
  async hasIntro(scheme: string): Promise<boolean> {
    return (await this.intros()).has(`collection:${scheme}`);
  }

  totals() {
    return this.once("totals", async () => (await this.store.get<{ quotes: number; works: number; concepts: number }>(`SELECT
      (SELECT COUNT(*) FROM records) AS quotes, (SELECT COUNT(DISTINCT work_id) FROM records) AS works, (SELECT COUNT(*) FROM concepts) AS concepts`))!);
  }

  /** Records tagged with no concept, so in no collection yet. */
  async untagged(): Promise<number> {
    const r = await this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM records r WHERE NOT EXISTS (SELECT 1 FROM record_concepts rc WHERE rc.record_id = r.id)");
    return r!.n;
  }

  /** Records tagged with each concept, by concept id. */
  conceptCounts(): Promise<Map<number, number>> {
    return this.once("conceptCounts", async () => new Map((await this.store.all<{ id: number; n: number }>(
      "SELECT concept_id AS id, COUNT(*) AS n FROM record_concepts GROUP BY concept_id")).map((r) => [r.id, r.n])));
  }

  /** Records tagged with any of some concepts. */
  async count(conceptIds: number[]): Promise<number> {
    return (await this.store.get<{ n: number }>(`SELECT COUNT(DISTINCT record_id) AS n FROM record_concepts WHERE concept_id IN (${ids(conceptIds)})`))!.n;
  }

  async concepts(scheme: string | null = null) {
    const [n, rows] = await Promise.all([this.conceptCounts(), this.store.all<{ id: number; scheme: string; slug: string; label: string; definition: string | null }>(
      `SELECT c.id, s.slug AS scheme, c.slug, c.label, c.definition FROM concepts c JOIN schemes s ON s.id = c.scheme_id
      WHERE (? IS NULL OR s.slug = ?) ORDER BY lower(c.label)`, [scheme, scheme])]);
    return rows.map((c) => ({ ...c, quotes: n.get(c.id) ?? 0 }));
  }

  /** A concept by slug, label, alternative label, or scheme:slug, and then by a slug it had before. */
  async findConcept(name: string): Promise<{ id: number; scheme: string; slug: string; label: string }> {
    const [scheme, slug] = name.includes(":") ? name.split(":", 2) : [null, name];
    const n = slug.trim().toLowerCase();
    const rows = await this.store.all<{ id: number; scheme: string; slug: string; label: string; alt_labels: string; former_slugs: string }>(
      `SELECT c.id, s.slug AS scheme, c.slug, c.label, c.alt_labels, c.former_slugs FROM concepts c JOIN schemes s ON s.id = c.scheme_id
      WHERE (? IS NULL OR s.slug = ?) AND (c.slug = ? OR lower(c.label) = ? OR instr(lower(c.alt_labels), ?) > 0 OR instr(c.former_slugs, ?) > 0)`, [scheme, scheme, n, n, n, n]);
    const hit = rows.find((c) => c.slug === n || c.label.toLowerCase() === n) ?? rows.find((c) => json<string[]>(c.alt_labels, []).some((a) => a.toLowerCase() === n))
      ?? rows.find((c) => json<string[]>(c.former_slugs, []).includes(n));
    if (!hit) throw new ToolError(`No concept "${name}".`);
    return { id: hit.id, scheme: hit.scheme, slug: hit.slug, label: hit.label };
  }

  /** A concept and everything narrower than it, at any depth. */
  async withNarrower(id: number): Promise<number[]> {
    const rows = await this.store.all<{ id: number }>(`WITH RECURSIVE under(id) AS (SELECT ? UNION SELECT r.to_id FROM relations r JOIN under u ON r.from_id = u.id WHERE r.type = 'narrower')
      SELECT id FROM under`, [id]);
    return rows.map((r) => r.id);
  }

  /** One concept, in get_concept's shape, with counts of public records, and the ids of it and everything narrower. */
  async concept(name: string) {
    const c = await this.findConcept(name);
    const [row, relations, narrower] = await Promise.all([
      this.store.get("SELECT definition, alt_labels, wordnet, status, source FROM concepts WHERE id = ?", [c.id]),
      this.store.all<{ type: string; slug: string; label: string }>("SELECT r.type, o.slug, o.label FROM relations r JOIN concepts o ON o.id = r.to_id WHERE r.from_id = ? ORDER BY r.type, o.label", [c.id]),
      this.withNarrower(c.id),
    ]);
    const grouped: Record<string, { slug: string; label: string }[]> = {};
    for (const r of relations) (grouped[RELATION_LABEL[r.type] ?? r.type] ??= []).push({ slug: r.slug, label: r.label });
    const [own, all] = await Promise.all([this.count([c.id]), this.count(narrower)]);
    return {
      concept: {
        ...c, definition: (row!.definition as string) ?? null, alt_labels: json<string[]>(row!.alt_labels, []), wordnet: (row!.wordnet as string) ?? null,
        status: row!.status as string, source: (row!.source as string) ?? null, relations: grouped, quotes: own, quotes_with_narrower: all,
      },
      narrower,
    };
  }

  /** Every concept, with its count of public records, and every relation: /api/graph's shape. */
  graph() {
    return this.once("graph", async () => {
      const [n, concepts, relations] = await Promise.all([
        this.conceptCounts(),
        this.store.all("SELECT c.id, c.slug, s.slug AS scheme, c.label, c.alt_labels, c.status, c.source FROM concepts c JOIN schemes s ON s.id = c.scheme_id ORDER BY s.slug, c.slug"),
        this.store.all<{ from: string; to: string; type: string }>(`SELECT a.slug AS "from", b.slug AS "to", r.type FROM relations r JOIN concepts a ON a.id = r.from_id
          JOIN concepts b ON b.id = r.to_id ORDER BY a.slug, b.slug, r.type`),
      ]);
      return {
        concepts: concepts.map(({ id, alt_labels, ...c }) => ({ ...c, alt_labels: json<string[]>(alt_labels, []), quotes: n.get(id as number) ?? 0 })) as
          { slug: string; scheme: string; label: string; alt_labels: string[]; status: string; source: string | null; quotes: number }[],
        relations,
      };
    });
  }

  /** Each scheme with concepts, as a collection: its introduction (or the scheme's label and description) and counts. */
  collections(): Promise<Collection[]> {
    return this.once("collections", async () => {
      const [intros, schemes, members, counts] = await Promise.all([
        this.intros(),
        this.store.all<{ id: number; slug: string; label: string; description: string | null }>("SELECT id, slug, label, description FROM schemes ORDER BY lower(label)"),
        this.store.all<{ scheme_id: number; id: number }>("SELECT scheme_id, id FROM concepts"),
        this.store.all<{ scheme_id: number; quotes: number; works: number }>(`SELECT c.scheme_id, COUNT(DISTINCT r.id) AS quotes, COUNT(DISTINCT r.work_id) AS works
          FROM records r JOIN record_concepts rc ON rc.record_id = r.id JOIN concepts c ON c.id = rc.concept_id GROUP BY c.scheme_id`),
      ]);
      return schemes.map((s) => {
        const conceptIds = members.filter((m) => m.scheme_id === s.id).map((m) => m.id);
        const n = counts.find((x) => x.scheme_id === s.id);
        const intro = intros.get(`collection:${s.slug}`) ?? { title: s.label, html: s.description ? `<p>${escapeHtml(s.description)}</p>` : "", summary: s.description };
        return { scheme: s.slug, intro, quotes: n?.quotes ?? 0, works: n?.works ?? 0, concepts: conceptIds.length, conceptIds };
      }).filter((c) => c.concepts > 0);
    });
  }

  /** Works with public records, by first author, or those quoted under some concepts, with how many records each. */
  async works(conceptIds?: number[]) {
    const within = conceptIds ? `AND r.id IN (SELECT record_id FROM record_concepts WHERE concept_id IN (${ids(conceptIds)}))` : "";
    return (await this.store.all(`SELECT w.id, w.title, w.authors, w.year, COUNT(*) AS quotes FROM records r JOIN works w ON w.id = r.work_id
      WHERE 1 ${within} GROUP BY w.id ORDER BY w.sort`)).map((w) => ({ ...w, authors: json<string[]>(w.authors, []) })) as
      { id: number; title: string; authors: string[]; year: string | null; quotes: number }[];
  }

  /** One work, with its concepts and how many records each; a ToolError when it has no public records. */
  async work(id: number) {
    const [w, concepts] = await Promise.all([
      this.store.get("SELECT w.id, w.title, w.authors, w.year, w.citekey, (SELECT COUNT(*) FROM records r WHERE r.work_id = w.id) AS quotes FROM works w WHERE w.id = ?", [id]),
      this.store.all<{ scheme: string; slug: string; label: string; quotes: number }>(`SELECT s.slug AS scheme, c.slug, c.label, COUNT(*) AS quotes FROM records r
        JOIN record_concepts rc ON rc.record_id = r.id JOIN concepts c ON c.id = rc.concept_id JOIN schemes s ON s.id = c.scheme_id
        WHERE r.work_id = ? GROUP BY c.id ORDER BY quotes DESC, lower(c.label)`, [id]),
    ]);
    if (!w) throw new ToolError(`No work ${id}.`);
    return { id, title: w.title as string, authors: json<string[]>(w.authors, []), year: (w.year as string) ?? null, citekey: (w.citekey as string) ?? null, quotes: w.quotes as number, concepts };
  }

  /** Records as the pages show them, with their works and concepts fetched for all of them at once. */
  private async records(rows: Row[]): Promise<PublicRecord[]> {
    if (!rows.length) return [];
    const recordIds = ids(rows.map((r) => r.id as number));
    const workIds = ids([...new Set(rows.map((r) => r.work_id as number | null).filter((w): w is number => w !== null))]);
    const [works, concepts] = await Promise.all([
      this.store.all(`SELECT id, title, authors, year, citekey FROM works WHERE id IN (${workIds})`),
      this.store.all<{ record_id: number; scheme: string; slug: string; label: string }>(`SELECT rc.record_id, s.slug AS scheme, c.slug, c.label FROM record_concepts rc
        JOIN concepts c ON c.id = rc.concept_id JOIN schemes s ON s.id = c.scheme_id WHERE rc.record_id IN (${recordIds}) ORDER BY lower(c.label)`),
    ]);
    const work = new Map(works.map((w) => [w.id as number, { id: w.id as number, title: w.title as string, authors: json<string[]>(w.authors, []), year: (w.year as string) ?? null, citekey: (w.citekey as string) ?? null }]));
    return rows.map((r) => {
      const note = r.kind === "note";
      return {
        id: r.id as number, kind: note ? "note" : "quote", text: r.text as string,
        ...(note ? { note: (r.note as string) ?? null } : r.comment ? { comment: r.comment as string } : {}),
        ...(r.snippet ? { snippet: r.snippet as string } : {}),
        locator: (r.locator as string) ?? null, chapter_author: (r.chapter_author as string) ?? null, attribution: (r.attribution as string) ?? null,
        work: work.get(r.work_id as number) ?? null,
        concepts: concepts.filter((c) => c.record_id === r.id).map(({ scheme, slug, label }) => ({ scheme, slug, label })),
      };
    });
  }

  /** One record; a ToolError when there's no such record. */
  async get(id: number): Promise<PublicRecord> {
    this.requireQuotes();
    const r = await this.store.get("SELECT * FROM records WHERE id = ?", [id]);
    if (!r) throw new ToolError(`No quote ${id}.`);
    return (await this.records([r]))[0];
  }

  /** Records, a page at a time: by words (ranked), concepts, or work (in page order). */
  async quotes(args: Search) {
    this.requireQuotes();
    const where = ["1"];
    const params: unknown[] = [];
    let from = "records r";
    let order = args.newest ? "r.added DESC, r.id DESC" : "r.id";
    let snippet = "NULL";
    if (args.query?.trim()) {
      const terms = ftsQuery(args.query);
      if (!terms) throw new ToolError("The search has no words to look for.");
      from = "records_fts f JOIN records r ON r.id = f.rowid";
      where.push("records_fts MATCH ?");
      params.push(terms);
      order = "bm25(records_fts)";
      snippet = "CASE r.kind WHEN 'note' THEN snippet(records_fts, 1, '«', '»', '…', 24) ELSE snippet(records_fts, 0, '«', '»', '…', 24) END";
    }
    if (args.conceptIds) where.push(`r.id IN (SELECT record_id FROM record_concepts WHERE concept_id IN (${ids(args.conceptIds)}))`);
    if (args.work !== undefined) {
      where.push("r.work_id = ?");
      params.push(args.work);
      if (!args.query?.trim()) order = "r.page IS NULL, r.page, r.id";
    }
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const offset = Math.max(args.offset ?? 0, 0);
    const clause = `WHERE ${where.join(" AND ")}`;
    const [total, rows] = await Promise.all([
      this.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${from} ${clause}`, params),
      this.store.all(`SELECT r.*, ${snippet} AS snippet FROM ${from} ${clause} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params),
    ]);
    return { total: total!.n, offset, limit, quotes: await this.records(rows) };
  }

  /** How to cite a record: the Pandoc citation, and BibTeX and CSL JSON for its work. */
  async citation(id: number) {
    this.requireQuotes();
    const r = await this.store.get("SELECT r.pandoc, w.citekey, w.csl, w.bibtex FROM records r LEFT JOIN works w ON w.id = r.work_id WHERE r.id = ?", [id]);
    if (!r) throw new ToolError(`No quote ${id}.`);
    return { pandoc: (r.pandoc as string) ?? null, citekey: (r.citekey as string) ?? null, csl: json<Record<string, unknown> | null>(r.csl, null), bibtex: (r.bibtex as string) ?? null };
  }

  /** Every set, with how many concepts it has: /api/sets's shape. */
  sets() {
    return this.once("sets", async () => (await this.store.all(`SELECT t.slug, s.slug AS scheme, t.label, t.description, t.missing,
      (SELECT COUNT(*) FROM set_concepts sc WHERE sc.set_slug = t.slug) AS concepts FROM sets t JOIN schemes s ON s.id = t.scheme_id ORDER BY t.position`))
      .map((r) => ({ slug: r.slug as string, scheme: r.scheme as string, label: r.label as string, description: (r.description as string) ?? null, concepts: r.concepts as number, missing: json<string[]>(r.missing, []) })));
  }

  /** One set as a piece of the graph (/api/sets/:slug's shape), and its concepts' ids. */
  async set(slug: string) {
    const t = await this.store.get("SELECT t.slug, s.slug AS scheme, t.label, t.description, t.definition, t.missing FROM sets t JOIN schemes s ON s.id = t.scheme_id WHERE t.slug = ?",
      [slug.trim().toLowerCase()]);
    if (!t) throw new ToolError(`No concept set "${slug}".`);
    const [members, graph] = await Promise.all([
      this.store.all<{ id: number; slug: string }>("SELECT c.id, c.slug FROM set_concepts sc JOIN concepts c ON c.id = sc.concept_id WHERE sc.set_slug = ?", [t.slug]),
      this.graph(),
    ]);
    const inSet = new Set(members.map((m) => m.slug));
    return {
      set: {
        slug: t.slug as string, scheme: t.scheme as string, label: t.label as string, description: (t.description as string) ?? null,
        definition: json<Record<string, unknown>>(t.definition, {}), missing: json<string[]>(t.missing, []),
        concepts: graph.concepts.filter((c) => c.scheme === t.scheme && inSet.has(c.slug)),
        relations: graph.relations.filter((r) => inSet.has(r.from) && inSet.has(r.to)),
      },
      conceptIds: members.map((m) => m.id),
    };
  }

  /** The sets a concept is in. */
  setsOf(conceptId: number): Promise<{ slug: string; label: string }[]> {
    return this.store.all("SELECT t.slug, t.label FROM set_concepts sc JOIN sets t ON t.slug = sc.set_slug WHERE sc.concept_id = ? ORDER BY t.position", [conceptId]);
  }

  maps(): Promise<PublishedMap[]> {
    return this.once("maps", () => this.store.all<PublishedMap>("SELECT name, title, description, scheme, set_slug AS \"set\", svg FROM maps ORDER BY position"));
  }
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
