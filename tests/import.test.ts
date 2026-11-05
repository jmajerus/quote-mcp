import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { type DB, SCHEMA_VERSION, openDb, openExisting } from "../src/db.js";
import { type DrupalSite, importWithSite } from "./seed.js";
import { exportAll } from "../src/export.js";
import { searchQuotes } from "../src/queries.js";
import { runImport } from "../src/import.js";
import { fullTitle, normalizedTitle, shareAuthor } from "../src/text.js";

const PRIMARY = "users/1";
const GROUP = "groups/2";

function site(): DrupalSite {
  return {
    concepts: [
      { kid: 1, word: "power", altLabels: ["authority"], definition: "possession of controlling influence", closeMatch: "http://wordnet/power" },
      { kid: 2, word: "job loss", altLabels: [], definition: null, closeMatch: null },
      { kid: 3, word: "fear", altLabels: [], definition: null, closeMatch: null },
    ],
    relations: [{ from: "job loss", to: "fear", type: "R" }, { from: "power", to: "fear", type: "N" }],
    works: [
      {
        nid: 10, title: "Victory Secrets of Attila the Hun", type: "Book", year: "1993", isbn: null, url: null, citekey: "Roberts1993", authors: ["Roberts, Wess"], keywords: ["power"],
        notes: `<span class="quote" title="power">\n"An organization's worst enemies are seldom external." (p. 44)\n</span>\n\n<span class="quote" title="job loss">\n"They are quick to find a <span class="kwic" title="job loss">scapegoat</span> when they make even a minor mistake."\n</span>`,
      },
      {
        nid: 11, title: "Building Community: The Human Side of Work", type: "Book", year: "1996", isbn: "0-07-912345-6", url: null, citekey: "Manning1996", authors: ["Manning, George"], keywords: [],
        notes: `<span class="quote" title="dignity">\n"What is consistent is that all people are treated with respect and dignity."\n</span>\nSee also [bib]Kantrow1988[/bib]`,
      },
      { nid: 12, title: "No quotes here", type: "Book", year: null, isbn: null, url: null, citekey: null, authors: [], keywords: [], notes: "" },
    ],
    quotes: [
      { nid: 50, title: "Comfort", body: `"I've come to feel that nothing which <span class="kwic" title="fear">gives comfort</span> should ever be despised."`, author: "Peter Barton", citation: "Not Fade Away" },
      { nid: 51, title: "Any kindness", body: "I expect to pass through this world but once.", author: null, citation: null },
    ],
  };
}

