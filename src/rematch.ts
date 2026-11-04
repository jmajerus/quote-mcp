import type { DB } from "./db.js";
import { now } from "./db.js";
import { creators, workMatcher } from "./import.js";
import { shareAuthor } from "./text.js";

/**
 * Matches works to Zotero from what the store holds, without reading any source again: every work not matched yet, and
 * any whose Zotero item has gone (merged into another, or deleted). A match whose item is still there stands. The rules
 * are the import's (workMatcher): short title, then shared author, full title, and year.
 *
 * Moving a work moves its quotes, keeping their ids and history, with a history entry for each. Its old id stays an
 * origin of the new work, so a key made from it (holdings-mcp's quote:<id>) still resolves.
 */

interface Row { id: number; title: string; authors: string; year: string | null; match: string; zotero_key: string | null; candidates: string | null; quotes: number }

export interface WorkChange { work: number; title: string; from: string; to: string; quotes: number }
export interface AuthorMismatch { title: string; authors: string[]; zotero: string; creators: string[] }
export interface RematchResult { checked: number; changes: WorkChange[]; authorMismatches: AuthorMismatch[]; works: Record<string, number> }

const ROLLBACK = new Error("dry run");

/** Runs `work` in a transaction, and with dryRun puts everything back afterwards. */
function transact(db: DB, dryRun: boolean | undefined, work: () => void): void {
  try {
    db.transaction(() => {
      work();
      if (dryRun) throw ROLLBACK;
    }).immediate();
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

export function rematchWorks(db: DB, { primary, dryRun, actor = "rematch" }: { primary: string; dryRun?: boolean; actor?: string }): RematchResult {
  const result: RematchResult = { checked: 0, changes: [], authorMismatches: [], works: {} };
  const stamp = now();
  transact(db, dryRun, () => {
    const { primaryByKey, candidates, zoteroWork, setOrigin } = workMatcher(db, primary, stamp);
    // An empty mirror would read as every item gone, so it stops here.
    if (!primaryByKey.size) throw new Error(`The Zotero mirror has no items for ${primary}, so there's nothing to match against. Run an import first.`);
    // Gone means the mirror says so: an item it has never seen isn't taken for a deleted one.
    const rows = db.prepare(`SELECT w.id, w.title, w.authors, w.year, w.match, w.zotero_key, w.candidates, (SELECT COUNT(*) FROM quotes WHERE work_id = w.id) AS quotes
      FROM works w WHERE w.match != 'zotero' OR (w.zotero_library = @primary AND EXISTS (SELECT 1 FROM zotero_items z WHERE z.library = @primary AND z.key = w.zotero_key AND z.deleted = 1))
      ORDER BY w.id`).all({ primary }) as Row[];
    const history = db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'work_matched', ?, ?, ?, ?)");
    const moveQuotes = db.prepare("UPDATE quotes SET work_id = ?, updated_at = ?, updated_by = ? WHERE id = ?");
    for (const w of rows) {
      result.checked++;
      const was = w.match === "zotero" ? `zotero ${w.zotero_key}` : w.match;
      const authors = JSON.parse(w.authors) as string[];
      const hits = candidates(w.title, w.year, authors);
      let is: string;
      if (hits.length === 1) {
        const { key, data } = hits[0];
        is = `zotero ${key}`;
        const made = creators(data);
        if (authors.length && !shareAuthor(authors, made)) result.authorMismatches.push({ title: w.title, authors, zotero: key, creators: made });
        const id = zoteroWork(primary, key, data);
        const reason = `matched by rematch: ${was} became ${is}`;
        for (const q of db.prepare("SELECT id FROM quotes WHERE work_id = ?").pluck().all(w.id) as number[]) {
          moveQuotes.run(id, stamp, actor, q);
          history.run(q, stamp, JSON.stringify({ work: w.id, match: was }), JSON.stringify({ work: id, match: is }), actor, reason);
        }
        db.prepare("UPDATE work_origins SET work_id = ? WHERE work_id = ?").run(id, w.id);
        setOrigin.run("work", String(w.id), id);
        db.prepare("DELETE FROM works WHERE id = ?").run(w.id);
      } else {
        is = hits.length ? "ambiguous" : "unmatched";
        const list = hits.length ? JSON.stringify(hits.map((h) => h.key)) : null;
        if (is === was && list === w.candidates) continue;
        db.prepare("UPDATE works SET match = ?, candidates = ?, zotero_library = NULL, zotero_key = NULL, updated_at = ? WHERE id = ?").run(is, list, stamp, w.id);
      }
      if (is !== was) result.changes.push({ work: w.id, title: w.title, from: was, to: is, quotes: w.quotes });
    }
    for (const r of db.prepare("SELECT match, COUNT(*) AS n FROM works w WHERE EXISTS (SELECT 1 FROM quotes WHERE work_id = w.id) GROUP BY match").all() as { match: string; n: number }[]) {
      result.works[r.match] = r.n;
    }
  });
  return result;
}

export interface YearsResult { read: number; withYear: number; filled: number; alreadySet: number; matched: number; notHere: number }

/**
 * Saves the old site's years on the works that keep their own details: an unmatched or ambiguous work, whose year is
 * empty. A work matched to Zotero has its item's year, and a year already there stays. Safe to run again.
 */
export function takeOldSiteYears(db: DB, years: { nid: number; year: string | null }[], { dryRun }: { dryRun?: boolean } = {}): YearsResult {
  const result: YearsResult = { read: years.length, withYear: years.filter((y) => y.year).length, filled: 0, alreadySet: 0, matched: 0, notHere: 0 };
  // None at all means the query or the column has changed, not that the site has none.
  if (years.length && !result.withYear) throw new Error(`None of the old site's ${years.length} works has a year it could read, so nothing was saved. Has a column changed?`);
  const stamp = now();
  transact(db, dryRun, () => {
    const find = db.prepare("SELECT w.id, w.match, w.year FROM work_origins o JOIN works w ON w.id = o.work_id WHERE o.kind = 'drupal' AND o.ref = ?");
    const fill = db.prepare("UPDATE works SET year = ?, updated_at = ? WHERE id = ?");
    for (const { nid, year } of years) {
      if (!year) continue;
      const w = find.get(String(nid)) as { id: number; match: string; year: string | null } | undefined;
      if (!w) result.notHere++;
      else if (w.match === "zotero") result.matched++;
      else if (w.year) result.alreadySet++;
      else {
        fill.run(year, stamp, w.id);
        result.filled++;
      }
    }
  });
  return result;
}
