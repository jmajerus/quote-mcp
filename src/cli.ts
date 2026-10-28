import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { openReadOnly } from "./queries.js";
import { serveHttp, serveStdio } from "./server.js";
import { drupalUrl, loadDrupal } from "./drupal.js";
import { exportAll } from "./export.js";
import { runImport } from "./import.js";
import { loadDictionary } from "./ocr.js";
import { syncLibrary } from "./sync.js";
import { ZoteroClient, zoteroConfig } from "./zotero.js";

/**
 *   quote-mcp import [--no-drupal] [--no-zotero]
 *       Syncs the Zotero mirror (QUOTE_ZOTERO_LIBRARY plus QUOTE_ZOTERO_SOURCES), reads the old site
 *       (QUOTE_DRUPAL_URL, when set), and imports. Safe to run again; run it on a timer to pick up new
 *       quote notes typed into Zotero.
 *   quote-mcp migrate                   Brings the store up to this build's schema (the server opens it read-only).
 *   quote-mcp export [--out file]      Everything as JSON (stdout by default).
 *   quote-mcp backup [--dir data/backups] [--keep 14]
 *   quote-mcp stats
 *   quote-mcp serve                     MCP over HTTP at /mcp, the admin pages, the JSON API at /api, and the
 *                                       concept map at /map/ (QUOTE_HOST, QUOTE_PORT, QUOTE_MAP_DIR).
 *   quote-mcp stdio                     MCP over stdio, for local clients and tests.
 */

const argv = process.argv.slice(3);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const say = (text: string) => process.stderr.write(text);

async function importCommand() {
  const db = openDb();
  const config = zoteroConfig();
  const sources = [...new Set([config.library, ...(process.env.QUOTE_ZOTERO_SOURCES ?? "").split(",").map((s) => s.trim()).filter(Boolean)])];
  if (!flag("--no-zotero")) {
    for (const library of sources) {
      const r = await syncLibrary(db, new ZoteroClient({ ...config, library }, (t) => say(`\n${t}`)), library, say);
      say(`${library}: ${r.changed} changed, ${r.deleted} deleted, now at version ${r.version}.\n`);
    }
  }
  const useDrupal = !flag("--no-drupal") && !!process.env.QUOTE_DRUPAL_URL;
  const drupal = useDrupal ? await loadDrupal(drupalUrl()) : undefined;
  let dictionary: Set<string> | undefined;
  try {
    dictionary = loadDictionary();
  } catch (error) {
    say(`No word list (${(error as Error).message}); the OCR check is skipped.\n`);
  }
  const s = runImport(db, { drupal, primary: config.library, sources, dictionary });
  const counts = db.prepare("SELECT kind, status, COUNT(*) AS n FROM quotes GROUP BY kind, status ORDER BY kind DESC, status").all() as { kind: string; status: string; n: number }[];
  console.log([
    `Concepts: ${s.concepts.added} added, ${s.concepts.relations} relations added.`,
    `Quotes: ${s.quotes.added} added, ${s.quotes.merged} merged from a second source, ${s.quotes.updated} re-imported, ${s.quotes.unchanged} unchanged, ${s.quotes.keptEdited} edited and left alone.`,
    `In the store: ${counts.map((c) => (c.kind === "note" ? `${c.n} notes` : `${c.n} ${c.status}`)).join(", ")}; ${s.ocrSuspects} with suspect words.`,
    `Works with quotes: ${Object.entries(s.works).map(([k, n]) => `${n} ${k}`).join(", ")}.`,
    `Skipped: ${Object.entries(s.skipped).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing"}.`,
    `Tags not in a concept scheme: ${s.unresolvedTags.length}${s.unresolvedTags.length ? ` (${s.unresolvedTags.slice(0, 25).map(([t, n]) => `${t} ${n}`).join(", ")}${s.unresolvedTags.length > 25 ? ", …" : ""})` : ""}.`,
  ].join("\n"));
}

function exportCommand() {
  const text = JSON.stringify(exportAll(openDb()), null, 2);
  const out = option("--out");
  if (out) writeFileSync(out, text);
  else console.log(text);
}

async function backupCommand() {
  const dir = option("--dir") ?? "data/backups";
  const keep = Number(option("--keep") ?? 14);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `quotes-${new Date().toISOString().slice(0, 10)}.db`);
  await openDb().backup(file);
  const old = readdirSync(dir).filter((f) => /^quotes-\d{4}-\d\d-\d\d\.db$/.test(f)).sort().slice(0, -keep);
  for (const f of old) rmSync(join(dir, f));
  console.log(`Backed up to ${file}${old.length ? `; removed ${old.length} older` : ""}.`);
}

function statsCommand() {
  const db = openDb();
  const one = (sql: string) => db.prepare(sql).all();
  console.log(JSON.stringify({
    quotes: one("SELECT kind, status, grade, COUNT(*) AS n FROM quotes GROUP BY kind, status, grade"),
    origins: one("SELECT kind, COUNT(*) AS n FROM quote_origins GROUP BY kind"),
    works: one("SELECT match, COUNT(*) AS n FROM works GROUP BY match"),
    concepts: one("SELECT s.slug AS scheme, COUNT(c.id) AS n FROM schemes s LEFT JOIN concepts c ON c.scheme_id = s.id GROUP BY s.slug"),
  }, null, 2));
}

async function serveCommand() {
  await serveHttp(openReadOnly(), { host: process.env.QUOTE_HOST ?? "0.0.0.0", port: Number(process.env.QUOTE_PORT ?? 8010),
    mapDir: process.env.QUOTE_MAP_DIR || undefined });
}

function migrateCommand() {
  console.log(`The store is at schema ${openDb().pragma("user_version", { simple: true })}.`);
}

const commands: Record<string, () => unknown> = {
  import: importCommand, migrate: migrateCommand, export: exportCommand, backup: backupCommand, stats: statsCommand, serve: serveCommand, stdio: () => serveStdio(openReadOnly()),
};
const command = commands[process.argv[2] ?? ""];
if (!command) {
  say(`Usage: quote-mcp ${Object.keys(commands).join(" | ")}\n`);
  process.exit(2);
}
Promise.resolve(command()).catch((error) => {
  say(`${(error as Error).message}\n`);
  process.exit(1);
});
