# Importing quotes and notes

Where quote-mcp's records come from, and how they're read. The design, and what the survey of the sources
found, are in [PLAN.md](../PLAN.md) (its Survey, Import, and Notes sections).

`npm run import` syncs the Zotero mirror, reads the old site, and imports. It's safe to run again: an
unchanged note changes nothing, and a quote edited in quote-mcp is left alone. On the server a timer runs it
every 30 minutes without the old site (`import --no-drupal`); Deploy Quotes → Import with the old site runs it
with the old site.

## Sources

- **The old site** (`QUOTE_DRUPAL_URL`, read-only): its concept vocabulary and relations, its works, the quotes
  in each work's notes (each quote span's `title` gives its concepts), and the Quotes module's standalone
  quotes.
- **Zotero notes** in `QUOTE_ZOTERO_LIBRARY`, and in any libraries in `QUOTE_ZOTERO_SOURCES`. The mirror syncs
  by Zotero's library version, so only what changed is fetched, and each note's HTML is kept, so a parser
  change re-runs without fetching again. A quote already imported from the old site gains the Zotero note as
  a second origin and its tags.
- Zotero notes are never changed.

## Forms the parser reads

1. The old site's quote span (`span.quote`, its `title` giving concepts), including a list after it.
2. The same span written as escaped text, decoded once.
3. A `<blockquote>`, with an optional locator in the paragraph after it.
4. A note that starts and ends with a quotation mark, with an optional locator: what you get by typing a
   quote into a Zotero note.

A trailing locator is read as a page (`p. 40`), a range (`pp. 12-14`), roman numerals, or a Kindle location,
with an optional chapter author after a comma or semicolon. Catalog notes (contents lists and the like) and
empty notes are skipped and counted.

## Grades

| Grade | Meaning | What happens |
|---|---|---|
| A | A recognised form, balanced quotation marks, no flags but a missing locator | Imported and searchable |
| B | Extracted with flags | Imported and searchable; the flags feed the worklists |
| C | Not parsed with confidence | Imported as `unparsed`, out of search until a person splits it |

## Flags

`no_locator`, `kindle_locator`, `chapter_author`, `ocr_suspect`, `unbalanced_quotes`, `list_quote`,
`title_tag_only` (a `title` term missing from the note's tags), `compound_tag`, `commentary_mixed`, and `long`
(over 2,000 characters). Each has a worklist (see [the admin pages](admin-ui.md#worklists)).

The OCR check (`ocr_suspect`) flags words that aren't in the word list (`QUOTE_DICTIONARY`, plus names and
titles from the store) and that look like OCR confusions: `rn` for `m`, `li` for `h`, capitals or punctuation
inside a word, repeated words.

## Works

Each quote cites a work, matched to a Zotero item by title, then by year where titles repeat. A work with
several Zotero editions is `ambiguous` (cite_quote lists each edition); one with none is `unmatched`, cited
from the old site's record until it's filed in Zotero. Both have worklists.

## Margin notes

A note is a record of your own words at a place in a work, beside the quotes from it. To add one, write it as
a Zotero note on the book and tag it `margin` (any case). End it with `(p. 51)` to give a page. The next
import (within 30 minutes on the server) picks it up.

Its words are read for concepts:

1. Split on commas, semicolons, and line breaks: if every piece is a concept (by label, alternative label, or
   slug), the note is just tags.
2. If every piece is short (up to four words, with no sentence punctuation or dash), it's still tags; pieces
   that aren't concepts go to the "tags that aren't concepts" worklist.
3. Otherwise it's prose. Leading pieces that are concepts become tags ("mobbing, false self — compare
   Goffman" gives two tags and the prose after the dash).
4. `.mobbing` or `.false-self` anywhere in a note is always a tag.

The note's other Zotero tags are kept as tags. A note tagged `private` stays private on the public site even
when notes are shared (see [the public site](public-site.md#what-is-public)).

## The store

The store is a SQLite file (`QUOTE_DB`). `npm run quotes -- migrate` brings it up to the build's schema; a
deploy runs it before restarting the server, which opens the store read-only. `npm run quotes -- stats` gives
counts by status, origin, work match, and scheme; `export` writes everything as JSON; `backup` makes a SQLite
backup (nightly on the server, keeping 14).
