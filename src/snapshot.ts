import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DB } from "./db.js";
import { type Visibility, bibtex, plainText, visible } from "./public.js";
import { citeQuote, locatorText, workSummary } from "./queries.js";
import { type ConceptSet, resolveSet } from "./sets.js";
import type { Intro } from "./intro.js";

/**
 * The public snapshot: what the public site may show, copied out of the store into a SQLite database of
 * its own, which the public pages read (src/published.ts) on the LAN and, sent to D1, in the Worker. The
 * rules for what's public (src/public.ts) are applied here and nowhere else, so nothing that isn't in the
 * snapshot can be shown, whatever the pages do.
 *
 * At the catalogue level records are copied with no words (no text, note, comment, place, or
 * attribution), only their kind, work, and concepts, so the pages can count them.
 */

export const SNAPSHOT_VERSION = 1;

export const SNAPSHOT_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE intros (key TEXT PRIMARY KEY, title TEXT NOT NULL, html TEXT NOT NULL, summary TEXT);
CREATE TABLE schemes (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL, description TEXT);
CREATE TABLE concepts (
  id INTEGER PRIMARY KEY, scheme_id INTEGER NOT NULL, slug TEXT NOT NULL, label TEXT NOT NULL, alt_labels TEXT NOT NULL,
  definition TEXT, wordnet TEXT, status TEXT NOT NULL, source TEXT, UNIQUE (scheme_id, slug)
);
CREATE TABLE relations (from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id, type));
CREATE TABLE works (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL, year TEXT, citekey TEXT, zotero_keys TEXT NOT NULL,
  csl TEXT, bibtex TEXT, sort TEXT NOT NULL
);
CREATE TABLE records (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, work_id INTEGER, text TEXT NOT NULL, note TEXT, comment TEXT, locator TEXT,
  page INTEGER, chapter_author TEXT, attribution TEXT, pandoc TEXT, added TEXT NOT NULL
);
CREATE TABLE record_concepts (record_id INTEGER NOT NULL, concept_id INTEGER NOT NULL, PRIMARY KEY (record_id, concept_id));
CREATE INDEX record_concepts_concept ON record_concepts (concept_id);
CREATE INDEX records_work ON records (work_id);
CREATE VIRTUAL TABLE records_fts USING fts5(text, words, tokenize = 'porter unicode61');
CREATE TABLE sets (slug TEXT PRIMARY KEY, scheme_id INTEGER NOT NULL, label TEXT NOT NULL, description TEXT, definition TEXT NOT NULL, missing TEXT NOT NULL, position INTEGER NOT NULL);
CREATE TABLE set_concepts (set_slug TEXT NOT NULL, concept_id INTEGER NOT NULL, PRIMARY KEY (set_slug, concept_id));
CREATE TABLE maps (name TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, scheme TEXT, set_slug TEXT, svg TEXT, position INTEGER NOT NULL);
`;

/** What goes into a snapshot, besides the store: the level, the introductions, the sets, and the maps. */
export interface SnapshotOptions extends Visibility {
  intro: Intro;
  collections: Record<string, Intro>;
  sets: ConceptSet[];
  /** The maps, as quote-atlas's maps.json lists them. */
  maps: MapEntry[];
}

export interface MapEntry { name: string; title?: string; description?: string; scheme?: string; set?: string; svg?: string }

/** The maps in quote-atlas's maps.json in a folder; none when there isn't one or it can't be read. */
export function readMapsFile(dir: string | undefined): MapEntry[] {
  if (!dir) return [];
  try {
    const maps = JSON.parse(fs.readFileSync(path.join(dir, "maps.json"), "utf8")) as MapEntry[];
    return Array.isArray(maps) ? maps.filter((m) => typeof m?.name === "string" && /^[\w-]+$/.test(m.name)) : [];
  } catch {
    return [];
  }
}

type Row = Record<string, unknown>;
const json = <T>(v: unknown, fallback: T): T => (typeof v === "string" && v ? (JSON.parse(v) as T) : fallback);

/** The numeric page a locator starts at, for ordering a work's quotes; null for none or a Kindle location. */
function pageOf(kind: string, locator: string | null): number | null {
  if (kind !== "page" || !locator) return null;
  const n = Number.parseInt(locator, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Copies what's public into an empty snapshot database. */
function fill(store: DB, snap: Database.Database, o: SnapshotOptions): void {
  const words = o.level === "quotes";
  const shareNotes = words && o.notes;
  const insert = (table: string, row: Row) => {
    const keys = Object.keys(row);
    snap.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((k) => `@${k}`).join(", ")})`).run(row);
  };

  // Concepts that aren't retired, and the relations between them.
  const schemes = store.prepare("SELECT id, slug, label, description FROM schemes").all() as Row[];
  for (const s of schemes) insert("schemes", s);
  const concepts = store.prepare(`SELECT c.id, c.scheme_id, c.slug, c.label, c.alt_labels, c.definition, c.close_match AS wordnet, c.status, c.source
    FROM concepts c WHERE c.status != 'retired'`).all() as Row[];
  for (const c of concepts) insert("concepts", c);
  const kept = new Set(concepts.map((c) => c.id as number));
  for (const r of store.prepare("SELECT from_id, to_id, type FROM concept_relations").all() as Row[]) {
    if (kept.has(r.from_id as number) && kept.has(r.to_id as number)) insert("relations", r);
  }

  // Public records, with words only at the quotes level, and the works they come from.
  const records = store.prepare(`SELECT q.* FROM quotes q WHERE ${visible(o)}`).all() as Row[];
  const tags = store.prepare("SELECT DISTINCT concept_id FROM quote_tags WHERE quote_id = ? AND concept_id IS NOT NULL");
  const works = new Set<number>();
  for (const q of records) {
    const note = q.kind === "note";
    const comment = typeof q.comment === "string" && q.comment.trim() ? q.comment.trim() : null;
    const work = (q.work_id as number) ?? null;
    if (work !== null) works.add(work);
    const text = words && !note ? plainText(q.text as string) : "";
    const noteWords = words && note ? comment : null;
    const shownComment = shareNotes && !note ? comment : null;
    insert("records", {
      id: q.id, kind: note ? "note" : "quote", work_id: work, text, note: noteWords, comment: shownComment,
      locator: words ? locatorText(q.locator_kind as string, (q.locator as string) ?? null) : null,
      page: pageOf(q.locator_kind as string, (q.locator as string) ?? null),
      chapter_author: words ? (q.chapter_author as string) ?? null : null,
      attribution: words ? (q.attribution as string) ?? null : null,
      pandoc: words ? citeQuote(store, q.id as number).pandoc : null,
      added: q.created_at,
    });
    if (words) snap.prepare("INSERT INTO records_fts (rowid, text, words) VALUES (?, ?, ?)").run(q.id, text, [noteWords, shownComment].filter(Boolean).join("\n"));
    for (const t of tags.all(q.id) as { concept_id: number }[]) {
      if (kept.has(t.concept_id)) insert("record_concepts", { record_id: q.id, concept_id: t.concept_id });
    }
  }
  const first = store.prepare("SELECT id FROM quotes q WHERE q.work_id = ? AND " + visible(o) + " LIMIT 1").pluck();
  for (const id of works) {
    const w = workSummary(store, id)!;
    const row = store.prepare("SELECT zotero_library, zotero_key, candidates FROM works WHERE id = ?").get(id) as Row;
    const keys = [row.zotero_key ? `${row.zotero_library}/${row.zotero_key}` : null, ...json<string[]>(row.candidates, []).map((k) => `${row.zotero_library ?? ""}/${k}`)]
      .filter((k): k is string => !!k && !k.startsWith("/"));
    const c = citeQuote(store, first.get(id) as number);
    const key = c.citekey ?? (c.csl?.id as string | undefined) ?? null;
    insert("works", {
      id, title: w.title, authors: JSON.stringify(w.authors), year: w.year, citekey: w.citekey, zotero_keys: JSON.stringify(keys),
      csl: words && c.csl ? JSON.stringify(c.csl) : null, bibtex: words && c.csl && key ? bibtex(c.csl, key) : null,
      sort: `${(w.authors[0] ?? "￿").toLowerCase()}\u0001${w.title.toLowerCase()}`,
    });
  }

  // Introductions, sets resolved against the store as it is now, and the maps.
  insert("intros", { key: "site", ...o.intro });
  for (const [scheme, intro] of Object.entries(o.collections)) insert("intros", { key: `collection:${scheme}`, ...intro });
  const graph = {
    concepts: concepts.map((c) => ({ slug: c.slug as string, scheme: schemes.find((s) => s.id === c.scheme_id)!.slug as string })),
    relations: (snap.prepare(`SELECT a.slug AS "from", b.slug AS "to", r.type FROM relations r JOIN concepts a ON a.id = r.from_id JOIN concepts b ON b.id = r.to_id`).all()) as { from: string; to: string; type: string }[],
  };
  o.sets.forEach((set, position) => {
    const scheme = schemes.find((s) => s.slug === set.scheme);
    if (!scheme) return;
    const { members, missing } = resolveSet(set, graph as never);
    const { concepts: listed, around, depth, types, narrower, exclude } = set;
    insert("sets", { slug: set.slug, scheme_id: scheme.id, label: set.label, description: set.description ?? null,
      definition: JSON.stringify({ concepts: listed, around, depth, types, narrower, exclude }), missing: JSON.stringify(missing), position });
    for (const slug of members) {
      const c = concepts.find((x) => x.scheme_id === scheme.id && x.slug === slug);
      if (c) insert("set_concepts", { set_slug: set.slug, concept_id: c.id });
    }
  });
  o.maps.forEach((m, position) => insert("maps", {
    name: m.name, title: m.title ?? m.name, description: m.description ?? null, scheme: m.scheme ?? m.name, set_slug: m.set ?? null, svg: m.svg ?? null, position,
  }));

  insert("meta", { key: "version", value: String(SNAPSHOT_VERSION) });
  insert("meta", { key: "level", value: o.level });
  insert("meta", { key: "notes", value: shareNotes ? "all" : "none" });
}

