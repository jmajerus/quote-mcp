import { describe, expect, it } from "vitest";
import { type ConceptSet, resolveSet } from "../src/sets.js";

// A small scheme: work → stress → burnout, stress related to anxiety, anxiety related to fear, burnout opposite to engagement.
const concept = (slug: string, scheme = "human-work") => ({ slug, scheme, label: slug, alt_labels: [], status: "confirmed", source: null, quotes: 0 });
const pair = (a: string, b: string, there: string, back: string) => [{ from: a, to: b, type: there }, { from: b, to: a, type: back }];
const graph = {
  concepts: ["anxiety", "burnout", "engagement", "fear", "stress", "work"].map((s) => concept(s)).concat(concept("fear", "other")),
  relations: [
    ...pair("work", "stress", "narrower", "broader"), ...pair("stress", "burnout", "narrower", "broader"),
    ...pair("stress", "anxiety", "related", "related"), ...pair("anxiety", "fear", "related", "related"),
    ...pair("burnout", "engagement", "inverse", "inverse"),
  ],
};
const ALL = ["broader", "narrower", "related", "opposite"];
const around = (term: string, depth = 1, types = ALL) => ({ term, depth, types });
const set = (rest: Partial<ConceptSet>): ConceptSet => ({ slug: "s", scheme: "human-work", label: "S", ...rest });

describe("resolving a concept set", () => {
  it("takes listed concepts as they are", () => {
    expect(resolveSet(set({ concepts: ["work", "fear"] }), graph)).toEqual({ members: ["fear", "work"], missing: [] });
  });

  it("steps out from concepts along every relation, or the types asked for", () => {
    expect(resolveSet(set({ around: [around("stress")] }), graph).members).toEqual(["anxiety", "burnout", "stress", "work"]);
    expect(resolveSet(set({ around: [around("stress", 2)] }), graph).members).toEqual(["anxiety", "burnout", "engagement", "fear", "stress", "work"]);
    expect(resolveSet(set({ around: [around("stress", 2, ["related"])] }), graph).members).toEqual(["anxiety", "fear", "stress"]);
    expect(resolveSet(set({ around: [around("burnout", 1, ["opposite"])] }), graph).members).toEqual(["burnout", "engagement"]);
    expect(resolveSet(set({ around: [around("stress", 0)] }), graph).members).toEqual(["stress"]);
  });

  it("takes everything narrower, at any depth, and leaves out exclusions", () => {
    expect(resolveSet(set({ narrower: ["work"] }), graph).members).toEqual(["burnout", "stress"]);
    expect(resolveSet(set({ narrower: ["work"], concepts: ["work", "fear"], exclude: ["stress"] }), graph).members).toEqual(["burnout", "fear", "work"]);
  });

  it("reports slugs the scheme doesn't have, and keeps to its scheme", () => {
    expect(resolveSet(set({ concepts: ["work", "wrok"], exclude: ["nothing"] }), graph)).toEqual({ members: ["work"], missing: ["wrok", "nothing"] });
    expect(resolveSet(set({ scheme: "other", around: [around("fear")] }), graph)).toEqual({ members: ["fear"], missing: [] });
  });
});
