import { describe, expect, it } from "vitest";
import { readMargin } from "../src/margin.js";

const CONCEPTS: Record<string, number> = { mobbing: 1, "false self": 2, "false-self": 2, "group bullying": 1, "psychic prison": 3 };
const resolve = (name: string) => CONCEPTS[name.toLowerCase()] ?? null;
const read = (text: string) => readMargin(text, resolve);

describe("readMargin", () => {
  it("reads a list of concepts as tags", () => {
    expect(read("mobbing, False self; psychic prison")).toEqual({
      tags: [{ tag: "mobbing", conceptId: 1 }, { tag: "False self", conceptId: 2 }, { tag: "psychic prison", conceptId: 3 }], prose: null,
    });
    expect(read("mobbing\ngroup bullying").tags).toEqual([{ tag: "mobbing", conceptId: 1 }, { tag: "group bullying", conceptId: 1 }]);
  });

  it("reads short pieces as tags even when they aren't concepts yet", () => {
    expect(read("mobbing, scapegoating, toxic boss")).toEqual({
      tags: [{ tag: "mobbing", conceptId: 1 }, { tag: "scapegoating", conceptId: null }, { tag: "toxic boss", conceptId: null }], prose: null,
    });
  });

  it("keeps prose as prose, taking leading concepts as tags", () => {
    expect(read("mobbing, false self — compare Goffman")).toEqual({
      tags: [{ tag: "mobbing", conceptId: 1 }, { tag: "false self", conceptId: 2 }], prose: "compare Goffman",
    });
    expect(read("This is exactly what happened at the plant in 1998.")).toEqual({ tags: [], prose: "This is exactly what happened at the plant in 1998." });
    expect(read("Compare the chapter on mobbing, which says more.")).toEqual({ tags: [], prose: "Compare the chapter on mobbing, which says more." });
  });

  it("reads dashed concepts as tags when nothing else follows", () => {
    expect(read("mobbing — false self")).toEqual({ tags: [{ tag: "mobbing", conceptId: 1 }, { tag: "false self", conceptId: 2 }], prose: null });
  });

  it("always reads .word as a tag, wherever it is", () => {
    expect(read(".mobbing .false-self Goffman says the same thing about asylums.")).toEqual({
      tags: [{ tag: "mobbing", conceptId: 1 }, { tag: "false self", conceptId: 2 }], prose: "Goffman says the same thing about asylums.",
    });
    expect(read("He means the same, e.g. in chapter 3. .new-idea").tags).toEqual([{ tag: "new idea", conceptId: null }]);
  });

  it("reads nothing from empty text", () => {
    expect(read("  ")).toEqual({ tags: [], prose: null });
  });
});
