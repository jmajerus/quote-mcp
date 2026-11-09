import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { citationRenderer } from "../src/citations.js";
import { readIntro } from "../src/intro.js";
import { buildSnapshot } from "../src/snapshot.js";
import { makeStore } from "./fixture.js";

const ryan = {
  id: "ryan1991driving", type: "book", title: "Driving Fear Out of the Workplace",
  author: [{ family: "Ryan", given: "Kathleen" }, { family: "Oestreich", given: "Daniel" }],
  issued: { "date-parts": [[1991]] },
};
const orwell = {
  id: "orwell19491984", type: "book", title: "Nineteen Eighty-Four",
  author: [{ family: "Orwell", given: "George" }], issued: { "date-parts": [[1949]] },
};

describe("Pandoc citekeys expanded as Chicago author-date", () => {
  const render = citationRenderer(new Map([["ryan1991driving", ryan], ["orwell19491984", orwell]]));

  it("renders a bracket citation, its page, and a bare citekey", () => {
    expect(render("People stay silent[@ryan1991driving].")).toBe("People stay silent(Ryan and Oestreich 1991).");
    expect(render("See [@ryan1991driving, p. 12].")).toBe("See (Ryan and Oestreich 1991, 12).");
    expect(render("@ryan1991driving says so.")).toBe("Ryan and Oestreich (1991) says so.");
    expect(render("See [@ryan1991driving; @orwell19491984].")).toBe("See (Ryan and Oestreich 1991; Orwell 1949).");
  });

  it("leaves a citekey that has no record, and an address", () => {
    expect(render("See [@Peters2004].")).toBe("See [@Peters2004].");
    expect(render("See [@ryan1991driving; @Peters2004].")).toBe("See [@ryan1991driving; @Peters2004].");
    expect(render("Write to ada@example.com.")).toBe("Write to ada@example.com.");
  });

  it("expands a citekey in a published comment and leaves the Pandoc citation to paste", () => {
    const db = makeStore();
    db.prepare("UPDATE quotes SET comment = ? WHERE text LIKE 'Mobbing is%'").run("See [@davenport1999mobbing, p. 12].");
    const file = path.join(os.tmpdir(), `quote-mcp-cites-${process.pid}.db`);
    buildSnapshot(db, { level: "quotes", notes: true, intro: readIntro("# Work quotes\n\nQuotes about work."), collections: {}, sets: [], maps: [] }, file);
    const snap = new Database(file, { readonly: true });
    const row = snap.prepare("SELECT text, comment, pandoc FROM records WHERE text LIKE 'Mobbing is%'").get() as { text: string; comment: string; pandoc: string };
    expect(row.text).toBe("Mobbing is an emotional assault.");
    expect(row.comment).toBe("See (Davenport 1999, 12).");
    expect(row.pandoc).toBe("[@davenport1999mobbing, p. 40]");
    snap.close();
    db.close();
  });
});
