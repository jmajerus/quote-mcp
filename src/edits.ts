import { type CorpusClient, conceptOf } from "./capture.js";
import { ToolError } from "./common.js";
import { type DB, now } from "./db.js";
import { type ProposalFields as Fields, getQuote, locatorText, proposal } from "./queries.js";
import { quoteKey } from "./text.js";

/**
 * Agents' changes to quotes already saved (docs/dev-briefs/holdings-and-quotes.md §2.5; PLAN.md "Quoted text
 * is protected"). Tags and comments an agent changes directly. A change to a quote's text, locator, or chapter
 * author is a proposal that a person accepts or rejects (the CLI's `proposals`); accepting one applies it as a
 * person's edit. An agent deletes only a quote an agent saved, or one taken over from corpus-mcp: an imported
 * quote's source would bring it back. Every change goes into history, before and after.
 */

const MAX_TEXT = 2000;
const MAX_NOTE = 4000;

function history(db: DB, id: number, kind: string, before: unknown, after: unknown, actor: string, reason: string): void {
  const str = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
  db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, now(), kind, str(before), str(after), actor, reason);
}

function refreshFts(db: DB, id: number): void {
  db.prepare("DELETE FROM quotes_fts WHERE rowid = ?").run(id);
  db.prepare(`INSERT INTO quotes_fts (rowid, text, comment, tags) SELECT id, text, COALESCE(comment, ''),
    COALESCE((SELECT group_concat(tag, ' ') FROM quote_tags WHERE quote_id = quotes.id), '') FROM quotes WHERE id = ?`).run(id);
}

function quoteRow(db: DB, id: number): Record<string, unknown> {
  const q = db.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!q) throw new ToolError(`No quote or note ${id}.`);
  return q;
}

const clean = (tags: string[] | undefined) => [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))];

export interface UpdateQuoteArgs { id: number; comment?: string | null; add_tags?: string[]; remove_tags?: string[]; reason?: string }

/** Changes a quote's tags or comment. A removed tag stays off through re-imports; a changed comment marks the quote edited, so a re-import keeps it. */
export function updateQuote(db: DB, args: UpdateQuoteArgs, actor: string) {
  const add = clean(args.add_tags);
  const remove = clean(args.remove_tags);
  const both = add.filter((t) => remove.some((r) => r.toLowerCase() === t.toLowerCase()));
  if (both.length) throw new ToolError(`${both.join(", ")} is both added and removed.`);
  if (!add.length && !remove.length && args.comment === undefined) throw new ToolError("Nothing to change: give comment, add_tags, or remove_tags.");
  const why = args.reason?.trim() || "update_quote";
  return db.transaction(() => {
    const q = quoteRow(db, args.id);
    const stamp = now();
    const changed: string[] = [];
    if (args.comment !== undefined) {
      if (q.kind === "note") throw new ToolError(`${args.id} is a note: its words are a person's own, so they aren't changed by an agent.`);
      const comment = args.comment?.trim() || null;
      if (comment && comment.length > MAX_NOTE) throw new ToolError(`The comment is ${comment.length} characters; the limit is ${MAX_NOTE}.`);
      if (comment !== ((q.comment as string | null) ?? null)) {
        db.prepare("UPDATE quotes SET comment = ?, edited = 1, updated_at = ?, updated_by = ? WHERE id = ?").run(comment, stamp, actor, args.id);
        history(db, args.id, "comment_changed", q.comment, comment, actor, why);
        changed.push("comment");
      }
    }
    const tagsBefore = db.prepare("SELECT tag FROM quote_tags WHERE quote_id = ? ORDER BY tag").pluck().all(args.id) as string[];
    for (const tag of remove) {
      if (db.prepare("DELETE FROM quote_tags WHERE quote_id = ? AND tag = ?").run(args.id, tag).changes) changed.push(`-${tag}`);
      db.prepare("INSERT INTO tag_removals (quote_id, tag, by, at, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET by = excluded.by, at = excluded.at, reason = excluded.reason")
        .run(args.id, tag, actor, stamp, args.reason?.trim() || null);
    }
    for (const tag of add) {
      db.prepare("DELETE FROM tag_removals WHERE quote_id = ? AND tag = ?").run(args.id, tag);
      if (db.prepare("INSERT OR IGNORE INTO quote_tags (quote_id, tag, concept_id, origin) VALUES (?, ?, ?, 'agent')").run(args.id, tag, conceptOf(db, tag)).changes) changed.push(`+${tag}`);
    }
    const tagsAfter = db.prepare("SELECT tag FROM quote_tags WHERE quote_id = ? ORDER BY tag").pluck().all(args.id) as string[];
    if (tagsAfter.join("\n") !== tagsBefore.join("\n")) {
      db.prepare("UPDATE quotes SET updated_at = ?, updated_by = ? WHERE id = ?").run(stamp, actor, args.id);
      history(db, args.id, "tags_changed", tagsBefore, tagsAfter, actor, why);
    }
    if (changed.length) refreshFts(db, args.id);
    return { changed, quote: getQuote(db, args.id) };
  })();
}

