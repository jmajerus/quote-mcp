import { type HTMLElement, type Node, NodeType, parse } from "node-html-parser";

/**
 * Reads one Zotero note and returns the quote it holds as fields: text, locator, chapter author, the
 * concepts in the legacy `title` attribute, and flags for anything a person should look at. These quotes
 * were typed to one pattern: the words between one opening and one closing double mark. Quotations inside
 * them are in single marks, or sometimes double ones, which are content so long as they pair. A page in parentheses ends the quote, and stands
 * in for a closing mark that's missing (which is flagged), so a note can hold several (the others are in `more`).
 * Words outside the marks are a comment.
 * Notes come in four forms:
 *
 *   span          <span class="quote" title="concepts"> "…" (p. 63) </span>, the legacy form
 *   escaped-span  the same span written out as text (&lt;span …&gt;), decoded and read as above
 *   blockquote    <blockquote>…</blockquote>, with an optional locator after it
 *   typed         a note that starts with a quotation mark, as typed by hand
 *
 * The parser never guesses: a note that doesn't follow the pattern is a slip or damage, so it keeps its
 * words as they are, marks included, and is flagged for a person, or is grade C when it may hold several quotes.
 */

export type NoteKind = "quote" | "catalog" | "empty" | "other";
export type QuoteForm = "span" | "escaped-span" | "blockquote" | "typed";
export type Grade = "A" | "B" | "C";
export type Flag =
  | "no_locator" | "kindle_locator" | "chapter_author" | "unbalanced_quotes" | "list_quote"
  | "title_tag_only" | "compound_tag" | "commentary_mixed" | "long" | "ocr_suspect" | "lead_in" | "no_marks" | "passage_gone";

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
  /** The note's other passages, when it holds several, each with its own text and page. */
  more?: ParsedNote[];
}

/** Over this many characters a quote is flagged `long`; corpus-mcp's quotes stop at 2,000. */
export const LONG_QUOTE = 2000;

const OPEN = new Set(['"', "“"]);
const CLOSE = new Set(['"', "”"]);
const PAGE = String.raw`[ivxlcdm]+|\d+`;
/** A trailing locator: (p. 63), (p 169), (pp. 63-64), (Kindle loc. 208-210), optionally ", chapter author". */
const LOCATOR = new RegExp(
  String.raw`\(\s*(?:(?:pp?[.,]?|pages?)\s*((?:${PAGE})(?:\s*[-–—]\s*(?:${PAGE}))?)|kindle\s+loc(?:ation)?s?\.?\s*(\d+(?:\s*[-–—]\s*\d+)?))\s*(?:[,;]\s*([^()]+?))?\s*\)\s*$`,
  "i",
);
/** Any locator anywhere, for spotting a note that holds several quotes. */
const ANY_LOCATOR = new RegExp(String.raw`\(\s*(?:pp?[.,]?\s*(?:${PAGE})|kindle\s+loc)`, "gi");
/** A locator typed inside the closing mark at a line's end, (p. 24)", or with no parentheses after it, " p. 222. */
const PAGES = String.raw`(?:${PAGE})(?:\s*[-–—]\s*(?:${PAGE}))?`;
const INSIDE_MARK = new RegExp(String.raw`[ \t]*(\([ \t]*(?:pp?[.,]?|pages?)[ \t]*${PAGES}[ \t]*\))[ \t]*(["”])[ \t]*$`, "gim");
const BARE_PAGE = new RegExp(String.raw`(["”])[ \t]+(pp?\.[ \t]*${PAGES})[ \t]*$`, "gim");
/** Every form of page reference, as metadata beside a quote's words: in parentheses anywhere, or bare after a closing mark at a line's end. */
export const PAGE_REFERENCE = new RegExp(String.raw`\(\s*(?:pp?[.,]?|pages?)\s*${PAGES}[^()]*\)|\(\s*kindle\s+loc[^()]*\)|(?<=["”][ \t]+)pp?\.[ \t]*${PAGES}[ \t]*$`, "gim");
/** The page that ends a quote: after its closing mark and any emphasis or footnote closing there, or standing in for the mark. */
const QUOTE_END = new RegExp(String.raw`(["”])?(\*+|\.?\[\/fn\])?\s*(${LOCATOR.source.replace(String.raw`\s*$`, "")})`, "gi");
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

