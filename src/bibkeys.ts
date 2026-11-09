import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citekeyOf } from "./csl.js";
import { type DB, now } from "./db.js";
import { citekeysIn } from "./public.js";
import { fullTitle, normalizedTitle, quoteKey, shareAuthor, yearOf } from "./text.js";

/**
 * Drupal `[bib]Ryan1991[/bib]` markers as Better BibTeX Pandoc citekeys (`[@ryan1991driving]`).
 * A current citekey that is the old key, or the old key plus its title word, wins. When that misses or
 * matches several, the old catalogue's title and year pick the work. A key that is still ambiguous, or
 * names no work, stays `[@Ryan1991]`: nothing is invented.
 */

export interface BiblioRecord { citekey: string; title: string; year: string | null; authors: string[] }
export interface CitedWork { library: string; key: string; title: string; year: string | null; authors: string[]; citekey: string }

interface ItemData {
  title?: string; date?: string; extra?: string; citationKey?: string;
  creators?: { creatorType?: string; lastName?: string; firstName?: string; name?: string }[];
}

/** The title word Better BibTeX appends: letters, or hyphenated words, and a trailing disambiguation digit. */
const TITLE_WORD = /^[a-z]+(?:-[a-z]+)*\d*$/;

/** Citekeys that are this old key, or this old key plus a title word. */
export function citekeysWithStem(stem: string, works: CitedWork[]): string[] {
  const keys = new Set<string>();
  for (const work of works) {
    const key = work.citekey.toLowerCase();
    const rest = key.startsWith(stem) ? key.slice(stem.length) : null;
    if (rest !== null && (rest === "" || TITLE_WORD.test(rest))) keys.add(work.citekey);
  }
  return [...keys];
}

/** Works whose title (and year, and a shared author when several remain) are this catalogue row. */
function worksFor(row: BiblioRecord, works: CitedWork[]): CitedWork[] {
  const title = normalizedTitle(row.title);
  const whole = fullTitle(row.title);
  const year = yearOf(row.year);
  let hits = works.filter((w) => normalizedTitle(w.title) === title && (!year || !yearOf(w.year) || yearOf(w.year) === year));
  if (hits.length > 1) {
    const exact = hits.filter((w) => fullTitle(w.title) === whole);
    if (exact.length) hits = exact;
  }
  if (hits.length > 1 && row.authors.length) {
    const shared = hits.filter((w) => shareAuthor(w.authors, row.authors));
    if (shared.length) hits = shared;
  }
  return hits;
}

/**
 * The Better BibTeX citekey for an old Biblio key, or null when none can be chosen. One current citekey
 * that extends the old key is enough. Otherwise the catalogue row's title and year have to name one work.
 */
export function resolveBiblioKey(old: string, works: CitedWork[], catalogue: BiblioRecord[]): string | null {
  const stem = old.trim().toLowerCase();
  if (!stem) return null;
  const prefixed = citekeysWithStem(stem, works);
  if (prefixed.length === 1) return prefixed[0];
  const rows = catalogue.filter((r) => r.citekey.trim().toLowerCase() === stem);
  const fromRows = new Set<string>();
  for (const row of rows) for (const work of worksFor(row, works)) fromRows.add(work.citekey);
  if (fromRows.size === 1) return [...fromRows][0];
  const narrowed = prefixed.filter((k) => fromRows.has(k));
  return narrowed.length === 1 ? narrowed[0] : null;
}

/** Author names, as import matching uses them: an item's authors, or every creator when it has no author. */
function creatorNames(creators: ItemData["creators"]): string[] {
  const all = creators ?? [];
  const authors = all.filter((c) => c.creatorType === "author");
  return (authors.length ? authors : all).map((c) => c.name || [c.lastName, c.firstName].filter(Boolean).join(", ")).filter(Boolean);
}

/** Every mirrored item that carries a citekey, so a marker can be resolved before its work row exists. */
export function citedWorks(db: DB): CitedWork[] {
  const rows = db.prepare("SELECT library, key, data FROM zotero_items WHERE deleted = 0 AND item_type NOT IN ('note', 'attachment', 'annotation')").all() as { library: string; key: string; data: string }[];
  const works: CitedWork[] = [];
  for (const row of rows) {
    const data = JSON.parse(row.data) as ItemData;
    const citekey = citekeyOf({ itemType: "document", ...data } as Parameters<typeof citekeyOf>[0]);
    if (!citekey) continue;
    works.push({ library: row.library, key: row.key, title: data.title ?? "", year: yearOf(data.date), authors: creatorNames(data.creators), citekey });
  }
  return works;
}

