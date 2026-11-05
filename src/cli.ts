import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { corpusClient, corpusConfig, followAnchors, importCorpusQuotes, retryAnchors, storeWriter, zoteroRefresher } from "./capture.js";
import { SCHEMA_VERSION, openDb, openExisting } from "./db.js";
import { reviewProposal } from "./edits.js";
import { ToolError } from "./common.js";
import { listProposals, openReadOnly } from "./queries.js";
import { servePublic, serveHttp, serveStdio } from "./server.js";
import { drupalUrl, emptyFields, loadDrupal, loadDrupalYears } from "./drupal.js";
import { exportAll } from "./export.js";
import { runImport } from "./import.js";
import { loadDictionary } from "./ocr.js";
import { loadCollections, loadIntro, loadSiteSettings } from "./intro.js";
import { LEVELS, type Level } from "./public.js";
import { snapshotReader } from "./published-sqlite.js";
import { d1ConfigFrom, d1Http } from "./d1-http.js";
import { openReplicaState, pending, startDrain, tick } from "./drain.js";
import { replicaScript } from "./replica.js";
import { type ConceptSet, listSets, loadSets } from "./sets.js";
import { configReport, siteSetting } from "./settings.js";
import { takeOldSiteYears, rematchWorks } from "./rematch.js";
import { type SnapshotOptions, buildSnapshot, readMapsFile } from "./snapshot.js";
import { syncLibrary } from "./sync.js";
import { acceptHeldChange, clearCursor, proposal, readCursor, reportProgress, runTermSync, startTermSync, terminologyClient, terminologyConfig } from "./terminology.js";
import { ZoteroClient, zoteroConfig } from "./zotero.js";

/**
 *   quote-mcp import [--no-drupal] [--no-zotero] [--dry-run]
 *       Syncs the Zotero mirror (QUOTE_ZOTERO_LIBRARY plus QUOTE_ZOTERO_SOURCES), reads the old site
 *       (QUOTE_DRUPAL_URL, when set), and imports. Safe to run again; run it on a timer to pick up new
 *       quote notes typed into Zotero.
 *   quote-mcp take-old-site-years [--dry-run]
 *       Saves the old site's years on works that keep their own details. Reads nothing else from the old site.
 *   quote-mcp rematch [--dry-run]
 *       Matches works to Zotero from the store: those not matched yet, and those whose item has gone. Reads no source
 *       but Zotero. The dry run lists what would move, and saves nothing.
 *   quote-mcp migrate [--backup <file>] Brings the store up to this build's schema (the server opens it read-only);
 *                                       with --backup, copies it to <file> first when its schema will change, so
 *                                       a deploy that rolls back can put back a store the previous build opens.
 *   quote-mcp export [--out file]      Everything as JSON (stdout by default).
 *   quote-mcp take-corpus-quotes [--skip 2,…] [--dry-run]
 *                                       Takes over corpus-mcp's own saved quotes, once: each is checked against
 *                                       its book again, saved with origin corpus, and its anchor posted. Prints
 *                                       corpus-mcp's id and the new one for each; a re-run skips those taken.
 *   quote-mcp proposals [--accept <n> | --reject <n>] [--note "…"] [--status accepted|rejected]
 *                                       Agents' proposed changes to a quote's text, locator, or chapter author:
 *                                       the pending ones, or accept or reject one (accepting applies it as your
 *                                       edit, recorded under your login).
 *   quote-mcp backup [--dir data/backups] [--keep 14]
 *   quote-mcp stats
 *   quote-mcp config                    Each setting, where it came from, and what each feature still needs.
 *   quote-mcp serve                     MCP over HTTP at /mcp, the admin pages, the JSON API at /api, the
 *                                       concept map at /map/, and the public site's preview at / (QUOTE_HOST,
 *                                       QUOTE_PORT, QUOTE_MAP_DIR, QUOTE_PUBLIC, QUOTE_PUBLIC_PORT).
 *   quote-mcp publish --dry-run        (--if-public: nothing when the site isn't public) Builds the public snapshot (QUOTE_SNAPSHOT, by default public.db beside
 *                                       the store), which the preview reads; an import also builds it.
 *   quote-mcp publish --sql <file>     The same, and a SQL file that loads it into a local D1 for the Worker.
 *   quote-mcp publish                  Builds it and ships what changed to its replica in D1 (as the server's
 *                                       drain does every 15 seconds); --status shows the queue.
 *   quote-mcp terms                     Follows terminology-mcp's human-work scheme (TERMINOLOGY_BASE): a dry run of what
 *                                       the next pass would apply and where it would stop. --apply applies it and reports
 *                                       progress (the server does this every minute when QUOTE_TERMS_SYNC=on);
 *                                       --accept <n> [--repoint <slug>] marks held change n as handled by hand;
 *                                       --rebootstrap forgets the cursor; --status shows it.
 *   quote-mcp propose <tag> [--quote <id>] [--label …] [--broader <slug>] [--note …] [--alt a,b] [--send]
 *                                       Proposes a tag that isn't a concept to terminology-mcp, with a quote as evidence;
 *                                       without --send it prints the proposal.
 *   quote-mcp stdio                     MCP over stdio, for local clients and tests.
 */

