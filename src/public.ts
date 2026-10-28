import { esc } from "./style.js";

/**
 * The rules for what's public, applied when the public snapshot is built (src/snapshot.ts) and nowhere
 * else. A public record has its text, place, work, and concepts. Notes, and a quote's comment (your own
 * words too), are public only with QUOTE_PUBLIC_NOTES=all, and a note tagged private never is. Status,
 * grade, flags, suspect words, plain tags, origins, and history never are; the snapshot has no columns
 * for them.
 */

export type Level = "none" | "catalogue" | "quotes";
export const LEVELS: readonly Level[] = ["none", "catalogue", "quotes"];

/** The part of the site's settings that decides what's public. */
export interface Visibility { level: Level; notes: boolean }

const sharesNotes = (v: Visibility) => v.level === "quotes" && v.notes;

/** The records a level makes public, as a condition on quotes q; at the catalogue level they're copied without their words. */
export function visible(v: Visibility): string {
  const notes = sharesNotes(v)
    ? " OR (q.kind = 'note' AND NOT EXISTS (SELECT 1 FROM quote_tags p WHERE p.quote_id = q.id AND p.tag = 'private' COLLATE NOCASE))" : "";
  return `(q.status != 'unparsed' AND (q.kind = 'quote'${notes}))`;
}

// --- Quote text ----------------------------------------------------------------------------------

/**
 * Quote text without the old site's [bib]Key[/bib] markers, in-text citations of its Biblio records; the
 * sentence around them already names the work. For display only: the store keeps the text as imported.
 */
export function plainText(text: string): string {
  return text.replace(/\s*\[bib\][^[\]]*\[\/bib\]/g, "");
}

/** *emphasis* as the old site wrote it: a pair of asterisks around words, not a lone one. */
const EMPHASIS = /(^|[\s(“"'‘—–-])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=$|[\s).,;:!?”"'’—–-])/gm;

/** Quote text as HTML: escaped, with the old site's emphasis as <em>. */
export function quoteHtml(text: string): string {
  const t = plainText(text);
  let html = "";
  let last = 0;
  for (const m of t.matchAll(EMPHASIS)) {
    const start = m.index + m[1].length;
    html += `${esc(t.slice(last, start))}<em>${esc(m[2])}</em>`;
    last = m.index + m[0].length;
  }
  return html + esc(t.slice(last));
}

// --- Citing --------------------------------------------------------------------------------------

type Csl = Record<string, unknown>;
type Name = { family?: string; given?: string; literal?: string };

const BIBTEX_TYPE: Record<string, string> = {
  book: "book", chapter: "incollection", "article-journal": "article", "article-magazine": "article", "article-newspaper": "article",
  "paper-conference": "inproceedings", report: "techreport", thesis: "phdthesis", webpage: "online",
};

/** A CSL JSON item as a BibTeX entry, for people who cite from BibTeX rather than Pandoc's CSL. */
export function bibtex(csl: Csl, key: string): string {
  const names = (v: unknown) => (Array.isArray(v) && v.length ? (v as Name[]).map((n) => n.literal ?? [n.family, n.given].filter(Boolean).join(", ")).join(" and ") : undefined);
  const year = ((csl.issued as { "date-parts"?: number[][] } | undefined)?.["date-parts"]?.[0]?.[0])?.toString();
  const type = BIBTEX_TYPE[csl.type as string] ?? "misc";
  const container = type === "incollection" ? "booktitle" : type === "article" ? "journal" : type === "inproceedings" ? "booktitle" : null;
  const fields: [string, unknown][] = [
    ["author", names(csl.author)], ["editor", names(csl.editor)], ["title", csl.title], [container ?? "", container ? csl["container-title"] : undefined],
    ["year", year], ["publisher", csl.publisher], ["address", csl["publisher-place"]], ["edition", csl.edition], ["volume", csl.volume],
    ["number", csl.issue], ["pages", csl.page], ["isbn", csl.ISBN], ["doi", csl.DOI], ["url", csl.URL],
  ];
  const value = (v: unknown) => String(v).replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  const lines = fields.filter(([k, v]) => k && v !== undefined && v !== null && value(v)).map(([k, v]) => `  ${k} = {${value(v)}}`);
  return `@${type}{${key.replace(/[\s,{}]/g, "")},\n${lines.join(",\n")}\n}`;
}
