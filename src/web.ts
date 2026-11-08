import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { type AddQuoteOptions, workFromMirror } from "./capture.js";
import { type MirrorBook, type WorkHit, getWork, saveSpokenQuote, searchMirror, searchWorks } from "./dictate.js";
import { type FiledItem, type PrintBook, filePrintBook, filedIsbn, lookupIsbn, printBookFromForm, rememberFiledItem, canonicalIsbn } from "./isbn.js";
import { editQuote } from "./edits.js";
import { emphasisHtml } from "./public.js";
import {
  type Proposal, QUEUES, type Queue, ToolError, type WorkSummary, citeQuote, getConcept, getQuote, listConcepts, overview, searchQuotes, worklist,
} from "./queries.js";
import { CSS, esc } from "./style.js";

/**
 * The admin pages, rendered on the server: an overview, search over quotes and notes, a record's page, the concept
 * scheme, the worklists, and the capture page. Read-only in phase 1; editing arrives with phase 2 behind Cloudflare Access.
 */

type Section = "overview" | "quotes" | "capture" | "concepts" | "worklists";



function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

function page(title: string, section: Section, body: string): string {
  const nav: [Section, string, string][] = [["overview", "Overview", "/admin"], ["quotes", "Quotes", "/admin/quotes"], ["capture", "Capture", "/admin/capture"], ["concepts", "Concepts", "/admin/concepts"], ["worklists", "Worklists", "/admin/worklists"]];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Quotes</title><link rel="icon" type="image/png" href="/favicon.png"><style>${CSS}</style></head><body>
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
  const text = q.snippet ? emphasisHtml(q.snippet).replace(/«/g, "<mark>").replace(/»/g, "</mark>") : emphasisHtml(words.length > 420 ? `${words.slice(0, 420)}…` : words);
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
  compound_tag: "Compound tags", anchor_lost: "Quotes no longer found in their book", anchor_missing: "Anchors not yet stored in corpus-mcp", proposals: "Proposed changes to review",
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

/** One proposal as a before-and-after table, with its reason and the command that accepts it. */
function proposalBlock(x: Proposal): string {
  const label: Record<string, string> = { text: "Text", locator: "Page or location", chapter_author: "Chapter author" };
  // "When proposed" is what the proposal saw; when the quote has changed since, "Now" shows it, and accepting is refused.
  const cell = (v: string | null | undefined) => `<td>${esc(v ?? "—")}</td>`;
  return `<div class="scroll"><table><tr><th>Proposal ${x.id}</th><th>When proposed</th>${x.stale ? "<th>Now</th>" : ""}<th>Proposed</th></tr>
${(Object.keys(x.change) as (keyof typeof x.change)[]).map((k) => `<tr><th>${label[k] ?? esc(k)}</th>${cell(x.before[k])}${x.stale ? cell(x.current[k]) : ""}${cell(x.change[k])}</tr>`).join("")}</table></div>
<p class="note">${esc(x.proposer)}: ${esc(x.rationale)}${x.evidence ? ` · Evidence: ${esc(x.evidence)}` : ""} · ${x.stale
    ? `The quote has changed since: reject it with <code>quote-mcp proposals --reject ${x.id}</code>.`
    : `<code>quote-mcp proposals --accept ${x.id}</code>`}</p>`;
}

function quotePage(db: DB, id: number): string {
  const q = getQuote(db, id);
  const c = citeQuote(db, id);
  const rows = (pairs: [string, string][]) => pairs.filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
  const note = q.kind === "note";
  const name = `${note ? "Note" : "Quote"} ${id}`;
  return page(name, "quotes", `<h1>${name}</h1><p class="sub">${note ? "your own words, no quoted text" : `${esc(q.status)} · grade ${esc(q.grade)}`}${q.edited ? " · edited" : ""} · <a href="/admin/quotes/${id}/edit">Edit</a></p>
${note ? (q.note ? `<div class="words">${esc(q.note)}</div>` : '<p class="note">Tags only.</p>') : `<blockquote>${emphasisHtml(q.text)}</blockquote>`}
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
${(q.proposals as Proposal[]).length ? `<h2>Proposed changes</h2>${(q.proposals as Proposal[]).map(proposalBlock).join("")}` : ""}
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

/** A word for a POSIX shell, in single quotes, so a tag copied from the worklist runs nothing. */
function shellWord(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
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
  } else if ("proposals" in r) {
    body = `<p>An agent proposed each of these. Accept or reject one on the server with <code>quote-mcp proposals --accept &lt;n&gt;</code> or <code>--reject &lt;n&gt;</code> (add <code>--note "…"</code> to say why).</p>
${(r.proposals as (Proposal & { quote: { id: number; text: string; work: string | null } })[]).map((x) => `<div class="result"><p class="text"><a href="/admin/quotes/${x.quote.id}">#${x.quote.id}</a> ${x.quote.work ? `<cite>${esc(x.quote.work)}</cite>` : ""}</p>${proposalBlock(x)}</div>`).join("")}`;
  } else if ("tags" in r) {
    const tags = r.tags as { tag: string; quotes: number }[];
    body = `<p>terminology-mcp holds the concepts. To make a tag one, propose it there with a quote as evidence; the quote's tag stays as it is, and resolves once the concept arrives.</p>
<div class="scroll"><table><tr><th>Tag</th><th>Quotes</th><th>Propose</th></tr>${tags.map((t) => `<tr><td><a href="/admin/quotes${qs({ tag: t.tag, status: "any" })}">${esc(t.tag)}</a></td><td>${t.quotes}</td><td><code>quote-mcp propose ${esc(shellWord(t.tag))}</code></td></tr>`).join("")}</table></div>`;
  } else {
    body = (r.quotes as Listed[]).map(quoteCard).join("");
  }
  return page(QUEUE_LABEL[queue], "worklists", `<h1>${QUEUE_LABEL[queue]}</h1><p class="sub"><a href="/admin/worklists">All worklists</a></p>${body}${"tags" in r ? "" : pager(`/admin/worklists/${queue}`, {}, r.total, r.offset, r.limit)}`);
}

/** The form for fixing a quote: its text (a verified quote's words are the book's; only its spacing can change), locator, chapter author, and comment. */
function editPage(db: DB, id: number, error?: string, sent?: URLSearchParams): string {
  const q = getQuote(db, id);
  const note = q.kind === "note";
  const locked = q.status === "verified";
  const value = (name: string, now: string | null) => esc(sent?.get(name) ?? now ?? "");
  const name = `Edit ${note ? "note" : "quote"} ${id}`;
  return page(name, "quotes", `<h1>${name}</h1><p class="sub"><a href="/admin/quotes/${id}">Back to the ${note ? "note" : "quote"}</a> · ${workLine(q.work, q.attribution)}</p>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<form class="edit" method="post" action="/admin/quotes/${id}/edit">
<input type="hidden" name="updated_at" value="${esc(sent?.get("updated_at") ?? (q.updated_at as string))}">
${note ? "" : `<label for="text">Text</label><textarea id="text" name="text">${value("text", q.text)}</textarea>
${locked ? '<p class="note">Checked against its Calibre book: the words are the book\'s. You can add your own marks: [brackets] for a clarification or [sic], *asterisks* around words you italicise (add [emphasis added]), and … for words left out. Spacing and line breaks can change too. Anything else that changes the words is refused.</p>' : ""}`}
<label for="locator">Page or location</label><input id="locator" name="locator" value="${value("locator", q.locator)}" placeholder="211, 211-212, or Kindle loc. 208">
<label for="chapter_author">Chapter author</label><input id="chapter_author" name="chapter_author" value="${value("chapter_author", q.chapter_author)}" placeholder="In an edited volume">
<label for="comment">${note ? "Note" : "Comment"}</label><textarea id="comment" name="comment">${value("comment", q.comment)}</textarea>
<label for="reason">Why (for the history)</label><input id="reason" name="reason" value="${value("reason", null)}" placeholder="Typo fixed">
<div class="actions"><button>Save</button><a href="/admin/quotes/${id}">Cancel</a></div>
</form>`);
}

/** Saves the edit form posted to /admin/quotes/<id>/edit: a redirect to the quote, or the form again with what was wrong. */
export function saveAdminEdit(writer: DB, path: string, form: URLSearchParams, editor: string): { redirect: string } | { status: number; html: string } | null {
  const m = /^\/admin\/quotes\/(\d+)\/edit$/.exec(path);
  if (!m) return null;
  const id = Number(m[1]);
  const field = (name: string) => (form.has(name) ? form.get(name)! : undefined);
  try {
    editQuote(writer, { id, text: field("text"), locator: field("locator"), chapter_author: field("chapter_author"), comment: field("comment"), reason: field("reason"), updated_at: field("updated_at") }, editor);
    return { redirect: `/admin/quotes/${id}` };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    if (/^No quote or note/.test(error.message)) return { status: 404, html: page("Not found", "quotes", `<h1>Not found</h1><p>${esc(error.message)}</p>`) };
    // Changed by someone else meanwhile: a fresh form, showing the quote as it is now. Otherwise what was sent, to correct.
    const stale = /changed after this form was opened/.test(error.message);
    return { status: stale ? 409 : 400, html: editPage(writer, id, error.message, stale ? undefined : form) };
  }
}

const CAPTURE_SCRIPT = `
const mic = document.querySelector("#mic");
const record = document.querySelector("#record");
const scan = document.querySelector("#scan");
const text = document.querySelector("#text");
const page = document.querySelector("#page");
const status = document.querySelector("#mic-status");
const view = document.querySelector("#scan-view");
const shot = document.querySelector("#scan-preview");
const pageText = document.querySelector("#page-text");
const KEY = "quote-capture-mic";
let recorder = null, chunks = [], stream = null, timer = null;
const say = (message) => { status.textContent = message; };
const remember = (id) => { try { localStorage.setItem(KEY, id); } catch (e) {} };
const remembered = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
const busy = (on) => { record.disabled = on; scan.disabled = on; };
async function inputs() {
  let devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  if (devices.length && devices.every((d) => !d.label)) {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  }
  return devices;
}
function fill(devices) {
  if (!devices.length) { say("No microphone was found. Plug in the USB microphone, or scan the page."); record.disabled = true; return; }
  const stored = remembered();
  const named = devices.find((d) => /usb/i.test(d.label));
  const external = devices.filter((d) => !/^default$/i.test(d.label) && !/built-in|internal|monitor/i.test(d.label));
  const chosen = devices.find((d) => d.deviceId === stored) ?? named ?? (external.length === 1 ? external[0] : devices[0]);
  mic.replaceChildren();
  for (const d of devices) {
    const option = document.createElement("option");
    option.value = d.deviceId;
    option.textContent = d.label || "Microphone";
    option.selected = d.deviceId === chosen.deviceId;
    mic.append(option);
  }
  const usb = named || (external.length === 1 && chosen === external[0]);
  say(usb ? chosen.label + " is selected. Record one quote, or scan the page." : "Choose the USB microphone, then record one quote. Or scan the page.");
}
async function fillMics() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices || typeof MediaRecorder === "undefined") {
    say("This browser can't use a microphone. Scan the page, or type the quote.");
    record.disabled = true;
    return;
  }
  try { fill(await inputs()); }
  catch (e) { say("Allow the microphone for this page, then reload. Or scan the page."); }
}
async function deliver(blob, waiting, failed) {
  say(waiting);
  busy(true);
  try {
    const res = await fetch("/admin/capture/read", { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.text !== "string") say((body && body.error) || failed);
    else if (body.kind === "page") showPage(body);
    else showSpeech(body.text);
  } catch (e) { say(failed); }
  busy(false);
}
function showSpeech(words) {
  text.value = words;
  say(view.hidden ? "Check the wording, then set the page and the concept and approve." : "Check the wording against the page, then set the concept and approve.");
  (page.value.trim() ? document.querySelector("#tag") : page).focus();
}
function showPage(body) {
  view.hidden = false;
  pageText.textContent = body.text;
  if (body.page && !page.value.trim()) page.value = body.page;
  text.value = "";
  say(body.page ? "Page " + body.page + " is from the scan. Mark the quote in the page text, then set the concept and approve." : "Mark the quote in the page text. Set the page number, then the concept, and approve.");
}
mic.addEventListener("change", () => remember(mic.value));
pageText.addEventListener("pointerup", () => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !pageText.contains(sel.anchorNode)) return;
  const marked = sel.toString().replace(/[ \\t]+\\n/g, "\\n").replace(/[ \\t]{2,}/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();
  if (!marked) return;
  text.value = marked;
  say("The marked passage is the quote. Correct it, set the concept, and approve.");
});
scan.addEventListener("change", () => {
  const file = scan.files && scan.files[0];
  if (!file) return;
  if (file.type.startsWith("image/")) {
    if (shot.dataset.objectUrl) URL.revokeObjectURL(shot.dataset.objectUrl);
    const url = URL.createObjectURL(file);
    shot.dataset.objectUrl = url;
    shot.src = url;
    shot.hidden = false;
  } else shot.hidden = true;
  view.hidden = false;
  pageText.textContent = "";
  deliver(file, "Reading the page…", "The page couldn't be read. Type the quote instead.");
});
record.addEventListener("click", async () => {
  if (recorder && recorder.state === "recording") { recorder.stop(); return; }
  record.disabled = true;
  let devices;
  try { devices = await inputs(); }
  catch (e) { say("The browser didn't allow the microphone."); record.disabled = false; return; }
  if (!devices.length) { say("No microphone was found. Plug in the USB microphone, or scan the page."); record.disabled = false; return; }
  fill(devices);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: mic.value ? { exact: mic.value } : undefined, channelCount: 1 } });
  } catch (e) {
    say("That microphone couldn't be opened. Choose it again, or plug it in.");
    record.disabled = false;
    return;
  }
  remember(mic.value);
  chunks = [];
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : (MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "");
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    record.textContent = "Record";
    record.classList.remove("recording");
    const blob = new Blob(chunks, { type: recorder.mimeType || "application/octet-stream" });
    if (blob.size < 400) { say("That recording was too short. Record the quote, then stop."); busy(false); return; }
    await deliver(blob, "Transcribing…", "The recording couldn't be transcribed. Type the quote instead.");
  };
  recorder.start();
  record.disabled = false;
  scan.disabled = true;
  record.textContent = "Stop";
  record.classList.add("recording");
  say("Listening. Speak the quote, then stop.");
  timer = setTimeout(() => { if (recorder && recorder.state === "recording") recorder.stop(); }, 180000);
});
fillMics();
`;

function workChoice(w: WorkHit): string {
  const who = w.authors.slice(0, 2).join("; ") + (w.authors.length > 2 ? " et al." : "");
  return `<a href="/admin/capture?work=${w.id}"><cite>${esc(w.title)}</cite></a>${w.year ? ` (${esc(w.year)})` : ""}${who ? `<div class="note">${esc(who)}</div>` : ""}`;
}

/** A Zotero book with no quotes yet. Choosing it makes the work, then the quote editor opens. */
function mirrorChoice(book: MirrorBook, q: string): string {
  const who = book.authors.slice(0, 2).join("; ") + (book.authors.length > 2 ? " et al." : "");
  return `<form method="post" action="/admin/capture" class="bring"><input type="hidden" name="bring" value="zotero:${esc(book.library)}/${esc(book.key)}"><input type="hidden" name="q" value="${esc(q)}"><button><cite>${esc(book.title)}</cite></button></form>${book.year ? ` (${esc(book.year)})` : ""}${who ? `<div class="note">${esc(who)}</div>` : ""}<div class="note">In Zotero, no quotes yet</div>`;
}

/** A quote just saved on this book, linked, with a note when its tag isn't a concept. */
function savedNote(db: DB, workId: number, params: URLSearchParams): string {
  const id = Number(params.get("saved"));
  if (!id) return "";
  let quote: ReturnType<typeof getQuote>;
  try {
    quote = getQuote(db, id);
  } catch {
    return "";
  }
  if (quote.work?.id !== workId) return "";
  const unresolved = params.get("unresolved") ?? "";
  const again = params.get("again") === "1";
  return `<p class="note">${again ? "The book already had these words" : "Saved"}: <a href="/admin/quotes/${id}">quote ${id}</a>.${
    unresolved ? ` ${esc(unresolved)} ${unresolved.includes(",") ? "aren't concepts" : "isn't a concept"} yet; the tag stays on the quote.` : ""
  } Capture the next one when you're ready.</p>`;
}

