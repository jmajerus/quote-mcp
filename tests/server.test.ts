import type http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DB, openDb } from "../src/db.js";
import type { DrupalSite } from "../src/drupal.js";
import { runImport } from "../src/import.js";
import { citeQuote, ftsQuery, getConcept, searchQuotes } from "../src/queries.js";
import { serveHttp } from "../src/server.js";

const PRIMARY = "users/1";

const drupal: DrupalSite = {
  concepts: [
    { kid: 1, word: "abuse", altLabels: [], definition: "cruel or inhumane treatment", closeMatch: null },
    { kid: 2, word: "mobbing", altLabels: ["group bullying"], definition: null, closeMatch: null },
    { kid: 3, word: "dignity", altLabels: [], definition: null, closeMatch: null },
  ],
  relations: [{ from: "abuse", to: "mobbing", type: "N" }, { from: "mobbing", to: "abuse", type: "B" }, { from: "abuse", to: "dignity", type: "I" }],
  works: [{
    nid: 7, title: "Mobbing: Emotional Abuse in the American Workplace", type: "Book", year: "1999", isbn: null, url: null, citekey: null, authors: ["Davenport, Noa"], keywords: [],
    notes: `<span class="quote" title="mobbing">\n"Mobbing is an emotional assault. It begins when an individual becomes the target of disrespectful and harmful behavior." (p. 40)\n</span>\n<span class="quote" title="abuse">\n"Abuse at work rarely announces itself." (Kindle loc. 12-14)\n</span>`,
  }, {
    nid: 8, title: "A Book Nobody Filed", type: "Book", year: "2001", isbn: "9780000000000", url: null, citekey: null, authors: ["Doe, Jane"], keywords: [],
    notes: `<span class="quote" title="dignity">\n"Everyone deserves dignity." \n</span>`,
  }],
  quotes: [],
};

let db: DB;
let server: http.Server;
let base: string;

beforeAll(async () => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, 'book', NULL, 0, ?)").run(PRIMARY, "MOBB0001", JSON.stringify({
    itemType: "book", title: "Mobbing: emotional abuse in the American workplace", date: "1999", publisher: "Civil Society Pub.", place: "Ames, Iowa", ISBN: "9780966480397",
    extra: "Citation Key: davenport1999mobbing", creators: [{ creatorType: "author", lastName: "Davenport", firstName: "Noa" }],
  }));
  db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, 'note', ?, 0, ?)").run(PRIMARY, "MARGIN01", "MOBB0001", JSON.stringify({
    itemType: "note", parentItem: "MOBB0001", note: "<p>Compare Leymann's forty-five behaviours, which she leaves out. (p. 41)</p>", tags: [{ tag: "margin" }],
  }));
  runImport(db, { drupal, primary: PRIMARY, sources: [PRIMARY] });
  server = await serveHttp(db, { host: "127.0.0.1", port: 0 });
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const quoteId = (fragment: string) => db.prepare("SELECT id FROM quotes WHERE text LIKE ?").pluck().get(`%${fragment}%`) as number;
const noteId = () => db.prepare("SELECT id FROM quotes WHERE kind = 'note'").pluck().get() as number;

