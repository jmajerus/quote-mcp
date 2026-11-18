import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import { getConcept } from "../src/queries.js";
import { renderAdmin, wordnetRow } from "../src/web.js";
import { type Synset, type WordnetLookup, refreshSynsets, senseKey, synsetFrom, synsetQuery } from "../src/wordnet.js";
import { makeStore } from "./fixture.js";

const PURL = "http://purl.org/vocabularies/princeton/wn30/synset-";
const GRAPH = "urn:wordnet:graph:oewn-2025";
const ANGER: Synset = {
  uri: `${PURL}anger-noun-1.rdf`, id: "oewn-07531593-n", edition: "oewn-2025", pos: "noun",
  definition: "a strong emotion; a feeling that is oriented toward some real or supposed grievance",
  words: ["anger", "choler", "ire"], broader: [{ id: "oewn-07495208-n", words: ["emotion"] }], at: "2026-11-18T00:00:00Z",
};

describe("a concept's WordNet link", () => {
  it("names the WordNet 3.0 sense an old-site link points at, in WordNet's lower case", () => {
    expect(senseKey(`${PURL}ethical_motive-noun-1.rdf`)).toBe("ethical_motive-noun-1");
    expect(senseKey(`${PURL}Schadenfreude-noun-1.rdf`)).toBe("schadenfreude-noun-1");
    expect(senseKey(`${PURL}caring-adjectivesatellite-1.rdf`)).toBe("caring-adjectivesatellite-1");
    expect(senseKey("NA")).toBeNull();
  });

  it("queries by sense name for an old-site link, by synset for an Open English WordNet one, and not at all otherwise", () => {
    expect(synsetQuery(`${PURL}anger-noun-1.rdf`, GRAPH)).toContain('<urn:wordnet:pwn30-sense> "anger-noun-1"');
    expect(synsetQuery("https://en-word.net/id/oewn-07531593-n", GRAPH)).toContain("BIND(<https://en-word.net/id/oewn-07531593-n> AS ?synset)");
    expect(synsetQuery("https://en-word.net/id/x> } DROP ALL #", GRAPH)).toBeNull();
    expect(synsetQuery("NA", GRAPH)).toBeNull();
  });

  it("folds the server's rows into one synset with its words and broader synsets", () => {
    const v = (value: string) => ({ value });
    const base = { synset: v("https://en-word.net/id/oewn-07531593-n"), pos: v("https://globalwordnet.github.io/schemas/wn#noun"), def: v(ANGER.definition!) };
    const s = synsetFrom(ANGER.uri, GRAPH, [
      { ...base, word: v("ire") }, { ...base, word: v("anger") }, { ...base, word: v("choler") },
      { ...base, broader: v("https://en-word.net/id/oewn-07495208-n"), broaderWord: v("emotion") },
    ], ANGER.at);
    expect(s).toEqual(ANGER);
    expect(synsetFrom(ANGER.uri, GRAPH, [], ANGER.at)).toEqual({ uri: ANGER.uri, id: null, edition: "oewn-2025", at: ANGER.at });
  });
});

describe("keeping concepts' synsets", () => {
  let db: DB;
  let asked: string[];
  const lookup: WordnetLookup = async (uri) => {
    asked.push(uri);
    return uri === ANGER.uri ? ANGER : { uri, id: null, edition: "oewn-2025", at: ANGER.at };
  };
  const conceptWith = (uri: string | null) => {
    const id = db.prepare("SELECT id FROM concepts ORDER BY id LIMIT 1").pluck().get() as number;
    db.prepare("UPDATE concepts SET close_match = ? WHERE id = ?").run(uri, id);
    db.prepare("UPDATE concepts SET close_match = NULL, synset = NULL WHERE id != ?").run(id);
    return id;
  };
  const synsetOf = (id: number) => db.prepare("SELECT synset FROM concepts WHERE id = ?").pluck().get(id) as string | null;

  beforeEach(() => {
    db = makeStore();
    asked = [];
  });

  it("looks up a new link once, then again only when the link changes, and clears it when the link goes", async () => {
    const id = conceptWith(ANGER.uri);
    expect(await refreshSynsets(db, lookup, GRAPH)).toBe(1);
    expect(JSON.parse(synsetOf(id)!)).toEqual(ANGER);
    expect(await refreshSynsets(db, lookup, GRAPH)).toBe(0);
    expect(asked).toEqual([ANGER.uri]);
    db.prepare("UPDATE concepts SET close_match = ? WHERE id = ?").run(`${PURL}anger-noun-2.rdf`, id);
    expect(await refreshSynsets(db, lookup, GRAPH)).toBe(1);
    expect(JSON.parse(synsetOf(id)!)).toMatchObject({ uri: `${PURL}anger-noun-2.rdf`, id: null });
    db.prepare("UPDATE concepts SET close_match = 'NA' WHERE id = ?").run(id);
    expect(await refreshSynsets(db, lookup, GRAPH)).toBe(1);
    expect(synsetOf(id)).toBeNull();
  });

  it("looks a link up again for a new edition", async () => {
    conceptWith(ANGER.uri);
    await refreshSynsets(db, lookup, GRAPH);
    await refreshSynsets(db, lookup, "urn:wordnet:graph:oewn-2026");
    expect(asked).toEqual([ANGER.uri, ANGER.uri]);
  });

  it("keeps what it has when the server can't be reached", async () => {
    const id = conceptWith(ANGER.uri);
    await refreshSynsets(db, lookup, GRAPH);
    db.prepare("UPDATE concepts SET close_match = ? WHERE id = ?").run(`${PURL}ire-noun-1.rdf`, id);
    await expect(refreshSynsets(db, async () => { throw new Error("unreachable"); }, GRAPH)).rejects.toThrow("unreachable");
    expect(JSON.parse(synsetOf(id)!)).toEqual(ANGER);
  });

  it("shows the synset on the concept page and in get_concept", async () => {
    const id = conceptWith(ANGER.uri);
    await refreshSynsets(db, lookup, GRAPH);
    const slug = db.prepare("SELECT slug FROM concepts WHERE id = ?").pluck().get(id) as string;
    expect(getConcept(db, slug)).toMatchObject({ wordnet: ANGER.uri, synset: { id: "oewn-07531593-n" } });
    const page = renderAdmin(db, `/admin/concepts/${slug}`, new URLSearchParams());
    expect(page).toContain('<a href="https://en-word.net/id/oewn-07531593-n"');
    expect(page).toContain(">anger, choler, ire</a> (noun): a strong emotion");
    expect(page).toContain('<tr><th>WordNet broader</th><td><a href="https://en-word.net/id/oewn-07495208-n">emotion</a></td></tr>');
  });
});

describe("the WordNet row before a synset is fetched", () => {
  it("links the word in Open English WordNet, not the old site's dead synset URI", () => {
    const row = wordnetRow(`${PURL}ethical_motive-noun-1.rdf`);
    expect(row).toContain('href="https://en-word.net/lemma/ethical%20motive"');
    expect(row).toContain(">ethical motive</a> (noun, sense 1)");
    expect(wordnetRow(`${PURL}caring-adjectivesatellite-1.rdf`)).toContain("(adjective, sense 1)");
  });

  it("says when WordNet has nothing for the link, and shows nothing for a value that isn't a link", () => {
    const uri = `${PURL}expendable-noun-1.rdf`;
    expect(wordnetRow(uri, { uri, id: null, edition: "oewn-2025", at: ANGER.at })).toContain("Not found in WordNet (expendable-noun-1)");
    expect(wordnetRow("NA")).toBe("");
    expect(wordnetRow(null)).toBe("");
  });
});
