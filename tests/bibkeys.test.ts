import { beforeEach, describe, expect, it } from "vitest";
import { auditOf } from "../src/audit.js";
import { canonicalizeCitekeys, citekeyResolver, resolveBiblioKey, type CitedWork } from "../src/bibkeys.js";
import { type DB, openDb } from "../src/db.js";
import { runImport } from "../src/import.js";

const book = (title: string, date: string, lastName: string, citationKey: string) => ({
  itemType: "book", title, date, citationKey, creators: [{ creatorType: "author", lastName, firstName: "A." }],
});

function addItem(db: DB, key: string, data: Record<string, unknown>) {
  db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES ('users/1', ?, 1, ?, NULL, 0, ?)")
    .run(key, data.itemType, JSON.stringify(data));
}

function addQuote(db: DB, text: string, comment: string, raw: string) {
  const { id } = db.prepare(`INSERT INTO quotes (text, text_key, comment, status, flags, created_at, updated_at)
    VALUES (?, ?, ?, 'transcribed', '[]', 't', 't') RETURNING id`).get(text, "k", comment) as { id: number };
  db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, raw, imported_at) VALUES ('drupal', '1#1', ?, ?, 't')").run(id, raw);
  return id;
}

let db: DB;
beforeEach(() => { db = openDb(":memory:"); });

describe("Better BibTeX citekeys", () => {
  const driving: CitedWork = { title: "Driving Fear Out of the Workplace", year: "1991", authors: ["Ryan, Kathleen"], citekey: "ryan1991driving" };
  const other: CitedWork = { title: "Some Other Ryan Book", year: "1991", authors: ["Ryan, Kathleen"], citekey: "ryan1991other" };

  it("uses the one current citekey that adds the title word", () => {
    expect(resolveBiblioKey("Ryan1991", [driving], [])).toBe("ryan1991driving");
    expect(resolveBiblioKey("Ryan1991", [driving, other], [])).toBeNull();
  });

  it("uses the catalogue title when the citekey is missing or ambiguous", () => {
    const row = { citekey: "Ryan1991", title: "Driving Fear Out of the Workplace: How to Overcome the Invisible Barriers", year: "1991", authors: ["Ryan, Kathleen"] };
    expect(resolveBiblioKey("Ryan1991", [driving], [row])).toBe("ryan1991driving");
    expect(resolveBiblioKey("Ryan1991", [driving, other], [row])).toBe("ryan1991driving");
    expect(resolveBiblioKey("Adams1996", [driving], [
      { citekey: "Adams1996", title: "One Book", year: "1996", authors: ["Adams, A."] },
      { citekey: "Adams1996", title: "Another Book", year: "1996", authors: ["Adams, B."] },
    ])).toBeNull();
  });

  it("rewrites stored markers, remembers the key, and leaves a duplicated key as itself", () => {
    addItem(db, "RYAN0001", book("Driving Fear Out of the Workplace", "1991", "Ryan", "ryan1991driving"));
    const id = addQuote(db, "People stay silent[bib]Ryan1991[/bib].", "See also [bib]Adams1996[/bib]",
      `<span class="quote">"People stay silent[bib]Ryan1991[/bib]."</span>\nSee also [bib]Adams1996[/bib]`);
    const dry = canonicalizeCitekeys(db, { dryRun: true });
    expect(dry).toMatchObject({ quotes: 1, resolved: 1, kept: 1 });
    expect(dry.keys).toEqual(expect.arrayContaining([{ from: "Ryan1991", to: "ryan1991driving", count: 1 }, { from: "Adams1996", to: "Adams1996", count: 1 }]));
    expect(db.prepare("SELECT text, comment FROM quotes WHERE id = ?").get(id)).toEqual({ text: "People stay silent[bib]Ryan1991[/bib].", comment: "See also [bib]Adams1996[/bib]" });

    const saved = canonicalizeCitekeys(db, {});
    expect(saved.quotes).toBe(1);
    expect(db.prepare("SELECT text, comment, edited FROM quotes WHERE id = ?").get(id)).toEqual({
      text: "People stay silent[@ryan1991driving].", comment: "See also [@Adams1996]", edited: 0,
    });
    expect(db.prepare("SELECT citekey FROM citekey_aliases WHERE biblio_key = 'Ryan1991'").pluck().get()).toBe("ryan1991driving");
    expect(db.prepare("SELECT kind, before, after FROM history WHERE quote_id = ? ORDER BY id").all(id)).toEqual([
      { kind: "citekeys", before: "People stay silent[bib]Ryan1991[/bib].", after: "People stay silent[@ryan1991driving]." },
      { kind: "citekeys", before: "See also [bib]Adams1996[/bib]", after: "See also [@Adams1996]" },
    ]);
    const audit = auditOf(db, id);
    expect(audit?.matches).toBe(true);
    expect(audit?.kinds).not.toContain("comment_differs");
    expect(canonicalizeCitekeys(db, {}).quotes).toBe(0);

    db.prepare("DELETE FROM zotero_items").run();
    expect(citekeyResolver(db)("Ryan1991")).toBe("ryan1991driving");
  });

  it("stores a citekey when a Zotero note is imported", () => {
    addItem(db, "RYAN0001", book("Driving Fear Out of the Workplace", "1991", "Ryan", "ryan1991driving"));
    addItem(db, "NOTE0001", { itemType: "note", parentItem: "RYAN0001", note: `<span class="quote">"People stay silent."</span>\nSee also [bib]Ryan1991[/bib]` });
    runImport(db, { primary: "users/1", sources: ["users/1"] });
    expect(db.prepare("SELECT comment FROM quotes WHERE text LIKE '%stay silent%'").pluck().get()).toBe("See also [@ryan1991driving]");
  });
});
