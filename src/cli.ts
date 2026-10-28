import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { openReadOnly } from "./queries.js";
import { servePublic, serveHttp, serveStdio } from "./server.js";
import { drupalUrl, loadDrupal } from "./drupal.js";
import { exportAll } from "./export.js";
import { runImport } from "./import.js";
import { loadDictionary } from "./ocr.js";
import { loadCollections, loadIntro } from "./intro.js";
import { LEVELS, type Level } from "./public.js";
import { snapshotReader } from "./published-sqlite.js";
import { d1ConfigFrom, d1Http } from "./d1-http.js";
import { openReplicaState, pending, startDrain, tick } from "./drain.js";
import { replicaScript } from "./replica.js";
import { type ConceptSet, listSets, loadSets } from "./sets.js";
import { type SnapshotOptions, buildSnapshot, readMapsFile } from "./snapshot.js";
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
 *   quote-mcp serve                     MCP over HTTP at /mcp, the admin pages, the JSON API at /api, the
 *                                       concept map at /map/, and the public site's preview at / (QUOTE_HOST,
 *                                       QUOTE_PORT, QUOTE_MAP_DIR, QUOTE_PUBLIC, QUOTE_PUBLIC_PORT).
 *   quote-mcp publish --dry-run        Builds the public snapshot (QUOTE_SNAPSHOT, by default public.db beside
 *                                       the store), which the preview reads; an import also builds it.
 *   quote-mcp publish --sql <file>     The same, and a SQL file that loads it into a local D1 for the Worker.
 *   quote-mcp publish                  Builds it and ships what changed to its replica in D1 (as the server's
 *                                       drain does every 15 seconds); --status shows the queue.
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
  const publish = snapshotOptions();
  if (publish) console.log(snapshotLine(buildSnapshot(db, publish, snapshotFile())));
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

/** QUOTE_PUBLIC: what the public snapshot holds. */
function level(): Level {
  const value = (process.env.QUOTE_PUBLIC || "none") as Level;
  if (!LEVELS.includes(value)) throw new Error(`QUOTE_PUBLIC is "${value}"; it should be ${LEVELS.join(", ")}.`);
  return value;
}

/** The public snapshot's file: QUOTE_SNAPSHOT, or public.db beside the store. */
const snapshotFile = () => process.env.QUOTE_SNAPSHOT || join(dirname(process.env.QUOTE_DB ?? "data/quotes.db"), "public.db");
/** The replica's queue and what's been shipped to D1: replica.db beside the snapshot. */
const replicaStateFile = () => join(dirname(snapshotFile()), "replica.db");

/**
 * What goes into the public snapshot, or null with QUOTE_PUBLIC=none: the level, QUOTE_PUBLIC_NOTES, the
 * introduction in QUOTE_INTRO or vocab/site.md and each collection's in collections/<scheme>.md beside it,
 * the concept sets, and the maps in QUOTE_MAP_DIR's maps.json.
 */
function snapshotOptions(): SnapshotOptions | null {
  const public_ = level();
  if (public_ === "none") return null;
  const notes = process.env.QUOTE_PUBLIC_NOTES || "none";
  if (notes !== "none" && notes !== "all") throw new Error(`QUOTE_PUBLIC_NOTES is "${notes}"; it should be none or all.`);
  const intro = process.env.QUOTE_INTRO || vocab("site.md");
  return { level: public_, notes: notes === "all", intro: loadIntro(intro), collections: loadCollections(join(dirname(intro), "collections")),
    sets: sets(), maps: readMapsFile(process.env.QUOTE_MAP_DIR || undefined) };
}

const snapshotLine = (s: ReturnType<typeof buildSnapshot>) =>
  `Public snapshot (${s.level}): ${s.records} records, ${s.works} works, ${s.concepts} concepts, ${s.sets} sets, ${s.maps} maps, written to ${s.file} (${s.hash.slice(0, 12)}).`;

/**
 * Builds the public snapshot and ships what changed to its replica in D1 (the server's drain does the
 * same every 15 seconds). --dry-run only builds it, for the preview; --sql <file> also writes it as a SQL
 * file that loads a replica from scratch (for a local D1 under `wrangler dev`); --status shows the queue.
 */
async function publishCommand() {
  if (flag("--status")) {
    const state = openReplicaState(replicaStateFile());
    console.log(JSON.stringify({ d1: d1ConfigFrom(process.env) ? "configured" : "not configured", ...pending(state),
      snapshot: state.prepare("SELECT value FROM state WHERE key = 'snapshot_hash'").pluck().get() ?? null,
      shipped_at: state.prepare("SELECT value FROM state WHERE key = 'shipped_at'").pluck().get() ?? null }, null, 2));
    return;
  }
  const options = snapshotOptions();
  if (!options) throw new Error("QUOTE_PUBLIC is none, so there's nothing to publish.");
  const sql = option("--sql");
  const config = flag("--dry-run") || sql ? null : d1ConfigFrom(process.env);
  if (!flag("--dry-run") && !sql && !config) {
    throw new Error("No D1 is configured (QUOTE_D1_PROXY_URL and QUOTE_D1_PROXY_TOKEN, or CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and QUOTE_D1_DATABASE_ID); use --dry-run to build the snapshot for the preview.");
  }
  const summary = buildSnapshot(openReadOnly(), options, snapshotFile());
  console.log(snapshotLine(summary));
  if (sql) {
    const snap = new Database(summary.file, { readonly: true });
    mkdirSync(dirname(sql), { recursive: true });
    writeFileSync(sql, replicaScript(snap));
    snap.close();
    console.log(`Replica SQL written to ${sql}.`);
  }
  if (config) {
    const { queued, shipped } = await tick(summary.file, openReplicaState(replicaStateFile()), d1Http(config));
    console.log(`Replica in D1: ${queued} queued, ${shipped} shipped.`);
  }
}

async function serveCommand() {
  const conceptSets = sets();
  const snapshot = level() === "none" ? undefined : snapshotReader(snapshotFile());
  const replica = snapshot ? startDrain(snapshotFile(), replicaStateFile()) : undefined;
  const options = { host: process.env.QUOTE_HOST ?? "0.0.0.0", port: Number(process.env.QUOTE_PORT ?? 8010), mapDir: process.env.QUOTE_MAP_DIR || undefined, sets: conceptSets, snapshot, replica };
  await serveHttp(openReadOnly(), options);
  if (process.env.QUOTE_PUBLIC_PORT) await servePublic({ ...options, port: Number(process.env.QUOTE_PUBLIC_PORT) });
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
  import: importCommand, migrate: migrateCommand, export: exportCommand, backup: backupCommand, stats: statsCommand, sets: setsCommand, publish: publishCommand, serve: serveCommand,
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
