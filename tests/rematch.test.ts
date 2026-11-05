import { beforeEach, describe, expect, it } from "vitest";
import { type DB, openDb } from "../src/db.js";
import type { DrupalSite } from "../src/drupal.js";
import { holdingsCounts } from "../src/holdings.js";
import { runImport } from "../src/import.js";
import { rematchWorks, takeOldSiteYears } from "../src/rematch.js";
import { searchQuotes } from "../src/queries.js";

const PRIMARY = "users/1";
const WORDS = "Everything worth saying has a long enough sentence";

const book = (title: string, date: string, lastName: string) => ({ itemType: "book", title, date, creators: [{ creatorType: "author", lastName, firstName: "A." }] });
function addItem(db: DB, key: string, data: Record<string, unknown>, deleted = 0) {
  db.prepare("INSERT OR REPLACE INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, ?, NULL, ?, ?)").run(PRIMARY, key, data.itemType, deleted, JSON.stringify(data));
}
const site = (title: string, authors = ["Morgan, Gareth"]): DrupalSite => ({
  concepts: [], relations: [], quotes: [],
  works: [{ nid: 5, title, type: "Book", year: null, isbn: null, url: null, citekey: null, authors, keywords: [], notes: `<span class="quote" title="x">"${WORDS}" (p. 1)</span>` }],
});

let db: DB;
const work = () => db.prepare("SELECT w.* FROM works w JOIN quotes q ON q.work_id = w.id LIMIT 1").get() as Record<string, unknown>;
const load = (title: string, authors?: string[]) => runImport(db, { drupal: site(title, authors), primary: PRIMARY, sources: [PRIMARY] });
const rematch = (dryRun = false) => rematchWorks(db, { primary: PRIMARY, dryRun });
const dump = () => JSON.stringify([db.prepare("SELECT * FROM works ORDER BY id").all(), db.prepare("SELECT id, work_id, updated_at FROM quotes ORDER BY id").all(),
  db.prepare("SELECT * FROM work_origins ORDER BY kind, ref").all(), db.prepare("SELECT COUNT(*) FROM history").pluck().get()]);

beforeEach(() => {
  db = openDb(":memory:");
  addItem(db, "SOMEBOOK", book("Something else entirely", "2000", "Nobody"));
});

