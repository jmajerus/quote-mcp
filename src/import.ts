import { type DB, NEXT_QUOTE_ID, now } from "./db.js";
import { type Suspect, dropCommonUnknowns, suspectTokens } from "./ocr.js";
import { readMargin } from "./margin.js";
import { type ParsedNote, noteText, parseNote, readLocator } from "./parse.js";
import { fullTitle, normalizedTitle, quoteKey, shareAuthor, slugify, yearOf } from "./text.js";
import type { ApiItem } from "./zotero.js";

/**
 * The import: the old site's concepts, works, and quotes, then the quote notes in the Zotero mirror,
 * into the store. Safe to run again: every quote is keyed by its origin, a quote already imported is
 * re-parsed only if its source changed, and a quote a person has edited, or one checked against its book, is never overwritten (the
 * changed source goes into its history instead). A quote whose text arrives from a second source is
 * merged: it gains the origin and the tags, not a duplicate. A Zotero note tagged `margin` is a note,
 * not a quote: your own words, read for concept tags and kept as the record's comment.
 */

export const SCHEME = {
  slug: "human-work",
  label: "The human side of work",
  description: "Concepts from the Work Creatively site (workcreatively.org): themes in passages about people at work.",
};

/** The Zotero tag that makes a note a margin note. It opts a note in: agents' research notes stay out. */
export const MARGIN_TAG = "margin";

export interface ImportOptions {
  /** The library quotes cite: works are matched to its items. */
  primary: string;
  /** Libraries whose quote notes are imported, in order; the primary library should come first. */
  sources: string[];
  /** A word list for the OCR check; without one the check is skipped. */
  dictionary?: Set<string>;
  actor?: string;
}

export interface ImportStats {
  quotes: { added: number; updated: number; merged: number; unchanged: number; keptEdited: number };
  skipped: Record<string, number>;
  works: Record<string, number>;
  /** Works left with no quotes because their quotes followed a note to another work, whose old ids now name that work. */
  absorbed: { from: number; into: number; title: string }[];
  unresolvedTags: [string, number][];
  ocrSuspects: number;
}

interface Incoming {
  kind: "zotero-note";
  record?: "quote" | "note";
  ref: string;
  version: string | null;
  raw: string;
  parsed: ParsedNote;
  workId: number | null;
  tags: { tag: string; origin: string }[];
  attribution?: string | null;
}

interface QuoteRow { id: number; work_id: number | null; edited: number; status: string; locator: string | null; chapter_author: string | null; comment: string | null }

export function creators(data: ApiItem["data"]): string[] {
  const all = data.creators ?? [];
  const authors = all.filter((c) => c.creatorType === "author");
  return (authors.length ? authors : all).map((c) => c.name ?? [c.lastName, c.firstName].filter(Boolean).join(", "));
}

