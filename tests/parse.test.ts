import { describe, expect, it } from "vitest";
import { dropCommonUnknowns, suspectTokens } from "../src/ocr.js";
import { parseNote } from "../src/parse.js";

// Real notes from the Business collection (2026-10-27 survey), by Zotero note key.

describe("legacy span", () => {
  it("reads text, page, and title terms (QKHG7Z9G)", () => {
    const p = parseNote(`<p><span class="quote" title="innovation"> "Innovators rarely find support within mainstream organizations, and the same stubbornness that drives them to work on problems others ignore gives them the strength to work alone." (p. 63) </span></p>`, ["innovation"]);
    expect(p).toMatchObject({ kind: "quote", form: "span", grade: "A", locator: { kind: "page", value: "63" }, titleTags: ["innovation"], flags: [] });
    expect(p.text).toBe("Innovators rarely find support within mainstream organizations, and the same stubbornness that drives them to work on problems others ignore gives them the strength to work alone.");
  });

  it("reads a page without a period (7FI2H4AD)", () => {
    const p = parseNote(`<p><span class="quote" title="belonging"> "People want to feel that the parts of their lives fit together well." (p 169) </span></p>`, ["belonging"]);
    expect(p.locator).toMatchObject({ kind: "page", value: "169" });
  });

  it("reads a Kindle location (RH9ZCU4Q)", () => {
    const p = parseNote(`<p><span class="quote" title="mobbing"> "Mobbing is group aggression." (Kindle loc. 208-210) </span></p>`, ["mobbing"]);
    expect(p).toMatchObject({ grade: "B", locator: { kind: "kindle", value: "208–210" }, flags: ["kindle_locator"] });
  });

  it("reads a chapter author after the page (RDW996DR)", () => {
    const p = parseNote(`<p><span class="quote" title="groupthink"> "Jerry Harvey calls this the Abilene Paradox." (p. 209, Richard L. Daft and Robert H. Lengel) </span></p>`, ["groupthink"]);
    expect(p).toMatchObject({ locator: { value: "209" }, chapterAuthor: "Richard L. Daft and Robert H. Lengel", flags: ["chapter_author"] });
  });

  it("is grade A without a locator, keeping inner quotes and emphasis (XM4UMV2H)", () => {
    const p = parseNote(`<p><span class="quote" title="ideology"> "In fact, in the case of hard work ideology, the overeducation effect is actually <em>increasing</em> in strength. That is, overqualified workers are increasingly likely to disavow the "American Dream" of success through hard work alone." </span></p>`, ["ideology"]);
    expect(p).toMatchObject({ grade: "A", flags: ["no_locator"] });
    expect(p.text).toBe(`In fact, in the case of hard work ideology, the overeducation effect is actually *increasing* in strength. That is, overqualified workers are increasingly likely to disavow the "American Dream" of success through hard work alone.`);
  });

  it("reads curly quotation marks (6KN6K6KV)", () => {
    const p = parseNote(`<p><span class="quote" title="competition"> “This false notion suggests that you get better outcomes by eliminating the weaker member of a group. Invoking Darwin to justify cutthroat behaviors is wrong.” </span></p>`, ["competition"]);
    expect(p.text).toMatch(/^This false notion.*is wrong\.$/);
    expect(p.flags).toEqual(["no_locator"]);
  });

  it("accepts a span with no quotation marks at all (52XRHF57)", () => {
    const p = parseNote(`<p><span class="quote" title="group narcissism">Already weakened by environmental forces not facilitative of psychological development.</span></p>`);
    expect(p).toMatchObject({ kind: "quote", form: "span", text: "Already weakened by environmental forces not facilitative of psychological development." });
    expect(p.flags).not.toContain("unbalanced_quotes");
    expect(p.flags).toContain("title_tag_only");
  });

  it("flags a missing opening mark (TH4GC7EJ)", () => {
    const p = parseNote(`<p><span class="quote" title="play"> Any individual or business that wants great success must take the concept of play seriously. Thus a business that regards fun as “unprofessional” stifles the creative and progressive process. That’s like running a highly competitive race with one foot stuck in a bucket.” </span></p>`, ["play"]);
    expect(p.flags).toContain("unbalanced_quotes");
    expect(p.text).toMatch(/^Any individual.*in a bucket\.$/);
    expect(p.commentary).toBeUndefined();
  });

  it("continues the quote into a following list (A8TP3ZSS)", () => {
    const p = parseNote(`<p><span class="quote" title="career"> "I define career as a combination of: </span></p>
<ul>
<li>The particular occupation you choose to pursue</li>
<li>The activities, experience, and knowledge you accumulate" (p. 13)</li>
</ul>
<p>&nbsp;</p>`, ["career"]);
    expect(p).toMatchObject({ grade: "B", locator: { value: "13" } });
    expect(p.flags).toEqual(["list_quote"]);
    expect(p.text).toBe("I define career as a combination of:\n- The particular occupation you choose to pursue\n- The activities, experience, and knowledge you accumulate");
  });

  it("reads nested spans and keeps a list item after the closing mark as commentary (94CIVRFP)", () => {
    const p = parseNote(`<p><span class="quote" title=""><span class="quote" title=""> "Ostracism threatens:</span></span></p>
<ul>
<li>our <em>need to belong</em>...</li>
<li>our <em>need for control</em> over interactions with others.\"</li>
<li>may threaten our <em>need to maintain our belief in a meaningful existence</em>.</li>
</ul>`, ["shunning"]);
    expect(p.grade).toBe("B");
    expect(p.flags).toEqual(expect.arrayContaining(["commentary_mixed", "list_quote", "no_locator"]));
    expect(p.text).toBe("Ostracism threatens:\n- our *need to belong*...\n- our *need for control* over interactions with others.");
    expect(p.commentary).toBe("- may threaten our *need to maintain our belief in a meaningful existence*.");
  });

  it("splits title terms on commas and flags a compound note tag (6JTJMK7Q)", () => {
    const p = parseNote(`<p><span class="quote" title="fear, job loss"> "Work is a basic need, and its threatened loss results in primal fear." </span></p>`, ["fear, job loss"]);
    expect(p.titleTags).toEqual(["fear", "job loss"]);
    expect(p.flags).toContain("compound_tag");
    expect(p.flags).not.toContain("title_tag_only");
  });

  it("doesn't flag a title that's a subset of the note's tags (U8WDIPTV)", () => {
    const p = parseNote(`<p><span class="quote" title="environment"> "Good managers of innovation recognize that they are in primary control over the environment." (p. 105) </span></p>`, ["environment", "innovation"]);
    expect(p).toMatchObject({ grade: "A", flags: [] });
  });
});

