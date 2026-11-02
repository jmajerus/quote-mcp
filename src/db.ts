import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * The quote store: primary data, never rebuilt (back it up). Quotes are the records people edit; their
 * origins (a span on the old site, a Zotero note) are provenance kept with the raw HTML they came from.
 * A record's kind is "quote" (a passage) or "note" (your own words at a locator or about a whole work, kept
 * as its comment, with no quoted text); both share works, locators, tags, and history.
 * Works are what quotes cite, linked to a Zotero item where there is one. Concepts belong to named
 * schemes and are keyed by internal ids, so a scheme or concept can be renamed without touching quotes.
 * A scheme followed from terminology-mcp (src/terminology.ts) is its replica: each concept carries its
 * term's stable id, and the slugs it had before, so old links still resolve.
 * zotero_items mirrors the Zotero libraries the import reads, so a re-run fetches only what changed.
 */

export type DB = Database.Database;

export const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS schemes (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS concepts (
  id INTEGER PRIMARY KEY, scheme_id INTEGER NOT NULL REFERENCES schemes(id), slug TEXT NOT NULL, label TEXT NOT NULL,
  alt_labels TEXT NOT NULL DEFAULT '[]', definition TEXT, close_match TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('provisional', 'confirmed', 'retired')),
  source TEXT, term_id TEXT, former_slugs TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (scheme_id, slug)
);
CREATE TABLE IF NOT EXISTS concept_relations (
  from_id INTEGER NOT NULL REFERENCES concepts(id), to_id INTEGER NOT NULL REFERENCES concepts(id),
  type TEXT NOT NULL CHECK (type IN ('broader', 'narrower', 'related', 'inverse')), PRIMARY KEY (from_id, to_id, type)
);

CREATE TABLE IF NOT EXISTS zotero_items (
  library TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, item_type TEXT NOT NULL, parent_key TEXT,
  deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, PRIMARY KEY (library, key)
);
CREATE INDEX IF NOT EXISTS zotero_items_type ON zotero_items (library, item_type);

CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]', year TEXT, item_type TEXT, isbn TEXT, url TEXT,
  zotero_library TEXT, zotero_key TEXT,
  -- zotero: a Zotero item; ambiguous: several items could be it; unmatched: not in Zotero yet.
  match TEXT NOT NULL CHECK (match IN ('zotero', 'ambiguous', 'unmatched')), candidates TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (zotero_library, zotero_key)
);
-- Where a work was seen: a Drupal node, a Zotero item (in any library).
CREATE TABLE IF NOT EXISTS work_origins (kind TEXT NOT NULL, ref TEXT NOT NULL, work_id INTEGER NOT NULL REFERENCES works(id), PRIMARY KEY (kind, ref));

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'quote' CHECK (kind IN ('quote', 'note')),
  work_id INTEGER REFERENCES works(id), text TEXT NOT NULL, text_key TEXT NOT NULL,
  locator_kind TEXT NOT NULL DEFAULT 'none' CHECK (locator_kind IN ('page', 'kindle', 'none')), locator TEXT, chapter_author TEXT,
  comment TEXT, attribution TEXT, source_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('transcribed', 'verified', 'unparsed')), grade TEXT, flags TEXT NOT NULL DEFAULT '[]',
  suspects TEXT NOT NULL DEFAULT '[]',
  -- Set once a person changes the quote: re-imports then leave it alone.
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL, updated_by TEXT
);
CREATE INDEX IF NOT EXISTS quotes_text_key ON quotes (text_key);
CREATE INDEX IF NOT EXISTS quotes_work ON quotes (work_id);
CREATE TABLE IF NOT EXISTS quote_origins (
  kind TEXT NOT NULL, ref TEXT NOT NULL, quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  version TEXT, raw TEXT NOT NULL, imported_at TEXT NOT NULL, PRIMARY KEY (kind, ref)
);
CREATE TABLE IF NOT EXISTS quote_tags (
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE, tag TEXT NOT NULL COLLATE NOCASE,
  concept_id INTEGER REFERENCES concepts(id), origin TEXT NOT NULL, PRIMARY KEY (quote_id, tag)
);
CREATE TABLE IF NOT EXISTS quote_kwic (
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE, phrase TEXT NOT NULL, tag TEXT NOT NULL,
  concept_id INTEGER REFERENCES concepts(id), PRIMARY KEY (quote_id, phrase, tag)
);
-- Every change to a quote. No foreign key, so a deleted quote keeps its history.
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY, quote_id INTEGER, at TEXT NOT NULL, kind TEXT NOT NULL, before TEXT, after TEXT, actor TEXT, reason TEXT
);
CREATE INDEX IF NOT EXISTS history_quote ON history (quote_id);

-- Rebuilt from quotes after every import; rowid is the quote id.
CREATE VIRTUAL TABLE IF NOT EXISTS quotes_fts USING fts5(text, comment, tags, tokenize = 'porter unicode61');
`;

export function openDb(path = process.env.QUOTE_DB ?? "data/quotes.db"): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version > SCHEMA_VERSION) throw new Error(`${path} has schema ${version}; this build knows ${SCHEMA_VERSION}.`);
  db.exec(SCHEMA);
  migrate(db);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** Brings a store made by an earlier schema up to date; a new store already has everything. */
function migrate(db: DB): void {
  const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  // 2: notes beside quotes.
  if (!columns("quotes").has("kind")) db.exec("ALTER TABLE quotes ADD COLUMN kind TEXT NOT NULL DEFAULT 'quote' CHECK (kind IN ('quote', 'note'))");
  // 3: concepts followed from terminology-mcp.
  const concepts = columns("concepts");
  if (!concepts.has("term_id")) db.exec("ALTER TABLE concepts ADD COLUMN term_id TEXT");
  if (!concepts.has("former_slugs")) db.exec("ALTER TABLE concepts ADD COLUMN former_slugs TEXT NOT NULL DEFAULT '[]'");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS concepts_term ON concepts (term_id)");
}

export function getMeta(db: DB, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

export const now = () => new Date().toISOString();
