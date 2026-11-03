import { beforeEach, describe, expect, it } from "vitest";
import { type AnchorChange, type Book, type CorpusClient, CorpusError, type CorpusQuote, type Verified, addQuote, followAnchors, importCorpusQuotes, retryAnchors } from "../src/capture.js";
import http from "node:http";
import { ToolError } from "../src/common.js";
import { handleCorpusQuotes } from "../src/corpus-api.js";
import { deleteQuote } from "../src/edits.js";
import type { DB } from "../src/db.js";
import { holdingsCounts } from "../src/holdings.js";
import { runImport } from "../src/import.js";
import { citeQuote, searchQuotes, worklist } from "../src/queries.js";
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

  log = "log-1";
  changes: AnchorChange[] = [];
  /** Two changes a page, so following them takes several. */
  async anchorChanges(since: number) {
    const after = this.changes.filter((c) => c.seq > since);
    return { log: this.log, changes: after.slice(0, 2), last: (after.slice(0, 2).at(-1) ?? this.changes.at(-1))?.seq ?? 0 };
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

  it("gives a new quote an id past a deleted one's", async () => {
    const first = saved(await addQuote(db, { work: "main:42", text: "It begins when an individual becomes the target" }, options())).id;
    await deleteQuote(db, corpus, first, "testing ids", "agent");
    const next = saved(await addQuote(db, { work: "main:42", text: "disrespectful behavior" }, options())).id;
    expect(next).toBeGreaterThan(first);
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

describe("following corpus-mcp's anchor changes", () => {
  const change = (seq: number, quote_id: number, kind: AnchorChange["kind"], anchor: Record<string, unknown> | null = null): AnchorChange =>
    ({ seq, quote_id, kind, status: kind === "orphaned" ? "orphaned" : "verified", anchor, at: "2026-11-03T00:00:00Z" });
  const flags = (id: number) => JSON.parse(db.prepare("SELECT flags FROM quotes WHERE id = ?").pluck().get(id) as string) as string[];
  const kept = (id: number) => JSON.parse(db.prepare("SELECT raw FROM quote_origins WHERE quote_id = ? AND kind = 'agent'").pluck().get(id) as string).anchor;

  it("flags a quote whose anchor is orphaned, keeps it verified, and clears the flag when it's found again", async () => {
    const id = saved(await addQuote(db, { work: "main:42", text: "It begins when an individual becomes the target" }, options())).id;
    const moved = { calibre_uuid: mobbingBook.calibre_uuid, sha256: "new", start_page: 41, start_offset: 3, text: "x" };
    const good = kept(id);
    corpus.changes = [change(1, id, "stored", good), change(2, 9999, "orphaned"), change(3, id, "orphaned", { ...good, sha256: null })];
    expect(await followAnchors(db, corpus)).toMatchObject({ read: 3, lost: 1, found: 0, updated: 0, from: 0, to: 3 });
    expect(kept(id)).toEqual(good);
    expect(flags(id)).toEqual(["anchor_lost"]);
    expect(db.prepare("SELECT status FROM quotes WHERE id = ?").pluck().get(id)).toBe("verified");
    expect((worklist(db, "anchor_lost") as { quotes: { id: number }[] }).quotes.map((q) => q.id)).toEqual([id]);
    expect((citeQuote(db, id).warnings as string[]).join(" ")).toMatch(/no longer finds these words/);

    corpus.changes.push(change(4, id, "found", moved));
    expect(await followAnchors(db, corpus)).toMatchObject({ read: 1, lost: 0, found: 1, updated: 1, from: 3, to: 4 });
    expect(flags(id)).toEqual([]);
    expect(kept(id)).toEqual(moved);
    expect(db.prepare("SELECT kind FROM history WHERE quote_id = ? ORDER BY id").pluck().all(id)).toEqual(["added", "anchor_lost", "anchor_found"]);
    expect(await followAnchors(db, corpus)).toMatchObject({ read: 0, from: 4, to: 4 });
  });

  it("starts a new, empty log at 0, so its first change isn't skipped", async () => {
    const id = saved(await addQuote(db, { work: "main:42", text: "It begins when an individual becomes the target" }, options())).id;
    corpus.changes = [change(1, id, "stored", kept(id)), change(2, id, "stored", kept(id)), change(3, id, "stored", kept(id))];
    await followAnchors(db, corpus);
    corpus.log = "log-2";
    corpus.changes = [];
    expect(await followAnchors(db, corpus)).toMatchObject({ read: 0, from: 0, to: 0 });
    corpus.changes = [change(1, id, "orphaned")];
    expect(await followAnchors(db, corpus)).toMatchObject({ read: 1, lost: 1 });
  });

  it("keeps a verified quote's words, status, and anchor flags when its Zotero note or old-site record changes", () => {
    runImport(db, { drupal, primary: PRIMARY, sources: [PRIMARY], dictionary: new Set(["mobbing"]) });
    const { quote_id: id, kind } = db.prepare("SELECT quote_id, kind FROM quote_origins WHERE kind IN ('drupal', 'zotero') LIMIT 1").get() as { quote_id: number; kind: string };
    db.prepare("UPDATE quotes SET status = 'verified', text = 'The book’s own words.', flags = '[\"anchor_lost\"]' WHERE id = ?").run(id);
    db.prepare("UPDATE quote_origins SET raw = 'an older version' WHERE quote_id = ? AND kind = ?").run(id, kind);
    runImport(db, { drupal, primary: PRIMARY, sources: [PRIMARY], dictionary: new Set(["mobbing"]) });
    expect(db.prepare("SELECT status, text, flags FROM quotes WHERE id = ?").get(id)).toEqual({ status: "verified", text: "The book’s own words.", flags: '["anchor_lost"]' });
    expect(db.prepare("SELECT reason FROM history WHERE quote_id = ? AND kind = 'source_changed'").pluck().get(id)).toMatch(/checked against its book/);
  });

  it("stops rather than reading the same page forever when corpus-mcp ignores since", async () => {
    corpus.changes = [change(1, 9999, "stored")];
    corpus.anchorChanges = async () => ({ log: "log-1", changes: [change(1, 9999, "stored")], last: 1 });
    await expect(followAnchors(db, corpus)).rejects.toThrow(/stopped following/);
  });

  it("reads from the start again when corpus-mcp's change log is a new one", async () => {
    const id = saved(await addQuote(db, { work: "main:42", text: "It begins when an individual becomes the target" }, options())).id;
    corpus.changes = [change(1, id, "orphaned")];
    await followAnchors(db, corpus);
    corpus.log = "log-2";
    corpus.changes = [change(1, id, "found", kept(id))];
    expect(await followAnchors(db, corpus)).toMatchObject({ read: 1, found: 1, from: 0, to: 1 });
    expect(flags(id)).toEqual([]);
  });
});

describe("the reader's routes for corpus-mcp", () => {
  const serve = async () => {
    const server = http.createServer((req, res) => void handleCorpusQuotes(db, { writer: () => db, corpus, primary: PRIMARY }, req, res, new URL(req.url ?? "/", "http://x")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { base: `http://127.0.0.1:${port}/api/corpus/quotes`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  };
  const post = (base: string, body: unknown, type = "application/json") => fetch(base, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

  it("saves a selection as add_quote does, and lists a book's quotes with flags and anchors", async () => {
    const s = await serve();
    try {
      const made = await post(s.base, { work: "main:42", text: "It begins when an individual becomes the target", page: "40", tags: ["mobbing"], request_id: "reader-1", by: "jo@example.org" });
      expect(made.status).toBe(201);
      const answer = (await made.json()) as { saved: boolean; book: Book; quote: { id: number; status: string } };
      expect(answer).toMatchObject({ saved: true, book: { book_id: "main:42" }, quote: { status: "verified" } });
      const id = answer.quote.id;
      expect(db.prepare("SELECT created_by FROM quotes WHERE id = ?").pluck().get(id)).toBe("corpus-mcp:jo@example.org");
      expect((await post(s.base, { work: "main:42", text: "It begins when an individual becomes the target", request_id: "reader-1" })).status).toBe(200);
      const numbered = await post(s.base, { work: mobbingBook.calibre_uuid, text: "disrespectful behavior", page: 40, comment: null, tags: ["mobbing"], request_id: "reader-2", by: null });
      expect(numbered.status).toBe(201);
      expect(corpus.verified.at(-1)).toMatchObject({ book: mobbingBook.calibre_uuid, page: 40 });

      db.prepare(`UPDATE quotes SET flags = '["anchor_lost"]' WHERE id = ?`).run(id);
      for (const key of [mobbingBook.calibre_uuid, "main:42"]) {
        const listed = (await (await fetch(`${s.base}?book=${encodeURIComponent(key)}`)).json()) as { quotes: Record<string, unknown>[] };
        expect(listed.quotes.filter((q) => q.id === id)).toEqual([expect.objectContaining({
          id, kind: "quote", text: "It begins when an individual becomes the target", tags: ["mobbing"], status: "verified", flags: ["anchor_lost"],
          anchor: expect.objectContaining({ calibre_uuid: mobbingBook.calibre_uuid }), admin_path: `/admin/quotes/${id}`,
        })]);
      }
      expect(((await (await fetch(`${s.base}?book=main:7`)).json()) as { quotes: unknown[] }).quotes).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("answers a miss with the closest passages, and a bad request with what's wrong", async () => {
    const s = await serve();
    try {
      const miss = await post(s.base, { work: "main:42", text: "Words this book doesn't have" });
      expect(miss.status).toBe(422);
      expect(await miss.json()).toMatchObject({ error: "no-match", message: "Not found in Mobbing (main:42). Nothing was saved.", closest: [expect.objectContaining({ page: 40 })], book: { book_id: "main:42" } });
      await rejects(addQuote(db, { work: "main:42", text: "Words this book doesn't have" }, options()), /The closest passages: \[/);
      expect((await post(s.base, { text: "no work" })).status).toBe(400);
      expect((await post(s.base, { work: "main:42", text: "x", tags: "one" })).status).toBe(400);
      expect((await post(s.base, { work: "main:42", text: "x", page: 0 })).status).toBe(400);
      expect((await post(s.base, { work: "main:42", text: "x" }, "text/plain")).status).toBe(415);
      expect((await fetch(s.base, { method: "DELETE" })).status).toBe(405);
      corpus.verify = async () => { throw new CorpusError(0, "corpus-mcp unreachable"); };
      expect((await post(s.base, { work: "main:42", text: "anything" })).status).toBe(502);
    } finally {
      await s.close();
    }
  });
});
