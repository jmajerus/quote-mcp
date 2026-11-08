import type { ApiItem } from "./zotero.js";

/**
 * A Zotero item as a CSL JSON item, the citation format Pandoc and citeproc read. Covers the fields
 * quotes need: type, title, creators, date, container, publisher, identifiers. The citekey is Better
 * BibTeX's, from the item's field or the "Citation Key:" line it writes to Extra.
 */

/**
 * Zotero's own CSL type for each item type (the global schema's `csl.types`). A journal article is an
 * article, and a podcast is a broadcast. An item type the schema does not name is a document, so a citation
 * still has a type, and it is not called a book.
 */
const CSL_TYPE: Record<string, string> = {
  artwork: "graphic", attachment: "document", audioRecording: "song", bill: "bill", blogPost: "post-weblog", book: "book",
  bookSection: "chapter", case: "legal_case", computerProgram: "software", conferencePaper: "paper-conference", dataset: "dataset",
  dictionaryEntry: "entry-dictionary", document: "document", email: "personal_communication", encyclopediaArticle: "entry-encyclopedia",
  film: "motion_picture", forumPost: "post", hearing: "hearing", instantMessage: "personal_communication", interview: "interview",
  journalArticle: "article-journal", letter: "personal_communication", magazineArticle: "article-magazine", manuscript: "manuscript",
  map: "map", newspaperArticle: "article-newspaper", note: "document", patent: "patent", podcast: "broadcast", preprint: "article",
  presentation: "speech", radioBroadcast: "broadcast", report: "report", standard: "standard", statute: "legislation", thesis: "thesis",
  tvBroadcast: "broadcast", videoRecording: "motion_picture", webpage: "webpage",
};

const WORK_LABEL: Record<string, string> = {
  book: "book", Book: "book", bookSection: "chapter", journalArticle: "journal article", magazineArticle: "magazine article",
  newspaperArticle: "newspaper article", webpage: "web page", blogPost: "blog post", conferencePaper: "conference paper",
  report: "report", thesis: "thesis", document: "document", encyclopediaArticle: "encyclopedia article", dictionaryEntry: "dictionary entry",
  interview: "interview", film: "film", podcast: "podcast", presentation: "presentation", case: "case", statute: "statute",
};

/** CSL's name for this stored type. The old catalogue's "Book" is a book. Anything Zotero does not map is a document. */
export function cslType(itemType: string | null | undefined): string {
  if (itemType === "Book") return "book";
  if (itemType && CSL_TYPE[itemType]) return CSL_TYPE[itemType];
  return "document";
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
  const csl: Record<string, unknown> = {
    id: citekeyOf(data) ?? key,
    type: cslType(data.itemType),
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
