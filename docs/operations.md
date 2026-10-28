# Operations

How quote-mcp is run, configured, and deployed.

## Commands

| Command | What it does |
|---|---|
| `npm run import` | Syncs the Zotero mirror, reads the old site, and imports (see [Importing](importing.md)). Safe to run again. |
| `npm run serve` | MCP at `/mcp`, the admin pages at `/admin`, the JSON API at `/api`, the maps at `/map/` (with `QUOTE_MAP_DIR`), the public site's preview at `/`, and `/health`; port `QUOTE_PORT` (8010 by default). With D1 settings it also runs the replica's drain. |
| `npm run quotes -- stdio` | MCP over stdio. |
| `npm run quotes -- migrate` | Brings the store up to this build's schema. Deploy runs it. |
| `npm run quotes -- config` | Every setting, where it came from, and what each feature still needs; secrets show only as set. |
| `npm run quotes -- stats` | Counts by status, origin, work match, and scheme. |
| `npm run quotes -- sets` | Each concept set as the store has it now; fails on a concept its scheme doesn't have. |
| `npm run quotes -- publish --dry-run` | Builds the public snapshot (see [the public site](public-site.md#the-snapshot)). |
| `npm run quotes -- publish` | Builds it and ships what changed to the replica in D1, as the drain does; `--status` shows the queue. |
| `npm run quotes -- publish --sql <file>` | The snapshot as a SQL file that loads a D1 replica from scratch. |
| `npm run quotes -- export --out quotes.json` | Everything as JSON. |
| `npm run quotes -- backup` | A SQLite backup in `data/backups`, keeping 14. |
| `npm run survey` | Phase 0's read-only survey of the sources (`-- --source drupal` for the old site). |
| `npm run worker:load`, `npm run worker:dev` | Loads the snapshot into a local D1 and runs the public Worker on it at `http://localhost:8787`. |
| `npm run worker:proxy` | The D1 proxy Worker, locally on port 8788. |
| `npm run worker:deploy` | Runs the tests, then deploys the public Worker to quotes.majerus.us. |
| `npm run deploy` | Deploys quote-mcp to its server (see [Deploying](#deploying)). |
| `npm test` | The tests. |

## Settings

Settings come from the environment: `.env` in the checkout on your computer (see
[.env.example](../.env.example)), and `/etc/quote-mcp/env` on the server, which the services read. They're
separate files; Deploy Quotes → Push the server's settings copies the server's from `.env` (see below).

Only `QUOTE_ZOTERO_LIBRARY` and `QUOTE_ZOTERO_API_KEY` are needed. The public site's choices are in
`vocab/site.md`, not here (see [the public site](public-site.md#turning-it-on)).

| Setting | Default | What it is |
|---|---|---|
| `QUOTE_ZOTERO_LIBRARY`, `QUOTE_ZOTERO_API_KEY` | required | The Zotero library (`users/<id>` or `groups/<id>`) and an API key; read-only is enough. |
| `QUOTE_ZOTERO_SOURCES` | none | Other Zotero libraries to import quote notes from, comma-separated. |
| `QUOTE_DRUPAL_URL` | none | The old Drupal site's database (`mysql://…`), read-only. |
| `QUOTE_MAP_DIR` | none | quote-atlas's built maps, served at `/map/`. |
| `QUOTE_D1_PROXY_URL`, `QUOTE_D1_PROXY_TOKEN` | none | The D1 proxy and its token, for the public replica's drain. |
| `QUOTE_PUBLIC`, `QUOTE_PUBLIC_NOTES` | `public:` and `notes:` in `vocab/site.md` | Override the public site's choices on one machine. |
| `QUOTE_PUBLIC_PORT` | none | A port serving only the public site, for a hostname with no login. |
| `QUOTE_DB` | `data/quotes.db` | The store. |
| `QUOTE_HOST`, `QUOTE_PORT` | `0.0.0.0`, `8010` | Where the service listens. |
| `QUOTE_SETS` | `vocab/sets.json` | The concept sets. |
| `QUOTE_INTRO` | `vocab/site.md` | The front page and the public site's choices. |
| `QUOTE_SNAPSHOT` | `public.db` beside the store | The public snapshot. |
| `QUOTE_DICTIONARY` | `/usr/share/dict/words` | The OCR check's word list. |
| `QUOTE_ZOTERO_API` | `https://api.zotero.org` | The Zotero API. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `QUOTE_D1_DATABASE_ID` | none; the database id from `worker/wrangler.jsonc` | Instead of the proxy, Cloudflare's REST API (slower). Only `CLOUDFLARE_ACCOUNT_ID` turns it on, since wrangler reads `CLOUDFLARE_API_TOKEN` too, to deploy the Workers. |
| `AUTHORING_DEPLOY_PASSWORD` | none | The deploy account's SSH password. |
| `QUOTE_DEPLOY_HOST` | `authoring@quote-mcp.localdomain` | Where `npm run deploy` installs. |
| `QUOTE_STATUS_URL` | `http://quote-mcp.localdomain:8000` | The server the status-bar items ask. |

## The server

quote-mcp runs on a Debian LXC, quote-mcp.localdomain, on port 8000.

- **Services.** `quote-mcp.service` (the server), `quote-import.timer` (an import every 30 minutes, without the
  old site), and `quote-backup.timer` (a backup at 03:45, keeping 14 in `/var/lib/quote-mcp/backups`).
- **Files.** The store, the snapshot (`public.db`), the replica's queue (`replica.db`), and the deploy record
  (`deployed.json`) are in `/var/lib/quote-mcp`; releases in `/opt/quote-mcp/releases`, the current one linked
  as `/opt/quote-mcp/current`; the maps in `/opt/quote-mcp/map`.
- **Access.** On the LAN, `http://quote-mcp.localdomain:8000`. From outside, `https://quote-mcp.majerus.us`,
  behind Cloudflare Access (Claude's connector and the admin pages). The public site is separate, at
  quotes.majerus.us.
- **`/health`** gives the version, counts, what the last deploy installed, and the replica's drain.

## Deploying

The **Deploy Quotes** button in VS Code's status bar runs the deploys, as `npm run deploy` does:

| Menu entry | Command | What it does |
|---|---|---|
| Deploy this checkout | `npm run deploy` | Builds, tests, installs this checkout as a new release, migrates the store, builds the public snapshot, restarts, checks `/health`, and rolls back to the previous release if it fails. |
| Deploy this checkout without tests | `npm run deploy -- --skip-tests` | The same, without the tests. |
| Push the server's settings | `npm run deploy -- --env` | Copies the server's settings from `.env` into `/etc/quote-mcp/env` and restarts, waiting until the server answers: the Zotero and old-site settings and the D1 proxy's. Only those set in `.env` are replaced. |
| Deploy the public Worker | `npm run worker:deploy` | Tests, then deploys the public Worker with `CLOUDFLARE_API_TOKEN` from `.env`. |
| Import with the old site | `npm run deploy -- --import-drupal` | Runs an import on the server with the old site included. |

`npm run deploy -- --provision` sets up a new server once: Node, build tools, the word list, the `quote` user,
and the folders.

## Status bar

Two items in VS Code's status bar, from the vscode-status-probe extension (set up in
[.vscode/settings.json](../.vscode/settings.json)):

| Item | What it shows |
|---|---|
| `$(quote) main` | The branch the server runs, `↓N` when it's behind origin, and `*` for uncommitted changes deployed. Refreshes every 5 minutes and after a deploy; opens the admin pages. |
| `$(cloud)` | The public replica: in step (`$(cloud)`), rows waiting (`$(cloud-upload) N`), no drain reported (`$(cloud) —`), the drain off for want of D1 settings (`$(cloud) off`), a failed drain (`$(cloud) !`), or a site that doesn't answer as published (`$(cloud) ?`). Refreshes every minute; opens quotes.majerus.us. |

Hover over an item for the details, including when it last checked.
