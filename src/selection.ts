import type { DB } from "./db.js";
import { now } from "./db.js";
import { ToolError } from "./common.js";
import { readProvenance } from "./provenance.js";

/**
 * Which records the public site shows without a person choosing them (docs/public-site.md, "Chosen by a person").
 *
 * A quote saved because a piece cites it is a citation; one the owner chose to keep is a collected passage. The
 * store can't read purpose, but it knows who saved a quote (its provenance stamp) and whether the words are a
 * whole sentence. So, unless a person has promoted it:
 *
 *   - a record a generative agent saved (generative: true) isn't public: choosing what the collection shows is the
 *     owner's judgement, not an agent's;
 *   - a quote that is part of a sentence isn't public unless a person saved it (generative: false), since saving it
 *     by hand was the choice. Where nothing says who saved it (a Zotero note), it's left out.
 *
 * Promoting is a person's act, from the admin pages or the CLI, never an MCP tool. It is kept in the quote's
 * history ('promoted', and 'unpromoted' to take it back), so who chose it and when stays on the record. Nothing is
 * deleted: a hidden quote keeps its id, its citation, and every marker that names it.
 */

/** The book text kept with a verified quote's anchor: what comes just before and after the words. */
interface Context { prefix?: unknown; suffix?: unknown }

export interface SentenceBounds {
  /** The words begin where a sentence begins. */
  starts: boolean;
  /** The words end where a sentence ends. */
  ends: boolean;
  /** source: from the book text around a verified quote; shape: from the words alone (a paper book's quote). */
  judged_by: "source" | "shape";
}

const OPENERS = `\\s"'“‘(\\[*_`;
const CLOSERS = `"'”’)\\]*_`;
const ELLIPSIS = new RegExp(`^[${OPENERS}]*(\\.\\.\\.|…)`, "u");
const SHAPE_START = new RegExp(`^[${OPENERS}]*[\\p{Lu}\\p{N}]`, "u");
const SHAPE_END = new RegExp(`[.!?…][${CLOSERS}]*\\s*$`, "u");
/** Before the words: the end of a sentence (its stop, and any closing quote or bracket), or a line break. */
const ENDED_BEFORE = new RegExp(`[.!?…][${CLOSERS}]*\\s*$`, "u");
const BREAK_BEFORE = /\n\s*$/;
/** After words with no stop of their own: the sentence's stop, the only thing left out. */
const STOP_AFTER = new RegExp(`^[${CLOSERS}]*[.!?…]`, "u");
/** After a stop: a lowercase word means the stop was an abbreviation's ("e.g. the"), not the sentence's end. */
const LOWER_AFTER = new RegExp(`^[${CLOSERS}]*\\s*\\p{Ll}`, "u");

