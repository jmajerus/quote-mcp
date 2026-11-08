import { describe, expect, it } from "vitest";
import { canonicalIsbn, filePrintBook, lookupIsbn, printBookFromForm } from "../src/isbn.js";
import { ToolError } from "../src/common.js";

describe("an ISBN", () => {
  it("accepts an ISBN-13, an ISBN-10, and a scan with punctuation", () => {
    expect(canonicalIsbn("978-0-306-40615-7")).toBe("9780306406157");
    expect(canonicalIsbn("0-306-40615-2")).toBe("9780306406157");
    expect(canonicalIsbn("ISBN 9780306406157")).toBe("9780306406157");
    expect(canonicalIsbn("9780306406158")).toBeNull();
    expect(canonicalIsbn("not a book")).toBeNull();
  });

  it("fills gaps from the second lookup", async () => {
    const fetchImpl = (async (url: string) => {
      const body = String(url).includes("openlibrary")
        ? { "ISBN:9780306406157": { title: "A Printed Book", publish_date: "1999", cover: { medium: "https://covers.example/m.jpg" } } }
        : { items: [{ volumeInfo: { title: "Ignored", authors: ["Ada Binder"], publisher: "North Press", publishedDate: "1998" } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    expect(await lookupIsbn("9780306406157", fetchImpl)).toEqual({
      isbn: "9780306406157", title: "A Printed Book", authors: ["Ada Binder"], year: "1999", publisher: "North Press", cover: "https://covers.example/m.jpg",
    });
    expect(await lookupIsbn("nope", fetchImpl)).toBeNull();
  });

  it("refuses a book with no title or author", () => {
    expect(() => printBookFromForm(new URLSearchParams({ isbn: "9780306406157", title: "  ", authors: "Ada Binder" }))).toThrow(ToolError);
    expect(() => printBookFromForm(new URLSearchParams({ isbn: "9780306406157", title: "A Printed Book", authors: "\n" }))).toThrow(/author/);
  });

  it("files the accepted book, and uses an item Zotero already has", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify([]), { status: 200 });
      const sent = JSON.parse(String(init?.body)) as { title: string; creators: { lastName: string }[]; ISBN: string }[];
      expect(sent[0]).toMatchObject({ title: "A Printed Book", ISBN: "9780306406157", creators: [{ lastName: "Binder", firstName: "Ada" }] });
      return new Response(JSON.stringify({ successful: { "0": { key: "PRINT001", version: 4 } }, failed: {} }), { status: 200 });
    }) as typeof fetch;
    const book = printBookFromForm(new URLSearchParams({ isbn: "978-0-306-40615-7", title: "A Printed Book", authors: "Binder, Ada", year: "1999", publisher: "North Press" }));
    const filed = await filePrintBook({ QUOTE_ZOTERO_LIBRARY: "users/1", QUOTE_ZOTERO_WRITE_KEY: "write-key" }, book, "a".repeat(32), fetchImpl);
    expect(filed).toMatchObject({ library: "users/1", key: "PRINT001", version: 4, data: { title: "A Printed Book", ISBN: "9780306406157" } });
    expect(calls[0]).toContain("api.zotero.org/users/1/items?q=9780306406157");
    expect(calls[1]).toMatch(/^POST /);

    const again = await filePrintBook({ QUOTE_ZOTERO_LIBRARY: "users/1", QUOTE_ZOTERO_API_KEY: "read-key" }, book, "b".repeat(32), (async () => new Response(JSON.stringify([
      { key: "HAVE0001", version: 2, data: { itemType: "book", title: "A Printed Book", ISBN: "978-0-306-40615-7" } },
    ]), { status: 200 })) as typeof fetch);
    expect(again.key).toBe("HAVE0001");
    await expect(filePrintBook({ QUOTE_ZOTERO_LIBRARY: "users/1" }, book, "c".repeat(32), fetchImpl)).rejects.toThrow(/QUOTE_ZOTERO_WRITE_KEY/);
  });
});
