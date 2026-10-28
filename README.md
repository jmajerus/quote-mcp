# quote-mcp

A store of quotations from books, most of them paper books, and of your own margin notes on them, as structured records you can search, tag, repair, and cite, with an MCP server and admin pages. [PLAN.md](PLAN.md) is the plan of record.

## Commands

| Command | What it does |
|---|---|
| `npm run import` | Syncs the Zotero mirror, reads the old Drupal site, and imports. Safe to run again. |
| `npm run serve` | MCP at `/mcp`, the admin pages at `/admin`, the JSON API at `/api`, the concept map at `/map/` when `QUOTE_MAP_DIR` is set, and the public site at `/` when `vocab/site.md` makes it public (port `QUOTE_PORT`, default 8010; a public-only port with `QUOTE_PUBLIC_PORT`). |
| `npm run quotes -- stdio` | MCP over stdio. |
| `npm run quotes -- migrate` | Brings the store up to this build's schema. Deploy runs it. |
| `npm run quotes -- export --out quotes.json` | Everything as JSON. |
| `npm run quotes -- backup` | An SQLite backup in `data/backups`, keeping 14. |
| `npm run quotes -- config` | Every setting, where it came from, and what each feature still needs. |
| `npm run quotes -- stats` | Counts by status, origin, work match, and scheme. |
| `npm run quotes -- publish --dry-run` | Builds the public snapshot (`public.db` beside the store, or `QUOTE_SNAPSHOT`), which the public pages read. Imports and deploys rebuild it. |
| `npm run quotes -- sets` | Each concept set as the store has it now; fails if a set names a concept its scheme doesn't have. |
| `npm run survey` | Phase 0's read-only survey (`-- --source drupal` for the old site). |
| `npm run quotes -- publish` | Builds the snapshot and ships what changed to its replica in D1, as the server's drain does every 15 seconds; `--status` shows the queue. |
| `npm run quotes -- publish --sql <file>` | The snapshot as a SQL file that loads a D1 replica from scratch. |
| `npm run worker:load`, `npm run worker:dev` | Load the snapshot into a local D1 and run the public site's Worker ([worker/](worker/)) on it, at `http://localhost:8787`. |
| `npm run worker:proxy` | The D1 proxy the drain can ship through ([worker/proxy.ts](worker/proxy.ts)), locally on port 8788. |
| `npm test` | The tests. |

To add a margin note, write it as a Zotero note on the book and tag it `margin`. End it with `(p. 51)` to give a page. A note that only names concepts (`mobbing, false self`) is read as tags; `.mobbing` anywhere in the note is always a tag.

To define a concept set (a part of a scheme, for a map, a theme, or search), add it to [vocab/sets.json](vocab/sets.json) and check it with `npm run quotes -- sets`. A set lists its `concepts`, or gives a recipe that's worked out on each request, so a concept added later joins the sets that reach it: `around` (those concepts and their neighbours, `depth` steps out, default 1, along `types`: broader, narrower, related, opposite; default all), `narrower` (those and everything under them), and `exclude`. They combine:

```json
{ "slug": "despair", "scheme": "human-work", "label": "Despair and its neighbours",
  "description": "…", "around": ["despair"], "depth": 1, "types": ["related", "opposite"], "exclude": ["pain"] }
```

A malformed file stops the server starting (so a deploy rolls back); a slug the scheme doesn't have is left out and shown as `missing`. A set's `types` decide only who's in it; quote-atlas's export keeps its own edge filter (related only by default), so `around` with all types takes in more concepts than its `--around` does.

To publish your collection, set `public:` in the header of [vocab/site.md](vocab/site.md) and build the snapshot. The public pages, and the public port's API, read only that snapshot, never the store, so they can show only what was published.

```
---
public: quotes
notes: none
---
# A commonplace book
```

`public:` is `none` (the default), `catalogue`, or `quotes`: `catalogue` shows concepts, sets, maps, and works by title and author, with counts but no quoted text; `quotes` adds a page per quote with how to cite it (Pandoc, BibTeX, CSL JSON), search, and the quotes on each concept's, set's, and work's page. The old site's markup is tidied for display: `[bib]…[/bib]` markers are dropped and `*emphasis*` is shown as emphasis; the store keeps the text as imported. The front page's title and introduction follow the header: a `# Title` line, then paragraphs. Each concept scheme is a *collection* to readers, with a page at `/collections/<scheme>` introduced by `vocab/collections/<scheme>.md` (see [human-work.md](vocab/collections/human-work.md)); with several, the front page has a card for each, and with one it's shown inline. Notes, and the comments on quotes, stay private unless `notes: all`, and a note tagged `private` in Zotero stays private even then. Unparsed quotes, flags, worklists, `/admin`, and `/mcp` are never public. For a hostname with no login in front of it, set `QUOTE_PUBLIC_PORT` and point the hostname there: that port serves only the snapshot's pages and the map's API routes from it (403 for quotes below the `quotes` level), and `/map/`, and 404 for everything else. The public site can also be served by a Cloudflare Worker ([worker/](worker/)) from a replica of the snapshot in D1, with the same pages and API; it runs locally with `npm run worker:load` and `npm run worker:dev`, and [worker/wrangler.jsonc](worker/wrangler.jsonc) says what a real deploy needs. While the server runs, its drain keeps the replica in step: when the snapshot is rebuilt, the rows that changed are queued in `replica.db` beside it and shipped to D1 within 15 seconds, through the D1 proxy Worker (`QUOTE_D1_PROXY_URL`, `QUOTE_D1_PROXY_TOKEN`). A failure leaves them queued for the next tick; `/health` shows the drain's state.

