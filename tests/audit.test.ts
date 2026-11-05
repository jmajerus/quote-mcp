import { beforeEach, describe, expect, it } from "vitest";
import { auditOf, auditStore } from "../src/audit.js";
import { type DB, openDb } from "../src/db.js";

let db: DB;
let n = 0;
function record(fields: { text: string; locator?: string | null; comment?: string | null; status?: string; edited?: number; kind?: string }, raw: string, kind = "drupal") {
  const id = ++n;
  db.prepare(`INSERT INTO quotes (id, kind, text, text_key, locator_kind, locator, comment, status, flags, edited, created_at, created_by, updated_at, updated_by)
    VALUES (?, 'quote', ?, '', ?, ?, ?, ?, '[]', ?, 'x', 'x', 'x', 'x')`).run(id, fields.text, fields.locator ? "page" : "none", fields.locator ?? null, fields.comment ?? null, fields.status ?? "transcribed", fields.edited ?? 0);
  db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES (?, ?, ?, NULL, ?, 'x')").run(kind, `r${id}`, id, raw);
  return id;
}
const span = (s: string) => `<span class="quote">${s}</span>`;
const kindsOf = (id: number) => auditStore(db).records.find((r) => r.id === id)?.kinds;

beforeEach(() => {
  db = openDb(":memory:");
  n = 0;
});

describe("the audit", () => {
  it("passes a record that matches its raw", () => {
    const id = record({ text: "A clean quote here.", locator: "5" }, span(`"A clean quote here." (p. 5)`));
    expect(kindsOf(id)).toEqual([]);
    expect(auditStore(db).clean).toBe(1);
  });

  it("finds several passages merged, a page in the text, and the wrong page (#89)", () => {
    const id = record({ text: `First passage." (p. 224)\n"Second passage.`, locator: "225", status: "unparsed" }, span(`"First passage." (p. 224)\n"Second passage." (p. 225)`));
    expect(kindsOf(id)).toEqual(expect.arrayContaining(["several_passages", "page_in_text", "locator_differs"]));
    expect(auditOf(db, id)?.parsed.map((p) => [p.text, p.locator])).toEqual([["First passage.", "224"], ["Second passage.", "225"]]);
  });

  it("finds a page left in the text (#469)", () => {
    expect(kindsOf(record({ text: "Depression follows. (p. 33)" }, span(`"Depression follows. (p. 33)"`)))).toEqual(expect.arrayContaining(["page_in_text", "locator_differs"]));
  });

  it("finds marks off the pattern (#243), and no marks (#521)", () => {
    expect(kindsOf(record({ text: "An unclosed quote." }, span(`"An unclosed quote.`)))).toContain("marks_off_pattern");
    expect(kindsOf(record({ text: "No marks here." }, span("No marks here.")))).toContain("no_marks");
  });

  it("finds a lead-in in the text (#53), and text wrongly in the comment (#302)", () => {
    expect(kindsOf(record({ text: `As they argue,\n"Nothing is worse.`, locator: "62" }, span(`As they argue,\n"Nothing is worse." (p. 62)`)))).toContain("lead_in");
    expect(kindsOf(record({ text: "A better way.", comment: "p. 222" }, span(`"A better way." p. 222`)))).toEqual(expect.arrayContaining(["comment_differs", "locator_differs"]));
  });

  it("finds pages running backwards (#318)", () => {
    expect(kindsOf(record({ text: "x", status: "unparsed" }, span(`"First." (p. 158)\n"Second." (p. 122)`)))).toContain("pages_backward");
  });

  it("finds words lost, words added, and words reordered", () => {
    expect(auditOf(db, record({ text: "One two." }, span(`"One two three." (p. 1)`)))?.lost).toEqual(["three"]);
    expect(auditOf(db, record({ text: "One two four." }, span(`"One two." (p. 1)`)))?.added).toEqual(["four"]);
    expect(kindsOf(record({ text: "Two one." }, span(`"One two."`)))).toContain("words_reordered");
  });

  it("counts verified and edited records apart, and leaves out quotes saved another way", () => {
    record({ text: "An unclosed quote.", status: "verified" }, span(`"An unclosed quote.`));
    record({ text: "Another unclosed.", edited: 1 }, span(`"Another unclosed.`));
    record({ text: "From a book." }, "{}", "corpus");
    const report = auditStore(db);
    expect(report).toMatchObject({ quotes: 3, checked: 2, notTyped: 1 });
    expect(report.kinds.marks_off_pattern).toMatchObject({ count: 2, verified: 1, edited: 1 });
  });

  it("picks the source the record has its page from, when two have the same words (#353)", () => {
    const id = record({ text: "The same words here.", locator: "15" }, span(`"The same words here."`));
    db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES ('zotero-note', 'n', ?, '1', ?, 'x')").run(id, `<p>${span(`"The same words here." (p. 15)`)}</p>`);
    expect(auditOf(db, id)).toMatchObject({ origin: { kind: "zotero-note" }, matches: true });
  });

  it("changes nothing", () => {
    record({ text: "An unclosed quote." }, span(`"An unclosed quote.`));
    const before = db.prepare("SELECT total_changes()").pluck().get();
    auditStore(db);
    expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(before);
  });
});
