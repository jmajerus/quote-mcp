#!/usr/bin/env node
// Prints what the quote server runs, as one JSON line for the vscode-status-probe status-bar
// extension (see .vscode/settings.json): the branch from /health's deploy record, and how far it is
// behind that branch on origin. It only reads: git ls-remote and gh api, never a fetch.
//
// Every deploy installs a local checkout (tools/deploy.mjs), so "local" isn't marked; uncommitted
// changes are (*), and a commit GitHub doesn't have, so the lag is unknown, is a warning.
//
// Status items show state, not actions: a noun glyph ($(quote)), no verbs, and a background only
// through `level`. The Deploy Quotes button is the action: a verb label and its own glyph.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.QUOTE_STATUS_URL ?? "http://quote-mcp.localdomain:8000";
const ICON = "$(quote)";
const MAX_BRANCH_LABEL = 16;

function print(probe) {
  process.stdout.write(`${JSON.stringify({ open: `${BASE}/admin`, ...probe })}\n`);
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

function tooltip(rows, note = "") {
  const table = ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${escapeMarkdown(k)} | ${escapeMarkdown(v)} |`)].join("\n");
  return `**Quote server**\n\n${table}${note ? `\n\n${note}` : ""}`;
}

function run(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** The head of a ref on origin, or null when it is gone or origin cannot be reached. */
function remoteHead(ref) {
  return run("git", ["ls-remote", "origin", ref])?.split(/\s/)[0] || null;
}

/** Commits on `head` that `commit` lacks, from GitHub, so they need not be fetched; null when unknown. */
function behindBy(commit, head) {
  if (commit === head) return 0;
  const count = Number(run("gh", ["api", `repos/{owner}/{repo}/compare/${commit}...${head}`, "--jq", ".ahead_by"]));
  return Number.isInteger(count) ? count : null;
}

function label(deployed) {
  const name = String(deployed.branch).slice(String(deployed.branch).lastIndexOf("/") + 1);
  return name.length > MAX_BRANCH_LABEL ? `${name.slice(0, MAX_BRANCH_LABEL - 1)}…` : name;
}

let health;
try {
  const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10000) });
  health = await response.json();
  if (!health.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  print({ text: `${ICON} ?`, tooltip: tooltip([["Server", BASE], ["Problem", `unreachable or unhealthy (${error.message})`]]), level: "error" });
  process.exit(0);
}

const deployed = health.deployed;
const rows = [["Version", health.version], ["Quotes", String(health.quotes)], ["Notes", String(health.notes ?? 0)]];
if (!deployed?.commit) {
  print({ text: `${ICON} ?`, level: "warn",
    tooltip: tooltip(rows, "The server has no deploy record yet: it was installed before deploys recorded one. Deploy it once with the Deploy Quotes button.") });
  process.exit(0);
}

const marks = [];
let note = "";
const head = remoteHead(`refs/heads/${deployed.branch}`);
const behind = head ? behindBy(deployed.commit, head) : null;
if (behind) marks.push(`↓${behind}`);
if (deployed.dirty) marks.push("*");
if (behind) note = "Pull and deploy with the Deploy Quotes button to catch up.";
else if (behind == null) note = head ? "GitHub doesn't have the deployed commit: push it." : `origin has no branch ${deployed.branch}, or can't be reached.`;

rows.unshift(
  ["Running", deployed.branch],
  ["Commit", `${deployed.commit.slice(0, 7)}${deployed.dirty ? ", with uncommitted changes" : ""}`],
  ["Behind origin", behind == null ? "unknown" : String(behind)],
  ["Deployed", new Date(deployed.at).toLocaleString()],
);
rows.push(["Checked", new Date().toLocaleTimeString()]);

print({
  text: [`${ICON} ${label(deployed)}`, ...marks].join(" "),
  tooltip: tooltip(rows, note),
  // Lag, a commit that is on no branch on origin, or uncommitted changes.
  level: behind || note || deployed.dirty ? "warn" : "ok",
});
