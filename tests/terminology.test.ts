import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import { readIntro } from "../src/intro.js";
import { openSnapshot } from "../src/published-sqlite.js";
import { buildSnapshot } from "../src/snapshot.js";
import { findConcept } from "../src/queries.js";
import type { ConceptSet } from "../src/sets.js";
import {
  type Change, type Term, type TerminologyClient, TerminologyError, acceptHeldChange, proposal, readCursor, reportProgress, runTermSync,
} from "../src/terminology.js";
import { runImport } from "../src/import.js";
import { drupal, makeStore } from "./fixture.js";

/** The fixture's three concepts as terminology-mcp holds them after importing quote-mcp's export. */
function imported(): Term[] {
  const term = (id: string, slug: string, kid: number, rest: Partial<Term> = {}): Term => ({
    id, scheme: "human-work", slug, label: slug, altLabels: [], status: "active", broader: [], relations: [], links: [],
    aliases: [`quote-mcp:human-work:${slug}`, `drupal:kid:${kid}`], ...rest,
  });
  return [
    term("t_abuse", "abuse", 1, { scopeNote: "cruel or inhumane treatment", relations: [{ type: "opposite", target: "t_dignity" }] }),
    term("t_mobbing", "mobbing", 2, { altLabels: ["group bullying"], broader: ["t_abuse"] }),
    term("t_dignity", "dignity", 3, { relations: [{ type: "opposite", target: "t_abuse" }] }),
  ];
}

/** A terminology-mcp that serves a state, a changelog after it, and records progress reports. */
function server(terms: Term[], changes: Change[] = [], log = "log-1") {
  const reports: Record<string, unknown>[] = [];
  let last = -1;
  const client: TerminologyClient & { reports: typeof reports; changes: TerminologyClient["changes"]; log: string; list: Change[] } = {
    baseUrl: "http://terminology.test",
    reports, log, list: changes,
    state: async () => ({ log: client.log, version: 10, terms }),
    changes: async (since) => ({ log: client.log, version: Math.max(10, ...client.list.map((c) => c.n)), changes: client.list.filter((c) => c.n > since) }),
    reportProgress: async (report) => {
      if (!report.reset && (report.through as number) < last) throw new TerminologyError(409, "behind", { through: last });
      last = report.through as number;
      reports.push(report);
      return {};
    },
    propose: async () => ({}),
  };
  return client;
}

const concept = (db: DB, slug: string) => db.prepare("SELECT * FROM concepts WHERE slug = ?").get(slug) as Record<string, unknown>;
const relations = (db: DB) => db.prepare(`SELECT a.slug || ' ' || r.type || ' ' || b.slug FROM concept_relations r JOIN concepts a ON a.id = r.from_id
  JOIN concepts b ON b.id = r.to_id ORDER BY 1`).pluck().all();
const tagsOf = (db: DB, slug: string) => db.prepare("SELECT t.tag FROM quote_tags t JOIN concepts c ON c.id = t.concept_id WHERE c.slug = ? ORDER BY t.tag").pluck().all(slug);
const SETS: ConceptSet[] = [{ slug: "harm", scheme: "human-work", label: "Harm", narrower: ["abuse"] }];

let db: DB;
beforeEach(() => {
  db = makeStore();
});

async function bootstrapped(changes: Change[] = []) {
  const client = server(imported(), changes);
  await runTermSync({ db, client, sets: SETS });
  return client;
}

