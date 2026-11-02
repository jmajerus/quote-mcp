# Quote MCP plan

Proposed 2026-10-27; revised the same day so Quote MCP owns the quotes, and
again after the surveys found the old Drupal site, and to add margin notes.
Phases 0 and 1 are done; phase 3's first part (notes) is built.

Quote MCP is the store for quotations: structured records you can search,
tag, repair, and cite. Most of its quotes come from paper books that will
not be digitized. They were collected on the old workcreatively.org Drupal
site (Biblio and Quotes modules, about 810 quotes with a concept vocabulary
of 221 terms), and some were later copied into Zotero child notes, many of
them programmatically, some by OCR. In both places their structure (where
a quote ends, the page, the chapter author, the concepts) is a convention
inside rich text. Quote MCP imports them once into real fields and becomes
their home from then on.

## Decisions

| Area | Decision |
|---|---|
| Source of truth | Quote MCP's database, for every quote. Zotero stays the authority for *books*: item metadata, citekeys, and citations. |
| Why not Zotero notes | Zotero has no quote type. Only a note's tags are structured; the page, chapter author, status, and the quote's own boundaries are conventions in HTML, which nothing validates and which Zotero 7's note editor can rewrite on any edit. Zotero's structured kind, the annotation, needs an attached file, which paper books don't have. |
| Import | One pass from the old site's database dump (the main source), then the Zotero notes, which add about 15 quotes the site doesn't have; a quote found in both is imported once with both origins. A watch then picks up new quote notes typed into Zotero. The import never writes to the dump or to Zotero. |
| Concepts | The old site's vocabulary is imported as a named concept scheme, `human-work` ("the human side of work"; the name is tentative and can change, since concepts are keyed by internal ids). It sits beside corpus-mcp's subject vocabulary, not inside it: subjects say what a book is about, concepts name themes in a passage. terminology-mcp, the master taxonomy server, holds the scheme (decided 2026-11-01): its concepts, labels, slugs, definitions, and relations. The store's concepts are a replica that follows terminology-mcp's changelog, and new concepts are proposed there with a quote as evidence ([dev-brief](docs/dev-briefs/human-work-from-terminology-mcp.md)). The scheme has 221 concepts with definitions, alternative labels, WordNet links, and 782 broader, narrower, related, and inverse relations. A quote's concepts are imported exactly as they appear (the span's `title`, the note's Zotero tags). Nothing is removed or renamed without a person approving it. |
| Works | A quote cites a Zotero item. About 300 of the 495 old-site works with quotes match a Zotero item by title; the rest are filed into Zotero's staging collection from their Biblio record before or during the import, so every quote ends up citable. |
| Quoted text is protected | People edit quotes directly. Agents add quotes and change tags and comments, but changes to an existing quote's text or locator are proposals that a person approves. |
| Zotero copies | Optional and later: Quote MCP can write a read-only copy of each book's quotes into Zotero as child notes. A copy is never read back as data; an edit made to one becomes a proposal. |
| Notes | A margin note (your own words at a page, or about a whole book, with no quoted passage) is a second kind of record in the same store, not a separate Notes MCP: it needs the same works, locators, concepts, tags, and search. A short note that only names concepts, as on Kindle highlights, is read as tags, not discarded. A Zotero note becomes a note record only when it's tagged `margin`: Zotero's other non-quote notes are agents' research notes and catalog data, not yours. |
| Corpus quotes | Quote MCP owns their content and tags too. corpus-mcp keeps what only it can do: checking text against a Calibre book and re-anchoring after scans. |
| Storage | SQLite (`quotes.db`), primary data from day one: a nightly online backup kept 14 days (corpus-mcp's pattern), Proxmox backups of the LXC, and a full JSON export. |
| Runtime | A systemd service on its own LXC (quote-mcp.localdomain, port 8000), with its own Access application and claude.ai connector. |
| Language | TypeScript on Node 22. The Zotero Web API client comes from corpus-mcp's `src/zotero.ts`, either copied or moved into a shared package like `packages/citekey`. |

## Survey (2026-10-27)

`npm run survey` (Zotero notes) and `npm run survey -- --source drupal` (the
old site) in this repo. Both are read-only.

| Source | Notes or spans | Quotes | Grade A / B / C | No locator |
|---|---:|---:|---|---:|
| Old site (`jmajerus_drp1` on mariadb.localdomain) | 812 | 811 (797 spans in 495 works, 14 Quotes-module quotes) | 577 / 223 / 11 | 17% |
| Zotero, personal library | 306 | 131 | 63 / 56 / 12 | 29% |
| Zotero, WorkCreatively group | 164 | 156 | 74 / 78 / 4 | 15% |

- **Distinct quotes:** about 830. 153 old-site quotes are also in Zotero
  notes, and 109 personal-library quotes are also in the group. About 15
  real quotes are only in Zotero; the other Zotero-only "quotes" are recent
  research notes (`[VERIFY: …]`, `[PLACEHOLDER: …]`, summaries), which are
  not imported.
- **Old-site notes** hold one to six quote spans each; the span's `title` is
  the concept. 18 `<span class="kwic" title="concept">` marks inside quotes
  name the words that carry a concept, and are kept.
- **Concepts:** 216 of the 221 are used on quotes. Only three quote terms
  are missing from the vocabulary (`flexiblity`, `care`, `conspiracy theory`).
- **Group copies lost their Zotero tags:** 48 group quotes have concepts only
  in the `title` attribute.
- **Encoding is clean.** (A `LIKE '%Ã%'` count suggests otherwise only
  because the table's `_ai_ci` collation ignores accents.)

The first look, at the Zotero Business collection, read 40 quote notes in
full as HTML and about 80 more as previews, from about 70 of its 308 items.

- **Usual form:** `<p><span class="quote" title="innovation"> "…" (p. 63) </span></p>`,
  about 90% of quote notes. Catalog notes ("Includes index", contents
  lists, "Originally published…") never have the span. One quote per note
  throughout.
- **Locators:** 22 of 40 have a page, written `(p. 63)` or `(p 169)`. Two have
  `(Kindle loc. 208-210)`. Three add a chapter author from an edited volume,
  as in `(p. 209, Richard L. Daft and Robert H. Lengel)`. About 13 have no
  locator; a few of those are web articles, most are books.
- **Tags:** note tags carry the concepts. The `title` attribute usually
  repeats them but can be incomplete (`title="environment"` on a note
  tagged `environment` and `innovation`). Some tags are compound
  (`fear, job loss`).
- **Variants:** the span written out as escaped text (`&lt;span…&gt;`); a
  quote that continues from the span into a `<ul>`; nested spans; a
  `<blockquote cite="…">` with no span; your comment followed by a quote
  broken with `<br />`; a missing opening quotation mark, or none at all;
  an empty note. Inside quotes: `<em>`, `<cite>`, `[Good bosses]`,
  `...`/`....`/`…` for cuts, and straight and curly quotes mixed.
- **OCR errors:** `over die next few years`, `a line line between`,
  `eEorts`, `showod`, `carefirlly`, `ot' self-esteem`, `can also he
  established`, `lleaders hesitate to team`. Some are non-words a
  dictionary catches; many are real words that need context.

The whole-library surveys confirmed these forms; the old site's notes use
the same span, several to a note.

## Data model

- **`quotes`:** id (Quote MCP's own, stable), kind (`quote` or `note`; see
  *Notes*), Zotero item key, cached
  citekey and Calibre UUID when there is one, text (paragraphs and list
  items, emphasis kept), locator kind (`page`, `kindle`, `none`) and value,
  printed page label, chapter author, comment (your own words about the
  quote, kept apart from the quoted text), status, grade, flags, origin,
  and who created and last changed it, and when.
- **Status:** `transcribed` (typed or OCR'd, not checked against a text),
  `verified` (checked against a Calibre text by corpus-mcp, with an anchor),
  `unparsed` (imported but not yet split into fields by a person).
- **Origins** (one or more per quote): `drupal` with the work's node id and
  span number, `drupal-quote` with the node id, `zotero-note` with the note
  key and version, `capture`, `agent`, `corpus`, or `zotero-annotation`. An
  origin is provenance, not a link that keeps syncing.
- **`concepts`** and **`concept_relations`:** the scheme imported from the
  old site (label, alternative labels, definition, WordNet link; broader,
  narrower, related, inverse), extended as new concepts are coined.
- **`quote_tags`:** quote, tag, the concept it resolves to (if any), and
  where the tag came from (`span`, `note`, `title`, `added`). A Zotero
  item's own tags, often Library of Congress subject headings, are read as a
  separate work-level set for filtering and never mixed in. A
  living-taxonomy term id comes later.
- **`quote_kwic`:** quote, phrase, concept: the words in a quote that carry
  a concept.
- **`dismissals`:** quote, flag, reason, by, at. "Web article, no page" and
  "sic, as printed" stop a flag from coming back.
- **`proposals`:** quote, change (text, locator, chapter author, tags),
  rationale, evidence, proposer, status, reviewer.
- **`history`:** every change to every quote, before and after, who made or
  approved it, and why. This is the undo.

## Import

**The old site first.** The dump is read directly (MariaDB, read-only):

1. Concepts and their relations from `biblio_keyword_data` and
   `biblio_keyword_skos`.
2. Works from `biblio`, with authors (`biblio_contributor`), keywords
   (`biblio_keyword`), year, ISBN, and URL. Each is matched to a Zotero item
   by loose title, then year where titles repeat. A work with no match is
   filed into Zotero staging from its Biblio record, and a person checks the
   ambiguous matches.
3. Each work's `biblio_notes` split into its quote spans, each parsed as a
   note in form 1, with the span's `title` as its concepts and any `kwic`
   marks kept. Text outside the spans (a cross-reference such as
   `[bib]Kantrow1988[/bib]`) becomes the first quote's comment.
4. The Quotes module's 14 quotes (`quotes`, `node_revisions`,
   `quotes_authors`), which have an author and a citation but no work.

**Then Zotero.** Its quote notes are parsed the same way. A quote whose text
already came from the old site (compared loosely, ignoring case and
punctuation) adds its note as a second origin and its Zotero tags as tags;
any other quote is imported as new.

**Reading Zotero.** Quote MCP syncs incrementally by Zotero's library
version, as corpus-mcp's mirror does: `items?itemType=note&since=<version>`
for notes and the parent items they hang from. It keeps each note's raw HTML
and version, so a parser change re-runs locally without fetching anything
again, until a quote has been edited in Quote MCP.

**Forms the parser reads.**

1. The legacy span: `span.quote`, its `title` attribute, and anything up
   to the closing quotation mark and locator, including a list that follows
   it.
2. The legacy span written as escaped text. It is decoded once and then
   parsed as form 1.
3. A `<blockquote>`, with an optional locator in the paragraph after it.
4. A note whose text starts with a quotation mark and ends with a quotation
   mark and an optional locator. This is the form you get by typing a quote
   into a note by hand.

**Steps.** For each note:

1. Decode the escaped span if present.
2. Classify the note: quote, catalog note, empty, or unclear. Catalog notes
   are skipped and counted.
3. Extract the quote body, keeping paragraphs, list items, and emphasis.
   Strip the outer quotation marks, and record whether either was missing.
4. Read the trailing locator: page, page range, roman numerals, `p` without
   a period, Kindle location, and an optional chapter author after a comma
   or semicolon.
5. Collect tags: the note's tags, plus the `title` attribute split on
   commas, kept with origin `title`.

**Grades.**

| Grade | Meaning | Where it goes |
|---|---|---|
| A | Clean: recognised form, balanced quotation marks, no flags except a missing locator | Imported and searchable |
| B | Extracted with flags (below) | Imported and searchable; flags feed worklists |
| C | Not parsed with confidence: commentary mixed in, several quotes suspected, no recognisable structure | Imported as `unparsed`, out of search until a person splits it |

Grades A and B are the easily extractable quotes, all searchable and
citable from phase 1. A citation for a quote without a locator says so,
rather than inventing one.

**Flags.** `no_locator`, `kindle_locator`, `chapter_author`, `ocr_suspect`,
`unbalanced_quotes`, `list_quote`, `title_tag_only` (a `title` term missing
from the note's tags), `compound_tag`, `commentary_mixed`, `long` (over
2,000 characters; allowed, but worth a look).

**OCR detector.** A first pass needs no model. It flags tokens that are
not in a dictionary (Hunspell en_US, plus an allowlist built from creators,
titles, and existing quotes) and that match common OCR confusions: `rn`↔`m`,
`li`↔`h`, `cl`↔`d`, `e`↔`c`, `f`↔`t`, capitals inside a word (`eEorts`),
punctuation inside a word (`ot'`), and repeated words (`line line`). Real-word
errors (`die` for `the`, `he` for `be`) need context, so a model pass in
phase 2 handles them.

**After the import.** Zotero notes aren't modified. Quote MCP keeps watching
notes for two cases:

- *A new quote note* (one it hasn't imported) is imported as a new quote,
  so typing a quote into Zotero keeps working.
- *An imported note that changed* in Zotero produces a proposal showing the
  difference, rather than changing the quote silently.

## Repairing quotes

Repairs are ordinary edits to Quote MCP records, kept in history.

| Class | Examples | Who decides | How it's applied |
|---|---|---|---|
| Tag hygiene | Add `title`-only terms; split compound tags; merge near-duplicates (`work-life balance`, `work life balance`) | Rules propose. A person approves each kind of change once, for all the quotes it affects. | Batch, from a preview |
| Evidence-backed | A page or the correct wording, found in a Calibre copy of the same book | The source text. A person spot-checks and approves in bulk. | Proposals queue; the quote becomes `verified` |
| Judgement | A missing page for a paper book; real-word OCR errors without a source; a chapter author; splitting an `unparsed` note | A person. An agent may propose. | Edit directly, or approve a proposal |

**Calibre-backed repairs.** Where a quote's book is also in Calibre (linked
through `Calibre UUID:` in the Zotero item's Extra, as corpus-mcp's mirror
does), corpus-mcp finds the passage. That gives the printed page and the
book's exact wording, which fixes OCR errors with evidence. corpus-mcp
needs a small read-only verify endpoint for this (book, text, optional page
→ match with anchor, or the closest passages), using the same check
`save_quote` uses.

**Shelf sessions.** Missing pages and wording checks for paper books need
the physical book. The by-book worklist lists books by how many of their
quotes need it. A book's page shows every quote that needs a page or a
check, in reading order where that's known. It's laid out for a phone, so
you can work with the book in hand and fix all of its quotes at once.

**OCR proposals by an agent.** An agent takes `ocr_suspect` quotes with the
flagged tokens and the book's metadata, and proposes corrections with a
confidence and a reason for each. If you can't check the book, you can
still accept a correction marked as conjectural. You can also dismiss the
flag as "sic, as printed", which stops it from being re-flagged.

**Surfaces.**

- *Admin pages:* the queues (one per flag, plus `unparsed`), the by-book
  view, and a quote page with the source note, the fields, flags, history,
  and any proposal as a diff, with buttons to accept, edit, reject, or
  dismiss.
- *MCP tools* for agents: `quote_worklist(queue, book?)` and
  `propose_quote_fix(quote, text?, locator?, chapter_author?, rationale,
  evidence?)`.
- *CLI:* `survey` (read-only report), `import`, `reparse` (re-runs the
  parser on quotes nobody has edited yet), and `export`.

## Adding quotes

| Where you are | How | Status |
|---|---|---|
| At the shelf, phone or any browser | Quote MCP's capture form: find the book by title, citekey, or ISBN; paste the text (the phone's camera text recognition works well for this); add the page and tags, with tags suggested as you type. The OCR detector runs before saving and highlights suspect words. | `transcribed` |
| A conversation with Claude | `add_quote(book, text, locator, tags, comment?)`, with the same checks | `transcribed` |
| Zotero desktop | Type a note in form 4 (`"…" (p. 63)`) with concept tags as note tags. The watch imports it. | `transcribed` |
| A Calibre book | `add_quote` with the Calibre book; Quote MCP asks corpus-mcp to check it | `verified` |
| A PDF or EPUB attached in Zotero | A highlight annotation with tags, imported with its page label | `transcribed` |
| A book not yet in Zotero | Filed first into `Corpus MCP/Staging`, the way the cited-article skill files books, then the quote is added | as above |

New tags reuse an existing tag's spelling, ignoring case, the same rule
corpus-mcp's quotes use, so one concept keeps one name.

## Notes

Readers write in margins, and ebook readers let you attach a note to a
highlight. Some of those notes are prose; many, especially on a Kindle,
are just concept tags typed against the highlighted passage, the same
tagging the paper books got. Quote MCP keeps both, and tells them apart.

**Two kinds of record.** A record's `kind` is `quote` or `note`:

- **quote:** a passage, with your note on it (if any) kept as its comment.
- **note:** your own words at a locator, or about the whole work when
  there's no locator. The words are the record's comment; there's no
  quoted text.

Notes share works, locators, tags, history, and the worklists with quotes.
`search_quotes` finds both, with a `kind` filter; the admin pages show
both. `cite_quote` on a note gives the work's citation and the locator, and
says there's no quote to cite.

**Tag or note.** One classifier reads any free text attached to a mark,
whatever the source:

1. Split it on commas, semicolons, and line breaks. If every piece is a
   concept's label, alternative label, or slug, it's tags.
2. If every piece is short (up to four words, no sentence punctuation and no
   dash), it's still tags; pieces that aren't concepts go to the
   unresolved-tags worklist as candidate concepts.
3. Otherwise it's prose, kept as the comment. Leading pieces that are
   concepts ("mobbing, false self — compare Goffman", where a dash also ends
   a piece) become tags, and the rest stays prose. The dash is what keeps
   this example out of rule 2, since every piece in it is short.
4. A word written as `.mobbing` or `.false-self` is always a tag, wherever
   it is. This is an optional convention for new notes, quick to type on a
   small screen; old notes rely on rules 1 to 3.

`src/margin.ts` is the classifier. Tags it reads have origin `text` in
`quote_tags`.

The raw text stays with the record's origin, so a wrong reading can be
redone when the rules change.

**Sources.**

- **Now:** a Zotero note tagged `margin` (any case), on a book or
  standalone. Its words go through the classifier, a trailing locator such as
  `(p. 51)` is read as for quotes, and its other Zotero tags are kept as
  tags. The 30-minute watch picks new ones up, so typing a margin note into
  Zotero works the way typing a quote does. A note that's tagged `margin`
  but empty is skipped.
- **Not imported:** the 162 Zotero notes the import sets aside as "other".
  A look on 2026-10-27 found about 90 agents' research notes (`[VERIFIED]`,
  `[VERIFY: …]`, `[PLACEHOLDER: …]`), about 50 one-line summaries written
  for annotated bibliographies (many repeated across items), about 15
  catalog notes the catalog rule misses ("Description based upon print
  version of record", contents lists), and Zotero's welcome note; none were
  margin notes. The old site's text outside quote spans is four remarks on
  a quote, already kept as that quote's comment, and a jacket blurb.
- **When the Kindle books are retrieved** (in progress; what exists isn't
  known yet): Kindle highlights and their notes, from `My Clippings.txt`
  (a highlight and its note are separate entries with the same location)
  or Amazon's notebook export; Calibre viewer annotations, of which there
  are few so far; KOReader if it's used. A highlight is a quote; its note
  goes through the classifier. When the book is in Calibre, the highlight
  can be checked against corpus-mcp's text and become `verified`, with a
  chapter to cite instead of a Kindle location.
- **Later:** Zotero annotation comments (phase 4) go through the same
  classifier.

## Citing

`cite_quote` returns the quote text, its locator, and the book's CSL JSON
from Zotero (by item key), with the chapter author given where there is
one. A Calibre book not yet in Zotero is cited through corpus-mcp's
`cite_passage` data until it's filed.

## Zotero copies (optional)

For browsing quotes from inside Zotero, Quote MCP can write one read-only
child note per book listing its quotes:

```html
<h2>Quotes (managed by Quote MCP; edit at https://…/quotes/book/ITEMKEY)</h2>
<blockquote><p>Innovators rarely find support within mainstream organizations, …</p></blockquote>
<p>(p. 63) · innovation</p>
```

- One note per book, not per quote, so the copies don't double the number of
  notes; tagged `quote-mcp:copy` so the watch skips them.
- Rewritten when the book's quotes change, with `If-Unmodified-Since-Version`.
  If the copy was edited in Zotero, Quote MCP turns the edits into proposals
  before rewriting it.
- The format uses only elements Zotero 7's note editor keeps, so test it in
  the editor first.

## Corpus quotes

corpus-mcp's quotes split along what each service is for:

- **Quote MCP** owns the record: text, locator, comment, tags, history.
- **corpus-mcp** keeps the *anchor*: Calibre UUID, offsets, prefix and suffix,
  file hash, and `verified` or `orphaned`. It re-anchors after scans, as it
  does today, and publishes anchor changes as a feed that Quote MCP reads to
  update a quote's status.

The migration moves corpus-mcp's quote content and tags into Quote MCP,
leaves the anchors behind with the new quote ids, and turns corpus-mcp's
quote tools into calls to Quote MCP or retires them. The reader view keeps
highlighting quotes from the anchors.

## Concept tags

- A tag report lists counts and likely duplicates (case, plurals, hyphens)
  as merge proposals.
- Searches combine tags with authors, books, and book-level subjects.
- Tags map to terminology-mcp term ids through their concepts
  (`concepts.term_id`), without renaming them (built 2026-11-01; see the
  [dev-brief](docs/dev-briefs/human-work-from-terminology-mcp.md)). This joins
  quotes to the same keys as Calibre tags and Concept Clusters
  subcategories (see PLAN.md, *Living taxonomy*).
- A tag that isn't a concept is proposed to terminology-mcp from the
  worklist (`quote-mcp propose`), with the quote as evidence.

## The concept map

A separate repo, `quote-atlas` (first called `human-work-map`), rebuilds
the old site's concept graph: a static SVG page where clicking a concept
shows its quotes. It reads quote-mcp live, so new concept-tagged quotes show
up without an export. Built 2026-10-28; the maps' front end and deploy live
in that repo. It holds several maps: `/map/` is a menu titled "Quote
atlas", read from `/map/maps.json`, each map is at `/map/<name>/` (the first is
`/map/human-work/`), and a concept is at `/map/<name>/#/concept/<slug>`;
old `/map/#/concept/<slug>` links redirect to the first map. Each map is
tied to one concept scheme: it calls `/api/concepts/<scheme>:<slug>` and
its `/quotes`, and filters `/api/graph` by each concept's `scheme`, so
`scheme` stays on the graph's concepts.