describe("escaped span", () => {
  it("decodes the span written out as text (NXASCTAR)", () => {
    const p = parseNote(`<p>&lt;span class="quote" title="craft"&gt;</p>
<p>&nbsp;"W. Edwards Deming asserted that employees are rightfully entitled to the 'pride of workmanship'." (p. 7)</p>
<p>&lt;/span&gt;</p>`, ["craft", "job security"]);
    expect(p).toMatchObject({ kind: "quote", form: "escaped-span", grade: "A", titleTags: ["craft"], locator: { value: "7" } });
    expect(p.text).toBe("W. Edwards Deming asserted that employees are rightfully entitled to the 'pride of workmanship'.");
  });
});

describe("blockquote and typed notes", () => {
  it("reads a blockquote and its cite URL (R2W9ICHT)", () => {
    const p = parseNote(`<blockquote cite="http://www.cnn.com/2012/01/13/living/brian-wilson-creativity/index.html">
<p>"Highly creative people are probably highly creative because of certain cognitive mechanisms,"</p>
</blockquote>`);
    expect(p).toMatchObject({ form: "blockquote", sourceUrl: "http://www.cnn.com/2012/01/13/living/brian-wilson-creativity/index.html", flags: ["no_locator"] });
    expect(p.text).toBe("Highly creative people are probably highly creative because of certain cognitive mechanisms,");
  });

  it("reads a typed note (4P6QI8EP)", () => {
    const p = parseNote(`<p>"There is always an uneasy truce between scientists and salesmen." (p. 78)</p>`);
    expect(p).toMatchObject({ form: "typed", grade: "A", locator: { value: "78" } });
  });

  it("sends a remark before the quote to a person (H65VSST6)", () => {
    const p = parseNote(`<p>Dr. Provinc would most likely agree with me. As he has said already:<br />"Fahions on laughter change, but one thing<br />that stays the same is you can 't laugh at people<br />in power."<br /><br /></p>`);
    expect(p).toMatchObject({ form: "typed", grade: "C", commentary: "Dr. Provinc would most likely agree with me. As he has said already:" });
    expect(p.text).toBe("Fahions on laughter change, but one thing\nthat stays the same is you can 't laugh at people\nin power.");
  });

  it("sends a note with two locators to a person", () => {
    const p = parseNote(`<p>"First quote." (p. 3)</p><p>"Second quote." (p. 9)</p>`);
    expect(p.grade).toBe("C");
  });
});

