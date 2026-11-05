import { beforeEach, describe, expect, it } from "vitest";
import { auditOf, auditStore } from "../src/audit.js";
import { type DB, openDb } from "../src/db.js";
import { runImport } from "../src/import.js";
import { searchQuotes } from "../src/queries.js";
import { repairQuotes } from "../src/repair.js";

let db: DB;
let n = 0;
function record(fields: { text: string; locator?: string | null; comment?: string | null; status?: string; edited?: number; flags?: string[] }, raw: string, kind = "drupal", ref?: string) {
  const id = ++n;
  db.prepare(`INSERT INTO quotes (id, kind, text, text_key, locator_kind, locator, comment, status, flags, edited, created_at, created_by, updated_at, updated_by)
    VALUES (?, 'quote', ?, '', ?, ?, ?, ?, ?, ?, 'then', 'import', 'then', 'import')`).run(id, fields.text, fields.locator ? "page" : "none", fields.locator ?? null, fields.comment ?? null, fields.status ?? "transcribed", JSON.stringify(fields.flags ?? []), fields.edited ?? 0);
  db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES (?, ?, ?, NULL, ?, 'then')").run(kind, ref ?? `${id}#1`, id, raw);
  db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, 'then', 'imported', NULL, ?, 'import', 'from the source')").run(id, raw);
  return id;
}
const span = (s: string) => `<span class="quote">${s}</span>`;
const quote = (id: number) => db.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as Record<string, unknown>;
const historyOf = (id: number) => db.prepare("SELECT kind FROM history WHERE quote_id = ? ORDER BY id").pluck().all(id);
const dump = () => JSON.stringify(["quotes", "quote_origins", "quote_tags", "quote_kwic", "history"].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));

const MERGED = `"For instance, recurring conflicts are about powerlessness." (p. 224)\n"A second hidden source of conflict are affronts to self-esteem." (p. 225)`;
const merged = () => record({ text: `For instance, recurring conflicts are about powerlessness." (p. 224)\n"A second hidden source of conflict are affronts to self-esteem.`, locator: "225", status: "unparsed", flags: ["ocr_suspect"] }, span(MERGED));

beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
});

