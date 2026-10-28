import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type ConceptSet, loadSets, resolveSet } from "../src/sets.js";

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
const set = (rest: Partial<ConceptSet>): ConceptSet => ({ slug: "s", scheme: "human-work", label: "S", ...rest });

describe("resolving a concept set", () => {
  it("takes listed concepts as they are", () => {
    expect(resolveSet(set({ concepts: ["work", "fear"] }), graph)).toEqual({ members: ["fear", "work"], missing: [] });
  });

  it("steps out from concepts along every relation, or the types asked for", () => {
    expect(resolveSet(set({ around: ["stress"] }), graph).members).toEqual(["anxiety", "burnout", "stress", "work"]);
    expect(resolveSet(set({ around: ["stress"], depth: 2 }), graph).members).toEqual(["anxiety", "burnout", "engagement", "fear", "stress", "work"]);
    expect(resolveSet(set({ around: ["stress"], depth: 2, types: ["related"] }), graph).members).toEqual(["anxiety", "fear", "stress"]);
    expect(resolveSet(set({ around: ["burnout"], types: ["opposite"] }), graph).members).toEqual(["burnout", "engagement"]);
    expect(resolveSet(set({ around: ["stress"], depth: 0 }), graph).members).toEqual(["stress"]);
  });

  it("takes everything narrower, at any depth, and leaves out exclusions", () => {
    expect(resolveSet(set({ narrower: ["work"] }), graph).members).toEqual(["burnout", "stress", "work"]);
    expect(resolveSet(set({ narrower: ["work"], concepts: ["fear"], exclude: ["stress"] }), graph).members).toEqual(["burnout", "fear", "work"]);
  });

  it("reports slugs the scheme doesn't have, and keeps to its scheme", () => {
    expect(resolveSet(set({ concepts: ["work", "wrok"], exclude: ["nothing"] }), graph)).toEqual({ members: ["work"], missing: ["wrok", "nothing"] });
    expect(resolveSet(set({ scheme: "other", around: ["fear"] }), graph)).toEqual({ members: ["fear"], missing: [] });
  });
});

describe("loading concept sets", () => {
  const write = (value: unknown) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "quote-sets-")), "sets.json");
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };

  it("reads a valid file", () => {
    expect(loadSets(write({ sets: [{ slug: "a", scheme: "human-work", label: "A", around: ["stress"], depth: 2, types: ["related"] }] }))).toHaveLength(1);
  });

  it("refuses a malformed one, saying what's wrong", () => {
    expect(() => loadSets(write("{"))).toThrow(/Cannot read the concept sets/);
    expect(() => loadSets(write({ sets: [{ slug: "a", scheme: "human-work", label: "A" }] }))).toThrow(/needs concepts, around, or narrower/);
    expect(() => loadSets(write({ sets: [{ slug: "a", scheme: "human-work", label: "A", concepts: ["x"], depth: 2 }] }))).toThrow(/depth and types go with around/);
    expect(() => loadSets(write({ sets: [{ slug: "a", scheme: "human-work", label: "A", around: ["x"], types: ["inverse"] }] }))).toThrow(/sets\.0\.types\.0/);
    expect(() => loadSets(write({ sets: [{ slug: "A b", scheme: "human-work", label: "A", concepts: ["x"] }] }))).toThrow(/a slug/);
    expect(() => loadSets(write({ sets: [{ slug: "a", scheme: "human-work", label: "A", concepts: ["x"], colour: "red" }] }))).toThrow(/colour/);
    const twice = { slug: "a", scheme: "human-work", label: "A", concepts: ["x"] };
    expect(() => loadSets(write({ sets: [twice, twice] }))).toThrow(/"a" twice/);
  });

  it("finds the checkout's own sets well formed", () => {
    expect(loadSets(path.join(import.meta.dirname, "..", "vocab", "sets.json")).length).toBeGreaterThan(0);
  });
});
