import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { type DB, SCHEMA_VERSION, openDb, openExisting } from "../src/db.js";
import { type DrupalSite, emptyFields, workFromRow } from "../src/drupal.js";
import { exportAll } from "../src/export.js";
import { holdingsCounts } from "../src/holdings.js";
import { searchQuotes } from "../src/queries.js";
import { type ImportOptions, runImport } from "../src/import.js";
import { fullTitle, normalizedTitle, shareAuthor, textOf } from "../src/text.js";

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
const opts = (more: Partial<ImportOptions> = {}): ImportOptions => ({ drupal: site(), primary: PRIMARY, sources: [PRIMARY, GROUP], dictionary: new Set(["an"]), ...more });
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
  it("imports the concept scheme with its relations", () => {
    const s = runImport(db, opts());
    expect(s.concepts).toEqual({ added: 3, relations: 2 });
    expect(db.prepare("SELECT slug, label FROM schemes").all()).toEqual([{ slug: "human-work", label: "The human side of work" }]);
    expect(db.prepare("SELECT slug FROM concepts ORDER BY slug").pluck().all()).toEqual(["fear", "job-loss", "power"]);
  });

  it("matches old-site works to Zotero items, and keeps the rest as works of their own", () => {
    runImport(db, opts());
    const attila = quoteLike("worst enemies");
    expect(db.prepare("SELECT match, zotero_library, zotero_key FROM works WHERE id = ?").get(attila.work_id)).toEqual({ match: "zotero", zotero_library: PRIMARY, zotero_key: "ATTILA01" });
    const community = quoteLike("respect and dignity");
    expect(db.prepare("SELECT match, title, isbn FROM works WHERE id = ?").get(community.work_id)).toEqual({ match: "unmatched", title: "Building Community: The Human Side of Work", isbn: "0-07-912345-6" });
  });

  it("splits a note into its quotes, resolving concepts and keeping kwic marks and outside text", () => {
    runImport(db, opts());
    const scapegoat = quoteLike("scapegoat");
    expect(scapegoat).toMatchObject({ locator_kind: "none", status: "transcribed" });
    expect(tagsOf(scapegoat.id)).toEqual([{ tag: "job loss", origin: "span", slug: "job-loss" }]);
    expect(db.prepare("SELECT phrase, tag FROM quote_kwic WHERE quote_id = ?").all(scapegoat.id)).toEqual([{ phrase: "scapegoat", tag: "job loss" }]);
    expect(quoteLike("respect and dignity").comment).toBe("See also [bib]Kantrow1988[/bib]");
  });

  it("merges the same quote from Zotero notes into one quote with every origin and tag", () => {
    const s = runImport(db, opts());
    const quote = quoteLike("worst enemies");
    expect(db.prepare("SELECT COUNT(*) FROM quotes WHERE text LIKE '%worst enemies%'").pluck().get()).toBe(1);
    expect(db.prepare("SELECT kind || ' ' || ref FROM quote_origins WHERE quote_id = ? ORDER BY kind, ref").pluck().all(quote.id))
      .toEqual(["drupal 10#1", `zotero-note ${GROUP}:NOTE0099`, `zotero-note ${PRIMARY}:NOTE0001`]);
    expect(tagsOf(quote.id)).toEqual([{ tag: "politics", origin: "note", slug: null }, { tag: "power", origin: "span", slug: "power" }]);
    expect(s.quotes).toMatchObject({ added: 5, merged: 2 });
    expect(quoteLike("pass through this world")).toMatchObject({ status: "transcribed", attribution: null });
    expect(s.skipped).toMatchObject({ "zotero note: other": 1 });
  });

  it("imports standalone quotes with their attribution, and resolves tags by alternative label", () => {
    addItem(db, PRIMARY, "NOTE0003", note("ATTILA01", `<p>"Power is the ability to act." (p. 9)</p>`, ["Authority"]));
    const s = runImport(db, opts());
    expect(quoteLike("gives comfort")).toMatchObject({ work_id: null, attribution: "Peter Barton, Not Fade Away" });
    expect(tagsOf(quoteLike("ability to act").id)).toEqual([{ tag: "Authority", origin: "note", slug: "power" }]);
    expect(s.unresolvedTags).toEqual([["dignity", 1], ["politics", 1]]);
  });

  it("changes nothing when run again", () => {
    runImport(db, opts());
    const before = JSON.stringify(exportAll(db).quotes);
    const s = runImport(db, opts());
    expect(s.quotes).toEqual({ added: 0, updated: 0, merged: 0, unchanged: 7, keptEdited: 0 });
    expect(JSON.stringify(exportAll(db).quotes)).toBe(before);
  });

  it("re-imports a changed note, but leaves a quote a person edited alone", () => {
    runImport(db, opts());
    addItem(db, PRIMARY, "NOTE0003", note("ATTILA01", `<p>"Leaders must earn trust." (p. 12)</p>`));
    runImport(db, opts());
    addItem(db, PRIMARY, "NOTE0003", note("ATTILA01", `<p>"Leaders must earn trust daily." (p. 12)</p>`), 2);
    expect(runImport(db, opts()).quotes.updated).toBe(1);
    expect(quoteLike("trust daily")).toBeTruthy();

    db.prepare("UPDATE quotes SET text = 'Leaders must earn trust, daily.', edited = 1 WHERE text LIKE '%trust daily%'").run();
    addItem(db, PRIMARY, "NOTE0003", note("ATTILA01", `<p>"Leaders must earn trust every day." (p. 12)</p>`), 3);
    expect(runImport(db, opts()).quotes.keptEdited).toBe(1);
    const kept = quoteLike("trust, daily");
    expect(kept).toBeTruthy();
    expect(db.prepare("SELECT kind FROM history WHERE quote_id = ? ORDER BY id DESC LIMIT 1").pluck().get(kept.id)).toBe("source_changed");
  });

  it("moves an old-site work's quotes to its Zotero item once it's filed", () => {
    runImport(db, opts());
    const old = quoteLike("respect and dignity").work_id;
    addItem(db, PRIMARY, "COMMUN01", book("Building community", "1996", "Manning"));
    runImport(db, opts());
    const moved = quoteLike("respect and dignity");
    expect(moved.work_id).not.toBe(old);
    expect(db.prepare("SELECT zotero_key FROM works WHERE id = ?").pluck().get(moved.work_id)).toBe("COMMUN01");
    expect(db.prepare("SELECT COUNT(*) FROM works WHERE id = ?").pluck().get(old)).toBe(0);
    // Its old id still names it, for holdings-mcp's quote:<id> key.
    expect(holdingsCounts(db).works.find((w) => w.work_id === moved.work_id)).toMatchObject({ match: "zotero", former_work_ids: [old] });
    expect(searchQuotes(db, { work: `quote:${old}` }).quotes.map((q) => q.id)).toContain(moved.id);
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
    runImport(db, opts({ drupal: s }));
    expect(db.prepare("SELECT zotero_key FROM works WHERE id = ?").pluck().get(quoteLike("groupthink").work_id)).toBe("IMAGES98");
    expect(db.prepare("SELECT zotero_key FROM works WHERE id = ?").pluck().get(quoteLike("bureaucratic").work_id)).toBe("IMAGES86");
  });

  describe("matching old-site works", () => {
    const work = (nid: number, title: string, year: string | null, authors: string[], words: string) => (
      { nid, title, type: "Book", year, isbn: null, url: null, citekey: null, authors, keywords: [], notes: `<span class="quote" title="power">"${words}" (p. 1)</span>` });
    const keyOf = (fragment: string) => db.prepare("SELECT zotero_key FROM works WHERE id = ?").pluck().get(quoteLike(fragment).work_id);
    const withWork = (...more: ReturnType<typeof work>[]) => {
      const s = site();
      s.works.push(...more);
      return opts({ drupal: s });
    };
    const LONG = "Everything worth saying has a long enough sentence";

    it("matches & to and, with a different subtitle", () => {
      addItem(db, PRIMARY, "SHAME001", book("Shame and guilt: the masters of disguise", "1992", "Bradshaw"));
      runImport(db, withWork(work(30, "Shame &amp; Guilt: Masters of Disguise", null, ["Bradshaw, John"], LONG)));
      expect(keyOf(LONG)).toBe("SHAME001");
    });

    it("tells editions apart by the year, and books with one title apart by the author", () => {
      addItem(db, PRIMARY, "EDITION1", book("Images of organization", "1986", "Morgan"));
      addItem(db, PRIMARY, "EDITION2", book("Images of organization", "2006", "Morgan"));
      addItem(db, PRIMARY, "OTHERONE", book("Images of organization", "2006", "Other"));
      runImport(db, withWork(work(31, "Images of Organization", "2006", ["Morgan, Gareth"], LONG)));
      expect(keyOf(LONG)).toBe("EDITION2");
    });

    it("stays ambiguous when nothing tells real editions apart", () => {
      addItem(db, PRIMARY, "EDITION1", book("Images of organization", "1986", "Morgan"));
      addItem(db, PRIMARY, "EDITION2", book("Images of organization", "2006", "Morgan"));
      runImport(db, withWork(work(31, "Images of Organization", null, ["Morgan, Gareth"], LONG)));
      const row = db.prepare("SELECT match, candidates FROM works WHERE id = ?").get(quoteLike(LONG).work_id);
      expect(row).toEqual({ match: "ambiguous", candidates: JSON.stringify(["EDITION1", "EDITION2"]) });
    });

    it("keeps a match when its title changes in Zotero or a second edition is filed, and lets it go when the item goes", () => {
      const o = withWork(work(32, "Maps of Meaning", null, ["Peterson, Jordan"], LONG));
      addItem(db, PRIMARY, "MAPS0001", book("Maps of meaning", "1999", "Peterson"));
      runImport(db, o);
      addItem(db, PRIMARY, "MAPS0001", book("Maps of meaning renamed", "1999", "Peterson"), 2);
      expect(runImport(db, o).workChanges).toEqual([]);
      expect(keyOf(LONG)).toBe("MAPS0001");
      addItem(db, PRIMARY, "MAPS0001", book("Maps of meaning", "1999", "Peterson"), 3);
      addItem(db, PRIMARY, "MAPS0002", book("Maps of meaning", "2002", "Peterson"));
      expect(runImport(db, o).workChanges).toEqual([]);
      expect(keyOf(LONG)).toBe("MAPS0001");
      db.prepare("UPDATE zotero_items SET deleted = 1 WHERE key = 'MAPS0001'").run();
      const { workChanges } = runImport(db, o);
      expect(workChanges).toEqual([{ title: "Maps of Meaning", from: "zotero MAPS0001", to: "zotero MAPS0002", quotes: 1 }]);
      expect(keyOf(LONG)).toBe("MAPS0002");
    });

    it("prefers the full title to the year, and doesn't move a match when a closer item appears", () => {
      addItem(db, PRIMARY, "EXEC0001", book("Images of organization: the executive edition", "1998", "Morgan"));
      addItem(db, PRIMARY, "PLAIN001", book("Images of organization", "2006", "Morgan"));
      const o = withWork(work(35, "Images of Organization: The Executive Edition", "2006", ["Morgan, Gareth"], LONG));
      runImport(db, o);
      expect(keyOf(LONG)).toBe("EXEC0001");
      addItem(db, PRIMARY, "EXACT001", book("Images of organization: the executive edition", "2006", "Morgan"));
      expect(runImport(db, o).workChanges).toEqual([]);
      expect(keyOf(LONG)).toBe("EXEC0001");
    });

    it("reports a match by title to a book with none of the work's authors, without undoing it", () => {
      addItem(db, PRIMARY, "SAMENAME", book("Leadership", "1978", "Burns"));
      const { authorMismatches } = runImport(db, withWork(work(33, "Leadership", null, ["Giuliani, Rudolph"], LONG)));
      expect(authorMismatches).toEqual([{ title: "Leadership", authors: ["Giuliani, Rudolph"], zotero: "SAMENAME", creators: ["Burns, A."] }]);
      expect(keyOf(LONG)).toBe("SAMENAME");
    });

    it("reports a match to an item with no authors, when the work has some", () => {
      addItem(db, PRIMARY, "NOBODY01", { itemType: "book", title: "Unsigned", date: "2000" });
      const { authorMismatches } = runImport(db, withWork(work(36, "Unsigned", null, ["Doe, Jane"], LONG), work(37, "Unsigned", null, [], "Another sentence that is long enough to count")));
      expect(authorMismatches).toEqual([{ title: "Unsigned", authors: ["Doe, Jane"], zotero: "NOBODY01", creators: [] }]);
    });

    it("reports what a dry run would move, and leaves everything as it was", () => {
      const o = withWork(work(34, "Later Filed", null, [], LONG));
      runImport(db, o);
      const dump = () => JSON.stringify([db.prepare("SELECT * FROM works ORDER BY id").all(), db.prepare("SELECT id, work_id FROM quotes ORDER BY id").all(), db.prepare("SELECT COUNT(*) FROM history").pluck().get()]);
      addItem(db, PRIMARY, "LATER001", book("Later filed", "2000", "Anyone"));
      const before = dump();
      const { workChanges } = runImport(db, { ...o, dryRun: true });
      expect(workChanges).toEqual([{ title: "Later Filed", from: "unmatched", to: "zotero LATER001", quotes: 1 }]);
      expect(dump()).toBe(before);
    });
  });

  describe("reading the old site's columns", () => {
    const row = (biblio_year: unknown) => ({ nid: 1, title: "T", type: "Book", biblio_year, biblio_isbn: null, biblio_url: null, biblio_citekey: null, biblio_notes: null });

    it("reads a year however the column gives it, and turns down placeholders", () => {
      expect(workFromRow(row(1996)).year).toBe("1996");
      expect(workFromRow(row("1996")).year).toBe("1996");
      expect(workFromRow(row(Buffer.from("1996"))).year).toBe("1996");
      for (const none of [9999, 9998, 0, null, ""]) expect(workFromRow(row(none)).year).toBeNull();
    });

    it("stops on a value it can't read, rather than taking it for nothing", () => {
      expect(textOf(" x ")).toBe("x");
      expect(textOf(12n)).toBe("12");
      expect(textOf("  ")).toBeNull();
      expect(() => workFromRow(row(new Date(0)))).toThrow(/Expected text, and found \[object Date\]/);
    });

    it("notices a field no work has", () => {
      expect(emptyFields([workFromRow(row(null))])).toEqual(["year", "authors"]);
      expect(emptyFields([workFromRow(row(1996), ["A"]), workFromRow(row(null))])).toEqual([]);
      expect(emptyFields([])).toEqual([]);
    });
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
    runImport(db, opts());
    expect(quoteLike("First quote")).toMatchObject({ status: "unparsed", grade: "C" });
  });

  it("imports a Zotero note tagged margin as a note, reading concepts out of its words", () => {
    addItem(db, PRIMARY, "MARGIN01", note("ATTILA01", `<p>power, job loss — he means layoffs as discipline (p. 51)</p>`, ["margin", "politics"]));
    addItem(db, PRIMARY, "MARGIN02", note("ATTILA01", `<p>fear; .job-loss</p>`, ["Margin"]));
    addItem(db, PRIMARY, "MARGIN03", note("ATTILA01", `<p></p>`, ["margin"]));
    const s = runImport(db, opts());
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
    runImport(db, opts());
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
