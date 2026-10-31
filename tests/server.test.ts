import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DB, openDb } from "../src/db.js";
import type { DrupalSite } from "../src/drupal.js";
import { runImport } from "../src/import.js";
import { citeQuote, ftsQuery, getConcept, searchQuotes } from "../src/queries.js";
import { serveHttp } from "../src/server.js";
import type { ConceptSet } from "../src/sets.js";

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
let mapRoot: string;

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
  // The map's folder, beside a file it must never serve, and a symlink pointing at that file.
  mapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quote-mcp-map-"));
  const mapDir = path.join(mapRoot, "map");
  fs.mkdirSync(path.join(mapDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(mapDir, "index.html"), "<!doctype html><title>Map</title>");
  fs.writeFileSync(path.join(mapDir, "assets", "app-3f9a1c2e.js"), "console.log('map');");
  fs.writeFileSync(path.join(mapDir, "assets", "index.html"), "<p>assets</p>");
  fs.writeFileSync(path.join(mapRoot, "secret.txt"), "secret");
  fs.symlinkSync(path.join(mapRoot, "secret.txt"), path.join(mapDir, "link.txt"));
  const sets: ConceptSet[] = [
    { slug: "harm", scheme: "human-work", label: "Harm", narrower: ["abuse"] },
    { slug: "worth", scheme: "human-work", label: "Worth", description: "with a typo", concepts: ["dignity", "dignty"] },
  ];
  server = await serveHttp(db, { host: "127.0.0.1", port: 0, mapDir, sets });
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => {
  fs.rmSync(mapRoot, { recursive: true, force: true });
  resolve();
})));

/** A request with the path sent exactly as written, as fetch would normalize "..". */
function raw(rawPath: string, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/`, { method, path: rawPath }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

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
    expect(tools).toEqual(["cite_quote", "get_concept", "get_quote", "list_concepts", "list_sets", "quote_worklist", "search_quotes"]);

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

  it("lists concept sets and searches within one", async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError, value: (result.content as { text: string }[])[0].text };
    };
    expect(JSON.parse((await call("list_sets", {})).value)).toEqual([
      { slug: "harm", scheme: "human-work", label: "Harm", description: null, concepts: 2, missing: [] },
      { slug: "worth", scheme: "human-work", label: "Worth", description: "with a typo", concepts: 1, missing: ["dignty"] },
    ]);
    expect(JSON.parse((await call("search_quotes", { set: "harm" })).value).total).toBe(2);
    expect(JSON.parse((await call("search_quotes", { set: "worth" })).value).quotes[0].text).toBe("Everyone deserves dignity.");
    expect(JSON.parse((await call("search_quotes", { set: "harm", query: "dignity" })).value).total).toBe(0);
    expect(JSON.parse((await call("list_concepts", { set: "harm" })).value).map((c: { slug: string }) => c.slug)).toEqual(["abuse", "mobbing"]);
    const missing = await call("search_quotes", { set: "nothing" });
    expect(missing).toEqual({ isError: true, value: 'No concept set "nothing". Sets: harm, worth.' });
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

describe("JSON API", () => {
  const get = async (p: string) => {
    const res = await fetch(base + p);
    return { status: res.status, type: res.headers.get("content-type"), body: await res.json() };
  };

  it("serves the whole concept graph", async () => {
    const { status, type, body } = await get("/api/graph");
    expect(status).toBe(200);
    expect(type).toMatch(/^application\/json/);
    expect(body.concepts).toEqual([
      { slug: "abuse", scheme: "human-work", label: "abuse", alt_labels: [], status: "confirmed", source: "drupal:kid:1", quotes: 1 },
      { slug: "dignity", scheme: "human-work", label: "dignity", alt_labels: [], status: "confirmed", source: "drupal:kid:3", quotes: 1 },
      { slug: "mobbing", scheme: "human-work", label: "mobbing", alt_labels: ["group bullying"], status: "confirmed", source: "drupal:kid:2", quotes: 1 },
    ]);
    expect(body.relations).toEqual([
      { from: "abuse", to: "dignity", type: "inverse" }, { from: "abuse", to: "mobbing", type: "narrower" }, { from: "mobbing", to: "abuse", type: "broader" },
    ]);
  });

  it("serves a concept, by slug or scheme:slug", async () => {
    const { status, body } = await get("/api/concepts/abuse");
    expect(status).toBe(200);
    expect(body).toMatchObject({ slug: "abuse", label: "abuse", relations: { narrower: [{ slug: "mobbing" }] }, quotes: 1, quotes_with_narrower: 2 });
    expect((await get(`/api/concepts/${encodeURIComponent("human-work:mobbing")}`)).body.slug).toBe("mobbing");
  });

  it("serves a concept's quotes, with narrower concepts unless asked not to, a page at a time", async () => {
    const all = await get("/api/concepts/abuse/quotes");
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ concept: { slug: "abuse", scheme: "human-work" }, total: 2, offset: 0, limit: 20 });
    expect(all.body.quotes[0]).toMatchObject({ kind: "quote", locator: "p. 40", work: { title: "Mobbing: emotional abuse in the American workplace", year: "1999", citekey: "davenport1999mobbing" } });
    expect(all.body.quotes[0].tags).toEqual([{ tag: "mobbing", concept: "mobbing", origin: "span" }]);
    expect((await get("/api/concepts/abuse/quotes?narrower=false")).body.total).toBe(1);
    const page = await get("/api/concepts/abuse/quotes?limit=1&offset=1");
    expect(page.body).toMatchObject({ total: 2, offset: 1, limit: 1 });
    expect(page.body.quotes).toHaveLength(1);
    expect((await get("/api/concepts/abuse/quotes?limit=many")).status).toBe(400);
  });

  it("lists the concept sets, and serves one as a piece of the graph", async () => {
    const list = await get("/api/sets");
    expect(list.status).toBe(200);
    expect(list.body.sets.map((s: { slug: string; concepts: number }) => [s.slug, s.concepts])).toEqual([["harm", 2], ["worth", 1]]);
    const { status, body } = await get("/api/sets/harm");
    expect(status).toBe(200);
    expect(body).toMatchObject({ slug: "harm", scheme: "human-work", label: "Harm", description: null, definition: { narrower: ["abuse"] }, missing: [] });
    expect(body.concepts.map((c: { slug: string }) => c.slug)).toEqual(["abuse", "mobbing"]);
    expect(body.concepts[0]).toEqual({ slug: "abuse", scheme: "human-work", label: "abuse", alt_labels: [], status: "confirmed", source: "drupal:kid:1", quotes: 1 });
    expect(body.relations).toEqual([{ from: "abuse", to: "mobbing", type: "narrower" }, { from: "mobbing", to: "abuse", type: "broader" }]);
    expect((await get("/api/sets/worth")).body.missing).toEqual(["dignty"]);
  });

  it("answers 404 for what isn't there, and 405 for anything but GET", async () => {
    expect((await get("/api/sets/nothing")).status).toBe(404);
    expect((await get("/api/concepts/nothing")).status).toBe(404);
    expect((await get("/api/concepts/nothing/quotes")).status).toBe(404);
    expect((await get("/api/nowhere")).status).toBe(404);
    const post = await fetch(`${base}/api/graph`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });
});

describe("the map at /map/", () => {
  it("redirects /map to /map/ and serves index.html there, revalidated on every load", async () => {
    const redirect = await fetch(`${base}/map?x=1`, { redirect: "manual" });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/map/?x=1");
    const res = await fetch(`${base}/map/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("<title>Map</title>");
  });

  it("serves other files with their type, caching hashed ones", async () => {
    const res = await fetch(`${base}/map/assets/app-3f9a1c2e.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await (await fetch(`${base}/map/assets/`)).text()).toBe("<p>assets</p>");
    const bare = await fetch(`${base}/map/assets?x=1`, { redirect: "manual" });
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe("/map/assets/?x=1");
    expect((await fetch(`${base}/map/missing.js`)).status).toBe(404);
  });

  it.each(["/map/../secret.txt", "/map/%2e%2e/secret.txt", "/map/..%2fsecret.txt", "/map/assets/..%2F..%2Fsecret.txt", "/map/%2E%2E%5Csecret.txt", "/map/link.txt", "/map/%00index.html"])("refuses %s", async (p) => {
    const res = await raw(p);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("secret");
  });

  it("doesn't take a word in a file name for a build hash", async () => {
    fs.writeFileSync(path.join(mapRoot, "map", "concept-positions.json"), "{}");
    expect((await fetch(`${base}/map/concept-positions.json`)).headers.get("cache-control")).toBe("no-cache");
  });

  it("answers a revalidation of an unchanged file with 304", async () => {
    const first = await fetch(`${base}/map/`);
    const etag = first.headers.get("etag");
    const modified = first.headers.get("last-modified");
    expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(modified).toBeTruthy();
    expect((await fetch(`${base}/map/`, { headers: { "if-none-match": etag! } })).status).toBe(304);
    expect((await fetch(`${base}/map/`, { headers: { "if-modified-since": modified! } })).status).toBe(304);
    expect((await fetch(`${base}/map/`, { headers: { "if-none-match": 'W/"0-0"' } })).status).toBe(200);
  });

  it("refuses writes", async () => {
    expect((await raw("/map/", "POST")).status).toBe(405);
  });

  it("is 404 without a map folder", async () => {
    const bare = await serveHttp(db, { host: "127.0.0.1", port: 0 });
    const a = bare.address();
    const res = await fetch(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/map/`);
    expect(res.status).toBe(404);
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  });
});


