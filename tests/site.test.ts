import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DB, openDb } from "../src/db.js";
import type { DrupalSite } from "../src/drupal.js";
import { runImport } from "../src/import.js";
import Database from "better-sqlite3";
import { readIntro } from "../src/intro.js";
import { Published, snapshotReader } from "../src/published.js";
import { servePublic, serveHttp } from "../src/server.js";
import type { ConceptSet } from "../src/sets.js";
import { bibtex, plainText, quoteHtml } from "../src/public.js";
import { renderSite } from "../src/site.js";
import { type SnapshotOptions, buildSnapshot, readMapsFile } from "../src/snapshot.js";

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
    notes: `<span class="quote" title="mobbing">\n"Mobbing is an emotional assault." (p. 40)\n</span>\n<span class="quote" title="abuse">\n"Abuse at work rarely announces itself." (p. 12)\n</span>`,
  }, {
    nid: 8, title: "A Book Nobody Filed", type: "Book", year: "2001", isbn: null, url: null, citekey: null, authors: ["Doe, Jane"], keywords: [],
    notes: `<span class="quote" title="dignity">\n"Everyone deserves dignity." \n</span>`,
  }],
  quotes: [],
};

const QUOTED = ["Mobbing is an emotional assault", "Abuse at work rarely", "Everyone deserves dignity"];
const SHARED_NOTE = "Compare Leymann";
const PRIVATE_NOTE = "Too harsh on her";

let db: DB;
let mapDir: string;
const servers: http.Server[] = [];

const SETS: ConceptSet[] = [{ slug: "harm", scheme: "human-work", label: "Harm", description: "Abuse and what it includes", narrower: ["abuse"] }];
let built = 0;

/** A snapshot of the test store with these settings, opened as the public pages read it. */
function site(rest: Partial<SnapshotOptions> = {}): Published {
  const file = path.join(mapDir, `public-${built++}.db`);
  buildSnapshot(db, { level: "catalogue", notes: false, intro: readIntro("# Work quotes\n\nQuotes about work."), collections: {}, sets: SETS, maps: readMapsFile(mapDir), ...rest }, file);
  return new Published(new Database(file, { readonly: true }));
}

async function start(options: Partial<SnapshotOptions> | null, publicPort = true) {
  const published = options && site(options);
  const base = { host: "127.0.0.1", port: 0, mapDir, sets: SETS, snapshot: published ? () => published : undefined };
  const url = (server: http.Server) => {
    const a = server.address();
    return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  };
  const lan = await serveHttp(db, base);
  servers.push(lan);
  if (!publicPort) return { lan: url(lan), pub: "" };
  const pub = await servePublic(base);
  servers.push(pub);
  return { lan: url(lan), pub: url(pub) };
}

beforeAll(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, 'book', NULL, 0, ?)").run(PRIMARY, "MOBB0001", JSON.stringify({
    itemType: "book", title: "Mobbing: emotional abuse in the American workplace", date: "1999", extra: "Citation Key: davenport1999mobbing",
    creators: [{ creatorType: "author", lastName: "Davenport", firstName: "Noa" }],
  }));
  const note = (key: string, text: string, tags: string[]) => db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, 'note', 'MOBB0001', 0, ?)")
    .run(PRIMARY, key, JSON.stringify({ itemType: "note", parentItem: "MOBB0001", note: `<p>${text} (p. 41)</p>`, tags: tags.map((tag) => ({ tag })) }));
  note("MARGIN01", `${SHARED_NOTE}'s forty-five behaviours, which she leaves out.`, ["margin", "mobbing"]);
  note("MARGIN02", `${PRIVATE_NOTE}, I think, but she's right about the HR department.`, ["margin", "private", "mobbing"]);
  runImport(db, { drupal, primary: PRIMARY, sources: [PRIMARY] });
  mapDir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-mcp-site-"));
  fs.writeFileSync(path.join(mapDir, "maps.json"), JSON.stringify([{ name: "human-work", title: "Human work", description: "The 2014 diagram", scheme: "human-work" }]));
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  fs.rmSync(mapDir, { recursive: true, force: true });
});