export interface ProposeArgs { id: number; text?: string; locator?: string | null; chapter_author?: string | null; rationale: string; evidence?: string }

/** A locator as given ("p. 211", "211-212", "Kindle loc. 208") as the store keeps it: its kind and value. */
function parseLocator(locator: string | null): { kind: string; value: string | null } {
  const l = locator?.trim() || "";
  if (!l) return { kind: "none", value: null };
  const kindle = /^kindle(?:\s+loc(?:ation)?\.?)?\s*(.+)$/i.exec(l);
  if (kindle) return { kind: "kindle", value: kindle[1].trim() };
  return { kind: "page", value: l.replace(/^pp?\.\s*/i, "") };
}

const fieldsOf = (q: Record<string, unknown>): Required<Fields> => ({
  text: q.text as string, locator: locatorText(q.locator_kind as string, q.locator as string | null), chapter_author: (q.chapter_author as string | null) ?? null,
});

/** Proposes a change to a quote's text, locator, or chapter author, for a person to accept or reject. */
export function proposeFix(db: DB, args: ProposeArgs, actor: string) {
  const rationale = args.rationale?.trim();
  if (!rationale) throw new ToolError("Say why: give a rationale.");
  return db.transaction(() => {
    const q = quoteRow(db, args.id);
    const now_ = fieldsOf(q);
    const change: Fields = {};
    if (args.text !== undefined) {
      const text = args.text.trim();
      if (q.kind === "note") throw new ToolError(`${args.id} is a note, with no quoted text.`);
      if (!text) throw new ToolError("The proposed text is empty.");
      if (text.length > MAX_TEXT) throw new ToolError(`The proposed text is ${text.length} characters; the limit is ${MAX_TEXT}.`);
      if (q.status === "verified") throw new ToolError(`${args.id} was checked against its Calibre book, so its text is the book's. To quote a different passage, save it with add_quote.`);
      if (text !== now_.text) change.text = text;
    }
    if (args.locator !== undefined) {
      const l = parseLocator(args.locator);
      const proposed = locatorText(l.kind, l.value);
      if (proposed !== now_.locator) change.locator = proposed;
    }
    if (args.chapter_author !== undefined) {
      const author = args.chapter_author?.trim() || null;
      if (author !== now_.chapter_author) change.chapter_author = author;
    }
    if (!Object.keys(change).length) throw new ToolError("Nothing to propose: the quote already has what was given.");
    const before = Object.fromEntries(Object.keys(change).map((k) => [k, now_[k as keyof Fields]]));
    const id = db.prepare(`INSERT INTO proposals (quote_id, change, before, rationale, evidence, proposer, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).pluck().get(args.id, JSON.stringify(change), JSON.stringify(before), rationale, args.evidence?.trim() || null, actor, now()) as number;
    history(db, args.id, "proposed", before, change, actor, `proposal ${id}: ${rationale}`);
    return { proposal: proposal(db, id) };
  })();
}

/**
 * Accepts or rejects a pending proposal. Accepting applies it as a person's edit (the quote is marked edited, so
 * re-imports leave it alone), unless the quote has changed since in a field the proposal touches.
 */
export function reviewProposal(db: DB, id: number, decision: "accept" | "reject", reviewer: string, note?: string) {
  return db.transaction(() => {
    const p = proposal(db, id);
    if (p.status !== "pending") throw new ToolError(`Proposal ${id} was already ${p.status}.`);
    const stamp = now();
    if (decision === "accept") {
      const q = quoteRow(db, p.quote_id);
      const current = fieldsOf(q);
      const stale = (Object.keys(p.before) as (keyof Fields)[]).filter((k) => current[k] !== p.before[k]);
      if (stale.length) throw new ToolError(`Quote ${p.quote_id}'s ${stale.join(" and ")} changed after proposal ${id} was made; reject it, and propose again from the quote as it is.`);
      const c = p.change;
      if (c.text !== undefined) db.prepare("UPDATE quotes SET text = ?, text_key = ? WHERE id = ?").run(c.text, quoteKey(c.text), p.quote_id);
      if (c.locator !== undefined) {
        const l = parseLocator(c.locator);
        db.prepare("UPDATE quotes SET locator_kind = ?, locator = ? WHERE id = ?").run(l.kind, l.value, p.quote_id);
        // A page settles no_locator, and kindle_locator (a Kindle location where a page is wanted); none brings no_locator back.
        let flags = (JSON.parse(q.flags as string) as string[]).filter((f) => f !== "no_locator" && !(f === "kindle_locator" && l.kind === "page"));
        if (!l.value) flags = [...flags, "no_locator"];
        db.prepare("UPDATE quotes SET flags = ? WHERE id = ?").run(JSON.stringify(flags), p.quote_id);
      }
      if (c.chapter_author !== undefined) db.prepare("UPDATE quotes SET chapter_author = ? WHERE id = ?").run(c.chapter_author, p.quote_id);
      db.prepare("UPDATE quotes SET edited = 1, updated_at = ?, updated_by = ? WHERE id = ?").run(stamp, reviewer, p.quote_id);
      history(db, p.quote_id, "edited", p.before, c, reviewer, `accepted proposal ${id} by ${p.proposer}: ${p.rationale}${note ? ` (${note})` : ""}`);
      refreshFts(db, p.quote_id);
    } else {
      history(db, p.quote_id, "proposal_rejected", null, null, reviewer, `rejected proposal ${id} by ${p.proposer}${note ? `: ${note}` : ""}`);
    }
    db.prepare("UPDATE proposals SET status = ?, reviewer = ?, review_note = ?, reviewed_at = ? WHERE id = ?")
      .run(decision === "accept" ? "accepted" : "rejected", reviewer, note?.trim() || null, stamp, id);
    return { proposal: proposal(db, id), quote: getQuote(db, p.quote_id) };
  })();
}

