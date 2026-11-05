import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import { readIntro } from "../src/intro.js";
import { openSnapshot } from "../src/published-sqlite.js";
import { buildSnapshot } from "../src/snapshot.js";
import { findConcept } from "../src/queries.js";
import { type ConceptSet, currentSets, listSets, setConcepts, setGraph, storedSets } from "../src/sets.js";
import {
  type Change, type Term, type TermSet, type TerminologyClient, TerminologyError, acceptHeldChange, proposal, readCursor, reportProgress, runTermSync,
} from "../src/terminology.js";
import { runImport } from "../src/import.js";
import { drupal, makeStore } from "./fixture.js";
import { importWithSite } from "./seed.js";

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
    importWithSite(db, { drupal, primary: "users/1", sources: ["users/1"] });
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
    expect(() => proposal(db, "conspiracy theory", { quote: 2 })).toThrow(/Quote 2 doesn't have the tag/);
    expect(proposal(db, "conspiracy theory", { quote: 1 })).toMatchObject({ evidence: { quote: 1 } });
  });
});

describe("concept sets from terminology-mcp", () => {
  const ALL = ["broader", "narrower", "related", "opposite"];
  const recipe = (rest: Record<string, unknown>) => ({ concepts: [], narrower: [], around: [], exclude: [], ...rest });
  const set = (id: string, slug: string, rest: Partial<TermSet> = {}): TermSet => ({ id, scheme: "human-work", slug, label: slug, description: "", kind: "theme", ordered: false, members: [], ...rest });
  const harm = set("s_harm", "harm", { recipe: recipe({ around: [{ term: "t_abuse", depth: 1, types: ALL }] }) });
  const members = (slug: string) => setConcepts(db, [], slug).slugs;
  const slugs = () => storedSets(db).map((s) => s.slug);

  it("applies set-added, set-changed, and set-deleted, keyed on the id, and keeps a former slug", async () => {
    const client = await bootstrapped([
      { n: 11, kind: "set-added", afterSets: [harm] },
      { n: 12, kind: "set-changed", afterSets: [{ ...harm, slug: "harms", label: "Harms" }] },
    ]);
    const result = await runTermSync({ db, client, sets: SETS });
    expect(result).toMatchObject({ outcome: "applied", through: 12 });
    expect(result.lines).toEqual(["11 set-added: set harm", "12 set-changed: set harms"]);
    expect(slugs()).toEqual(["harms"]);
    expect(setGraph(db, [], "harm")).toMatchObject({ slug: "harms", label: "Harms" });
    client.list = [...client.list, { n: 13, kind: "set-deleted", afterSets: [{ ...harm, slug: "harms", deleted: true }] },
      { n: 14, kind: "set-added", afterSets: [set("s_new", "harms", { members: ["t_dignity"] })] }];
    await runTermSync({ db, client, sets: SETS });
    expect(storedSets(db).map((s) => s.formerSlugs)).toEqual([[]]);
    expect(members("harms")).toEqual(["dignity"]);
    expect(() => setGraph(db, [], "harm")).toThrow(/No concept set "harm"/);
  });

  it("takes sets from afterSets on any kind, and doesn't read a term in after as a set", async () => {
    const after = imported();
    const client = await bootstrapped([
      { n: 11, kind: "set-added", afterSets: [set("s_list", "list", { members: ["t_abuse"] }), set("s_two", "two", { members: ["t_dignity"] })] },
      // A term edit that changes only its explicit membership: the term is in before and after.
      { n: 12, kind: "set-changed", after: { ...after[0], label: "not applied from here" }, afterSets: [set("s_list", "list", { members: ["t_abuse", "t_mobbing"] })] },
      { n: 13, kind: "updated", afterTerms: [{ ...after[2], label: "worth" }], afterSets: [set("s_two", "two", { members: ["t_dignity", "t_abuse"] })] },
    ]);
    await runTermSync({ db, client, sets: SETS });
    expect(members("list")).toEqual(["abuse", "mobbing"]);
    expect(members("two")).toEqual(["abuse", "dignity"]);
    expect(concept(db, "abuse").label).toBe("abuse");
    expect(concept(db, "dignity").label).toBe("worth");
  });

  it("leaves out another scheme's sets", async () => {
    const client = await bootstrapped([{ n: 11, kind: "set-added", afterSets: [harm, set("s_other", "other", { scheme: "cc-subjects" })] }]);
    await runTermSync({ db, client, sets: SETS });
    expect(slugs()).toEqual(["harm"]);
  });

  it("takes sets from a scheme-changed, whose own payload is ignored", async () => {
    const client = await bootstrapped([{ n: 11, kind: "scheme-changed", after: { id: "human-work", label: "not a term" }, afterSets: [harm] } as Change]);
    expect(await runTermSync({ db, client, sets: SETS })).toMatchObject({ outcome: "applied", through: 11, blocked: null });
    expect(slugs()).toEqual(["harm"]);
    expect(concept(db, "abuse").label).toBe("abuse");
  });

  it("keeps an ordered set's order and says it's ordered, on the server and in the public snapshot", async () => {
    const client = await bootstrapped([{ n: 11, kind: "set-added", afterSets: [set("s_path", "path", { ordered: true, members: ["t_mobbing", "t_abuse", "t_dignity"] })] }]);
    await runTermSync({ db, client, sets: SETS });
    const order = ["mobbing", "abuse", "dignity"];
    const here = setGraph(db, [], "path");
    expect(here.concepts.map((c) => c.slug)).toEqual(order);
    expect(here.definition.ordered).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-mcp-sets-"));
    try {
      const file = path.join(dir, "public.db");
      buildSnapshot(db, { level: "catalogue", notes: false, intro: readIntro("# Work quotes"), collections: {}, sets: [], maps: [] }, file);
      const { set: there } = await (await openSnapshot(file)).set("path");
      expect(there.concepts.map((c) => c.slug)).toEqual(order);
      expect(there.definition).toMatchObject({ ordered: true, members: order });
      expect(there.definition).not.toHaveProperty("order");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works a recipe out as terminology-mcp does, against the store as it is now", async () => {
    const after = imported();
    const client = await bootstrapped([
      { n: 11, kind: "set-added", afterSets: [
        harm,
        set("s_rel", "rel", { recipe: recipe({ around: [{ term: "t_abuse", depth: 1, types: ["opposite"] }] }) }),
        set("s_zero", "zero", { recipe: recipe({ around: [{ term: "t_abuse", depth: 0, types: ALL }] }) }),
        set("s_below", "below", { recipe: recipe({ narrower: ["t_abuse"] }) }),
        set("s_excl", "excl", { recipe: recipe({ around: [{ term: "t_abuse", depth: 1, types: ALL }], exclude: ["t_abuse"] }) }),
      ] },
    ]);
    await runTermSync({ db, client, sets: SETS });
    expect(members("harm")).toEqual(["abuse", "dignity", "mobbing"]);
    expect(members("rel")).toEqual(["abuse", "dignity"]);
    expect(members("zero")).toEqual(["abuse"]);
    expect(members("below")).toEqual(["mobbing"]);
    expect(members("excl")).toEqual(["dignity", "mobbing"]);
    // A concept added later joins without a set-changed; a retired one drops out and shows as missing.
    client.list = [...client.list, { n: 12, kind: "added", after: { ...after[0], id: "t_new", slug: "newcomer", label: "newcomer", broader: ["t_abuse"], relations: [], aliases: [] } }];
    await runTermSync({ db, client, sets: SETS });
    expect(members("below")).toEqual(["mobbing", "newcomer"]);
    client.list = [...client.list, { n: 13, kind: "retired", afterTerms: [{ ...after[1], status: "retired", replacedBy: ["t_abuse"] }] }];
    await runTermSync({ db, client, sets: SETS });
    expect(members("below")).toEqual(["newcomer"]);
    const list = [{ n: 14, kind: "set-added", afterSets: [set("s_gone", "gone", { members: ["t_mobbing", "t_abuse", "t_elsewhere"] })] }];
    client.list = [...client.list, ...list];
    await runTermSync({ db, client, sets: SETS });
    expect(listSets(db).find((s) => s.slug === "gone")).toMatchObject({ concepts: 1, missing: ["mobbing", "t_elsewhere"] });
  });

  it("expands nested and ordered explicit sets, and survives a loop", async () => {
    const client = await bootstrapped([{ n: 11, kind: "set-added", afterSets: [
      set("s_inner", "inner", { recipe: recipe({ narrower: ["t_abuse"] }) }),
      set("s_outer", "outer", { ordered: true, members: ["t_dignity", "s_inner", "t_abuse"] }),
      set("s_a", "loop-a", { members: ["s_b", "t_abuse"] }),
      set("s_b", "loop-b", { members: ["s_a", "t_dignity"] }),
    ] }]);
    await runTermSync({ db, client, sets: SETS });
    expect(members("outer")).toEqual(["dignity", "mobbing", "abuse"]);
    expect(setGraph(db, [], "outer").concepts.map((c) => c.slug)).toEqual(["dignity", "mobbing", "abuse"]);
    expect(setGraph(db, [], "outer").definition.members).toEqual(["dignity", "inner", "abuse"]);
    expect(members("loop-a")).toEqual(["abuse", "dignity"]);
  });

  it("uses the store's sets once it has any, the file's until then, and counts their quotes", async () => {
    const client = await bootstrapped([{ n: 11, kind: "set-added", afterSets: [harm] }]);
    expect(currentSets(db, SETS)).toEqual(SETS);
    await runTermSync({ db, client, sets: SETS });
    expect(currentSets(db, SETS).map((s) => s.slug)).toEqual(["harm"]);
    expect(listSets(db, SETS)).toMatchObject([{ slug: "harm", concepts: 3 }]);
    expect(listSets(db, SETS)[0].quotes).toBeGreaterThan(0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-mcp-sets-"));
    try {
      const file = path.join(dir, "public.db");
      buildSnapshot(db, { level: "catalogue", notes: false, intro: readIntro("# Work quotes"), collections: {}, sets: [{ slug: "file-set", scheme: "human-work", label: "File", concepts: ["abuse"] }], maps: [] }, file);
      const site = await openSnapshot(file);
      expect((await site.sets()).map((s) => s.slug)).toEqual(["harm"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds on slug-in-sets only while the file is in effect", async () => {
    const after = imported();
    const client = await bootstrapped([
      { n: 11, kind: "set-added", afterSets: [harm] },
      { n: 12, kind: "slugged", afterTerms: [{ ...after[0], slug: "maltreatment", formerSlugs: ["abuse"] }] },
    ]);
    const result = await runTermSync({ db, client, sets: SETS });
    expect(result).toMatchObject({ outcome: "applied", through: 12 });
    expect(members("harm")).toEqual(["dignity", "maltreatment", "mobbing"]);
  });

  it("bootstraps a store's sets from the state", async () => {
    const client = server(imported());
    client.state = async () => ({ log: client.log, version: 10, terms: imported(), sets: [harm, set("s_x", "elsewhere", { scheme: "cc-subjects" })] });
    await runTermSync({ db, client, sets: SETS });
    expect(slugs()).toEqual(["harm"]);
  });

  describe("the backfill, for a store already following when this build arrived", () => {
    const SEEDED = "terminology:human-work:sets-seeded";
    const following = async () => {
      const client = await bootstrapped();
      db.prepare("DELETE FROM meta WHERE key = ?").run(SEEDED);
      return client;
    };

    it("takes the sets a change it passed carried, once, and counts as applied", async () => {
      const client = await following();
      let reads = 0;
      client.state = async () => { reads++; return { log: client.log, version: 10, terms: imported(), sets: [harm] }; };
      const dry = await runTermSync({ db, client, sets: SETS, apply: false });
      expect(dry.lines).toEqual(["set harm, from the state"]);
      expect(slugs()).toEqual([]);
      const first = await runTermSync({ db, client, sets: SETS });
      expect(first).toMatchObject({ outcome: "applied", through: 10 });
      expect(slugs()).toEqual(["harm"]);
      const before = reads;
      expect((await runTermSync({ db, client, sets: SETS })).outcome).toBe("current");
      expect(reads).toBe(before);
    });

    it("waits until the state is at the cursor, and past a failed read", async () => {
      const client = await following();
      client.state = async () => ({ log: client.log, version: 11, terms: imported(), sets: [harm] });
      expect((await runTermSync({ db, client, sets: SETS })).outcome).toBe("current");
      expect(slugs()).toEqual([]);
      client.state = async () => { throw new TerminologyError(0, "unreachable"); };
      expect((await runTermSync({ db, client, sets: SETS })).outcome).toBe("current");
      client.state = async () => ({ log: client.log, version: 10, terms: imported(), sets: [harm] });
      await runTermSync({ db, client, sets: SETS });
      expect(slugs()).toEqual(["harm"]);
    });

    it("waits past a hold", async () => {
      const after = imported();
      const client = await following();
      client.state = async () => ({ log: client.log, version: 12, terms: imported(), sets: [harm] });
      client.list = [{ n: 11, kind: "split", afterTerms: [{ ...after[1], status: "retired", replacedBy: ["t_a", "t_b"] }] }];
      expect((await runTermSync({ db, client, sets: SETS })).blocked).toMatchObject({ at: 11 });
      expect(slugs()).toEqual([]);
    });
  });

  it("applies a held change's sets when it's accepted", async () => {
    const after = imported();
    const client = await bootstrapped([{ n: 11, kind: "split", afterTerms: [{ ...after[1], status: "retired", replacedBy: ["t_a", "t_b"] }], afterSets: [harm] }]);
    await runTermSync({ db, client, sets: SETS });
    await acceptHeldChange({ db, client, n: 11 });
    expect(slugs()).toEqual(["harm"]);
  });
});

describe("a link to a term in another scheme", () => {
  it("is skipped for related and opposite, and still holds for broader", async () => {
    const after = imported();
    const client = await bootstrapped([{ n: 11, kind: "updated", afterTerms: [{ ...after[2], relations: [...after[2].relations!, { type: "related", target: "t_foreign" }] }] }]);
    expect(await runTermSync({ db, client, sets: SETS })).toMatchObject({ outcome: "applied", through: 11 });
    expect(relations(db)).not.toContainEqual(expect.stringContaining("foreign"));
    client.list = [...client.list, { n: 12, kind: "updated", afterTerms: [{ ...after[2], broader: ["t_foreign"] }] }];
    expect((await runTermSync({ db, client, sets: SETS })).blocked).toMatchObject({ at: 12, code: "unknown-term" });
  });

  it("doesn't show as a change in a bootstrap", async () => {
    const terms = imported();
    terms[2].relations = [...terms[2].relations!, { type: "related", target: "t_foreign" }];
    const result = await runTermSync({ db, client: server(terms), sets: SETS, apply: false });
    expect(result.lines.join("\n")).not.toContain("undefined");
  });
});
