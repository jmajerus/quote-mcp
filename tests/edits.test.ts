import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CorpusClient } from "../src/capture.js";
import { ToolError } from "../src/common.js";
import type { DB } from "../src/db.js";
import { acceptOcrWord, deleteQuote, editQuote, fromBook, proposeFix, reviewProposal, updateQuote } from "../src/edits.js";
import { saveAdminEdit } from "../src/web.js";
import { serveHttp } from "../src/server.js";
import { runImport } from "../src/import.js";
import { getQuote, overview, searchQuotes, worklist } from "../src/queries.js";
import { renderAdmin } from "../src/web.js";
import { drupal, makeStore } from "./fixture.js";
import { importWithSite } from "./seed.js";

let db: DB;
const byText = (start: string) => db.prepare("SELECT id FROM quotes WHERE text LIKE ?").pluck().get(`${start}%`) as number;
const reimport = () => importWithSite(db, { drupal, primary: "users/1", sources: ["users/1"], dictionary: new Set(["mobbing"]) });
const tags = (id: number) => db.prepare("SELECT tag FROM quote_tags WHERE quote_id = ? ORDER BY tag").pluck().all(id) as string[];
const fails = (f: () => unknown, pattern: RegExp) => {
  expect(f).toThrow(ToolError);
  expect(f).toThrow(pattern);
};

beforeEach(() => {
  db = makeStore();
});

