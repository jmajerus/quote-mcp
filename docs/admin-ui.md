# The admin pages

The admin pages at `/admin` show everything in the store, including what's private: unparsed quotes,
flags, notes, and history. They're read-only for now. On the LAN they're at
`http://quote-mcp.localdomain:8000/admin`; from outside, at `https://quote-mcp.majerus.us/admin`, behind
Cloudflare Access. They're never part of the public site.

## Overview

`/admin`: counts of quotes, notes, works, and concepts, when the store was last imported, and the
worklists with how many each holds.

## Quotes

`/admin/quotes`: search over quotes and notes, with the same filters as `search_quotes` (see
[MCP tools](tools.md#search_quotes)): words, concept, author, work, status, and kind. A tag in the URL
(`?tag=`) narrows to that tag. Each result shows its work (with a link that opens the item in Zotero), its
place, its tags (concepts as chips; tags that aren't concepts are dashed), and its flags.

## A quote or note

`/admin/quotes/<id>`: the whole record.

- The text, or a note's words.
- Its work and place, its tags, and its flags.
- Details: the chapter author, the comment, a source URL, key words marked in the text, words the OCR
  check suspects, and where it came from (the old site, a Zotero note).
- The citation: the Pandoc form, what to check, and the CSL JSON.
- Its history.

## Concepts

`/admin/concepts`: every concept with its quote count and definition, and a box to find one.
`/admin/concepts/<slug>`: one concept, its alternative labels, its broader, narrower, related, and
opposite concepts, its WordNet link, and its quotes, narrower concepts included.

## Worklists

`/admin/worklists`: what needs a person, each list a page of its own.

| List | What's on it |
|---|---|
| Unparsed quotes to split | Notes the import couldn't split into quotes with confidence (grade C) |
| Works with several Zotero editions | Works whose edition has to be picked by hand |
| Works not in Zotero yet | Works to file in Zotero |
| Tags that aren't concepts | Tags no concept matches, as candidate concepts |
| No page or location, possible OCR errors, unbalanced quotation marks, commentary mixed in, chapter authors to check, Kindle locations, concepts only in the title attribute, compound tags | Quotes by flag (see [Importing](importing.md#flags)) |
