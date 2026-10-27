import { type HTMLElement, type Node, NodeType, parse } from "node-html-parser";

/**
 * Reads one Zotero note and returns the quote it holds as fields: text, locator, chapter author, the
 * concepts in the legacy `title` attribute, and flags for anything a person should look at. Each note
 * is expected to hold one quote, in one of four forms:
 *
 *   span          <span class="quote" title="concepts"> "…" (p. 63) </span>, the legacy form
 *   escaped-span  the same span written out as text (&lt;span …&gt;), decoded and read as above
 *   blockquote    <blockquote>…</blockquote>, with an optional locator after it
 *   typed         a note that starts with a quotation mark, as typed by hand
 *
 * The parser never guesses: a note it can't read with confidence is grade C, for a person to split.
 */

export type NoteKind = "quote" | "catalog" | "empty" | "other";
export type QuoteForm = "span" | "escaped-span" | "blockquote" | "typed";
export type Grade = "A" | "B" | "C";
export type Flag =
  | "no_locator" | "kindle_locator" | "chapter_author" | "unbalanced_quotes" | "list_quote"
  | "title_tag_only" | "compound_tag" | "commentary_mixed" | "long" | "ocr_suspect";

export interface Locator {
  kind: "page" | "kindle";
  /** Normalized: "63", "63–64", "xii", "208–210". */
  value: string;
  /** As written, parentheses included. */
  raw: string;
}

export interface ParsedNote {
  kind: NoteKind;
  form?: QuoteForm;
  grade?: Grade;
  /** The quoted words without their outer quotation marks; list items start with "- ", emphasis is *…*. */
  text?: string;
  locator?: Locator;
  chapterAuthor?: string;
  /** Words in the note that are not the quote, such as a remark before it or a paraphrase after it. */
  commentary?: string;
  /** A blockquote's cite attribute. */
  sourceUrl?: string;
  /** Terms from the legacy title attribute, split on commas. */
  titleTags: string[];
  /** Keyword-in-context marks from the old site: the words in the quote that carry a concept. */
  kwic: { phrase: string; concept: string }[];
  flags: Flag[];
  /** Why a quote is grade C. */
  problems: string[];
}

/** Over this many characters a quote is flagged `long`; corpus-mcp's quotes stop at 2,000. */
export const LONG_QUOTE = 2000;

const OPEN = new Set(['"', "“"]);
const CLOSE = new Set(['"', "”"]);
const PAGE = String.raw`[ivxlcdm]+|\d+`;
/** A trailing locator: (p. 63), (p 169), (pp. 63-64), (Kindle loc. 208-210), optionally ", chapter author". */
const LOCATOR = new RegExp(
  String.raw`\(\s*(?:(?:pp?\.?|pages?)\s*((?:${PAGE})(?:\s*[-–—]\s*(?:${PAGE}))?)|kindle\s+loc(?:ation)?s?\.?\s*(\d+(?:\s*[-–—]\s*\d+)?))\s*(?:[,;]\s*([^()]+?))?\s*\)\s*$`,
  "i",
);
/** Any locator anywhere, for spotting a note that holds several quotes. */
const ANY_LOCATOR = new RegExp(String.raw`\(\s*(?:pp?\.?\s*(?:${PAGE})|kindle\s+loc)`, "gi");
const CATALOG = [
  /\bIncludes (?:bibliographical references|bibliography|index)/i,
  /\bOriginally published\b/i,
  /^(?:Translation of|Reprint|Bibliography:)/i,
];
const RESEARCH_NOTE = /\[(?:VERIFY|VERIFIED|PLACEHOLDER)\b|^(?:Discussed|Quoted) in:/m;
const BLOCK = new Set(["p", "div", "blockquote", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "table", "tr"]);

interface Block { list: boolean; text: string }

const tagOf = (node: Node) => (node.nodeType === NodeType.ELEMENT_NODE ? (node as HTMLElement).rawTagName?.toLowerCase() : undefined);

function inline(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) return node.text;
  if (node.nodeType !== NodeType.ELEMENT_NODE) return "";
  const tag = tagOf(node);
  if (tag === "br") return "\n";
  const inner = node.childNodes.map(inline).join("");
  if ((tag === "em" || tag === "i" || tag === "cite") && inner.trim()) return `*${inner.trim()}*`;
  return inner;
}