export function readLocator(text: string): { body: string; locator?: Locator; chapterAuthor?: string } {
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
    html = decodeEscapedSpans(html);
    form = "escaped-span";
  }
  const root = parse(html);
  const spans = quoteSpans(root);
  const quoteBlock = root.querySelector("blockquote");
  if (!form) form = spans.length ? "span" : quoteBlock ? "blockquote" : undefined;
  // Concepts belong to their span: each span of several is read alone, so its quotes keep its own concepts.
  if (spans.length > 1) {
    const read = spans.flatMap((s) => {
      const p = parseNote(s.toString(), tags);
      return p.kind === "quote" ? [p, ...(p.more ?? [])] : [];
    }).map((p) => ({ ...p, more: undefined }));
    if (read.length) {
      for (const s of spans) s.remove();
      const outside = joinBlocks(blocks(root));
      const last = read[read.length - 1];
      if (outside) {
        last.commentary = [last.commentary, outside].filter(Boolean).join("\n\n");
        last.flags = [...last.flags, "commentary_mixed"];
        last.grade = gradeOf(last);
      }
      return { ...read[0], form: form ?? "span", more: read.length > 1 ? read.slice(1) : undefined };
    }
  }
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

  const text = full;
  if (!form) {
    if (![...text].some((ch) => OPEN.has(ch))) return { ...result, kind: "other" };
    form = "typed";
  }
  result.form = form;
  if (form === "blockquote") result.sourceUrl = quoteBlock?.getAttribute("cite") || undefined;

  /** The common fields once a quote's own have been read, for the note and each of its passages. */
  const finish = (r: ParsedNote): ParsedNote => {
    if (!r.locator) r.flags.push("no_locator");
    else if (r.locator.kind === "kindle") r.flags.push("kindle_locator");
    if (r.chapterAuthor) r.flags.push("chapter_author");
    if (all.some((b) => b.list)) r.flags.push("list_quote");
    if ((r.text ?? "").length > LONG_QUOTE) r.flags.push("long");
    if (tags.some((t) => t.includes(","))) r.flags.push("compound_tag");
    const noteTerms = new Set(tags.flatMap(splitTerms).map((t) => t.toLowerCase()));
    if (titleTags.some((t) => !noteTerms.has(t.toLowerCase()))) r.flags.push("title_tag_only");
    r.grade = gradeOf(r);
    return r;
  };
  const read = readQuotes(text);
  if (read.quotes === undefined) return finish({ ...result, text, problems: [read.unsure] });
  const parts = read.quotes.map((q) => finish({ ...result, ...q, flags: [...q.flags], problems: [] }));
  if (!parts[0].text) return { ...result, kind: "empty", form: undefined };
  return parts.length > 1 ? { ...parts[0], more: parts.slice(1) } : parts[0];
}

type Read = Pick<ParsedNote, "text" | "locator" | "chapterAuthor" | "commentary" | "flags">;

