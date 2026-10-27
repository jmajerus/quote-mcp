# quote-mcp

A store of quotations from books, most of them paper books, as structured records you can search, tag, repair, and cite, with an MCP server and admin pages. [PLAN.md](PLAN.md) is the plan of record.

## Commands

| Command | What it does |
|---|---|
| `npm run import` | Syncs the Zotero mirror, reads the old Drupal site, and imports. Safe to run again. |
| `npm run serve` | MCP at `/mcp` and the admin pages at `/admin` (port `QUOTE_PORT`, default 8010). |
| `npm run quotes -- stdio` | MCP over stdio. |
| `npm run quotes -- export --out quotes.json` | Everything as JSON. |
| `npm run quotes -- backup` | An SQLite backup in `data/backups`, keeping 14. |
| `npm run quotes -- stats` | Counts by status, origin, work match, and scheme. |
| `npm run survey` | Phase 0's read-only survey (`-- --source drupal` for the old site). |
| `npm test` | The tests. |

Configuration is in `.env`; see [.env.example](.env.example).

## MCP tools

All read-only for now: `search_quotes`, `get_quote`, `cite_quote`, `list_concepts`, `get_concept`, `quote_worklist`.