describe("update_quote", () => {
  it("adds and removes tags and sets the comment, with history; a removed tag stays off through a re-import", () => {
    const id = byText("Mobbing is an emotional assault");
    expect(tags(id)).toContain("mobbing");
    const r = updateQuote(db, { id, add_tags: ["dignity", "project:x"], remove_tags: ["mobbing"], comment: "Leymann's term.", reason: "retagging" }, "agent");
    expect(r.changed).toEqual(["comment", "-mobbing", "+dignity", "+project:x"]);
    expect(tags(id)).toEqual(["dignity", "project:x"]);
    expect(r.quote).toMatchObject({ comment: "Leymann's term.", edited: true });
    expect(db.prepare("SELECT kind, actor, reason FROM history WHERE quote_id = ? AND kind IN ('comment_changed', 'tags_changed') ORDER BY id").all(id)).toEqual([
      { kind: "comment_changed", actor: "agent", reason: "retagging" }, { kind: "tags_changed", actor: "agent", reason: "retagging" },
    ]);
    expect(searchQuotes(db, { query: "Leymann" }).quotes.map((q) => q.id)).toContain(id);

    db.prepare("UPDATE quote_origins SET raw = 'older' WHERE quote_id = ?").run(id);
    reimport();
    expect(tags(id)).toEqual(["dignity", "project:x"]);
    expect(getQuote(db, id).comment).toBe("Leymann's term.");

    updateQuote(db, { id, add_tags: ["mobbing"] }, "agent");
    expect(tags(id)).toContain("mobbing");
    expect(updateQuote(db, { id, add_tags: ["mobbing"] }, "agent").changed).toEqual([]);
  });

  it("refuses nothing to do, a tag both added and removed, a note's words, and an unknown quote", () => {
    const id = byText("Mobbing is an emotional assault");
    fails(() => updateQuote(db, { id }, "agent"), /Nothing to change/);
    fails(() => updateQuote(db, { id, add_tags: ["x"], remove_tags: ["X"] }, "agent"), /both added and removed/);
    const note = db.prepare("SELECT id FROM quotes WHERE kind = 'note' LIMIT 1").pluck().get() as number;
    fails(() => updateQuote(db, { id: note, comment: "rewritten" }, "agent"), /a person's own/);
    fails(() => updateQuote(db, { id: 99999, comment: "x" }, "agent"), /No quote or note 99999/);
  });
});

describe("proposals", () => {
  it("takes a printed page as page_label, and refuses one that isn't a page or disagrees with locator", () => {
    const id = byText("Everyone deserves dignity");
    expect(proposeFix(db, { id, page_label: "211-212", rationale: "my copy" }, "agent").proposal).toMatchObject({ change: { locator: "pp. 211-212" } });
    expect(proposeFix(db, { id, page_label: "7", locator: "p. 7", rationale: "the same page twice" }, "agent").proposal).toMatchObject({ change: { locator: "p. 7" } });
    fails(() => proposeFix(db, { id, page_label: "8", locator: "p. 7", rationale: "x" }, "agent"), /locator is "p. 7" but page_label is "8"/);
    fails(() => proposeFix(db, { id, page_label: "chap. 3", rationale: "x" }, "agent"), /page_label is the number printed on the page/);
    fails(() => proposeFix(db, { id, page_label: " ", rationale: "x" }, "agent"), /page_label is the number printed on the page/);
  });

  it("proposes a fix, lists it, and applies it as a person's edit when accepted", () => {
    const id = byText("Everyone deserves dignity");
    const { proposal } = proposeFix(db, { id, text: "Everyone deserves dignity at work.", locator: "p. 7", rationale: "Checked the book", evidence: "my copy, p. 7" }, "agent");
    expect(proposal).toMatchObject({ quote_id: id, status: "pending", change: { text: "Everyone deserves dignity at work.", locator: "p. 7" }, before: { text: "Everyone deserves dignity.", locator: null } });
    expect(getQuote(db, id)).toMatchObject({ text: "Everyone deserves dignity.", proposals: [{ id: proposal.id }] });
    expect(overview(db).queues.proposals).toBe(1);
    expect((worklist(db, "proposals") as { proposals: { id: number }[] }).proposals.map((p) => p.id)).toEqual([proposal.id]);

    const r = reviewProposal(db, proposal.id, "accept", "authoring", "looks right");
    expect(r.proposal).toMatchObject({ status: "accepted", reviewer: "authoring", review_note: "looks right" });
    expect(r.quote).toMatchObject({ text: "Everyone deserves dignity at work.", locator: "p. 7", edited: true, proposals: [] });
    expect(r.quote.flags).not.toContain("no_locator");
    expect(searchQuotes(db, { query: "dignity work" }).quotes.map((q) => q.id)).toContain(id);
    expect(db.prepare("SELECT actor FROM history WHERE quote_id = ? AND kind = 'edited'").pluck().get(id)).toBe("authoring");
    fails(() => reviewProposal(db, proposal.id, "reject", "authoring"), /already accepted/);
    reimport();
    expect(getQuote(db, id).text).toBe("Everyone deserves dignity at work.");
  });

  it("refuses a text change to a quote verified since, and keeps the locator and chapter-author flags right", () => {
    const id = byText("Everyone deserves dignity");
    const text = proposeFix(db, { id, text: "Everyone deserves dignity, always.", rationale: "x" }, "agent").proposal;
    db.prepare("UPDATE quotes SET status = 'verified' WHERE id = ?").run(id);
    fails(() => reviewProposal(db, text.id, "accept", "authoring"), /checked against its Calibre book after proposal/);
    db.prepare("UPDATE quotes SET status = 'transcribed' WHERE id = ?").run(id);
    reviewProposal(db, text.id, "reject", "authoring");

    const flags = () => getQuote(db, id).flags;
    expect(flags()).toContain("no_locator");
    reviewProposal(db, proposeFix(db, { id, locator: "Kindle loc. 208", rationale: "Kindle" }, "agent").proposal.id, "accept", "authoring");
    expect(flags()).toEqual(expect.arrayContaining(["kindle_locator"]));
    expect(flags()).not.toContain("no_locator");
    reviewProposal(db, proposeFix(db, { id, locator: "7", rationale: "the page" }, "agent").proposal.id, "accept", "authoring");
    expect(flags()).not.toContain("kindle_locator");
    expect(flags()).not.toContain("no_locator");
    reviewProposal(db, proposeFix(db, { id, locator: null, rationale: "no page after all" }, "agent").proposal.id, "accept", "authoring");
    expect(flags()).toContain("no_locator");
    reviewProposal(db, proposeFix(db, { id, locator: "chap. 7.2", rationale: "an EPUB's chapter" }, "agent").proposal.id, "accept", "authoring");
    expect(getQuote(db, id).locator).toBe("chap. 7.2");
    expect(flags()).not.toContain("no_locator");
    expect(db.prepare("SELECT locator_kind, locator FROM quotes WHERE id = ?").get(id)).toEqual({ locator_kind: "chapter", locator: "7.2" });

    db.prepare(`UPDATE quotes SET flags = json_insert(flags, '$[#]', 'chapter_author') WHERE id = ?`).run(id);
    reviewProposal(db, proposeFix(db, { id, chapter_author: "Roe, Richard", rationale: "the volume's contents page" }, "agent").proposal.id, "accept", "authoring");
    expect(getQuote(db, id)).toMatchObject({ chapter_author: "Roe, Richard" });
    expect(flags()).not.toContain("chapter_author");
  });

  it("shows what the quote has now beside a stale proposal", () => {
    const id = byText("Abuse at work rarely");
    const { proposal } = proposeFix(db, { id, locator: "13", rationale: "off by one" }, "agent");
    db.prepare("UPDATE quotes SET locator = '14' WHERE id = ?").run(id);
    expect(getQuote(db, id).proposals[0]).toMatchObject({ stale: true, before: { locator: "p. 12" }, current: { locator: "p. 14" } });
    const html = renderAdmin(db, `/admin/quotes/${id}`, new URLSearchParams())!;
    expect(html).toContain("<th>Now</th>");
    expect(html).toContain("p. 14");
    expect(html).toContain(`quote-mcp proposals --reject ${proposal.id}`);
  });

  it("shows on the admin pages, with the command that accepts it", () => {
    const id = byText("Everyone deserves dignity");
    const { proposal } = proposeFix(db, { id, locator: "7", rationale: "Checked <the> book" }, "agent");
    for (const path of ["/admin/worklists/proposals", `/admin/quotes/${id}`]) {
      const html = renderAdmin(db, path, new URLSearchParams())!;
      expect(html).toContain(`Proposal ${proposal.id}`);
      expect(html).toContain(`quote-mcp proposals --accept ${proposal.id}`);
      expect(html).toContain("Checked &lt;the&gt; book");
    }
    expect(renderAdmin(db, "/admin/worklists", new URLSearchParams())).toContain("Proposed changes to review");
    editQuote(db, { id, text: "Everyone deserves *dignity* [emphasis added]." }, "jo@example.org");
    expect(renderAdmin(db, `/admin/quotes/${id}`, new URLSearchParams())).toContain("Everyone deserves <em>dignity</em> [emphasis added].");
    expect(renderAdmin(db, "/admin/quotes", new URLSearchParams({ q: "dignity" }))).toContain("<em><mark>dignity</mark></em>");
  });

  it("rejects, refuses a stale accept, and keeps a verified quote's text the book's", () => {
    const id = byText("Abuse at work rarely");
    const a = proposeFix(db, { id, chapter_author: "Someone Else", rationale: "a guess" }, "agent").proposal;
    expect(reviewProposal(db, a.id, "reject", "authoring", "no").proposal.status).toBe("rejected");
    expect(getQuote(db, id).chapter_author).toBeNull();

    const b = proposeFix(db, { id, locator: "13", rationale: "off by one" }, "agent").proposal;
    db.prepare("UPDATE quotes SET locator = '14' WHERE id = ?").run(id);
    fails(() => reviewProposal(db, b.id, "accept", "authoring"), /changed after proposal/);

    fails(() => proposeFix(db, { id, locator: "p. 14", rationale: "same" }, "agent"), /Nothing to propose/);
    fails(() => proposeFix(db, { id, locator: "15", rationale: " " }, "agent"), /rationale/);
    db.prepare("UPDATE quotes SET status = 'verified' WHERE id = ?").run(id);
    fails(() => proposeFix(db, { id, text: "Other words", rationale: "x" }, "agent"), /text is the book's/);
    expect(proposeFix(db, { id, locator: "Kindle loc. 208", rationale: "the Kindle edition" }, "agent").proposal.change).toEqual({ locator: "Kindle loc. 208" });
  });
});

describe("delete_quote", () => {
  const corpus = (dropped: number[]) => ({ dropAnchor: async (id: number) => void dropped.push(id) }) as unknown as CorpusClient;

  it("deletes an agent's quote, dropping its anchor first, and keeps it in history", async () => {
    const work = db.prepare("SELECT work_id FROM quotes LIMIT 1").pluck().get() as number;
    const id = db.prepare(`INSERT INTO quotes (kind, work_id, text, text_key, status, created_at, updated_at) VALUES ('quote', ?, 'Saved by an agent', 'savedbyanagent', 'verified', 'x', 'x') RETURNING id`).pluck().get(work) as number;
    db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, raw, imported_at) VALUES ('agent', 'r1', ?, '{}', 'x')").run(id);
    db.prepare("INSERT INTO quotes_fts (rowid, text, comment, tags) VALUES (?, 'Saved by an agent', '', '')").run(id);
    const dropped: number[] = [];
    expect(await deleteQuote(db, corpus(dropped), id, "a test quote", "agent")).toEqual({ deleted: id, anchor_dropped: true });
    expect(dropped).toEqual([id]);
    expect(db.prepare("SELECT COUNT(*) FROM quotes WHERE id = ?").pluck().get(id)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM quote_origins WHERE quote_id = ?").pluck().get(id)).toBe(0);
    expect(searchQuotes(db, { query: "agent" }).quotes).toEqual([]);
    const h = db.prepare("SELECT before, reason FROM history WHERE quote_id = ? AND kind = 'deleted'").get(id) as { before: string; reason: string };
    expect(JSON.parse(h.before)).toMatchObject({ id, text: "Saved by an agent" });
    expect(h.reason).toBe("a test quote");
  });

  it("never gives a deleted quote's id to a new one", async () => {
    const work = db.prepare("SELECT work_id FROM quotes LIMIT 1").pluck().get() as number;
    const top = db.prepare(`INSERT INTO quotes (kind, work_id, text, text_key, status, created_at, updated_at) VALUES ('quote', ?, 'The top quote', 'thetopquote', 'verified', 'x', 'x') RETURNING id`).pluck().get(work) as number;
    db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, raw, imported_at) VALUES ('agent', 'top', ?, '{}', 'x')").run(top);
    await deleteQuote(db, null, top, "testing ids", "agent");
    // The import makes a quote again once it's gone from the store.
    db.prepare("DELETE FROM quotes WHERE id = ?").run(byText("Everyone deserves dignity"));
    reimport();
    const fresh = byText("Everyone deserves dignity");
    expect(fresh).toBeGreaterThan(top);
    expect(db.prepare("SELECT kind FROM history WHERE quote_id = ?").pluck().all(top)).toEqual(["deleted"]);
  });

  it("keeps a quote an import reached while its anchor was being dropped, flagged for the anchor to go back", async () => {
    const work = db.prepare("SELECT work_id FROM quotes LIMIT 1").pluck().get() as number;
    const id = db.prepare(`INSERT INTO quotes (kind, work_id, text, text_key, status, created_at, updated_at) VALUES ('quote', ?, 'Raced', 'raced', 'verified', 'x', 'x') RETURNING id`).pluck().get(work) as number;
    db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, raw, imported_at) VALUES ('agent', 'race', ?, '{}', 'x')").run(id);
    const racing = { dropAnchor: async () => void db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, raw, imported_at) VALUES ('zotero', 'users/1:N1', ?, '', 'x')").run(id) } as unknown as CorpusClient;
    await expect(deleteQuote(db, racing, id, "racing", "agent")).rejects.toThrow(/came from zotero users\/1:N1/);
    expect(getQuote(db, id).flags).toContain("anchor_missing");
    expect(db.prepare("SELECT COUNT(*) FROM history WHERE quote_id = ? AND kind = 'deleted'").pluck().get(id)).toBe(0);

    db.prepare("DELETE FROM quote_origins WHERE kind = 'zotero' AND quote_id = ?").run(id);
    const editing = { dropAnchor: async () => void db.prepare("UPDATE quotes SET updated_at = 'later' WHERE id = ?").run(id) } as unknown as CorpusClient;
    await expect(deleteQuote(db, editing, id, "racing", "agent")).rejects.toThrow(/changed while it was being deleted/);
    expect(db.prepare("SELECT COUNT(*) FROM quotes WHERE id = ?").pluck().get(id)).toBe(1);
  });

  it("refuses an imported quote, which its source would bring back", async () => {
    const id = byText("Mobbing is an emotional assault");
    const dropped: number[] = [];
    await expect(deleteQuote(db, corpus(dropped), id, "no", "agent")).rejects.toThrow(/came from drupal/);
    expect(dropped).toEqual([]);
    await expect(deleteQuote(db, null, id, " ", "agent")).rejects.toThrow(/give a reason/);
  });
});

