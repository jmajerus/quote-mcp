#!/usr/bin/env node
// Writes src/favicon.ts from assets/favicon.png, so the Node server and the Worker (which can't read
// files) serve the same icon. Run after changing the icon: render assets/favicon.svg to assets/favicon.png
// (inkscape "$PWD/assets/favicon.svg" --export-type=png --export-filename="$PWD/assets/favicon.png" -w 64 -h 64),
// then `node tools/favicon.mjs`. A test fails while the two differ.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const png = fs.readFileSync(path.join(root, "assets", "favicon.png")).toString("base64");
fs.writeFileSync(path.join(root, "src", "favicon.ts"), `// Generated from assets/favicon.png by tools/favicon.mjs; don't edit.

/** The tab icon (assets/favicon.svg, rendered): VS Code's "quote" codicon on the site's accent blue. */
export const FAVICON_PNG_BASE64 =
  "${png}";

/** The icon's bytes, for a response body; no Node modules, so the Worker can use it too. */
export function faviconBytes(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(FAVICON_PNG_BASE64), (c) => c.charCodeAt(0));
}
`);
console.log(`src/favicon.ts written (${png.length} base64 characters).`);