function addItem(db: DB, library: string, key: string, data: Record<string, unknown>, version = 1) {
  db.prepare("INSERT OR REPLACE INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .run(library, key, version, data.itemType, (data.parentItem as string) ?? null, JSON.stringify(data));
}

const book = (title: string, date: string, lastName: string) => ({ itemType: "book", title, date, creators: [{ creatorType: "author", lastName, firstName: "A." }] });
const note = (parentItem: string, html: string, tags: string[] = []) => ({ itemType: "note", parentItem, note: html, tags: tags.map((tag) => ({ tag })) });

let db: DB;
const opts = (more: Partial<Parameters<typeof importWithSite>[1]> = {}) => ({ drupal: site(), primary: PRIMARY, sources: [PRIMARY, GROUP], dictionary: new Set(["an"]), ...more });
const quoteLike = (fragment: string) => db.prepare("SELECT * FROM quotes WHERE text LIKE ?").get(`%${fragment}%`) as Record<string, unknown>;
const tagsOf = (id: unknown) => db.prepare("SELECT t.tag, t.origin, c.slug FROM quote_tags t LEFT JOIN concepts c ON c.id = t.concept_id WHERE quote_id = ? ORDER BY tag").all(id);

beforeEach(() => {
  db = openDb(":memory:");
  addItem(db, PRIMARY, "ATTILA01", book("Victory secrets of Attila the Hun", "1993", "Roberts"));
  addItem(db, PRIMARY, "NOTE0001", note("ATTILA01", `<p><span class="quote" title="power"> "An organization's worst enemies are seldom external." (p. 44) </span></p>`, ["power", "politics"]));
  addItem(db, PRIMARY, "NOTE0002", note("ATTILA01", `<p>Standard historical account. [VERIFY: confirm publisher details.]</p>`));
  addItem(db, GROUP, "ATTILA99", book("Victory Secrets of Attila the Hun", "1993", "Roberts"));
  addItem(db, GROUP, "NOTE0099", note("ATTILA99", `<p><span class="quote" title="power"> "An organization's worst enemies are seldom external." (p. 44) </span></p>`));
});

describe("import", () => {
  it("merges the same quote from Zotero notes into one quote with every origin and tag", () => {
    const s = importWithSite(db, opts());
    const quote = quoteLike("worst enemies");
    expect(db.prepare("SELECT COUNT(*) FROM quotes WHERE text LIKE '%worst enemies%'").pluck().get()).toBe(1);
    expect(db.prepare("SELECT kind || ' ' || ref FROM quote_origins WHERE quote_id = ? ORDER BY kind, ref").pluck().all(quote.id))
      .toEqual(["drupal 10#1", `zotero-note ${GROUP}:NOTE0099`, `zotero-note ${PRIMARY}:NOTE0001`]);
    expect(tagsOf(quote.id)).toEqual([{ tag: "politics", origin: "note", slug: null }, { tag: "power", origin: "span", slug: "power" }]);
    expect(s.quotes).toMatchObject({ added: 0, merged: 2 });
    expect(quoteLike("pass through this world")).toMatchObject({ status: "transcribed", attribution: null });
    expect(s.skipped).toMatchObject({ "zotero note: other": 1 });
  });

  it("imports standalone quotes with their attribution, and resolves tags by alternative label", () => {
    addItem(db, PRIMARY, "NOTE0003", note("ATTILA01", `<p>"Power is the ability to act." (p. 9)</p>`, ["Authority"]));
    const s = importWithSite(db, opts());
    expect(quoteLike("gives comfort")).toMatchObject({ work_id: null, attribution: "Peter Barton, Not Fade Away" });
    expect(tagsOf(quoteLike("ability to act").id)).toEqual([{ tag: "Authority", origin: "note", slug: "power" }]);
    expect(s.unresolvedTags).toEqual([["dignity", 1], ["politics", 1]]);
  });

  it("changes nothing when run again", () => {
    importWithSite(db, opts());
    const before = JSON.stringify(exportAll(db).quotes);
    const s = importWithSite(db, opts());
    expect(s.quotes).toEqual({ added: 0, updated: 0, merged: 0, unchanged: 2, keptEdited: 0 });
    expect(JSON.stringify(exportAll(db).quotes)).toBe(before);
  });

  it("re-imports a changed note, but leaves a quote a person edited alone", () => {
    importWithSite(db, opts());
    addItem(db, PRIMARY, "NOTE0003", note("ATTILA01", `<p>"Leaders must earn trust." (p. 12)</p>`));
    importWithSite(db, opts());
    addItem(db, PRIMARY, "NOTE0003", note("ATTILA01", `<p>"Leaders must earn trust daily." (p. 12)</p>`), 2);
    expect(importWithSite(db, opts()).quotes.updated).toBe(1);
    expect(quoteLike("trust daily")).toBeTruthy();

    db.prepare("UPDATE quotes SET text = 'Leaders must earn trust, daily.', edited = 1 WHERE text LIKE '%trust daily%'").run();
    addItem(db, PRIMARY, "NOTE0003", note("ATTILA01", `<p>"Leaders must earn trust every day." (p. 12)</p>`), 3);
    expect(importWithSite(db, opts()).quotes.keptEdited).toBe(1);
    const kept = quoteLike("trust, daily");
    expect(kept).toBeTruthy();
    expect(db.prepare("SELECT kind FROM history WHERE quote_id = ? ORDER BY id DESC LIMIT 1").pluck().get(kept.id)).toBe("source_changed");
  });

  it("tells editions apart by the full title when the short title repeats", () => {
    addItem(db, PRIMARY, "IMAGES86", book("Images of organization", "1986", "Morgan"));
    addItem(db, PRIMARY, "IMAGES98", book("Images of organization: the executive edition", "1998", "Morgan"));
    const s = site();
    s.works.push(
      { nid: 20, title: "Images of Organization: The Executive Edition", type: "Book", year: null, isbn: null, url: null, citekey: null, authors: [], keywords: [],
        notes: `<span class="quote" title="power">"The groupthink phenomenon has been reproduced in thousands of situations." (p. 186)</span>` },
      { nid: 21, title: "Images of Organization", type: "Book", year: null, isbn: null, url: null, citekey: null, authors: [], keywords: [],
        notes: `<span class="quote" title="power">"We should be alert to the bureaucratic form of organization." (p. 209)</span>` },
    );
    importWithSite(db, opts({ drupal: s }));
    expect(db.prepare("SELECT zotero_key FROM works WHERE id = ?").pluck().get(quoteLike("groupthink").work_id)).toBe("IMAGES98");
    expect(db.prepare("SELECT zotero_key FROM works WHERE id = ?").pluck().get(quoteLike("bureaucratic").work_id)).toBe("IMAGES86");
  });

  describe("comparing titles and authors", () => {
    it("treats & and and alike, however it's written", () => {
      for (const t of ["Shame & Guilt", "Shame &amp; Guilt", "Shame and Guilt", "SHAME AND GUILT: x"]) expect(normalizedTitle(t)).toBe("shame and guilt");
      expect(fullTitle("Shame & Guilt: x")).toBe(fullTitle("shame and guilt x"));
      expect(normalizedTitle("Previews &#38; Premises &#x26; More")).toBe("previews and premises and more");
      expect(normalizedTitle("Work &bogus; x &#99999999; y")).toBe("work and bogus x y");
      expect(normalizedTitle("Caf&eacute; &ldquo;Life&rdquo;")).toBe("cafe life");
      expect(normalizedTitle("Work &ndash; why")).toBe("work");
      expect(normalizedTitle("AT&T and Me")).toBe("at and t and me");
      expect(shareAuthor(["O&#039;Neil, Judy"], ["O'Neil, Judy"])).toBe(true);
    });

    it("leaves off a subtitle however it's set off, but not at an abbreviation", () => {
      for (const t of ["Work: why", "Work? Why", "Work! Why", "Work - why", "Work – why", "Work — why", "Work—why", "Work. Why"]) expect(normalizedTitle(t)).toBe("work");
      expect(normalizedTitle("Dr. Spock: a life")).toBe("dr spock");
      expect(normalizedTitle("U.S. Labor History")).toBe("u s labor history");
      expect(normalizedTitle("Work-Life Balance")).toBe("work life balance");
    });

    it("drops a leading article even after a quotation mark, and keeps a title that's all subtitle", () => {
      expect(normalizedTitle("\u201cThe Fear of Work\u201d")).toBe("fear of work");
      expect(normalizedTitle("?: Why")).toBe("why");
    });

    it("compares authors by surname, in either order of name", () => {
      expect(shareAuthor(["Morgan, Gareth"], ["Gareth Morgan"])).toBe(true);
      expect(shareAuthor(["Morgan, G."], ["Other, A.", "Morgan, Gareth"])).toBe(true);
      expect(shareAuthor(["Morgan, Gareth"], ["Burns, James"])).toBe(false);
      expect(shareAuthor([], ["Burns, James"])).toBe(false);
    });
  });

  it("imports a quote it can't split as unparsed, out of the way", () => {
    addItem(db, PRIMARY, "NOTE0004", note("ATTILA01", `<p>"First quote." (p. 3)</p><p>"Second quote." (p. 9)</p>`));
    importWithSite(db, opts());
    expect(quoteLike("First quote")).toMatchObject({ status: "unparsed", grade: "C" });
  });

  it("imports a Zotero note tagged margin as a note, reading concepts out of its words", () => {
    addItem(db, PRIMARY, "MARGIN01", note("ATTILA01", `<p>power, job loss — he means layoffs as discipline (p. 51)</p>`, ["margin", "politics"]));
    addItem(db, PRIMARY, "MARGIN02", note("ATTILA01", `<p>fear; .job-loss</p>`, ["Margin"]));
    addItem(db, PRIMARY, "MARGIN03", note("ATTILA01", `<p></p>`, ["margin"]));
    const s = importWithSite(db, opts());
    const prose = db.prepare("SELECT * FROM quotes WHERE comment LIKE '%layoffs%'").get() as Record<string, unknown>;
    expect(prose).toMatchObject({ kind: "note", text: "", comment: "he means layoffs as discipline", locator_kind: "page", locator: "51", grade: null, flags: "[]" });
    expect(tagsOf(prose.id)).toEqual([
      { tag: "job loss", origin: "text", slug: "job-loss" }, { tag: "politics", origin: "note", slug: null }, { tag: "power", origin: "text", slug: "power" },
    ]);
    const tagsOnly = db.prepare("SELECT q.* FROM quotes q JOIN quote_origins o ON o.quote_id = q.id WHERE o.ref = ?").get(`${PRIMARY}:MARGIN02`) as Record<string, unknown>;
    expect(tagsOnly).toMatchObject({ kind: "note", comment: null, locator_kind: "none" });
    expect(tagsOf(tagsOnly.id)).toEqual([{ tag: "fear", origin: "text", slug: "fear" }, { tag: "job loss", origin: "text", slug: "job-loss" }]);
    expect(s.skipped).toMatchObject({ "zotero margin note: empty": 1, "zotero note: other": 1 });
    expect(db.prepare("SELECT rowid FROM quotes_fts WHERE quotes_fts MATCH ?").pluck().all("layoffs")).toEqual([prose.id]);
  });

  it("indexes quotes for full-text search", () => {
    importWithSite(db, opts());
    const hits = db.prepare("SELECT rowid FROM quotes_fts WHERE quotes_fts MATCH ?").pluck().all("enemies");
    expect(hits).toEqual([quoteLike("worst enemies").id]);
    expect(db.prepare("SELECT rowid FROM quotes_fts WHERE quotes_fts MATCH ?").pluck().all("tags:politics")).toEqual(hits);
  });
});

describe("schema", () => {
  it("leaves a store alone for a dry run: it won't create one or migrate one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "quote-mcp-existing-"));
    try {
      const file = path.join(dir, "quotes.db");
      expect(() => openExisting(file)).toThrow();
      expect(existsSync(file)).toBe(false);
      openDb(file).close();
      openExisting(file).close();
      const old = new Database(file);
      old.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
      old.close();
      expect(() => openExisting(file)).toThrow(/Run migrate first/);
      const after = new Database(file, { readonly: true });
      expect(after.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION - 1);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds kind to a store made before notes, keeping its quotes as quotes", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/quote-mcp-v1-${process.pid}.db`;
    const v1 = new Database(path);
    v1.exec(`CREATE TABLE quotes (id INTEGER PRIMARY KEY, work_id INTEGER, text TEXT NOT NULL, text_key TEXT NOT NULL,
      locator_kind TEXT NOT NULL DEFAULT 'none', locator TEXT, chapter_author TEXT, comment TEXT, attribution TEXT, source_url TEXT,
      status TEXT NOT NULL, grade TEXT, flags TEXT NOT NULL DEFAULT '[]', suspects TEXT NOT NULL DEFAULT '[]', edited INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL, updated_by TEXT);
      INSERT INTO quotes (text, text_key, status, created_at, updated_at) VALUES ('Old quote', 'oldquote', 'transcribed', 'then', 'then');
      PRAGMA user_version = 1;`);
    v1.close();
    const migrated = openDb(path);
    expect(migrated.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(migrated.prepare("SELECT kind, text FROM quotes").get()).toEqual({ kind: "quote", text: "Old quote" });
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  });
});