const workId = (title: string) => db.prepare("SELECT id FROM works WHERE title LIKE ?").pluck().get(`${title}%`) as number;
const pages = () => ["/", "/concepts", "/concepts/abuse", "/concepts/mobbing", "/concepts/dignity", "/sets/harm", "/works", `/works/${workId("Mobbing")}`, `/works/${workId("A Book")}`];

describe("the introduction", () => {
  it("takes the title from the first heading and renders a little Markdown", () => {
    const intro = readIntro("# My quotes\n\nFrom **books**, with *pages*.\nSee [the maps](/map/).\n\n## Where\n\n- one\n- two");
    expect(intro.title).toBe("My quotes");
    expect(intro.html).toBe('<p>From <strong>books</strong>, with <em>pages</em>. See <a href="/map/">the maps</a>.</p>\n<h2>Where</h2>\n<ul><li>one</li><li>two</li></ul>');
  });

  it("escapes HTML and links only safe addresses", () => {
    const intro = readIntro('<script>x</script> [bad](javascript:alert(1)) [ok](https://example.org/a)');
    expect(intro.title).toBe("Quotes");
    expect(intro.html).not.toContain("<script>");
    expect(intro.html).not.toContain('href="javascript');
    expect(intro.html).toContain('<a href="https://example.org/a">ok</a>');
  });
});

describe("the catalogue level", () => {
  it("shows the front page: introduction, counts, maps, sets, and ways to browse", () => {
    const html = renderSite(site(), "/")!;
    expect(html).toContain("<h1>Work quotes</h1>");
    expect(html).toContain("<p>Quotes about work.</p>");
    expect(html).toContain("3 quotes from 2 works, tagged with 3 concepts.");
    expect(html).toContain('href="/map/human-work/"');
    expect(html).toContain('href="/sets/harm"');
  });

  it("lists concepts, sets, and works, with counts of public quotes only", () => {
    expect(renderSite(site(), "/concepts/abuse")).toContain("2 quotes, with its narrower concepts");
    expect(renderSite(site(), "/concepts/abuse")).toContain('href="/map/human-work/#/concept/abuse"');
    expect(renderSite(site(), "/concepts/mobbing")).toContain("In <a href=\"/sets/harm\">Harm</a>");
    expect(renderSite(site(), "/sets/harm")).toMatch(/abuse<\/a> <span class="count">1<\/span>.*mobbing<\/a> <span class="count">1<\/span>/s);
    const works = renderSite(site(), "/works")!;
    expect(works.indexOf("Davenport")).toBeLessThan(works.indexOf("Doe"));
    expect(renderSite(site(), `/works/${workId("Mobbing")}`)).toContain("2 quotes");
  });

  it("shows no quoted text and no notes", () => {
    for (const p of pages()) {
      const html = renderSite(site(), p)!;
      for (const words of [...QUOTED, SHARED_NOTE, PRIVATE_NOTE]) expect(html, `${p} shows "${words}"`).not.toContain(words);
    }
  });

  it("answers null or a not-found for what isn't there", () => {
    expect(renderSite(site(), "/nowhere")).toBeNull();
    expect(() => renderSite(site(), "/concepts/nothing")).toThrow();
    expect(() => renderSite(site(), "/sets/nothing")).toThrow();
    expect(() => renderSite(site(), "/works/99999")).toThrow();
    expect(() => site({ level: "none" })).toThrow(/nothing to publish/);
  });

  it("counts shared notes at the quotes level, but not private ones", () => {
    expect(renderSite(site({ level: "quotes", notes: true }), "/")).toContain("4 quotes and notes from 2 works");
    expect(renderSite(site({ level: "quotes" }), "/")).toContain("3 quotes from 2 works");
    expect(renderSite(site({ level: "catalogue", notes: true }), "/")).toContain("3 quotes from 2 works");
  });
});

