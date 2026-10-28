# quote-mcp

A store of quotations from books, most of them paper books that exist only on the shelf, and of your own margin
notes on them: structured records you can search, tag, repair, and cite. An [MCP](https://modelcontextprotocol.io/)
server lets an AI agent search and cite them; admin pages show everything to a person; and a public site can
publish the collection, its concepts, and its maps.

The quotes come from Zotero notes and from an old Drupal site (workcreatively.org), and are tagged with concepts
from that site's vocabulary of the human side of work. It complements
[corpus-mcp](https://github.com/jmajerus/corpus-mcp), which cites the books in the Calibre libraries, and
quote-atlas, whose concept maps open the quotes tagged with each concept.

## What it does

- **Import.** Reads quote notes from Zotero and the old site, grades each, and flags what to check: a missing
  page, a possible OCR error, a work not yet in Zotero. Zotero notes tagged `margin` become notes of your own.
- **Search and cite.** Full-text search over what quotes say, by concept (with narrower concepts), set, author,
  or work, and a citation with a real locator: CSL JSON, the Better BibTeX citekey, and a Pandoc citation.
- **Organise.** Concepts in named schemes, with broader, narrower, related, and opposite relations, and named
  concept sets for maps, themes, and search.
- **Publish.** A public site of the collection, its concepts, and (if you choose) its quotes, served from a
  snapshot holding only what's public, on the LAN or from a Cloudflare Worker:
  [quotes.majerus.us](https://quotes.majerus.us).

quote-mcp never changes Zotero, and its MCP tools are read-only for now.

## Documentation

| Document | For |
|---|---|
| [MCP tools](docs/tools.md) | Every tool, its arguments, and what it returns |
| [The admin pages](docs/admin-ui.md) | The web interface at `/admin`, page by page, and the worklists |
| [Importing quotes and notes](docs/importing.md) | The sources, the forms the parser reads, grades, flags, works, and margin notes |
| [Concepts, collections, and concept sets](docs/concepts.md) | Concept schemes, collections on the public site, and the sets file |
| [The public site](docs/public-site.md) | What's public, `vocab/site.md`, the snapshot, the Worker and its D1 replica, the pages, and the maps' API |
| [Operations](docs/operations.md) | Commands, settings, the server, deploying, and the status-bar items |
| [PLAN.md](PLAN.md) | The plan of record: design decisions, what the survey found, the phases, and open questions |

## Quick start

Requires Node.js 22 or later; `better-sqlite3` compiles natively, so you also need a C++ toolchain and Python.

```bash
npm install
cp .env.example .env    # then set QUOTE_ZOTERO_LIBRARY and QUOTE_ZOTERO_API_KEY
npm run import          # sync Zotero and import its quote notes
npm run serve           # MCP at http://localhost:8010/mcp, admin pages at /admin
```

Register it with an MCP client, for example Claude Code:

```bash
claude mcp add --transport http quotes http://localhost:8010/mcp
```

`npm run quotes -- config` shows every setting and what each feature still needs. Run the tests with `npm test`.
Configuration and deployment are in [Operations](docs/operations.md).
