import { type AuditRecord, auditStore, beyond, passageRef, words } from "./audit.js";
import { type DB, NEXT_QUOTE_ID, now } from "./db.js";
import { rebuildSearch } from "./import.js";
import { PAGE_REFERENCE, type ParsedNote } from "./parse.js";
import { quoteKey } from "./text.js";

/**
 * Repairs typed quotes from their stored raw, by the pattern they were typed to (src/parse.ts). Only a clean reading is
 * applied. A record that's off the pattern, edited by a person, or verified against a book isn't touched: it's listed for
 * a person to decide. Every change gets a history entry. A record holding several passages keeps its id for the first; each
 * other becomes a new quote with the same work, tags, and history, and an origin that links back to it.
 */

export interface Repair { id: number; why: string[]; before: AuditRecord["stored"] & { status: string }; after: { text: string; locator: string | null; comment: string | null; status: string }[]; newIds: number[]; existingIds: number[]; removedConcepts: string[] }
export interface ForPerson { id: number; status: string; why: string; text: string; reading: { text?: string; locator?: string; comment?: string }[] }
export interface RepairResult { repairs: Repair[]; forPerson: ForPerson[]; checked: number; alreadyRight: number }

const statusOf = (p: ParsedNote) => (p.grade === "C" ? "unparsed" : "transcribed");
const excerpt = (r: AuditRecord): ForPerson["reading"] => r.parsed.map((p) => ({ text: p.text, locator: p.locator, comment: p.comment }));

/** A reading may not lose words the source has: that would be a slip in the parser, not a repair. */
function losesWords(r: AuditRecord): string[] {
  const kept = r.parts.map((p) => [p.text, p.commentary, p.chapterAuthor].filter(Boolean).join(" ")).join(" ");
  return beyond(words(r.plain.replace(PAGE_REFERENCE, " ")), words(`${kept} ${r.chapterAuthor ?? ""}`));
}

/** Copies what a new part keeps of the record it came from: tags, tag removals, and history. Marks go with the words they mark. */
function carryOver(db: DB, from: number, to: number, parts: ParsedNote[], index: number): void {
  db.prepare("INSERT INTO quote_tags (quote_id, tag, concept_id, origin) SELECT ?, tag, concept_id, origin FROM quote_tags WHERE quote_id = ?").run(to, from);
  db.prepare("INSERT INTO tag_removals (quote_id, tag, by, at, reason) SELECT ?, tag, by, at, reason FROM tag_removals WHERE quote_id = ?").run(to, from);
  db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) SELECT ?, at, kind, before, after, actor, reason FROM history WHERE quote_id = ? ORDER BY id").run(to, from);
  const inPart = (phrase: string, p: ParsedNote) => (p.text ?? "").replace(/\*/g, "").toLowerCase().includes(phrase.replace(/\*/g, "").toLowerCase());
  for (const k of db.prepare("SELECT phrase, tag, concept_id FROM quote_kwic WHERE quote_id = ?").all(from) as { phrase: string; tag: string; concept_id: number | null }[]) {
    if (!inPart(k.phrase, parts[index]) || inPart(k.phrase, parts[0])) continue;
    db.prepare("INSERT OR IGNORE INTO quote_kwic (quote_id, phrase, tag, concept_id) VALUES (?, ?, ?, ?)").run(to, k.phrase, k.tag, k.concept_id);
    db.prepare("DELETE FROM quote_kwic WHERE quote_id = ? AND phrase = ? AND tag = ?").run(from, k.phrase, k.tag);
  }
}

const ROLLBACK = new Error("dry run");

