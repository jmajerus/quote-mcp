import { beforeEach, describe, expect, it } from "vitest";
import type { CorpusClient } from "../src/capture.js";
import { ToolError } from "../src/common.js";
import type { DB } from "../src/db.js";
import { deleteQuote, editQuote, fromBook, proposeFix, reviewProposal, updateQuote } from "../src/edits.js";
import { serveHttp } from "../src/server.js";
import { runImport } from "../src/import.js";
import { getQuote, overview, searchQuotes, worklist } from "../src/queries.js";
import { renderAdmin } from "../src/web.js";
import { drupal, makeStore } from "./fixture.js";

let db: DB;
const byText = (start: string) => db.prepare("SELECT id FROM quotes WHERE text LIKE ?").pluck().get(`${start}%`) as number;
const reimport = () => runImport(db, { drupal, primary: "users/1", sources: ["users/1"], dictionary: new Set(["mobbing"]) });
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
});
