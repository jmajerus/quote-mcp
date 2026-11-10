import { type CorpusClient, conceptOf } from "./capture.js";
import { ToolError } from "./common.js";
import { type DB, now } from "./db.js";
import { type Suspect, addKnownWords, dictionaryForm, loadDictionary, suspectTokens } from "./ocr.js";
import { withoutEmphasis } from "./public.js";
import { type ProposalFields as Fields, conceptLabels, getQuote, locatorText, proposal } from "./queries.js";
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

/**
 * The tags a person wants on the quote, as the edit form lists them. A tag already there under the same concept
 * stays as it is. One left off is removed, and recorded so a re-import does not put it back. A name that is not a
 * concept yet is kept. Changing tags does not mark the quote edited.
 */
function replaceConcepts(db: DB, id: number, wanted: string[], actor: string, reason: string): string[] {
  const next: string[] = [];
  for (const raw of wanted) {
    const tag = raw.trim();
    if (tag && !next.some((t) => t.toLowerCase() === tag.toLowerCase())) next.push(tag);
  }
  const rows = db.prepare("SELECT tag FROM quote_tags WHERE quote_id = ? ORDER BY tag").all(id) as { tag: string }[];
  const same = (a: string, b: string) => {
    if (a.toLowerCase() === b.toLowerCase()) return true;
    const left = conceptOf(db, a);
    return left !== null && left === conceptOf(db, b);
  };
  const removed = rows.filter((row) => !next.some((tag) => same(row.tag, tag)));
  const added = next.filter((tag) => !rows.some((row) => same(row.tag, tag)));
  if (!removed.length && !added.length) return [];
  const stamp = now();
  const before = rows.map((row) => row.tag);
  const changed: string[] = [];
  for (const row of removed) {
    db.prepare("DELETE FROM quote_tags WHERE quote_id = ? AND tag = ?").run(id, row.tag);
    db.prepare("DELETE FROM quote_kwic WHERE quote_id = ? AND tag = ?").run(id, row.tag);
    db.prepare("INSERT INTO tag_removals (quote_id, tag, by, at, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET by = excluded.by, at = excluded.at, reason = excluded.reason")
      .run(id, row.tag, actor, stamp, reason);
    changed.push(`-${row.tag}`);
  }
  for (const tag of added) {
    db.prepare("DELETE FROM tag_removals WHERE quote_id = ? AND tag = ?").run(id, tag);
    db.prepare("INSERT OR IGNORE INTO quote_tags (quote_id, tag, concept_id, origin) VALUES (?, ?, ?, 'person')").run(id, tag, conceptOf(db, tag));
    changed.push(`+${tag}`);
  }
  const after = db.prepare("SELECT tag FROM quote_tags WHERE quote_id = ? ORDER BY tag").pluck().all(id) as string[];
  db.prepare("UPDATE quotes SET updated_at = ?, updated_by = ? WHERE id = ?").run(stamp, actor, id);
  history(db, id, "tags_changed", before, after, actor, reason);
  refreshFts(db, id);
  return changed;
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
 * chapter_author, which asks a person to check the chapter author, is settled by a person setting it. A new text
 * is checked for suspect words again, so a corrected misspelling drops ocr_suspect.
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
  if (c.text !== undefined) settleOcr(db, id);
  refreshFts(db, id);
}

/** The word list plus words a person has accepted, or null when there is no word list to check against. */
function checkingDictionary(db: DB): Set<string> | null {
  try {
    const dict = new Set(loadDictionary());
    for (const word of db.prepare("SELECT word FROM ocr_words").pluck().all() as string[]) dict.add(word);
    addKnownWords(dict, conceptLabels(db));
    return dict;
  } catch {
    return null;
  }
}

