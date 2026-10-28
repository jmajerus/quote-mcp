import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import { ToolError, getConcept, withNarrower } from "./queries.js";
import { type ConceptSet, listSets, setGraph } from "./sets.js";
import { CSS, esc } from "./web.js";

/**
 * The public site: a front page at / and pages for concepts, sets, and works, off unless QUOTE_PUBLIC is
 * set. It has its own queries, which return only what a level makes public, rather than the admin pages
 * with parts hidden, so a field added there can't leak here.
 *
 *   catalogue   concepts, sets, maps, works by title and author, and counts; no quoted text
 *   quotes      the catalogue and quote text with citations (and notes, with QUOTE_PUBLIC_NOTES=all,
 *               except those tagged private)
 *
 * Unparsed quotes, flags, OCR suspects, worklists, and history are never public.
 */

export type Level = "none" | "catalogue" | "quotes";
export const LEVELS: readonly Level[] = ["none", "catalogue", "quotes"];

export interface SiteOptions {
  level: Level;
  /** Notes beside quotes on public pages (QUOTE_PUBLIC_NOTES=all); only at the quotes level. */
  notes: boolean;
  /** The front page's title and introduction, from vocab/site.md. */
  intro: Intro;
  mapDir?: string;
  sets: ConceptSet[];
}

export interface Intro { title: string; html: string }

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
  return { title: title ?? "Quotes", html };
}

/** The introduction from a file, or a plain title when there isn't one. */
export function loadIntro(file: string): Intro {
  return fs.existsSync(file) ? readIntro(fs.readFileSync(file, "utf8")) : { title: "Quotes", html: "" };
}

// --- Public queries ------------------------------------------------------------------------------

/** The records a level makes public, as a condition on quotes q. */
function visible(site: SiteOptions): string {
  const notes = site.level === "quotes" && site.notes
    ? " OR (q.kind = 'note' AND NOT EXISTS (SELECT 1 FROM quote_tags p WHERE p.quote_id = q.id AND p.tag = 'private' COLLATE NOCASE))" : "";
  return `(q.status != 'unparsed' AND (q.kind = 'quote'${notes}))`;
}

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

function publicConcepts(db: DB, site: SiteOptions) {
  const n = conceptCounts(db, site);
  return (db.prepare(`SELECT c.id, s.slug AS scheme, c.slug, c.label, c.definition FROM concepts c JOIN schemes s ON s.id = c.scheme_id
    WHERE c.status != 'retired' ORDER BY lower(c.label)`).all() as { id: number; scheme: string; slug: string; label: string; definition: string | null }[])
    .map((c) => ({ ...c, quotes: n.get(c.id) ?? 0 }));
}