describe("collections", () => {
  // A second scheme, with one concept tagged on the dignity quote, so that quote is in both collections.
  beforeAll(() => {
    const now = new Date().toISOString();
    const scheme = db.prepare("INSERT INTO schemes (slug, label, description, created_at) VALUES ('ethics', 'Ethics', 'Right and wrong', ?)").run(now).lastInsertRowid;
    const concept = db.prepare("INSERT INTO concepts (scheme_id, slug, label, created_at, updated_at) VALUES (?, 'respect', 'respect', ?, ?)").run(scheme, now, now).lastInsertRowid;
    const quote = db.prepare("SELECT id FROM quotes WHERE text LIKE 'Everyone deserves%'").pluck().get();
    db.prepare("INSERT INTO quote_tags (quote_id, tag, concept_id, origin) VALUES (?, 'respect', ?, 'span')").run(quote, concept);
  });
  afterAll(() => {
    db.prepare("DELETE FROM quote_tags WHERE tag = 'respect'").run();
    db.prepare("DELETE FROM concepts WHERE slug = 'respect'").run();
    db.prepare("DELETE FROM schemes WHERE slug = 'ethics'").run();
  });
  const intros = { "human-work": readIntro("# The human side of work\n\nWhat work does to people.\n\nSince 2014.") };

  it("lists the collections on the front page, each with its introduction's first paragraph and counts", () => {
    const html = renderSite(site({ collections: intros }), "/")!;
    expect(html).toContain("<h2>Collections</h2>");
    expect(html).toMatch(/href="\/collections\/ethics"><h3>Ethics<\/h3>\s*<p>Right and wrong<\/p><p class="count">1 quote · 1 work · 1 concept<\/p>/);
    expect(html).toMatch(/href="\/collections\/human-work"><h3>The human side of work<\/h3>\s*<p>What work does to people.<\/p><p class="count">3 quotes · 2 works · 3 concepts<\/p>/);
    expect(html).not.toContain("Since 2014");
  });

  it("gives each collection a page with its own maps, sets, and filtered lists", () => {
    const work = renderSite(site({ collections: intros }), "/collections/human-work")!;
    expect(work).toContain("<h1>The human side of work</h1>");
    expect(work).toContain("Since 2014");
    expect(work).toContain('href="/map/human-work/"');
    expect(work).toContain('href="/sets/harm"');
    expect(work).toContain('href="/concepts?collection=human-work"');
    const ethics = renderSite(site({ collections: intros }), "/collections/ethics")!;
    expect(ethics).toContain("<p>Right and wrong</p>");
    expect(ethics).not.toContain("/map/human-work/");
    expect(ethics).not.toContain("/sets/harm");
    const concepts = renderSite(site(), "/concepts", new URLSearchParams("collection=ethics"))!;
    expect(concepts).toContain("respect");
    expect(concepts).not.toContain("mobbing");
    const works = renderSite(site(), "/works", new URLSearchParams("collection=ethics"))!;
    expect(works).toContain("A Book Nobody Filed");
    expect(works).not.toContain("Davenport");
    expect(renderSite(site(), "/concepts/respect")).toContain('href="/collections/ethics"');
    expect(() => renderSite(site(), "/collections/nothing")).toThrow();
    expect(() => renderSite(site(), "/works", new URLSearchParams("collection=nothing"))).toThrow();
  });
});

describe("one collection", () => {
  it("shows it inline on the front page, under its own heading when it has an introduction", () => {
    const html = renderSite(site({ collections: { "human-work": readIntro("# The human side of work\n\nWhat work does to people.") } }), "/")!;
    expect(html).not.toContain("<h2>Collections</h2>");
    expect(html).toContain("<h2>The human side of work</h2>");
    expect(html).toContain('href="/concepts"');
    expect(renderSite(site(), "/")).not.toContain("<h2>The human side of work</h2>");
  });
});

