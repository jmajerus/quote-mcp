import { type CorpusClient, conceptOf } from "./capture.js";
import { ToolError } from "./common.js";
import { type DB, now } from "./db.js";
import { withoutEmphasis } from "./public.js";
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
 * Writes a person's change to a quote's text, locator, chapter author, or comment, marking it edited (re-imports
 * leave it alone). The flags the parser sets for these follow: no_locator and kindle_locator the new locator, and
 * chapter_author, which asks a person to check the chapter author, is settled by a person setting it.
 */
function applyFields(db: DB, q: Record<string, unknown>, c: Fields & { comment?: string | null }, editor: string, stamp: string): void {
  const id = q.id as number;
  let flags = JSON.parse(q.flags as string) as string[];
  if (c.text !== undefined) db.prepare("UPDATE quotes SET text = ?, text_key = ? WHERE id = ?").run(c.text, quoteKey(c.text), id);
  if (c.locator !== undefined) {
    const l = parseLocator(c.locator);
    db.prepare("UPDATE quotes SET locator_kind = ?, locator = ? WHERE id = ?").run(l.kind, l.value, id);
    flags = flags.filter((f) => f !== "no_locator" && f !== "kindle_locator");
    if (!l.value) flags.push("no_locator");
    else if (l.kind === "kindle") flags.push("kindle_locator");
  }
  if (c.chapter_author !== undefined) {
    db.prepare("UPDATE quotes SET chapter_author = ? WHERE id = ?").run(c.chapter_author, id);
    flags = flags.filter((f) => f !== "chapter_author");
  }
  if (c.comment !== undefined) db.prepare("UPDATE quotes SET comment = ? WHERE id = ?").run(c.comment, id);
  db.prepare("UPDATE quotes SET flags = ?, edited = 1, updated_at = ?, updated_by = ? WHERE id = ?").run(JSON.stringify(flags), stamp, editor, id);
  refreshFts(db, id);
}

/** Text compared loosely: spacing collapsed, and *emphasis* pairs' asterisks dropped, since they're a reader's mark. */
const plain = (t: string) => withoutEmphasis(t).replace(/\s+/g, " ").trim();
/** An omission: …, ..., or either in brackets. */
const ELLIPSIS = /\s*(?:\[\s*(?:…|\.\s?\.\s?\.)\s*\]|…|\.\s?\.\s?\.)\s*/g;
/** Punctuation a quoter drops beside an ellipsis ("facts, … men" for "facts, about daily men"). */
const EDGE = /^[\p{P}]+|[\p{P}]+$/gu;

/**
 * Whether a verified quote's text, as a person edited it, is still the book's words with only their own marks: [any
 * bracketed text] (a clarification, [sic], [emphasis added]), *emphasis* pairs, and an ellipsis for words left out.
 * Taking out the brackets and emphasis must leave the book's text, exactly, or with an ellipsis, whole words of it in
 * order with the omitted ones between (a word beside an ellipsis may lose its punctuation). Spacing doesn't count.
 */
export function fromBook(text: string, book: string): boolean {
  const parts = text.replace(ELLIPSIS, "\u0000").replace(/\s*\[[^\]]*\]/g, "").split("\u0000").map(plain);
  const whole = plain(book);
  if (parts.length === 1) return parts[0] === whole;
  const words = whole.split(" ");
  // Each part is a run of the book's words, after the previous part's; a word beside an ellipsis matches without its edge punctuation.
  const runAt = (part: string[], at: number, cutStart: boolean, cutEnd: boolean) => part.every((w, k) => {
    const loose = (k === 0 && cutStart) || (k === part.length - 1 && cutEnd);
    return loose ? w.replace(EDGE, "") === words[at + k]?.replace(EDGE, "") : w === words[at + k];
  });
  let from = 0;
  let found = 0;
  for (let n = 0; n < parts.length; n++) {
    if (!parts[n]) continue;
    const part = parts[n].split(" ");
    let at = from;
    while (at + part.length <= words.length && !runAt(part, at, n > 0, n < parts.length - 1)) at++;
    if (at + part.length > words.length) return false;
    from = at + part.length;
    found++;
  }
  return found > 0;
}

