# MCP tools

quote-mcp's tools, at `/mcp` (Streamable HTTP, stateless) and over stdio (`npm run quotes -- stdio`). All are
read-only for now: nothing an agent does changes the store. Editing comes with phase 2's repair tools (see
[PLAN.md](../PLAN.md)).

| Tool | Title | What it does |
|---|---|---|
| `search_quotes` | Search quotes | Searches quotes and notes by words, concept, tag, author, work, flag, status, kind, or concept set |
| `get_quote` | Get a quote | One record in full: text, locator, work, tags, comment, suspect words, origins, history |
| `cite_quote` | Cite a quote | A CSL JSON item for the work, the locator, the citekey, and a Pandoc citation |
| `list_concepts` | List concepts | The concepts, with definitions, alternative labels, and quote counts |
| `get_concept` | Get a concept | One concept, its relations, and its quote counts |
| `list_sets` | List concept sets | The named concept sets, with how many concepts each has |
| `quote_worklist` | Quote worklist | What needs a person: unparsed quotes, unmatched works, tags that aren't concepts, flags |

## The typical flow

`search_quotes` (by words, a concept, an author, or a work) → `get_quote` for the whole record →
`cite_quote` for the citation.

## search_quotes

Every argument is optional, and they combine.

| Argument | What it does |
|---|---|
| `query` | Words or `"quoted phrases"`, looked for in what a quote says and its comment, not its tags. Words are ANDed; a trailing `*` matches the start of a word. Results are ranked, with matches in `«»` in the snippet. |
| `concept` | A concept by label, alternative label, slug, or `scheme:slug`. Narrower concepts are included unless `narrower` is `false`. |
| `set` | A concept set's slug (see [Concepts](concepts.md)): only quotes tagged with one of its concepts. |
| `tag` | An exact tag, including tags that aren't concepts. |
| `author` | Part of an author's name, a chapter author, or an attribution. |
| `work` | Part of a work's title, its Zotero item key, or its citekey. |
| `flag` | One of the import's flags, such as `no_locator` or `ocr_suspect` (see [Importing](importing.md#flags)). |
| `status` | `transcribed`, `verified`, `unparsed`, or `any`. By default everything but `unparsed`. |
| `kind` | `quote`, `note`, or `any` (the default). |
| `limit`, `offset` | Up to 100 a page; 20 by default. |

Each result has its kind, text (a note's words are in `note`), work, locator, tags, and flags.

## cite_quote

Returns the quote, a CSL JSON item for its work (from Zotero, or the old site's record when the work isn't in
Zotero yet), the locator, the Better BibTeX citekey, and a Pandoc citation such as
`[@roberts1993victory, p. 44]`. `warnings` says what to check first: no page, possible OCR errors, a work
not yet filed in Zotero. When a work has several editions in Zotero, `editions` lists each one's citekey;
cite the edition the page number belongs to. On a note, it gives the work and the place, and says there's
no quotation to cite.

## Notes beside quotes

A note is your own words at a place in a work, with no quoted text: its words are in `note`. Search finds
notes and quotes together unless `kind` is given. See [Importing](importing.md#margin-notes) for how notes
get in.
