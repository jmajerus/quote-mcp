import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { d1ConfigFrom, wranglerDatabaseId } from "../src/d1-http.js";
import { frontMatter, readIntro } from "../src/intro.js";
import { SETTINGS, configReport, resolve, siteSetting } from "../src/settings.js";

describe("vocab/site.md's settings header", () => {
  it("reads key: value lines between --- lines, and leaves the introduction after them", () => {
    const text = "---\npublic: quotes\nNotes: 'all'\n# a comment line is ignored\n---\n# My quotes\n\nHello.";
    expect(frontMatter(text).fields).toEqual({ public: "quotes", notes: "all" });
    expect(readIntro(text)).toMatchObject({ title: "My quotes", html: "<p>Hello.</p>" });
    expect(frontMatter("# No header\n\n---\nnot: this").fields).toEqual({});
  });

  it("gives the public site's choices, which the environment overrides, and defaults otherwise", () => {
    expect(siteSetting("QUOTE_PUBLIC", {}, { public: "quotes" })).toBe("quotes");
    expect(siteSetting("QUOTE_PUBLIC", { QUOTE_PUBLIC: "catalogue" }, { public: "quotes" })).toBe("catalogue");
    expect(siteSetting("QUOTE_PUBLIC", {}, {})).toBe("none");
    const port = SETTINGS.find((s) => s.name === "QUOTE_PORT")!;
    expect(resolve(port, {}, {})).toEqual({ value: "8010", source: "default" });
    expect(resolve(port, { QUOTE_PORT: "9000" }, {})).toEqual({ value: "9000", source: "environment" });
  });
});

describe("quote-mcp config", () => {
  it("shows secrets only as set, and what each feature needs", () => {
    const report = configReport({ QUOTE_ZOTERO_LIBRARY: "users/1", QUOTE_ZOTERO_API_KEY: "s3cret", QUOTE_D1_PROXY_URL: "https://p.example" }, { public: "quotes" }, "/nowhere");
    expect(report).not.toContain("s3cret");
    expect(report).toMatch(/QUOTE_ZOTERO_API_KEY\s+\(set\)/);
    expect(report).toMatch(/QUOTE_PUBLIC\s+quotes\s+\[server, vocab\/site\.md\]/);
    expect(report).toMatch(/on\s+Import from Zotero/);
    expect(report).toMatch(/off\s+Public replica in D1: QUOTE_D1_PROXY_URL is set but QUOTE_D1_PROXY_TOKEN isn't/);
  });
});

describe("D1 through the REST API", () => {
  const wrangler = (id: string) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "quote-wrangler-")), "wrangler.jsonc");
    fs.writeFileSync(file, `// a comment\n{\n  "d1_databases": [\n    {\n      // another\n      "database_id": "${id}"\n    }\n  ]\n}\n`);
    return file;
  };

  it("takes the database id from the Worker's wrangler config, unless it's the placeholder", () => {
    expect(wranglerDatabaseId(wrangler("abc-123"))).toBe("abc-123");
    expect(wranglerDatabaseId(wrangler("00000000-0000-0000-0000-000000000000"))).toBeUndefined();
    expect(d1ConfigFrom({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" }, wrangler("abc-123"))).toMatchObject({ accountId: "a", databaseId: "abc-123" });
  });

  it("isn't turned on by an API token alone, which wrangler reads too", () => {
    expect(d1ConfigFrom({ CLOUDFLARE_API_TOKEN: "t" })).toBeNull();
  });
});