/**
 * A verified quote's text as the book has it: the passage kept with its newest anchor (the one followAnchors keeps
 * current), so an edit is checked against the book, not against an earlier edit that left words out.
 */
function bookText(db: DB, id: number, current: string): string {
  const raw = db.prepare(`SELECT raw FROM quote_origins WHERE quote_id = ? AND kind IN ('agent', 'corpus')
    AND json_extract(raw, '$.anchor.text') IS NOT NULL ORDER BY imported_at DESC, rowid DESC LIMIT 1`).pluck().get(id) as string | undefined;
  const anchored = raw ? (JSON.parse(raw) as { anchor: { text: string } }).anchor.text : undefined;
  if (anchored) return anchored;
  const added = db.prepare("SELECT after FROM history WHERE quote_id = ? AND kind = 'added' ORDER BY id LIMIT 1").pluck().get(id) as string | null | undefined;
  return added ?? current;
}

export interface EditArgs { id: number; text?: string; locator?: string | null; chapter_author?: string | null; comment?: string | null; reason?: string; updated_at?: string }

/**
 * A person's edit from the admin pages: fixing a typo, a page, a chapter author, or the comment. Only the fields that
 * changed are written. A verified quote's words are the book's and stay (fromBook says which marks a person may
 * add). updated_at, when given, is the quote's as the form showed it; a quote changed since is refused, so one edit
 * doesn't undo another.
 */
export function editQuote(db: DB, args: EditArgs, editor: string) {
  return db.transaction(() => {
    const q = quoteRow(db, args.id);
    if (args.updated_at !== undefined && args.updated_at !== q.updated_at) {
      throw new ToolError(`Quote ${args.id} changed after this form was opened (by ${q.updated_by ?? "someone"}); open it again and redo the edit.`);
    }
    const now_ = { ...fieldsOf(q), comment: (q.comment as string | null) ?? null };
    const change: Fields & { comment?: string | null } = {};
    if (args.text !== undefined && q.kind !== "note") {
      const text = args.text.replace(/\r\n/g, "\n").trim();
      if (!text) throw new ToolError("The text can't be empty.");
      if (text.length > MAX_TEXT) throw new ToolError(`The text is ${text.length} characters; the limit is ${MAX_TEXT}.`);
      if (text !== now_.text) {
        if (q.status === "verified" && !fromBook(text, bookText(db, args.id, now_.text))) {
          throw new ToolError(`Quote ${args.id} was checked against its Calibre book, so its words are the book's. Your own marks can be added: [brackets], *emphasis*, and … for words left out; spacing and line breaks can change. Anything else that changes the words is refused.`);
        }
        change.text = text;
      }
    }
    if (args.locator !== undefined) {
      const l = parseLocator(args.locator);
      const locator = locatorText(l.kind, l.value);
      if (locator !== now_.locator) change.locator = locator;
    }
    if (args.chapter_author !== undefined) {
      const author = args.chapter_author?.trim() || null;
      if (author !== now_.chapter_author) change.chapter_author = author;
    }
    if (args.comment !== undefined) {
      const comment = args.comment?.replace(/\r\n/g, "\n").trim() || null;
      if (comment && comment.length > MAX_NOTE) throw new ToolError(`The ${q.kind === "note" ? "note" : "comment"} is ${comment.length} characters; the limit is ${MAX_NOTE}.`);
      if (comment !== now_.comment) change.comment = comment;
    }
    const keys = Object.keys(change) as (keyof typeof change)[];
    if (!keys.length) return { changed: [] as string[], quote: getQuote(db, args.id) };
    const stamp = now();
    applyFields(db, q, change, editor, stamp);
    history(db, args.id, "edited", Object.fromEntries(keys.map((k) => [k, now_[k]])), change, editor, args.reason?.trim() || "edited on the admin pages");
    return { changed: keys as string[], quote: getQuote(db, args.id) };
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
      if (c.text !== undefined && q.status === "verified") {
        throw new ToolError(`Quote ${p.quote_id} was checked against its Calibre book after proposal ${id} was made, so its text is the book's; reject the proposal.`);
      }
      applyFields(db, q, c, reviewer, stamp);
      history(db, p.quote_id, "edited", p.before, c, reviewer, `accepted proposal ${id} by ${p.proposer}: ${p.rationale}${note ? ` (${note})` : ""}`);
    } else {
      history(db, p.quote_id, "proposal_rejected", null, null, reviewer, `rejected proposal ${id} by ${p.proposer}${note ? `: ${note}` : ""}`);
    }
    db.prepare("UPDATE proposals SET status = ?, reviewer = ?, review_note = ?, reviewed_at = ? WHERE id = ?")
      .run(decision === "accept" ? "accepted" : "rejected", reviewer, note?.trim() || null, stamp, id);
    return { proposal: proposal(db, id), quote: getQuote(db, p.quote_id) };
  })();
}