describe("rematching works", () => {
  it("matches a work filed since, keeping the quote's id, recording the move, and keeping the old id resolvable", () => {
    load("Images of Organization");
    const { id: old } = work();
    const quote = db.prepare("SELECT id FROM quotes").pluck().get() as number;
    addItem(db, "IMAGES01", book("Images of organization", "1986", "Morgan"));
    const r = rematch();
    expect(r.changes).toEqual([{ work: old, title: "Images of Organization", from: "unmatched", to: "zotero IMAGES01", quotes: 1 }]);
    expect(work()).toMatchObject({ match: "zotero", zotero_key: "IMAGES01", title: "Images of organization" });
    expect(db.prepare("SELECT id FROM quotes").pluck().get()).toBe(quote);
    expect(db.prepare("SELECT COUNT(*) FROM works WHERE id = ?").pluck().get(old)).toBe(0);
    expect(db.prepare("SELECT kind, reason FROM history WHERE quote_id = ? ORDER BY id DESC LIMIT 1").get(quote)).toEqual({ kind: "work_matched", reason: "matched by rematch: unmatched became zotero IMAGES01" });
    expect(searchQuotes(db, { work: `quote:${old}` }).quotes.map((q) => q.id)).toContain(quote);
    expect(holdingsCounts(db).works.find((w) => w.match === "zotero" && w.work_id === work().id)).toMatchObject({ former_work_ids: [old] });
    expect(rematch().changes).toEqual([]);
  });

  it("settles an ambiguous work by the year once it has one, and by a merge without one", () => {
    addItem(db, "EDITION1", book("Images of organization", "1986", "Morgan"));
    addItem(db, "EDITION2", book("Images of organization", "2006", "Morgan"));
    load("Images of Organization");
    expect(work()).toMatchObject({ match: "ambiguous", year: null });
    expect(rematch().changes).toEqual([]);
    takeOldSiteYears(db, [{ nid: 5, year: "2006" }]);
    expect(rematch().changes).toMatchObject([{ from: "ambiguous", to: "zotero EDITION2" }]);
    expect(work()).toMatchObject({ zotero_key: "EDITION2" });
  });

  it("settles an ambiguous work when duplicates are merged in Zotero", () => {
    addItem(db, "EDITION1", book("Images of organization", "1986", "Morgan"));
    addItem(db, "EDITION2", book("Images of organization", "2006", "Morgan"));
    load("Images of Organization");
    addItem(db, "EDITION1", book("Images of organization", "1986", "Morgan"), 1);
    expect(rematch().changes).toMatchObject([{ from: "ambiguous", to: "zotero EDITION2" }]);
  });

  it("updates an ambiguous work's candidates, and makes it unmatched when none are left", () => {
    addItem(db, "EDITION1", book("Images of organization", "1986", "Morgan"));
    addItem(db, "EDITION2", book("Images of organization", "2006", "Morgan"));
    load("Images of Organization");
    addItem(db, "EDITION3", book("Images of organization", "2010", "Morgan"));
    expect(rematch().changes).toEqual([]);
    expect(JSON.parse(work().candidates as string)).toHaveLength(3);
    for (const k of ["EDITION1", "EDITION2", "EDITION3"]) addItem(db, k, book("Images of organization", "1986", "Morgan"), 1);
    expect(rematch().changes).toMatchObject([{ from: "ambiguous", to: "unmatched" }]);
    expect(work()).toMatchObject({ match: "unmatched", candidates: null });
  });

  it("leaves a match alone while its item is there, whatever its title has become", () => {
    addItem(db, "IMAGES01", book("Images of organization", "1986", "Morgan"));
    load("Images of Organization");
    addItem(db, "IMAGES01", book("Renamed in Zotero", "1986", "Morgan"));
    addItem(db, "IMAGES02", book("Images of organization", "2006", "Morgan"));
    const before = dump();
    expect(rematch()).toMatchObject({ checked: 0, changes: [] });
    expect(dump()).toBe(before);
  });

  it("matches a work again when its item goes, to its merged twin or to nothing", () => {
    addItem(db, "IMAGES01", book("Images of organization", "1986", "Morgan"));
    load("Images of Organization");
    addItem(db, "IMAGES02", book("Images of organization", "1986", "Morgan"));
    addItem(db, "IMAGES01", book("Images of organization", "1986", "Morgan"), 1);
    expect(rematch().changes).toMatchObject([{ from: "zotero IMAGES01", to: "zotero IMAGES02", quotes: 1 }]);
    addItem(db, "IMAGES02", book("Images of organization", "1986", "Morgan"), 1);
    expect(rematch().changes).toMatchObject([{ from: "zotero IMAGES02", to: "unmatched" }]);
    expect(work()).toMatchObject({ match: "unmatched", zotero_library: null, zotero_key: null, title: "Images of organization" });
  });

  it("matches a work again when its item goes from a secondary library", () => {
    const GROUP = "groups/2";
    db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, 'GROUP001', 1, 'book', NULL, 0, ?)").run(GROUP, JSON.stringify(book("In a group", "2001", "Morgan")));
    db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, 'NOTE0001', 1, 'note', 'GROUP001', 0, ?)")
      .run(GROUP, JSON.stringify({ itemType: "note", parentItem: "GROUP001", note: `<p><span class="quote" title="x">"${WORDS}" (p. 1)</span></p>`, tags: [] }));
    runImport(db, { primary: PRIMARY, sources: [PRIMARY, GROUP] });
    expect(work()).toMatchObject({ zotero_library: GROUP, zotero_key: "GROUP001" });
    expect(rematch()).toMatchObject({ checked: 0, updated: false });
    db.prepare("UPDATE zotero_items SET deleted = 1 WHERE key = 'GROUP001'").run();
    expect(rematch().changes).toMatchObject([{ from: "zotero GROUP001", to: "unmatched", quotes: 1 }]);
    expect(work()).toMatchObject({ match: "unmatched", zotero_library: null, zotero_key: null });
  });

  it("says it wrote something when only an ambiguous work's candidates changed, and not when nothing did", () => {
    addItem(db, "EDITION1", book("Images of organization", "1986", "Morgan"));
    addItem(db, "EDITION2", book("Images of organization", "2006", "Morgan"));
    load("Images of Organization");
    expect(rematch()).toMatchObject({ changes: [], updated: false });
    addItem(db, "EDITION3", book("Images of organization", "2010", "Morgan"));
    expect(rematch()).toMatchObject({ changes: [], updated: true });
    expect(rematch()).toMatchObject({ changes: [], updated: false });
  });

  it("doesn't take an item the mirror has never seen for a deleted one", () => {
    addItem(db, "IMAGES01", book("Images of organization", "1986", "Morgan"));
    load("Images of Organization");
    db.prepare("DELETE FROM zotero_items WHERE key = 'IMAGES01'").run();
    expect(rematch()).toMatchObject({ checked: 0, changes: [] });
  });

  it("stops on an empty mirror, which would read as everything gone", () => {
    load("Images of Organization");
    db.prepare("DELETE FROM zotero_items").run();
    expect(() => rematch()).toThrow(/no items for users\/1/);
  });

  it("reports a match with no author in common, or no authors, and matches it anyway", () => {
    addItem(db, "SAMENAME", book("Leadership", "1978", "Burns"));
    load("Other Name", ["Giuliani, Rudolph"]);
    db.prepare("UPDATE works SET title = 'Leadership' WHERE match = 'unmatched'").run();
    expect(rematch().authorMismatches).toEqual([{ title: "Leadership", authors: ["Giuliani, Rudolph"], zotero: "SAMENAME", creators: ["Burns, A."] }]);
    expect(work()).toMatchObject({ zotero_key: "SAMENAME" });
  });

  it("reports the same in a dry run, and saves nothing", () => {
    load("Images of Organization");
    addItem(db, "IMAGES01", book("Images of organization", "1986", "Morgan"));
    const before = dump();
    const r = rematch(true);
    expect(r.changes).toMatchObject([{ from: "unmatched", to: "zotero IMAGES01" }]);
    expect(r.works).toEqual({ zotero: 1 });
    expect(dump()).toBe(before);
  });
});

