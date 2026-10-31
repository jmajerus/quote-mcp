#!/usr/bin/env node
// Prints the public replica's state, as one JSON line for the vscode-status-probe status-bar extension
// (see .vscode/settings.json): the server's drain from /health (src/drain.ts), and whether the public
// site, on the hostname in worker/wrangler.jsonc, has been published. It only reads.
//
// In step: $(cloud). Rows waiting to ship: $(cloud-upload) and how many. No drain reported (the public
// site is none, or an older build), the drain off (no D1 settings on the server) or failing, or the public
// site not published: a warning or an error, with the reason in the tooltip. Status items show state, not
// actions: noun glyphs, no verbs.
//
// Every uncached page the Worker renders reads thousands of D1 rows, and D1's free tier allows five million
// a day across the account, so the site check is a HEAD with the last ETag it saw (kept in
// node_modules/.cache): while nothing new is published, the Worker answers 304 after reading only its meta.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SEEN = path.join(root, "node_modules", ".cache", "replica-status-etag");
const BASE = process.env.QUOTE_STATUS_URL ?? "http://quote-mcp.localdomain:8000";

/** The public hostname: the custom domain in the public Worker's wrangler config. */
function publicSite() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, "worker", "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    const route = config.routes?.find((r) => r.custom_domain)?.pattern;
    return route ? `https://${route}` : null;
  } catch {
    return null;
  }
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

function tooltip(rows, note = "") {
  const table = ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${escapeMarkdown(k)} | ${escapeMarkdown(v)} |`)].join("\n");
  return `**Public replica**\n\n${table}${note ? `\n\n${note}` : ""}`;
}

function ago(iso) {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} min ago`;
  return new Date(iso).toLocaleString();
}

const site = publicSite();
const print = (probe) => process.stdout.write(`${JSON.stringify({ ...(site ? { open: site } : {}), ...probe })}\n`);

let replica;
try {
  const health = await (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10000) })).json();
  replica = health.replica;
} catch (error) {
  print({ text: "$(cloud) ?", level: "error", tooltip: tooltip([["Server", BASE], ["Problem", `unreachable (${error.message})`]]) });
  process.exit(0);
}

let published = "unknown";
if (site) {
  try {
    let seen = "";
    try {
      seen = fs.readFileSync(SEEN, "utf8").trim();
    } catch {}
    const res = await fetch(site, { method: "HEAD", headers: seen ? { "if-none-match": seen } : {}, signal: AbortSignal.timeout(10000), redirect: "manual" });
    published = res.status === 200 || res.status === 304 ? "yes" : res.status === 503 ? "not yet" : `HTTP ${res.status}`;
    const etag = res.headers.get("etag");
    if (res.status === 200 && etag && etag !== seen) {
      fs.mkdirSync(path.dirname(SEEN), { recursive: true });
      fs.writeFileSync(SEEN, etag);
    }
  } catch (error) {
    published = `unreachable (${error.message})`;
  }
}

const rows = [
  ["Public site", site ?? "no custom domain in worker/wrangler.jsonc"],
  ["Published", published],
  ["Drain", replica?.phase ?? "not reported"],
  ["Waiting to ship", String(replica?.pending ?? 0)],
  ["Last shipped", ago(replica?.shipped_at)],
  ...(replica?.error ? [["Error", replica.error]] : []),
  ["Checked", new Date().toLocaleTimeString()],
];

if (!replica) {
  // The server leaves the drain out of /health when its public site is none, and builds before the drain had none.
  print({ text: "$(cloud) —", level: "warn", tooltip: tooltip(rows, "The server doesn't report a drain: its public site is none (public: in vocab/site.md, or QUOTE_PUBLIC on the server), or it runs a build from before the drain. Deploy to update it.") });
} else if (replica.phase === "off") {
  print({ text: "$(cloud) off", level: "warn", tooltip: tooltip(rows, "The server's drain isn't running: it has no D1 settings. Push them with Deploy Quotes → Push the server's settings.") });
} else if (replica.phase === "error") {
  print({ text: "$(cloud) !", level: "error", tooltip: tooltip(rows, "The last drain failed; rows stay queued and the next tick tries again.") });
} else if (replica.pending > 0) {
  print({ text: `$(cloud-upload) ${replica.pending}`, level: "ok", tooltip: tooltip(rows, "Rows are queued and ship within 15 seconds.") });
} else if (published !== "yes") {
  print({ text: "$(cloud) ?", level: "warn", tooltip: tooltip(rows, "The drain is in step, but the public site doesn't answer as published.") });
} else {
  print({ text: "$(cloud)", level: "ok", tooltip: tooltip(rows) });
}
