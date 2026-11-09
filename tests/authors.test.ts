import { describe, expect, it } from "vitest";
import { type AuthorFill, type MirrorItem, addAuthors, authorFills, creatorsFrom } from "../src/authors.js";
import type { BiblioRecord } from "../src/bibkeys.js";

const item = (more: Partial<MirrorItem> = {}): MirrorItem => ({
  library: "users/1", key: "ABCD2345", version: 3, title: "Theory Z: How American Business Can Meet the Japanese Challenge",
  year: "1981", citekey: "1981theory", collections: ["BUSINESS"], creators: [], ...more,
});
const row = (more: Partial<BiblioRecord> = {}): BiblioRecord => ({
  citekey: "Ouchi1981", title: "Theory Z: How American Business Can Meet the Japanese Challenge", year: "1981", authors: ["Ouchi, William"], ...more,
});

describe("authors from the old catalogue", () => {
  it("turns a catalogue name into Zotero's creator fields", () => {
    expect(creatorsFrom(["Ouchi, William", "American Management Association"])).toEqual([
      { creatorType: "author", lastName: "Ouchi", firstName: "William" },
      { creatorType: "author", name: "American Management Association" },
    ]);
  });

  it("fills an authorless item in the collection and keeps an editor", () => {
    const plan = authorFills([
      item(),
      item({ key: "EDITOR01", creators: [{ creatorType: "editor", lastName: "Sanborn", firstName: "Franklin" }] }),
      item({ key: "HASAUTHOR", creators: [{ creatorType: "author", lastName: "Ouchi", firstName: "William" }] }),
      item({ key: "ELSEWHERE", collections: ["OTHER"] }),
    ], [row()], ["BUSINESS"]);
    expect(plan.fills.map((f) => f.key)).toEqual(["ABCD2345", "EDITOR01"]);
    expect(plan.fills[1].creators).toEqual([
      { creatorType: "author", lastName: "Ouchi", firstName: "William" },
      { creatorType: "editor", lastName: "Sanborn", firstName: "Franklin" },
    ]);
    expect(plan.gaps).toEqual([]);
  });

  it("leaves a title the catalogue doesn't settle", () => {
    const plan = authorFills([item()], [
      row({ authors: ["Ouchi, William"] }),
      row({ citekey: "Other1981", authors: ["Someone, Else"] }),
    ], ["BUSINESS"]);
    expect(plan.fills).toEqual([]);
    expect(plan.gaps).toEqual([{ library: "users/1", key: "ABCD2345", title: item().title, citekey: "1981theory", why: "several author lists" }]);
  });

  it("writes the authors only when Zotero still has none", async () => {
    const fill: AuthorFill = { library: "users/1", key: "ABCD2345", version: 3, title: "Theory Z", citekey: "1981theory", creators: [{ creatorType: "author", lastName: "Ouchi", firstName: "William" }] };
    const calls: { url: string; method?: string; version?: string; body?: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, version: new Headers(init?.headers).get("If-Unmodified-Since-Version") ?? undefined, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === "PATCH") return new Response(null, { status: 204 });
      const creators = String(url).endsWith("HASAUTHOR") ? [{ creatorType: "author", lastName: "Ouchi", firstName: "William" }] : [];
      return new Response(JSON.stringify({ version: 9, data: { creators } }), { status: 200 });
    }) as typeof fetch;
    const result = await addAuthors([fill, { ...fill, key: "HASAUTHOR" }], "secret", fetchImpl);
    expect(result).toEqual({ written: 1, skipped: 1, failed: [] });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("https://api.zotero.org/users/1/items/ABCD2345");
    expect(patch?.version).toBe("9");
    expect(patch?.body).toEqual({ creators: [{ creatorType: "author", lastName: "Ouchi", firstName: "William" }] });
    expect(JSON.stringify(calls)).not.toContain("secret");
  });
});