describe("splitting a merged record (#89)", () => {
  it("keeps the id for the first passage, and makes a new quote for the next, each with its page", () => {
    const id = merged();
    const { repairs } = repairQuotes(db);
    expect(repairs).toHaveLength(1);
    expect(quote(id)).toMatchObject({ text: "For instance, recurring conflicts are about powerlessness.", locator: "224", status: "transcribed" });
    expect(JSON.parse(quote(id).flags as string)).toContain("ocr_suspect");
    const [other] = repairs[0].newIds;
    expect(quote(other)).toMatchObject({ text: "A second hidden source of conflict are affronts to self-esteem.", locator: "225", status: "transcribed", created_at: "then", created_by: "import", updated_by: "repair" });
  });

  it("gives the new part the tags, history, and work, and links it back", () => {
    db.prepare("INSERT INTO works (id, title, match, created_at, updated_at) VALUES (9, 'A Work', 'unmatched', 'x', 'x')").run();
    const id = merged();
    db.prepare("UPDATE quotes SET work_id = 9 WHERE id = ?").run(id);
    db.prepare("INSERT INTO quote_tags (quote_id, tag, origin) VALUES (?, 'conflict', 'span')").run(id);
    db.prepare("INSERT INTO tag_removals (quote_id, tag, by, at) VALUES (?, 'gone', 'me', 'x')").run(id);
    const [other] = repairQuotes(db).repairs[0].newIds;
    expect(quote(other).work_id).toBe(9);
    expect(db.prepare("SELECT tag FROM quote_tags WHERE quote_id = ?").pluck().all(other)).toEqual(["conflict"]);
    expect(db.prepare("SELECT tag FROM tag_removals WHERE quote_id = ?").pluck().all(other)).toEqual(["gone"]);
    expect(historyOf(id)).toEqual(["imported", "split"]);
    expect(historyOf(other)).toEqual(["imported", "split_from"]);
    expect(db.prepare("SELECT reason FROM history WHERE quote_id = ? AND kind = 'split'").pluck().get(id)).toContain(`quotes ${other}`);
    expect(db.prepare("SELECT kind, ref FROM quote_origins WHERE quote_id = ? ORDER BY kind").all(other)).toEqual([{ kind: "drupal", ref: `${id}#1/2` }, { kind: "split", ref: `${id}#2` }]);
  });

  it("moves a mark to the passage holding its words", () => {
    const id = merged();
    db.prepare("INSERT INTO quote_kwic (quote_id, phrase, tag) VALUES (?, 'powerlessness', 'power'), (?, 'self-esteem', 'esteem')").run(id, id);
    const [other] = repairQuotes(db).repairs[0].newIds;
    expect(db.prepare("SELECT phrase FROM quote_kwic WHERE quote_id = ?").pluck().all(id)).toEqual(["powerlessness"]);
    expect(db.prepare("SELECT phrase FROM quote_kwic WHERE quote_id = ?").pluck().all(other)).toEqual(["self-esteem"]);
  });

  it("makes both parts searchable, and the audit finds nothing left to do", () => {
    const id = merged();
    const [other] = repairQuotes(db).repairs[0].newIds;
    expect(searchQuotes(db, { query: "affronts" }).quotes.map((q) => q.id)).toEqual([other]);
    expect(searchQuotes(db, { query: "powerlessness" }).quotes.map((q) => q.id)).toEqual([id]);
    expect(auditOf(db, id)).toMatchObject({ matches: true, kinds: [] });
    expect(auditOf(db, other)).toMatchObject({ matches: true, kinds: [] });
  });

  it("gives a Zotero note's parts the origins the import looks for, and an import leaves them alone", () => {
    const raw = `<p>${span(MERGED)}</p>`;
    db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES ('users/1', 'NOTE', 1, 'note', NULL, 0, ?)").run(JSON.stringify({ itemType: "note", note: raw, tags: [] }));
    const id = record({ text: "stored wrongly here for the test", locator: "225" }, raw, "zotero-note", "users/1:NOTE");
    db.prepare("UPDATE quote_origins SET version = '1' WHERE quote_id = ?").run(id);
    const [other] = repairQuotes(db).repairs[0].newIds;
    expect(db.prepare("SELECT ref FROM quote_origins WHERE quote_id = ? AND kind = 'zotero-note'").pluck().get(other)).toBe("users/1:NOTE#2");
    const before = JSON.stringify(db.prepare("SELECT id, text, locator FROM quotes ORDER BY id").all());
    expect(runImport(db, { primary: "users/1", sources: ["users/1"] }).quotes).toMatchObject({ added: 0, updated: 0, merged: 0 });
    expect(JSON.stringify(db.prepare("SELECT id, text, locator FROM quotes ORDER BY id").all())).toBe(before);
  });
});

describe("repairing one record", () => {
  it("takes a page out of the text (#132)", () => {
    const id = record({ text: "*Totalitarianism is proclaimed.* (p. 24)" }, span(`"<em>Totalitarianism is proclaimed.</em> (p. 24)"`));
    repairQuotes(db);
    expect(quote(id)).toMatchObject({ text: "*Totalitarianism is proclaimed.*", locator: "24", locator_kind: "page" });
  });

  it("moves a lead-in to the comment (#53)", () => {
    const id = record({ text: `As they argue,\n"Nothing is more discouraging.`, locator: "62" }, span(`As they argue,\n"Nothing is more discouraging." (p. 62)`));
    repairQuotes(db);
    expect(quote(id)).toMatchObject({ text: "Nothing is more discouraging.", comment: "As they argue,", locator: "62" });
  });

  it("takes a remark after the page out of the text (#345), and a place out of the comment (#338)", () => {
    const a = record({ text: `The diseases are devastating." (p.36)\nSee also Deming` }, span(`"The diseases are devastating." (p.36)\nSee also Deming`));
    const b = record({ text: "Even panic attacks.", comment: "(p, 40)" }, span(`"Even panic attacks." (p, 40)`));
    repairQuotes(db);
    expect(quote(a)).toMatchObject({ text: "The diseases are devastating.", comment: "See also Deming", locator: "36" });
    expect(quote(b)).toMatchObject({ text: "Even panic attacks.", comment: null, locator: "40" });
  });

  it("puts emphasis back on the words (#155)", () => {
    const id = record({ text: "*I never got support.", comment: "*", locator: "34" }, span(`"<cite>I never got support."</cite> (p. 34)`));
    repairQuotes(db);
    expect(quote(id)).toMatchObject({ text: "*I never got support.*", comment: null, locator: "34" });
  });

  it("records what it changed", () => {
    const id = record({ text: "Even panic attacks.", comment: "(p, 40)" }, span(`"Even panic attacks." (p, 40)`));
    repairQuotes(db);
    const h = db.prepare("SELECT kind, before, after, actor, reason FROM history WHERE quote_id = ? ORDER BY id DESC LIMIT 1").get(id) as Record<string, string>;
    expect(h).toMatchObject({ kind: "repaired", actor: "repair", reason: `read again from drupal ${id}#1` });
    expect(JSON.parse(h.before)).toMatchObject({ comment: "(p, 40)", locator: null });
    expect(JSON.parse(h.after)).toMatchObject({ comment: null, locator: "40" });
  });

  it("doesn't take away a page that another source gave (#353)", () => {
    const id = record({ text: "The same words here.", locator: "15" }, span(`"The same words here."`));
    expect(repairQuotes(db)).toMatchObject({ repairs: [] });
    expect(quote(id).locator).toBe("15");
  });
});

