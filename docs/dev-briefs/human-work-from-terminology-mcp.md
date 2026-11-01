# The human-work scheme from terminology-mcp

**Status: the subscriber is built and tested against terminology-mcp's
`feat/human-work-subscriber` branch (terminology-mcp PR #14). It goes live
once that's merged and deployed, human-work is imported into the live
store from a fresh export, and `QUOTE_TERMS_SYNC=on` is set on the server.**

terminology-mcp (`http://terminology-mcp.localdomain:8000`) becomes the
master of the `human-work` concept scheme. Quote MCP's `concepts` and
`concept_relations` rows for the scheme become a replica, which Quote MCP
keeps current by following terminology-mcp's changelog. Concept Clusters
follows `cc-subjects` the same way (its `modules/subjectsSubscriber.js` and
`docs/dev-briefs/subjects-from-terminology-mcp.md`). The contract is
terminology-mcp's [docs/following-changes.md](https://github.com/jmajerus/terminology-mcp/blob/main/docs/following-changes.md).

## Decision

| Owned by terminology-mcp | Owned by Quote MCP |
|---|---|
| Which concepts exist, their labels, alternative labels, slugs, definitions (scope notes), status, and broader, related, and opposite relations | Quotes, notes, and their tags: the words a quote was tagged with, which never change |
| Merges, splits, retirements, slug changes, with impact previews | Which concept each tag resolves to, and re-pointing a tag when its concept is replaced |
| Links to other vocabularies (WordNet as a `closeMatch`) | Concept sets (`vocab/sets.json`), the maps, and the public site |

Quote MCP stops minting concepts. A tag that isn't a concept is proposed to
terminology-mcp with the quote as evidence, and arrives back as a
provisional concept.

## Keys

| terminology-mcp | Quote MCP |
|---|---|
| `id` (`t_…`, stable) | `concepts.term_id` (schema 3) |
| `slug`, `formerSlugs` | `concepts.slug`, `concepts.former_slugs` (schema 3) |
| `label`, `altLabels`, `scopeNote` | `label`, `alt_labels`, `definition` |
| `status`: `provisional`, `active`, `retired` | `provisional`, `confirmed`, `retired` |
| a `closeMatch` link to a WordNet synset | `close_match` (other links stay in terminology-mcp) |
| alias `drupal:kid:N` | `source` (the maps place concepts by it) |
| alias `quote-mcp:human-work:<slug>` | how the bootstrap finds each concept |
| `broader[]` | `broader` from the concept and `narrower` back |
| `relations`: `related`, `opposite` (symmetric, on both ends) | `related` and `inverse`, in both directions |

Slugs stay what Quote MCP has: terminology-mcp's import of
`quote-mcp-export/1` keeps them, and the scheme's `slugScope: "scheme"`
keeps them unique across it, as `UNIQUE (scheme_id, slug)` does here.

## The subscriber

`src/terminology.ts`. The cursor (`log`, `through`, `blocked`) is in the
store's `meta` table under `terminology:human-work`. Each change is
applied in one SQLite transaction with the cursor, so a pass that stops
part-way resumes at the right change, and two runs can't both apply one.

- **Bootstrap** (no cursor): reads `GET /api/state?scheme=human-work`,
  matches each term to a concept by its term id, else by its
  `quote-mcp:human-work:<slug>` alias, and lists what would change. It
  refuses to write anything when a slug differs, a term matches the wrong
  concept, or a new term's slug is taken (`slug-mismatch`, `term-mismatch`,
  `slug-clash`), so public links never change by surprise. A concept
  terminology-mcp doesn't have is reported (`not-in-terminology`) and left
  alone. Otherwise it records each term id, overwrites the concepts and
  their relations from the terms, and saves the cursor.
- **Catch-up**: reads `GET /api/changes?since=<through>&scheme=human-work`
  and applies each change in order. A changed `log` means terminology-mcp's
  store was rebuilt: the cursor is cleared and the next pass bootstraps
  again, reporting with `reset`.
- **Report**: `POST /api/subscribers/quote-mcp/progress` with
  `label: "Quote MCP"` and `schemes: ["human-work"]`, when the cursor or the
  hold changes and every five minutes besides. From the LAN, where the caller
  names itself; never with credentials.

### What it applies

Each touched concept is overwritten from the change's `afterTerms` (or
`after` for an added term), then its own relations are rebuilt: its
broader terms (with the narrower rows back) and its related and opposite
relations, both ways. Its children's rows are theirs and stay.

| Kind | What happens |
|---|---|
| `added`, `noted`, `labelled`, `updated`, `moved`, `imported` | Applied. A proposed term arrives as `provisional`. |
| `merged`, or `retired` with one replacement | Applied, and the retired concept's tags and keyword marks are re-pointed to the replacement, keeping their words, with a `concept_replaced` history entry per quote. |
| `retired` with no replacement, or several | Applied when no quote uses the concept; otherwise **held** (`retire-ambiguous`). |
| `split` | Applied when no quote uses the concept; otherwise **held** (`split`). |
| `slugged` | Applied: the old slug goes to `former_slugs`, so `/api/concepts/<old>` keeps resolving, on the LAN and on the public site. **Held** (`slug-in-sets`) when `vocab/sets.json` names the old slug. |
| `scheme-added`, `scheme-changed`, `set-added`, `set-changed`, `set-deleted` | Ignored for now. |
| anything else | **Held** (`unknown-change`). |