/**
 * Choose the book, then speak a quote or mark one on a scanned page. Without a book, a search; with one,
 * the microphone, the scan, the page, and the concept. `sent` is a form that didn't save, shown again with what was wrong.
 */
function capturePage(db: DB, params: URLSearchParams, error?: string, sent?: URLSearchParams): string {
  const asked = params.get("work");
  if (!asked) {
    const q = params.get("q") ?? "";
    const found = q.trim() ? searchWorks(db, q) : [];
    const fresh = q.trim() ? searchMirror(db, q) : [];
    const rows = [...found.map((w) => `<tr><td>${workChoice(w)}</td><td>${esc(w.year)}</td></tr>`), ...fresh.map((b) => `<tr><td>${mirrorChoice(b, q)}</td><td>${esc(b.year)}</td></tr>`)].join("");
    const mirror = params.get("mirror");
    const check = q.trim() ? `<form class="filters" method="post" action="/admin/capture"><input type="hidden" name="q" value="${esc(q)}"><input type="hidden" name="refresh" value="1"><button>Check Zotero</button><span class="note">For a book filed since the last import.</span></form>` : "";
    return page("Capture", "capture", `<h1>Capture</h1>
<p class="sub">Choose the book these quotes come from. Scan a print book's ISBN, or find a book by title, author, citekey, or ISBN. A book in Zotero with no quotes yet can be brought in here. Each quote is then spoken, or marked on a scanned page, with its page and a concept tag.</p>
${error ? `<p class="error">${esc(error)}</p>` : ""}${mirror ? `<p class="error">${esc(mirror)}</p>` : ""}
<form class="filters" method="get" action="/admin/capture"><input name="isbn" placeholder="Scan or type an ISBN" aria-label="ISBN" inputmode="text" autocomplete="off" autofocus><button>Look up</button></form>
<form class="filters" method="get" action="/admin/capture"><input name="q" placeholder="Title, author, citekey, or ISBN" value="${esc(q)}" aria-label="Find a book"><button>Find</button></form>
${q.trim() ? (rows ? `<div class="scroll"><table><tr><th>Book</th><th>Year</th></tr>${rows}</table></div>${check}` : `<p class="note">No book matches.</p>${check}`) : ""}`);
  }
  const id = Number(asked);
  const work = Number.isInteger(id) && id > 0 ? getWork(db, id) : undefined;
  if (!work) throw new ToolError(`No work ${asked}.`);
  const value = (name: string) => esc(sent?.get(name) ?? "");
  const concepts = listConcepts(db);
  const options = concepts.flatMap((c) => [c.label, ...c.alt_labels]).map((label) => `<option value="${esc(label)}">`).join("");
  const who = work.authors.slice(0, 2).join("; ") + (work.authors.length > 2 ? " et al." : "");
  return page(`Capture · ${work.title}`, "capture", `<h1>Capture</h1>
<p class="sub">${who ? `${esc(who)}, ` : ""}<cite>${esc(work.title)}</cite>${work.year ? ` (${esc(work.year)})` : ""} · <a href="/admin/capture">Choose another book</a></p>
${error ? `<p class="error">${esc(error)}</p>` : ""}${sent ? "" : savedNote(db, work.id, params)}
<p>Speak one quote, or scan one page and mark the passage. Set the page and the concept, correct the wording, and approve it. The next quote stays on this book.</p>
<form class="edit capture" method="post" action="/admin/capture">
<input type="hidden" name="work" value="quote:${work.id}">
<input type="hidden" name="request_id" value="${esc(sent?.get("request_id") ?? randomUUID())}">
<label for="mic">Microphone</label><select id="mic" aria-label="Microphone"><option value="">Allow the microphone to see its name</option></select>
<div class="actions"><button type="button" id="record">Record</button><label class="file" for="scan">Scan a page</label><input id="scan" type="file" accept="image/*,application/pdf" capture="environment"><span id="mic-status" class="note live" role="status">Plug in the USB microphone if it isn't listed.</span></div>
<div id="scan-view" class="scan-view" hidden><img id="scan-preview" alt="The scanned page" hidden><pre id="page-text" class="page-text"></pre></div>
<label for="text">Quote</label><textarea id="text" name="text" required>${value("text")}</textarea>
<p class="note">Correct the wording, or mark the quote in the page text. Approving saves that passage.</p>
<label for="page">Page</label><input id="page" name="page" required inputmode="numeric" value="${value("page")}" placeholder="40 or 211-212">
<label for="tag">Concept</label><input id="tag" name="tag" required list="concepts" value="${value("tag")}" placeholder="mobbing">
<datalist id="concepts">${options}</datalist>
<div class="actions"><button>Approve</button></div>
</form>
<script>${CAPTURE_SCRIPT}</script>`);
}