describe("taking the old site's years", () => {
  it("fills an empty year on a work with its own details, and nothing else", () => {
    load("Images of Organization");
    const nid = [{ nid: 5, year: "2006" }, { nid: 6, year: "1999" }, { nid: 7, year: null }];
    const dry = takeOldSiteYears(db, nid, { dryRun: true });
    expect(dry).toEqual({ read: 3, withYear: 2, filled: 1, alreadySet: 0, matched: 0, notHere: 1 });
    expect(work().year).toBeNull();
    expect(takeOldSiteYears(db, nid).filled).toBe(1);
    expect(work().year).toBe("2006");
    expect(takeOldSiteYears(db, [{ nid: 5, year: "1990" }])).toMatchObject({ filled: 0, alreadySet: 1 });
    expect(work().year).toBe("2006");
  });

  it("leaves a matched work with its item's year", () => {
    addItem(db, "IMAGES01", book("Images of organization", "1986", "Morgan"));
    load("Images of Organization");
    expect(takeOldSiteYears(db, [{ nid: 5, year: "2006" }])).toMatchObject({ filled: 0, matched: 1 });
    expect(work().year).toBe("1986");
  });

  it("stops if no year could be read", () => {
    load("Images of Organization");
    expect(() => takeOldSiteYears(db, [{ nid: 5, year: null }])).toThrow(/Has a column changed/);
    expect(takeOldSiteYears(db, []).read).toBe(0);
  });
});
