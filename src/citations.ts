import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pandoc citekeys in published prose, expanded as Pandoc expands them: Chicago author-date, its default
 * citeproc style. `[@ryan1991driving]` becomes `(Ryan and Oestreich 1991)`, and `[@ryan1991driving, p. 12]`
 * keeps the page. The store keeps the citekey. A key with no CSL record is left as it was written.
 */

export type CslItem = Record<string, unknown>;

interface CiteProc {
  Engine: new (
    sys: { retrieveLocale: (lang: string) => string; retrieveItem: (id: string) => CslItem },
    style: string,
    lang: string,
  ) => Engine;
}

interface Cite {
  key: string;
  prefix?: string;
  suffix?: string;
  locator?: string;
  label?: string;
  suppressAuthor?: boolean;
}

const require = createRequire(import.meta.url);
const CSL = require("citeproc") as CiteProc;

/** Pandoc's locator words, and the CSL label they name. `p.` and `pp.` are both a page. */
const LOCATOR_LABEL: Record<string, string> = {
  p: "page", pp: "page", page: "page", pages: "page",
  chap: "chapter", chapter: "chapter", chapters: "chapter",
  sec: "section", section: "section", sections: "section",
  para: "paragraph", paragraph: "paragraph", paragraphs: "paragraph",
  vol: "volume", volume: "volume", volumes: "volume",
  line: "line", lines: "line", note: "note", notes: "note",
  book: "book", books: "book", fig: "figure", figure: "figure", figures: "figure",
  op: "opus", opus: "opus", verse: "verse", verses: "verse",
  folio: "folio", folios: "folio", issue: "issue", issues: "issue",
  column: "column", columns: "column", part: "part", parts: "part",
};

let styleText: string | undefined;
let localeText: string | undefined;

function cslFile(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, "../vendor/csl"), join(here, "../../vendor/csl")]) {
    const file = join(dir, name);
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  throw new Error(`The citation style ${name} is not in vendor/csl.`);
}

function assets(): { style: string; locale: string } {
  styleText ??= cslFile("chicago-author-date.csl");
  localeText ??= cslFile("locales-en-US.xml");
  return { style: styleText, locale: localeText };
}

/** `p. 12` is a page locator. Anything else after the citekey is a suffix, as Pandoc treats it. */
function locatorOf(rest: string): { locator?: string; label?: string; suffix?: string } {
  const match = /^([A-Za-z]+)\.?\s+(\d[\d–—-]*)\s*(?:,\s*(.*))?$/.exec(rest.trim());
  const label = match && LOCATOR_LABEL[match[1].toLowerCase()];
  if (!match || !label) return { suffix: rest.trim() };
  const suffix = match[3]?.trim();
  return { locator: match[2], label, ...(suffix ? { suffix } : {}) };
}

/** One Pandoc citation group, `[see @key, p. 12; @other]`, or null when it isn't one. */
function bracketCites(inner: string): Cite[] | null {
  const cites: Cite[] = [];
  for (const part of inner.split(";")) {
    const match = /^\s*(.*?)\s*(-?)@([A-Za-z][A-Za-z0-9_.:-]*)\s*(?:,\s*([^]*))?$/.exec(part);
    if (!match?.[3]) return null;
    const prefix = match[1].trim();
    const rest = match[4]?.trim();
    cites.push({
      key: match[3],
      ...(prefix ? { prefix: prefix.endsWith(" ") ? prefix : `${prefix} ` } : {}),
      ...(match[2] ? { suppressAuthor: true } : {}),
      ...(rest ? locatorOf(rest) : {}),
    });
  }
  return cites;
}

interface Engine {
  updateItems: (ids: string[]) => void;
  previewCitationCluster: (
    citation: { citationItems: Record<string, unknown>[]; properties: { noteIndex: number } },
    pre: unknown[],
    post: unknown[],
    mode: string,
  ) => string;
}

function cluster(engine: Engine, cites: Cite[], narrative: boolean): string {
  const item = (cite: Cite, extra: Record<string, unknown> = {}) => ({
    id: cite.key,
    ...(cite.prefix ? { prefix: cite.prefix } : {}),
    ...(cite.suffix ? { suffix: cite.suffix } : {}),
    ...(cite.locator ? { locator: cite.locator, label: cite.label } : {}),
    ...(cite.suppressAuthor ? { "suppress-author": 1 } : {}),
    ...extra,
  });
  const preview = (citationItems: Record<string, unknown>[]) => engine.previewCitationCluster({ citationItems, properties: { noteIndex: 0 } }, [], [], "text");
  // `@key` puts the author in the sentence and the year in parentheses: Ryan and Oestreich (1991).
  if (narrative && cites.length === 1) return `${preview([item(cites[0], { "author-only": 1 })])} ${preview([item(cites[0], { "suppress-author": 1 })])}`;
  return preview(cites.map((cite) => item(cite)));
}

/** Same items, same engine. Parsing the style is the slow part, and a publish repeats it for one library. */
function librarySignature(library: Map<string, CslItem>): string {
  const hash = createHash("sha256");
  for (const key of [...library.keys()].sort()) {
    hash.update(key);
    hash.update("\0");
    hash.update(JSON.stringify(library.get(key)));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function engineFor(library: Map<string, CslItem>): Engine {
  const { style, locale } = assets();
  const engine = new CSL.Engine({
    retrieveLocale: () => locale,
    retrieveItem: (id) => library.get(id) ?? { id },
  }, style, "en-US");
  engine.updateItems([...library.keys()]);
  return engine;
}

let cached: { signature: string; render: (text: string) => string } | undefined;

/** A function that expands citekeys in one text. The engine is built on the first citekey, then kept for that library. */
export function citationRenderer(library: Map<string, CslItem>): (text: string) => string {
  if (!library.size) return (text) => text;
  const signature = librarySignature(library);
  if (cached?.signature === signature) return cached.render;
  let engine: Engine | undefined;
  const render = (text: string) => expand(text, library, () => (engine ??= engineFor(library)));
  cached = { signature, render };
  return render;
}

function expand(text: string, library: Map<string, CslItem>, engine: () => Engine): string {
  if (!text.includes("@")) return text;
  const pieces: { start: number; end: number; next: string }[] = [];
  const taken: [number, number][] = [];
  const known = (cites: Cite[]) => cites.every((cite) => library.has(cite.key));
  for (const match of text.matchAll(/\[([^[\]]*@[A-Za-z][^[\]]*)\]/g)) {
    const cites = bracketCites(match[1]);
    if (!cites) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    // A group with one unknown key stays whole, so the bare pass cannot render the known half.
    taken.push([start, end]);
    if (!known(cites)) continue;
    pieces.push({ start, end, next: cluster(engine(), cites, false) });
  }
  for (const match of text.matchAll(/(^|[\s(\[])@([A-Za-z][A-Za-z0-9_.:-]*)/g)) {
    const lead = match[1].length;
    const start = (match.index ?? 0) + lead;
    if (taken.some(([from, to]) => start >= from && start < to)) continue;
    if (!library.has(match[2])) continue;
    pieces.push({ start, end: start + 1 + match[2].length, next: cluster(engine(), [{ key: match[2] }], true) });
  }
  if (!pieces.length) return text;
  pieces.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const piece of pieces) {
    out += text.slice(at, piece.start) + piece.next;
    at = piece.end;
  }
  return out + text.slice(at);
}
