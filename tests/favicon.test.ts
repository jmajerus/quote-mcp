import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FAVICON_PNG_BASE64, faviconBytes } from "../src/favicon.js";

describe("the tab icon", () => {
  it("is assets/favicon.png, as src/favicon.ts carries it (run `node tools/favicon.mjs` after changing the icon)", () => {
    const png = fs.readFileSync(path.join(import.meta.dirname, "..", "assets", "favicon.png"));
    expect(FAVICON_PNG_BASE64).toBe(png.toString("base64"));
    expect(Buffer.from(faviconBytes()).equals(png)).toBe(true);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });
});