## Settings

Settings are in `.env` (`/etc/quote-mcp/env` on the server); see [.env.example](.env.example). Only `QUOTE_ZOTERO_LIBRARY` and `QUOTE_ZOTERO_API_KEY` are needed. `npm run quotes -- config` lists every setting, where each came from (the environment, `vocab/site.md`, or its default), and what each feature still needs; secrets show only as set. The rest have defaults and rarely need changing:

| Setting | Default | What it is |
|---|---|---|
| `QUOTE_PUBLIC`, `QUOTE_PUBLIC_NOTES` | `public:` and `notes:` in `vocab/site.md` | Override the public site's choices on one machine. |
| `QUOTE_PUBLIC_PORT` | none | A port serving only the public site, for a hostname with no login. |
| `QUOTE_DB` | `data/quotes.db` | The store. |
| `QUOTE_HOST`, `QUOTE_PORT` | `0.0.0.0`, `8010` | Where the service listens. |
| `QUOTE_SETS` | `vocab/sets.json` | The concept sets. |
| `QUOTE_INTRO` | `vocab/site.md` | The front page and the public site's choices. |
| `QUOTE_SNAPSHOT` | `public.db` beside the store | The public snapshot. |
| `QUOTE_DICTIONARY` | `/usr/share/dict/words` | The OCR check's word list. |
| `QUOTE_ZOTERO_API` | `https://api.zotero.org` | The Zotero API. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `QUOTE_D1_DATABASE_ID` | none; the database id from `worker/wrangler.jsonc` | Instead of the D1 proxy, Cloudflare's REST API (slower). Only `CLOUDFLARE_ACCOUNT_ID` turns it on, since wrangler reads `CLOUDFLARE_API_TOKEN` too. |
| `QUOTE_DEPLOY_HOST` | `authoring@quote-mcp.localdomain` | Where `npm run deploy` installs. |
| `QUOTE_STATUS_URL` | `http://quote-mcp.localdomain:8000` | The server the VS Code status item asks. |

## MCP tools

All read-only for now; `search_quotes` finds quotes and notes (filter with `kind`), and it and `list_concepts` take a concept `set`: `search_quotes`, `get_quote`, `cite_quote`, `list_concepts`, `get_concept`, `list_sets`, `quote_worklist`.

## HTTP routes

| Route | What it is |
|---|---|
| `POST /mcp` | MCP over Streamable HTTP (stateless). |
| `GET /admin` | The admin pages. |
| `GET /api/graph` | Every concept (with its quote count and `source`) and every relation, as JSON. |
| `GET /api/concepts/:slug` | One concept, as `get_concept` returns it; `scheme:slug` works too. |
| `GET /api/concepts/:slug/quotes` | Its quotes and notes; `narrower=false`, `limit` (up to 100), `offset`. |
| `GET /api/sets` | The concept sets, with how many concepts each has and any `missing` slugs. |
| `GET /api/sets/:slug` | One set as a piece of the graph: `concepts` and `relations` as `/api/graph` gives them, with the set's `slug`, `scheme`, `label`, `description`, `definition`, and `missing`. |
| `GET /map/` | The concept maps' built files from `QUOTE_MAP_DIR` (quote-atlas): a menu, and each map at `/map/<name>/`. |
| `GET /` | The public site's front page when it's public (`public:` in `vocab/site.md`); otherwise a redirect to `/admin`. |
| `GET /collections/:scheme`, `/concepts`, `/concepts/:slug`, `/sets/:slug`, `/works`, `/works/:id` | The public site's pages; `/concepts` and `/works` take `?collection=`. |
| `GET /quotes/:id`, `/search?q=` | At the `quotes` level: a quote's page, and search (`collection` narrows it). |
| `GET /health` | Version, counts, and what the last deploy installed. |

The API is read-only and a contract with the map: add fields, but keep the routes and existing fields stable.
