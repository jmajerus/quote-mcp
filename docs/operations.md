# Operations

How quote-mcp is run, configured, and deployed.

## Commands

| Command | What it does |
|---|---|
| `npm run import` | Syncs the Zotero mirror and imports quote notes (see [Importing](importing.md)). Safe to run again. Not needed to match works: see `rematch`. |
| `npm run quotes -- audit` | Compares typed quotes with their stored raw, by kind of problem, and changes nothing. `--id <n>` shows one side by side; `--kind <kind>` lists one kind. |
| `npm run quotes -- repair` | Repairs typed quotes from their stored raw where the reading is clean, and lists the rest. `--dry-run` shows before and after and saves nothing; `--id <n>` applies one. Back up first (`quote-mcp backup`). |
| `npm run quotes -- citekeys` | Rewrites Drupal `[bib]Key[/bib]` markers in quote text and comments as the work's Better BibTeX citekey (`[@ryan1991driving]`). A key that matches one current citekey is used; otherwise the old catalogue (`QUOTE_DRUPAL_URL`, `biblio.biblio_citekey`) picks the work by title and year. A key that is still ambiguous stays `[@Key]`. The chosen item is remembered, so a later run rewrites a stored `[@old]` when Better BibTeX has given that item a new citekey. `--dry-run` lists the keys and saves nothing. Back up first. |
| `npm run quotes -- authors` | One time: adds authors from the old catalogue to Zotero items in the Business and Literature collections that have none, matched by title and year. Prints the plan and writes nothing. `--apply` writes them (needs `QUOTE_ZOTERO_WRITE_KEY`). Better BibTeX refreshes the citekeys after the authors are there; run `citekeys` again so a stored citation follows. |
| `npm run quotes -- rematch` | Matches works to Zotero from the store, for works not matched yet and those whose item has gone. `--dry-run` lists what would move and saves nothing. |
| `npm run serve` | MCP at `/mcp`, the admin pages at `/admin`, the JSON API at `/api`, the maps at `/map/` (with `QUOTE_MAP_DIR`), the public site's preview at `/`, `/health`, and on the LAN only, holdings-mcp's counts feed at `/api/holdings/counts` and corpus-mcp's reader routes at `/api/corpus/quotes` (see [the dev-brief](dev-briefs/holdings-and-quotes.md)); port `QUOTE_PORT` (8010 by default). With D1 settings it also runs the replica's drain. |
| `npm run quotes -- stdio` | MCP over stdio. |
| `npm run quotes -- migrate` | Brings the store up to this build's schema. Deploy runs it with `--backup`, which copies the store first when its schema will change, so a rolled-back deploy can put the old store back. If that restore fails, the rollback leaves quote-mcp and the import timer stopped, prints `store_restore_failed` with where each store is, and a person puts the right one back. |
| `npm run quotes -- config` | Every setting, where it came from, and what each feature still needs; secrets show only as set. |
| `npm run quotes -- stats` | Counts by status, origin, work match, and scheme, and the Zotero mirror by library: the version the next import carries on from, items, notes, and deleted. |
| `npm run quotes -- sets` | Each concept set as the store has it now; fails on a concept its scheme doesn't have. |
| `npm run quotes -- publish --dry-run` | Builds the public snapshot (see [the public site](public-site.md#the-snapshot)). |
| `npm run quotes -- publish` | Builds it and ships what changed to the replica in D1, as the drain does; `--status` shows the queue. |
| `npm run quotes -- publish --sql <file>` | The snapshot as a SQL file that loads a D1 replica from scratch. |
| `npm run terms` | Follows terminology-mcp's `human-work` scheme: a dry run of what the next pass would apply and where it would stop. `-- --apply` applies it, `-- --accept <n> [--repoint <slug>]` passes a held change a person has handled, `-- --status` shows the cursor (see [the dev-brief](dev-briefs/human-work-from-terminology-mcp.md)). |
| `npm run quotes -- propose <tag>` | Proposes a tag that isn't a concept to terminology-mcp, with a quote that uses it as evidence; `--send` sends it. |
| `quote-mcp take-corpus-quotes --skip 2` | Once: takes over corpus-mcp's own saved quotes, each checked against its book again, and prints corpus-mcp's id and the new one for each (see [the dev-brief](dev-briefs/holdings-and-quotes.md), §2.3). `--dry-run` first. |
| `quote-mcp proposals` | Agents' proposed changes to quotes' text, page, or chapter author; `--accept <n>` or `--reject <n>` (with `--note "…"`) reviews one. Accepting applies it as your edit. |
| `npm run quotes -- export --out quotes.json` | Everything as JSON. |
| `npm run quotes -- backup` | A SQLite backup in a `backups` folder beside the store, keeping 14. |
| `npm run survey` | Phase 0's read-only survey of the Zotero notes. |
| `npm run worker:load`, `npm run worker:dev` | Loads the snapshot into a local D1 and runs the public Worker on it at `http://localhost:8787`. |
| `npm run worker:proxy` | The D1 proxy Worker, locally on port 8788. |
| `npm run worker:deploy` | Runs the tests, then deploys the public Worker to quotes.majerus.us. |
| `npm run deploy` | Deploys quote-mcp to its server (see [Deploying](#deploying)). |
| `npm test` | The tests. |

## Settings

Settings come from the environment: `.env` in the checkout on your computer (see
[.env.example](../.env.example)), and `/etc/quote-mcp/env` on the server, which the services read. They're
separate files; Deploy Quotes → Push the server's settings copies the server's from `.env` (see below).

Only `QUOTE_ZOTERO_LIBRARY` and `QUOTE_ZOTERO_API_KEY` are needed, and the key only when reading zotero.org. The public site's choices are in
`vocab/site.md`, not here (see [the public site](public-site.md#turning-it-on)).

| Setting | Default | What it is |
|---|---|---|
| `QUOTE_ZOTERO_LIBRARY`, `QUOTE_ZOTERO_API_KEY` | required | The Zotero library (`users/<id>` or `groups/<id>`) and an API key; read-only is enough. The key isn't needed when `QUOTE_ZOTERO_API` is holdings-mcp's copy. |
| `QUOTE_ZOTERO_WRITE_KEY` | the API key above | A key that can create items. The [capture page](admin-ui.md#capturing-a-quote) uses it to file a print book after its ISBN is accepted. |
| `QUOTE_ZOTERO_SOURCES` | none | Other Zotero libraries to import quote notes from, comma-separated. |
| `QUOTE_MAP_DIR` | none | quote-atlas's built maps, served at `/map/`. |
| `QUOTE_TERMS_SYNC` | `off` | `on`: the server follows terminology-mcp's `human-work` scheme every minute. Set it in `/etc/quote-mcp/env` only; a second follower would fight the server's cursor. |
| `TERMINOLOGY_BASE` | `http://terminology-mcp.localdomain:8000` | terminology-mcp on the LAN, where progress reports name the caller; `off` turns following off. |
| `CORPUS_BASE` | `http://corpus-mcp.localdomain:8000` | corpus-mcp on the LAN, which checks `add_quote`'s words against a Calibre book; `off` saves every quote transcribed (a Calibre book id then needs the work's key from `find_work` instead). |
| `QUOTE_WHISPER_URL` | none | The faster-whisper server, such as `http://whisper.localdomain:8000`. The [capture page](admin-ui.md#capturing-a-quote) sends a recording there. That server keeps nothing. |
| `QUOTE_HA_URL`, `QUOTE_HA_TOKEN` | none | Home Assistant and a long-lived access token, used when `QUOTE_WHISPER_URL` is unset. The capture page sends a recording to one of its speech engines. |
| `QUOTE_HA_STT` | Home Assistant Cloud, or the only engine | The speech engine, such as `stt.home_assistant_cloud` or an AI subscription's speech-to-text entity. |
| `QUOTE_HA_STT_LANGUAGE` | `en` | The language to ask for, matched to one the engine offers (`en` matches `en-US`). |
| `QUOTE_TRANSCRIBE` | none | A command that prints the words of a 16 kHz mono wav, with `{wav}` as the file. When set, it is used instead of faster-whisper, Home Assistant, and PocketSphinx. |
| `QUOTE_POCKETSPHINX_MODEL` | `/usr/share/pocketsphinx/model/en-us` | That model's directory, when no other transcriber is set. |
| `QUOTE_OCR` | Tesseract | A command that prints the words of a scanned page, with `{image}` as the file. Unset, the capture page uses Tesseract (`eng`). A PDF is its first page. |
| `QUOTE_D1_PROXY_URL`, `QUOTE_D1_PROXY_TOKEN` | none | The D1 proxy and its token, for the public replica's drain. |
| `QUOTE_PUBLIC`, `QUOTE_PUBLIC_NOTES` | `public:` and `notes:` in `vocab/site.md` | Override the public site's choices on one machine. |
| `QUOTE_PUBLIC_PORT` | none | A port serving only the public site, for a hostname with no login. |
| `QUOTE_DB` | `data/quotes.db` | The store. |
| `QUOTE_HOST`, `QUOTE_PORT` | `0.0.0.0`, `8010` | Where the service listens. |
| `QUOTE_TLS_CERT`, `QUOTE_TLS_KEY`, `QUOTE_TLS_PORT` | none, none, `8443` | A certificate for the same server on HTTPS. The [capture page](admin-ui.md#capturing-a-quote) needs it before a browser will offer a microphone. Deploy creates one for quote-mcp.localdomain when these are unset. |
| `QUOTE_SETS` | `vocab/sets.json` | The concept sets, used only while the store has none from terminology-mcp. |
| `QUOTE_INTRO` | `vocab/site.md` | The front page and the public site's choices. |
| `QUOTE_SNAPSHOT` | `public.db` beside the store | The public snapshot. |
| `QUOTE_DICTIONARY` | `/usr/share/dict/words` | The OCR check's word list. |
| `QUOTE_ZOTERO_API` | `https://api.zotero.org` | The Zotero API, or holdings-mcp's copy of it on the LAN (`http://holdings-mcp.localdomain:8000/zotero`), which refreshes every 2 minutes and saves calls to zotero.org. The import carries on from the same library versions either way. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `QUOTE_D1_DATABASE_ID` | none; the database id from `worker/wrangler.jsonc` | Instead of the proxy, Cloudflare's REST API (slower). Only `CLOUDFLARE_ACCOUNT_ID` turns it on, since wrangler reads `CLOUDFLARE_API_TOKEN` too, to deploy the Workers. |
| `AUTHORING_DEPLOY_PASSWORD` | none | The deploy account's SSH password. |
| `QUOTE_DEPLOY_HOST` | `authoring@quote-mcp.localdomain` | Where `npm run deploy` installs. |
| `QUOTE_STATUS_URL` | `http://quote-mcp.localdomain:8000` | The server the status-bar items ask. |

## The server

quote-mcp runs on a Debian LXC, quote-mcp.localdomain, on port 8000.

- **Services.** `quote-mcp.service` (the server), `quote-import.timer` (an import every 30 minutes), and `quote-backup.timer` (a backup at 03:45, keeping 14 in `/var/lib/quote-mcp/backups`).
- **Files.** The store, the snapshot (`public.db`), the replica's queue (`replica.db`), and the deploy record
  (`deployed.json`) are in `/var/lib/quote-mcp`; releases in `/opt/quote-mcp/releases`, the current one linked
  as `/opt/quote-mcp/current`; the maps in `/opt/quote-mcp/map`.
- **Access.** On the LAN, `http://quote-mcp.localdomain:8000`, and `https://quote-mcp.localdomain:8443` for the capture page's microphone. From outside, `https://quote-mcp.majerus.us`,
  behind Cloudflare Access (Claude's connector and the admin pages). The public site is separate, at
  quotes.majerus.us.
- **Commands.** Log in as `authoring` and run `quote-mcp <command>` (`quote-mcp terms`, `quote-mcp stats`,
  `quote-mcp export --out /tmp/quotes.json`): it runs the CLI as the `quote` user with `/etc/quote-mcp/env`,
  asking for `authoring`'s password. Deploy installs it in `/usr/local/bin`. Running `node dist/cli.js`
  yourself misses the settings and looks for a store in the release folder.
- **`/health`** gives the version, counts, what the last deploy installed, the replica's drain, and how far
  the concepts follow terminology-mcp (`terms`: through, head, and any hold).

## Deploying

The **Deploy Quotes** button in VS Code's status bar runs the deploys, as `npm run deploy` does:

| Menu entry | Command | What it does |
|---|---|---|
| Deploy this checkout | `npm run deploy` | Builds, tests, installs this checkout as a new release, migrates the store, builds the public snapshot, restarts, checks `/health`, and rolls back to the previous release if it fails. |
| Deploy this checkout without tests | `npm run deploy -- --skip-tests` | The same, without the tests. |
| Push the server's settings | `npm run deploy -- --env` | Copies the server's settings from `.env` into `/etc/quote-mcp/env` and restarts, waiting until the server answers: the Zotero settings (`QUOTE_ZOTERO_API` among them), `QUOTE_WHISPER_URL`, and the D1 proxy's. Only those set in `.env` are replaced. |
| Deploy the public Worker | `npm run worker:deploy` | Tests, then deploys the public Worker with `CLOUDFLARE_API_TOKEN` from `.env`. |

A release that adds a migration under `worker/migrations` needs it in D1 before the server's drain ships rows
with the new columns: `npx wrangler d1 migrations apply DB --remote -c worker/wrangler.jsonc`, then the
deploy and `npm run worker:deploy`. Until then the drain fails and retries, leaving the rows queued.

`npm run deploy -- --provision` sets up a new server once: Node, build tools, the word list, the `quote` user,
and the folders.

## Status bar

Two items in VS Code's status bar, from the vscode-status-probe extension (set up in
[.vscode/settings.json](../.vscode/settings.json)):

| Item | What it shows |
|---|---|
| `$(quote) main` | The branch the server runs, `↓N` when it's behind origin, and `*` for uncommitted changes deployed. Refreshes every 5 minutes and after a deploy; opens the admin pages. |
| `$(cloud)` | The public replica: in step (`$(cloud)`), rows waiting (`$(cloud-upload) N`), no drain reported (`$(cloud) —`), the drain off for want of D1 settings (`$(cloud) off`), a failed drain (`$(cloud) !`), or a site that doesn't answer as published (`$(cloud) ?`). Refreshes every five minutes, with a conditional HEAD so an unchanged site costs D1 only its meta; opens quotes.majerus.us. |

Hover over an item for the details, including when it last checked.

## Shared authoring Access applications

The private HTTP listener validates Cloudflare Access JWT assertions before
serving MCP, administration pages or private API reads/writes. Configure the
following in the server's `/etc/quote-mcp/env`:

```dotenv
ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
```

Cloudflare Managed OAuth supplies client authorization and forwards
`Cf-Access-Jwt-Assertion`; the origin verifies the signature, issuer, expiry
and subject. It does not check the audience (which Access application issued
the token): every application in the team admits only the owner, so
recreating or merging applications needs no change here. Protect the UI's API
and asset routes in an Access application too. Missing/invalid tokens fail
closed.

Direct requests from a private peer naming the service's LAN hostname/IP,
without Cloudflare proxy headers, retain their existing LAN behavior. Separate
public snapshot listeners and Workers are unaffected.
