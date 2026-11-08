# The admin pages

The admin pages at `/admin` show everything in the store, including what's private: unparsed quotes,
flags, notes, and history. A quote or note can be edited there (below); everything else is read-only. On the LAN they're at
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
- Proposed changes from agents, before and after, with the command that accepts one.
- Its history.

## Editing a quote or note

`/admin/quotes/<id>/edit`, from the quote's **Edit** link: its text, page or location (`211`, `211-212`, or
`Kindle loc. 208`), chapter author, and comment (a note's words), with a line for the history saying why.
Saving is your edit: it's recorded in the history under your Access email (`lan` on the LAN), and the
quote is marked edited, so imports leave it alone from then on. The page and chapter-author flags follow
what you set. A quote checked against its Calibre book keeps the book's words, and you add your own marks to them:

- `[brackets]` for anything you insert: a clarification (`he [Smith]`), `[sic]` after a misprint, or
  `[emphasis added]`;
- `*asterisks*` around words you italicise, shown in italics here and on the public site, and as Markdown
  emphasis in a citation;
- `…` (or `...`, `[…]`) where words are left out;
- spacing and line breaks, such as joining lines an EPUB broke mid-sentence.

Taking out the brackets and asterisks has to leave the book's words, in order, with any omitted ones where
the ellipses are, so a changed or replaced word (`[Smith]` in place of `he`) is refused. The check is
against the passage as the book has it, so words you left out can be put back later. If the quote changed after you opened the form, the save is refused and the form shows it as it
is now. A form posted from anywhere but these pages is refused.

## Capturing a quote

`/admin/capture`: new quotes, spoken or marked on a scanned page. Choose the book first, by title, author,
citekey, or ISBN. It stays chosen, and every quote saved on the page is attached to it.

With the book chosen, two ways fill the same editor. **Record** speaks one quote into a microphone (a USB
microphone appears under its own name; the browser asks once for permission) and **Stop** transcribes it
into the quote box. **Scan a page** takes a photo or a one-page PDF; the printed page number, when the
header or footer is only that number, fills the page field, and the page's text sits beside the picture.
Mark the passage in that text and it becomes the quote. Either way, correct the wording, set the page
(`40` or `211-212`) and a concept tag (suggested from the concepts as you type), and **Approve**. Approving
keeps the book and clears the quote, ready for the next one. The quote is `transcribed`: a draft, not
checked against a Calibre text. A tag that isn't a concept yet is kept, and shows on the unresolved-tags
worklist. The recording and the page image are not stored.

A recording is transcribed on the server. With `QUOTE_WHISPER_URL` set, that is the faster-whisper server
on the LAN (`whisper.localdomain`); the recording is sent there and is not stored. Home Assistant
(`QUOTE_HA_URL` and `QUOTE_HA_TOKEN`) is the next choice, then PocketSphinx's US English model. `QUOTE_TRANSCRIBE`
names a local command instead. A page is read by Tesseract, or by `QUOTE_OCR` (see
[Operations](operations.md#settings)). The quote can also be typed into the box.

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