const argv = process.argv.slice(3);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const say = (text: string) => process.stderr.write(text);

/** The libraries quotes come from: the primary one first, then QUOTE_ZOTERO_SOURCES. */
const zoteroSources = (primary: string) => [...new Set([primary, ...(process.env.QUOTE_ZOTERO_SOURCES ?? "").split(",").map((s) => s.trim()).filter(Boolean)])];

async function importCommand() {
  // A dry run saves nothing, the mirror and the schema included, so it reads the store as the last sync left it.
  const dryRun = flag("--dry-run");
  const db = dryRun ? openExisting() : openDb();
  const config = zoteroConfig();
  const sources = zoteroSources(config.library);
  if (!flag("--no-zotero") && !dryRun) {
    for (const library of sources) {
      const r = await syncLibrary(db, new ZoteroClient({ ...config, library }, (t) => say(`\n${t}`)), library, say);
      say(`${library}: ${r.changed} changed, ${r.deleted} deleted, now at version ${r.version}.\n`);
    }
  }
  const useDrupal = !flag("--no-drupal") && !!process.env.QUOTE_DRUPAL_URL;
  const drupal = useDrupal ? await loadDrupal(drupalUrl()) : undefined;
  if (drupal) for (const field of emptyFields(drupal.works)) say(`Warning: none of the old site's ${drupal.works.length} works has ${field === "year" ? "a year" : "authors"}, so matching can't use them. Has a column changed?\n`);
  else if (dryRun) say("The old site isn't being read (--no-drupal, or no QUOTE_DRUPAL_URL), so works aren't matched again.\n");
  let dictionary: Set<string> | undefined;
  try {
    dictionary = loadDictionary();
  } catch (error) {
    say(`No word list (${(error as Error).message}); the OCR check is skipped.\n`);
  }
  const s = runImport(db, { drupal, primary: config.library, sources, dictionary, dryRun });
  const counts = db.prepare("SELECT kind, status, COUNT(*) AS n FROM quotes GROUP BY kind, status ORDER BY kind DESC, status").all() as { kind: string; status: string; n: number }[];
  console.log([
    `Concepts: ${s.concepts.added} added, ${s.concepts.relations} relations added.`,
    `Quotes: ${s.quotes.added} added, ${s.quotes.merged} merged from a second source, ${s.quotes.updated} re-imported, ${s.quotes.unchanged} unchanged, ${s.quotes.keptEdited} edited or checked against a book and left alone.`,
    `In the store: ${counts.map((c) => (c.kind === "note" ? `${c.n} notes` : `${c.n} ${c.status}`)).join(", ")}; ${s.ocrSuspects} with suspect words.`,
    `Works with quotes: ${Object.entries(s.works).map(([k, n]) => `${n} ${k}`).join(", ")}.`,
    `Skipped: ${Object.entries(s.skipped).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing"}.`,
    `Tags not in a concept scheme: ${s.unresolvedTags.length}${s.unresolvedTags.length ? ` (${s.unresolvedTags.slice(0, 25).map(([t, n]) => `${t} ${n}`).join(", ")}${s.unresolvedTags.length > 25 ? ", …" : ""})` : ""}.`,
  ].join("\n"));
  for (const c of s.workChanges) console.log(`Work ${dryRun ? "would move" : "moved"}: ${c.title} (${c.from} → ${c.to}, ${c.quotes} quote${c.quotes === 1 ? "" : "s"}).`);
  for (const m of s.authorMismatches) console.log(`Check this match, no author in common: ${m.title} (${m.authors.join("; ")}) and Zotero ${m.zotero} (${m.creators.join("; ")}).`);
  if (dryRun) {
    console.log("Dry run: nothing was saved.");
    return;
  }
  const corpus = corpusConfig();
  if (corpus) {
    try {
      const client = corpusClient(corpus);
      const a = await retryAnchors(db, client);
      if (a.tried) console.log(`Anchors posted again to corpus-mcp: ${a.stored} of ${a.tried}.`);
      const f = await followAnchors(db, client);
      if (f.read) console.log(`Anchor changes from corpus-mcp: ${f.read} (changes ${f.from}–${f.to}); ${f.lost} no longer found, ${f.found} found again, ${f.updated} anchors updated.`);
    } catch (error) {
      say(`Anchors not followed: ${(error as Error).message}\n`);
    }
  }
  const publish = snapshotOptions();
  if (publish) console.log(snapshotLine(buildSnapshot(db, publish, snapshotFile())));
}