/**
 * Deletes a quote an agent saved, one taken over from corpus-mcp, or one spoken on the capture page, first dropping
 * its anchor there. A quote with any other origin (a Zotero note, the old site) is refused: the next import would
 * bring it back from its source.
 * The quote as it was goes into history, which a deleted quote keeps.
 */
export async function deleteQuote(db: DB, corpus: CorpusClient | null, id: number, reason: string, actor: string) {
  const why = reason?.trim();
  if (!why) throw new ToolError("Say why: give a reason.");
  const imported = (quoteId: number) =>
    db.prepare("SELECT kind || ' ' || ref FROM quote_origins WHERE quote_id = ? AND kind NOT IN ('agent', 'corpus', 'capture') ORDER BY kind, ref").pluck().all(quoteId) as string[];
  const refuse = (from: string[]) =>
    new ToolError(`Quote ${id} came from ${from.join(", ")}, which the import reads again; delete it there (or change its tags and comment here) instead.`);
  const q = getQuote(db, id);
  if (imported(id).length) throw refuse(imported(id));
  if (corpus) await corpus.dropAnchor(id);
  // Checked again once corpus-mcp has answered: an import or an edit may have reached the quote meanwhile. Then it
  // stays, flagged anchor_missing, so the next import posts the anchor kept with it again.
  const kept = db.transaction((): string[] | "gone" | "changed" | null => {
    const now_ = db.prepare("SELECT updated_at FROM quotes WHERE id = ?").pluck().get(id) as string | undefined;
    if (now_ === undefined) return "gone";
    const from = imported(id);
    if (from.length) return from;
    if (now_ !== q.updated_at) return "changed";
    history(db, id, "deleted", q, null, actor, why);
    db.prepare("DELETE FROM quotes_fts WHERE rowid = ?").run(id);
    db.prepare("DELETE FROM quotes WHERE id = ?").run(id);
    return null;
  })();
  if (kept === "gone") throw new ToolError(`Quote ${id} was deleted meanwhile.`);
  if (kept) {
    if (corpus) {
      db.prepare(`UPDATE quotes SET flags = json_insert(flags, '$[#]', 'anchor_missing') WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(flags) WHERE value = 'anchor_missing')`).run(id);
    }
    throw kept === "changed" ? new ToolError(`Quote ${id} changed while it was being deleted, so it was kept; look at it again before deleting it.`) : refuse(kept);
  }
  return { deleted: id, anchor_dropped: Boolean(corpus), ...(corpus ? {} : { warning: "corpus-mcp is off here (CORPUS_BASE), so any anchor it keeps for this quote wasn't dropped." }) };
}