describe("notes that aren't quotes", () => {
  it.each([
    ["Includes index", `<p>Includes index</p>`],
    ["Originally published", `<p>Originally published: New York : W. Morrow, c1989 Includes index</p>`],
    ["a quoted series statement", `<p>"A Touchstone book." Includes index</p>`],
    ["a contents list", `<p>It's time to evolve -- A new understanding of anxiety -- Living in the gap -- The three faces of anxiety</p>`],
  ])("treats %s as a catalog note", (_, html) => {
    expect(parseNote(html).kind).toBe("catalog");
  });

  it("treats an empty note as empty (34XME77W)", () => {
    expect(parseNote(`<p> </p>`).kind).toBe("empty");
    expect(parseNote("").kind).toBe("empty");
  });

  it("treats a note without quote marks or markup as other", () => {
    expect(parseNote(`<p>Remember to compare this with chapter 4.</p>`).kind).toBe("other");
  });
});

describe("OCR check", () => {
  const dict = new Set(["over", "the", "next", "few", "years", "a", "line", "between", "efforts", "showed", "carefully", "of", "and", "worker", "workers", "involvement", "it", "that", "had", "students", "said"]);

  it("finds inner capitals, confusions, repeats, and stray apostrophes (Q52ET4AG, 264ENPS2)", () => {
    const found = suspectTokens("a line line between; eEorts and worker involvement; later research showod that; carefirlly; ot' self", dict);
    expect(found).toEqual(expect.arrayContaining([
      { token: "line line", reason: "repeated" },
      { token: "eEorts", reason: "inner_capital", suggestion: "efforts" },
      { token: "showod", reason: "confusion", suggestion: "showed" },
      { token: "carefirlly", reason: "confusion", suggestion: "carefully" },
      { token: "ot'", reason: "stray_apostrophe" },
    ]));
  });

  it("passes names, inflections, possessives, and plural apostrophes", () => {
    expect(suspectTokens("Deming said the workers had had the students' years.", dict)).toEqual([]);
  });

  it("drops unknown words that recur across notes", () => {
    const byNote = new Map([
      ["A", [{ token: "overqualified", reason: "unknown" as const }]],
      ["B", [{ token: "overqualified", reason: "unknown" as const }, { token: "narsistic", reason: "unknown" as const }]],
      ["C", [{ token: "Overqualified", reason: "unknown" as const }]],
    ]);
    expect([...dropCommonUnknowns(byNote)]).toEqual([["B", [{ token: "narsistic", reason: "unknown" }]]]);
  });
});

describe("OCR check on real false positives", () => {
  const dict = new Set(["didn't", "and", "life", "work", "are", "the", "truth", "is", "self", "esteem"]);

  it("reads curly contractions and closing single quotes as fine (K5FNDJN6)", () => {
    expect(suspectTokens("didn’t; 'life' and 'work' are; the truth is", dict)).toEqual([]);
  });

  it("still flags an apostrophe with no opening mark (264ENPS2)", () => {
    expect(suspectTokens("aspect ot' self-esteem", dict)).toContainEqual({ token: "ot'", reason: "stray_apostrophe" });
  });
});
