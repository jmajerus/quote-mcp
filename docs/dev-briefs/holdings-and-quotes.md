# holdings-mcp, and corpus-mcp's quotes

**Status: proposed 2026-11-02, copied from holdings-mcp. §1 is built
(2026-11-02, `src/holdings.ts`), and §2.1 (`src/capture.ts`); the rest waits. The plan of
record is holdings-mcp's [PLAN.md](https://github.com/jmajerus/holdings-mcp/blob/main/PLAN.md).**

A review of corpus-mcp, quote-mcp, and terminology-mcp found that an agent
using the Authoring MCP portal still has to know which repository holds a
book or a quote. Two changes fix that:

- **holdings-mcp**, a new service, gives one lookup over every work
  (`find_work`, `get_work`), keyed by Zotero item key and citekey, saying
  which holdings each has: text in Calibre, quotes, notes.
- **quote-mcp becomes the only quote store**, as this repo's PLAN.md
  already decided ("Corpus quotes", phase 6). This brief turns that section
  into work, and adds what holdings-mcp needs.

The rule behind both: records have one home; capabilities stay with the
material. A quote is the same record from an ebook or a paper book; only the
evidence differs. corpus-mcp's check against Calibre text is evidence that
quote-mcp asks for, not a second store.

## 1. Counts feed for holdings-mcp (holdings phase 2)

`GET /api/holdings/counts`, on the LAN, with an ETag; one entry per work
that has quotes or notes:

```json
{
  "version": 1,
  "works": [
    { "zotero": { "library": "users/123", "key": "ABCD1234" }, "citekey": "roberts1993victory",
      "quotes": 12, "notes": 1, "verified": 0 },
    { "work_id": 417, "match": "unmatched", "title": "…", "authors": ["…"], "year": "1987",
      "quotes": 4, "notes": 0, "verified": 0 },
    { "work_id": 52, "match": "ambiguous", "candidates": ["users/123/EFGH5678", "users/123/IJKL9012"],
      "title": "…", "authors": ["…"], "year": "2001", "quotes": 7, "notes": 0, "verified": 0 }
  ]
}
```

- A work matched to one Zotero item is sent by its item. holdings-mcp keys it
  `zotero:<library>/<key>`.
- An `unmatched` or `ambiguous` work is sent by its id with its title,
  authors, and year. holdings-mcp keys it `quote:<work id>` until it's filed
  or the edition is chosen. About 200 works are in this state, most of them
  paper books, so they matter: without them `find_work` misses most of what's
  on the shelf.
- `unparsed` records aren't counted.
- `search_quotes`'s `work` argument accepts `quote:<id>` and
  `zotero:<library>/<key>` as well as a citekey or item key, so a key from
  `find_work` works unchanged.

As built:

- Every entry has `work_id` and `match`, matched works included, as
  holdings-mcp asked. When a work is filed in Zotero, the import moves its
  quotes to the Zotero item's work and deletes the old one, so the matched
  entry's `work_id` is a new id; `former_work_ids` lists the ids filed into
  it, for holdings-mcp's `former_keys`. The import records them as
  `work_origins` of kind `work`, and `quote:<former id>` keeps finding the
  quotes in `search_quotes`.
- The ETag is strong (a hash of the body), with `Cache-Control: no-cache`;
  `If-None-Match` with it answers 304. `HEAD` works too.
- On the LAN only: through Cloudflare Access the path answers 404.
- A work can be matched and also be a candidate of an ambiguous work (a
  note filed it to one edition while an old-site work still has two).
  holdings-mcp gets both entries.

## 2. Taking corpus-mcp's quotes (holdings phase 3)

This repo's phases 2 and 4 already plan the pieces. In the order that stops
new quotes landing in corpus-mcp soonest:

1. **`add_quote`** (phase 4). For a work that has a Calibre book, it calls
   corpus-mcp's `POST /api/verify` (book, text, optional page). On a match,
   it stores the book's exact wording, status `verified`, origin `agent` or
   `capture`, then `POST /api/anchors` with the new quote id. With no match
   it returns corpus-mcp's closest passages and saves nothing, as
   `save_quote` does now. A work with no Calibre book is saved
   `transcribed`, as planned.
   As built, on the contract agreed with corpus-mcp (2026-11-02):

   - `add_quote(work, text, page?, comment?, tags?, request_id?)`. `work`
     is any key: `zotero:<library>/<key>`, `quote:<id>`, a citekey, a
     Zotero item key, or a Calibre book id or UUID.
   - `POST /api/verify` with `book` as `zotero:<library>/<key>` (or the
     citekey, for an item outside the library corpus-mcp mirrors). The
     answers carry the book as its books-feed entry. A match saves the
     book's wording, and the page from `locator` (an EPUB's section goes in
     the comment); `exact: false` is noted in the quote's history.
     `404 no-book` or `no-text` saves it `transcribed`; `409 ambiguous`
     saves nothing and lists the books. A Calibre book not in Zotero
     becomes an `unmatched` work, found again by its UUID (`work_origins`
     of kind `calibre`). The counts feed sends its `calibre_uuid`, so
     holdings-mcp joins it to the book's work.
   - `POST /api/anchors` after the save. On `409 stale-anchor` it verifies
     again once. If corpus-mcp can't take it, the quote is flagged
     `anchor_missing`, and each import posts it again.
   - A retry with the same `request_id`, or the same words for the same
     work, returns the quote already saved, before asking corpus-mcp, so a
     retry works while corpus-mcp is down. `quote:<id>` for a work made for
     a Calibre book is checked against that book again.
   - The server's store stays read-only; `add_quote` writes through its
     own connection. `CORPUS_BASE` (default
     `http://corpus-mcp.localdomain:8000`; `off` saves every quote
     transcribed).
   - The import's OCR check leaves verified quotes alone.
   - Not yet: `DELETE /api/anchors/<id>` when a quote is deleted or moved
     (quote-mcp has no tool for either yet), and following
     `/api/anchors/changes` (§2.4).

