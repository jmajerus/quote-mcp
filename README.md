# quote-mcp

A store of quotations from books, most of them paper books, and of your own margin notes on them, as structured records you can search, tag, repair, and cite, with an MCP server and admin pages. [PLAN.md](PLAN.md) is the plan of record.

## Commands

| Command | What it does |
|---|---|
| `npm run import` | Syncs the Zotero mirror, reads the old Drupal site, and imports. Safe to run again. |
| `npm run serve` | MCP at `/mcp`, the admin pages at `/admin`, the JSON API at `/api`, and the concept map at `/map/` when `QUOTE_MAP_DIR` is set (port `QUOTE_PORT`, default 8010). |
| `npm run quotes -- stdio` | MCP over stdio. |
| `npm run quotes -- migrate` | Brings the store up to this build's schema. Deploy runs it. |
| `npm run quotes -- export --out quotes.json` | Everything as JSON. |
| `npm run quotes -- backup` | An SQLite backup in `data/backups`, keeping 14. |
| `npm run quotes -- stats` | Counts by status, origin, work match, and scheme. |
| `npm run survey` | Phase 0's read-only survey (`-- --source drupal` for the old site). |
| `npm test` | The tests. |

To add a margin note, write it as a Zotero note on the book and tag it `margin`. End it with `(p. 51)` to give a page. A note that only names concepts (`mobbing, false self`) is read as tags; `.mobbing` anywhere in the note is always a tag.

Configuration is in `.env`; see [.env.example](.env.example).

## MCP tools

All read-only for now; `search_quotes` finds quotes and notes (filter with `kind`): `search_quotes`, `get_quote`, `cite_quote`, `list_concepts`, `get_concept`, `quote_worklist`.

## HTTP routes

| Route | What it is |
|---|---|
| `POST /mcp` | MCP over Streamable HTTP (stateless). |
| `GET /admin` | The admin pages. |
| `GET /api/graph` | Every concept (with its quote count and `source`) and every relation, as JSON. |
| `GET /api/concepts/:slug` | One concept, as `get_concept` returns it; `scheme:slug` works too. |
| `GET /api/concepts/:slug/quotes` | Its quotes and notes; `narrower=false`, `limit` (up to 100), `offset`. |
| `GET /map/` | The concept maps' built files from `QUOTE_MAP_DIR` (quote-atlas): a menu, and each map at `/map/<name>/`. |
| `GET /health` | Version, counts, and what the last deploy installed. |

The API is read-only and a contract with the map: add fields, but keep the routes and existing fields stable.