interface Alias { biblio: string; citekey: string; library: string | null; key: string | null }

/** The citekey an alias names now. A remembered item's current key wins, including after Better BibTeX refreshes it. */
function currentCitekey(row: Alias, works: CitedWork[], catalogue: BiblioRecord[]): { citekey: string; library: string | null; key: string | null; trusted: boolean } {
  const linked = row.library && row.key ? works.find((w) => w.library === row.library && w.key === row.key) : undefined;
  if (linked) return { citekey: linked.citekey, library: linked.library, key: linked.key, trusted: true };
  // The item was remembered and has gone: the last citekey is the one that was written.
  if (row.library && row.key) return { citekey: row.citekey, library: row.library, key: row.key, trusted: true };
  const present = works.some((w) => w.citekey.toLowerCase() === row.citekey.toLowerCase());
  if (!present) {
    const live = resolveBiblioKey(row.biblio, works, catalogue);
    if (live) {
      const owners = works.filter((w) => w.citekey.toLowerCase() === live.toLowerCase());
      const owner = owners.length === 1 ? owners[0] : undefined;
      return { citekey: live, library: owner?.library ?? null, key: owner?.key ?? null, trusted: true };
    }
    return { citekey: row.citekey, library: null, key: null, trusted: works.length === 0 };
  }
  const owners = works.filter((w) => w.citekey.toLowerCase() === row.citekey.toLowerCase());
  const owner = owners.length === 1 ? owners[0] : undefined;
  return { citekey: row.citekey, library: owner?.library ?? null, key: owner?.key ?? null, trusted: true };
}

function aliasMap(db: DB): Map<string, Alias> {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'citekey_aliases'").get();
  if (!exists) return new Map();
  const cols = new Set((db.prepare("PRAGMA table_info(citekey_aliases)").all() as { name: string }[]).map((c) => c.name));
  const item = cols.has("zotero_library") && cols.has("zotero_key");
  const sql = item
    ? "SELECT biblio_key, citekey, zotero_library, zotero_key FROM citekey_aliases"
    : "SELECT biblio_key, citekey, NULL AS zotero_library, NULL AS zotero_key FROM citekey_aliases";
  const map = new Map<string, Alias>();
  for (const row of db.prepare(sql).all() as { biblio_key: string; citekey: string; zotero_library: string | null; zotero_key: string | null }[]) {
    map.set(row.biblio_key.toLowerCase(), { biblio: row.biblio_key, citekey: row.citekey, library: row.zotero_library, key: row.zotero_key });
  }
  return map;
}

/**
 * The citekey to write for an old key. The remembered item's current citekey wins, so a Better BibTeX
 * refresh is followed. A saved citekey is used when that item is gone, or when it is still the mirror's
 * key. A saved citekey that names no current item is not written.
 */
export function citekeyResolver(db: DB, catalogue: BiblioRecord[] = []): (key: string) => string {
  const aliases = aliasMap(db);
  const works = citedWorks(db);
  return (key: string) => {
    const saved = aliases.get(key.trim().toLowerCase());
    if (saved) {
      const current = currentCitekey(saved, works, catalogue);
      if (current.trusted) return current.citekey;
    }
    return resolveBiblioKey(key, works, catalogue) ?? key.trim();
  };
}

