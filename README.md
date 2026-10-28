# quote-mcp

A store of quotations from books, most of them paper books, and of your own margin notes on them, as structured records you can search, tag, repair, and cite, with an MCP server and admin pages. [PLAN.md](PLAN.md) is the plan of record.

## Commands

| Command | What it does |
|---|---|
| `npm run import` | Syncs the Zotero mirror, reads the old Drupal site, and imports. Safe to run again. |
| `npm run serve` | MCP at `/mcp`, the admin pages at `/admin`, the JSON API at `/api`, the concept map at `/map/` when `QUOTE_MAP_DIR` is set, and the public site at `/` when `QUOTE_PUBLIC` is set (port `QUOTE_PORT`, default 8010; a public-only port with `QUOTE_PUBLIC_PORT`). |
| `npm run quotes -- stdio` | MCP over stdio. |
| `npm run quotes -- migrate` | Brings the store up to this build's schema. Deploy runs it. |
| `npm run quotes -- export --out quotes.json` | Everything as JSON. |
| `npm run quotes -- backup` | An SQLite backup in `data/backups`, keeping 14. |
| `npm run quotes -- stats` | Counts by status, origin, work match, and scheme. |
| `npm run quotes -- sets` | Each concept set as the store has it now; fails if a set names a concept its scheme doesn't have. |
| `npm run survey` | Phase 0's read-only survey (`-- --source drupal` for the old site). |
| `npm test` | The tests. |

To add a margin note, write it as a Zotero note on the book and tag it `margin`. End it with `(p. 51)` to give a page. A note that only names concepts (`mobbing, false self`) is read as tags; `.mobbing` anywhere in the note is always a tag.

To define a concept set (a part of a scheme, for a map, a theme, or search), add it to [vocab/sets.json](vocab/sets.json) and check it with `npm run quotes -- sets`. A set lists its `concepts`, or gives a recipe that's worked out on each request, so a concept added later joins the sets that reach it: `around` (those concepts and their neighbours, `depth` steps out, default 1, along `types`: broader, narrower, related, opposite; default all), `narrower` (those and everything under them), and `exclude`. They combine:

```json
{ "slug": "despair", "scheme": "human-work", "label": "Despair and its neighbours",
  "description": "…", "around": ["despair"], "depth": 1, "types": ["related", "opposite"], "exclude": ["pain"] }
```

A malformed file stops the server starting (so a deploy rolls back); a slug the scheme doesn't have is left out and shown as `missing`. A set's `types` decide only who's in it; quote-atlas's export keeps its own edge filter (related only by default), so `around` with all types takes in more concepts than its `--around` does.

To publish your collection, set `QUOTE_PUBLIC`: `catalogue` shows concepts, sets, maps, and works by title and author, with counts but no quoted text; `quotes` adds quote text with citations (the `quotes` pages are still to come). The front page's title and introduction come from [vocab/site.md](vocab/site.md), a `# Title` line then paragraphs. Notes stay private unless `QUOTE_PUBLIC_NOTES=all`, and a note tagged `private` in Zotero stays private even then. Unparsed quotes, flags, worklists, `/admin`, and `/mcp` are never public. For a hostname with no login in front of it, set `QUOTE_PUBLIC_PORT` and point the hostname there: that port serves only the public pages, `/map/`, and the API routes with no quoted text, and 404 for everything else.

Configuration is in `.env`; see [.env.example](.env.example).

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
| `GET /` | The public site's front page when `QUOTE_PUBLIC` is set; otherwise a redirect to `/admin`. |
| `GET /concepts`, `/concepts/:slug`, `/sets/:slug`, `/works`, `/works/:id` | The public site's pages. |
| `GET /health` | Version, counts, and what the last deploy installed. |

The API is read-only and a contract with the map: add fields, but keep the routes and existing fields stable.
