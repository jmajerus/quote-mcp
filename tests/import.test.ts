import { beforeEach, describe, expect, it } from "vitest";
import { type DB, openDb } from "../src/db.js";
import type { DrupalSite } from "../src/drupal.js";
import { exportAll } from "../src/export.js";
import { type ImportOptions, runImport } from "../src/import.js";

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
  });

  it("imports a quote it can't split as unparsed, out of the way", () => {
    addItem(db, PRIMARY, "NOTE0004", note("ATTILA01", `<p>"First quote." (p. 3)</p><p>"Second quote." (p. 9)</p>`));
    runImport(db, opts());
    expect(quoteLike("First quote")).toMatchObject({ status: "unparsed", grade: "C" });
  });

  it("indexes quotes for full-text search", () => {
    runImport(db, opts());
    const hits = db.prepare("SELECT rowid FROM quotes_fts WHERE quotes_fts MATCH ?").pluck().all("enemies");
    expect(hits).toEqual([quoteLike("worst enemies").id]);
    expect(db.prepare("SELECT rowid FROM quotes_fts WHERE quotes_fts MATCH ?").pluck().all("tags:politics")).toEqual(hits);
  });
});