- **API.** A read-only JSON API at `/api` (`src/api.ts`), on the same
  queries as the MCP tools so the two can't disagree: `GET /api/graph`
  (every concept that isn't retired, with `slug`, `scheme`, `label`,
  `alt_labels`, `status`, `source`, and `quotes`, plus every relation as
  `from`, `to`, and the stored `type`), `GET /api/concepts/:slug` (what
  `get_concept` returns; `scheme:slug` works too), and
  `GET /api/concepts/:slug/quotes` (quotes and notes, unparsed left out,
  narrower concepts included unless `narrower=false`, with `limit` up to 100
  and `offset`). An unknown concept is 404, a bad number 400, any method but
  GET 405. `source` is `drupal:kid:N` for the old site's concepts, which the
  map uses to place them as the old site's Gephi layout did.
- **Contract.** The map calls these routes by relative URL. Keep the routes
  and their fields stable; adding fields is fine.
- **Hosting.** quote-mcp serves the map's build at `/map/` from
  `QUOTE_MAP_DIR` (`/opt/quote-mcp/map` on the LXC, outside `releases/` so a
  quote-mcp deploy never removes it), behind the same Access login, so the
  map needs no CORS and no auth of its own. quote-atlas's deploy copies
  its whole build there, a folder per map; quote-mcp only serves what's in the folder. A path that
  resolves outside the folder is 404; `index.html` is revalidated on every
  load, and files with a build hash in their names are cached for a year.
  Without `QUOTE_MAP_DIR`, `/map/` is 404.