/** Works with public records, by first author, or those quoted under some concepts. */
function publicWorks(db: DB, site: SiteOptions, conceptIds?: number[]): PublicWork[] {
  const within = conceptIds ? `AND q.id IN (SELECT quote_id FROM quote_tags WHERE concept_id IN (${conceptIds.join(",")}))` : "";
  return works(db.prepare(`SELECT w.id, w.title, w.authors, w.year, COUNT(*) AS quotes FROM quotes q JOIN works w ON w.id = q.work_id
    WHERE ${visible(site)} ${within} GROUP BY w.id ORDER BY lower(json_extract(w.authors, '$[0]')) NULLS LAST, lower(w.title)`).all() as never);
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

type Section = "home" | "concepts" | "works" | "maps";

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
`;

function page(site: SiteOptions, title: string | null, section: Section, body: string): string {
  const nav: [Section, string, string][] = [["home", "Home", "/"], ["concepts", "Concepts", "/concepts"], ["works", "Works", "/works"]];
  if (site.mapDir) nav.push(["maps", "Maps", "/map/"]);
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

function frontPage(db: DB, site: SiteOptions): string {
  const n = counts(db, site);
  const maps = readMaps(site);
  const sets = listSets(db, site.sets).filter((s) => s.concepts > 0);
  return page(site, null, "home", `<h1>${esc(site.intro.title)}</h1>
<div class="intro">${site.intro.html}</div>
<p class="stats">${records(site, n.quotes)} from ${plural(n.works, "work")}, tagged with ${plural(n.concepts, "concept")}.</p>
${maps.length ? `<h2>Maps</h2><div class="grid">${maps.map((m) => card(`/map/${m.name}/`, m.title ?? m.name, m.description)).join("")}</div>` : ""}
${sets.length ? `<h2>Starting points</h2><div class="grid">${sets.map((s) => card(`/sets/${s.slug}`, s.label, s.description)).join("")}</div>` : ""}
<h2>Browse</h2><div class="grid">${card("/concepts", "Concepts", `${plural(n.concepts, "concept")}, A to Z`)}${card("/works", "Works", `${plural(n.works, "work")}, by author`)}</div>`);
}

function conceptsPage(db: DB, site: SiteOptions): string {
  const list = publicConcepts(db, site);
  const groups = new Map<string, typeof list>();
  for (const c of list) {
    const letter = /^[a-z]/i.test(c.label) ? c.label[0].toUpperCase() : "#";
    (groups.get(letter) ?? groups.set(letter, []).get(letter)!).push(c);
  }
  return page(site, "Concepts", "concepts", `<h1>Concepts</h1><p class="sub">${plural(list.length, "concept")}. A concept's count includes only what's tagged with it, not its narrower concepts.</p>
<nav class="letters">${[...groups.keys()].map((l) => `<a href="#${l === "#" ? "other" : l}">${l}</a>`).join("")}</nav>
<div class="az">${[...groups].map(([l, cs]) => `<h2 id="${l === "#" ? "other" : l}">${l}</h2><ul>${cs.map((c) => `<li><a href="${conceptHref(c.slug)}">${esc(c.label)}</a> <span class="count">${c.quotes}</span></li>`).join("")}</ul>`).join("")}</div>`);
}

function conceptPage(db: DB, site: SiteOptions, slug: string): string {
  const c = getConcept(db, slug);
  const ids = withNarrower(db, c.id);
  const quoted = publicWorks(db, site, ids);
  const total = (db.prepare(`SELECT COUNT(DISTINCT q.id) FROM quotes q JOIN quote_tags t ON t.quote_id = q.id WHERE t.concept_id IN (${ids.join(",")}) AND ${visible(site)}`).pluck().get() as number);
  const relations = Object.entries(c.relations).map(([type, list]) =>
    `<tr><th>${esc(type)}</th><td>${list.map((r) => `<a class="chip" href="${conceptHref(r.slug)}">${esc(r.label)}</a>`).join("")}</td></tr>`).join("");
  const inSets = listSets(db, site.sets).filter((s) => s.scheme === c.scheme && setGraph(db, site.sets, s.slug).concepts.some((m) => m.slug === c.slug));
  const maps = readMaps(site).filter((m) => (m.scheme ?? m.name) === c.scheme && !m.set);
  return page(site, c.label, "concepts", `<h1>${esc(c.label)}</h1>
<p class="sub">${records(site, total)}${ids.length > 1 ? ", with its narrower concepts" : ""}${maps.map((m) => ` · <a href="/map/${m.name}/#/concept/${encodeURIComponent(c.slug)}">on the map</a>`).join("")}</p>
${c.definition ? `<p>${esc(c.definition)}</p>` : ""}
${c.alt_labels.length || relations ? `<div class="scroll"><table>${c.alt_labels.length ? `<tr><th>Also</th><td>${c.alt_labels.map(esc).join(", ")}</td></tr>` : ""}${relations}</table></div>` : ""}
${inSets.length ? `<p class="meta">In ${inSets.map((s) => `<a href="/sets/${s.slug}">${esc(s.label)}</a>`).join(", ")}</p>` : ""}
<h2>Works quoted</h2>${quoted.length ? `<ul class="plain-list works">${quoted.map((w) => workItem(w, site)).join("")}</ul>` : '<p class="note">None yet.</p>'}`);
}

function setPage(db: DB, site: SiteOptions, slug: string): string {
  const set = setGraph(db, site.sets, slug);
  const n = conceptCounts(db, site);
  const ids = new Map((db.prepare("SELECT c.slug, c.id FROM concepts c JOIN schemes s ON s.id = c.scheme_id WHERE s.slug = ?").all(set.scheme) as { slug: string; id: number }[]).map((r) => [r.slug, r.id]));
  const maps = readMaps(site).filter((m) => m.set === set.slug);
  return page(site, set.label, "concepts", `<h1>${esc(set.label)}</h1>
${set.description ? `<p class="intro">${esc(set.description)}</p>` : ""}
<p class="sub">${plural(set.concepts.length, "concept")}${maps.map((m) => ` · <a href="/map/${m.name}/">${esc(m.title ?? m.name)}</a>`).join("")}</p>
<ul class="plain-list">${set.concepts.map((c) => `<li><a href="${conceptHref(c.slug)}">${esc(c.label)}</a> <span class="count">${n.get(ids.get(c.slug) ?? -1) ?? 0}</span></li>`).join("")}</ul>`);
}

function worksPage(db: DB, site: SiteOptions): string {
  const list = publicWorks(db, site);
  return page(site, "Works", "works", `<h1>Works</h1><p class="sub">${plural(list.length, "work")} quoted, by first author.</p>
<ul class="plain-list works" style="columns:auto">${list.map((w) => workItem(w, site)).join("")}</ul>`);
}

function workPage(db: DB, site: SiteOptions, id: number): string {
  const w = publicWork(db, site, id);
  return page(site, w.title, "works", `<h1><cite>${esc(w.title)}</cite></h1>
<p class="sub">${w.authors.length ? `${esc(authorsOf(w.authors))} · ` : ""}${w.year ? `${esc(w.year)} · ` : ""}${records(site, w.quotes)}</p>
<h2>Concepts</h2>${w.concepts.length ? `<p>${w.concepts.map((c) => `<a class="chip" href="${conceptHref(c.slug)}">${esc(c.label)} <span class="count">${c.quotes}</span></a>`).join("")}</p>` : '<p class="note">None tagged.</p>'}`);
}

/** The paths the public site answers, so the server can route them. */
export function isSitePath(pathname: string): boolean {
  return pathname === "/" || /^\/(concepts|works|sets)(\/|$)/.test(pathname);
}

function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new ToolError("Not found.");
  }
}

/** The HTML for a public path, or null when there's no such page; a ToolError for a concept, set, or work that isn't there. */
export function renderSite(db: DB, site: SiteOptions, pathname: string): string | null {
  if (site.level === "none") return null;
  if (pathname === "/") return frontPage(db, site);
  if (pathname === "/concepts" || pathname === "/concepts/") return conceptsPage(db, site);
  if (pathname === "/works" || pathname === "/works/") return worksPage(db, site);
  let m = /^\/concepts\/([^/]+)$/.exec(pathname);
  if (m) return conceptPage(db, site, decoded(m[1]));
  m = /^\/sets\/([^/]+)$/.exec(pathname);
  if (m) return setPage(db, site, decoded(m[1]));
  m = /^\/works\/(\d+)$/.exec(pathname);
  if (m) return workPage(db, site, Number(m[1]));
  return null;
}
