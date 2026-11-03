import { beforeEach, describe, expect, it } from "vitest";
import { type Book, type CorpusClient, CorpusError, type CorpusQuote, type Verified, addQuote, importCorpusQuotes, retryAnchors } from "../src/capture.js";
import { ToolError } from "../src/common.js";
import type { DB } from "../src/db.js";
import { holdingsCounts } from "../src/holdings.js";
import { runImport } from "../src/import.js";
import { citeQuote, searchQuotes } from "../src/queries.js";
import { drupal, makeStore } from "./fixture.js";

const PRIMARY = "users/1";
const PAGE = "Mobbing is an emotional assault. It begins when an individual becomes the target of disrespectful behavior.";

const mobbingBook: Book = {
  calibre_uuid: "11111111-2222-3333-4444-555555555555", book_id: "main:42", title: "Mobbing", authors: ["Noa Davenport"], year: 1999,
  citekey: "davenport1999mobbing", zotero: { library: PRIMARY, key: "MOBB0001" },
};
const unfiledBook: Book = {
  calibre_uuid: "99999999-8888-7777-6666-555555555555", book_id: "main:7", title: "An Unfiled Ebook", authors: ["Roe, Richard"], year: 2020,
  citekey: null, zotero: null,
};

/** corpus-mcp as the agreed contract has it, over a few books, recording what it was sent. */
class FakeCorpus implements CorpusClient {
  baseUrl = "http://corpus.test";
  books = new Map<string, { book: Book; text: string | null }>([
    ["zotero:users/1/MOBB0001", { book: mobbingBook, text: PAGE }], ["main:42", { book: mobbingBook, text: PAGE }],
    [mobbingBook.calibre_uuid, { book: mobbingBook, text: PAGE }], ["main:7", { book: unfiledBook, text: "Work is a story we tell ourselves." }],
    [unfiledBook.calibre_uuid, { book: unfiledBook, text: "Work is a story we tell ourselves." }],
  ]);
  anchors = new Map<number, Record<string, unknown>>();
  verified: { book: string; text: string; page?: number }[] = [];
  /** Errors the next anchor POSTs throw, in order. */
  anchorErrors: CorpusError[] = [];