- **Concept sets** (built 2026-10-28). Named parts of one scheme, so a map can show less than a whole scheme, search can stay
  within one, and themes (quote-atlas's plan) have something to draw on.
  They're editorial, so they live here, not in quote-atlas, and in a file in
  git (`vocab/sets.json`, or `QUOTE_SETS`), not the store, so they're
  reviewed and shared like code and ship with each deploy. A set lists its
  `concepts`, or gives a recipe worked out on each request (`around` with
  `depth` and `types`, `narrower`, `exclude`), so a concept added later joins
  the sets that reach it. A malformed file stops the server starting; a slug
  the scheme doesn't have is shown as `missing` rather than failing, since a
  concept retired later shouldn't take the service down.
  `npm run quotes -- sets` checks them. The API has `GET /api/sets` and
  `GET /api/sets/:slug` (in `/api/graph`'s shape, so a map draws a set as it
  draws a scheme); the MCP tools have `list_sets` and a `set` filter on
  `search_quotes` and `list_concepts`. A map would name its set in
  quote-atlas's `maps.json`. Sets could move into the store once there are
  write tools, so they can be made from a conversation; themes would extend
  the same file.

## The public site

Anyone who runs quote-mcp has their own Zotero library, and some will want
to show their collection and maps rather than keep them private. So the
server has public pages, off unless they're turned on.

- **Where the choices live** (2026-10-28). The level and the notes setting
  are the site's choices, not a machine's, so they're `public:` and
  `notes:` in a header at the top of `vocab/site.md`, in git beside the
  title, and ship with each deploy; `QUOTE_PUBLIC` and `QUOTE_PUBLIC_NOTES`
  override them on one machine. `.env.example` lists only the two required
  settings and the optional ones by feature; `quote-mcp config` shows every
  setting, where it came from, and what each feature still needs.
- **Levels.** `QUOTE_PUBLIC` is `none` (the default: nothing changes),
  `catalogue` (concepts, sets, maps, works by title and author, counts; no
  quoted text), or `quotes` (the catalogue plus quote text with citations).
  This site uses `quotes`, as the old site published its quotes. Unparsed
  quotes, flags, OCR suspects, worklists, history, `/admin`, and `/mcp` are
  never public at any level.
- **Notes.** Reading notes are often shared, as on Goodreads, but they're
  your own words, so sharing them is a separate choice: `QUOTE_PUBLIC_NOTES`
  is `none` (the default) or `all`, and with `all` a note whose Zotero note
  is also tagged `private` stays private. It takes effect only at the
  `quotes` level, where a work's page shows its notes beside its quotes.
- **Front page at `/`.** On the LAN, `http://quote-mcp.localdomain:8000/` is
  the public front page (it redirects to `/admin` today); `/admin`, `/mcp`,
  and `/map/` stay where they are. With `QUOTE_PUBLIC=none`, `/` still
  redirects to `/admin`.
- **A public-only port** (to be re-based on the snapshot; see "Hosting the
  public site" below). `QUOTE_PUBLIC_PORT` starts a second listener that
  serves only the public pages, the public API, `/map/`, and `/site.json`;
  everything else is 404 there whatever the request. The server enforces
  what's public, not the proxy, so a wrong tunnel or Access rule can't expose
  notes or the admin pages, and someone without Cloudflare can put the
  public port behind any proxy.
- **Hostnames.** `quote-mcp.majerus.us` keeps its Access login and points
  at port 8000, for Claude and the admin pages. The public site gets its own
  hostname (say `quotes.majerus.us`), served by a Worker (below) rather than
  a tunnel route to the LAN. The user creates the Cloudflare resources and
  runs their deploys; no Cloudflare changes are made from here.
- **Separate code.** The public pages have their own renderer and queries
  that return only public fields. They don't reuse the admin pages with parts
  hidden, so a field added to the admin pages can't leak.
- **Collections.** A collection is a concept scheme as readers see it: the
  human side of work is one, and quotes from books in other fields would go
  in others, each a scheme with its own concepts. Its concepts decide what's
  in it, so a work quoted in two collections is in both. Each has a page at
  `/collections/<scheme>` (its introduction from
  `vocab/collections/<scheme>.md`, else the scheme's label and description;
  its counts, maps, and sets; its concepts and works), and the concept and
  work lists take `?collection=`. Concept sets are starting points within a
  collection, not collections themselves. "Collection" is the readers' word
  only; in the code and the store it stays a scheme, and Zotero's
  collections are always called that in full. A per-collection switch to keep
  one private can come when there's a second collection to need it.
- **Pages.**
  - The front page: the owner's title and a short introduction for the whole
    site (`vocab/site.md`), then the counts. With several collections, a card
    for each (its introduction's first paragraph and counts) and a note of
    quotes not yet tagged, so in no collection; with one, it's shown inline.
  - Ways in: the maps (from `/map/maps.json`), the concept sets and later
    the themes, and a search box.
  - Concepts A to Z with quote counts, a page per concept (definition,
    relations, its quotes), and a page per set.
  - Works by author, as a bibliography, and a page per work with its
    quotes.
  - At `quotes`, a page per quote with its work, page, concepts, and a
    "cite this" box (the Pandoc citation, BibTeX written from the CSL, and
    the CSL JSON), search over what quotes say, and the quotes on concept,
    set, and work pages. A quote's comment counts as your own words, so
    it's shown and searched only with `QUOTE_PUBLIC_NOTES=all`.
  - The old site's markup is tidied for display only: `[bib]Key[/bib]`
    markers (in-text citations of its Biblio records, which the sentence
    around them already names) are dropped, and paired `*asterisks*` are
    emphasis. The store keeps the text as imported until phase 2's repair
    tools can edit it with history.
  - Public pages are cacheable, unlike `/admin`.
- **Public API.** The map's `/api` routes, cut to public fields: the graph,
  concepts, and sets at `catalogue`, and quotes at `quotes`. On the public
  port `/map/` works as on the LAN, so the maps are public too.
- **Linking with corpus-mcp.** corpus-mcp can do the same: its book
  catalogue public (titles, authors, subjects, shelves), book text and page
  images private. The two link by a convention, not shared code:
  - `/site.json` gives `version` (1), the site's name, kind (`quotes` or
    `library`), public URL, level, and the path of its key list.
  - The key list (`/api/public/citekeys`) maps each public work's or book's
    Zotero citekeys (`citekeys`) and Zotero item keys (`zotero_keys`, as
    `users/<id>/<key>` or `groups/<id>/<key>`) to the path of its public
    page; a link matches on either. Item keys are the stable ones; a work
    with several editions lists each, all pointing at its one page.
  - corpus-mcp's side (agreed with its session 2026-10-28): `/books/<id>`, a
    catalogue entry only (title, authors, year, subjects, shelves, citekey),
    with `CORPUS_PUBLIC`, `CORPUS_PUBLIC_PORT`, and `CORPUS_SITE_LINKS`.
    Few of its books have citekeys yet, so it lists the Zotero items its
    mirror links to Calibre books as well as pinned citekeys.
  - Each site lists the other's public URL in its settings
    (`QUOTE_SITE_LINKS`) and fetches its `site.json` and key list when it
    publishes, storing the links in its own snapshot: the front pages link
    to each other, and a work page here links to "this book in the library"
    when the library lists its citekey (a book page there links to "quotes
    from this book"). Nothing is fetched while a page is served, so there's
    no CORS, and when the other site is down at publish time the previous
    links are kept.

### Hosting the public site: a replica in D1, served by a Worker

Decided 2026-10-28, on concept-clusters' model (a Worker with static
assets and D1, and a published replica fed by a queue). The public site
moves off the LAN. The LXC stays the source of truth for the store, import,
MCP, and the admin pages; what's public is built as a local snapshot, its
changed rows are queued, and a drain copies them to D1, which a Worker
serves and never writes.

- **Why.** Only what's published leaves the LAN: notes not shared,
  comments, unparsed quotes, flags, and history are never in the snapshot,
  so no bug in the Worker can show them. Public traffic never reaches the
  home server, the site stays up when the LAN or the tunnel is down, and
  Cloudflare caches it near readers. The cost is a second runtime and a site
  a little behind the store: seconds after a snapshot is rebuilt, which
  happens after each import (every 30 minutes) and on deploy.
- **The snapshot** (built 2026-10-28, `src/snapshot.ts`). A SQLite database
  of public records only, built from the store with `src/public.ts`'s rules
  (the level and notes settings decide what goes in) and written beside the
  store as `public.db`, renamed into place so a reader never sees half of
  it. At the catalogue level records are copied with no words, only their
  kind, work, and concepts, so pages can count them. It's the replica's
  desired state. Its tables:
  - `meta`: the snapshot's version, level, notes setting, when it was built,
    and a content hash (of everything but the build time), so an unchanged
    snapshot is recognised.
  - `intros`: the site's and each collection's title, HTML, and summary.
  - `schemes`, `concepts` (slug, label, alternative labels, definition,
    status, source), and `relations`.
  - `works` (title, authors, year, citekey, and its Zotero item keys, for
    links), `records` (the public record's fields: kind, text with markup
    tidied, note, comment when shared, locator, chapter author, attribution,
    work, added), and `record_concepts`.
  - `records_fts`, FTS5 over the public text only, so search can't match
    words that aren't shown.
  - `sets` and `set_concepts`, recipes resolved when the snapshot is built;
    `maps`, from quote-atlas's `maps.json`; and later `links`, the other
    sites' key lists.
- **One renderer** (built 2026-10-28). `src/site.ts` and the public API read
  the snapshot's schema only (`src/published.ts`), never the store, through
  a small async store interface with positional parameters, as D1 wants:
  better-sqlite3 on the LAN (`src/published-sqlite.ts`) and D1 in the
  Worker. A list's works and concepts are fetched for all its rows at once,
  and what doesn't change (introductions, maps, collections, counts) is kept
  for the life of a snapshot, since each query is a round trip in D1. The
  pages and the queries use no Node modules (`src/common.ts` and
  `src/style.ts` hold what they share with the store's code), so they bundle
  for the Worker as they are. The rules for what's public live only in the
  builder. The pages, search, the map's API, and `site.json` are the same
  code on both.
- **The LAN preview** (built 2026-10-28). `http://quote-mcp.localdomain:8000/`
  serves the snapshot (rebuilt by `quote-mcp publish --dry-run`, after each
  import, and on deploy), reread when it's replaced, so the site can be
  checked as it will go out. Without one yet, `/` says how to build it.
- **The queue and the drain** (built 2026-10-28, `src/drain.ts`, on
  concept-clusters' `publishedReplica`). D1 is only a replica, kept in step
  by rows:
  - After the snapshot is rebuilt, each row is compared with what was last
    shipped (by table, key, and a hash of the row, kept beside the store),
    and each new, changed, or removed row is queued, keyed by table and key,
    so a later change replaces a pending one.
  - A drain on the LXC (every 15 seconds, as concept-clusters' does) ships
    queued rows to D1 as idempotent batches (upserts, and deletes for removed
    rows), through the D1 HTTP API or a d1-proxy Worker, in dependency order:
    schemes, concepts, relations, works, records and their FTS rows,
    record_concepts, sets, set_concepts, maps, intros, meta; removals go in
    reverse. A queued row is cleared only if its hash still matches what was
    shipped; a failure leaves it queued for the next tick, so an outage just
    leaves the queue waiting.
  - Nothing writes D1 but the drain. A reader may see a drain's rows arrive
    over a few seconds, but never a reference to a row that isn't there yet.
  - The queue and what was shipped live in `replica.db` beside the snapshot
    (the server reads the store read-only, but can write there). The drain
    runs inside `serve`: each tick, if the snapshot's hash has changed, it
    compares and queues, then ships. Batches are at most 100 statements; a
    record's FTS row is a delete and an insert, since FTS5 takes no upsert.
    `quote-mcp publish` does one tick by hand; `publish --status` shows the
    queue; `/health` shows the drain's state.
  - D1 is reached through the proxy Worker (`worker/proxy.ts`, a copy of
    concept-clusters' d1-proxy: the REST API's `/query` shape through the
    database's binding, behind a bearer token) or the REST API itself
    (`src/d1-http.ts`). Settings in `/etc/quote-mcp/env`:
    `QUOTE_D1_PROXY_URL` and `QUOTE_D1_PROXY_TOKEN`, or
    `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and
    `QUOTE_D1_DATABASE_ID`. Without them the drain doesn't run.
  - Tried end to end locally: from an empty D1, the first tick shipped the
    whole snapshot (4,042 rows) in about a second; one edited quote then
    shipped as four rows (the record, its search row, and meta's hash and
    build time) within a tick; and the public Worker on that D1 answered
    byte for byte as the public port. Two local Workers can't share one
    local D1 (workerd locks it), so locally the proxy and the public Worker
    run one at a time.
  - Fixed 2026-10-28, from corpus-mcp's review of the same code: a lease in
    `replica.db` lets one tick ship at a time across processes (the
    server's drain and `quote-mcp publish`), renewed per batch and expiring
    after 5 minutes if its process dies; a row still queued (its batch may
    have committed with the response lost) is sent again even when the
    snapshot reverts it, and deleted if it leaves the snapshot, confirmed or
    not; and meta's hash row, which the Worker takes as "published", is
    written last of all.
  - Phase 2's edits can later queue rows in the same transaction as the
    edit, as concept-clusters does, rather than waiting for a rebuild.
- **The Worker** (built 2026-10-28, `worker/`, its own `wrangler.jsonc`), on
  its own hostname, with no Access. It serves the pages and the map's API
  (`/api/graph`, `/api/concepts/…`, `/api/sets/…`, routed by
  `src/api-routes.ts`, shared with the Node server) from D1, read-only, and
  later `site.json` and the key list. Responses can be cached for a minute,
  with the snapshot's hash as the ETag, so a revalidation is a 304 until
  something new is published; a bare `/map` is sent to `/map/`; with nothing
  published yet it answers 503. D1's schema is a migration
  (`worker/migrations/0001_snapshot.sql`) kept identical to the snapshot's
  by a test. Locally, `npm run worker:load` builds the snapshot, writes it
  as SQL (`publish --sql`, `src/replica.ts`), and loads it into a local D1;
  `npm run worker:dev` runs the Worker on it. On the local store its pages
  and API answers are byte for byte the LAN preview's and the public port's.
- **The maps.** quote-atlas's build needs the same origin as the API. Both
  sessions prefer that quote-atlas deploys its own assets-only Worker on a
  `quotes.majerus.us/map/*` route, so its deploys stay its own (its user is
  deciding; the alternative is bundling its build into this Worker's
  assets). With that:
  - The route doesn't match a bare `/map`, so this Worker redirects `/map`
    to `/map/`, as the LAN server does.
  - quote-atlas's `npm run deploy` keeps copying to `/opt/quote-mcp/map` for
    the LAN and the Access hostname, and deploys its Worker too.
  - `publish` reads the public copy of `maps.json`
    (`https://quotes.majerus.us/map/maps.json`), so the front page lists only
    maps the public site has; the LAN preview reads
    `/opt/quote-mcp/map/maps.json`. Its fields are `name`, `title`,
    `description`, `scheme`, `svg`, and `match`, and later an optional `set`;
    a map's drawing is at `/map/<name>/<svg>`.
  - The map needs `/api/graph`, `/api/concepts/<scheme>:<slug>` and its
    `/quotes` (`limit`, `offset`, `narrower`), and `/api/sets/<slug>` for a
    map with a set, in the shapes the public port gives today.
- **What retired** (2026-10-28). Filtering the store per request on the
  public port. The public port stays as the option for people without
  Cloudflare, re-based on the snapshot: it serves `public.db` and the map and
  nothing else, so it can't leak either. The LAN's private `/api` is
  unchanged.
- **corpus-mcp** would follow the same model: a catalogue snapshot (titles,
  authors, subjects, shelves, citekeys, Zotero item keys) in its own D1 and
  Worker, with book text and page images never leaving the LAN.

## Phases

0. **Survey** (done 2026-10-27). `npm run survey` for Zotero notes and
   `--source drupal` for the old site: counts by form, grade, and flag, with
   examples, a tag inventory, the concept vocabulary, work matching, and the
   overlap between sources. Grade C is 27 quotes across all sources.
1. **Import and search** (done 2026-10-27). The store, the concept scheme,
   the import (old site, then Zotero, merging duplicates), and the Zotero
   mirror, whose re-sync every 30 minutes is the watch. First run: 827
   quotes (812 transcribed, 15 unparsed), 282 merged from a second source,
   221 concepts, 782 relations; works 283 in Zotero, 33 ambiguous (several
   editions), 183 unmatched, and after matching editions by full title,
   292, 24, and 183. A read-only service: MCP over HTTP at `/mcp`
   (stateless) and stdio, with `search_quotes`, `get_quote`, `cite_quote`,
   `list_concepts`, `get_concept`, and `quote_worklist`; admin pages at
   `/admin` (overview, quote search, a quote with its citation, the concept
   scheme, the worklists); `export` and nightly backups. Deployed to
   quote-mcp.localdomain (Debian 13 LXC, port 8000; `npm run deploy`), public
   at https://quote-mcp.majerus.us behind Cloudflare Access (Managed OAuth).
   Works without a Zotero item are listed for filing; filing them is the
   first Zotero write, so it waits for phase 4 unless they're filed by hand.
2. **Repair.** Editing and history on the admin pages, proposals,
   tag hygiene, the corpus-mcp verify endpoint, the OCR detector's agent
   pass, and shelf sessions.
3. **Notes.** Built 2026-10-27: the `kind` field (schema 2, added by `quote-mcp
   migrate`, which deploy runs before restarting the read-only server), the
   tag-or-note classifier, Zotero notes tagged `margin` imported as notes,
   the `kind` filter in `search_quotes` and the admin pages, and
   `cite_quote` on a note. No notes exist yet. Still to come: the ebook
   highlight import, once the Kindle books are retrieved and it's known
   which source holds the annotations.
4. **Capture.** The capture form, `add_quote` and `add_note`, filing new
   books into staging (the first Zotero writes), and Zotero annotations as
   a source.
5. **Zotero copies.** The read-only book notes.
6. **Corpus quotes.** The anchor split and migration described above.
7. **The public site.** In this order: the `catalogue` level (front page,
   concepts, sets, works, the maps menu) with `QUOTE_PUBLIC_PORT` (built
   2026-10-28, `src/site.ts`, with collections; the public port answers 404 for
   `/api/concepts/:slug/quotes` until the quotes level cuts it to public
   fields); then the
   `quotes` level (quote pages, "cite this", search; built 2026-10-28,
   `src/public.ts` deciding what a record may show, and the public port's
   map API cut to public records and counts). Then the move to a Worker
   and D1 ("Hosting the public site"), in this order: the snapshot builder
   and `publish --dry-run`, with the LAN preview and the public port reading
   it (built 2026-10-28); `src/site.ts` behind the async store interface
   (built 2026-10-28); the Worker under `wrangler dev` with a local D1 (built 2026-10-28); the queue and the drain (built 2026-10-28); then
   `/site.json`, the key list, and the links with corpus-mcp, whose rows are
   queued like any other when the other site's key list changes. Deployed
   2026-10-28 with the user's token: the D1 database `quote-mcp-public`
   (ENAM, migration applied), the proxy at
   `quote-mcp-d1-proxy.jmajerus.workers.dev` with its `D1_PROXY_TOKEN`
   secret, and the public Worker on the custom domain `quotes.majerus.us`
   (until then a tunnel route to the whole server with no login, which the
   user removed). The LXC's drain needs the proxy's two settings.

## Open questions

- **Write access.** Phase 4 needs a Zotero key with write access, which can
  write any item, not only staging. Is that acceptable, or should new books
  go through the Zotero MCP server instead?
- **Legacy notes.** Once a book's quotes are repaired, keep its original
  notes as they are, or let Quote MCP replace them with its copy note?
- **Libraries.** Most group quotes duplicate the personal library's. Cite
  from the personal library only, and treat the group as a source of quotes
  and tags?
- **Concepts and the living taxonomy.** Settled 2026-11-01: terminology-mcp
  holds `human-work` as a scheme of its own, beside the subject
  vocabularies, and Quote MCP follows it. Links between the schemes are
  terminology-mcp's to make.
- **Kindle locations.** Keep them as a locator kind, and re-locate them when
  the book reaches Calibre? They can't be converted to pages reliably.
- **Ebook annotations.** Which source holds the Kindle highlights and
  notes (`My Clippings.txt`, Amazon's notebook export, Calibre, KOReader)?
  Known once the Kindle books are retrieved.
- **Hosting and name.** The corpus-mcp LXC, or a new one; "Quote MCP" or
  something else.