/** Whether the suspect's token is still a word in the text, not a substring of a longer one. */
function tokenPresent(text: string, token: string): boolean {
  const body = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z])${body}(?:[^A-Za-z]|$)`, "i").test(text);
}

/**
 * Writes this quote's suspect words from its text. A corrected word drops out. With no word list, only words
 * that have left the text drop out. An unknown word already in three quotes stays out, as the import leaves it:
 * that is a word the list lacks, not the same error made once.
 */
function settleOcr(db: DB, id: number): void {
  const q = db.prepare("SELECT kind, text, status, flags, suspects FROM quotes WHERE id = ?").get(id) as { kind: string; text: string; status: string; flags: string; suspects: string } | undefined;
  if (!q || q.kind !== "quote") return;
  const previous = JSON.parse(q.suspects) as Suspect[];
  const seen = new Set(previous.map((s) => s.token.toLowerCase()));
  const dict = checkingDictionary(db);
  const accepted = new Set((db.prepare("SELECT word FROM ocr_words").pluck().all() as string[]).map((w) => w.toLowerCase()));
  const fresh = dict ? suspectTokens(q.text, dict) : previous.filter((s) => tokenPresent(q.text, s.token) && !accepted.has(dictionaryForm(s.token)));
  const found = fresh.filter((s) => {
    if (!tokenPresent(q.text, s.token)) return false;
    if (s.reason !== "unknown" || seen.has(s.token.toLowerCase())) return true;
    const n = db.prepare("SELECT COUNT(*) FROM quotes WHERE kind = 'quote' AND lower(text) LIKE ?").pluck().get(`%${dictionaryForm(s.token)}%`) as number;
    return n < 3;
  });
  let flags = (JSON.parse(q.flags) as string[]).filter((f) => f !== "ocr_suspect");
  if (found.length) flags.push("ocr_suspect");
  if (JSON.stringify(found) === q.suspects && JSON.stringify(flags) === q.flags) return;
  const grade = q.status === "unparsed" ? "C" : flags.some((f) => f !== "no_locator") ? "B" : "A";
  db.prepare("UPDATE quotes SET suspects = ?, flags = ?, grade = ? WHERE id = ?").run(JSON.stringify(found), JSON.stringify(flags), grade, id);
}

/** Quotes whose stored suspects name this word, so accepting it clears them all. */
function quotesSuspecting(db: DB, word: string): number[] {
  return (db.prepare("SELECT id FROM quotes WHERE kind = 'quote' AND lower(suspects) LIKE ?").pluck().all(`%${word}%`) as number[]);
}

/**
 * Remembers unknown suspect words a person has accepted as real. Only a word this quote already flags as
 * unknown is kept; anything else in the form is ignored. Returns the words newly treated as real.
 */
function rememberWords(db: DB, q: Record<string, unknown>, words: string[], actor: string): string[] {
  const suspects = JSON.parse(q.suspects as string) as Suspect[];
  const saved: string[] = [];
  const insert = db.prepare("INSERT INTO ocr_words (word, accepted_by, accepted_at) VALUES (?, ?, ?) ON CONFLICT (word) DO NOTHING");
  for (const raw of words) {
    const hit = suspects.find((s) => s.reason === "unknown" && s.token.toLowerCase() === raw.trim().toLowerCase());
    if (!hit || hit.token.includes(" ")) continue;
    const word = dictionaryForm(hit.token);
    if (!word) continue;
    insert.run(word, actor, now());
    saved.push(word);
  }
  return saved;
}

/** Accepts one unknown suspect word on this quote as real, and clears it on every quote that flagged it. */
export function acceptOcrWord(db: DB, id: number, word: string, actor: string) {
  return db.transaction(() => {
    const q = quoteRow(db, id);
    const saved = rememberWords(db, q, [word], actor);
    if (!saved.length) throw new ToolError(`${word.trim() || "That"} isn't an unknown word on this quote.`);
    for (const accepted of saved) for (const quote of quotesSuspecting(db, accepted)) settleOcr(db, quote);
    const stamp = now();
    db.prepare("UPDATE quotes SET updated_at = ?, updated_by = ? WHERE id = ?").run(stamp, actor, id);
    history(db, id, "ocr_word", null, saved[0], actor, `Accepted "${saved[0]}" as a word`);
    return { word: saved[0], quote: getQuote(db, id) };
  })();
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

export interface EditArgs { id: number; text?: string; locator?: string | null; chapter_author?: string | null; comment?: string | null; reason?: string; updated_at?: string; accept?: string[]; concepts?: string[] }

/**
 * A person's edit from the admin pages: fixing a typo, a page, a chapter author, the comment, or the concepts
 * attached to it. Only the fields that changed are written. A verified quote's words are the book's and stay
 * (fromBook says which marks a person may add). updated_at, when given, is the quote's as the form showed it; a
 * quote changed since is refused, so one edit doesn't undo another. A removed concept stays off through a
 * re-import. Changing only the concepts does not mark the quote edited, so a later import can still update its words.
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
    const accepted = rememberWords(db, q, args.accept ?? [], editor);
    const why = args.reason?.trim() || "edited on the admin pages";
    const concepts = args.concepts === undefined ? [] : replaceConcepts(db, args.id, args.concepts, editor, why);
    if (!keys.length && !accepted.length && !concepts.length) return { changed: [] as string[], quote: getQuote(db, args.id) };
    const stamp = now();
    if (keys.length) {
      applyFields(db, q, change, editor, stamp);
      history(db, args.id, "edited", Object.fromEntries(keys.map((k) => [k, now_[k]])), change, editor, why);
    }
    for (const word of accepted) {
      for (const quote of quotesSuspecting(db, word)) settleOcr(db, quote);
      history(db, args.id, "ocr_word", null, word, editor, `Accepted "${word}" as a word`);
    }
    if (accepted.length && !keys.length) db.prepare("UPDATE quotes SET updated_at = ?, updated_by = ? WHERE id = ?").run(stamp, editor, args.id);
    return { changed: [...keys, ...concepts, ...accepted.map((word) => `word:${word}`)] as string[], quote: getQuote(db, args.id) };
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
 * Deletes a quote an agent saved, one taken over from corpus-mcp, or one spoken on the capture page. An agent or
 * corpus quote drops its anchor there first. A capture quote never had one, so corpus-mcp is not called: this
 * quote's id must not remove an anchor that belongs to some other quote. A quote with any other origin (a Zotero
 * note, the old site) is refused: the next import would bring it back from its source.
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
  const anchored = Boolean(db.prepare("SELECT 1 FROM quote_origins WHERE quote_id = ? AND kind IN ('agent', 'corpus')").get(id));
  if (corpus && anchored) await corpus.dropAnchor(id);
  // Checked again once corpus-mcp has answered: an import or an edit may have reached the quote meanwhile. Then it
  // stays, flagged anchor_missing when an anchor was dropped, so the next import posts that anchor again.
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
    if (corpus && anchored) {
      db.prepare(`UPDATE quotes SET flags = json_insert(flags, '$[#]', 'anchor_missing') WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(flags) WHERE value = 'anchor_missing')`).run(id);
    }
    throw kept === "changed" ? new ToolError(`Quote ${id} changed while it was being deleted, so it was kept; look at it again before deleting it.`) : refuse(kept);
  }
  return { deleted: id, anchor_dropped: Boolean(corpus && anchored), ...(corpus ? {} : { warning: "corpus-mcp is off here (CORPUS_BASE), so any anchor it keeps for this quote wasn't dropped." }) };
}
