import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serverEnv } from "../src/settings.js";
// @ts-expect-error: a plain JavaScript tool, with no types.
import { writeEnvScript } from "../tools/server-env.mjs";

const SERVER = "# The server's own.\nQUOTE_DB=/var/lib/quote-mcp/quotes.db\nQUOTE_PORT=8000\n";
const LOCAL = {
  QUOTE_ZOTERO_LIBRARY: "users/1", QUOTE_ZOTERO_API_KEY: "zkey", QUOTE_D1_PROXY_URL: "https://p.example", QUOTE_D1_PROXY_TOKEN: "ptoken",
  QUOTE_DB: "data/quotes.db", AUTHORING_DEPLOY_PASSWORD: "pw", CLOUDFLARE_API_TOKEN: "cf", QUOTE_ZOTERO_SOURCES: "",
};

describe("the server's settings file", () => {
  it("has the server's own settings, then the server settings from .env, and nothing that's this machine's", () => {
    const { text, names } = serverEnv(LOCAL, SERVER);
    expect(text).toMatch(/^# Written by `npm run deploy`/);
    expect(names).toEqual(["QUOTE_DB", "QUOTE_PORT", "QUOTE_ZOTERO_LIBRARY", "QUOTE_ZOTERO_API_KEY", "QUOTE_D1_PROXY_URL", "QUOTE_D1_PROXY_TOKEN"]);
    expect(text).toContain("QUOTE_DB=/var/lib/quote-mcp/quotes.db");
    expect(text).not.toContain("data/quotes.db");
    for (const local of ["pw", "cf", "AUTHORING_DEPLOY_PASSWORD", "CLOUDFLARE_API_TOKEN", "QUOTE_ZOTERO_SOURCES"]) expect(text).not.toContain(local);
  });

  it("refuses a value with a line break", () => {
    expect(() => serverEnv({ QUOTE_ZOTERO_API_KEY: "a\nb" }, SERVER)).toThrow(/line break/);
  });
});

describe("writing it on the server", () => {
  const group = execFileSync("id", ["-gn"], { encoding: "utf8" }).trim();
  const setup = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-env-"));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return dir;
  };
  const run = (dir: string, text: string) => spawnSync("bash", ["-c", `set -euo pipefail\n${writeEnvScript(text, dir, group)}`], { encoding: "utf8" });
  const files = (dir: string) => fs.readdirSync(dir).sort();
  const mode = (file: string) => (fs.statSync(file).mode & 0o777).toString(8);

  it("replaces the old env with generated.env, moving the old one aside, readable by its owner only", () => {
    const dir = setup({ env: "QUOTE_DB=/var/lib/quote-mcp/quotes.db\nQUOTE_PORT=8000\nQUOTE_ZOTERO_API_KEY=old\n" });
    const { text } = serverEnv(LOCAL, SERVER);
    const r = run(dir, text);
    expect(r.status, r.stderr).toBe(0);
    expect(files(dir)).toEqual(["env.replaced", "generated.env"]);
    expect(fs.readFileSync(path.join(dir, "generated.env"), "utf8")).toBe(text);
    expect(mode(path.join(dir, "generated.env"))).toBe("640");
    expect(mode(path.join(dir, "env.replaced"))).toBe("600");
  });

  it("changes nothing, and says what's missing, when the server has a setting the new file wouldn't", () => {
    const dir = setup({ "generated.env": "QUOTE_DB=x\nQUOTE_PORT=8000\nQUOTE_ZOTERO_API_KEY=keep\nQUOTE_DRUPAL_URL=mysql://keep\n" });
    const { text } = serverEnv({ ...LOCAL, QUOTE_ZOTERO_API_KEY: "" }, SERVER);
    const r = run(dir, text);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("QUOTE_DRUPAL_URL QUOTE_ZOTERO_API_KEY");
    expect(files(dir)).toEqual(["generated.env"]);
    expect(fs.readFileSync(path.join(dir, "generated.env"), "utf8")).toContain("QUOTE_ZOTERO_API_KEY=keep");
  });

  it("rewrites generated.env on later deploys", () => {
    const dir = setup({ "generated.env": "QUOTE_DB=x\n" });
    const { text } = serverEnv(LOCAL, SERVER);
    expect(run(dir, text).status).toBe(0);
    expect(files(dir)).toEqual(["generated.env"]);
    expect(fs.readFileSync(path.join(dir, "generated.env"), "utf8")).toBe(text);
  });
});