it("requires a team-signed Access token, from any application, for public-host private API and MCP requests", async () => {
  const {publicKey,privateKey}=await generateKeyPair("RS256");
  const team="https://example.cloudflareaccess.com";
  const keys=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:"test",alg:"RS256"}]});
  const sign=(aud:string,key=privateKey)=>new SignJWT({}).setSubject("user").setIssuer(team).setAudience(aud).setIssuedAt().setExpirationTime("5m").setProtectedHeader({alg:"RS256",kid:"test"}).sign(key);
  const mcp=await sign("mcp"),admin=await sign("admin"),forged=await sign("mcp",(await generateKeyPair("RS256")).privateKey);
  const guarded=await serveHttp(db,{host:"127.0.0.1",port:0,access:{teamDomain:team,lanHosts:[]},accessKeys:keys});
  const address=guarded.address() as import("node:net").AddressInfo;
  const send=(url:string,assertion?:string)=>fetch(`http://127.0.0.1:${address.port}`+url,{headers:{Host:"public.example","cf-ray":"test",...(assertion?{"cf-access-jwt-assertion":assertion}:{})}});
  try {
    expect((await send("/api/concepts/abuse")).status).toBe(401);
    expect((await send("/api/concepts/abuse",forged)).status).toBe(403);
    expect((await send("/api/concepts/abuse",mcp)).status).toBe(200);
    expect((await send("/api/concepts/abuse",admin)).status).toBe(200);
    expect((await send("/mcp",forged)).status).toBe(403);
    expect((await send("/mcp",admin)).status).toBe(405);
  } finally {await new Promise<void>(resolve=>guarded.close(()=>resolve()));}
});