  async verify(r: { book: string; text: string; page?: number }): Promise<Verified> {
    this.verified.push(r);
    const entry = this.books.get(r.book);
    if (!entry) throw new CorpusError(404, "no-book", { error: "no-book" });
    if (entry.text === null) throw new CorpusError(404, "no-text", { error: "no-text", book: entry.book });
    const squash = (s: string) => s.toLowerCase().replace(/["“”'’]/g, "").replace(/\s+/g, " ").trim();
    const at = squash(entry.text).indexOf(squash(r.text));
    if (at < 0) return { match: false, closest: [{ page: 40, page_label: "40", section: null, locator: "p. 40", snippet: "«Mobbing» is an emotional…" }], book: entry.book };
    const text = entry.text.slice(at, at + squash(r.text).length);
    return {
      match: true, exact: text === r.text, text, locator: "p. 40", page_label: "40", section: "Chapter 1",
      anchor: { calibre_uuid: entry.book.calibre_uuid, sha256: "abc", start_page: 39, start_offset: at, text }, book: entry.book,
    };
  }

  async anchor(quoteId: number, anchor: Record<string, unknown>): Promise<unknown> {
    const error = this.anchorErrors.shift();
    if (error) throw error;
    this.anchors.set(quoteId, anchor);
    return { quote_id: quoteId, status: "verified", anchor };
  }

  async quotes(): Promise<CorpusQuote[]> {
    return [];
  }

  async dropAnchor(quoteId: number): Promise<void> {
    this.anchors.delete(quoteId);
  }
}

let db: DB;
let corpus: FakeCorpus;
const options = () => ({ corpus, primary: PRIMARY });
const saved = (r: Record<string, unknown>) => r.quote as { id: number; text: string; status: string; locator: string | null; work: { id: number; title: string } | null; flags: string[]; tags: { tag: string; concept: unknown }[] };
const rejects = async (p: Promise<unknown>, pattern: RegExp) => {
  await expect(p).rejects.toThrow(ToolError);
  await expect(p).rejects.toThrow(pattern);
};

beforeEach(() => {
  db = makeStore();
  corpus = new FakeCorpus();
});

describe("add_quote", () => {
  it("saves the book's wording, verified, and leaves the anchor with corpus-mcp", async () => {
    const r = await addQuote(db, { work: `zotero:${PRIMARY}/MOBB0001`, text: "It begins when an individual becomes the TARGET", page: "40", tags: ["mobbing", "project:on-curiosity"] }, options());
    const q = saved(r);
    expect(r).toMatchObject({ saved: true, status: "verified", anchored: true });
    expect(q).toMatchObject({ text: "It begins when an individual becomes the target", status: "verified", locator: "p. 40", flags: [] });
    expect(q.work?.title).toMatch(/^Mobbing/);
    expect(q.tags.map((t) => [t.tag, !!t.concept])).toEqual([["mobbing", true], ["project:on-curiosity", false]]);
    expect(corpus.verified).toEqual([{ book: `zotero:${PRIMARY}/MOBB0001`, text: "It begins when an individual becomes the TARGET", page: 40 }]);
    expect(corpus.anchors.get(q.id)).toMatchObject({ calibre_uuid: mobbingBook.calibre_uuid });
    expect((r.warnings as string[]).join(" ")).toMatch(/book's wording/);
    const history = db.prepare("SELECT kind, before, after FROM history WHERE quote_id = ?").get(q.id);
    expect(history).toEqual({ kind: "added", before: "It begins when an individual becomes the TARGET", after: q.text });
    expect(searchQuotes(db, { query: "individual target" }).quotes.map((x) => x.id)).toEqual([q.id]);
  });

  it("cites a quote checked against a book as prose, with the book and its place", async () => {
    corpus.books.set("main:7", { book: unfiledBook, text: "Work is a story\nwe tell ourselves.\nAnd then\nit ends." });
    const r = await addQuote(db, { work: "main:7", text: "Work is a story we tell ourselves. And then it ends." }, options());
    expect((r.book as Book).book_id).toBe("main:7");
    const id = saved(r).id;
    expect(saved(r).text).toBe("Work is a story\nwe tell ourselves.\nAnd then\nit ends.");
    expect(citeQuote(db, id)).toMatchObject({
      quote: "Work is a story we tell ourselves.\n\nAnd then it ends.", book: { book_id: "main:7", calibre_uuid: unfiledBook.calibre_uuid },
      position: { section: "Chapter 1", page_label: "40" },
    });
    const again = await addQuote(db, { work: "main:7", text: "Work is a story we tell ourselves. And then it ends." }, options());
    expect(again).toMatchObject({ saved: false, book: { book_id: "main:7" } });
    const other = db.prepare("SELECT id FROM quotes WHERE id != ? AND kind = 'quote' LIMIT 1").pluck().get(id) as number;
    expect(citeQuote(db, other)).not.toHaveProperty("position");
  });

  it("finds the work by citekey or quote:<id> as well", async () => {
    const work = db.prepare("SELECT id FROM works WHERE zotero_key = 'MOBB0001'").pluck().get() as number;
    const byCitekey = saved(await addQuote(db, { work: "davenport1999mobbing", text: "Mobbing is an emotional assault. It begins" }, options()));
    expect(byCitekey.work?.id).toBe(work);
    expect(corpus.verified.at(-1)?.book).toBe(`zotero:${PRIMARY}/MOBB0001`);
    const byId = await addQuote(db, { work: `quote:${work}`, text: "disrespectful behavior" }, options());
    expect(saved(byId).work?.id).toBe(work);
  });

  it("saves nothing when the words aren't in the book, and gives the closest passages", async () => {
    const before = db.prepare("SELECT COUNT(*) FROM quotes").pluck().get();
    await rejects(addQuote(db, { work: "main:42", text: "Words the book never says" }, options()), /Not found in Mobbing.*Nothing was saved.*«Mobbing»/);
    expect(db.prepare("SELECT COUNT(*) FROM quotes").pluck().get()).toBe(before);
  });

  it("saves a paper book's quote transcribed, with the page given", async () => {
    const work = db.prepare("SELECT id FROM works WHERE title = 'A Book Nobody Filed'").pluck().get() as number;
    const r = await addQuote(db, { work: `quote:${work}`, text: "Dignity is not negotiable.", page: "12" }, options());
    expect(r).toMatchObject({ saved: true, status: "transcribed", anchored: false });
    expect(saved(r)).toMatchObject({ status: "transcribed", locator: "p. 12", flags: [] });
    expect(corpus.verified).toEqual([]);
  });

  it("saves transcribed when corpus-mcp has no book, or no text, for the work", async () => {
    corpus.books.delete("zotero:users/1/MOBB0001");
    const noBook = await addQuote(db, { work: `zotero:${PRIMARY}/MOBB0001`, text: "Something typed from the paper copy." }, options());
    expect(noBook).toMatchObject({ status: "transcribed" });
    expect((noBook.warnings as string[]).join(" ")).toMatch(/no Calibre book/);
    corpus.books.set("main:42", { book: mobbingBook, text: null });
    const noText = await addQuote(db, { work: "main:42", text: "Something from a scan with no text layer." }, options());
    expect(noText).toMatchObject({ status: "transcribed" });
    expect(saved(noText).work?.id).toBe(saved(noBook).work?.id);
  });

  it("asks which book when a key names several", async () => {
    corpus.verify = async () => {
      throw new CorpusError(409, "ambiguous", { error: "ambiguous", books: [mobbingBook, { ...mobbingBook, book_id: "main:43", year: 2005 }] });
    };
    await rejects(addQuote(db, { work: "davenport1999mobbing", text: "It begins when an individual" }, options()), /main:42.*main:43/);
  });

  it("files a Calibre book not in Zotero as an unmatched work, once", async () => {
    const a = saved(await addQuote(db, { work: "main:7", text: "Work is a story" }, options()));
    const b = saved(await addQuote(db, { work: unfiledBook.calibre_uuid, text: "a story we tell ourselves" }, options()));
    expect(a.work?.title).toBe("An Unfiled Ebook");
    expect(b.work?.id).toBe(a.work?.id);
    expect(holdingsCounts(db, PRIMARY).works.find((w) => w.work_id === a.work?.id)).toMatchObject({ match: "unmatched", calibre_uuid: unfiledBook.calibre_uuid, quotes: 2, verified: 2 });
  });

  it("returns the quote already saved for a retry, by request_id or by the same words", async () => {
    const first = saved(await addQuote(db, { work: "main:42", text: "an individual becomes the target", request_id: "r1" }, options()));
    expect(await addQuote(db, { work: "main:42", text: "something else entirely", request_id: "r1" }, options())).toMatchObject({ saved: false, quote: { id: first.id } });
    expect(await addQuote(db, { work: "main:42", text: "An individual becomes the target" }, options())).toMatchObject({ saved: false, quote: { id: first.id } });
    // The fixture's own quote from the old site counts too.
    expect(await addQuote(db, { work: "main:42", text: "Mobbing is an emotional assault." }, options())).toMatchObject({ saved: false, reason: /already has/ });
  });

  it("verifies again when the anchor is stale, and flags the quote when corpus-mcp can't take it", async () => {
    corpus.anchorErrors = [new CorpusError(409, "stale-anchor", { error: "stale-anchor" })];
    const fresh = await addQuote(db, { work: "main:42", text: "disrespectful behavior" }, options());
    expect(fresh).toMatchObject({ anchored: true });
    expect(corpus.verified.length).toBe(2);

    corpus.anchorErrors = [0, 1, 2].map(() => new CorpusError(0, "unreachable"));
    const pending = await addQuote(db, { work: "main:42", text: "the target of disrespectful" }, options());
    const id = saved(pending).id;
    expect(pending).toMatchObject({ saved: true, status: "verified", anchored: false, quote: { flags: ["anchor_missing"] } });
    expect(await retryAnchors(db, corpus)).toEqual({ tried: 1, stored: 1 });
    expect(corpus.anchors.has(id)).toBe(true);
    expect(searchQuotes(db, { flag: "anchor_missing" as never, status: "any" }).total).toBe(0);
  });

  it("checks a Calibre book's work against the book again, by quote:<id> or its UUID, and without corpus-mcp saves it transcribed", async () => {
    const work = saved(await addQuote(db, { work: "main:7", text: "Work is a story" }, options())).work!.id;
    const again = await addQuote(db, { work: `quote:${work}`, text: "we tell ourselves", page: "12-13" }, options());
    expect(again).toMatchObject({ status: "verified", quote: { work: { id: work } } });
    expect(corpus.verified.at(-1)).toEqual({ book: unfiledBook.calibre_uuid, text: "we tell ourselves", page: 12 });
    const off = await addQuote(db, { work: unfiledBook.calibre_uuid, text: "Typed while corpus-mcp was off." }, { corpus: null, primary: PRIMARY });
    expect(off).toMatchObject({ status: "transcribed", quote: { work: { id: work } } });
    await rejects(addQuote(db, { work: "main:7", text: "Typed while corpus-mcp was off." }, { corpus: null, primary: PRIMARY }), /find_work/);
  });

  it("returns the saved quote for a retry when corpus-mcp is down, or when two retries race", async () => {
    const first = saved(await addQuote(db, { work: "davenport1999mobbing", text: "the target of disrespectful behavior" }, options()));
    corpus.verify = async () => {
      throw new CorpusError(0, "unreachable");
    };
    expect(await addQuote(db, { work: "davenport1999mobbing", text: "The target of disrespectful behavior" }, options())).toMatchObject({ saved: false, quote: { id: first.id } });
    corpus = new FakeCorpus();
    const [a, b] = await Promise.all([1, 2].map(() => addQuote(db, { work: "main:42", text: "an individual becomes", request_id: "race" }, options())));
    expect([a.saved, b.saved].sort()).toEqual([false, true]);
    expect(saved(a).id).toBe(saved(b).id);
  });

  it("verifies a stale anchor again only once", async () => {
    corpus.anchorErrors = [1, 2].map(() => new CorpusError(409, "stale-anchor", { error: "stale-anchor" }));
    const r = await addQuote(db, { work: "main:42", text: "disrespectful behavior" }, options());
    expect(r).toMatchObject({ anchored: false, quote: { flags: ["anchor_missing"] } });
    expect(corpus.verified.length).toBe(2);
  });

  it("refuses text over the limit, and works it can't find", async () => {
    await rejects(addQuote(db, { work: "main:42", text: "x".repeat(2001) }, options()), /limit is 2000/);
    await rejects(addQuote(db, { work: "nobody2000nothing", text: "words" }, options()), /No work for/);
    await rejects(addQuote(db, { work: "quote:99999", text: "words" }, options()), /No work quote:99999/);
  });

  it("is left alone by the import's OCR check once verified", async () => {
    const id = saved(await addQuote(db, { work: "main:42", text: "disrespectful behavior" }, options())).id;
    runImport(db, { drupal, primary: PRIMARY, sources: [PRIMARY], dictionary: new Set(["mobbing"]) });
    expect(db.prepare("SELECT flags FROM quotes WHERE id = ?").pluck().get(id)).toBe("[]");
  });
});

describe("taking over corpus-mcp's quotes", () => {
  const theirs = (id: number, book: Book, text: string, labels: string[], note: string | null = null): CorpusQuote => ({
    id, book_id: book.book_id, calibre_uuid: book.calibre_uuid, title: book.title, text, note, labels, page: 40, status: "verified", created_by: "claude", created_at: "2026-10-01T00:00:00Z",
  });
  const quotes = [
    theirs(1, mobbingBook, "It begins when an individual becomes the target", ["confirmation bias"], "Why it matters."),
    theirs(2, unfiledBook, "Work is a story", ["curiosity", "test:standalone-article"]),
    theirs(3, unfiledBook, "Work is a story we tell ourselves.", ["project:on-curiosity", "curiosity"]),
    theirs(4, mobbingBook, "Words this book doesn't have", ["curiosity"]),
  ];

  it("checks each again, saves it with origin corpus and its tags as written, and posts its anchor", async () => {
    const r = await importCorpusQuotes(db, corpus, quotes, { primary: PRIMARY, skip: [2] });
    expect(r.map((x) => [x.corpus_id, x.status ?? x.skipped ?? "error"])).toEqual([[1, "verified"], [2, "asked to skip"], [3, "verified"], [4, "error"]]);
    expect(r[3].error).toMatch(/Not found/);
    const [one, three] = [r[0].quote_id!, r[2].quote_id!];
    expect(corpus.anchors.has(one) && corpus.anchors.has(three)).toBe(true);
    expect(db.prepare("SELECT kind, ref FROM quote_origins WHERE quote_id IN (?, ?) ORDER BY ref").all(one, three)).toEqual([{ kind: "corpus", ref: "1" }, { kind: "corpus", ref: "3" }]);
    const q3 = db.prepare("SELECT created_by, comment FROM quotes WHERE id = ?").get(three);
    expect(q3).toEqual({ created_by: "corpus-mcp:claude", comment: null });
    expect(db.prepare("SELECT comment FROM quotes WHERE id = ?").pluck().get(one)).toBe("Why it matters.");
    expect(db.prepare("SELECT tag FROM quote_tags WHERE quote_id = ? ORDER BY tag").pluck().all(three)).toEqual(["curiosity", "project:on-curiosity"]);
    const unfiled = holdingsCounts(db, PRIMARY).works.find((w) => w.work_id === db.prepare("SELECT work_id FROM quotes WHERE id = ?").pluck().get(three));
    expect(unfiled).toMatchObject({ match: "unmatched", calibre_uuid: unfiledBook.calibre_uuid, verified: 1 });

    const again = await importCorpusQuotes(db, corpus, quotes, { primary: PRIMARY, skip: [2, 4] });
    expect(again.filter((x) => x.skipped === "already taken").map((x) => [x.corpus_id, x.quote_id])).toEqual([[1, one], [3, three]]);
  });

  it("takes over a quote whose words the work already has: checked again, origin and tags added, anchor posted", async () => {
    const mine = saved(await addQuote(db, { work: "main:42", text: "It begins when an individual becomes the target", tags: ["mobbing"] }, options())).id;
    corpus.anchors.clear();
    const before = corpus.verified.length;
    const [r] = await importCorpusQuotes(db, corpus, [quotes[0]], { primary: PRIMARY });
    expect(r).toMatchObject({ corpus_id: 1, quote_id: mine, taken_over: true, anchored: true, status: "verified" });
    expect(corpus.verified.length).toBe(before + 1);
    expect(corpus.anchors.has(mine)).toBe(true);
    expect(db.prepare("SELECT kind FROM quote_origins WHERE quote_id = ? ORDER BY kind").pluck().all(mine)).toEqual(["agent", "corpus"]);
    expect(db.prepare("SELECT tag FROM quote_tags WHERE quote_id = ? ORDER BY tag").pluck().all(mine)).toEqual(["confirmation bias", "mobbing"]);
    expect(db.prepare("SELECT flags FROM quotes WHERE id = ?").pluck().get(mine)).toBe("[]");
    expect(db.prepare("SELECT COUNT(*) FROM history WHERE quote_id = ? AND kind = 'taken_over'").pluck().get(mine)).toBe(1);
    expect(db.prepare("SELECT tags FROM quotes_fts WHERE rowid = ?").pluck().get(mine)).toMatch(/confirmation bias/);
    const [again] = await importCorpusQuotes(db, corpus, [quotes[0]], { primary: PRIMARY });
    expect(again).toMatchObject({ quote_id: mine, skipped: "already taken" });
  });

  it("changes nothing on a dry run", async () => {
    const before = db.prepare("SELECT COUNT(*) FROM quotes").pluck().get();
    const r = await importCorpusQuotes(db, corpus, quotes, { primary: PRIMARY, dryRun: true });
    expect(r.every((x) => x.skipped?.startsWith("dry run"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) FROM quotes").pluck().get()).toBe(before);
    expect(corpus.verified).toEqual([]);
  });
});