/** What matching a work needs, over the primary library's items as the mirror has them now. */
export function workMatcher(db: DB, primary: string, stamp: string) {
  const itemsOf = (library: string) => (db.prepare(`SELECT key, data FROM zotero_items WHERE library = ? AND deleted = 0 AND parent_key IS NULL
    AND item_type NOT IN ('note', 'attachment', 'annotation')`).all(library) as { key: string; data: string }[])
    .map((r) => ({ key: r.key, data: JSON.parse(r.data) as ApiItem["data"] }));
  const index = new Map<string, { key: string; data: ApiItem["data"] }[]>();
  const primaryByKey = new Map(itemsOf(primary).map((item) => [item.key, item]));
  for (const item of primaryByKey.values()) {
    const k = normalizedTitle(item.data.title);
    if (k) index.set(k, [...(index.get(k) ?? []), item]);
  }
  /** Primary-library items with this title, narrowed when the title repeats: by author, by the full title, subtitle included, then by year. */
  const candidates = (title: string, year: string | null, authors: string[]) => {
    let hits = index.get(normalizedTitle(title)) ?? [];
    const narrow = (keep: (h: (typeof hits)[number]) => boolean) => {
      const kept = hits.filter(keep);
      if (hits.length > 1 && kept.length) hits = kept;
    };
    narrow((h) => shareAuthor(authors, creators(h.data)));
    narrow((h) => fullTitle(h.data.title) === fullTitle(title));
    narrow((h) => !!year && yearOf(h.data.date) === year);
    return hits;
  };

  const workByOrigin = db.prepare("SELECT work_id FROM work_origins WHERE kind = ? AND ref = ?");
  const setOrigin = db.prepare(`INSERT INTO work_origins (kind, ref, work_id) VALUES (?, ?, ?)
    ON CONFLICT (kind, ref) DO UPDATE SET work_id = excluded.work_id`);
  const upsertZoteroWork = db.prepare(`
    INSERT INTO works (title, authors, year, item_type, isbn, url, zotero_library, zotero_key, match, created_at, updated_at)
    VALUES (@title, @authors, @year, @item_type, @isbn, @url, @library, @key, 'zotero', @stamp, @stamp)
    ON CONFLICT (zotero_library, zotero_key) DO UPDATE SET title = excluded.title, authors = excluded.authors, year = excluded.year,
      item_type = excluded.item_type, isbn = excluded.isbn, url = excluded.url, updated_at = excluded.updated_at
    RETURNING id`);
  const zoteroWork = (library: string, key: string, data: ApiItem["data"]): number => {
    const { id } = upsertZoteroWork.get({
      title: data.title ?? "(untitled)", authors: JSON.stringify(creators(data)), year: yearOf(data.date), item_type: data.itemType,
      isbn: data.ISBN || null, url: data.url || null, library, key, stamp,
    }) as { id: number };
    setOrigin.run("zotero", `${library}:${key}`, id);
    return id;
  };
  return { primaryByKey, candidates, zoteroWork, setOrigin, workByOrigin };
}

/** The search index, from the quotes as they are. */
export function rebuildSearch(db: DB): void {
  db.exec(`DELETE FROM quotes_fts;
    INSERT INTO quotes_fts (rowid, text, comment, tags)
    SELECT q.id, q.text, COALESCE(q.comment, ''), COALESCE((SELECT group_concat(tag, ' ') FROM quote_tags WHERE quote_id = q.id), '') FROM quotes q;`);
}

