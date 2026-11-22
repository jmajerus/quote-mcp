# The public site

quote-mcp can publish the collection: a front page, its collections and concepts, its works, and (if you
choose) its quotes, with a page per quote and how to cite it. This site's is at
[quotes.majerus.us](https://quotes.majerus.us). The design is in [PLAN.md](../PLAN.md) ("The public site").

## Turning it on

The site's choices are in a header at the top of [vocab/site.md](../vocab/site.md), kept in git with its title
and introduction:

```
---
public: quotes
notes: none
holdings: https://holdings.majerus.us
---
# A commonplace book

Passages from books, collected over years and kept in Zotero.
```

| Setting | Values |
|---|---|
| `public:` | `none` (the default: no public site), `catalogue` (concepts, sets, maps, and works, with counts but no quoted text), or `quotes` (the catalogue, plus quote pages, search, and the quotes on each page) |
| `notes:` | `none` (the default) or `all`: whether notes, and the comments on quotes, are public. Only at `quotes`. |
| `holdings:` | The public holdings site (holdings-mcp). A work's page links to `<holdings>/?key=quote:<id>`, which lists that work's copies (Zotero, Calibre, and quotes). The link appears in the page's subtitle and on the title in each quote's source line, which would otherwise point back to the page itself. Unset, the title isn't linked. |

`QUOTE_PUBLIC`, `QUOTE_PUBLIC_NOTES`, and `QUOTE_PUBLIC_HOLDINGS` override them on one machine. After the header, a `# Title` line and
paragraphs make the front page's introduction. Each collection's introduction is in
`vocab/collections/<scheme>.md` (see [Concepts](concepts.md#collections)).

## What is public

- **Public:** at `catalogue`, concepts, sets, maps, collections, and works by title and author, with counts. At
  `quotes`, also each quote's text, place, work, and concepts, with its citation (Pandoc, BibTeX, CSL JSON).
- **Only with `notes: all`:** notes, and the comments on quotes; a note tagged `private` in Zotero stays
  private even then.
- **Never:** unparsed quotes, flags, suspect words, plain tags, origins, history, the worklists, `/admin`, and
  `/mcp`.
- **Only once a person promotes it:** a record a generative agent saved, and part of a sentence no person saved
  (below).

### Chosen by a person

A quote saved because a piece cites it is a citation; one you chose to keep is a collected passage. An agent writing an
article saves the exact words it quotes, often part of a sentence, and those shouldn't appear beside the passages you chose.
So, unless a person has promoted it, the snapshot leaves out:

- **a record a generative agent saved** (its [provenance stamp](provenance.md) says `generative: true`, shown as G875),
  whole sentence or not. Which passages the collection shows is your judgement, not an agent's.
- **part of a sentence**, unless a person saved it (on the capture page, or on the old site): saving it by hand was the
  choice. One whose saver isn't recorded, such as a Zotero note, is left out.

Whether the words are a whole sentence is read from the book where there is one. A quote checked against a Calibre book keeps
corpus-mcp's anchor, with the book's text just before and after it, so the store knows whether the words begin after a
sentence's end and end at one: "collaboration consists in generating possibility." is a whole clause but begins
mid-sentence, and a capital after a comma is a name, not a sentence's start. Where the anchor has no text on a side (the
passage begins a page), or there's no anchor (a paper book's quote), the words' shape decides that side: a capital or number
first, a stop last, no ellipsis.

To promote a record, use the **Promote** button beside **Public site** on its admin page, or
`quote-mcp promote <id>,…`. Either records a `promoted` history entry under your login; **Take back** (or `--undo`)
records `unpromoted`, and the record follows the rules above again. No MCP tool promotes. `quote-mcp promote` with no ids
lists what's held back, and why. `get_quote` returns the decision as `public`: `shown`, `reason`, `promoted`, and `sentence`
(`starts`, `ends`, and `judged_by`: `source` or `shape`). Nothing is deleted: a held-back quote keeps its id, its citation,
and every draft marker that names it. An admin promotion appears on the public site at the next import (within 30 minutes);
the CLI republishes at once.

The old site's markup is tidied for display: a leftover `[bib]Key[/bib]` marker is shown as a Pandoc citekey
(`[@Key]`), and `*emphasis*` is shown as emphasis. Drupal is retired. `quote-mcp citekeys` is the one-time
migration that writes each marker's Better BibTeX citekey into the stored text and comments. A snapshot
then expands those citekeys the way Pandoc does, in Chicago author-date: `[@ryan1991driving, p. 12]` is
shown as `(Ryan and Oestreich 1991, 12)`. A key with no CSL record stays `[@Key]`, as does a key shared by
two items when the primary library does not have exactly one of them. The stored text keeps
the citekey, and Cite this still shows the Pandoc citation to paste into a manuscript.

## The snapshot

The public pages never read the store. `npm run quotes -- publish --dry-run` builds a *snapshot*, `public.db`
beside the store (`QUOTE_SNAPSHOT`), holding only what's public; imports and deploys rebuild it. The pages read
only the snapshot, so they can't show what wasn't published, whatever they do. At the `catalogue` level its
records carry no words, only what the pages need to count.

On the LAN, `/` previews the public site from the snapshot (`http://quote-mcp.localdomain:8000/`). With
`public: none`, `/` goes to the admin pages.

## The Worker and its replica in D1

[quotes.majerus.us](https://quotes.majerus.us) is a Cloudflare Worker ([worker/](../worker/)) serving the same
pages from a replica of the snapshot in D1. Only what was published ever leaves the LAN, and the site stays up
when the LAN is down.

- **The drain.** While the server runs, it checks every 15 seconds whether the snapshot was rebuilt. If so, it
  queues the rows that changed (in `replica.db` beside it) and ships them to D1, through the D1 proxy Worker
  ([worker/proxy.ts](../worker/proxy.ts), behind a token). One tick ships at a time. A failure leaves rows
  queued for the next tick, and the "published" marker is written last, so readers never see half a
  publication. `npm run quotes -- publish` runs one tick by hand; `publish --status` shows the queue.
- **Caching.** D1's free tier allows five million rows read a day, and a page reads thousands, so the Worker
  keeps each page and API answer in Cloudflare's cache under the snapshot's hash. Past a page's first view in a
  data centre, a request reads only the snapshot's `meta`; a new publication is a new hash, so nothing goes
  stale. `/robots.txt` asks crawlers to leave `/search` and `/api/` alone, since every search is new.
- **Settings.** The server needs `QUOTE_D1_PROXY_URL` and `QUOTE_D1_PROXY_TOKEN` (see
  [Operations](operations.md#settings)).
- **Deploying the Worker.** Deploy Quotes → Deploy the public Worker (`npm run worker:deploy`). A deploy of
  quote-mcp itself doesn't change the Worker.
- **Locally.** `npm run worker:load` loads the snapshot into a local D1, and `npm run worker:dev` runs the
  Worker on it at `http://localhost:8787`. `npm run worker:proxy` runs the proxy, on port 8788; two local
  Workers can't share one local D1, so run them one at a time.
- **Watching it.** The `$(cloud)` item in VS Code's status bar shows the replica (see
  [Operations](operations.md#status-bar)).

Without Cloudflare, `QUOTE_PUBLIC_PORT` gives a second port that serves only the snapshot's pages and API, and
`/map/`, for any proxy to put a public hostname in front of.

## Pages

| Route | What it is |
|---|---|
| `/` | The front page: the introduction, counts, the collections, maps, starting points (concept sets), ways to browse, and at `quotes` a search box and the newest quotes. |
| `/collections/<scheme>` | A collection: its introduction, counts, maps, sets, concepts, and works. |
| `/concepts`, `/concepts/<slug>` | Concepts A to Z; a concept's definition, relations, sets, map link, and its quotes or the works that quote it. `?collection=` narrows the list. |
| `/sets/<slug>` | A concept set: its concepts, and at `quotes` its quotes. |
| `/works`, `/works/<id>` | Works by first author; a work's concepts and, at `quotes`, its quotes in page order. `?collection=` narrows the list. |
| `/quotes/<id>` | At `quotes`: a quote, its source and concepts, and how to cite it. |
| `/search` | At `quotes`: search by words, concept, author, or work. A concept search starts with that concept. `include` adds `narrower`, `broader`, `related`, or `opposite`, and `exact` can be left out. `kind` is `quote` or `note` when notes are shared. `collection` narrows it. `read` shares that search as the quotes in full, with one link back to the form. |
| `/robots.txt` | Keeps crawlers off `/search` and `/api/`. |
| `/favicon.png` | The tab icon (see [assets/favicon.svg](../assets/favicon.svg)). |

## The API, for the maps

A read-only JSON API, which the concept maps (quote-atlas, at `/map/`) read from the same origin. Its routes and
fields are a contract with the maps: add fields, but keep the routes and existing fields.

| Route | What it is |
|---|---|
| `GET /api/graph` | Every concept (with its quote count and `source`) and every relation. |
| `GET /api/concepts/<slug>` | One concept, as `get_concept` returns it; `scheme:slug` works too. |
| `GET /api/concepts/<slug>/quotes` | Its quotes and notes; `narrower=false`, `limit` (up to 100), `offset`. |
| `GET /api/sets` | The concept sets, with how many concepts each has and any `missing` slugs. |
| `GET /api/sets/<slug>` | One set as a piece of the graph, in `/api/graph`'s shape, with the set's `slug`, `scheme`, `label`, `description`, `definition`, and `missing`. |

On the LAN (port 8000), `/api` answers from the store, with everything. On the public site it answers from the
snapshot: counts of public records, quotes as public records (`id`, `kind`, `text`, `locator`,
`chapter_author`, `attribution`, `work`, `concepts`), and 403 for quotes below the `quotes` level.

## The maps

The maps' own files are quote-atlas's. On the LAN, quote-mcp serves them at `/map/` from `QUOTE_MAP_DIR`. On
quotes.majerus.us they'd be quote-atlas's own Worker on the `/map/*` route, which isn't built yet. The front page
lists the maps in `QUOTE_MAP_DIR`'s `maps.json` when the snapshot is built.