describe("editing on the admin pages", () => {
  it("checks against the newest anchor's passage", () => {
    const id = byText("Everyone deserves dignity");
    db.prepare("UPDATE quotes SET status = 'verified' WHERE id = ?").run(id);
    db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, raw, imported_at) VALUES ('agent', 'a', ?, ?, '2026-01-01')").run(id, JSON.stringify({ anchor: { text: "An old wording." } }));
    db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, raw, imported_at) VALUES ('corpus', 'c', ?, ?, '2026-02-01')").run(id, JSON.stringify({ anchor: { text: "Everyone deserves dignity." } }));
    expect(editQuote(db, { id, text: "Everyone deserves *dignity* [emphasis added]." }, "jo@example.org").changed).toEqual(["text"]);
    fails(() => editQuote(db, { id, text: "An old wording." }, "jo@example.org"), /Anything else that changes the words is refused/);
  });

  it("fixes a typo as a person's edit, with history, and leaves a verified quote's text alone", () => {
    const id = byText("Abuse at work rarely");
    const q = getQuote(db, id);
    const r = editQuote(db, { id, text: "Abuse at work rarely announces itself!", locator: "p. 12", comment: "", reason: "typo", updated_at: q.updated_at as string }, "jo@example.org");
    expect(r.changed).toEqual(["text"]);
    expect(r.quote).toMatchObject({ text: "Abuse at work rarely announces itself!", edited: true });
    expect(db.prepare("SELECT actor, reason FROM history WHERE quote_id = ? AND kind = 'edited'").get(id)).toEqual({ actor: "jo@example.org", reason: "typo" });
    fails(() => editQuote(db, { id, text: "Again", updated_at: q.updated_at as string }, "jo@example.org"), /changed after this form was opened/);
    expect(editQuote(db, { id, text: "Abuse at work rarely announces itself!" }, "jo@example.org").changed).toEqual([]);

    db.prepare("UPDATE quotes SET status = 'verified', text = 'Abuse at work\n\nrarely announces\nitself!' WHERE id = ?").run(id);
    // As add_quote keeps it: the passage corpus-mcp matched, with its anchor.
    db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, raw, imported_at) VALUES ('agent', 'r', ?, ?, 'x')").run(id, JSON.stringify({ anchor: { text: "Abuse at work\n\nrarely announces\nitself!" } }));
    fails(() => editQuote(db, { id, text: "Different words" }, "jo@example.org"), /words are the book's/);
    expect(editQuote(db, { id, text: "Abuse at work rarely announces itself!" }, "jo@example.org")).toMatchObject({ changed: ["text"], quote: { text: "Abuse at work rarely announces itself!", status: "verified" } });
    expect(editQuote(db, { id, text: "Abuse at work rarely [sic] announces itself!" }, "jo@example.org").quote.text).toBe("Abuse at work rarely [sic] announces itself!");
    fails(() => editQuote(db, { id, text: "Abuse at work [sic] seldom announces itself!" }, "jo@example.org"), /Anything else that changes the words is refused/);
    fails(() => editQuote(db, { id, text: "Abuse at work [usually] announces itself!" }, "jo@example.org"), /Anything else that changes the words is refused/);
    // Checked against the book's words, not the last edit: words cut with an ellipsis can be put back.
    editQuote(db, { id, text: "Abuse at work … announces *itself* [emphasis added]!" }, "jo@example.org");
    expect(editQuote(db, { id, text: "Abuse at work rarely announces itself!" }, "jo@example.org").changed).toEqual(["text"]);
    expect(editQuote(db, { id, text: "Abuse at work rarely announces itself!" }, "jo@example.org").quote.text).toBe("Abuse at work rarely announces itself!");
    expect(editQuote(db, { id, text: "Abuse at work rarely announces itself!", locator: "13" }, "jo@example.org").changed).toEqual(["locator"]);
  });

  it("adds and removes concepts, and a removed one stays off through a re-import", () => {
    const id = byText("Mobbing is an emotional assault");
    expect(tags(id)).toEqual(["mobbing"]);
    const sets = [{ slug: "harm", scheme: "human-work", label: "Harm", concepts: ["abuse"] }];
    const html = renderAdmin(db, `/admin/quotes/${id}/edit`, new URLSearchParams(), sets)!;
    expect(html).toContain('name="concepts" id="concepts" value="mobbing"');
    expect(html).toContain(">Harm</option>");
    expect(html).toContain(">The human side of work</option>");
    const spaces = JSON.parse(html.match(/id="concept-spaces">([\s\S]*?)<\/script>/)![1]) as { id: string; concepts: { label: string }[] }[];
    const labels = (space: string) => spaces.find((s) => s.id === space)!.concepts.map((c) => c.label);
    expect(labels("scheme:human-work")).toEqual(expect.arrayContaining(["abuse", "dignity", "mobbing"]));
    expect(labels("set:harm")).toEqual(["abuse"]);

    // An alternative label is the same concept, so the tag already on the quote stays.
    expect(editQuote(db, { id, concepts: ["group bullying"] }, "jo@example.org").changed).toEqual([]);
    expect(tags(id)).toEqual(["mobbing"]);

    const r = editQuote(db, { id, concepts: ["dignity", "kept-name"], reason: "retag" }, "jo@example.org");
    expect(r.changed).toEqual(["-mobbing", "+dignity", "+kept-name"]);
    expect(r.quote.edited).toBe(false);
    expect(tags(id)).toEqual(["dignity", "kept-name"]);
    expect(db.prepare("SELECT origin, concept_id IS NOT NULL AS concept FROM quote_tags WHERE quote_id = ? AND tag = 'dignity'").get(id)).toEqual({ origin: "person", concept: 1 });
    expect(db.prepare("SELECT concept_id FROM quote_tags WHERE quote_id = ? AND tag = 'kept-name'").pluck().get(id)).toBeNull();
    expect(db.prepare("SELECT tag FROM tag_removals WHERE quote_id = ?").pluck().all(id)).toEqual(["mobbing"]);
    expect(db.prepare("SELECT kind, reason FROM history WHERE quote_id = ? AND kind = 'tags_changed'").get(id)).toEqual({ kind: "tags_changed", reason: "retag" });

    reimport();
    expect(tags(id)).toEqual(["dignity", "kept-name"]);

    const quote = getQuote(db, id);
    const saved = saveAdminEdit(db, `/admin/quotes/${id}/edit`, new URLSearchParams({ concepts: "abuse", text: quote.text as string, updated_at: quote.updated_at as string }), "lan", sets);
    expect(saved).toEqual({ redirect: `/admin/quotes/${id}` });
    expect(tags(id)).toEqual(["abuse"]);
    expect(getQuote(db, id).edited).toBe(false);
    reimport();
    expect(tags(id)).toEqual(["abuse"]);
  });

  it("treats a concept's label as a known word, including when the quote is saved", () => {
    const id = byText("Everyone deserves dignity");
    const again = () => importWithSite(db, { drupal, primary: "users/1", sources: ["users/1"], dictionary: new Set(["everyone", "deserves"]) });
    again();
    expect(getQuote(db, id).suspect_words).toEqual([]);

    db.prepare("UPDATE concepts SET status = 'retired' WHERE slug = 'dignity'").run();
    again();
    expect(getQuote(db, id).suspect_words).toEqual([{ token: "dignity", reason: "unknown" }]);
    db.prepare("UPDATE concepts SET status = 'confirmed' WHERE slug = 'dignity'").run();

    const dir = mkdtempSync(path.join(tmpdir(), "quote-mcp-concepts-"));
    const list = path.join(dir, "words");
    writeFileSync(list, "everyone\ndeserves\nat\nwork\n");
    const previous = process.env.QUOTE_DICTIONARY;
    process.env.QUOTE_DICTIONARY = list;
    try {
      const saved = editQuote(db, { id, text: "Everyone deserves dlgnity at work." }, "jo@example.org");
      expect(saved.quote.suspect_words).toEqual([{ token: "dlgnity", reason: "confusion", suggestion: "dignity" }]);
    } finally {
      if (previous === undefined) delete process.env.QUOTE_DICTIONARY;
      else process.env.QUOTE_DICTIONARY = previous;
    }
  });

  it("clears a corrected misspelling, and accepts an unknown word as real", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "quote-mcp-words-"));
    const list = path.join(dir, "words");
    writeFileSync(list, "the\nway\ntraditional\nan\npractice\nmobbing\n");
    const previous = process.env.QUOTE_DICTIONARY;
    process.env.QUOTE_DICTIONARY = list;
    try {
      const id = byText("Everyone deserves dignity");
      const suspect = (token: string) => JSON.stringify([{ token, reason: "unknown" }]);
      const other = db.prepare(`INSERT INTO quotes (kind, work_id, text, text_key, status, grade, flags, suspects, edited, created_at, updated_at)
        VALUES ('quote', (SELECT work_id FROM quotes WHERE id = ?), 'The experiential way.', 'theexperientialway', 'transcribed', 'B', '["ocr_suspect"]', ?, 0, 'x', 'x') RETURNING id`).pluck()
        .get(id, suspect("experiential")) as number;
      db.prepare("UPDATE quotes SET text = ?, flags = ?, suspects = ?, grade = 'B' WHERE id = ?")
        .run("The tradtional way.", JSON.stringify(["ocr_suspect"]), suspect("tradtional"), id);
      const server = await serveHttp(db, { host: "127.0.0.1", port: 0, capture: { writer: () => db, corpus: null, primary: "users/1" } });
      const { port } = server.address() as import("node:net").AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const post = (url: string, fields: Record<string, string>) => fetch(url, {
        method: "POST", redirect: "manual", body: new URLSearchParams(fields),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      });
      try {
        const quotePage = await (await fetch(`${base}/admin/quotes/${id}`)).text();
        expect(quotePage).toContain("tradtional (unknown)");
        expect(quotePage).toContain(`action="/admin/quotes/${id}/words"`);
        const form = await (await fetch(`${base}/admin/quotes/${id}/edit`)).text();
        expect(form).toContain("Saving checks these words again");
        expect(form).toContain("tradtional is a real word");
        const updated = /name="updated_at" value="([^"]+)"/.exec(form)![1];
        const saved = await post(`${base}/admin/quotes/${id}/edit`, { text: "The traditional way.", locator: "", comment: "", reason: "typo", updated_at: updated });
        expect(saved.status).toBe(303);
        expect(getQuote(db, id).flags).not.toContain("ocr_suspect");
        expect(getQuote(db, id).suspect_words).toEqual([]);

        db.prepare("UPDATE quotes SET text = 'The experiential way.', flags = ?, suspects = ?, grade = 'B', edited = 0 WHERE id = ?").run(JSON.stringify(["ocr_suspect"]), suspect("experiential"), id);
        const again = await (await fetch(`${base}/admin/quotes/${id}`)).text();
        expect(again).toContain("experiential (unknown)");
        const accepted = await post(`${base}/admin/quotes/${id}/words`, { word: "experiential" });
        expect(accepted.status).toBe(303);
        expect(getQuote(db, id).flags).not.toContain("ocr_suspect");
        expect(getQuote(db, other).flags).not.toContain("ocr_suspect");
        expect(getQuote(db, other).suspect_words).toEqual([]);
        expect(getQuote(db, id).edited).toBe(false);
        expect(db.prepare("SELECT word FROM ocr_words").pluck().all()).toEqual(["experiential"]);
        fails(() => acceptOcrWord(db, id, "experiential", "jo@example.org"), /isn't an unknown word/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      importWithSite(db, { drupal, primary: "users/1", sources: ["users/1"], dictionary: new Set(["the", "way", "traditional", "an", "practice", "mobbing"]) });
      expect(getQuote(db, id).text).toBe("The experiential way.");
      expect(getQuote(db, id).flags).not.toContain("ocr_suspect");
      expect(getQuote(db, other).flags).not.toContain("ocr_suspect");
    } finally {
      if (previous === undefined) delete process.env.QUOTE_DICTIONARY;
      else process.env.QUOTE_DICTIONARY = previous;
    }
  });

  it("saves the form posted from its own page, and refuses one posted from elsewhere", async () => {
    const server = await serveHttp(db, { host: "127.0.0.1", port: 0, capture: { writer: () => db, corpus: null, primary: "users/1" } });
    const { port } = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const id = byText("Everyone deserves dignity");
    try {
      const form = await (await fetch(`${base}/admin/quotes/${id}/edit`)).text();
      expect(form).toContain('<form class="edit" method="post"');
      const updated = /name="updated_at" value="([^"]+)"/.exec(form)![1];
      const post = (origin: string | null, fields: Record<string, string>) => fetch(`${base}/admin/quotes/${id}/edit`, {
        method: "POST", redirect: "manual", body: new URLSearchParams(fields),
        headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
      });
      expect((await post("https://evil.example", { text: "Hacked", updated_at: updated })).status).toBe(403);
      expect((await post(null, { text: "Hacked", updated_at: updated })).status).toBe(403);
      const saved = await post(base, { text: "Everyone deserves dignity at work.", locator: "7", comment: "", reason: "typo", updated_at: updated });
      expect(saved.status).toBe(303);
      expect(saved.headers.get("location")).toBe(`/admin/quotes/${id}`);
      expect(getQuote(db, id)).toMatchObject({ text: "Everyone deserves dignity at work.", locator: "p. 7" });
      expect(db.prepare("SELECT actor FROM history WHERE quote_id = ? AND kind = 'edited'").pluck().get(id)).toBe("lan");
      const again = await post(base, { text: "Something else", updated_at: updated });
      expect(again.status).toBe(409);
      expect(await again.text()).toContain("changed after this form was opened");
      const empty = await post(base, { text: " ", updated_at: getQuote(db, id).updated_at as string });
      expect(empty.status).toBe(400);
      expect(await (await fetch(`${base}/admin/quotes/${id}`)).text()).toContain(`href="/admin/quotes/${id}/edit"`);
      // A note has no quoted text to edit, but a chapter author can come with it from the import.
      const note = db.prepare("SELECT id FROM quotes WHERE kind = 'note' LIMIT 1").pluck().get() as number;
      const noteForm = await (await fetch(`${base}/admin/quotes/${note}/edit`)).text();
      expect(noteForm).toContain('name="chapter_author"');
      expect(noteForm).not.toContain('name="text"');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("a reader's marks in a verified quote", () => {
  const book = "I flatter myself that I understand all sorts of curiosity. Curiosity about\n\ndaily facts, about daily things, about daily men.";
  it.each([
    ["the same words, lines joined", "I flatter myself that I understand all sorts of curiosity. Curiosity about daily facts, about daily things, about daily men.", true],
    ["[sic] and a clarification in brackets", "I flatter myself [Marlow speaks] that I understand all sorts [sic] of curiosity. Curiosity about daily facts, about daily things, about daily men.", true],
    ["*emphasis* with [emphasis added]", "I flatter myself that I understand *all* sorts of curiosity [emphasis added]. Curiosity about daily facts, about daily things, about daily men.", true],
    ["words left out with …", "I flatter myself … curiosity. Curiosity about daily facts … about daily men.", true],
    ["words left out with [...]", "I flatter myself [...] about daily men.", true],
    ["an ellipsis at the start", "… about daily things, about daily men.", true],
    ["a changed word", "I flatter myself that I understand all kinds of curiosity. Curiosity about daily facts, about daily things, about daily men.", false],
    ["a bracket replacing a word", "[Marlow] flatter[s] himself that I understand all sorts of curiosity. Curiosity about daily facts, about daily things, about daily men.", false],
    ["words out of order around an ellipsis", "about daily men … I flatter myself", false],
    ["a shortened quote without an ellipsis", "I flatter myself that I understand all sorts of curiosity.", false],
    ["nothing but an ellipsis", "…", false],
  ])("%s", (_, text, ok) => {
    expect(fromBook(text, book)).toBe(ok);
  });

  it("keeps the book's own asterisks, and matches whole words beside an ellipsis", () => {
    expect(fromBook("2 3", "2 * 3")).toBe(false);
    expect(fromBook("2 * 3", "2 * 3")).toBe(true);
    expect(fromBook("*2* * 3", "2 * 3")).toBe(true);
    expect(fromBook("on … two", "one two")).toBe(false);
    expect(fromBook("one … two", "one and two")).toBe(true);
    expect(fromBook("ne … two", "one and two")).toBe(false);
    expect(fromBook("I flatter myself … curiosity", book)).toBe(true);
  });
});
