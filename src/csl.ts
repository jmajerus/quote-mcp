import type { ApiItem } from "./zotero.js";

/**
 * A Zotero item as a CSL JSON item, the citation format Pandoc and citeproc read. Covers the fields
 * quotes need: type, title, creators, date, container, publisher, identifiers. The citekey is Better
 * BibTeX's, from the item's field or the "Citation Key:" line it writes to Extra.
 */

/** CSL's name for a Zotero item type, only when that name is the same kind of work. A podcast is not a song, and an unmapped type is not a document. */
const CSL_TYPE: Record<string, string> = {
  book: "book", bookSection: "chapter", journalArticle: "article-journal", magazineArticle: "article-magazine",
  newspaperArticle: "article-newspaper", webpage: "webpage", blogPost: "post-weblog", conferencePaper: "paper-conference",
  report: "report", thesis: "thesis", document: "document", encyclopediaArticle: "entry-encyclopedia", dictionaryEntry: "entry-dictionary",
  interview: "interview", film: "motion_picture", presentation: "speech", case: "legal_case", statute: "legislation",
};

const WORK_LABEL: Record<string, string> = {
  book: "book", Book: "book", bookSection: "chapter", journalArticle: "journal article", magazineArticle: "magazine article",
  newspaperArticle: "newspaper article", webpage: "web page", blogPost: "blog post", conferencePaper: "conference paper",
  report: "report", thesis: "thesis", document: "document", encyclopediaArticle: "encyclopedia article", dictionaryEntry: "dictionary entry",
  interview: "interview", film: "film", podcast: "podcast", presentation: "presentation", case: "case", statute: "statute",
};

/** CSL's name for this stored type, when CSL has one for the same kind of work. The old catalogue's "Book" is a book. */
export function cslType(itemType: string | null | undefined): string | undefined {
  if (!itemType) return undefined;
  if (itemType === "Book") return "book";
  return CSL_TYPE[itemType];
}

/** The ordinary name of a stored item type. A type with no ordinary name is a work. */
export function workLabel(itemType: string | null | undefined): string {
  if (!itemType) return "work";
  return WORK_LABEL[itemType] ?? "work";
}

type Data = ApiItem["data"] & Record<string, unknown>;

export function citekeyOf(data: Data): string | null {
  if (typeof data.citationKey === "string" && data.citationKey) return data.citationKey;
  return /^Citation Key:\s*(\S+)/m.exec(String(data.extra ?? ""))?.[1] ?? null;
}

/** `@fromm1994escape` and `[@fromm1994escape]` are that citekey. Anything else is unchanged. */
export function citedKey(raw: string): string {
  const q = raw.trim();
  const match = /^(?:\[@|@)([A-Za-z][A-Za-z0-9_.:-]*)(?:\]|,.*)?$/.exec(q);
  return match?.[1] ?? q;
}

function names(data: Data, types: string[]) {
  return (data.creators ?? []).filter((c) => types.includes(c.creatorType))
    .map((c) => (c.name ? { literal: c.name } : { family: c.lastName ?? "", given: c.firstName ?? "" }));
}

function issued(date: unknown) {
  const m = /(\d{4})(?:-(\d\d))?(?:-(\d\d))?/.exec(String(date ?? ""));
  if (!m) return undefined;
  return { "date-parts": [[Number(m[1]), ...(m[2] ? [Number(m[2])] : []), ...(m[3] ? [Number(m[3])] : [])]] };
}

export function zoteroToCsl(key: string, data: Data): Record<string, unknown> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const type = cslType(data.itemType);
  const csl: Record<string, unknown> = {
    id: citekeyOf(data) ?? key,
    ...(type ? { type } : {}),
    title: str(data.title),
    author: names(data, ["author"]),
    editor: names(data, ["editor", "seriesEditor"]),
    translator: names(data, ["translator"]),
    issued: issued(data.date),
    "container-title": str(data.publicationTitle) ?? str(data.bookTitle) ?? str(data.websiteTitle) ?? str(data.blogTitle) ?? str(data.proceedingsTitle),
    publisher: str(data.publisher) ?? str(data.university) ?? str(data.institution),
    "publisher-place": str(data.place),
    edition: str(data.edition),
    volume: str(data.volume),
    issue: str(data.issue),
    page: str(data.pages),
    ISBN: str(data.ISBN),
    DOI: str(data.DOI),
    URL: str(data.url),
  };
  for (const [k, v] of Object.entries(csl)) if (v === undefined || (Array.isArray(v) && !v.length)) delete csl[k];
  return csl;
}