/** `[@old]` as `[@new]`, locator and all. A key that merely starts with `old` is left alone. */
function replaceCitekeys(text: string, replacements: Map<string, string>): { text: string; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  if (!replacements.size || !text.includes("[@")) return { text, counts };
  const next = text.replace(/\[@([A-Za-z0-9_.:-]+)/g, (whole, found: string) => {
    const to = replacements.get(found.toLowerCase());
    if (!to || to.toLowerCase() === found.toLowerCase()) return whole;
    counts.set(found.toLowerCase(), (counts.get(found.toLowerCase()) ?? 0) + 1);
    return `[@${to}`;
  });
  return { text: next, counts };
}

export interface CitekeyChange { from: string; to: string; count: number }
export interface CitekeyReport { quotes: number; markers: number; resolved: number; kept: number; refreshed: number; keys: CitekeyChange[] }

const ROLLBACK = new Error("dry run");

function ensureAliases(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS citekey_aliases (
    biblio_key TEXT PRIMARY KEY COLLATE NOCASE, citekey TEXT NOT NULL, zotero_library TEXT, zotero_key TEXT)`);
  const cols = new Set((db.prepare("PRAGMA table_info(citekey_aliases)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("zotero_library")) db.exec("ALTER TABLE citekey_aliases ADD COLUMN zotero_library TEXT");
  if (!cols.has("zotero_key")) db.exec("ALTER TABLE citekey_aliases ADD COLUMN zotero_key TEXT");
}

/**
 * Rewrites `[bib]` markers in quote text and comments. A resolved key is remembered with its Zotero item,
 * so a later import writes the same citekey without the catalogue, and a Better BibTeX refresh of that
 * item is followed: a stored `[@old]` is rewritten. `--dry-run` reports the rewrite and saves nothing.
 */
export function canonicalizeCitekeys(db: DB, { dryRun = false, catalogue = [], actor = "citekeys" }: { dryRun?: boolean; catalogue?: BiblioRecord[]; actor?: string } = {}): CitekeyReport {
  const works = citedWorks(db);
  const markers = new Map<string, CitekeyChange>();
  const refreshed = new Map<string, CitekeyChange>();
  const report: CitekeyReport = { quotes: 0, markers: 0, resolved: 0, kept: 0, refreshed: 0, keys: [] };
  try {
    db.transaction(() => {
      ensureAliases(db);
      const aliases = aliasMap(db);
      const replacements = new Map<string, string>();
      const spelling = new Map<string, string>();
      const save = db.prepare(`INSERT INTO citekey_aliases (biblio_key, citekey, zotero_library, zotero_key) VALUES (?, ?, ?, ?)
        ON CONFLICT (biblio_key) DO UPDATE SET citekey = excluded.citekey, zotero_library = excluded.zotero_library, zotero_key = excluded.zotero_key`);
      for (const alias of aliases.values()) {
        const current = currentCitekey(alias, works, catalogue);
        const citekey = current.trusted ? current.citekey : alias.citekey;
        const moved = citekey.toLowerCase() !== alias.citekey.toLowerCase();
        const stillThere = works.some((w) => w.citekey.toLowerCase() === alias.citekey.toLowerCase() && !(w.library === current.library && w.key === current.key));
        if (moved && current.trusted && !stillThere) {
          replacements.set(alias.citekey.toLowerCase(), citekey);
          spelling.set(alias.citekey.toLowerCase(), alias.citekey);
        }
        if (moved || current.library !== alias.library || current.key !== alias.key) save.run(alias.biblio, citekey, current.library, current.key);
        aliases.set(alias.biblio.toLowerCase(), { biblio: alias.biblio, citekey, library: current.library, key: current.key });
      }
      const resolve = (key: string) => {
        const from = key.trim();
        const saved = aliases.get(from.toLowerCase());
        const followed = saved ? currentCitekey(saved, works, catalogue) : null;
        const to = followed?.trusted ? followed.citekey : (resolveBiblioKey(from, works, catalogue) ?? from);
        const change = markers.get(from.toLowerCase()) ?? { from, to, count: 0 };
        change.to = to;
        change.count++;
        markers.set(from.toLowerCase(), change);
        return to;
      };
      const history = db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'citekeys', ?, ?, ?, ?)");
      const stamp = now();
      const where = replacements.size
        ? "text LIKE '%[bib]%' OR comment LIKE '%[bib]%' OR text LIKE '%[@%' OR comment LIKE '%[@%'"
        : "text LIKE '%[bib]%' OR comment LIKE '%[bib]%'";
      const rows = db.prepare(`SELECT id, text, comment FROM quotes WHERE ${where}`).all() as { id: number; text: string; comment: string | null }[];
      const noteRefresh = (counts: Map<string, number>) => {
        for (const [from, count] of counts) {
          const change = refreshed.get(from) ?? { from: spelling.get(from) ?? from, to: replacements.get(from) ?? from, count: 0 };
          change.count += count;
          refreshed.set(from, change);
        }
      };
      for (const row of rows) {
        const written = replaceCitekeys(citekeysIn(row.text, resolve), replacements);
        const comment = row.comment == null ? null : replaceCitekeys(citekeysIn(row.comment, resolve), replacements);
        noteRefresh(written.counts);
        if (comment) noteRefresh(comment.counts);
        const commentText = comment?.text ?? null;
        if (written.text === row.text && commentText === row.comment) continue;
        report.quotes++;
        const reason = row.text.includes("[bib]") || (row.comment ?? "").includes("[bib]")
          ? "Drupal [bib] citekey rewritten as a Pandoc citekey"
          : "Stored citekey followed the item's Better BibTeX citekey";
        if (written.text !== row.text) history.run(row.id, stamp, row.text, written.text, actor, reason);
        if (comment && comment.text !== row.comment) history.run(row.id, stamp, row.comment, comment.text, actor, reason);
        db.prepare("UPDATE quotes SET text = ?, text_key = ?, comment = ?, updated_at = ?, updated_by = ? WHERE id = ?")
          .run(written.text, quoteKey(written.text), commentText, stamp, actor, row.id);
      }
      for (const change of markers.values()) {
        report.markers += change.count;
        if (change.to.toLowerCase() === change.from.toLowerCase()) report.kept += change.count;
        else {
          report.resolved += change.count;
          const owners = works.filter((w) => w.citekey.toLowerCase() === change.to.toLowerCase());
          const owner = owners.length === 1 ? owners[0] : undefined;
          save.run(change.from, change.to, owner?.library ?? null, owner?.key ?? null);
        }
      }
      for (const change of refreshed.values()) report.refreshed += change.count;
      report.keys = [...markers.values(), ...refreshed.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
      if (dryRun) throw ROLLBACK;
      if (report.quotes) db.exec(`DELETE FROM quotes_fts;
        INSERT INTO quotes_fts (rowid, text, comment, tags)
        SELECT q.id, q.text, COALESCE(q.comment, ''), COALESCE((SELECT group_concat(tag, ' ') FROM quote_tags WHERE quote_id = q.id), '') FROM quotes q;`);
    })();
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return report;
}

/** The old site's catalogue, from QUOTE_DRUPAL_URL: `biblio.biblio_citekey` with its title, year, and authors. */
export function loadBiblioCatalogue(url: string): Promise<BiblioRecord[]> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new Error("QUOTE_DRUPAL_URL is not a usable database URL."));
  }
  if (parsed.protocol !== "mysql:") return Promise.reject(new Error("QUOTE_DRUPAL_URL is not a MySQL URL."));
  const dir = mkdtempSync(join(tmpdir(), "quote-mcp-biblio-"));
  const file = join(dir, "client.cnf");
  const sql = `SET SESSION group_concat_max_len = 1000000;
    SELECT JSON_OBJECT(
      'citekey', b.biblio_citekey,
      'title', REPLACE(REPLACE(n.title, CHAR(10), ' '), CHAR(13), ' '),
      'year', b.biblio_year,
      'authors', IFNULL((
        SELECT GROUP_CONCAT(TRIM(CONCAT(COALESCE(NULLIF(d.lastname, ''), d.name, ''),
          CASE WHEN d.firstname IS NULL OR d.firstname = '' THEN '' ELSE CONCAT(', ', d.firstname) END)) SEPARATOR ' || ')
        FROM biblio_contributor c JOIN biblio_contributor_data d ON d.cid = c.cid
        WHERE c.vid = b.vid AND c.auth_type = 1
      ), '')
    )
    FROM biblio b JOIN node n ON n.vid = b.vid
    WHERE b.biblio_citekey IS NOT NULL AND b.biblio_citekey <> ''`;
  writeFileSync(file, `[client]\nuser=${decodeURIComponent(parsed.username)}\npassword=${decodeURIComponent(parsed.password)}\nhost=${parsed.hostname}\nport=${parsed.port || "3306"}\n`, { mode: 0o600 });
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return new Promise((resolve, reject) => {
    const child = spawn("mysql", [`--defaults-extra-file=${file}`, "--batch", "--raw", "--skip-column-names", database, "-e", sql], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      rmSync(dir, { recursive: true, force: true });
      reject(error.code === "ENOENT" ? new Error("The mysql client is not installed, so the old catalogue could not be read.") : error);
    });
    child.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      if (code !== 0) {
        const line = err.split("\n").map((s) => s.trim()).find((s) => s.startsWith("ERROR")) ?? "mysql failed";
        reject(new Error(`The old catalogue could not be read (${line}).`));
        return;
      }
      // The SET statement prints nothing; each selected row is one JSON object.
      const records: BiblioRecord[] = [];
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { citekey: string; title: string; year: string | number | null; authors: string };
        records.push({
          citekey: String(row.citekey), title: String(row.title ?? ""),
          year: row.year == null || row.year === "" ? null : String(row.year),
          authors: String(row.authors ?? "").split(" || ").map((s) => s.trim()).filter(Boolean),
        });
      }
      resolve(records);
    });
  });
}