describe("the bootstrap", () => {
  it("dry-runs first: it reports what would change and writes nothing", async () => {
    const result = await runTermSync({ db, client: server(imported()), sets: SETS, apply: false });
    expect(result.outcome).toBe("bootstrap");
    expect(result.lines[0]).toBe("3 terms matched to concepts, 0 new");
    // The fixture stores the opposite on one end only; terminology-mcp has both.
    expect(result.lines).toContain("relation dignity inverse abuse: added");
    expect(readCursor(db)).toBeNull();
    expect(concept(db, "abuse").term_id).toBeNull();
  });

  it("matches terms to concepts by their quote-mcp alias, and saves the cursor", async () => {
    const result = await runTermSync({ db, client: server(imported()), sets: SETS });
    expect(result.outcome).toBe("bootstrapped");
    expect(concept(db, "mobbing")).toMatchObject({ term_id: "t_mobbing", status: "confirmed", source: "drupal:kid:2", alt_labels: '["group bullying"]' });
    expect(relations(db)).toEqual(["abuse inverse dignity", "abuse narrower mobbing", "dignity inverse abuse", "mobbing broader abuse"]);
    expect(readCursor(db)).toEqual({ log: "log-1", through: 10, blocked: null });
  });

  it("holds, writing nothing, when a slug differs", async () => {
    const terms = imported();
    terms[1].slug = "workplace-mobbing";
    const result = await runTermSync({ db, client: server(terms), sets: SETS });
    expect(result.outcome).toBe("bootstrap-held");
    expect(result.problems).toContainEqual({ code: "slug-mismatch", reason: "mobbing is workplace-mobbing in terminology-mcp" });
    expect(readCursor(db)).toBeNull();
  });

  it("stops the old-site import adding concepts once the scheme is followed", async () => {
    const after = imported();
    const client = await bootstrapped([{ n: 11, kind: "slugged", afterTerms: [{ ...after[2], slug: "human-dignity", formerSlugs: ["dignity"] }] }]);
    await runTermSync({ db, client, sets: SETS });
    runImport(db, { drupal, primary: "users/1", sources: ["users/1"] });
    expect(db.prepare("SELECT slug FROM concepts ORDER BY slug").pluck().all()).toEqual(["abuse", "human-dignity", "mobbing"]);
  });

  it("reports a concept terminology-mcp doesn't have, and leaves it", async () => {
    const result = await runTermSync({ db, client: server(imported().slice(0, 2).map((t) => ({ ...t, relations: [] }))), sets: SETS, apply: false });
    expect(result.problems).toContainEqual(expect.objectContaining({ code: "not-in-terminology" }));
    expect(result.outcome).toBe("bootstrap");
  });
});