describe("queries", () => {
  it("turns words and phrases into a safe FTS query", () => {
    expect(ftsQuery('emotional "harmful behavior" targ* AND')).toBe('"emotional" "harmful behavior" "targ"* "AND"');
    expect(ftsQuery('"')).toBe("");
  });

  it("finds quotes by narrower concepts, unless asked not to", () => {
    expect(searchQuotes(db, { concept: "abuse" }).total).toBe(2);
    expect(searchQuotes(db, { concept: "abuse", narrower: false }).total).toBe(1);
    expect(searchQuotes(db, { concept: "group bullying" }).quotes[0].text).toMatch(/^Mobbing is/);
  });

  it("names opposite concepts as opposites", () => {
    expect(getConcept(db, "abuse")).toMatchObject({ relations: { narrower: [{ slug: "mobbing" }], opposite: [{ slug: "dignity" }] }, quotes: 1, quotes_with_narrower: 2 });
  });

  it("cites a quote from its Zotero item, with the citekey and page", () => {
    const c = citeQuote(db, quoteId("emotional assault"));
    expect(c).toMatchObject({
      citekey: "davenport1999mobbing", pandoc: "[@davenport1999mobbing, p. 40]", locator: { label: "page", locator: "40" },
      csl: { id: "davenport1999mobbing", type: "book", author: [{ family: "Davenport", given: "Noa" }], issued: { "date-parts": [[1999]] }, publisher: "Civil Society Pub." },
      warnings: [],
    });
    expect(citeQuote(db, quoteId("rarely announces")).pandoc).toBe("[@davenport1999mobbing, Kindle loc. 12–14]");
  });

  it("looks for words in what a quote says, not in its tags", () => {
    expect(searchQuotes(db, { query: "mobbing" }).quotes.map((q) => q.text)).toEqual([expect.stringMatching(/^Mobbing is/)]);
    expect(searchQuotes(db, { query: "dignity" }).quotes.map((q) => q.text)).toEqual(["Everyone deserves dignity."]);
    expect(searchQuotes(db, { query: "abuse" }).total).toBe(1);
  });

  it("finds notes beside quotes, by their words, unless a kind is asked for", () => {
    const hit = searchQuotes(db, { query: "Leymann" });
    expect(hit.quotes).toEqual([expect.objectContaining({ kind: "note", text: "", note: expect.stringMatching(/^Compare Leymann/), locator: "p. 41", grade: null })]);
    expect(hit.quotes[0].snippet).toBe("Compare «Leymann»'s forty-five behaviours, which she leaves out.");
    expect(searchQuotes(db, { query: "Leymann", kind: "quote" }).total).toBe(0);
    expect(searchQuotes(db, { work: "davenport1999mobbing", kind: "note" }).total).toBe(1);
    expect(searchQuotes(db, { work: "davenport1999mobbing" }).total).toBe(3);
  });

  it("cites a note as its work and place, with no quotation", () => {
    const c = citeQuote(db, noteId());
    expect(c).toMatchObject({ kind: "note", quote: null, note: expect.stringMatching(/^Compare/), pandoc: "[@davenport1999mobbing, p. 41]" });
    expect(c.warnings.join(" ")).toMatch(/not a quote/);
  });

  it("offers each edition when several Zotero items could be the work", () => {
    db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, 'book', NULL, 0, ?)").run(PRIMARY, "NOBODY01", JSON.stringify({ itemType: "book", title: "A book nobody filed", date: "2001", extra: "Citation Key: doe2001book" }));
    db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, 'book', NULL, 0, ?)").run(PRIMARY, "NOBODY02", JSON.stringify({ itemType: "book", title: "A Book Nobody Filed", date: "2001", extra: "Citation Key: doe2001booka" }));
    db.prepare("UPDATE works SET match = 'ambiguous', candidates = ? WHERE title = 'A Book Nobody Filed'").run(JSON.stringify(["NOBODY01", "NOBODY02"]));
    const c = citeQuote(db, quoteId("deserves dignity"));
    expect(c.editions?.map((e) => [e.zotero_key, e.citekey, e.pandoc])).toEqual([["NOBODY01", "doe2001book", "[@doe2001book]"], ["NOBODY02", "doe2001booka", "[@doe2001booka]"]]);
    expect(c.warnings.join(" ")).toMatch(/editions/);
    db.prepare("UPDATE works SET match = 'unmatched', candidates = NULL WHERE title = 'A Book Nobody Filed'").run();
    db.prepare("DELETE FROM zotero_items WHERE key IN ('NOBODY01', 'NOBODY02')").run();
  });

  it("cites a work not in Zotero from the old site's record, and says so", () => {
    const c = citeQuote(db, quoteId("deserves dignity"));
    expect(c.csl).toMatchObject({ title: "A Book Nobody Filed", author: [{ family: "Doe", given: "Jane" }], ISBN: "9780000000000" });
    expect(c.warnings.join(" ")).toMatch(/isn't in Zotero yet/);
    expect(c.warnings.join(" ")).toMatch(/no page/);
  });
});

describe("MCP over HTTP", () => {
  it("lists the tools and answers them", async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["cite_quote", "get_concept", "get_quote", "list_concepts", "quote_worklist", "search_quotes"]);

    const search = await client.callTool({ name: "search_quotes", arguments: { query: "assault" } });
    const found = JSON.parse((search.content as { text: string }[])[0].text);
    expect(found.total).toBe(1);
    expect(found.quotes[0].snippet).toContain("«assault»");

    const missing = await client.callTool({ name: "get_quote", arguments: { id: 9999 } });
    expect(missing.isError).toBe(true);

    const counts = JSON.parse(((await client.callTool({ name: "quote_worklist", arguments: {} })).content as { text: string }[])[0].text);
    expect(counts.queues).toMatchObject({ unmatched_works: 1, kindle_locator: 1 });
    await client.close();
  });
});

describe("admin pages", () => {
  it.each(["/admin", "/admin/quotes?q=dignity", "/admin/concepts", "/admin/concepts/abuse", "/admin/worklists", "/admin/worklists/unmatched_works", "/admin/worklists/kindle_locator"])("serves %s", async (path) => {
    const res = await fetch(base + path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>");
  });

  it("shows a quote with its citation", async () => {
    const html = await (await fetch(`${base}/admin/quotes/${quoteId("emotional assault")}`)).text();
    expect(html).toContain("[@davenport1999mobbing, p. 40]");
    expect(html).toContain("zotero://select/library/items/MOBB0001");
  });

  it("shows a note as your own words", async () => {
    const html = await (await fetch(`${base}/admin/quotes/${noteId()}`)).text();
    expect(html).toContain("<h1>Note ");
    expect(html).toContain("Compare Leymann&#39;s forty-five behaviours");
    expect(html).not.toContain("<blockquote>");
    const list = await (await fetch(`${base}/admin/quotes?kind=note`)).text();
    expect(list).toContain('<span class="kind">note</span>');
    expect(list).toContain("1–1 of 1");
  });

  it("escapes what it shows", async () => {
    const html = await (await fetch(`${base}/admin/quotes?q=${encodeURIComponent('<script>x</script>')}`)).text();
    expect(html).not.toContain("<script>x</script>");
  });

  it("answers 404 for what isn't there", async () => {
    expect((await fetch(`${base}/admin/quotes/9999`)).status).toBe(404);
    expect((await fetch(`${base}/admin/nowhere`)).status).toBe(404);
    expect((await fetch(`${base}/admin/concepts/nothing`)).status).toBe(404);
  });
});