A slug check runs for every kind, not only `slugged`, so no change can
rename a slug the sets use. A write that would break `UNIQUE (scheme_id,
slug)`, or a relation to a term that isn't here, is held too (`slug-clash`,
`unknown-term`).

### Handling a hold

terminology-mcp's **Subscribers** panel shows the hold with its code and
reason; `/health` shows it as `terms.blocked`. Either change it back in
terminology-mcp, or handle it here and accept it:

- `slug-in-sets`: edit `vocab/sets.json` to the new slug, deploy, then
  `npm run terms -- --accept <n>`.
- `split`, `retire-ambiguous`: decide where the quotes go.
  `npm run terms -- --accept <n> --repoint <slug>` writes the change and
  re-points every quote of the retired concept to that one; without
  `--repoint` the quotes keep the retired concept, which then drops out of
  search, the maps, and the public site until they're re-tagged.

Accepting writes the change's terms as they are and moves the cursor past
it; the next pass continues after it.

## Running it

| | |
|---|---|
| `npm run terms` | A dry run: the next pass runs in a transaction that's rolled back, and prints what it would apply and where it would stop. |
| `npm run terms -- --apply` | Applies it, reports progress, and rebuilds the public snapshot. |
| `npm run terms -- --accept <n> [--repoint <slug>]` | Passes a held change a person has handled. |
| `npm run terms -- --rebootstrap` | Forgets the cursor; the next pass bootstraps. |
| `npm run terms -- --status` | The cursor. |
| `QUOTE_TERMS_SYNC=on` | The server runs a pass every minute, through its own writable connection to the store (the rest of the server stays read-only), and rebuilds the public snapshot after one that changed it; the drain then ships it to D1. |

Set `QUOTE_TERMS_SYNC` in `/etc/quote-mcp/env` only. Progress is reported
as `quote-mcp`, so a second follower (a checkout on your computer) would
fight the server's cursor. To try it on your computer, run terminology-mcp
locally (`TERMINOLOGY_DB=<scratch file> PORT=8765 npm start` in its
checkout), import a Quote MCP export with **Import graph…**, and point
`TERMINOLOGY_BASE` at it, with `QUOTE_DB` on a copy of the store.

Once the scheme is followed, the old-site import no longer adds concepts
or relations: `quote-mcp import` with the old site skips them when any
concept has a term id.

## Tags that aren't concepts

The **Tags that aren't concepts** worklist (`quote_worklist`
`unresolved_tags`, and `/admin/worklists/unresolved_tags`) is where a
concept is proposed:

```
npm run quotes -- propose "conspiracy theory"                # prints the proposal
npm run quotes -- propose "care" --broader dignity --send    # sends it
npm run quotes -- propose flexiblity --label flexibility --send
```

It posts `{scheme: "human-work", label, scopeNote?, altLabels?, broader?,
evidence: {quote, text, tag}, proposer: "quote-mcp", requestId:
"tag:<tag>"}` to `POST /api/proposals`, with the first quote that has the
tag (or `--quote <id>`) and up to 500 characters of its text. A retry
returns the term already proposed. An agent can call terminology-mcp's
`propose_term` tool with the same fields.

The term arrives through the changelog as a provisional concept. The quote's
tags aren't changed: the next import (every 30 minutes) resolves a tag
whose words match the concept's label, an alternative label, or its slug.
A misspelt tag (`flexiblity`) resolves only if the misspelling is an
alternative label; whether to add one is terminology-mcp's call.

## Deploying it

1. terminology-mcp: merge PR #14 and deploy it.
2. Here: apply the D1 migration `worker/migrations/0002_former_slugs.sql`
   (`npx wrangler d1 migrations apply DB --remote -c worker/wrangler.jsonc`),
   deploy the server (`npm run deploy`, which migrates the store to schema
   3), and deploy the Worker (`npm run worker:deploy`).
3. Export the store (`node dist/cli.js export --out human-work.json` on the
   server, as the `quote` user) for terminology-mcp's import of human-work.
4. On the server: `node dist/cli.js terms` (the dry run). It should match
   all 221 concepts and report only the 20 `close_match` values of `NA` that
   the old site used for "no WordNet synset", which become null.
5. `node dist/cli.js terms --apply`, then set `QUOTE_TERMS_SYNC=on` in
   `/etc/quote-mcp/env` and restart `quote-mcp.service`.

## Tested

Against terminology-mcp's branch, with a copy of the store: the bootstrap
matched 221 of 221 concepts, with every slug and relation the same. Then
a proposal with evidence (`conspiracy theory`) arrived as a provisional
concept; a merge of `psychic-vampirism` into `abuse` re-pointed six
quotes, with history; a slug change of `despair`, which a set names, was
held and showed on terminology-mcp's Subscribers panel; `--accept` passed
it; and the server's loop applied the next change (a relabel), rebuilt the
snapshot, and reported zero pending.
