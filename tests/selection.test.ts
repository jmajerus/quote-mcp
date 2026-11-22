import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import { readIntro } from "../src/intro.js";
import { stamp } from "../src/provenance.js";
import { getQuote } from "../src/queries.js";
import { promote, publicChoice, sentenceBounds } from "../src/selection.js";
import { buildSnapshot } from "../src/snapshot.js";
import { renderAdmin, savePromotion } from "../src/web.js";
import { makeStore } from "./fixture.js";

describe("sentenceBounds", () => {
  it("reads a verified quote's bounds from the book text around it, not its shape", () => {
    // A whole clause opening in lowercase, run on from a sentence already begun.
    expect(sentenceBounds("collaboration consists in generating possibility.", { prefix: "In other words, ", suffix: " The second" }))
      .toEqual({ starts: false, ends: true, judged_by: "source" });
    // Capitalized and stopped, and the book agrees.
    expect(sentenceBounds("Hence, eradicating it is hopeless.", { prefix: "the end of it. ", suffix: "\nNext" }))
      .toEqual({ starts: true, ends: true, judged_by: "source" });
    // A capital after a comma is mid-sentence (a name).
    expect(sentenceBounds("Dante appears as blind.", { prefix: "in Part III, ", suffix: " So" }).starts).toBe(false);
  });

  it("takes an abbreviation's stop for one, and a sentence quoted without its stop as whole", () => {
    expect(sentenceBounds("It dates to 4500 B.C.E.", { prefix: "old. ", suffix: " and was lost" }).ends).toBe(false);
    expect(sentenceBounds("It dates to 4500 B.C.E", { prefix: "old. ", suffix: ". Then" }).ends).toBe(true);
    expect(sentenceBounds("are said to date back to around 4500", { prefix: "which ", suffix: " B.C.E. and" }))
      .toEqual({ starts: false, ends: false, judged_by: "source" });
  });

  it("falls back to the words' shape on a side with no book text, and with no anchor", () => {
    expect(sentenceBounds("Top of a page.", { prefix: "", suffix: " More" })).toEqual({ starts: true, ends: true, judged_by: "source" });
    expect(sentenceBounds("“Everyone deserves dignity.”", null)).toEqual({ starts: true, ends: true, judged_by: "shape" });
    expect(sentenceBounds("having become literally blind", null)).toEqual({ starts: false, ends: false, judged_by: "shape" });
    expect(sentenceBounds("… and so it ends.", null).starts).toBe(false);
    expect(sentenceBounds("It trails off …", null).ends).toBe(false);
  });
});

let db: DB;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-selection-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A quote saved as add_quote saves one: by an agent, or with `generative` as given, and its anchor's context. */
function addQuote(text: string, generative: boolean | null, anchor?: { prefix: string; suffix: string }): number {
  const work = db.prepare("SELECT id FROM works LIMIT 1").pluck().get() as number;
  const at = "2026-11-22T00:00:00.000Z";
  const id = db.prepare(`INSERT INTO quotes (kind, work_id, text, text_key, locator_kind, locator, status, grade, created_at, updated_at, provenance)
    VALUES ('quote', ?, ?, ?, 'page', '12', 'verified', 'A', ?, ?, ?) RETURNING id`).pluck()
    .get(work, text, text.toLowerCase(), at, at, JSON.stringify(stamp(generative === true ? "mcp" : generative === false ? "capture" : "zotero", generative, at, null))) as number;
  if (anchor) db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, raw, imported_at) VALUES ('agent', ?, ?, ?, ?)").run(`r${id}`, id, JSON.stringify({ anchor: { ...anchor, text } }), at);
  return id;
}

let built = 0;
function publicIds(): number[] {
  const file = path.join(dir, `public-${built++}.db`);
  buildSnapshot(db, { level: "quotes", notes: false, intro: readIntro("# Quotes"), collections: {}, sets: [], maps: [] }, file);
  const snap = new Database(file, { readonly: true });
  try {
    return snap.prepare("SELECT id FROM records ORDER BY id").pluck().all() as number[];
  } finally {
    snap.close();
  }
}

beforeEach(() => {
  db = makeStore();
});

describe("the public site's choice", () => {
  it("holds back an agent's quote, whole sentence or not, until a person promotes it", () => {
    const whole = addQuote("Collaboration is a practice.", true, { prefix: "art. ", suffix: " Then" });
    const part = addQuote("having become literally blind", true, { prefix: "Dante appears as ", suffix: ", he" });
    expect(publicIds()).not.toContain(whole);
    expect(publicIds()).not.toContain(part);
    expect(getQuote(db, whole).public).toMatchObject({ shown: false, promoted: null, reason: expect.stringMatching(/generative agent/) });

    const after = promote(db, part, "owner@example.com", { reason: "worth keeping" });
    expect(after).toMatchObject({ shown: true, promoted: { by: "owner@example.com", reason: "worth keeping" } });
    expect(publicIds()).toContain(part);
    expect(publicIds()).not.toContain(whole);
    // Promoting twice changes nothing; taking it back returns it to the rules.
    promote(db, part, "owner@example.com");
    expect(db.prepare("SELECT COUNT(*) FROM history WHERE quote_id = ? AND kind = 'promoted'").pluck().get(part)).toBe(1);
    expect(promote(db, part, "owner@example.com", { undo: true })).toMatchObject({ shown: false, promoted: null });
    expect(publicIds()).not.toContain(part);
  });

  it("holds back part of a sentence nobody is known to have saved, but not a person's own choice", () => {
    const unknownPart = addQuote("collaboration consists in generating possibility.", null, { prefix: "In other words, ", suffix: " The" });
    const unknownWhole = addQuote("Collaboration consists in generating possibility.", null, { prefix: "here. ", suffix: " The" });
    const personsPart = addQuote("consists in generating possibility", false, { prefix: "collaboration ", suffix: ". The" });
    const ids = publicIds();
    expect(ids).not.toContain(unknownPart);
    expect(ids).toContain(unknownWhole);
    expect(ids).toContain(personsPart);
    expect(publicChoice(db, unknownPart)).toMatchObject({ shown: false, sentence: { starts: false, ends: true, judged_by: "source" }, reason: expect.stringMatching(/begins mid-sentence/) });
  });

  it("keeps the quotes the fixture's people saved, and the works they cite", () => {
    const before = publicIds();
    addQuote("an agent's fragment", true);
    expect(publicIds()).toEqual(before);
  });

  it("shows the choice on the admin page, and promotes from its button under the signed-in person", () => {
    const id = addQuote("having become literally blind", true);
    let html = renderAdmin(db, `/admin/quotes/${id}`, new URLSearchParams())!;
    expect(html).toMatch(/Not shown: Saved by a generative agent/);
    expect(html).toContain(`action="/admin/quotes/${id}/promote"><button>Promote</button>`);
    expect(savePromotion(db, `/admin/quotes/${id}/promote`, new URLSearchParams(), "owner@example.com")).toEqual({ redirect: `/admin/quotes/${id}` });
    html = renderAdmin(db, `/admin/quotes/${id}`, new URLSearchParams())!;
    expect(html).toMatch(/Shown: Promoted by owner@example.com/);
    expect(html).toContain("Take back</button>");
    savePromotion(db, `/admin/quotes/${id}/promote`, new URLSearchParams({ undo: "1" }), "owner@example.com");
    expect(publicChoice(db, id).shown).toBe(false);
    expect(savePromotion(db, "/admin/quotes/1/edit", new URLSearchParams(), "x")).toBeNull();
  });
});