function isbnReview(book: PrintBook, error?: string, writeToken = randomUUID().replace(/-/g, "")): string {
  const cover = book.cover ? `<img src="${esc(book.cover)}" alt="">` : `<p class="note">No cover came back with this ISBN.</p>`;
  return page("File a print book", "capture", `<h1>File this book</h1>
<p class="sub">Compare this with the book in hand. Accept files it in Zotero and opens the quote editor. Reject files nothing.</p>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<div class="isbn-review">${cover}
<form method="post" action="/admin/capture">
<input type="hidden" name="file" value="1">
<input type="hidden" name="write_token" value="${esc(writeToken)}">
<input type="hidden" name="cover" value="${esc(book.cover ?? "")}">
<label for="isbn-title">Title</label><input id="isbn-title" name="title" value="${esc(book.title)}" required>
<label for="isbn-authors">Authors</label><textarea id="isbn-authors" name="authors" rows="4" required>${esc(book.authors.join("\n"))}</textarea>
<p class="note">One author per line, as printed or as Last, First.</p>
<label for="isbn-year">Year</label><input id="isbn-year" name="year" value="${esc(book.year ?? "")}" inputmode="numeric" placeholder="1999">
<label for="isbn-publisher">Publisher</label><input id="isbn-publisher" name="publisher" value="${esc(book.publisher ?? "")}">
<label for="isbn">ISBN</label><input id="isbn" name="isbn" value="${esc(book.isbn)}" required>
<div class="actions"><button>Accept</button><a href="/admin/capture">Reject</a></div>
</form></div>`);
}