describe("following changes", () => {
  it("applies additions, labels, and notes, and reports progress", async () => {
    const after = imported();
    const care: Term = { id: "t_care", scheme: "human-work", slug: "care", label: "care", status: "provisional", broader: ["t_dignity"], relations: [], aliases: [] };
    const client = await bootstrapped([
      { n: 11, kind: "added", after: care },
      { n: 12, kind: "labelled", afterTerms: [{ ...after[1], label: "workplace mobbing" }] },
      { n: 13, kind: "noted", afterTerms: [{ ...after[2], scopeNote: "the quality of being worthy of esteem" }] },
    ]);
    const result = await runTermSync({ db, client, sets: SETS });
    expect(result).toMatchObject({ outcome: "applied", through: 13, blocked: null });
    expect(concept(db, "care")).toMatchObject({ status: "provisional", term_id: "t_care", source: null });
    expect(relations(db)).toContain("dignity narrower care");
    expect(concept(db, "mobbing").label).toBe("workplace mobbing");
    expect(concept(db, "dignity").definition).toBe("the quality of being worthy of esteem");
    await reportProgress(client, result);
    expect(client.reports.at(-1)).toEqual({ log: "log-1", through: 13, label: "Quote MCP", schemes: ["human-work"] });
  });

  it("re-points a merged concept's quotes to its replacement, keeping the tags' words, with history", async () => {
    const after = imported();
    const client = await bootstrapped([{ n: 11, kind: "merged", afterTerms: [{ ...after[1], status: "retired", replacedBy: ["t_abuse"], broader: [] }, after[0]] }]);
    const before = tagsOf(db, "mobbing").length;
    const result = await runTermSync({ db, client, sets: SETS });
    expect(result.outcome).toBe("applied");
    expect(result.lines).toContain(`11 re-pointed ${before} quotes from mobbing to abuse`);
    expect(concept(db, "mobbing").status).toBe("retired");
    expect(tagsOf(db, "mobbing")).toEqual([]);
    expect(tagsOf(db, "abuse")).toContain("mobbing");
    expect(db.prepare("SELECT COUNT(*) FROM history WHERE kind = 'concept_replaced'").pluck().get()).toBe(before);
  });

  it("holds a retirement without one replacement when quotes use the concept, until it's accepted", async () => {
    const after = imported();
    const client = await bootstrapped([
      { n: 11, kind: "retired", afterTerms: [{ ...after[1], status: "retired", replacedBy: [], broader: [] }, after[0]] },
      { n: 12, kind: "noted", afterTerms: [{ ...after[2], scopeNote: "worth" }] },
    ]);
    const held = await runTermSync({ db, client, sets: SETS });
    expect(held).toMatchObject({ outcome: "held", through: 10, blocked: { at: 11, code: "retire-ambiguous" } });
    expect(concept(db, "mobbing").status).toBe("confirmed");
    await reportProgress(client, held);
    expect(client.reports.at(-1)).toMatchObject({ through: 10, blocked: { at: 11, code: "retire-ambiguous" } });

    const accepted = await acceptHeldChange({ db, client, n: 11, repointTo: "abuse" });
    expect(accepted.lines[0]).toMatch(/^re-pointed \d+ quotes from mobbing to abuse$/);
    expect(concept(db, "mobbing").status).toBe("retired");
    const next = await runTermSync({ db, client, sets: SETS });
    expect(next).toMatchObject({ outcome: "applied", through: 12, blocked: null });
    expect(concept(db, "dignity").definition).toBe("worth");
  });

  it("holds a split of a concept that quotes use", async () => {
    const after = imported();
    const client = await bootstrapped([{ n: 11, kind: "split", afterTerms: [{ ...after[1], status: "retired", replacedBy: ["t_a", "t_b"] }] }]);
    expect((await runTermSync({ db, client, sets: SETS })).blocked).toMatchObject({ at: 11, code: "split" });
  });

  it("holds a slug change vocab/sets.json names, and applies one it doesn't, keeping the old slug resolvable", async () => {
    const after = imported();
    const client = await bootstrapped([
      { n: 11, kind: "slugged", afterTerms: [{ ...after[1], slug: "workplace-mobbing", formerSlugs: ["mobbing"] }] },
      { n: 12, kind: "slugged", afterTerms: [{ ...after[0], slug: "maltreatment", formerSlugs: ["abuse"] }] },
    ]);
    const result = await runTermSync({ db, client, sets: SETS });
    expect(result).toMatchObject({ through: 11, blocked: { at: 12, code: "slug-in-sets" } });
    expect(findConcept(db, "mobbing").slug).toBe("workplace-mobbing");
    expect(findConcept(db, "human-work:mobbing").slug).toBe("workplace-mobbing");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-mcp-terms-"));
    try {
      const file = path.join(dir, "public.db");
      buildSnapshot(db, { level: "catalogue", notes: false, intro: readIntro("# Work quotes"), collections: {}, sets: [], maps: [] }, file);
      expect((await (await openSnapshot(file)).findConcept("human-work:mobbing")).slug).toBe("workplace-mobbing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls a dry run back", async () => {
    const after = imported();
    const client = await bootstrapped([{ n: 11, kind: "labelled", afterTerms: [{ ...after[1], label: "workplace mobbing" }] }]);
    const result = await runTermSync({ db, client, sets: SETS, apply: false });
    expect(result).toMatchObject({ outcome: "applied", through: 11, lines: ["11 labelled: mobbing"] });
    expect(concept(db, "mobbing").label).toBe("mobbing");
    expect(readCursor(db)!.through).toBe(10);
  });

  it("bootstraps again when terminology-mcp's log changes, reporting with reset", async () => {
    const client = await bootstrapped();
    await reportProgress(client, { log: "log-1", through: 10 });
    client.log = "log-2";
    expect((await runTermSync({ db, client, sets: SETS })).outcome).toBe("rebuilt");
    const again = await runTermSync({ db, client, sets: SETS });
    expect(again).toMatchObject({ outcome: "bootstrapped", log: "log-2", reset: true });
    await reportProgress(client, { log: "log-2", through: 5 });
    expect(client.reports.at(-1)).toMatchObject({ through: 5, reset: true });
  });
});

describe("proposals", () => {
  it("names a quote with the tag as evidence", () => {
    db.prepare("INSERT INTO quote_tags (quote_id, tag, concept_id, origin) VALUES (1, 'conspiracy theory', NULL, 'span')").run();
    const body = proposal(db, "Conspiracy theory", { broader: "abuse" });
    expect(body).toMatchObject({
      scheme: "human-work", label: "Conspiracy theory", broader: "abuse", proposer: "quote-mcp", requestId: "tag:conspiracy theory",
      evidence: { quote: 1, tag: "Conspiracy theory" },
    });
    expect((body.evidence as { text: string }).text.length).toBeGreaterThan(0);
    expect(() => proposal(db, "no such tag")).toThrow(/No quote has the tag/);
  });
});