/** add_quote's writes: a writable connection to the store, corpus-mcp to check quotes against, and the primary library. */
function capture() {
  const corpus = corpusConfig();
  const writer = storeWriter(process.env.QUOTE_DB ?? "data/quotes.db");
  return { writer, corpus: corpus ? corpusClient(corpus) : null, primary: process.env.QUOTE_ZOTERO_LIBRARY || null, refreshZotero: zoteroRefresher(writer) };
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
    // The Zotero mirror, by library: the version the next import carries on from, and what it holds.
    zotero: one(`SELECT z.library, (SELECT value FROM meta WHERE key = 'zotero_version:' || z.library) AS version,
      SUM(z.deleted = 0) AS items, SUM(z.deleted = 0 AND z.item_type = 'note') AS notes, SUM(z.deleted = 1) AS deleted
      FROM zotero_items z GROUP BY z.library`),
  }, null, 2));
}

/** A file in the checkout's vocab/ folder (one level up from src/ and dist/). */
const vocab = (name: string) => fileURLToPath(new URL(`../vocab/${name}`, import.meta.url));

/** The concept sets: QUOTE_SETS, or the checkout's vocab/sets.json when there is one. */
function sets(): ConceptSet[] {
  if (process.env.QUOTE_SETS) return loadSets(process.env.QUOTE_SETS);
  return existsSync(vocab("sets.json")) ? loadSets(vocab("sets.json")) : [];
}

/** The front page's file, whose settings header holds the public site's choices: QUOTE_INTRO, or vocab/site.md. */
const introFile = () => process.env.QUOTE_INTRO || vocab("site.md");
/** The public Worker's wrangler config, for D1's database id. */
const wranglerFile = () => fileURLToPath(new URL("../worker/wrangler.jsonc", import.meta.url));

/** What the public snapshot holds: QUOTE_PUBLIC, or `public:` in vocab/site.md; none by default. */
function level(): Level {
  const value = siteSetting("QUOTE_PUBLIC", process.env, loadSiteSettings(introFile())) as Level;
  if (!LEVELS.includes(value)) throw new Error(`The public site's level is "${value}"; it should be ${LEVELS.join(", ")} (QUOTE_PUBLIC, or public: in vocab/site.md).`);
  return value;
}

/** The public snapshot's file: QUOTE_SNAPSHOT, or public.db beside the store. */
const snapshotFile = () => process.env.QUOTE_SNAPSHOT || join(dirname(process.env.QUOTE_DB ?? "data/quotes.db"), "public.db");
/** The replica's queue and what's been shipped to D1: replica.db beside the snapshot. */
const replicaStateFile = () => join(dirname(snapshotFile()), "replica.db");

/**
 * What goes into the public snapshot, or null when the level is none: the level, the notes setting
 * (QUOTE_PUBLIC_NOTES, or notes: in vocab/site.md), the introduction and each collection's in
 * collections/<scheme>.md beside it, the concept sets, and the maps in QUOTE_MAP_DIR's maps.json.
 */