const shapeStarts = (text: string) => SHAPE_START.test(text) && !ELLIPSIS.test(text);
const shapeEnds = (text: string) => SHAPE_END.test(text) && !/(\.\.\.|…)[\s"'”’)\]*_]*$/u.test(text);

/**
 * Whether a quote's words start and end at sentence boundaries. A verified quote is anchored in the book, so the text
 * around it decides: "collaboration consists in generating possibility." is a whole clause, but the book's text
 * before it runs on from a sentence already begun. Where the anchor has no text on a side (the passage starts at the
 * top of a page, or there's no anchor: a paper book's quote), the words' shape is the best guess for that side.
 */
export function sentenceBounds(text: string, anchor: Context | null): SentenceBounds {
  const words = text.trim();
  const prefix = typeof anchor?.prefix === "string" && anchor.prefix.length ? anchor.prefix : null;
  const suffix = typeof anchor?.suffix === "string" && anchor.suffix.length ? anchor.suffix : null;
  const starts = shapeStarts(words) && (prefix === null || ENDED_BEFORE.test(prefix) || BREAK_BEFORE.test(prefix));
  const ends = suffix === null
    ? shapeEnds(words)
    : (shapeEnds(words) && !LOWER_AFTER.test(suffix)) || (!SHAPE_END.test(words) && STOP_AFTER.test(suffix));
  return { starts, ends, judged_by: prefix !== null || suffix !== null ? "source" : "shape" };
}

export const isWholeSentence = (b: SentenceBounds) => b.starts && b.ends;

export interface Promotion { by: string; at: string; reason: string | null }

export interface PublicChoice {
  /** Whether the public site shows it (at the quotes level, and for a note only with notes: all). */
  shown: boolean;
  reason: string;
  /** Set when a person promoted it, and hasn't taken that back. */
  promoted: Promotion | null;
  /** For a quote: whether its words are a whole sentence, and how that was judged. */
  sentence: SentenceBounds | null;
}

interface Row { id: number; kind: string; text: string; provenance: unknown }

/** Decides for each record; built once per snapshot, so its statements are prepared once. */
export function publicChooser(db: DB): (q: Row) => PublicChoice {
  const lastPromotion = db.prepare(`SELECT kind, actor, at, reason FROM history WHERE quote_id = ? AND kind IN ('promoted', 'unpromoted')
    ORDER BY id DESC LIMIT 1`);
  const anchorOf = db.prepare(`SELECT json_extract(raw, '$.anchor') FROM quote_origins WHERE quote_id = ? AND kind IN ('agent', 'corpus')
    AND json_extract(raw, '$.anchor') IS NOT NULL ORDER BY imported_at DESC LIMIT 1`).pluck();
  return (q) => {
    const last = lastPromotion.get(q.id) as { kind: string; actor: string | null; at: string; reason: string | null } | undefined;
    const promoted = last?.kind === "promoted" ? { by: last.actor ?? "unknown", at: last.at, reason: last.reason } : null;
    let sentence: SentenceBounds | null = null;
    if (q.kind === "quote") {
      const raw = anchorOf.get(q.id) as string | undefined;
      sentence = sentenceBounds(q.text, raw ? (JSON.parse(raw) as Context) : null);
    }
    if (promoted) return { shown: true, reason: `Promoted by ${promoted.by}.`, promoted, sentence };
    const generative = readProvenance(q.provenance)?.generative ?? null;
    if (generative === true) {
      return { shown: false, reason: "Saved by a generative agent: it stays off the public site until a person promotes it.", promoted, sentence };
    }
    if (sentence && !isWholeSentence(sentence) && generative !== false) {
      const part = !sentence.starts && !sentence.ends ? "begins and ends mid-sentence" : !sentence.starts ? "begins mid-sentence" : "ends mid-sentence";
      return { shown: false, reason: `Part of a sentence (it ${part}, judged from ${sentence.judged_by === "source" ? "the book's text" : "its words"}), and not saved by a person: it stays off the public site until a person promotes it.`, promoted, sentence };
    }
    return { shown: true, reason: generative === false ? "Saved by a person." : "A whole sentence, not saved by an agent.", promoted, sentence };
  };
}

/** The public choice for one record. */
export function publicChoice(db: DB, id: number): PublicChoice {
  const q = db.prepare("SELECT id, kind, text, provenance FROM quotes WHERE id = ?").get(id) as Row | undefined;
  if (!q) throw new ToolError(`No quote or note ${id}.`);
  return publicChooser(db)(q);
}

/**
 * Promotes a record to the public site, or with `undo` takes a promotion back (the record then follows the rules
 * above again). A person's act: the admin pages and the CLI call it, and no MCP tool does. Returns the choice after.
 */
export function promote(db: DB, id: number, actor: string, o: { undo?: boolean; reason?: string } = {}): PublicChoice {
  return db.transaction(() => {
    const before = publicChoice(db, id);
    if (!o.undo === !!before.promoted) return before;
    const kind = o.undo ? "unpromoted" : "promoted";
    const reason = o.reason?.trim() || (o.undo ? "Promotion taken back" : "Promoted to the public site");
    db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, now(), kind, JSON.stringify({ shown: before.shown }), null, actor, reason);
    return publicChoice(db, id);
  })();
}
