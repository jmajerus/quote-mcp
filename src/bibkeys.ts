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
export interface CitedWork { title: string; year: string | null; authors: string[]; citekey: string }

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

/** Every mirrored item that carries a citekey, so a marker can be resolved before its work row exists. */
export function citedWorks(db: DB): CitedWork[] {
  const rows = db.prepare("SELECT data FROM zotero_items WHERE deleted = 0 AND item_type != 'note'").all() as { data: string }[];
  const works: CitedWork[] = [];
  for (const row of rows) {
    const data = JSON.parse(row.data) as ItemData;
    const citekey = citekeyOf({ itemType: "document", ...data } as Parameters<typeof citekeyOf>[0]);
    if (!citekey) continue;
    const authors = (data.creators ?? []).map((c) => c.name || [c.lastName, c.firstName].filter(Boolean).join(", ")).filter(Boolean);
    works.push({ title: data.title ?? "", year: yearOf(data.date), authors, citekey });
  }
  return works;
}

function aliasMap(db: DB): Map<string, string> {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'citekey_aliases'").get();
  if (!exists) return new Map();
  const map = new Map<string, string>();
  for (const row of db.prepare("SELECT biblio_key, citekey FROM citekey_aliases").all() as { biblio_key: string; citekey: string }[]) {
    map.set(row.biblio_key.toLowerCase(), row.citekey);
  }
  return map;
}

/** The citekey to write for an old key: a saved alias, then the mirror, then the old key itself. */
export function citekeyResolver(db: DB, catalogue: BiblioRecord[] = []): (key: string) => string {
  const aliases = aliasMap(db);
  const works = citedWorks(db);
  return (key: string) => aliases.get(key.trim().toLowerCase()) ?? resolveBiblioKey(key, works, catalogue) ?? key.trim();
}

export interface CitekeyChange { from: string; to: string; count: number }
export interface CitekeyReport { quotes: number; markers: number; resolved: number; kept: number; keys: CitekeyChange[] }

const ROLLBACK = new Error("dry run");

/**
 * Rewrites `[bib]` markers in quote text and comments. A resolved key is remembered, so a later import
 * writes the same citekey without the catalogue. `--dry-run` reports the rewrite and saves nothing.
 */
export function canonicalizeCitekeys(db: DB, { dryRun = false, catalogue = [], actor = "citekeys" }: { dryRun?: boolean; catalogue?: BiblioRecord[]; actor?: string } = {}): CitekeyReport {
  const works = citedWorks(db);
  const seen = new Map<string, CitekeyChange>();
  const resolve = (key: string) => {
    const from = key.trim();
    const to = resolveBiblioKey(from, works, catalogue) ?? from;
    const change = seen.get(from.toLowerCase()) ?? { from, to, count: 0 };
    change.count++;
    seen.set(from.toLowerCase(), change);
    return to;
  };
  const report: CitekeyReport = { quotes: 0, markers: 0, resolved: 0, kept: 0, keys: [] };
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS citekey_aliases (biblio_key TEXT PRIMARY KEY COLLATE NOCASE, citekey TEXT NOT NULL)`);
      const save = db.prepare(`INSERT INTO citekey_aliases (biblio_key, citekey) VALUES (?, ?)
        ON CONFLICT (biblio_key) DO UPDATE SET citekey = excluded.citekey`);
      const history = db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'citekeys', ?, ?, ?, ?)");
      const stamp = now();
      const rows = db.prepare("SELECT id, text, comment FROM quotes WHERE text LIKE '%[bib]%' OR comment LIKE '%[bib]%'").all() as { id: number; text: string; comment: string | null }[];
      for (const row of rows) {
        const text = citekeysIn(row.text, resolve);
        const comment = row.comment == null ? null : citekeysIn(row.comment, resolve);
        if (text === row.text && comment === row.comment) continue;
        report.quotes++;
        if (text !== row.text) history.run(row.id, stamp, row.text, text, actor, "Drupal [bib] citekey rewritten as a Pandoc citekey");
        if (comment !== row.comment) history.run(row.id, stamp, row.comment, comment, actor, "Drupal [bib] citekey rewritten as a Pandoc citekey");
        db.prepare("UPDATE quotes SET text = ?, text_key = ?, comment = ?, updated_at = ?, updated_by = ? WHERE id = ?")
          .run(text, quoteKey(text), comment, stamp, actor, row.id);
      }
      for (const change of seen.values()) {
        report.markers += change.count;
        if (change.to.toLowerCase() === change.from.toLowerCase()) report.kept += change.count;
        else {
          report.resolved += change.count;
          save.run(change.from, change.to);
        }
      }
      report.keys = [...seen.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
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
