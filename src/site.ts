import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import { type Level, type PublicRecord, publicCitation, publicCount, publicQuotes, publicRecord, quoteHtml, visible } from "./public.js";
import { ToolError, getConcept, withNarrower, workSummary } from "./queries.js";
import { type ConceptSet, listSets, setGraph } from "./sets.js";
import { CSS, esc } from "./web.js";

/**
 * The public site: a front page at / and pages for collections, concepts, sets, and works, off unless
 * QUOTE_PUBLIC is set. A collection is a concept scheme as readers see it (the human side of work, say):
 * its concepts decide what's in it, so a work quoted in two collections is in both, and each has an
 * introduction in vocab/collections/<scheme>.md. With one collection the front page shows it inline.
 *
 *   catalogue   concepts, sets, maps, works by title and author, and counts; no quoted text
 *   quotes      the catalogue, plus a page per quote with how to cite it, search, and the quotes on each
 *               concept's, set's, and work's page (and notes, with QUOTE_PUBLIC_NOTES=all)
 *
 * What a record may show is decided in src/public.ts, not here, and these pages use only its queries
 * for quotes, never the admin pages', so a field added there can't leak here.
 */

export type { Level } from "./public.js";
export const LEVELS: readonly Level[] = ["none", "catalogue", "quotes"];

export interface SiteOptions {
  level: Level;
  /** Notes beside quotes on public pages (QUOTE_PUBLIC_NOTES=all); only at the quotes level. */
  notes: boolean;
  /** The front page's title and introduction, from vocab/site.md. */
  intro: Intro;
  /** Each collection's title and introduction, by scheme slug, from vocab/collections/<scheme>.md. */
  collections: Record<string, Intro>;
  mapDir?: string;
  sets: ConceptSet[];
}

export interface Intro { title: string; html: string; /** The first paragraph as plain text, for a card. */ summary: string | null }

// --- The introduction ----------------------------------------------------------------------------