function snapshotOptions(): SnapshotOptions | null {
  const public_ = level();
  if (public_ === "none") return null;
  const intro = introFile();
  const notes = siteSetting("QUOTE_PUBLIC_NOTES", process.env, loadSiteSettings(intro));
  if (notes !== "none" && notes !== "all") throw new Error(`The notes setting is "${notes}"; it should be none or all (QUOTE_PUBLIC_NOTES, or notes: in vocab/site.md).`);
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
    console.log(JSON.stringify({ d1: d1ConfigFrom(process.env, wranglerFile()) ? "configured" : "not configured", ...pending(state),
      snapshot: state.prepare("SELECT value FROM state WHERE key = 'snapshot_hash'").pluck().get() ?? null,
      shipped_at: state.prepare("SELECT value FROM state WHERE key = 'shipped_at'").pluck().get() ?? null }, null, 2));
    return;
  }
  const options = snapshotOptions();
  if (!options && flag("--if-public")) return;
  if (!options) throw new Error("The public site is none, so there's nothing to publish (public: in vocab/site.md, or QUOTE_PUBLIC).");
  const sql = option("--sql");
  const config = flag("--dry-run") || sql ? null : d1ConfigFrom(process.env, wranglerFile());
  if (!flag("--dry-run") && !sql && !config) {
    throw new Error("No D1 is configured (QUOTE_D1_PROXY_URL and QUOTE_D1_PROXY_TOKEN; `quote-mcp config` shows the settings); use --dry-run to build the snapshot for the preview.");
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
    const { queued, shipped, busy } = await tick(summary.file, openReplicaState(replicaStateFile()), d1Http(config));
    console.log(busy ? "Another tick (the server's drain, most likely) is shipping to D1 now; it picks up this snapshot's changes too."
      : `Replica in D1: ${queued} queued, ${shipped} shipped.`);
  }
}

/** Each setting, where it came from, and what each feature still needs; secrets show only as set. */
function configCommand() {
  console.log(configReport(process.env, loadSiteSettings(introFile()), wranglerFile()));
}