/**
 * Deletes a quote an agent saved or took over from corpus-mcp, first dropping its anchor there. A quote with any
 * other origin (a Zotero note, the old site) is refused: the next import would bring it back from its source.
 * The quote as it was goes into history, which a deleted quote keeps.
 */
export async function deleteQuote(db: DB, corpus: CorpusClient | null, id: number, reason: string, actor: string) {
  const why = reason?.trim();
  if (!why) throw new ToolError("Say why: give a reason.");
  const q = getQuote(db, id);
  const origins = q.origins as { kind: string; ref: string }[];
  const imported = origins.filter((o) => o.kind !== "agent" && o.kind !== "corpus");
  if (imported.length) {
    throw new ToolError(`Quote ${id} came from ${imported.map((o) => `${o.kind} ${o.ref}`).join(", ")}, which the import reads again; delete it there (or change its tags and comment here) instead.`);
  }
  if (corpus) await corpus.dropAnchor(id);
  db.transaction(() => {
    history(db, id, "deleted", q, null, actor, why);
    db.prepare("DELETE FROM quotes_fts WHERE rowid = ?").run(id);
    db.prepare("DELETE FROM quotes WHERE id = ?").run(id);
  })();
  return { deleted: id, anchor_dropped: Boolean(corpus), ...(corpus ? {} : { warning: "corpus-mcp is off here (CORPUS_BASE), so any anchor it keeps for this quote wasn't dropped." }) };
}
