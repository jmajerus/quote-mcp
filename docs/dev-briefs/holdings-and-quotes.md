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
3. **Import corpus-mcp's five quotes**, origin `corpus`, status `verified`,
   tags exactly as written (`project:on-curiosity`, `test:standalone-article`
   are tags that aren't concepts). The Calibre books behind them may not be
   in Zotero yet; they arrive as `unmatched` works.
4. **Follow the anchors.** corpus-mcp's `GET /api/anchors/changes?since=N`
   reports re-anchored, orphaned, and found-again quotes. An orphaned anchor
   keeps the quote `verified` (it was checked) and adds a flag, proposed
   `anchor_lost`, to the worklist; a person decides.
5. **Writes from agents beyond `add_quote`.** corpus-mcp's `update_quote`
   (note and tags) and `delete_quote` retire, so their equivalents land
   here with the rest of phase 2's editing: tag and comment changes by
   agents, text and locator changes as proposals.

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
