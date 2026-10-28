import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DB, openDb } from "../src/db.js";
import type { DrupalSite } from "../src/drupal.js";
import { runImport } from "../src/import.js";
import { servePublic, serveHttp } from "../src/server.js";
import type { ConceptSet } from "../src/sets.js";
import { type SiteOptions, readIntro, renderSite } from "../src/site.js";

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

function site(rest: Partial<SiteOptions> = {}): SiteOptions {
  const sets: ConceptSet[] = [{ slug: "harm", scheme: "human-work", label: "Harm", description: "Abuse and what it includes", narrower: ["abuse"] }];
  return { level: "catalogue", notes: false, intro: readIntro("# Work quotes\n\nQuotes about work."), collections: {}, mapDir, sets, ...rest };
}

async function start(options: Partial<SiteOptions>, publicPort = true) {
  const s = site(options);
  const base = { host: "127.0.0.1", port: 0, mapDir, sets: s.sets, site: s };
  const url = (server: http.Server) => {
    const a = server.address();
    return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  };
  const lan = await serveHttp(db, base);
  servers.push(lan);
  if (!publicPort) return { lan: url(lan), pub: "" };
  const pub = await servePublic(db, base);
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
    const html = renderSite(db, site(), "/")!;
    expect(html).toContain("<h1>Work quotes</h1>");
    expect(html).toContain("<p>Quotes about work.</p>");
    expect(html).toContain("3 quotes from 2 works, tagged with 3 concepts.");
    expect(html).toContain('href="/map/human-work/"');
    expect(html).toContain('href="/sets/harm"');
  });

  it("lists concepts, sets, and works, with counts of public quotes only", () => {
    expect(renderSite(db, site(), "/concepts/abuse")).toContain("2 quotes, with its narrower concepts");
    expect(renderSite(db, site(), "/concepts/abuse")).toContain('href="/map/human-work/#/concept/abuse"');
    expect(renderSite(db, site(), "/concepts/mobbing")).toContain("In <a href=\"/sets/harm\">Harm</a>");
    expect(renderSite(db, site(), "/sets/harm")).toMatch(/abuse<\/a> <span class="count">1<\/span>.*mobbing<\/a> <span class="count">1<\/span>/s);
    const works = renderSite(db, site(), "/works")!;
    expect(works.indexOf("Davenport")).toBeLessThan(works.indexOf("Doe"));
    expect(renderSite(db, site(), `/works/${workId("Mobbing")}`)).toContain("2 quotes");
  });

  it("shows no quoted text and no notes", () => {
    for (const p of pages()) {
      const html = renderSite(db, site(), p)!;
      for (const words of [...QUOTED, SHARED_NOTE, PRIVATE_NOTE]) expect(html, `${p} shows "${words}"`).not.toContain(words);
    }
  });

  it("answers null or a not-found for what isn't there", () => {
    expect(renderSite(db, site(), "/nowhere")).toBeNull();
    expect(() => renderSite(db, site(), "/concepts/nothing")).toThrow();
    expect(() => renderSite(db, site(), "/sets/nothing")).toThrow();
    expect(() => renderSite(db, site(), "/works/99999")).toThrow();
    expect(renderSite(db, site({ level: "none" }), "/")).toBeNull();
  });

  it("counts shared notes at the quotes level, but not private ones", () => {
    expect(renderSite(db, site({ level: "quotes", notes: true }), "/")).toContain("4 quotes and notes from 2 works");
    expect(renderSite(db, site({ level: "quotes" }), "/")).toContain("3 quotes from 2 works");
    expect(renderSite(db, site({ level: "catalogue", notes: true }), "/")).toContain("3 quotes from 2 works");
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
    const html = renderSite(db, site({ collections: intros }), "/")!;
    expect(html).toContain("<h2>Collections</h2>");
    expect(html).toMatch(/href="\/collections\/ethics"><h3>Ethics<\/h3>\s*<p>Right and wrong<\/p><p class="count">1 quote · 1 work · 1 concept<\/p>/);
    expect(html).toMatch(/href="\/collections\/human-work"><h3>The human side of work<\/h3>\s*<p>What work does to people.<\/p><p class="count">3 quotes · 2 works · 3 concepts<\/p>/);
    expect(html).not.toContain("Since 2014");
  });

  it("gives each collection a page with its own maps, sets, and filtered lists", () => {
    const work = renderSite(db, site({ collections: intros }), "/collections/human-work")!;
    expect(work).toContain("<h1>The human side of work</h1>");
    expect(work).toContain("Since 2014");
    expect(work).toContain('href="/map/human-work/"');
    expect(work).toContain('href="/sets/harm"');
    expect(work).toContain('href="/concepts?collection=human-work"');
    const ethics = renderSite(db, site({ collections: intros }), "/collections/ethics")!;
    expect(ethics).toContain("<p>Right and wrong</p>");
    expect(ethics).not.toContain("/map/human-work/");
    expect(ethics).not.toContain("/sets/harm");
    const concepts = renderSite(db, site(), "/concepts", new URLSearchParams("collection=ethics"))!;
    expect(concepts).toContain("respect");
    expect(concepts).not.toContain("mobbing");
    const works = renderSite(db, site(), "/works", new URLSearchParams("collection=ethics"))!;
    expect(works).toContain("A Book Nobody Filed");
    expect(works).not.toContain("Davenport");
    expect(renderSite(db, site(), "/concepts/respect")).toContain('href="/collections/ethics"');
    expect(() => renderSite(db, site(), "/collections/nothing")).toThrow();
    expect(() => renderSite(db, site(), "/works", new URLSearchParams("collection=nothing"))).toThrow();
  });
});

describe("one collection", () => {
  it("shows it inline on the front page, under its own heading when it has an introduction", () => {
    const html = renderSite(db, site({ collections: { "human-work": readIntro("# The human side of work\n\nWhat work does to people.") } }), "/")!;
    expect(html).not.toContain("<h2>Collections</h2>");
    expect(html).toContain("<h2>The human side of work</h2>");
    expect(html).toContain('href="/concepts"');
    expect(renderSite(db, site(), "/")).not.toContain("<h2>The human side of work</h2>");
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
    for (const p of ["/admin", "/admin/quotes", "/mcp", "/health", "/api/concepts/abuse/quotes", "/api/nowhere", "/anything"]) {
      expect((await fetch(`${pub}${p}`, { redirect: "manual" })).status, p).toBe(404);
    }
    expect((await fetch(`${pub}/mcp`, { method: "POST", body: "{}" })).status).toBe(404);
    for (const p of ["/api/graph", "/api/concepts/abuse", "/api/sets", "/api/sets/harm"]) expect((await fetch(`${pub}${p}`)).status, p).toBe(200);
    expect((await fetch(`${pub}/map/maps.json`)).status).toBe(200);
    expect((await fetch(`${lan}/admin`)).status).toBe(200);
  });

  it("redirects / to /admin with no public site, and refuses a public port", async () => {
    const { lan } = await start({ level: "none" }, false);
    const res = await fetch(`${lan}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect((await fetch(`${lan}/concepts`)).status).toBe(404);
    expect(() => servePublic(db, { host: "127.0.0.1", port: 0, site: site({ level: "none" }) })).toThrow(/QUOTE_PUBLIC/);
  });
});