export function runImport(db: DB, opts: ImportOptions): ImportStats {
  const actor = opts.actor ?? "import";
  const stamp = now();
  const stats: ImportStats = {
    quotes: { added: 0, updated: 0, merged: 0, unchanged: 0, keptEdited: 0 },
    skipped: {}, works: {}, absorbed: [], unresolvedTags: [], ocrSuspects: 0,
  };
  const skip = (why: string) => (stats.skipped[why] = (stats.skipped[why] ?? 0) + 1);

  db.transaction(() => {
    // --- Concepts ---------------------------------------------------------------------------------
    db.prepare("INSERT OR IGNORE INTO schemes (slug, label, description, created_at) VALUES (?, ?, ?, ?)").run(SCHEME.slug, SCHEME.label, SCHEME.description, stamp);
    // Tags resolve to concepts by label first, then by alternative label, then by slug, ignoring case.
    const concepts = new Map<string, number>();
    const rows = db.prepare("SELECT id, slug, label, alt_labels FROM concepts WHERE status != 'retired'").all() as { id: number; slug: string; label: string; alt_labels: string }[];
    for (const c of rows) concepts.set(c.slug, c.id);
    for (const c of rows) for (const alt of JSON.parse(c.alt_labels) as string[]) concepts.set(alt.toLowerCase(), c.id);
    for (const c of rows) concepts.set(c.label.toLowerCase(), c.id);
    const conceptOf = (tag: string) => concepts.get(tag.toLowerCase()) ?? null;

    // --- Works ------------------------------------------------------------------------------------
    const { candidates, zoteroWork, setOrigin } = workMatcher(db, opts.primary, stamp);

    /** The work for a Zotero note's parent: the primary library's copy of it when there is exactly one. */
    const noteWork = (library: string, parentKey: string | null): number | null => {
      if (!parentKey) return null;
      const parent = db.prepare("SELECT data FROM zotero_items WHERE library = ? AND key = ?").get(library, parentKey) as { data: string } | undefined;
      if (!parent) return null;
      const data = JSON.parse(parent.data) as ApiItem["data"];
      if (library === opts.primary) return zoteroWork(library, parentKey, data);
      const hits = candidates(data.title ?? "", yearOf(data.date), creators(data));
      const id = hits.length === 1 ? zoteroWork(opts.primary, hits[0].key, hits[0].data) : zoteroWork(library, parentKey, data);
      setOrigin.run("zotero", `${library}:${parentKey}`, id);
      return id;
    };

    // --- Quotes -----------------------------------------------------------------------------------
    const getOrigin = db.prepare("SELECT quote_id, version, raw FROM quote_origins WHERE kind = ? AND ref = ?");
    const getQuote = db.prepare("SELECT id, work_id, edited, status, locator, chapter_author, comment FROM quotes WHERE id = ?");
    const findDuplicate = db.prepare("SELECT id, work_id, edited, status, locator, chapter_author, comment FROM quotes WHERE text_key = ? ORDER BY (work_id IS ?) DESC, id LIMIT 1");
    const addOrigin = db.prepare("INSERT INTO quote_origins (kind, ref, quote_id, version, raw, imported_at) VALUES (?, ?, ?, ?, ?, ?)");
    const updateOrigin = db.prepare("UPDATE quote_origins SET version = ?, raw = ?, imported_at = ? WHERE kind = ? AND ref = ?");
    // A tag someone took off the quote stays off, though its source still has it.
    const addTag = db.prepare(`INSERT OR IGNORE INTO quote_tags (quote_id, tag, concept_id, origin) SELECT @q, @tag, @concept, @origin
      WHERE NOT EXISTS (SELECT 1 FROM tag_removals WHERE quote_id = @q AND tag = @tag)`);
    const addKwic = db.prepare("INSERT OR IGNORE INTO quote_kwic (quote_id, phrase, tag, concept_id) VALUES (?, ?, ?, ?)");
    const addHistory = db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertQuote = db.prepare(`
      INSERT INTO quotes (id, kind, work_id, text, text_key, locator_kind, locator, chapter_author, comment, attribution, source_url, status, grade, flags,
        created_at, created_by, updated_at, updated_by)
      VALUES (${NEXT_QUOTE_ID}, @kind, @work_id, @text, @text_key, @locator_kind, @locator, @chapter_author, @comment, @attribution, @source_url, @status, @grade, @flags,
        @stamp, @actor, @stamp, @actor) RETURNING id`);
    const updateQuote = db.prepare(`
      UPDATE quotes SET kind = @kind, work_id = @work_id, text = @text, text_key = @text_key, locator_kind = @locator_kind, locator = @locator,
        chapter_author = @chapter_author, comment = @comment, attribution = @attribution, source_url = @source_url, status = @status,
        grade = @grade, flags = @flags, updated_at = @stamp, updated_by = @actor WHERE id = @id`);

    const fieldsOf = (q: Incoming) => {
      const p = q.parsed;
      return {
        kind: q.record ?? "quote", work_id: q.workId, text: p.text ?? "", text_key: quoteKey(p.text), locator_kind: p.locator?.kind ?? "none", locator: p.locator?.value ?? null,
        chapter_author: p.chapterAuthor ?? null, comment: p.commentary ?? null, attribution: q.attribution ?? null, source_url: p.sourceUrl ?? null,
        status: p.grade === "C" ? "unparsed" : "transcribed", grade: p.grade ?? null, flags: JSON.stringify(p.flags), stamp, actor,
      };
    };
    const tagAndMark = (quoteId: number, q: Incoming) => {
      for (const t of q.tags) addTag.run({ q: quoteId, tag: t.tag, concept: conceptOf(t.tag), origin: t.origin });
      for (const k of q.parsed.kwic) addKwic.run(quoteId, k.phrase, k.concept, conceptOf(k.concept));
    };

    // A note merged into another item in Zotero takes its quotes along, which can leave their old work empty.
    const moved = new Map<number, number>();
    const upsert = (q: Incoming) => {
      const origin = getOrigin.get(q.kind, q.ref) as { quote_id: number; version: string | null; raw: string } | undefined;
      const fields = fieldsOf(q);
      if (origin) {
        const quote = getQuote.get(origin.quote_id) as QuoteRow;
        if (origin.raw === q.raw && origin.version === q.version) {
          stats.quotes.unchanged++;
        } else if (quote.edited || quote.status === "verified") {
          // A quote checked against its book (taken over from corpus-mcp, say) keeps the book's words, its status,
          // and the anchor flags corpus-mcp's changes set, as an edited one keeps a person's work.
          addHistory.run(quote.id, stamp, "source_changed", origin.raw, q.raw, actor,
            `${q.kind} ${q.ref} changed; the quote was ${quote.edited ? "edited" : "checked against its book"}, so it was left alone`);
          updateOrigin.run(q.version, q.raw, stamp, q.kind, q.ref);
          stats.quotes.keptEdited++;
        } else {
          addHistory.run(quote.id, stamp, "reimported", origin.raw, q.raw, actor, `${q.kind} ${q.ref} changed`);
          updateQuote.run({ ...fields, id: quote.id });
          if (quote.work_id && q.workId && quote.work_id !== q.workId) {
            addHistory.run(quote.id, stamp, "work_matched", JSON.stringify({ work: quote.work_id }), JSON.stringify({ work: q.workId }), actor, `moved with ${q.kind} ${q.ref}`);
            moved.set(quote.work_id, q.workId);
          }
          updateOrigin.run(q.version, q.raw, stamp, q.kind, q.ref);
          stats.quotes.updated++;
        }
        tagAndMark(origin.quote_id, q);
        return;
      }
      const duplicate = fields.text_key.length >= 20 ? (findDuplicate.get(fields.text_key, q.workId) as QuoteRow | undefined) : undefined;
      if (duplicate) {
        addOrigin.run(q.kind, q.ref, duplicate.id, q.version, q.raw, stamp);
        if (!duplicate.edited) {
          // The second source fills what the first lacked; it never replaces what's there.
          db.prepare(`UPDATE quotes SET work_id = COALESCE(work_id, ?), locator_kind = CASE WHEN locator IS NULL THEN ? ELSE locator_kind END,
            locator = COALESCE(locator, ?), chapter_author = COALESCE(chapter_author, ?), updated_at = ? WHERE id = ?`)
            .run(q.workId, fields.locator_kind, fields.locator, fields.chapter_author, stamp, duplicate.id);
        }
        addHistory.run(duplicate.id, stamp, "origin_added", null, q.raw, actor, `also in ${q.kind} ${q.ref}`);
        tagAndMark(duplicate.id, q);
        stats.quotes.merged++;
        return;
      }
      const { id } = insertQuote.get(fields) as { id: number };
      addOrigin.run(q.kind, q.ref, id, q.version, q.raw, stamp);
      addHistory.run(id, stamp, "imported", null, q.raw, actor, `from ${q.kind} ${q.ref}`);
      tagAndMark(id, q);
      stats.quotes.added++;
    };

    /** A margin note's fields: a trailing locator, concept tags read from its words, and the rest as its comment. */
    const marginNote = (html: string, noteTags: string[]): Pick<Incoming, "parsed" | "tags"> | null => {
      const { body, locator, chapterAuthor } = readLocator(noteText(html));
      const reading = readMargin(body, conceptOf);
      const tags = [...noteTags.map((tag) => ({ tag, origin: "note" })), ...reading.tags.map((t) => ({ tag: t.tag, origin: "text" }))];
      if (!reading.prose && !tags.length && !locator) return null;
      return {
        parsed: { kind: "other", text: "", locator, chapterAuthor, commentary: reading.prose ?? undefined, titleTags: [], kwic: [], flags: [], problems: [] },
        tags,
      };
    };

    // Zotero notes, library by library: quote notes and margin notes.
    for (const library of opts.sources) {
      const notes = db.prepare("SELECT key, version, parent_key, data FROM zotero_items WHERE library = ? AND item_type = 'note' AND deleted = 0 ORDER BY key")
        .all(library) as { key: string; version: number; parent_key: string | null; data: string }[];
      /**
       * A note that used to hold more passages than it does now. The quote isn't deleted, since a person may have worked on it
       * and it may be the note that's wrong: it's flagged and recorded once, for a person to decide.
       */
      const passagesGone = (key: string, version: number, raw: string, kept: number) => {
        const prefix = `${library}:${key}#`;
        for (const o of db.prepare("SELECT ref, quote_id, raw FROM quote_origins WHERE kind = 'zotero-note' AND substr(ref, 1, ?) = ?").all(prefix.length, prefix) as { ref: string; quote_id: number; raw: string }[]) {
          if (Number(o.ref.slice(prefix.length)) <= kept || o.raw === raw) continue;
          const row = db.prepare("SELECT flags FROM quotes WHERE id = ?").get(o.quote_id) as { flags: string } | undefined;
          if (row) {
            db.prepare("UPDATE quotes SET flags = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(JSON.stringify([...new Set([...(JSON.parse(row.flags) as string[]), "passage_gone"])]), stamp, actor, o.quote_id);
            addHistory.run(o.quote_id, stamp, "source_changed", o.raw, raw, actor, `zotero-note ${o.ref} no longer holds this passage; the quote was left for a person`);
          }
          updateOrigin.run(String(version), raw, stamp, "zotero-note", o.ref);
        }
      };
      for (const n of notes) {
        const data = JSON.parse(n.data) as ApiItem["data"];
        const noteTags = (data.tags ?? []).map((t) => t.tag);
        if (noteTags.some((t) => t.toLowerCase() === MARGIN_TAG)) {
          const margin = marginNote(data.note ?? "", noteTags.filter((t) => t.toLowerCase() !== MARGIN_TAG));
          if (!margin) {
            skip("zotero margin note: empty");
            continue;
          }
          upsert({ kind: "zotero-note", record: "note", ref: `${library}:${n.key}`, version: String(n.version), raw: data.note ?? "", ...margin,
            workId: noteWork(library, n.parent_key) });
          passagesGone(n.key, n.version, data.note ?? "", 1);
          continue;
        }
        const parsed = parseNote(data.note ?? "", noteTags);
        if (parsed.kind !== "quote") {
          skip(`zotero note: ${parsed.kind}`);
          passagesGone(n.key, n.version, data.note ?? "", 1);
          continue;
        }
        const parts = [parsed, ...(parsed.more ?? [])];
        const lower = (tags: string[]) => tags.map((t) => t.toLowerCase());
        /** A part's concepts: the note's tags, less those that only another part's span names, and its own span's. */
        const tagsOf = (part: ParsedNote) => {
          const own = lower(part.titleTags);
          const elsewhere = new Set(parts.flatMap((p) => lower(p.titleTags)).filter((t) => !own.includes(t)));
          const titleOnly = part.titleTags.filter((t) => !noteTags.some((n2) => n2.toLowerCase() === t.toLowerCase()));
          return [...noteTags.filter((t) => !elsewhere.has(t.toLowerCase())).map((tag) => ({ tag, origin: "note" })), ...titleOnly.map((tag) => ({ tag, origin: "title" }))];
        };
        // A note already imported and unchanged stays as it is: only a changed or new note is divided (`quote-mcp repair` does the rest).
        const known = getOrigin.get("zotero-note", `${library}:${n.key}`) as { raw: string } | undefined;
        const unchanged = known?.raw === (data.note ?? "");
        upsert({ kind: "zotero-note", ref: `${library}:${n.key}`, version: String(n.version), raw: data.note ?? "", parsed, workId: noteWork(library, n.parent_key), tags: tagsOf(parsed) });
        if (!unchanged) {
          // A note with several passages: one quote each, with the concepts that are theirs.
          for (const [i, more] of (parsed.more ?? []).entries()) {
            upsert({ kind: "zotero-note", ref: `${library}:${n.key}#${i + 2}`, version: String(n.version), raw: data.note ?? "", parsed: more, workId: noteWork(library, n.parent_key), tags: tagsOf(more) });
          }
        }
        passagesGone(n.key, n.version, data.note ?? "", 1 + (parsed.more?.length ?? 0));
      }
    }

    // Tags and marks imported before their concept existed resolve now.
    const resolveTag = db.prepare("UPDATE quote_tags SET concept_id = ? WHERE quote_id = ? AND tag = ?");
    for (const t of db.prepare("SELECT quote_id, tag FROM quote_tags WHERE concept_id IS NULL").all() as { quote_id: number; tag: string }[]) {
      const id = conceptOf(t.tag);
      if (id) resolveTag.run(id, t.quote_id, t.tag);
    }
    const resolveKwic = db.prepare("UPDATE quote_kwic SET concept_id = ? WHERE quote_id = ? AND phrase = ? AND tag = ?");
    for (const k of db.prepare("SELECT quote_id, phrase, tag FROM quote_kwic WHERE concept_id IS NULL").all() as { quote_id: number; phrase: string; tag: string }[]) {
      const id = conceptOf(k.tag);
      if (id) resolveKwic.run(id, k.quote_id, k.phrase, k.tag);
    }

    // --- OCR check over every quote nobody has edited, and that wasn't checked against a book's text ---
    const all = db.prepare("SELECT id, text, status, flags, edited FROM quotes WHERE kind = 'quote'").all() as { id: number; text: string; status: string; flags: string; edited: number }[];
    const suspects = new Map<string, Suspect[]>();
    if (opts.dictionary) for (const q of all) suspects.set(String(q.id), suspectTokens(q.text, opts.dictionary));
    const kept = dropCommonUnknowns(suspects);
    const setOcr = db.prepare("UPDATE quotes SET suspects = ?, flags = ?, grade = ? WHERE id = ?");
    for (const q of all) {
      if (q.edited || q.status === "verified") continue;
      const found = kept.get(String(q.id)) ?? [];
      const flags = (JSON.parse(q.flags) as string[]).filter((f) => f !== "ocr_suspect");
      if (found.length) flags.push("ocr_suspect");
      const grade = q.status === "unparsed" ? "C" : flags.some((f) => f !== "no_locator") ? "B" : "A";
      setOcr.run(JSON.stringify(found), JSON.stringify(flags), grade, q.id);
      if (found.length) stats.ocrSuspects++;
    }

    // --- Works left empty -------------------------------------------------------------------------
    // An old id keeps naming the work its quotes went to (holdings-mcp's quote:<id>), as it does for a rematch. A work
    // emptied before this was kept has its old-site quotes to say where they went, when they all went to one place.
    const whereQuotesWent = db.prepare(`SELECT DISTINCT q.work_id FROM quote_origins o JOIN quotes q ON q.id = o.quote_id
      WHERE o.kind = 'drupal' AND o.ref LIKE ? AND q.work_id IS NOT NULL`).pluck();
    for (const w of db.prepare(`SELECT w.id, o.ref FROM works w JOIN work_origins o ON o.work_id = w.id AND o.kind = 'drupal'
      WHERE w.match != 'zotero' AND NOT EXISTS (SELECT 1 FROM quotes WHERE work_id = w.id)`).all() as { id: number; ref: string }[]) {
      const went = whereQuotesWent.all(`${w.ref}#%`) as number[];
      if (went.length === 1 && !moved.has(w.id)) moved.set(w.id, went[0]);
    }
    for (const [from, into] of moved) {
      const w = db.prepare("SELECT title FROM works WHERE id = ? AND match != 'zotero' AND NOT EXISTS (SELECT 1 FROM quotes WHERE work_id = works.id)").get(from) as { title: string } | undefined;
      if (!w) continue;
      db.prepare("UPDATE work_origins SET work_id = ? WHERE work_id = ?").run(into, from);
      setOrigin.run("work", String(from), into);
      db.prepare("DELETE FROM works WHERE id = ?").run(from);
      stats.absorbed.push({ from, into, title: w.title });
    }

    // --- Search index -----------------------------------------------------------------------------
    rebuildSearch(db);

    for (const r of db.prepare("SELECT match, COUNT(*) AS n FROM works w WHERE EXISTS (SELECT 1 FROM quotes WHERE work_id = w.id) GROUP BY match").all() as { match: string; n: number }[]) {
      stats.works[r.match] = r.n;
    }
    stats.unresolvedTags = (db.prepare("SELECT tag, COUNT(*) AS n FROM quote_tags WHERE concept_id IS NULL GROUP BY tag COLLATE NOCASE ORDER BY n DESC, tag").all() as { tag: string; n: number }[])
      .map((r) => [r.tag, r.n]);
  })();
  return stats;
}
