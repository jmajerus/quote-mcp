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

  it("flags double marks inside a quote, keeping the note's words as they are (XM4UMV2H)", () => {
    const p = parseNote(`<p><span class="quote" title="ideology"> "In fact, the effect is actually <em>increasing</em> in strength, as workers disavow the "American Dream" of success." </span></p>`, ["ideology"]);
    expect(p.flags).toContain("unbalanced_quotes");
    expect(p.text).toBe(`"In fact, the effect is actually *increasing* in strength, as workers disavow the "American Dream" of success."`);
  });

  it("keeps single marks as content", () => {
    const p = parseNote(`<p><span class="quote"> "He called it the 'bureaucratic burden' and that's that." (p. 3)</span></p>`);
    expect(p).toMatchObject({ text: "He called it the 'bureaucratic burden' and that's that.", grade: "A" });
    expect(p.locator?.value).toBe("3");
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

  it("flags a missing opening mark, keeping the closing one (TH4GC7EJ)", () => {
    const p = parseNote(`<p><span class="quote" title="play"> Any individual or business that wants great success must take play seriously. That’s like running a race with one foot stuck in a bucket.” </span></p>`, ["play"]);
    expect(p.flags).toContain("unbalanced_quotes");
    expect(p.text).toMatch(/^Any individual.*in a bucket\.”$/);
    expect(p.commentary).toBeUndefined();
  });

  it("splits passages that each end in a page (#89)", () => {
    const p = parseNote(`<span class="quote" title="conflict">\n"For instance, conflicts are about <em>controlling your destiny</em>, or feelings of powerlessness." (p. 224)\n"A second hidden source of conflict are <em>affronts to our self-esteem</em>, that we are unappreciated." (p. 225)\n</span>`);
    expect(p.problems).toEqual([]);
    expect(p).toMatchObject({ text: "For instance, conflicts are about *controlling your destiny*, or feelings of powerlessness.", grade: "B" });
    expect(p.locator?.value).toBe("224");
    expect(p.more).toHaveLength(1);
    expect(p.more?.[0].text).toBe("A second hidden source of conflict are *affronts to our self-esteem*, that we are unappreciated.");
    expect(p.more?.[0].locator?.value).toBe("225");
  });

  it("splits pages that run backwards as they stand (#318)", () => {
    const p = parseNote(`<span class="quote">"First passage here." (p. 158)\n"Second passage here." (p. 122)</span>`);
    expect([p.locator?.value, p.more?.[0].locator?.value]).toEqual(["158", "122"]);
  });

  it("takes a page typed inside the closing mark (#132, #469)", () => {
    const p = parseNote(`<span class="quote">\n"<em>In organizational totalitarianism the ideal is proclaimed.</em> (p. 24)"\n</span>`);
    expect(p.text).toBe("*In organizational totalitarianism the ideal is proclaimed.*");
    expect(p.locator?.value).toBe("24");
    expect(p.flags).not.toContain("unbalanced_quotes");
  });

  it("takes a page with no parentheses, or a comma for the full stop (#302, #338)", () => {
    expect(parseNote(`<span class="quote">"A better way of doing things." p. 222</span>`)).toMatchObject({ text: "A better way of doing things.", commentary: undefined, locator: { value: "222" } });
    expect(parseNote(`<span class="quote">"Even panic attacks." (p, 40)</span>`)).toMatchObject({ text: "Even panic attacks.", commentary: undefined, locator: { value: "40" } });
  });

  it("keeps emphasis that closes outside the mark in the text (#155)", () => {
    const p = parseNote(`<span class="quote">"He used the analogy.\n\n<cite>Among coyotes, I never got the support I needed."</cite> (p. 34)</span>`);
    expect(p.text).toBe("He used the analogy.\n*Among coyotes, I never got the support I needed.*");
    expect(p.commentary).toBeUndefined();
    expect(p.locator?.value).toBe("34");
  });

  it("makes words after the page a comment (#148, #351)", () => {
    const p = parseNote(`<span class="quote">"The cause may be permanent." (p. 115)\n\nCompare with Collis [bib]Collis1997[/bib]: "The right person, continuously."</span>`);
    expect(p).toMatchObject({ text: "The cause may be permanent.", commentary: `Compare with Collis [bib]Collis1997[/bib]: "The right person, continuously."`, locator: { value: "115" } });
    expect(p.flags).toContain("commentary_mixed");
    expect(p.more).toBeUndefined();
  });

  it("makes words before the opening mark a comment, and flags them (#53, #345)", () => {
    const p = parseNote(`<span class="quote">As DeMarco and Lister [12] argue,\n"There is nothing more discouraging to any worker." (p. 62)</span>`);
    expect(p).toMatchObject({ text: "There is nothing more discouraging to any worker.", commentary: "As DeMarco and Lister [12] argue,", locator: { value: "62" } });
    expect(p.flags).toContain("lead_in");
    const q = parseNote(`<span class="quote"><strong>The Seven Deadly Diseases</strong>\n"3. Evaluation by performance." (p.36)\nSee also in particular: [bib]Deming1982[/bib]</span>`);
    expect(q.text).toBe("3. Evaluation by performance.");
    expect(q.locator?.value).toBe("36");
    expect(q.commentary).toMatch(/The Seven Deadly Diseases[^]*See also in particular: \[bib\]Deming1982\[\/bib\]$/);
  });

  it("keeps an opening mark with no closing mark, flagged (#243)", () => {
    const p = parseNote(`<span class="quote">"Getting cooperation has always been a challenge.[fn]Compare Fisher.[/fn]</span>`);
    expect(p.text).toBe(`"Getting cooperation has always been a challenge.[fn]Compare Fisher.[/fn]`);
    expect(p.flags).toContain("unbalanced_quotes");
  });

  it("keeps a closing mark with no opening mark, with its page, flagged (#45)", () => {
    const p = parseNote(`<span class="quote">The sheer size requires something more than 'thriving on chaos.'" (p. 33)</span>`);
    expect(p.text).toBe(`The sheer size requires something more than 'thriving on chaos.'"`);
    expect(p.locator?.value).toBe("33");
    expect(p.flags).toContain("unbalanced_quotes");
  });

  it("keeps a note with no marks of its own whole, when marks only set off a phrase mid-sentence (#28)", () => {
    const p = parseNote(`<span class="quote">Group relationships satisfy needs. Scott Peck explains that they are "onto something" in all this, he says.</span>`);
    expect(p.text).toBe(`Group relationships satisfy needs. Scott Peck explains that they are "onto something" in all this, he says.`);
    expect(p.flags).toContain("no_marks");
    expect(parseNote(`<span class="quote">No marks at all here. (p. 9)</span>`)).toMatchObject({ text: "No marks at all here.", locator: { value: "9" }, flags: expect.arrayContaining(["no_marks"]) });
  });

  it("takes a page as an implicit closing mark, and flags the missing mark", () => {
    const p = parseNote(`<span class="quote">"Because the quotation provides such a memorable source. (p. 121)</span>`);
    expect(p).toMatchObject({ text: "Because the quotation provides such a memorable source.", locator: { value: "121" } });
    expect(p.flags).toContain("unbalanced_quotes");
  });

  it("splits passages when a page stands in for a closing mark, and flags that one", () => {
    const p = parseNote(`<span class="quote">"The first passage, unclosed. (p. 3)\n"The second passage." (p. 9)</span>`);
    expect([p.text, p.locator?.value, p.more?.[0].text, p.more?.[0].locator?.value]).toEqual(["The first passage, unclosed.", "3", "The second passage.", "9"]);
    expect(p.flags).toContain("unbalanced_quotes");
    expect(p.more?.[0].flags).not.toContain("unbalanced_quotes");
  });

  it("keeps a page after words that follow the closing mark, which are a comment (#374)", () => {
    const p = parseNote(`<span class="quote">"A third group manifested itself physically." --Roy R. Male (p. 334)</span>`);
    expect(p).toMatchObject({ text: "A third group manifested itself physically.", commentary: "--Roy R. Male", locator: { value: "334" } });
    expect(p.flags).not.toContain("unbalanced_quotes");
  });

  it("doesn't take a phrase in mid-sentence for the quote, when the note ends in a page (#28)", () => {
    const p = parseNote(`<span class="quote">Scott Peck explains that they are "onto something" in all this. (p. 12)</span>`);
    expect(p).toMatchObject({ text: `Scott Peck explains that they are "onto something" in all this.`, locator: { value: "12" } });
    expect(p.flags).toContain("no_marks");
  });

  it("flags a note with no marks that ends in a page, keeping the page", () => {
    expect(parseNote(`<span class="quote">No marks at all here. (p. 9)</span>`).flags).toContain("no_marks");
  });

  it("closes emphasis around the marks on the words, not the remark after them (#315)", () => {
    const p = parseNote(`<span class="quote"><em>"Good name in man and woman." (III, iii)</em></span>`);
    expect(p).toMatchObject({ text: "*Good name in man and woman.*", commentary: "(III, iii)" });
  });

  it("splits quotes grouped under a concept with no pages (#752)", () => {
    const p = parseNote(`<span class="quote" title="psychic vampirism">"The vampire lives on."\n\n"I suppose it is thus."</span>`);
    expect([p.text, p.more?.[0].text]).toEqual(["The vampire lives on.", "I suppose it is thus."]);
    expect([p.locator, p.more?.[0].locator]).toEqual([undefined, undefined]);
    expect(p.titleTags).toEqual(["psychic vampirism"]);
    expect(p.more?.[0].titleTags).toEqual(["psychic vampirism"]);
  });

  it("gives a page only to the quote it follows, in a concept group", () => {
    const p = parseNote(`<span class="quote">"One without a page."\n"One with a page." (p. 5)</span>`);
    expect([p.text, p.locator?.value, p.more?.[0].text, p.more?.[0].locator?.value]).toEqual(["One without a page.", undefined, "One with a page.", "5"]);
  });

  it("splits a quote after the last page, with no page of its own (#342)", () => {
    const p = parseNote(`<span class="quote">"Every employee is family." (p. 165)\n"The right person, continuously." ([bib]Deming1982[/bib], p. 115)</span>`);
    expect(p).toMatchObject({ text: "Every employee is family.", locator: { value: "165" } });
    expect(p.more?.[0]).toMatchObject({ text: "The right person, continuously.", commentary: "([bib]Deming1982[/bib], p. 115)" });
  });

  it("keeps each span's concepts and page with its own quote (#353)", () => {
    const p = parseNote(`<p><span class="quote" title="disability"> "Stress is the biggest reason for disability claims." </span> <span class="quote" title="stress"> "Employees with stress had higher costs." (p. 15) </span></p>`, ["disability", "stress"]);
    expect(p).toMatchObject({ text: "Stress is the biggest reason for disability claims.", titleTags: ["disability"], locator: undefined });
    expect(p.more?.[0]).toMatchObject({ text: "Employees with stress had higher costs.", titleTags: ["stress"], locator: { value: "15" } });
    expect(p.problems).toEqual([]);
  });

  it("gives every passage in one span that span's concepts (#490)", () => {
    const p = parseNote(`<span class="quote" title="power, control">"First passage." (p. 394)\n"Second passage." (p. 395)</span>`);
    expect(p.titleTags).toEqual(["power", "control"]);
    expect(p.more?.[0].titleTags).toEqual(["power", "control"]);
  });

  it("holds a page inside a quote that doesn't close, as it stands", () => {
    const p = parseNote(`<span class="quote">"First passage, unclosed. (p. 3) and on. (p. 4) then." (p. 9)</span>`);
    expect(p.grade).toBe("C");
    expect(p.locator).toBeUndefined();
    expect(p.text).toBe(`"First passage, unclosed. (p. 3) and on. (p. 4) then." (p. 9)`);
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

  it("makes a remark before the quote a comment, and flags it (H65VSST6)", () => {
    const p = parseNote(`<p>Dr. Provinc would most likely agree with me. As he has said already:<br />"Fahions on laughter change, but one thing<br />that stays the same is you can 't laugh at people<br />in power."<br /><br /></p>`);
    expect(p).toMatchObject({ form: "typed", commentary: "Dr. Provinc would most likely agree with me. As he has said already:" });
    expect(p.flags).toContain("lead_in");
    expect(p.text).toBe("Fahions on laughter change, but one thing\nthat stays the same is you can 't laugh at people\nin power.");
  });

  it("splits a typed note with two quotes and two pages", () => {
    const p = parseNote(`<p>"First quote." (p. 3)</p><p>"Second quote." (p. 9)</p>`);
    expect([p.text, p.locator?.value, p.more?.[0].text, p.more?.[0].locator?.value]).toEqual(["First quote.", "3", "Second quote.", "9"]);
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