async function serveCommand() {
  const conceptSets = sets();
  const snapshot = level() === "none" ? undefined : snapshotReader(snapshotFile());
  const replica = snapshot ? startDrain(snapshotFile(), replicaStateFile(), process.env, wranglerFile()) : undefined;
  // The concepts changed: rebuild the public snapshot, which the drain then ships.
  const rebuild = () => {
    const publish = snapshotOptions();
    if (!publish) return;
    const store = openReadOnly();
    try {
      console.error(snapshotLine(buildSnapshot(store, publish, snapshotFile())));
    } finally {
      store.close();
    }
  };
  const terms = startTermSync({ file: process.env.QUOTE_DB ?? "data/quotes.db", sets: conceptSets, onApplied: rebuild });
  const options = { host: process.env.QUOTE_HOST ?? "0.0.0.0", port: Number(process.env.QUOTE_PORT ?? 8010), mapDir: process.env.QUOTE_MAP_DIR || undefined, sets: conceptSets, snapshot, replica, terms, capture: capture() };
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

function termsClient() {
  const config = terminologyConfig();
  if (!config) throw new Error("TERMINOLOGY_BASE is off; there's nothing to follow.");
  return terminologyClient(config);
}

/** Follows terminology-mcp's human-work scheme by hand; see the usage above. */
async function termsCommand() {
  const db = openDb();
  if (flag("--status")) {
    console.log(JSON.stringify(readCursor(db), null, 2));
    return;
  }
  if (flag("--rebootstrap")) {
    clearCursor(db);
    console.log("Cursor cleared; the next pass bootstraps from terminology-mcp's state.");
    return;
  }
  const client = termsClient();
  const print = (label: string, lines: string[] | undefined) => {
    if (lines?.length) console.log(`${label}\n${lines.map((l) => `  ${l}`).join("\n")}`);
  };
  const accept = option("--accept");
  if (accept !== undefined) {
    const n = Number(accept);
    if (!Number.isInteger(n)) throw new Error("--accept needs a change number.");
    const result = await acceptHeldChange({ db, client, n, repointTo: option("--repoint") });
    await reportProgress(client, result);
    print("Applied:", result.lines);
    console.log(`Accepted change ${n} (${result.change.kind}); the cursor is at ${n}, and the next pass continues after it.`);
    // The next pass may find nothing new, and wouldn't rebuild for this one.
    const publish = snapshotOptions();
    if (publish) console.log(snapshotLine(buildSnapshot(db, publish, snapshotFile())));
    return;
  }
  const apply = flag("--apply");
  const result = await runTermSync({ db, client, sets: sets(), apply });
  console.log(`Concepts from terminology-mcp ${apply ? "" : "(dry run) "}${result.outcome} against ${client.baseUrl}: through ${result.through}, head ${result.head ?? "?"}.`);
  print(apply ? "Applied:" : "Would apply:", result.lines);
  print("Problems (reported, not applied):", result.problems?.map((p) => `${p.code}: ${p.reason}`));
  if (result.blocked) console.log(`Held at change ${result.blocked.at} (${result.blocked.code}): ${result.blocked.reason}`);
  if (result.outcome === "bootstrap-held") console.log("The bootstrap is held: nothing was written. Resolve the slug problems above first.");
  if (apply && !["rebuilt", "bootstrap-held"].includes(result.outcome)) await reportProgress(client, result);
  if (apply && ["applied", "bootstrapped", "held"].includes(result.outcome)) {
    const publish = snapshotOptions();
    if (publish) console.log(snapshotLine(buildSnapshot(db, publish, snapshotFile())));
  }
}

/** Proposes a tag that isn't a concept to terminology-mcp, with a quote as evidence. */
async function proposeCommand() {
  const tag = argv[0];
  if (!tag || tag.startsWith("--")) throw new Error("Name the tag: quote-mcp propose <tag> [--quote <id>] [--label …] [--broader <slug>] [--note …] [--alt a,b] [--send]");
  const quote = option("--quote");
  const body = proposal(openReadOnly(), tag, {
    quote: quote === undefined ? undefined : Number(quote), label: option("--label"), broader: option("--broader"), note: option("--note"),
    altLabels: option("--alt")?.split(",").map((a) => a.trim()).filter(Boolean),
  });
  if (!flag("--send")) {
    console.log(`${JSON.stringify(body, null, 2)}\n(not sent; add --send to propose it)`);
    return;
  }
  const answer = await termsClient().propose(body);
  console.log(`Proposed "${body.label}" as ${String(answer.slug)} (${String(answer.id)}, ${String(answer.status)}), change ${String(answer.change)}. The subscriber adds it as a provisional concept; the next import resolves the tag.`);
}

async function migrateCommand() {
  const file = process.env.QUOTE_DB ?? "data/quotes.db";
  const backup = option("--backup");
  if (backup && existsSync(file)) {
    const old = new Database(file, { readonly: true, fileMustExist: true });
    const version = Number(old.pragma("user_version", { simple: true }));
    if (version < SCHEMA_VERSION) {
      rmSync(backup, { force: true });
      await old.backup(backup);
      console.log(`Copied the store at schema ${version} to ${backup}.`);
    }
    old.close();
  }
  console.log(`The store is at schema ${openDb().pragma("user_version", { simple: true })}.`);
}

/** Rebuilds the public snapshot after a change to the store, when the site is public. */
function publishFrom(db: Database.Database) {
  const publish = snapshotOptions();
  if (publish) console.log(snapshotLine(buildSnapshot(db, publish, snapshotFile())));
}

/** Saves the old site's years, once, on works that keep their own details. Nothing else is read from the old site. */
async function takeOldSiteYearsCommand() {
  const dryRun = flag("--dry-run");
  const years = await loadDrupalYears(drupalUrl());
  const db = dryRun ? openExisting() : openDb();
  try {
    const r = takeOldSiteYears(db, years, { dryRun });
    console.log(`Old-site works: ${r.read}, ${r.withYear} with a year. ${dryRun ? "Would save" : "Saved"} ${r.filled}; ${r.alreadySet} already had one, ${r.matched} are matched to Zotero and use its year, ${r.notHere} aren't in the store.`);
    if (dryRun) console.log("Dry run: nothing was saved.");
    else if (r.filled) publishFrom(db);
  } finally {
    db.close();
  }
}

/** Matches works to Zotero from the store, after bringing the mirror of each library up to date. */
async function rematchCommand() {
  const dryRun = flag("--dry-run");
  const config = zoteroConfig();
  const db = dryRun ? openExisting() : openDb();
  try {
    if (dryRun) say("Reading the Zotero mirror as the last sync left it.\n");
    else for (const library of zoteroSources(config.library)) await syncLibrary(db, new ZoteroClient({ ...config, library }, (t) => say(`\n${t}`)), library, say);
    const r = rematchWorks(db, { primary: config.library, dryRun });
    console.log(`Checked ${r.checked} works. ${dryRun ? "Would change" : "Changed"} ${r.changes.length}, moving ${r.changes.reduce((n, c) => n + c.quotes, 0)} quotes.`);
    for (const c of r.changes) console.log(`  ${c.title} (${c.from} \u2192 ${c.to}, ${c.quotes} quote${c.quotes === 1 ? "" : "s"})`);
    for (const m of r.authorMismatches) console.log(`Check this match, no author in common: ${m.title} (${m.authors.join("; ")}) and Zotero ${m.zotero} (${m.creators.join("; ") || "no authors"}).`);
    console.log(`Works with quotes${dryRun ? ", after this" : ""}: ${Object.entries(r.works).map(([k, n]) => `${n} ${k}`).join(", ")}.`);
    if (dryRun) {
      console.log("Dry run: nothing was saved.");
      return;
    }
    if (r.updated) publishFrom(db);
  } finally {
    db.close();
  }
}

async function takeCorpusQuotesCommand() {
  const config = corpusConfig();
  if (!config) throw new Error("CORPUS_BASE is off; there's no corpus-mcp to take quotes from.");
  const corpus = corpusClient(config);
  const skip = (option("--skip") ?? "").split(",").map((n) => Number(n.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const db = openDb();
  try {
    const results = await importCorpusQuotes(db, corpus, await corpus.quotes(), { primary: process.env.QUOTE_ZOTERO_LIBRARY || null, skip, dryRun: flag("--dry-run") });
    console.log(JSON.stringify(results, null, 2));
    if (results.some((r) => r.error)) process.exitCode = 1;
  } finally {
    db.close();
  }
}

function proposalsCommand() {
  const accept = option("--accept");
  const reject = option("--reject");
  const db = openDb();
  try {
    if (accept || reject) {
      const id = Number(accept ?? reject);
      if (!Number.isInteger(id) || id < 1) throw new Error(`Give a proposal number, not ${accept ?? reject}.`);
      const reviewer = process.env.SUDO_USER || userInfo().username;
      const r = reviewProposal(db, id, accept ? "accept" : "reject", reviewer, option("--note"));
      console.log(`Proposal ${id} ${r.proposal.status}; quote ${r.quote.id} is now:\n${JSON.stringify({ text: r.quote.text, locator: r.quote.locator, chapter_author: r.quote.chapter_author }, null, 2)}`);
      return;
    }
    const status = (option("--status") ?? "pending") as "pending" | "accepted" | "rejected";
    const list = listProposals(db, { status, limit: 200 });
    if (!list.total) return console.log(`No ${status} proposals.`);
    for (const p of list.proposals) {
      console.log(`\n${p.id}. Quote ${p.quote.id}${p.quote.work ? ` (${p.quote.work})` : ""}, by ${p.proposer}, ${p.created_at.slice(0, 10)}: ${p.rationale}${p.evidence ? `\n   Evidence: ${p.evidence}` : ""}`);
      for (const k of Object.keys(p.change) as (keyof typeof p.change)[]) console.log(`   ${k}: ${JSON.stringify(p.before[k] ?? null)}\n     → ${JSON.stringify(p.change[k] ?? null)}`);
    }
    if (status === "pending") console.log("\nquote-mcp proposals --accept <n> | --reject <n> [--note \"…\"]");
  } catch (error) {
    if (error instanceof ToolError) throw new Error(error.message);
    throw error;
  } finally {
    db.close();
  }
}

const commands: Record<string, () => unknown> = {
  import: importCommand, migrate: migrateCommand, export: exportCommand, backup: backupCommand, stats: statsCommand, sets: setsCommand, publish: publishCommand, config: configCommand, serve: serveCommand,
  terms: termsCommand, propose: proposeCommand, "take-corpus-quotes": takeCorpusQuotesCommand, "take-old-site-years": takeOldSiteYearsCommand, rematch: rematchCommand, proposals: proposalsCommand,
  stdio: () => serveStdio(openReadOnly(), sets(), capture()),
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
