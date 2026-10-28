-- The public snapshot's schema (src/snapshot.ts SNAPSHOT_SCHEMA), for its replica in D1. A test keeps the two the same.
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