/** The note as paragraphs and list items, in order; inline content outside any block becomes a paragraph. */
function blocks(el: HTMLElement, out: Block[] = []): Block[] {
  let pending = "";
  const flush = () => {
    if (pending.trim()) out.push({ list: false, text: pending });
    pending = "";
  };
  for (const child of el.childNodes) {
    const tag = tagOf(child);
    if (!tag || !BLOCK.has(tag)) {
      pending += inline(child);
      continue;
    }
    flush();
    const c = child as HTMLElement;
    if (tag === "li") out.push({ list: true, text: inline(c) });
    else if (c.childNodes.some((n) => BLOCK.has(tagOf(n) ?? ""))) blocks(c, out);
    else out.push({ list: false, text: inline(c) });
  }
  flush();
  return out;
}

function tidy(text: string): string {
  return text.replace(/ /g, " ").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
}

function joinBlocks(list: Block[]): string {
  let out = "";
  for (const [i, b] of list.entries()) {
    const text = tidy(b.text);
    if (!text) continue;
    if (out) out += b.list || list[i - 1]?.list ? "\n" : "\n\n";
    out += b.list ? `- ${text}` : text;
  }
  return out;
}

/** The outermost quote spans: the legacy notes sometimes nest one inside another. */
export function quoteSpans(root: HTMLElement): HTMLElement[] {
  return root.querySelectorAll("span.quote").filter((el) => {
    for (let p = el.parentNode; p; p = p.parentNode) if (p.rawTagName?.toLowerCase() === "span" && p.classList?.contains("quote")) return false;
    return true;
  });
}

const splitTerms = (value: string) => value.split(",").map((t) => t.trim()).filter(Boolean);

function uniqueTerms(terms: string[]): string[] {
  const seen = new Map<string, string>();
  for (const t of terms) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  return [...seen.values()];
}

function readLocator(text: string): { body: string; locator?: Locator; chapterAuthor?: string } {
  const m = LOCATOR.exec(text);
  if (!m) return { body: text };
  const dash = (v: string) => v.replace(/\s*[-–—]\s*/, "–");
  const locator: Locator = m[1]
    ? { kind: "page", value: dash(m[1]), raw: m[0].trim() }
    : { kind: "kindle", value: dash(m[2]), raw: m[0].trim() };
  return { body: text.slice(0, m.index).trimEnd(), locator, chapterAuthor: m[3]?.trim() || undefined };
}

/**
 * Parses a note's HTML. `tags` are the note's own Zotero tags, used only to compare with the title
 * attribute; the caller keeps them as the quote's concepts.
 */