const hasDoubleMark = (body: string) => /["“”]/.test(body);
/** Whether the double marks inside a quote's words pair up, as a quotation inside it does. Single marks are apostrophes as often as not. */
function innerMarksPair(body: string): boolean {
  const count = (mark: string) => body.split(mark).length - 1;
  return count('"') % 2 === 0 && count("“") === count("”");
}
/** Off the pattern: marks inside that don't pair, or marks both before and inside, when nothing says which are the quote's. */
const offPattern = (lead: string, body: string) => !innerMarksPair(body) || (!!lead && !/^\*+$/.test(lead) && hasDoubleMark(body));

const joined = (...parts: (string | undefined)[]) => parts.map((p) => p?.trim()).filter(Boolean).join("\n\n") || undefined;

/** Whole quotes at the start of some words, each in its own marks and ending its line, and how far they run. */
function pairsBefore(words: string): { quotes: Read[]; length: number } {
  const quotes: Read[] = [];
  let at = 0;
  for (;;) {
    const m = /^(["“])([^"“”\n]*(?:\n[^"“”\n]*)*?)(["”])\s*\n+\s*(?=["“])/.exec(words.slice(at));
    if (!m) break;
    quotes.push({ text: m[2].trim(), flags: [] });
    at += m[0].length;
  }
  return { quotes, length: at };
}

/**
 * The quotes in a note's words. Each page ends a quote, which starts at the first opening mark since the last one ended;
 * with no closing mark before it, the page stands in for one, and the missing mark is flagged. Words before that mark are a comment on it; words after the last page, on the last.
 */
function readQuotes(raw: string): { quotes: Read[]; unsure?: undefined } | { quotes?: undefined; unsure: string } {
  const text = raw.replace(INSIDE_MARK, "$2 $1").replace(BARE_PAGE, "$1 ($2)");
  const ends = [...text.matchAll(QUOTE_END)];
  const anyOpening = (s: string) => [...s].findIndex((ch) => OPEN.has(ch));
  if (!ends.length) return readWithoutPage(text);
  const quotes: Read[] = [];
  let from = 0;
  for (const end of ends) {
    const part = text.slice(from, end.index);
    const opening = anyOpening(part);
    const close = end[1] ?? "";
    if (opening < 0) {
      if (ends.length > 1) return { unsure: "a page with no opening mark, among several page references: several quotes?" };
      // No opening mark: not a quote by the rule, so its words stay as they are.
      const located = readLocator(end[3]);
      return { quotes: [{ text: `${part}${close}${end[2] ?? ""}`.trim(), locator: located.locator, chapterAuthor: located.chapterAuthor, commentary: text.slice(end.index + end[0].length).trim() || undefined, flags: [close ? "unbalanced_quotes" : "no_marks"] }] };
    }
    // Quotes grouped under a concept needn't each have a page: those before this one end at their closing mark, and have none.
    const earlier = pairsBefore(part.slice(opening));
    quotes.push(...earlier.quotes);
    const body = part.slice(opening + earlier.length + 1);
    if (body.match(ANY_LOCATOR)) return { unsure: "a page reference inside a quote: several quotes?" };
    const located = readLocator(end[3]);
    const place = { locator: located.locator, chapterAuthor: located.chapterAuthor };
    // The closing mark is there, with words between it and the page: the page is still this quote's, and the words a comment.
    const marks = close ? [] : [...body.matchAll(/["”]/g)];
    if (!close && marks.length === 1 && !/["“”]/.test(body.slice(0, marks[0].index))) {
      const lead = part.slice(0, opening).trim();
      const after = body.slice(marks[0].index + 1).trim();
      const emphasis = /^\*+$/.test(lead);
      // Marks in mid-sentence set off a phrase: the note has no marks of its own.
      if (lead && !emphasis && after && !/[:,\n]\s*$/.test(part.slice(0, opening))) {
        quotes.push({ text: part.trim(), ...place, flags: ["no_marks"] });
      } else {
        const flags: Read["flags"] = lead && !emphasis ? ["lead_in"] : [];
        if (after) flags.push("commentary_mixed");
        quotes.push({ text: `${emphasis ? lead : ""}${body.slice(0, marks[0].index)}`.trim(), ...place, commentary: joined(emphasis ? undefined : lead, after), flags });
      }
      from = end.index + end[0].length;
      continue;
    }
    // A closing mark just before a footnote's end closes something in the footnote, not the quote (#251, #462).
    if (offPattern(part.slice(0, opening).trim(), body) || /\[\/fn\]$/.test(end[2] ?? "")) {
      // Off the pattern, so nothing says which marks are the quote's: its words stay as they are.
      quotes.push({ text: `${part.slice(0, opening)}${part.slice(opening + earlier.length)}${close}${end[2] ?? ""}`.trim(), ...place, flags: ["unbalanced_quotes"] });
    } else {
      const lead = part.slice(0, opening).trim();
      const emphasis = /^\*+$/.test(lead);
      quotes.push({ text: `${emphasis ? lead : ""}${body}${end[2] ?? ""}`.trim(), ...place, commentary: emphasis ? undefined : lead || undefined,
        flags: [...(lead && !emphasis ? ["lead_in" as const] : []), ...(close ? [] : ["unbalanced_quotes" as const])] });
    }
    from = end.index + end[0].length;
  }
  const rest = text.slice(from).trim();
  // Another quote after the last page, in its own marks on its own line, with no page of its own.
  if (OPEN.has(rest[0] ?? "")) {
    const after = readWithoutPage(rest);
    // Marks inside would make it a remark that quotes something, as often as a quote (#342).
    if (after.quotes && !after.quotes.some((q) => q.flags.includes("unbalanced_quotes") || q.flags.includes("no_marks") || hasDoubleMark(q.text ?? ""))) return { quotes: [...quotes, ...after.quotes] };
  }
  if (rest) {
    const last = quotes[quotes.length - 1];
    last.commentary = joined(last.commentary, rest);
    last.flags = [...last.flags, "commentary_mixed"];
  }
  return { quotes };
}

/** A note with no closing mark and page: one pair of marks around its words, or it stays as it is, flagged. */
function readWithoutPage(text: string): { quotes: Read[]; unsure?: undefined } | { quotes?: undefined; unsure: string } {
  const located = readLocator(text);
  const words = located.body;
  const place = { locator: located.locator, chapterAuthor: located.chapterAuthor };
  const opening = [...words].findIndex((ch) => OPEN.has(ch));
  if (opening < 0) return { quotes: [{ text: words.trim(), ...place, flags: [CLOSE.has(words.at(-1) ?? "") ? "unbalanced_quotes" : "no_marks"] }] };
  const closing = Math.max(...[...CLOSE].map((ch) => words.lastIndexOf(ch)));
  // An opening mark with nothing to close it isn't taken for an outer one: it stays, for a person to see.
  if (closing <= opening) return { quotes: [{ text: words.trim(), ...place, flags: ["unbalanced_quotes"] }] };
  const body = words.slice(opening + 1, closing);
  if (body.match(ANY_LOCATOR)) return { unsure: "a page reference inside a quote: several quotes?" };
  if (/["”]\s*\n+\s*["“]/.test(body)) {
    // Quotes grouped under a concept, in their own marks, with no page.
    const lines = words.trim().split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const clean = lines.every((l) => OPEN.has(l[0]) && CLOSE.has(l.at(-1) ?? "") && innerMarksPair(l.slice(1, -1)));
    if (clean && !place.locator) return { quotes: lines.map((l) => ({ text: l.slice(1, -1).trim(), flags: [] })) };
    return { unsure: "a closing mark then an opening mark, not each a clean quote: several quotes?" };
  }
  if (offPattern(words.slice(0, opening).trim(), body)) return { quotes: [{ text: words.trim(), ...place, flags: ["unbalanced_quotes"] }] };
  const lead = words.slice(0, opening).trim();
  const leadEmphasis = /^\*+$/.test(lead);
  let rest = words.slice(closing + 1).trim();
  let emphasis = /^\*+$/.test(rest);
  // Emphasis around the marks and a remark: *"The words." (III, iii)*. It closes on the words, not the remark.
  let closesEmphasis = "";
  if (leadEmphasis && !emphasis && rest.endsWith(lead)) {
    closesEmphasis = lead;
    rest = rest.slice(0, -lead.length).trim();
    emphasis = false;
  }
  // Marks in the middle of a sentence are a phrase being quoted, not the quote: the note has no marks of its own.
  if (lead && !leadEmphasis && rest && !emphasis && !/[:,]$|\n$/.test(words.slice(0, opening).trimEnd()) && !readLocator(rest).locator) return { quotes: [{ text: words.trim(), ...place, flags: ["no_marks"] }] };
  const tail = emphasis ? undefined : readLocator(rest);
  const flags: Read["flags"] = [];
  if (lead && !leadEmphasis) flags.push("lead_in");
  if (tail?.body) flags.push("commentary_mixed");
  return { quotes: [{
    text: `${leadEmphasis ? lead : ""}${body}${closesEmphasis}${emphasis ? rest : ""}`.trim(), locator: place.locator ?? tail?.locator, chapterAuthor: place.chapterAuthor ?? tail?.chapterAuthor,
    commentary: joined(leadEmphasis ? undefined : lead, tail?.body), flags,
  }] };
}

/** A note's words as plain text: paragraphs, list items, and emphasis kept as parseNote keeps them. */
export function noteText(html: string): string {
  return joinBlocks(blocks(parse(decodeEscapedSpans(html))));
}

/** A span written out as text (&lt;span …&gt;) as a real one. */
function decodeEscapedSpans(html: string): string {
  return html.replace(/&lt;(\/?span\b[^]*?)&gt;/gi, (_, inner: string) => `<${inner.replace(/&quot;/g, '"')}>`);
}

/** A: clean, apart from a missing locator. B: extracted, with flags. C: needs a person to split it. */
export function gradeOf(note: ParsedNote): Grade {
  if (note.problems.length) return "C";
  return note.flags.some((f) => f !== "no_locator") ? "B" : "A";
}