/** An already-filed ISBN opens its book. A new one is looked up and shown for acceptance. */
export async function renderCaptureIsbn(db: DB, raw: string, lookup?: (isbn: string) => Promise<PrintBook | null>): Promise<{ redirect: string } | { status: number; html: string }> {
  const find = lookup ?? lookupIsbn;
  const isbn = canonicalIsbn(raw);
  if (!isbn) return { status: 400, html: capturePage(db, new URLSearchParams(), "That ISBN isn't valid. Scan it again, or find the book by title.") };
  const filed = filedIsbn(db, isbn);
  if (filed && "workId" in filed) return { redirect: `/admin/capture?work=${filed.workId}` };
  if (filed) {
    return { status: 200, html: page("File a print book", "capture", `<h1>Already in Zotero</h1>
<p class="sub"><cite>${esc(filed.title)}</cite> is already filed for this ISBN.</p>
<form method="post" action="/admin/capture" class="bring"><input type="hidden" name="bring" value="zotero:${esc(filed.library)}/${esc(filed.key)}"><button>Use this book</button></form>
<p><a href="/admin/capture">Back</a></p>`) };
  }
  try {
    const book = await find(isbn);
    if (!book) return { status: 404, html: capturePage(db, new URLSearchParams(), "No record for that ISBN. Check the number, or find the book by title.") };
    return { status: 200, html: isbnReview(book) };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { status: 502, html: capturePage(db, new URLSearchParams(), error.message) };
  }
}