describe("what it leaves for a person", () => {
  const wrong = { text: "Even panic attacks.", comment: "(p, 40)" };
  const raw = span(`"Even panic attacks." (p, 40)`);

  it("lists an edited record, and doesn't overwrite it", () => {
    const id = record({ ...wrong, edited: 1 }, raw);
    const before = dump();
    expect(repairQuotes(db)).toMatchObject({ repairs: [], forPerson: [{ id, why: "edited" }] });
    expect(dump()).toBe(before);
  });

  it("lists a verified record whose raw reads differently, and doesn't overwrite it", () => {
    const id = record({ ...wrong, status: "verified" }, raw);
    const before = dump();
    expect(repairQuotes(db)).toMatchObject({ repairs: [], forPerson: [{ id, why: "verified" }] });
    expect(dump()).toBe(before);
  });

  it("leaves out a verified or edited record that reads the same", () => {
    record({ text: "Fine as it is.", locator: "3", status: "verified" }, span(`"Fine as it is." (p. 3)`));
    expect(repairQuotes(db)).toMatchObject({ repairs: [], forPerson: [], alreadyRight: 1 });
  });

  it.each([
    ["an opening mark with no closing mark (#243)", `"An unclosed quote.`, "marks_off_pattern"],
    ["a closing mark with no opening mark (#45)", `A closing mark only." (p. 33)`, "marks_off_pattern"],
    ["double marks inside a quote (#469)", `"With a "phrase" inside." (p. 3)`, "marks_off_pattern"],
    ["no marks (#521)", "No marks at all.", "no_marks"],
    ["two quotes with no page (#752)", `"One quote."\n\n"Another quote."`, "held"],
  ])("lists %s", (_name, words, why) => {
    const id = record({ text: "as stored" }, span(words));
    const before = dump();
    const r = repairQuotes(db);
    expect(r.repairs).toEqual([]);
    expect(r.forPerson[0]).toMatchObject({ id, why });
    expect(dump()).toBe(before);
  });

  it("applies one flagged record when told to, but never an edited one", () => {
    const flagged = record({ text: "stale text", locator: null }, span(`"Because it is memorable. (p. 121)`));
    db.prepare("UPDATE quotes SET text = ? WHERE id = ?").run("stale text", flagged);
    const edited = record({ ...wrong, edited: 1 }, raw);
    expect(repairQuotes(db, { only: flagged }).repairs).toHaveLength(1);
    expect(quote(flagged)).toMatchObject({ text: "Because it is memorable.", locator: "121" });
    expect(JSON.parse(quote(flagged).flags as string)).toContain("unbalanced_quotes");
    expect(repairQuotes(db, { only: edited })).toMatchObject({ repairs: [], forPerson: [{ id: edited, why: "edited" }] });
  });
});

describe("running it", () => {
  it("saves nothing in a dry run, and reports the same as a real one", () => {
    const id = merged();
    const before = dump();
    const dry = repairQuotes(db, { dryRun: true });
    expect(dump()).toBe(before);
    expect(dry.repairs[0]).toMatchObject({ id, after: [{ locator: "224" }, { locator: "225" }] });
    expect(repairQuotes(db).repairs[0].after).toEqual(dry.repairs[0].after);
  });

  it("finds nothing to do the second time", () => {
    merged();
    repairQuotes(db);
    const before = dump();
    expect(repairQuotes(db).repairs).toEqual([]);
    expect(dump()).toBe(before);
  });

  it("leaves a quote saved another way alone", () => {
    const id = record({ text: "From a book." }, "{}", "corpus");
    expect(repairQuotes(db)).toMatchObject({ repairs: [], forPerson: [], checked: 0 });
    expect(quote(id).text).toBe("From a book.");
  });
});
