import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { openReadOnly } from "./queries.js";
import { servePublic, serveHttp, serveStdio } from "./server.js";
import { drupalUrl, loadDrupal } from "./drupal.js";
import { exportAll } from "./export.js";
import { runImport } from "./import.js";
import { loadDictionary } from "./ocr.js";
import { type ConceptSet, listSets, loadSets } from "./sets.js";
import { LEVELS, type Level, type SiteOptions, loadCollections, loadIntro } from "./site.js";
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

/** A file in the checkout's vocab/ folder (one level up from src/ and dist/). */
const vocab = (name: string) => fileURLToPath(new URL(`../vocab/${name}`, import.meta.url));

/** The concept sets: QUOTE_SETS, or the checkout's vocab/sets.json when there is one. */
function sets(): ConceptSet[] {
  if (process.env.QUOTE_SETS) return loadSets(process.env.QUOTE_SETS);
  return existsSync(vocab("sets.json")) ? loadSets(vocab("sets.json")) : [];
}

/**
 * The public site's settings: QUOTE_PUBLIC, QUOTE_PUBLIC_NOTES, the introduction in QUOTE_INTRO or vocab/site.md,
 * and each collection's beside it in collections/<scheme>.md.
 */
function site(mapDir: string | undefined, conceptSets: ConceptSet[]): SiteOptions {
  const level = (process.env.QUOTE_PUBLIC || "none") as Level;
  if (!LEVELS.includes(level)) throw new Error(`QUOTE_PUBLIC is "${level}"; it should be ${LEVELS.join(", ")}.`);
  const notes = process.env.QUOTE_PUBLIC_NOTES || "none";
  if (notes !== "none" && notes !== "all") throw new Error(`QUOTE_PUBLIC_NOTES is "${notes}"; it should be none or all.`);
  const intro = process.env.QUOTE_INTRO || vocab("site.md");
  return { level, notes: notes === "all", intro: loadIntro(intro), collections: loadCollections(join(dirname(intro), "collections")), mapDir, sets: conceptSets };
}

async function serveCommand() {
  const mapDir = process.env.QUOTE_MAP_DIR || undefined;
  const conceptSets = sets();
  const options = { host: process.env.QUOTE_HOST ?? "0.0.0.0", port: Number(process.env.QUOTE_PORT ?? 8010), mapDir, sets: conceptSets, site: site(mapDir, conceptSets) };
  const db = openReadOnly();
  await serveHttp(db, options);
  if (process.env.QUOTE_PUBLIC_PORT) await servePublic(db, { ...options, port: Number(process.env.QUOTE_PUBLIC_PORT) });
}

/** Each concept set as the store has it now; fails when a set names a concept the scheme doesn't have. */
function setsCommand() {
  const listed = listSets(openReadOnly(), sets());
  console.log(JSON.stringify(listed, null, 2));
  const missing = listed.filter((s) => s.missing.length);
  if (missing.length) throw new Error(`Concepts not in their scheme: ${missing.map((s) => `${s.slug} (${s.missing.join(", ")})`).join("; ")}.`);
}

function migrateCommand() {
  console.log(`The store is at schema ${openDb().pragma("user_version", { simple: true })}.`);
}

const commands: Record<string, () => unknown> = {
  import: importCommand, migrate: migrateCommand, export: exportCommand, backup: backupCommand, stats: statsCommand, sets: setsCommand, serve: serveCommand,
  stdio: () => serveStdio(openReadOnly(), sets()),
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
