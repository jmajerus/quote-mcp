import type { Collection, PublicRecord, Published } from "./published.js";
import { quoteHtml } from "./public.js";
import { ToolError } from "./queries.js";
import { CSS, esc } from "./web.js";

/**
 * The public site: a front page at / and pages for collections, concepts, sets, works, and (at the quotes
 * level) quotes and search, read from the public snapshot (src/published.ts) and nothing else, so they
 * can show only what was published. A collection is a concept scheme as readers see it (the human side of
 * work, say): its concepts decide what's in it, so a work quoted in two collections is in both. With one
 * collection the front page shows it inline.
 *
 *   catalogue   concepts, sets, maps, works by title and author, and counts; no quoted text
 *   quotes      the catalogue, plus a page per quote with how to cite it, search, and the quotes on each
 *               concept's, set's, and work's page (and notes, if the snapshot shares them)
 */

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

const PAGE = 20;

function page(p: Published, title: string | null, section: Section, body: string): string {
  const nav: [Section, string, string][] = [["home", "Home", "/"], ["concepts", "Concepts", "/concepts"], ["works", "Works", "/works"]];
  if (p.maps().length) nav.push(["maps", "Maps", "/map/"]);
  if (p.quoting) nav.push(["search", "Search", "/search"]);
  const site = p.site;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${esc(title)} · ` : ""}${esc(site.title)}</title><style>${CSS}${SITE_CSS}</style></head><body>
<header class="topbar"><div class="topbar-inner"><a class="brand" href="/" style="color:inherit;text-decoration:none">${esc(site.title)}</a><nav class="nav">
${nav.map(([k, label, href]) => `<a href="${href}"${k === section ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
</nav></div></header><main>${body}</main></body></html>`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
const conceptHref = (slug: string) => `/concepts/${encodeURIComponent(slug)}`;
const records = (p: Published, n: number) => (p.quoting && p.notes ? plural(n, "quote or note", "quotes and notes") : plural(n, "quote"));

function authorsOf(authors: string[]): string {
  return authors.slice(0, 3).join("; ") + (authors.length > 3 ? " et al." : "");
}

function workItem(p: Published, w: { id: number; title: string; authors: string[]; year: string | null; quotes: number }): string {
  const who = authorsOf(w.authors);
  return `<li>${who ? `${esc(who)}, ` : ""}<a href="/works/${w.id}"><cite>${esc(w.title)}</cite></a>${w.year ? ` (${esc(w.year)})` : ""} <span class="count">${records(p, w.quotes)}</span></li>`;
}

function card(href: string, title: string, text: string | null | undefined): string {
  return `<a class="card" href="${esc(href)}"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ""}</a>`;
}

// --- Quotes, at the quotes level -------------------------------------------------------------------

function qs(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== 0) q.set(k, String(v));
  const s = q.toString();
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
function quoteList(p: Published, result: ReturnType<Published["quotes"]>, base: string, params: Record<string, unknown>): string {
  if (!result.total) return '<p class="note">None yet.</p>';
  const { total, offset, limit } = result;
  const prev = offset > 0 ? `<a href="${base}${qs({ ...params, offset: Math.max(0, offset - limit) })}">← Previous</a>` : "";
  const next = offset + limit < total ? `<a href="${base}${qs({ ...params, offset: offset + limit })}">Next →</a>` : "";
  return `<ol class="quotes">${result.quotes.map(quoteItem).join("")}</ol>
<div class="pager">${prev}${next}<span class="note">${offset + 1}–${Math.min(total, offset + limit)} of ${records(p, total)}</span></div>`;
}

function searchForm(query: string, collection: string | null): string {
  return `<form class="search" method="get" action="/search" role="search"><input type="search" name="q" value="${esc(query)}" placeholder="Words or &quot;a phrase&quot;" aria-label="Search the quotes">
${collection ? `<input type="hidden" name="collection" value="${esc(collection)}">` : ""}<button>Search</button></form>`;
}

function searchPage(p: Published, params: URLSearchParams): string {
  const query = (params.get("q") ?? "").trim();
  const c = chosen(p, params);
  let body = "";
  if (query) {
    try {
      const result = p.quotes({ query, conceptIds: c?.conceptIds, limit: PAGE, offset: offsetOf(params) });
      body = quoteList(p, result, "/search", { q: query, collection: c?.scheme });
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      body = `<p class="note">${esc(error.message)}</p>`;
    }
  }
  return page(p, query ? `“${query}”` : "Search", "search", `<h1>Search</h1>
<p class="sub">Words are looked for in what the quotes say; "a phrase" is kept together, and a trailing * matches the start of a word${within(p, c)}.</p>
${searchForm(query, c?.scheme ?? null)}${body}`);
}

function quotePage(p: Published, id: number): string {
  const r = p.get(id);
  const c = p.citation(id);
  const name = r.kind === "note" ? "A note" : "A quote";
  const title = r.work ? `${name} from ${r.work.title}` : name;
  return page(p, title, "works", `<div class="quote-page"><h1>${esc(title)}</h1>
${words(r)}${source(r)}${conceptChips(r)}
${r.comment ? `<h2>Comment</h2><p>${esc(r.comment)}</p>` : ""}
<h2>Cite this</h2><div class="cite">
${c.pandoc ? `<p>Pandoc: <code>${esc(c.pandoc)}</code></p>` : ""}
${c.bibtex ? `<details${c.pandoc ? "" : " open"}><summary>BibTeX</summary><pre>${esc(c.bibtex)}</pre></details>` : ""}
${c.csl ? `<details><summary>CSL JSON</summary><pre>${esc(JSON.stringify(c.csl, null, 2))}</pre></details>` : '<p class="note">There\'s no work recorded to cite.</p>'}
${r.work && !r.work.citekey ? '<p class="note">This work isn\'t filed in Zotero with a citekey yet, so there\'s no Pandoc citation; the BibTeX and CSL come from its old catalogue record.</p>' : ""}
</div></div>`);
}

// --- The catalogue -------------------------------------------------------------------------------

/** A collection's maps and starting points (concept sets), or every collection's. */
function waysIn(p: Published, scheme: string | null): string {
  const maps = p.maps().filter((m) => !scheme || m.scheme === scheme);
  const sets = p.sets().filter((s) => s.concepts > 0 && (!scheme || s.scheme === scheme));
  return `${maps.length ? `<h2>Maps</h2><div class="grid">${maps.map((m) => card(`/map/${m.name}/`, m.title, m.description)).join("")}</div>` : ""}
${sets.length ? `<h2>Starting points</h2><div class="grid">${sets.map((s) => card(`/sets/${s.slug}`, s.label, s.description)).join("")}</div>` : ""}`;
}

function browse(n: { works: number; concepts: number }, scheme: string | null): string {
  const q = scheme ? `?collection=${encodeURIComponent(scheme)}` : "";
  return `<h2>Browse</h2><div class="grid">${card(`/concepts${q}`, "Concepts", `${plural(n.concepts, "concept")}, A to Z`)}${card(`/works${q}`, "Works", `${plural(n.works, "work")}, by author`)}</div>`;
}

function stats(p: Published, n: { quotes: number; works: number; concepts: number }): string {
  return `<p class="stats">${records(p, n.quotes)} from ${plural(n.works, "work")}, tagged with ${plural(n.concepts, "concept")}.</p>`;
}

function frontPage(p: Published): string {
  const n = p.totals();
  const all = p.collections();
  const site = p.site;
  const head = `<h1>${esc(site.title)}</h1>\n<div class="intro">${site.html}</div>\n${stats(p, n)}${p.quoting ? searchForm("", null) : ""}`;
  const recent = p.quoting ? `<h2>Recently added</h2><ol class="quotes">${p.quotes({ newest: true, limit: 5 }).quotes.map(quoteItem).join("")}</ol>` : "";
  if (all.length <= 1) {
    // One collection: shown inline, under its own heading when it has an introduction of its own.
    const c = all[0];
    const own = c && p.hasIntro(c.scheme) ? `<h2>${esc(c.intro.title)}</h2><div class="intro">${c.intro.html}</div>` : "";
    return page(p, null, "home", `${head}${own}${waysIn(p, null)}${browse(n, null)}${recent}`);
  }
  const loose = p.untagged();
  return page(p, null, "home", `${head}
<h2>Collections</h2><div class="grid">${all.map((c) => `<a class="card" href="/collections/${encodeURIComponent(c.scheme)}"><h3>${esc(c.intro.title)}</h3>
${c.intro.summary ? `<p>${esc(c.intro.summary)}</p>` : ""}<p class="count">${records(p, c.quotes)} · ${plural(c.works, "work")} · ${plural(c.concepts, "concept")}</p></a>`).join("")}</div>
${loose ? `<p class="note">${records(p, loose)} not yet tagged with a concept, so in no collection; they're under Works.</p>` : ""}
${waysIn(p, null)}${browse(n, null)}${recent}`);
}

function findCollection(p: Published, scheme: string): Collection {
  const c = p.collections().find((x) => x.scheme === scheme);
  if (!c) throw new ToolError(`No collection "${scheme}".`);
  return c;
}

function collectionPage(p: Published, scheme: string): string {
  const c = findCollection(p, scheme);
  return page(p, c.intro.title, "home", `<h1>${esc(c.intro.title)}</h1>
<div class="intro">${c.intro.html}</div>${stats(p, c)}${p.quoting ? searchForm("", c.scheme) : ""}${waysIn(p, c.scheme)}${browse(c, c.scheme)}`);
}

/** The collection a ?collection= asks for, or null for all; a ToolError for one that isn't there. */
function chosen(p: Published, params: URLSearchParams): Collection | null {
  const scheme = params.get("collection");
  return scheme ? findCollection(p, scheme) : null;
}

/** "in <collection>", linked, when there's more than one collection to tell apart. */
function within(p: Published, c: Collection | null): string {
  return c && p.collections().length > 1 ? ` in <a href="/collections/${encodeURIComponent(c.scheme)}">${esc(c.intro.title)}</a> · <a href="?">all collections</a>` : "";
}

function conceptsPage(p: Published, params: URLSearchParams): string {
  const c = chosen(p, params);
  const list = p.concepts(c?.scheme ?? null);
  const groups = new Map<string, typeof list>();
  for (const x of list) {
    const letter = /^[a-z]/i.test(x.label) ? x.label[0].toUpperCase() : "#";
    (groups.get(letter) ?? groups.set(letter, []).get(letter)!).push(x);
  }
  return page(p, "Concepts", "concepts", `<h1>Concepts</h1><p class="sub">${plural(list.length, "concept")}${within(p, c)}. A concept's count includes only what's tagged with it, not its narrower concepts.</p>
<nav class="letters">${[...groups.keys()].map((l) => `<a href="#${l === "#" ? "other" : l}">${l}</a>`).join("")}</nav>
<div class="az">${[...groups].map(([l, cs]) => `<h2 id="${l === "#" ? "other" : l}">${l}</h2><ul>${cs.map((x) => `<li><a href="${conceptHref(x.slug)}">${esc(x.label)}</a> <span class="count">${x.quotes}</span></li>`).join("")}</ul>`).join("")}</div>`);
}

function conceptPage(p: Published, slug: string, params: URLSearchParams): string {
  const c = p.concept(slug);
  const ids = p.withNarrower(c.id);
  const quoted = p.works(ids);
  const worksList = quoted.length ? `<ul class="plain-list works">${quoted.map((w) => workItem(p, w)).join("")}</ul>` : '<p class="note">None yet.</p>';
  const listed = p.quoting
    ? `<h2>Quotes</h2>${quoteList(p, p.quotes({ conceptIds: ids, limit: PAGE, offset: offsetOf(params) }), conceptHref(c.slug), {})}
<details><summary>Works quoted (${quoted.length})</summary>${worksList}</details>`
    : `<h2>Works quoted</h2>${worksList}`;
  const relations = Object.entries(c.relations).map(([type, list]) =>
    `<tr><th>${esc(type)}</th><td>${list.map((r) => `<a class="chip" href="${conceptHref(r.slug)}">${esc(r.label)}</a>`).join("")}</td></tr>`).join("");
  const inSets = p.setsOf(c.id);
  const maps = p.maps().filter((m) => m.scheme === c.scheme && !m.set);
  const all = p.collections();
  const home = all.length > 1 ? all.find((x) => x.scheme === c.scheme) : undefined;
  return page(p, c.label, "concepts", `<h1>${esc(c.label)}</h1>
<p class="sub">${home ? `<a href="/collections/${encodeURIComponent(home.scheme)}">${esc(home.intro.title)}</a> · ` : ""}${records(p, c.quotes_with_narrower)}${ids.length > 1 ? ", with its narrower concepts" : ""}${maps.map((m) => ` · <a href="/map/${m.name}/#/concept/${encodeURIComponent(c.slug)}">on the map</a>`).join("")}</p>
${c.definition ? `<p>${esc(c.definition)}</p>` : ""}
${c.alt_labels.length || relations ? `<div class="scroll"><table>${c.alt_labels.length ? `<tr><th>Also</th><td>${c.alt_labels.map(esc).join(", ")}</td></tr>` : ""}${relations}</table></div>` : ""}
${inSets.length ? `<p class="meta">In ${inSets.map((s) => `<a href="/sets/${s.slug}">${esc(s.label)}</a>`).join(", ")}</p>` : ""}
${listed}`);
}

function setPage(p: Published, slug: string, params: URLSearchParams): string {
  const set = p.set(slug);
  const n = p.conceptCounts();
  const ids = p.setConceptIds(set.slug);
  const byslug = new Map(p.concepts(set.scheme).map((c) => [c.slug, c.id]));
  const maps = p.maps().filter((m) => m.set === set.slug);
  return page(p, set.label, "concepts", `<h1>${esc(set.label)}</h1>
${set.description ? `<p class="intro">${esc(set.description)}</p>` : ""}
<p class="sub">${plural(set.concepts.length, "concept")}${maps.map((m) => ` · <a href="/map/${m.name}/">${esc(m.title)}</a>`).join("")}</p>
<ul class="plain-list">${set.concepts.map((c) => `<li><a href="${conceptHref(c.slug)}">${esc(c.label)}</a> <span class="count">${n.get(byslug.get(c.slug) ?? -1) ?? 0}</span></li>`).join("")}</ul>
${p.quoting && ids.length ? `<h2>Quotes</h2>${quoteList(p, p.quotes({ conceptIds: ids, limit: PAGE, offset: offsetOf(params) }), `/sets/${set.slug}`, {})}` : ""}`);
}

function worksPage(p: Published, params: URLSearchParams): string {
  const c = chosen(p, params);
  const list = p.works(c?.conceptIds);
  return page(p, "Works", "works", `<h1>Works</h1><p class="sub">${plural(list.length, "work")} quoted${within(p, c)}, by first author.</p>
<ul class="plain-list works" style="columns:auto">${list.map((w) => workItem(p, w)).join("")}</ul>`);
}

function workPage(p: Published, id: number, params: URLSearchParams): string {
  const w = p.work(id);
  return page(p, w.title, "works", `<h1><cite>${esc(w.title)}</cite></h1>
<p class="sub">${w.authors.length ? `${esc(authorsOf(w.authors))} · ` : ""}${w.year ? `${esc(w.year)} · ` : ""}${records(p, w.quotes)}</p>
<h2>Concepts</h2>${w.concepts.length ? `<p>${w.concepts.map((c) => `<a class="chip" href="${conceptHref(c.slug)}">${esc(c.label)} <span class="count">${c.quotes}</span></a>`).join("")}</p>` : '<p class="note">None tagged.</p>'}
${p.quoting ? `<h2>Quotes</h2>${quoteList(p, p.quotes({ work: id, limit: 50, offset: offsetOf(params) }), `/works/${id}`, {})}${w.citekey ? `<p class="meta">Cite as <code>[@${esc(w.citekey)}]</code>, with the page.</p>` : ""}` : ""}`);
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
export function renderSite(p: Published, pathname: string, params = new URLSearchParams()): string | null {
  if (pathname === "/") return frontPage(p);
  if (pathname === "/concepts" || pathname === "/concepts/") return conceptsPage(p, params);
  if (pathname === "/works" || pathname === "/works/") return worksPage(p, params);
  let m = /^\/collections\/([^/]+)$/.exec(pathname);
  if (m) return collectionPage(p, decoded(m[1]));
  m = /^\/concepts\/([^/]+)$/.exec(pathname);
  if (m) return conceptPage(p, decoded(m[1]), params);
  m = /^\/sets\/([^/]+)$/.exec(pathname);
  if (m) return setPage(p, decoded(m[1]), params);
  m = /^\/works\/(\d+)$/.exec(pathname);
  if (m) return workPage(p, Number(m[1]), params);
  if (!p.quoting) return null;
  if (pathname === "/search") return searchPage(p, params);
  m = /^\/quotes\/(\d+)$/.exec(pathname);
  if (m) return quotePage(p, Number(m[1]));
  return null;
}
