# Concepts, collections, and concept sets

## Concept schemes

Concepts belong to named schemes. `human-work` (the human side of work) is the old site's vocabulary: 221
concepts with definitions, alternative labels, WordNet links, and broader, narrower, related, and opposite
relations. A quote's concepts come from its tags. Searching by a concept includes its narrower concepts
unless asked not to.

Nothing is removed or renamed without a person approving it; a concept retired later drops out of search,
the maps, and the public site.

## Collections

To readers of the public site, each scheme is a *collection*: the human side of work is one, and quotes from
books in another field would go in another, each a scheme with its own concepts. A collection's concepts
decide what's in it, so a work quoted in two collections is in both.

Each collection has a page at `/collections/<scheme>`, introduced by `vocab/collections/<scheme>.md` (a
`# Title` line, then paragraphs; see [human-work.md](../vocab/collections/human-work.md)), or by the scheme's
label and description when there's no file. With one collection the front page shows it inline; with several,
a card for each. "Collection" is the readers' word only: in the code and the store it's a scheme.

## Concept sets

A concept set names a part of one scheme, for a map, a theme, or search: [vocab/sets.json](../vocab/sets.json).
Search and `list_concepts` take a set (`set`), the public site has a page per set (as "starting points"), and
the API serves each one in the graph's shape for the maps.

A set lists its `concepts`, or gives a recipe worked out on each request, so a concept added later joins the
sets that reach it:

| Field | What it adds |
|---|---|
| `concepts` | These concepts. |
| `around`, with `depth` (default 1) and `types` | These concepts and their neighbours, `depth` steps out along relations of `types` (`broader`, `narrower`, `related`, `opposite`; all by default). |
| `narrower` | These concepts and everything narrower, at any depth. |
| `exclude` | Minus these. |

They combine:

```json
{ "slug": "despair", "scheme": "human-work", "label": "Despair and its neighbours",
  "description": "…", "around": ["despair"], "depth": 1, "types": ["related", "opposite"], "exclude": ["pain"] }
```

Check the file with `npm run quotes -- sets`: it lists each set as the store has it now, and fails if one names
a concept its scheme doesn't have. A malformed file stops the server starting, so a deploy rolls back; a slug
the scheme doesn't have is left out and shown as `missing`.

A set's `types` decide only which concepts are in it. quote-atlas's export keeps its own filter for which links
it draws (related only, by default), so `around` with all types takes in more concepts than its `--around`
does.
