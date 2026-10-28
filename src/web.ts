import type { DB } from "./db.js";
import {
  QUEUES, type Queue, ToolError, type WorkSummary, citeQuote, getConcept, getQuote, listConcepts, overview, searchQuotes, worklist,
} from "./queries.js";

/**
 * The admin pages, rendered on the server: an overview, search over quotes and notes, a record's page, the concept
 * scheme, and the worklists. Read-only in phase 1; editing arrives with phase 2 behind Cloudflare Access.
 */

type Section = "overview" | "quotes" | "concepts" | "worklists";

export const CSS = `
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --border: #dedcd6;
  --accent: #2f5d8a; --chip: #eef2f7; --chip-text: #23405e; --warn: #a15c07; --warn-bg: #fdf1e0; --ok: #2e7d4f; --quote: #f2f0ea;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --border: #3a3935;
    --accent: #7fb0e0; --chip: #233142; --chip-text: #cfe0f2; --warn: #e0a85a; --warn-bg: #3a2c18; --ok: #6cc290; --quote: #262522;
  }
}
:root[data-theme="dark"] {
  --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a3a29b; --border: #3a3935;
  --accent: #7fb0e0; --chip: #233142; --chip-text: #cfe0f2; --warn: #e0a85a; --warn-bg: #3a2c18; --ok: #6cc290; --quote: #262522;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); }
.topbar { background: var(--surface); border-bottom: 1px solid var(--border); }
.topbar-inner { max-width: 1100px; margin: 0 auto; padding: 10px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; }
.brand { font-weight: 700; }
.nav { display: flex; flex-wrap: wrap; gap: 2px; }
.nav a { color: var(--text); text-decoration: none; padding: 4px 10px; border-radius: 6px; font-size: 0.92rem; }
.nav a[aria-current="page"] { background: var(--chip); color: var(--chip-text); font-weight: 600; }
main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 64px; }
h1 { font-size: 1.35rem; margin: 0 0 4px; }
h2 { font-size: 1.02rem; margin: 28px 0 10px; }
.sub, .note { color: var(--muted); font-size: 0.9rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
.card .n { font-size: 1.6rem; font-weight: 650; }
.card .k { color: var(--muted); font-size: 0.85rem; }
form.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 18px; }
form.filters input, form.filters select { font: inherit; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); min-width: 0; }
form.filters input[name="q"] { flex: 1 1 260px; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--surface); cursor: pointer; }
.result { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
.result .text { margin: 0 0 6px; }
.meta { color: var(--muted); font-size: 0.87rem; }
blockquote { margin: 0 0 10px; padding: 12px 16px; background: var(--quote); border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; white-space: pre-wrap; }
.chip { display: inline-block; background: var(--chip); color: var(--chip-text); border-radius: 999px; padding: 1px 9px; font-size: 0.82rem; margin: 2px 4px 2px 0; text-decoration: none; }
.kind { display: inline-block; border: 1px solid var(--border); color: var(--muted); border-radius: 4px; padding: 0 6px; font-size: 0.78rem; margin-right: 4px; }
.words { margin: 0 0 10px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; white-space: pre-wrap; }
.chip.plain { background: transparent; border: 1px dashed var(--border); color: var(--muted); }
.flag { display: inline-block; background: var(--warn-bg); color: var(--warn); border-radius: 4px; padding: 0 6px; font-size: 0.78rem; margin-right: 4px; }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; font-size: 0.92rem; }
th { color: var(--muted); font-weight: 600; font-size: 0.82rem; }
.scroll { overflow-x: auto; }
pre { background: var(--quote); padding: 10px; border-radius: 8px; overflow-x: auto; font-size: 0.82rem; }
mark { background: var(--warn-bg); color: inherit; }
.pager { display: flex; gap: 12px; margin-top: 14px; }
`;

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