/** Saves the capture form: a redirect back to the same book, or the form again with what was wrong. */
export async function saveCaptureForm(writer: DB, form: URLSearchParams, editor: string, o: Omit<AddQuoteOptions, "origin" | "actor"> & { filePrintBook?: (book: PrintBook, writeToken: string) => Promise<FiledItem> }): Promise<{ redirect: string } | { status: number; html: string }> {
  if (form.get("file") === "1") {
    let book: PrintBook | undefined;
    try {
      book = printBookFromForm(form);
      const filed = await (o.filePrintBook ?? ((record, token) => filePrintBook(process.env, record, token)))(book, form.get("write_token") ?? randomUUID());
      return { redirect: `/admin/capture?work=${rememberFiledItem(writer, filed)}` };
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      const draft: PrintBook = book ?? {
        isbn: form.get("isbn") ?? "", title: form.get("title") ?? "", authors: (form.get("authors") ?? "").split("\n").map((author) => author.trim()).filter(Boolean),
        year: form.get("year")?.trim() || null, publisher: form.get("publisher")?.trim() || null, cover: form.get("cover")?.trim() || null,
      };
      return { status: 400, html: isbnReview(draft, error.message, form.get("write_token") ?? undefined) };
    }
  }
  const bring = form.get("bring")?.trim() ?? "";
  if (form.get("refresh") === "1" || bring) {
    try {
      if (form.get("refresh") === "1") {
        const note = o.refreshZotero ? await o.refreshZotero() : "Zotero isn't set up on this server. New items arrive with the import, about every 30 minutes.";
        const next = new URLSearchParams({ q: form.get("q") ?? "" });
        if (note) next.set("mirror", note);
        return { redirect: `/admin/capture?${next}` };
      }
      return { redirect: `/admin/capture?work=${workFromMirror(writer, bring)}` };
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      return { status: 400, html: capturePage(writer, new URLSearchParams({ q: form.get("q") ?? "" }), error.message) };
    }
  }
  const work = form.get("work") ?? "";
  const id = /^quote:(\d+)$/.exec(work)?.[1];
  try {
    const saved = await saveSpokenQuote(writer, {
      work, text: form.get("text") ?? "", page: form.get("page") ?? "", tag: form.get("tag") ?? "", request_id: form.get("request_id") ?? undefined,
    }, editor, o);
    const next = new URLSearchParams({ work: id ?? "", saved: String(saved.id) });
    if (!saved.saved) next.set("again", "1");
    if (saved.unresolved.length) next.set("unresolved", saved.unresolved.join(", "));
    return { redirect: `/admin/capture?${next}` };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { status: 400, html: capturePage(writer, new URLSearchParams(id ? { work: id } : {}), error.message, form) };
  }
}

/** The HTML for an /admin path, or null when there is no such page. */
export function renderAdmin(db: DB, path: string, params: URLSearchParams): string | null {
  if (path === "/admin" || path === "/admin/") return overviewPage(db);
  if (path === "/admin/quotes") return quotesPage(db, params);
  if (path === "/admin/capture") return capturePage(db, params);
  let m = /^\/admin\/quotes\/(\d+)$/.exec(path);
  if (m) return quotePage(db, Number(m[1]));
  m = /^\/admin\/quotes\/(\d+)\/edit$/.exec(path);
  if (m) return editPage(db, Number(m[1]));
  if (path === "/admin/concepts") return conceptsPage(db, params);
  m = /^\/admin\/concepts\/([^/]+)$/.exec(path);
  if (m) return conceptPage(db, decodeURIComponent(m[1]), params);
  if (path === "/admin/worklists") return page("Worklists", "worklists", `<h1>Worklists</h1>${worklistTable(overview(db).queues)}`);
  m = /^\/admin\/worklists\/([a-z_]+)$/.exec(path);
  if (m && (QUEUES as readonly string[]).includes(m[1])) return worklistPage(db, m[1] as Queue, params);
  return null;
}