/** Inline Markdown: links (web, mail, and site-relative only), **strong**, *emphasis*, and `code`. */
function inline(text: string): string {
  return esc(text)
    .replace(/\[([^\]]+)\]\(((?:https?:|mailto:|\/|#)[^)\s]*)\)/g, (_, label: string, href: string) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * The front page's introduction from a little Markdown: a `# Title` line, then paragraphs, `## headings`,
 * and `- lists`, separated by blank lines.
 */
export function readIntro(markdown: string): Intro {
  const lines = markdown.replace(/\r\n/g, "\n").trim().split("\n");
  const title = /^#\s+(.+)$/.exec(lines[0] ?? "")?.[1].trim();
  const blocks = (title ? lines.slice(1) : lines).join("\n").trim().split(/\n\s*\n/).filter(Boolean);
  const html = blocks.map((b) => {
    const heading = /^##\s+(.+)$/.exec(b);
    if (heading) return `<h2>${inline(heading[1])}</h2>`;
    const items = b.split("\n");
    if (items.every((l) => /^[-*]\s+/.test(l))) return `<ul>${items.map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${inline(b.replace(/\n/g, " "))}</p>`;
  }).join("\n");
  const first = blocks.find((b) => !/^(##\s|[-*]\s)/.test(b));
  const summary = first?.replace(/\n/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "") ?? null;
  return { title: title ?? "Quotes", html, summary };
}

/** The introduction from a file, or a plain title when there isn't one. */
export function loadIntro(file: string): Intro {
  return fs.existsSync(file) ? readIntro(fs.readFileSync(file, "utf8")) : { title: "Quotes", html: "", summary: null };
}

/** The collections' introductions in a folder, one <scheme>.md each; none when there's no folder. */
export function loadCollections(dir: string): Record<string, Intro> {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f.slice(0, -3), readIntro(fs.readFileSync(path.join(dir, f), "utf8"))]));
}

// --- Public queries ------------------------------------------------------------------------------

interface PublicWork { id: number; title: string; authors: string[]; year: string | null; quotes: number }

const json = <T>(v: string | null, fallback: T): T => (v ? (JSON.parse(v) as T) : fallback);
const works = (rows: (Omit<PublicWork, "authors"> & { authors: string })[]): PublicWork[] => rows.map((w) => ({ ...w, authors: json<string[]>(w.authors, []) }));

function counts(db: DB, site: SiteOptions) {
  return db.prepare(`SELECT COUNT(*) AS quotes, COUNT(DISTINCT q.work_id) AS works,
    (SELECT COUNT(*) FROM concepts WHERE status != 'retired') AS concepts FROM quotes q WHERE ${visible(site)}`).get() as { quotes: number; works: number; concepts: number };
}

/** Public records tagged with each concept, by concept id. */
function conceptCounts(db: DB, site: SiteOptions): Map<number, number> {
  const rows = db.prepare(`SELECT t.concept_id AS id, COUNT(DISTINCT q.id) AS n FROM quote_tags t JOIN quotes q ON q.id = t.quote_id
    WHERE t.concept_id IS NOT NULL AND ${visible(site)} GROUP BY t.concept_id`).all() as { id: number; n: number }[];
  return new Map(rows.map((r) => [r.id, r.n]));
}

function publicConcepts(db: DB, site: SiteOptions, scheme: string | null = null) {
  const n = conceptCounts(db, site);
  return (db.prepare(`SELECT c.id, s.slug AS scheme, c.slug, c.label, c.definition FROM concepts c JOIN schemes s ON s.id = c.scheme_id
    WHERE c.status != 'retired' AND (? IS NULL OR s.slug = ?) ORDER BY lower(c.label)`).all(scheme, scheme) as { id: number; scheme: string; slug: string; label: string; definition: string | null }[])
    .map((c) => ({ ...c, quotes: n.get(c.id) ?? 0 }));
}

/** Works with public records, by first author, or those quoted under some concepts. */
function publicWorks(db: DB, site: SiteOptions, conceptIds?: number[]): PublicWork[] {
  const within = conceptIds ? `AND q.id IN (SELECT quote_id FROM quote_tags WHERE concept_id IN (${conceptIds.join(",")}))` : "";
  return works(db.prepare(`SELECT w.id, w.title, w.authors, w.year, COUNT(*) AS quotes FROM quotes q JOIN works w ON w.id = q.work_id
    WHERE ${visible(site)} ${within} GROUP BY w.id ORDER BY lower(json_extract(w.authors, '$[0]')) NULLS LAST, lower(w.title)`).all() as never);
}

interface Collection { scheme: string; intro: Intro; quotes: number; works: number; concepts: number; conceptIds: number[] }

/** Each concept scheme with concepts, as a collection: its introduction (or the scheme's label and description) and its public counts. */
function collections(db: DB, site: SiteOptions): Collection[] {
  const schemes = db.prepare("SELECT id, slug, label, description FROM schemes ORDER BY lower(label)").all() as { id: number; slug: string; label: string; description: string | null }[];
  const ids = db.prepare("SELECT id FROM concepts WHERE scheme_id = ? AND status != 'retired'").pluck();
  return schemes.map((s) => {
    const conceptIds = ids.all(s.id) as number[];
    const n = db.prepare(`SELECT COUNT(*) AS quotes, COUNT(DISTINCT q.work_id) AS works FROM quotes q
      WHERE ${visible(site)} AND q.id IN (SELECT quote_id FROM quote_tags WHERE concept_id IN (${conceptIds.join(",")}))`).get() as { quotes: number; works: number };
    const intro = site.collections[s.slug] ?? { title: s.label, html: s.description ? `<p>${esc(s.description)}</p>` : "", summary: s.description };
    return { scheme: s.slug, intro, ...n, concepts: conceptIds.length, conceptIds };
  }).filter((c) => c.concepts > 0);
}

function findCollection(db: DB, site: SiteOptions, scheme: string): Collection {
  const c = collections(db, site).find((x) => x.scheme === scheme);
  if (!c) throw new ToolError(`No collection "${scheme}".`);
  return c;
}

/** Public records tagged with no concept, so in no collection yet. */
function untagged(db: DB, site: SiteOptions): number {
  return db.prepare(`SELECT COUNT(*) FROM quotes q WHERE ${visible(site)} AND NOT EXISTS (SELECT 1 FROM quote_tags t JOIN concepts c ON c.id = t.concept_id
    WHERE t.quote_id = q.id AND c.status != 'retired')`).pluck().get() as number;
}

function publicWork(db: DB, site: SiteOptions, id: number) {
  const [work] = works(db.prepare(`SELECT w.id, w.title, w.authors, w.year, COUNT(*) AS quotes FROM quotes q JOIN works w ON w.id = q.work_id
    WHERE w.id = ? AND ${visible(site)} GROUP BY w.id`).all(id) as never);
  if (!work) throw new ToolError(`No work ${id}.`);
  const concepts = db.prepare(`SELECT s.slug AS scheme, c.slug, c.label, COUNT(DISTINCT q.id) AS quotes FROM quotes q
    JOIN quote_tags t ON t.quote_id = q.id JOIN concepts c ON c.id = t.concept_id JOIN schemes s ON s.id = c.scheme_id
    WHERE q.work_id = ? AND c.status != 'retired' AND ${visible(site)} GROUP BY c.id ORDER BY quotes DESC, lower(c.label)`)
    .all(id) as { scheme: string; slug: string; label: string; quotes: number }[];
  return { ...work, concepts };
}

// --- Maps ----------------------------------------------------------------------------------------

interface MapEntry { name: string; title: string; description?: string; scheme?: string; set?: string }

/** The maps quote-atlas has installed, from its maps.json; read per request, since its deploy can change them. */
function readMaps(site: SiteOptions): MapEntry[] {
  if (!site.mapDir) return [];
  try {
    const maps = JSON.parse(fs.readFileSync(path.join(site.mapDir, "maps.json"), "utf8")) as MapEntry[];
    return Array.isArray(maps) ? maps.filter((m) => typeof m?.name === "string" && /^[\w-]+$/.test(m.name)) : [];
  } catch {
    return [];
  }
}

// --- Pages ---------------------------------------------------------------------------------------

type Section = "home" | "concepts" | "works" | "maps" | "search";

const SITE_CSS = `
.intro { max-width: 46rem; font-size: 1.02rem; }
.intro p { margin: 0 0 10px; }
.stats { color: var(--muted); margin: 6px 0 4px; }
a.card { text-decoration: none; color: inherit; display: block; }
a.card:hover { border-color: var(--accent); }
.card h3 { margin: 0 0 4px; font-size: 1rem; color: var(--accent); }
.card p { margin: 0; color: var(--muted); font-size: 0.9rem; }
.letters { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 8px 0 4px; }
.az h2 { border-bottom: 1px solid var(--border); padding-bottom: 4px; }
.az ul, .plain-list { list-style: none; padding: 0; margin: 0; columns: 16rem; column-gap: 24px; }
.az li, .plain-list li { break-inside: avoid; padding: 2px 0; }
.count { color: var(--muted); font-size: 0.85rem; }
.works li { padding: 4px 0; }
.quotes { list-style: none; padding: 0; margin: 0; }
.quotes > li { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
.quotes blockquote, .quote-page blockquote { margin: 0 0 8px; }
.quote-page blockquote { font-size: 1.08rem; }
.source { color: var(--muted); font-size: 0.9rem; margin: 0 0 4px; }
.permalink { color: var(--muted); font-size: 0.82rem; text-decoration: none; float: right; margin-left: 8px; }
form.search { display: flex; gap: 8px; margin: 14px 0; max-width: 40rem; }
form.search input { flex: 1; font: inherit; padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); min-width: 0; }
.cite pre { white-space: pre-wrap; }
`;

function page(site: SiteOptions, title: string | null, section: Section, body: string): string {
  const nav: [Section, string, string][] = [["home", "Home", "/"], ["concepts", "Concepts", "/concepts"], ["works", "Works", "/works"]];
  if (site.mapDir) nav.push(["maps", "Maps", "/map/"]);
  if (site.level === "quotes") nav.push(["search", "Search", "/search"]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${esc(title)} · ` : ""}${esc(site.intro.title)}</title><style>${CSS}${SITE_CSS}</style></head><body>
<header class="topbar"><div class="topbar-inner"><a class="brand" href="/" style="color:inherit;text-decoration:none">${esc(site.intro.title)}</a><nav class="nav">
${nav.map(([k, label, href]) => `<a href="${href}"${k === section ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
</nav></div></header><main>${body}</main></body></html>`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
const conceptHref = (slug: string) => `/concepts/${encodeURIComponent(slug)}`;
const records = (site: SiteOptions, n: number) => plural(n, site.level === "quotes" && site.notes ? "quote or note" : "quote", site.level === "quotes" && site.notes ? "quotes and notes" : "quotes");

function authorsOf(authors: string[]): string {
  return authors.slice(0, 3).join("; ") + (authors.length > 3 ? " et al." : "");
}

function workItem(w: PublicWork, site: SiteOptions): string {
  const who = authorsOf(w.authors);
  return `<li>${who ? `${esc(who)}, ` : ""}<a href="/works/${w.id}"><cite>${esc(w.title)}</cite></a>${w.year ? ` (${esc(w.year)})` : ""} <span class="count">${records(site, w.quotes)}</span></li>`;
}

function card(href: string, title: string, text: string | null | undefined): string {
  return `<a class="card" href="${esc(href)}"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ""}</a>`;
}

// --- Quotes, at the quotes level -------------------------------------------------------------------

const quoting = (site: SiteOptions) => site.level === "quotes";
const PAGE = 20;

function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== 0) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

function offsetOf(params: URLSearchParams): number {
  const n = Number(params.get("offset") ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Where a record comes from: chapter author, authors, the work (linked), year, and place. */
function source(r: PublicRecord): string {
  const w = r.work;
  const who = w ? authorsOf(w.authors) : "";
  return `<p class="source">${r.chapter_author ? `${esc(r.chapter_author)}, in ` : ""}${who ? `${esc(who)}, ` : ""}${w ? `<a href="/works/${w.id}"><cite>${esc(w.title)}</cite></a>` : ""}${w?.year ? ` (${esc(w.year)})` : ""}${r.locator ? `${w ? ", " : ""}${esc(r.locator)}` : ""}${r.attribution ? ` — ${esc(r.attribution)}` : ""}</p>`;
}

function conceptChips(r: PublicRecord): string {
  return r.concepts.length ? `<p>${r.concepts.map((c) => `<a class="chip" href="${conceptHref(c.slug)}">${esc(c.label)}</a>`).join("")}</p>` : "";
}

function words(r: PublicRecord): string {
  if (r.kind === "note") return `<div class="words"><span class="kind">note</span>${esc(r.note ?? "")}</div>`;
  return `<blockquote>${quoteHtml(r.text)}</blockquote>`;
}

function quoteItem(r: PublicRecord): string {
  const text = r.snippet ? `<p>${esc(r.snippet).replace(/«/g, "<mark>").replace(/»/g, "</mark>")}</p>` : words(r);
  return `<li><a class="permalink" href="/quotes/${r.id}" title="This ${r.kind}'s page, with how to cite it">#${r.id}</a>${text}${source(r)}${conceptChips(r)}</li>`;
}

/** A page of records, with links to the pages before and after it. */
function quoteList(site: SiteOptions, result: ReturnType<typeof publicQuotes>, base: string, params: Record<string, unknown>): string {
  if (!result.total) return '<p class="note">None yet.</p>';
  const { total, offset, limit } = result;
  const prev = offset > 0 ? `<a href="${base}${qs({ ...params, offset: Math.max(0, offset - limit) })}">← Previous</a>` : "";
  const next = offset + limit < total ? `<a href="${base}${qs({ ...params, offset: offset + limit })}">Next →</a>` : "";
  return `<ol class="quotes">${result.quotes.map(quoteItem).join("")}</ol>
<div class="pager">${prev}${next}<span class="note">${offset + 1}–${Math.min(total, offset + limit)} of ${records(site, total)}</span></div>`;
}

function searchForm(query: string, collection: string | null): string {
  return `<form class="search" method="get" action="/search" role="search"><input type="search" name="q" value="${esc(query)}" placeholder="Words or &quot;a phrase&quot;" aria-label="Search the quotes">
${collection ? `<input type="hidden" name="collection" value="${esc(collection)}">` : ""}<button>Search</button></form>`;
}

function searchPage(db: DB, site: SiteOptions, params: URLSearchParams): string {
  const query = (params.get("q") ?? "").trim();
  const c = chosen(db, site, params);
  let body = "";
  if (query) {
    try {
      const result = publicQuotes(db, site, { query, conceptIds: c?.conceptIds, limit: PAGE, offset: offsetOf(params) });
      body = quoteList(site, result, "/search", { q: query, collection: c?.scheme });
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      body = `<p class="note">${esc(error.message)}</p>`;
    }
  }
  return page(site, query ? `“${query}”` : "Search", "search", `<h1>Search</h1>
<p class="sub">Words are looked for in what the quotes say; "a phrase" is kept together, and a trailing * matches the start of a word${within(db, site, c)}.</p>
${searchForm(query, c?.scheme ?? null)}${body}`);
}

function quotePage(db: DB, site: SiteOptions, id: number): string {
  const r = publicRecord(db, site, id);
  const c = publicCitation(db, site, id);
  const name = r.kind === "note" ? "A note" : "A quote";
  const title = r.work ? `${name} from ${r.work.title}` : name;
  return page(site, title, "works", `<div class="quote-page"><h1>${esc(title)}</h1>
${words(r)}${source(r)}${conceptChips(r)}
${r.comment ? `<h2>Comment</h2><p>${esc(r.comment)}</p>` : ""}
<h2>Cite this</h2><div class="cite">
${c.pandoc ? `<p>Pandoc: <code>${esc(c.pandoc)}</code></p>` : ""}
${c.bibtex ? `<details${c.pandoc ? "" : " open"}><summary>BibTeX</summary><pre>${esc(c.bibtex)}</pre></details>` : ""}
${c.csl ? `<details><summary>CSL JSON</summary><pre>${esc(JSON.stringify(c.csl, null, 2))}</pre></details>` : '<p class="note">There\'s no work recorded to cite.</p>'}
${r.work && !r.work.citekey ? '<p class="note">This work isn\'t filed in Zotero with a citekey yet, so there\'s no Pandoc citation; the BibTeX and CSL come from its old catalogue record.</p>' : ""}
</div></div>`);
}

/** A collection's maps and starting points (concept sets), or every collection's. */
function waysIn(db: DB, site: SiteOptions, scheme: string | null): string {
  const maps = readMaps(site).filter((m) => !scheme || (m.scheme ?? m.name) === scheme);
  const sets = listSets(db, site.sets).filter((s) => s.concepts > 0 && (!scheme || s.scheme === scheme));
  return `${maps.length ? `<h2>Maps</h2><div class="grid">${maps.map((m) => card(`/map/${m.name}/`, m.title ?? m.name, m.description)).join("")}</div>` : ""}
${sets.length ? `<h2>Starting points</h2><div class="grid">${sets.map((s) => card(`/sets/${s.slug}`, s.label, s.description)).join("")}</div>` : ""}`;
}

function browse(site: SiteOptions, n: { works: number; concepts: number }, scheme: string | null): string {
  const q = scheme ? `?collection=${encodeURIComponent(scheme)}` : "";
  return `<h2>Browse</h2><div class="grid">${card(`/concepts${q}`, "Concepts", `${plural(n.concepts, "concept")}, A to Z`)}${card(`/works${q}`, "Works", `${plural(n.works, "work")}, by author`)}</div>`;
}

function stats(site: SiteOptions, n: { quotes: number; works: number; concepts: number }): string {
  return `<p class="stats">${records(site, n.quotes)} from ${plural(n.works, "work")}, tagged with ${plural(n.concepts, "concept")}.</p>`;
}

function frontPage(db: DB, site: SiteOptions): string {
  const n = counts(db, site);
  const all = collections(db, site);
  const head = `<h1>${esc(site.intro.title)}</h1>\n<div class="intro">${site.intro.html}</div>\n${stats(site, n)}${quoting(site) ? searchForm("", null) : ""}`;
  const recent = quoting(site) ? `<h2>Recently added</h2><ol class="quotes">${publicQuotes(db, site, { newest: true, limit: 5 }).quotes.map(quoteItem).join("")}</ol>` : "";
  if (all.length <= 1) {
    // One collection: shown inline, under its own heading when it has an introduction of its own.
    const c = all[0];
    const own = c && site.collections[c.scheme] ? `<h2>${esc(c.intro.title)}</h2><div class="intro">${c.intro.html}</div>` : "";
    return page(site, null, "home", `${head}${own}${waysIn(db, site, null)}${browse(site, n, null)}${recent}`);
  }
  const loose = untagged(db, site);
  return page(site, null, "home", `${head}
<h2>Collections</h2><div class="grid">${all.map((c) => `<a class="card" href="/collections/${encodeURIComponent(c.scheme)}"><h3>${esc(c.intro.title)}</h3>
${c.intro.summary ? `<p>${esc(c.intro.summary)}</p>` : ""}<p class="count">${records(site, c.quotes)} · ${plural(c.works, "work")} · ${plural(c.concepts, "concept")}</p></a>`).join("")}</div>
${loose ? `<p class="note">${records(site, loose)} not yet tagged with a concept, so in no collection; they're under Works.</p>` : ""}
${waysIn(db, site, null)}${browse(site, n, null)}${recent}`);
}

function collectionPage(db: DB, site: SiteOptions, scheme: string): string {
  const c = findCollection(db, site, scheme);
  return page(site, c.intro.title, "home", `<h1>${esc(c.intro.title)}</h1>
<div class="intro">${c.intro.html}</div>${stats(site, c)}${quoting(site) ? searchForm("", c.scheme) : ""}${waysIn(db, site, c.scheme)}${browse(site, c, c.scheme)}`);
}

/** The collection a ?collection= asks for, or null for all; a ToolError for one that isn't there. */
function chosen(db: DB, site: SiteOptions, params: URLSearchParams): Collection | null {
  const scheme = params.get("collection");
  return scheme ? findCollection(db, site, scheme) : null;
}

/** "in <collection>", linked, when there's more than one collection to tell apart. */
function within(db: DB, site: SiteOptions, c: Collection | null): string {
  return c && collections(db, site).length > 1 ? ` in <a href="/collections/${encodeURIComponent(c.scheme)}">${esc(c.intro.title)}</a> · <a href="?">all collections</a>` : "";
}

function conceptsPage(db: DB, site: SiteOptions, params: URLSearchParams): string {
  const c = chosen(db, site, params);
  const list = publicConcepts(db, site, c?.scheme ?? null);
  const groups = new Map<string, typeof list>();
  for (const c of list) {
    const letter = /^[a-z]/i.test(c.label) ? c.label[0].toUpperCase() : "#";
    (groups.get(letter) ?? groups.set(letter, []).get(letter)!).push(c);
  }
  return page(site, "Concepts", "concepts", `<h1>Concepts</h1><p class="sub">${plural(list.length, "concept")}${within(db, site, c)}. A concept's count includes only what's tagged with it, not its narrower concepts.</p>
<nav class="letters">${[...groups.keys()].map((l) => `<a href="#${l === "#" ? "other" : l}">${l}</a>`).join("")}</nav>
<div class="az">${[...groups].map(([l, cs]) => `<h2 id="${l === "#" ? "other" : l}">${l}</h2><ul>${cs.map((c) => `<li><a href="${conceptHref(c.slug)}">${esc(c.label)}</a> <span class="count">${c.quotes}</span></li>`).join("")}</ul>`).join("")}</div>`);
}

function conceptPage(db: DB, site: SiteOptions, slug: string, params: URLSearchParams): string {
  const c = getConcept(db, slug);
  const ids = withNarrower(db, c.id);
  const quoted = publicWorks(db, site, ids);
  const total = publicCount(db, site, ids);
  const worksList = quoted.length ? `<ul class="plain-list works">${quoted.map((w) => workItem(w, site)).join("")}</ul>` : '<p class="note">None yet.</p>';
  const listed = quoting(site)
    ? `<h2>Quotes</h2>${quoteList(site, publicQuotes(db, site, { conceptIds: ids, limit: PAGE, offset: offsetOf(params) }), conceptHref(c.slug), {})}
<details><summary>Works quoted (${quoted.length})</summary>${worksList}</details>`
    : `<h2>Works quoted</h2>${worksList}`;
  const relations = Object.entries(c.relations).map(([type, list]) =>
    `<tr><th>${esc(type)}</th><td>${list.map((r) => `<a class="chip" href="${conceptHref(r.slug)}">${esc(r.label)}</a>`).join("")}</td></tr>`).join("");
  const inSets = listSets(db, site.sets).filter((s) => s.scheme === c.scheme && setGraph(db, site.sets, s.slug).concepts.some((m) => m.slug === c.slug));
  const maps = readMaps(site).filter((m) => (m.scheme ?? m.name) === c.scheme && !m.set);
  const all = collections(db, site);
  const home = all.length > 1 ? all.find((x) => x.scheme === c.scheme) : undefined;
  return page(site, c.label, "concepts", `<h1>${esc(c.label)}</h1>
<p class="sub">${home ? `<a href="/collections/${encodeURIComponent(home.scheme)}">${esc(home.intro.title)}</a> · ` : ""}${records(site, total)}${ids.length > 1 ? ", with its narrower concepts" : ""}${maps.map((m) => ` · <a href="/map/${m.name}/#/concept/${encodeURIComponent(c.slug)}">on the map</a>`).join("")}</p>
${c.definition ? `<p>${esc(c.definition)}</p>` : ""}
${c.alt_labels.length || relations ? `<div class="scroll"><table>${c.alt_labels.length ? `<tr><th>Also</th><td>${c.alt_labels.map(esc).join(", ")}</td></tr>` : ""}${relations}</table></div>` : ""}
${inSets.length ? `<p class="meta">In ${inSets.map((s) => `<a href="/sets/${s.slug}">${esc(s.label)}</a>`).join(", ")}</p>` : ""}
${listed}`);
}

function setPage(db: DB, site: SiteOptions, slug: string, params: URLSearchParams): string {
  const set = setGraph(db, site.sets, slug);
  const n = conceptCounts(db, site);
  const ids = new Map((db.prepare("SELECT c.slug, c.id FROM concepts c JOIN schemes s ON s.id = c.scheme_id WHERE s.slug = ?").all(set.scheme) as { slug: string; id: number }[]).map((r) => [r.slug, r.id]));
  const maps = readMaps(site).filter((m) => m.set === set.slug);
  return page(site, set.label, "concepts", `<h1>${esc(set.label)}</h1>
${set.description ? `<p class="intro">${esc(set.description)}</p>` : ""}
<p class="sub">${plural(set.concepts.length, "concept")}${maps.map((m) => ` · <a href="/map/${m.name}/">${esc(m.title ?? m.name)}</a>`).join("")}</p>
<ul class="plain-list">${set.concepts.map((c) => `<li><a href="${conceptHref(c.slug)}">${esc(c.label)}</a> <span class="count">${n.get(ids.get(c.slug) ?? -1) ?? 0}</span></li>`).join("")}</ul>
${quoting(site) ? `<h2>Quotes</h2>${quoteList(site, publicQuotes(db, site, { conceptIds: set.concepts.map((c) => ids.get(c.slug)!), limit: PAGE, offset: offsetOf(params) }), `/sets/${set.slug}`, {})}` : ""}`);
}

function worksPage(db: DB, site: SiteOptions, params: URLSearchParams): string {
  const c = chosen(db, site, params);
  const list = publicWorks(db, site, c?.conceptIds);
  return page(site, "Works", "works", `<h1>Works</h1><p class="sub">${plural(list.length, "work")} quoted${within(db, site, c)}, by first author.</p>
<ul class="plain-list works" style="columns:auto">${list.map((w) => workItem(w, site)).join("")}</ul>`);
}

function workPage(db: DB, site: SiteOptions, id: number, params: URLSearchParams): string {
  const w = publicWork(db, site, id);
  const citekey = workSummary(db, id)?.citekey ?? null;
  return page(site, w.title, "works", `<h1><cite>${esc(w.title)}</cite></h1>
<p class="sub">${w.authors.length ? `${esc(authorsOf(w.authors))} · ` : ""}${w.year ? `${esc(w.year)} · ` : ""}${records(site, w.quotes)}</p>
<h2>Concepts</h2>${w.concepts.length ? `<p>${w.concepts.map((c) => `<a class="chip" href="${conceptHref(c.slug)}">${esc(c.label)} <span class="count">${c.quotes}</span></a>`).join("")}</p>` : '<p class="note">None tagged.</p>'}
${quoting(site) ? `<h2>Quotes</h2>${quoteList(site, publicQuotes(db, site, { work: id, limit: 50, offset: offsetOf(params) }), `/works/${id}`, {})}${citekey ? `<p class="meta">Cite as <code>[@${esc(citekey)}]</code>, with the page.</p>` : ""}` : ""}`);
}

/** The paths the public site answers, so the server can route them. */
export function isSitePath(pathname: string): boolean {
  return pathname === "/" || /^\/(collections|concepts|works|sets|quotes|search)(\/|$)/.test(pathname);
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new ToolError("Not found.");
  }
}

/** The HTML for a public path, or null when there's no such page; a ToolError for a concept, set, or work that isn't there. */
export function renderSite(db: DB, site: SiteOptions, pathname: string, params = new URLSearchParams()): string | null {
  if (site.level === "none") return null;
  if (pathname === "/") return frontPage(db, site);
  if (pathname === "/concepts" || pathname === "/concepts/") return conceptsPage(db, site, params);
  if (pathname === "/works" || pathname === "/works/") return worksPage(db, site, params);
  let m = /^\/collections\/([^/]+)$/.exec(pathname);
  if (m) return collectionPage(db, site, decoded(m[1]));
  m = /^\/concepts\/([^/]+)$/.exec(pathname);
  if (m) return conceptPage(db, site, decoded(m[1]), params);
  m = /^\/sets\/([^/]+)$/.exec(pathname);
  if (m) return setPage(db, site, decoded(m[1]), params);
  m = /^\/works\/(\d+)$/.exec(pathname);
  if (m) return workPage(db, site, Number(m[1]), params);
  if (!quoting(site)) return null;
  if (pathname === "/search") return searchPage(db, site, params);
  m = /^\/quotes\/(\d+)$/.exec(pathname);
  if (m) return quotePage(db, site, Number(m[1]));
  return null;
}
