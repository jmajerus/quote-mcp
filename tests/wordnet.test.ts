import { describe, expect, it } from "vitest";
import { wordnetRow } from "../src/web.js";

describe("a concept's WordNet link", () => {
  it("links the word in Open English WordNet, not the old site's dead synset URI", () => {
    const row = wordnetRow("http://purl.org/vocabularies/princeton/wn30/synset-ethical_motive-noun-1.rdf");
    expect(row).toContain('href="https://en-word.net/lemma/ethical%20motive"');
    expect(row).toContain(">ethical motive</a> (noun, sense 1)");
    expect(wordnetRow("http://purl.org/vocabularies/princeton/wn30/synset-caring-adjectivesatellite-1.rdf")).toContain("(adjective, sense 1)");
  });

  it("shows nothing for a value that isn't a synset", () => {
    expect(wordnetRow("NA")).toBe("");
    expect(wordnetRow(null)).toBe("");
  });
});