/** A hash of everything in a snapshot but its meta, so an unchanged snapshot isn't sent again. */
function contentHash(snap: Database.Database): string {
  const hash = createHash("sha256");
  const tables = snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'records_fts%' AND name != 'meta' ORDER BY name").pluck().all() as string[];
  for (const t of tables) {
    hash.update(`\u0001${t}`);
    for (const row of snap.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).iterate()) hash.update(JSON.stringify(row));
  }
  for (const row of snap.prepare("SELECT key, value FROM meta WHERE key IN ('version', 'level', 'notes') ORDER BY key").iterate()) hash.update(JSON.stringify(row));
  return hash.digest("hex");
}

export interface SnapshotSummary { file: string; hash: string; level: string; records: number; works: number; concepts: number; sets: number; maps: number }

/**
 * Builds the snapshot at `file`: written beside it under a temporary name and renamed into place, so a
 * server reading the old one never sees half of the new. Returns what's in it.
 */
export function buildSnapshot(store: DB, o: SnapshotOptions, file: string): SnapshotSummary {
  if (o.level === "none") throw new Error("There's nothing to publish with QUOTE_PUBLIC=none; set it to catalogue or quotes.");
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  const snap = new Database(temp);
  try {
    snap.pragma("journal_mode = DELETE");
    snap.exec(SNAPSHOT_SCHEMA);
    snap.transaction(() => fill(store, snap, o))();
    const hash = contentHash(snap);
    snap.prepare("INSERT INTO meta (key, value) VALUES ('hash', ?), ('built_at', ?)").run(hash, new Date().toISOString());
    const count = (t: string) => snap.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get() as number;
    const summary = { file, hash, level: o.level, records: count("records"), works: count("works"), concepts: count("concepts"), sets: count("sets"), maps: count("maps") };
    snap.close();
    fs.renameSync(temp, file);
    return summary;
  } catch (error) {
    if (snap.open) snap.close();
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