function page(title: string, section: Section, body: string): string {
  const nav: [Section, string, string][] = [["overview", "Overview", "/admin"], ["quotes", "Quotes", "/admin/quotes"], ["concepts", "Concepts", "/admin/concepts"], ["worklists", "Worklists", "/admin/worklists"]];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Quotes</title><style>${CSS}</style></head><body>
<header class="topbar"><div class="topbar-inner"><span class="brand">Quote MCP</span><nav class="nav">
${nav.map(([k, label, href]) => `<a href="${href}"${k === section ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
</nav></div></header><main>${body}</main></body></html>`;
}

function zoteroLink(library: string | null, key: string | null): string {
  if (!library || !key) return "";
  const lib = library.startsWith("groups/") ? `groups/${library.split("/")[1]}` : "library";
  return `zotero://select/${lib}/items/${key}`;
}

function workLine(w: WorkSummary | null, attribution: string | null): string {
  if (!w) return attribution ? esc(attribution) : '<span class="note">no work</span>';
  const who = w.authors.slice(0, 2).join("; ") + (w.authors.length > 2 ? " et al." : "");
  const link = zoteroLink(w.zotero_library, w.zotero_key);
  const status = w.match === "zotero" ? (link ? ` <a href="${link}" title="Open in Zotero">Zotero</a>` : "") : ` <span class="flag">${w.match === "ambiguous" ? "edition?" : "not in Zotero"}</span>`;
  return `${who ? `${esc(who)}, ` : ""}<a href="/admin/quotes${qs({ work: w.zotero_key ?? w.title })}"><cite>${esc(w.title)}</cite></a>${w.year ? ` (${esc(w.year)})` : ""}${status}`;
}

function tagChips(tags: { tag: string; concept: string | null }[]): string {
  return tags.map((t) => (t.concept
    ? `<a class="chip" href="/admin/concepts/${encodeURIComponent(t.concept)}">${esc(t.tag)}</a>`
    : `<a class="chip plain" href="/admin/quotes${qs({ tag: t.tag })}" title="Not a concept">${esc(t.tag)}</a>`)).join("");
}

type Listed = ReturnType<typeof searchQuotes>["quotes"][number];

function quoteCard(q: Listed): string {
  const words = q.kind === "note" ? q.note ?? "" : q.text;
  const text = q.snippet ? esc(q.snippet).replace(/«/g, "<mark>").replace(/»/g, "</mark>") : esc(words.length > 420 ? `${words.slice(0, 420)}…` : words);
  return `<div class="result"><p class="text"><a href="/admin/quotes/${q.id}">#${q.id}</a> ${q.kind === "note" ? '<span class="kind">note</span>' : ""}${text}</p>
<div class="meta">${workLine(q.work, q.attribution)}${q.locator ? ` · ${esc(q.locator)}` : ""}${q.chapter_author ? ` · by ${esc(q.chapter_author)}` : ""}</div>
<div>${tagChips(q.tags)}${q.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join("")}</div></div>`;
}

function pager(base: string, params: Record<string, unknown>, total: number, offset: number, limit: number): string {
  const prev = offset > 0 ? `<a href="${base}${qs({ ...params, offset: Math.max(0, offset - limit) })}">← Previous</a>` : "";
  const next = offset + limit < total ? `<a href="${base}${qs({ ...params, offset: offset + limit })}">Next →</a>` : "";
  return `<div class="pager">${prev}${next}<span class="note">${total ? `${offset + 1}–${Math.min(total, offset + limit)} of ${total}` : "None"}</span></div>`;
}

const QUEUE_LABEL: Record<Queue, string> = {
  unparsed: "Unparsed quotes to split", ambiguous_works: "Works with several Zotero editions", unmatched_works: "Works not in Zotero yet",
  unresolved_tags: "Tags that aren't concepts", no_locator: "No page or location", ocr_suspect: "Possible OCR errors", unbalanced_quotes: "Unbalanced quotation marks",
  commentary_mixed: "Commentary mixed in", chapter_author: "Chapter authors to check", kindle_locator: "Kindle locations", title_tag_only: "Concepts only in the title attribute",
  compound_tag: "Compound tags",
};

function overviewPage(db: DB): string {
  const o = overview(db);
  const cards = [["Quotes", o.quotes, "/admin/quotes?kind=quote"], ["Notes", o.notes, "/admin/quotes?kind=note"], ["Works", o.works, "/admin/quotes"], ["Concepts", o.concepts, "/admin/concepts"]]
    .map(([k, n, href]) => `<a class="card" href="${href}" style="text-decoration:none;color:inherit"><div class="n">${n}</div><div class="k">${k}</div></a>`).join("");
  return page("Overview", "overview", `<h1>Quotes</h1><p class="sub">Last import ${esc(String(o.last_import ?? "never").slice(0, 16).replace("T", " "))} UTC · schemes: ${o.schemes.map((s) => esc((s as { label: string }).label)).join(", ")}</p>
<div class="grid">${cards}</div>${worklistTable(o.queues)}`);
}

function worklistTable(queues: Record<string, number>): string {
  return `<h2>Worklists</h2><div class="scroll"><table><tr><th>What needs a person</th><th>Count</th></tr>
${QUEUES.map((q) => `<tr><td><a href="/admin/worklists/${q}">${QUEUE_LABEL[q]}</a></td><td>${queues[q] ?? 0}</td></tr>`).join("")}</table></div>`;
}

function quotesPage(db: DB, p: URLSearchParams): string {
  const params = {
    q: p.get("q") ?? "", concept: p.get("concept") ?? "", tag: p.get("tag") ?? "", author: p.get("author") ?? "", work: p.get("work") ?? "",
    status: p.get("status") ?? "", kind: p.get("kind") ?? "", offset: Number(p.get("offset") ?? 0),
  };
  let body: string;
  try {
    const r = searchQuotes(db, {
      query: params.q || undefined, concept: params.concept || undefined, tag: params.tag || undefined, author: params.author || undefined,
      work: params.work || undefined, status: (params.status || undefined) as never, kind: (params.kind || undefined) as never, offset: params.offset, limit: 25,
    });
    body = r.quotes.map(quoteCard).join("") + pager("/admin/quotes", { ...params, offset: undefined }, r.total, r.offset, r.limit);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    body = `<p class="flag">${esc(error.message)}</p>`;
  }
  const input = (name: keyof typeof params, label: string) => `<input name="${name}" placeholder="${label}" value="${esc(params[name])}" aria-label="${label}">`;
  return page("Quotes", "quotes", `<h1>Quotes</h1>
<form class="filters" method="get">${input("q", "Words or \"a phrase\"")}${input("concept", "Concept")}${input("author", "Author")}${input("work", "Work")}
<select name="status" aria-label="Status"><option value="">Ready to use</option>${["transcribed", "unparsed", "any"].map((s) => `<option${params.status === s ? " selected" : ""}>${s}</option>`).join("")}</select>
<select name="kind" aria-label="Kind"><option value="">Quotes and notes</option>${[["quote", "Quotes"], ["note", "Notes"]].map(([v, label]) => `<option value="${v}"${params.kind === v ? " selected" : ""}>${label}</option>`).join("")}</select>
${params.tag ? `<input type="hidden" name="tag" value="${esc(params.tag)}">` : ""}<button>Search</button></form>
${params.tag ? `<p class="note">Tag: ${esc(params.tag)} · <a href="/admin/quotes">clear</a></p>` : ""}${body}`);
}

function quotePage(db: DB, id: number): string {
  const q = getQuote(db, id);
  const c = citeQuote(db, id);
  const rows = (pairs: [string, string][]) => pairs.filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
  const note = q.kind === "note";
  const name = `${note ? "Note" : "Quote"} ${id}`;
  return page(name, "quotes", `<h1>${name}</h1><p class="sub">${note ? "your own words, no quoted text" : `${esc(q.status)} · grade ${esc(q.grade)}`}${q.edited ? " · edited" : ""}</p>
${note ? (q.note ? `<div class="words">${esc(q.note)}</div>` : '<p class="note">Tags only.</p>') : `<blockquote>${esc(q.text)}</blockquote>`}
<div class="meta">${workLine(q.work, q.attribution)}${q.locator ? ` · ${esc(q.locator)}` : ""}</div>
<p>${tagChips(q.tags)}${q.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join("")}</p>
<h2>Details</h2><div class="scroll"><table>${rows([
    ["Chapter author", esc(q.chapter_author)],
    ["Comment", note ? "" : esc(q.comment)],
    ["Source URL", q.source_url ? `<a href="${esc(q.source_url)}">${esc(q.source_url)}</a>` : ""],
    ["Key words", (q.kwic as { phrase: string; tag: string }[]).map((k) => `“${esc(k.phrase)}” → ${esc(k.tag)}`).join("<br>")],
    ["Suspect words", (q.suspect_words as { token: string; reason: string; suggestion?: string }[]).map((s) => `${esc(s.token)}${s.suggestion ? ` → ${esc(s.suggestion)}` : ` (${esc(s.reason)})`}`).join(", ")],
    ["Came from", (q.origins as { kind: string; ref: string }[]).map((o) => `${esc(o.kind)} ${esc(o.ref)}`).join("<br>")],
  ])}</table></div>
<h2>Citation</h2>${c.pandoc ? `<p><code>${esc(c.pandoc)}</code></p>` : ""}${c.warnings.map((w) => `<p class="note">${esc(w)}</p>`).join("")}
<details><summary>CSL JSON</summary><pre>${esc(JSON.stringify(c.csl, null, 2))}</pre></details>
<h2>History</h2><div class="scroll"><table><tr><th>When</th><th>What</th><th>Why</th></tr>
${(q.history as { at: string; kind: string; reason: string }[]).map((h) => `<tr><td>${esc(h.at.slice(0, 16).replace("T", " "))}</td><td>${esc(h.kind)}</td><td>${esc(h.reason)}</td></tr>`).join("")}</table></div>`);
}

function conceptsPage(db: DB, p: URLSearchParams): string {
  const query = p.get("q") ?? "";
  const list = listConcepts(db, { query: query || undefined });
  return page("Concepts", "concepts", `<h1>Concepts</h1><p class="sub">The human side of work (<code>human-work</code>): ${list.length} concepts${query ? ` matching “${esc(query)}”` : ""}.</p>
<form class="filters" method="get"><input name="q" placeholder="Find a concept" value="${esc(query)}" aria-label="Find a concept"><button>Find</button></form>
<div class="scroll"><table><tr><th>Concept</th><th>Quotes</th><th>Definition</th></tr>
${list.map((c) => `<tr><td><a href="/admin/concepts/${encodeURIComponent(c.slug)}">${esc(c.label)}</a></td><td>${c.quotes}</td><td class="note">${esc(c.definition)}</td></tr>`).join("")}</table></div>`);
}

function conceptPage(db: DB, slug: string, p: URLSearchParams): string {
  const c = getConcept(db, slug);
  const offset = Number(p.get("offset") ?? 0);
  const quotes = searchQuotes(db, { concept: c.slug, limit: 25, offset });
  const relations = Object.entries(c.relations).map(([type, list]) => `<tr><th>${esc(type)}</th><td>${list.map((r) => `<a class="chip" href="/admin/concepts/${encodeURIComponent(r.slug)}">${esc(r.label)}</a>`).join("")}</td></tr>`).join("");
  return page(c.label, "concepts", `<h1>${esc(c.label)}</h1><p class="sub"><code>${esc(c.scheme)}:${esc(c.slug)}</code> · ${c.quotes} quotes, ${c.quotes_with_narrower} with narrower concepts</p>
${c.definition ? `<p>${esc(c.definition)}</p>` : ""}
<div class="scroll"><table>${c.alt_labels.length ? `<tr><th>Also</th><td>${c.alt_labels.map(esc).join(", ")}</td></tr>` : ""}${relations}
${c.wordnet ? `<tr><th>WordNet</th><td><a href="${esc(c.wordnet)}">${esc(c.wordnet.replace(/^.*synset-/, "").replace(/\.rdf$/, ""))}</a></td></tr>` : ""}</table></div>
<h2>Quotes, with narrower concepts</h2>${quotes.quotes.map(quoteCard).join("")}${pager(`/admin/concepts/${encodeURIComponent(c.slug)}`, {}, quotes.total, quotes.offset, quotes.limit)}`);
}

function worklistPage(db: DB, queue: Queue, p: URLSearchParams): string {
  const offset = Number(p.get("offset") ?? 0);
  const r = worklist(db, queue, { offset, limit: 50 }) as Record<string, unknown> & { total: number; offset: number; limit: number };
  let body = "";
  if ("works" in r) {
    const works = r.works as { id: number; title: string; authors: string[]; year: string | null; isbn: string | null; quotes: number; drupal_nid: string | null; candidates: { key: string; title: string | null; date: string | null; citekey: string | null }[] }[];
    body = `<div class="scroll"><table><tr><th>Work</th><th>Quotes</th><th>${queue === "ambiguous_works" ? "Zotero candidates" : "ISBN"}</th></tr>
${works.map((w) => `<tr><td><a href="/admin/quotes${qs({ work: w.title })}"><cite>${esc(w.title)}</cite></a><div class="note">${esc(w.authors.join("; "))}${w.year ? ` · ${esc(w.year)}` : ""}${w.drupal_nid ? ` · old site node ${esc(w.drupal_nid)}` : ""}</div></td><td>${w.quotes}</td>
<td>${queue === "ambiguous_works" ? w.candidates.map((c) => `<a href="zotero://select/library/items/${esc(c.key)}">${esc(c.key)}</a> ${esc((c.date ?? "").slice(0, 4))}${c.citekey ? ` <code>${esc(c.citekey)}</code>` : ""}`).join("<br>") : esc(w.isbn)}</td></tr>`).join("")}</table></div>`;
  } else if ("tags" in r) {
    const tags = r.tags as { tag: string; quotes: number }[];
    body = `<div class="scroll"><table><tr><th>Tag</th><th>Quotes</th></tr>${tags.map((t) => `<tr><td><a href="/admin/quotes${qs({ tag: t.tag, status: "any" })}">${esc(t.tag)}</a></td><td>${t.quotes}</td></tr>`).join("")}</table></div>`;
  } else {
    body = (r.quotes as Listed[]).map(quoteCard).join("");
  }
  return page(QUEUE_LABEL[queue], "worklists", `<h1>${QUEUE_LABEL[queue]}</h1><p class="sub"><a href="/admin/worklists">All worklists</a></p>${body}${"tags" in r ? "" : pager(`/admin/worklists/${queue}`, {}, r.total, r.offset, r.limit)}`);
}

/** The HTML for an /admin path, or null when there is no such page. */
export function renderAdmin(db: DB, path: string, params: URLSearchParams): string | null {
  if (path === "/admin" || path === "/admin/") return overviewPage(db);
  if (path === "/admin/quotes") return quotesPage(db, params);
  let m = /^\/admin\/quotes\/(\d+)$/.exec(path);
  if (m) return quotePage(db, Number(m[1]));
  if (path === "/admin/concepts") return conceptsPage(db, params);
  m = /^\/admin\/concepts\/([^/]+)$/.exec(path);
  if (m) return conceptPage(db, decodeURIComponent(m[1]), params);
  if (path === "/admin/worklists") return page("Worklists", "worklists", `<h1>Worklists</h1>${worklistTable(overview(db).queues)}`);
  m = /^\/admin\/worklists\/([a-z_]+)$/.exec(path);
  if (m && (QUEUES as readonly string[]).includes(m[1])) return worklistPage(db, m[1] as Queue, params);
  return null;
}