/** Applies clean readings to the store, or with dryRun reports them and saves nothing. `only` applies one record, even a flagged one, as a person's decision. */
export function repairQuotes(db: DB, { dryRun, only, actor = "repair" }: { dryRun?: boolean; only?: number; actor?: string } = {}): RepairResult {
  const stamp = now();
  const result: RepairResult = { repairs: [], forPerson: [], checked: 0, alreadyRight: 0 };
  const flaggedKinds = ["held", "marks_off_pattern", "no_marks", "passage_gone"] as const;
  try {
    db.transaction(() => {
      const history = db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const r of auditStore(db).records) {
        result.checked++;
        if (only !== undefined && r.id !== only) continue;
        const flagged = flaggedKinds.filter((k) => r.kinds.includes(k));
        // A record that reads right can still be held back as unparsed, from when it couldn't be read cleanly.
        const needsStatus = r.status === "unparsed" && r.parts.length > 0 && r.parts.every((p) => statusOf(p) === "transcribed");
        const concepts = r.otherConcepts.length > 0 || r.otherPage;
        if (r.matches && !flagged.length && !needsStatus && !concepts) {
          result.alreadyRight++;
          continue;
        }
        const list = (why: string) => result.forPerson.push({ id: r.id, status: r.status, why, text: r.stored.text, reading: excerpt(r) });
        if (r.kinds.includes("passage_gone")) {
          list("passage_gone");
          continue;
        }
        if (r.edited || r.status === "verified") {
          // A person's work, or checked against the book: only worth a person's look when the raw reads differently.
          if (!r.matches) list(r.edited ? "edited" : "verified");
          else if (flagged.length) list(flagged[0]);
          else result.alreadyRight++;
          continue;
        }
        if (flagged.length && only === undefined) {
          list(flagged[0]);
          continue;
        }
        const lost = losesWords(r);
        if (lost.length) {
          list(`the reading would lose words: ${lost.slice(0, 8).join(" ")}`);
          continue;
        }
        // Words the record has and its source doesn't came from somewhere else, and a repair would delete them.
        if (r.added.length) {
          list(`the record has words its source doesn't: ${r.added.slice(0, 8).join(" ")}`);
          continue;
        }
        const parts = r.parts;
        const first = parts[0];
        // More words before the marks than inside them: a note that quotes a phrase, not a quote with a lead-in.
        if (only === undefined && first.flags.includes("lead_in") && (first.commentary ?? "").length > (first.text ?? "").length) {
          list("more words before the marks than inside them");
          continue;
        }
        const row = db.prepare("SELECT status, flags, chapter_author, locator_kind, work_id, attribution, source_url, created_at, created_by FROM quotes WHERE id = ?").get(r.id) as
          { status: string; flags: string; chapter_author: string | null; locator_kind: "page" | "kindle" | "none"; work_id: number | null; attribution: string | null; source_url: string | null; created_at: string; created_by: string | null };
        // One source can give the words and another the place: a place isn't taken away, or changed in kind, because this source has
        // none, unless it's the page of another passage in the note.
        const locator = first.locator ?? (parts.length === 1 && r.stored.locator && row.locator_kind !== "none" && !r.otherPage ? { kind: row.locator_kind, value: r.stored.locator, raw: "" } : undefined);
        const same = !concepts && parts.length === 1 && first.text === r.stored.text && (locator?.value ?? null) === r.stored.locator && (first.commentary ?? null) === r.stored.comment && statusOf(first) === r.status;
        if (same) {
          result.alreadyRight++;
          continue;
        }
        const keepOcr = (JSON.parse(row.flags) as string[]).includes("ocr_suspect") ? ["ocr_suspect"] : [];
        const after = parts.map((p, i) => ({ text: p.text ?? "", locator: (i === 0 ? locator : p.locator)?.value ?? null, comment: p.commentary ?? null, status: statusOf(p) }));
        const repair: Repair = { id: r.id, why: r.kinds, before: { ...r.stored, status: r.status }, after, newIds: [], existingIds: [], removedConcepts: r.otherConcepts };
        // A concept from a Zotero note or another span goes; one the record got any other way, a person's, stays.
        for (const tag of r.otherConcepts) db.prepare("DELETE FROM quote_tags WHERE quote_id = ? AND tag = ? AND origin IN ('title', 'note', 'span')").run(r.id, tag);
        db.prepare(`UPDATE quotes SET text = ?, text_key = ?, locator_kind = ?, locator = ?, chapter_author = ?, comment = ?, status = ?, grade = ?, flags = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
          .run(after[0].text, quoteKey(after[0].text), locator?.kind ?? "none", locator?.value ?? null, first.chapterAuthor ?? row.chapter_author, after[0].comment, after[0].status, first.grade ?? null,
            JSON.stringify([...new Set([...first.flags, ...keepOcr])]), stamp, actor, r.id);
        for (const [i, part] of parts.entries()) {
          if (i === 0) continue;
          // The passage may have a quote already: an earlier import's, or the old site's own record of it. It isn't made twice.
          const existing = r.origins.map((o) => db.prepare("SELECT quote_id FROM quote_origins WHERE kind = ? AND ref = ?").pluck().get(o.kind, passageRef(o, i + 1)) as number | undefined).find((x) => x !== undefined)
            ?? (quoteKey(part.text).length >= 20 ? db.prepare("SELECT id FROM quotes WHERE text_key = ? AND id != ? AND (work_id IS ? OR work_id IS NULL OR ? IS NULL) ORDER BY id LIMIT 1").pluck().get(quoteKey(part.text), r.id, row.work_id, row.work_id) as number | undefined : undefined);
          if (existing !== undefined) {
            repair.existingIds.push(existing);
            // The span's concepts cover all its passages, so this quote gets them too, unless a person took one off.
            db.prepare(`INSERT OR IGNORE INTO quote_tags (quote_id, tag, concept_id, origin) SELECT @to, t.tag, t.concept_id, t.origin FROM quote_tags t WHERE t.quote_id = @from AND t.origin IN ('span', 'title', 'note')
              AND NOT EXISTS (SELECT 1 FROM tag_removals r WHERE r.quote_id = @to AND r.tag = t.tag)`).run({ to: existing, from: r.id });
            for (const o of r.origins) db.prepare("INSERT OR IGNORE INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES (?, ?, ?, ?, ?, ?)").run(o.kind, passageRef(o, i + 1), existing, o.version ?? null, o.raw, stamp);
            db.prepare("INSERT OR IGNORE INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES ('split', ?, ?, NULL, ?, ?)").run(`${r.id}#${i + 1}`, existing, r.raw, stamp);
            history.run(existing, stamp, "split_from", JSON.stringify(repair.before), JSON.stringify(after[i]), actor, `passage ${i + 1} of quote ${r.id}, which already had this quote`);
            continue;
          }
          const { id } = db.prepare(`INSERT INTO quotes (id, kind, work_id, text, text_key, locator_kind, locator, chapter_author, comment, attribution, source_url, status, grade, flags, created_at, created_by, updated_at, updated_by)
            VALUES (${NEXT_QUOTE_ID}, 'quote', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(row.work_id, after[i].text, quoteKey(after[i].text), part.locator?.kind ?? "none", part.locator?.value ?? null,
            part.chapterAuthor ?? null, after[i].comment, row.attribution, row.source_url, after[i].status, part.grade ?? null, JSON.stringify(part.flags), row.created_at, row.created_by, stamp, actor) as { id: number };
          repair.newIds.push(id);
          carryOver(db, r.id, id, parts, i);
          // Back to the record it came from, and to the note's passage, so a later change to the note finds it.
          db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES ('split', ?, ?, NULL, ?, ?)").run(`${r.id}#${i + 1}`, id, r.raw, stamp);
          for (const o of r.origins) {
            db.prepare("INSERT OR IGNORE INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES (?, ?, ?, ?, ?, ?)").run(o.kind, passageRef(o, i + 1), id, o.version ?? null, o.raw, stamp);
          }
          history.run(id, stamp, "split_from", JSON.stringify(repair.before), JSON.stringify(after[i]), actor, `passage ${i + 1} of quote ${r.id}, read again from ${r.origin.kind} ${r.origin.ref}`);
        }
        const others = [...repair.newIds, ...repair.existingIds];
        history.run(r.id, stamp, others.length ? "split" : "repaired", JSON.stringify({ ...repair.before, concepts: r.otherConcepts }), JSON.stringify(after[0]), actor,
          `read again from ${r.origin.kind} ${r.origin.ref}${others.length ? `; its other passages are now quotes ${others.join(", ")}` : ""}${r.otherConcepts.length ? `; concepts of another passage removed: ${r.otherConcepts.join(", ")}` : ""}`);
        result.repairs.push(repair);
      }
      if (result.repairs.length) rebuildSearch(db);
      if (dryRun) throw ROLLBACK;
    }).immediate();
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return result;
}