2. **The `cited-article` skill** (in corpus-mcp's `skills/`) switches to
   `add_quote` and this repo's `cite_quote`. `cite_quote` needs what the
   skill uses from corpus-mcp's: the quote as reflowed prose, and the BibTeX
   for filing a book not yet in Zotero (which comes from corpus-mcp's
   `cite_passage` until it's filed, as this repo's PLAN.md says).

   As agreed with corpus-mcp (2026-11-03): the skill calls `add_quote`,
   then this repo's `cite_quote` for the quote and its citation, then
   corpus-mcp's `cite_passage` (by `book.book_id`) for filing data when
   `zotero` or `citekey` is null. `pin_citekey` stays with corpus-mcp.
   For a quote checked against a Calibre book, `cite_quote` gives `quote`
   as prose (corpus-mcp's `reflow`, copied exactly), `book` (verify's book)
   and `position` (`section`, `page_label`), which the quote's origin
   keeps. `add_quote`'s answer carries `book` too.
3. **Import corpus-mcp's five quotes**, origin `corpus`, status `verified`,
   tags exactly as written (`project:on-curiosity`, `test:standalone-article`
   are tags that aren't concepts). The Calibre books behind them may not be
   in Zotero yet; they arrive as `unmatched` works.

   As built: `quote-mcp take-corpus-quotes --skip 2` reads corpus-mcp's
   `GET /api/quotes`, checks each quote's `text` against its Calibre UUID
   through `POST /api/verify` (corpus-mcp asked for that over posting its
   stored anchors), saves it as `add_quote` does with origin `corpus` (ref:
   its corpus-mcp id, so a re-run skips it; its record kept in the raw),
   its note as the comment and its labels as tags, and posts the new
   anchor. A quote whose words the work already has (say, saved by an
   agent) is still checked, and taken over: it gains the `corpus` origin
   and the tags, keeps its own text, and gets the new anchor. It prints
   the old and new ids for corpus-mcp, which then
   deletes its rows. `--dry-run` shows what it would take.
4. **Follow the anchors.** corpus-mcp's `GET /api/anchors/changes?since=N`
   reports re-anchored, orphaned, and found-again quotes. An orphaned anchor
   keeps the quote `verified` (it was checked) and adds a flag, proposed
   `anchor_lost`, to the worklist; a person decides.

   As built: each import, after posting missing anchors again, reads the
   changes after the change number kept in `meta` (`corpus_anchor_seq`,
   with the `log` id it belongs to; a new log id reads from 0, which is
   safe since a change applied twice changes nothing). `orphaned` flags the
   quote `anchor_lost` (worklist queue `anchor_lost`; `cite_quote` warns);
   `found`, `stored`, `replaced` or `reanchored` clears it. Each anchor
   corpus-mcp sends replaces the one kept with the quote's origin.
   `deleted` changes nothing here, and changes for quotes this store
   doesn't have are passed over. History records `anchor_lost` and
   `anchor_found`. `anchor_missing` has a worklist queue too.
5. **Writes from agents beyond `add_quote`.** corpus-mcp's `update_quote`
   (note and tags) and `delete_quote` retire, so their equivalents land
   here with the rest of phase 2's editing: tag and comment changes by
   agents, text and locator changes as proposals.

   As built (`src/edits.ts`, schema 4), as MCP tools beside `add_quote`:
   - `update_quote(id, comment?, add_tags?, remove_tags?, reason?)` changes
     tags and the comment directly, with history. A removed tag is kept in
     `tag_removals`, so a re-import doesn't put back one the Zotero note
     still has; a changed comment marks the quote edited, so a re-import
     keeps it. A note's words aren't changed by an agent.
   - `propose_quote_fix(id, text?, locator?, chapter_author?, rationale,
     evidence?)` adds a row to `proposals`, shown in `get_quote`, the
     `proposals` worklist queue, and the admin pages. A verified quote's
     text is the book's and isn't proposed. A person reviews them with
     `quote-mcp proposals [--accept n | --reject n] [--note …]`; accepting
     applies the change as their edit, unless the quote changed since.
   - `delete_quote(id, reason)` deletes a quote whose origins are all
     `agent` or `corpus`, after `DELETE /api/anchors/<id>`; an imported one
     is refused, since its source would bring it back. The quote as it was
     stays in history.

### corpus-mcp's reader (corpus-mcp's §3.4)

corpus-mcp's book reader keeps highlighting quotes from its anchors, and links
each one to `/admin/quotes/<id>` here; it doesn't keep a list of quotes. Two
routes serve it, on the LAN only (a 404 through Access), in `src/corpus-api.ts`:

- `GET /api/corpus/quotes?book=<calibre_uuid or book_id>`: the quotes checked
  against that book, as `{ book, quotes: [{ id, kind, text, prose, comment,
  tags, status, flags, locator, anchor, admin_path }] }`. `flags` shows
  `anchor_lost`; `anchor` is the one kept with the quote's origin, which
  follows the anchor changes feed.
- `POST /api/corpus/quotes` (`application/json`): `add_quote`'s arguments
  (`work`, `text`, `page?` as a string or a number, `comment?`, `tags?`,
  `request_id?`; `null` is the same as left out) plus `by?`,
  the person saving, recorded as `corpus-mcp:<by>`. Same verification, work
  and duplicate handling as `add_quote`; the answer is `add_quote`'s, `201`
  when saved and `200` when it already was. A miss is `422 { error:
  "no-match", message, closest, book }`, several books `422 { error:
  "ambiguous", books }`, a bad body `400`, and corpus-mcp unreachable `502`.

## 3. Concept sets to terminology-mcp (holdings phase 5)

terminology-mcp holds `human-work`, and already stores concept sets with
versioned expansion. Its `list_sets` and this repo's `list_sets` now serve
different sets under one name. Moving `vocab/sets.json` there would:

- import the sets into terminology-mcp as `human-work`'s sets;
- have the subscriber apply `set-added`, `set-changed`, and `set-deleted`
  instead of ignoring them, so the `slug-in-sets` hold goes away;
- keep this repo's `list_sets` and `search_quotes`'s `set` argument, reading
  the replica, with quote counts added.

## 4. One Zotero mirror (holdings phase 4)

holdings-mcp will mirror the Zotero libraries, and corpus-mcp and this
repo can read items from it instead of each syncing zotero.org. Whether
holdings-mcp also mirrors notes, so this repo can drop its sync entirely,
is an open question in holdings-mcp's PLAN.md; until it's settled, the
note sync stays here.