export function parseNote(html: string, tags: string[] = []): ParsedNote {
  let form: QuoteForm | undefined;
  if (/&lt;span\s+class=["']quote["']/i.test(html)) {
    html = html.replace(/&lt;(\/?span\b[^]*?)&gt;/gi, (_, inner: string) => `<${inner.replace(/&quot;/g, '"')}>`);
    form = "escaped-span";
  }
  const root = parse(html);
  const spans = quoteSpans(root);
  const quoteBlock = root.querySelector("blockquote");
  if (!form) form = spans.length ? "span" : quoteBlock ? "blockquote" : undefined;
  const titleTags = uniqueTerms(spans.flatMap((s) => splitTerms(s.getAttribute("title") ?? "")));
  const kwic = root.querySelectorAll("span.kwic")
    .map((s) => ({ phrase: tidy(inline(s)).replace(/\n/g, " "), concept: (s.getAttribute("title") ?? "").trim() }))
    .filter((k) => k.phrase && k.concept);
  const result: ParsedNote = { kind: "quote", titleTags, kwic, flags: [], problems: [] };

  const all = blocks(root);
  const full = joinBlocks(all);
  if (!full) return { ...result, kind: "empty", form: undefined };
  if (!form && CATALOG.some((re) => re.test(full))) return { ...result, kind: "catalog" };
  if (!form && (full.match(/ -- /g)?.length ?? 0) >= 2) return { ...result, kind: "catalog" };
  // Research notes left by agents and drafts: "[VERIFY: …]", "[VERIFIED]", "[PLACEHOLDER: …]".
  if (!form && RESEARCH_NOTE.test(full)) return { ...result, kind: "other" };

  let text = full;
  let opened = OPEN.has(text[0]);
  if (!form) {
    const first = [...text].findIndex((ch) => OPEN.has(ch));
    if (first < 0) return { ...result, kind: "other" };
    form = "typed";
    if (first > 0) {
      result.commentary = text.slice(0, first).trim();
      result.problems.push("commentary before the quote");
      text = text.slice(first);
      opened = true;
    }
  }
  result.form = form;
  if (form === "blockquote") result.sourceUrl = quoteBlock?.getAttribute("cite") || undefined;

  const located = readLocator(text);
  let body = located.body;
  result.locator = located.locator;
  result.chapterAuthor = located.chapterAuthor;
  if (opened) body = body.slice(1);

  let closed = CLOSE.has(body.at(-1) ?? "");
  if (closed) body = body.slice(0, -1);
  else if (opened) {
    // A paraphrase or remark after the closing mark: the quote ends at the last closing mark.
    const last = Math.max(...[...CLOSE].map((ch) => body.lastIndexOf(ch)));
    if (last > 0) {
      const after = body.slice(last + 1).trim();
      const tail = readLocator(after);
      result.commentary = [result.commentary, tail.body].filter(Boolean).join("\n\n") || undefined;
      result.locator ??= tail.locator;
      result.chapterAuthor ??= tail.chapterAuthor;
      body = body.slice(0, last);
      closed = true;
      result.flags.push("commentary_mixed");
    }
  }
  result.text = body.trim();
  if (!result.text) return { ...result, kind: "empty", form: undefined };

  if (opened !== closed) result.flags.push("unbalanced_quotes");
  if (!result.locator) result.flags.push("no_locator");
  else if (result.locator.kind === "kindle") result.flags.push("kindle_locator");
  if (result.chapterAuthor) result.flags.push("chapter_author");
  if (all.some((b) => b.list)) result.flags.push("list_quote");
  if (result.text.length > LONG_QUOTE) result.flags.push("long");
  if (tags.some((t) => t.includes(","))) result.flags.push("compound_tag");
  const noteTerms = new Set(tags.flatMap(splitTerms).map((t) => t.toLowerCase()));
  if (titleTags.some((t) => !noteTerms.has(t.toLowerCase()))) result.flags.push("title_tag_only");

  if ((full.match(ANY_LOCATOR)?.length ?? 0) > 1) result.problems.push("more than one locator: several quotes?");
  if (spans.length > 1) result.problems.push("more than one quote span: several quotes?");
  result.grade = gradeOf(result);
  return result;
}

/**
 * Splits a note that holds several quote spans, as the old site's notes do, into one piece of HTML per
 * quote, plus whatever text sits outside every span (a cross-reference, a remark).
 */
export function splitQuotes(html: string): { quotes: { html: string; concepts: string[] }[]; outside: string } {
  const root = parse(html);
  const spans = quoteSpans(root);
  const quotes = spans.map((s) => ({ html: s.toString(), concepts: uniqueTerms(splitTerms(s.getAttribute("title") ?? "")) }));
  for (const s of spans) s.remove();
  return { quotes, outside: joinBlocks(blocks(root)) };
}

/** A: clean, apart from a missing locator. B: extracted, with flags. C: needs a person to split it. */
export function gradeOf(note: ParsedNote): Grade {
  if (note.problems.length) return "C";
  return note.flags.some((f) => f !== "no_locator") ? "B" : "A";
}
