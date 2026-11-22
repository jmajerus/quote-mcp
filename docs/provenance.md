# Provenance stamps

Each quote and note carries one provenance stamp, saying who or what saved it. Above all, the stamp says
whether a generative agent saved it. The stamp is written when the quote is saved and never changed.
Concept Clusters keeps a list of stamps because its puzzles keep changing. A quote doesn't: its words are
the book's, and later changes to its tags, comment, or page are in its history, each with who made it.

The server writes the stamp. The caller never supplies one. It's stored as JSON in `quotes.provenance`
([src/provenance.ts](../src/provenance.ts)). `get_quote` returns it in full, `search_quotes` returns its
`generative` value, and the admin quote page shows it under **Provenance**. The public site doesn't show it,
and the public snapshot doesn't copy it. It does decide what the public site shows: a quote a generative agent saved
stays off it until a person promotes it ([the public site](public-site.md#chosen-by-a-person)).

## The G label

A quote a generative agent saved is shown as **G874** rather than #874: in the admin list, in the title of its
page, and as `label` in `search_quotes` and `get_quote` results. The label is worked out from the stamp. The
number itself doesn't change, so citations, draft markers, corpus-mcp's anchors, holdings-mcp's
`quote:<id>` keys, and public URLs all keep working. In the admin search box, `G848` goes to quote 848, as
`#848` does. Numbers don't say who saved a quote, but the label does.

```json
{
  "v": 1,
  "generative": true,
  "channel": "mcp",
  "at": "2026-11-17T22:40:00.000Z",
  "by": "someone@example.org",
  "client": { "name": "claude-code", "version": "2.1", "user_agent": "Claude-User" },
  "detail": null
}
```

| Field | What it holds |
|---|---|
| `generative` | `true`: a generative agent saved it. `false`: a person did. `null`: nothing says which. |
| `channel` | How it arrived: `mcp`, `capture`, `corpus-mcp`, `zotero`, `drupal`, or `unknown` (see below). |
| `at` | When it was saved, by the server's clock. |
| `by` | The signed-in person behind the request (from Cloudflare Access), `lan` for a request on the LAN, or the importer's name. |
| `client` | For `mcp` only: the client name, version, and user agent the call presented. These are observed, not verified, and through the Authoring Portal they may be the portal's own. Left out when the call presented none. |
| `inferred` | `true` when the stamp was worked out later from the quote's origin, for quotes saved before stamps existed. |
| `detail` | Reserved for fuller provenance, shaped like Concept Clusters' `provenance` object: `{ collaboration, contributors: [{ name, model?, reasoning? }] }`. Always `null` for now. |

## How each channel is stamped

| Channel | `generative` | Why |
|---|---|---|
| `mcp`: `add_quote` | `true` | A person doesn't hand-call an MCP tool. This holds whether or not the client could be named, as in Concept Clusters. |
| `capture`: the admin capture page | `false` | A person typed or spoke it. Speech or OCR transcription is a tool the person corrects, not a contributor. |
| `corpus-mcp`: one of corpus-mcp's own quotes, taken over | from corpus-mcp | corpus-mcp recorded whether each quote was saved by an agent or on its admin page. `null` if it recorded neither. |
| `zotero`: a Zotero note | `null` | A Zotero note doesn't say who wrote it, and an agent can write one through Zotero's API. |
| `drupal`: the old site | `false` | The old site predates agents. |

A quote split from another by the repair command keeps the original's stamp.

## Quotes saved before stamps

Schema 8 adds the column and stamps every quote that has none, using its origin. If a quote came from the
old site, that origin decides. Otherwise its earliest origin does. The quote's number isn't used. Quotes 1–827 all came from
the old site, but a person's quote captured or imported later is numbered after the agents' quotes saved
before it. These stamps have `inferred: true`, and `at` and `by` are the quote's `created_at` and `created_by`.
The backfill runs whenever the store is opened, and it touches only quotes with no stamp yet.