describe("serving the public site", () => {
  it("serves the front page at / on the LAN and the public port", async () => {
    const { lan, pub } = await start({});
    for (const base of [lan, pub]) {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
      expect(await res.text()).toContain("<h1>Work quotes</h1>");
    }
    expect((await fetch(`${lan}/concepts/%E0`)).status).toBe(404);
    expect((await fetch(`${pub}/concepts/nothing`)).status).toBe(404);
    expect((await fetch(`${pub}/`, { method: "POST" })).status).toBe(405);
  });

  it("serves only public routes on the public port", async () => {
    const { lan, pub } = await start({});
    for (const p of ["/admin", "/admin/quotes", "/mcp", "/health", "/api/nowhere", "/anything", "/search?q=assault", "/quotes/1"]) {
      expect((await fetch(`${pub}${p}`, { redirect: "manual" })).status, p).toBe(404);
    }
    expect((await fetch(`${pub}/mcp`, { method: "POST", body: "{}" })).status).toBe(404);
    for (const p of ["/api/graph", "/api/concepts/abuse", "/api/sets", "/api/sets/harm"]) expect((await fetch(`${pub}${p}`)).status, p).toBe(200);
    expect((await fetch(`${pub}/map/maps.json`)).status).toBe(200);
    expect((await fetch(`${pub}/api/concepts/abuse/quotes`)).status).toBe(403);
    expect((await fetch(`${lan}/admin`)).status).toBe(200);
  });

  it("redirects / to /admin with no public site, and refuses a public port", async () => {
    const { lan } = await start(null, false);
    const res = await fetch(`${lan}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect((await fetch(`${lan}/concepts`)).status).toBe(404);
    expect(() => servePublic({ host: "127.0.0.1", port: 0 })).toThrow(/QUOTE_PUBLIC/);
  });
});

describe("old-site markup in quote text", () => {
  it("drops [bib] markers and renders paired asterisks as emphasis", () => {
    expect(plainText("Ryan and Oestreich [bib]Ryan1991[/bib], in their study")).toBe("Ryan and Oestreich, in their study");
    expect(plainText("The Player Piano[bib]Vonnegut1952[/bib].")).toBe("The Player Piano.");
    expect(quoteHtml('Choice is the basis *if* relationships are <equal> and "*loyal*" too')).toBe('Choice is the basis <em>if</em> relationships are &lt;equal&gt; and &quot;<em>loyal</em>&quot; too');
    expect(quoteHtml("in *Organizational America* (1979)")).toBe("in <em>Organizational America</em> (1979)");
    expect(quoteHtml("*Performance appraisals are\nannual")).toBe("*Performance appraisals are\nannual");
    expect(quoteHtml("5 * 3 = 15, 2 * 2")).toBe("5 * 3 = 15, 2 * 2");
  });

  it("writes BibTeX from CSL", () => {
    expect(bibtex({ type: "book", title: "Mobbing", author: [{ family: "Davenport", given: "Noa" }, { literal: "Civil {Society}" }], issued: { "date-parts": [[1999]] }, publisher: "Civil Society Pub.", ISBN: "9780966480397" }, "davenport1999mobbing"))
      .toBe("@book{davenport1999mobbing,\n  author = {Davenport, Noa and Civil Society},\n  title = {Mobbing},\n  year = {1999},\n  publisher = {Civil Society Pub.},\n  isbn = {9780966480397}\n}");
  });
});

describe("the quotes level", () => {
  const quotes = (rest: Partial<SnapshotOptions> = {}) => site({ level: "quotes", ...rest });
  const id = (fragment: string) => db.prepare("SELECT id FROM quotes WHERE text LIKE ? OR comment LIKE ?").pluck().get(`%${fragment}%`, `%${fragment}%`) as number;

  it("gives each quote a page with its source, concepts, and how to cite it", () => {
    const html = renderSite(quotes(), `/quotes/${id("emotional assault")}`)!;
    expect(html).toContain("<blockquote>Mobbing is an emotional assault.</blockquote>");
    expect(html).toContain(`<a href="/works/${workId("Mobbing")}"><cite>Mobbing: emotional abuse in the American workplace</cite></a> (1999), p. 40`);
    expect(html).toContain('href="/concepts/mobbing"');
    expect(html).toContain("<code>[@davenport1999mobbing, p. 40]</code>");
    expect(html).toContain("@book{davenport1999mobbing,");
    const unfiled = renderSite(quotes(), `/quotes/${id("deserves dignity")}`)!;
    expect(unfiled).toContain("isn't filed in Zotero");
    expect(unfiled).toContain("@book{work-");
  });

  it("lists quotes on concept, set, and work pages, and the newest on the front page", () => {
    expect(renderSite(quotes(), "/concepts/abuse")).toMatch(/Mobbing is an emotional assault[\s\S]*Abuse at work rarely|Abuse at work rarely[\s\S]*Mobbing is an emotional assault/);
    expect(renderSite(quotes(), "/sets/harm")).toContain("Abuse at work rarely");
    const work = renderSite(quotes(), `/works/${workId("Mobbing")}`)!;
    expect(work.indexOf("Abuse at work rarely")).toBeLessThan(work.indexOf("Mobbing is an emotional assault"));
    expect(work).toContain("Cite as <code>[@davenport1999mobbing]</code>");
    const front = renderSite(quotes(), "/")!;
    expect(front).toContain("<h2>Recently added</h2>");
    expect(front).toContain('action="/search"');
  });

  it("searches what quotes say, a page at a time", () => {
    const html = renderSite(quotes(), "/search", new URLSearchParams("q=assault"))!;
    expect(html).toContain("<mark>assault</mark>");
    expect(html).toContain("1–1 of 1 quote");
    expect(renderSite(quotes(), "/search", new URLSearchParams("q=forty-five"))).toContain("None yet.");
    expect(renderSite(quotes(), "/search", new URLSearchParams('q="'))).toContain("no words to look for");
    expect(renderSite(quotes(), "/search")).not.toContain('class="quotes"');
  });

  it("keeps notes private unless they're shared, and private-tagged notes always", () => {
    const shared = id(SHARED_NOTE), hidden = id(PRIVATE_NOTE);
    expect(() => renderSite(quotes(), `/quotes/${shared}`)).toThrow();
    expect(renderSite(quotes({ notes: true }), `/quotes/${shared}`)).toContain(SHARED_NOTE);
    expect(() => renderSite(quotes({ notes: true }), `/quotes/${hidden}`)).toThrow();
    expect(renderSite(quotes({ notes: true }), "/search", new URLSearchParams("q=forty-five"))).toContain("1–1 of 1 quote or note");
    expect(renderSite(quotes({ notes: true }), "/search", new URLSearchParams("q=harsh"))).toContain("None yet.");
    for (const p of [...pages(), "/search?q=her"]) {
      const [path, query] = p.split("?");
      for (const notes of [false, true]) {
        const html = renderSite(quotes({ notes }), path, new URLSearchParams(query))!;
        expect(html, p).not.toContain(PRIVATE_NOTE);
        if (!notes) expect(html, p).not.toContain(SHARED_NOTE);
      }
    }
  });

  it("serves the map's quotes on the public port as public records, with public counts", async () => {
    const { pub } = await start({ level: "quotes" });
    const body = await (await fetch(`${pub}/api/concepts/mobbing/quotes`)).json();
    expect(body.total).toBe(1);
    expect(Object.keys(body.quotes[0]).sort()).toEqual(["attribution", "chapter_author", "concepts", "id", "kind", "locator", "text", "work"]);
    expect(body.quotes[0].work).toEqual({ id: workId("Mobbing"), title: "Mobbing: emotional abuse in the American workplace", authors: ["Davenport, Noa"], year: "1999", citekey: "davenport1999mobbing" });
    const concept = await (await fetch(`${pub}/api/concepts/mobbing`)).json();
    expect(concept).toMatchObject({ quotes: 1, quotes_with_narrower: 1 });
    const graph = await (await fetch(`${pub}/api/graph`)).json();
    expect(graph.concepts.find((c: { slug: string }) => c.slug === "mobbing").quotes).toBe(1);
    expect((await fetch(`${pub}/quotes/${id("emotional assault")}`)).status).toBe(200);
    expect((await fetch(`${pub}/quotes/${id(SHARED_NOTE)}`)).status).toBe(404);
  });
});

describe("the public snapshot", () => {
  const options = (rest: Partial<SnapshotOptions> = {}): SnapshotOptions =>
    ({ level: "quotes", notes: false, intro: readIntro("# Work quotes"), collections: {}, sets: SETS, maps: [], ...rest });
  const build = (rest: Partial<SnapshotOptions> = {}) => {
    const file = path.join(mapDir, `check-${built++}.db`);
    const summary = buildSnapshot(db, options(rest), file);
    return { summary, snap: new Database(file, { readonly: true }), file };
  };
  const all = (snap: Database.Database, sql: string) => snap.prepare(sql).all();

  it("holds no words at the catalogue level, only what the pages count", () => {
    const { snap } = build({ level: "catalogue" });
    expect(all(snap, "SELECT text, note, comment, locator, chapter_author, attribution, pandoc FROM records WHERE text != '' OR note IS NOT NULL OR comment IS NOT NULL OR locator IS NOT NULL OR chapter_author IS NOT NULL OR attribution IS NOT NULL OR pandoc IS NOT NULL")).toEqual([]);
    expect(all(snap, "SELECT * FROM records_fts")).toEqual([]);
    expect(all(snap, "SELECT csl, bibtex FROM works WHERE csl IS NOT NULL OR bibtex IS NOT NULL")).toEqual([]);
    expect(snap.prepare("SELECT COUNT(*) FROM records").pluck().get()).toBe(3);
  });

  it("leaves out notes unless they're shared, and private-tagged notes always", () => {
    expect(all(build().snap, "SELECT id FROM records WHERE kind = 'note'")).toEqual([]);
    const shared = build({ notes: true }).snap;
    const notes = all(shared, "SELECT note FROM records WHERE kind = 'note'") as { note: string }[];
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toContain(SHARED_NOTE);
    const dump = JSON.stringify(all(shared, "SELECT * FROM records")) + JSON.stringify(all(shared, "SELECT * FROM records_fts"));
    expect(dump).not.toContain(PRIVATE_NOTE);
  });

  it("leaves out unparsed quotes, and has no columns for status, grade, flags, or tags", () => {
    const id = db.prepare("SELECT id FROM quotes WHERE text LIKE 'Abuse at work%'").pluck().get() as number;
    db.prepare("UPDATE quotes SET status = 'unparsed' WHERE id = ?").run(id);
    try {
      const { snap } = build();
      expect(snap.prepare("SELECT COUNT(*) FROM records WHERE id = ?").pluck().get(id)).toBe(0);
      const columns = (snap.prepare("SELECT name FROM pragma_table_info('records')").pluck().all() as string[]);
      for (const private_ of ["status", "grade", "flags", "suspects", "tags", "source_url", "edited"]) expect(columns).not.toContain(private_);
    } finally {
      db.prepare("UPDATE quotes SET status = 'transcribed' WHERE id = ?").run(id);
    }
  });

  it("tidies the old site's markup and keeps what citing needs", () => {
    const { snap } = build();
    const r = snap.prepare("SELECT r.text, r.locator, r.pandoc, w.citekey, w.bibtex FROM records r JOIN works w ON w.id = r.work_id WHERE r.text LIKE 'Mobbing is%'").get() as Record<string, string>;
    expect(r).toMatchObject({ text: "Mobbing is an emotional assault.", locator: "p. 40", pandoc: "[@davenport1999mobbing, p. 40]", citekey: "davenport1999mobbing" });
    expect(r.bibtex).toMatch(/^@book\{davenport1999mobbing,/);
  });

  it("gives the same hash for the same content, and a new one when it changes", () => {
    const a = build().summary.hash, b = build().summary.hash;
    expect(a).toBe(b);
    expect(build({ level: "catalogue" }).summary.hash).not.toBe(a);
    expect(build({ intro: readIntro("# Other title") }).summary.hash).not.toBe(a);
  });

  it("is reread by the preview when a rebuild replaces it", () => {
    const file = path.join(mapDir, "replaced.db");
    buildSnapshot(db, options({ intro: readIntro("# First") }), file);
    const read = snapshotReader(file);
    expect(read()!.site.title).toBe("First");
    buildSnapshot(db, options({ intro: readIntro("# Second") }), file);
    expect(read()!.site.title).toBe("Second");
    expect(snapshotReader(path.join(mapDir, "missing.db"))()).toBeNull();
  });
});
