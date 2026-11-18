# WordNet synsets

Most `human-work` concepts have a WordNet link: terminology-mcp holds it as the term's `closeMatch`, and the
store keeps it as `close_match`. The old site linked Princeton WordNet 3.0 synsets by purl.org addresses such
as `http://purl.org/vocabularies/princeton/wn30/synset-anger-noun-1.rdf`, the first noun sense of "anger".
These addresses no longer resolve: their last redirect is to a host whose certificate has expired.

So the store asks a WordNet server of its own what each link names, and keeps the answer with the concept.

## The WordNet server

`wordnet.localdomain` is an Oxigraph container used only for WordNet. Its SPARQL endpoint is
`http://wordnet.localdomain:7878/query`. It holds two graphs:

| Graph | Contents |
| --- | --- |
| `urn:wordnet:graph:oewn-2025` | [Open English WordNet](https://en-word.net/) 2025, as released (CC BY 4.0): 107,519 synsets, 3.7 million triples |
| `urn:wordnet:graph:pwn30-senses` | Each of Princeton WordNet 3.0's 206,941 senses, named as the old links name them (`anger-noun-1`), on its [Interlingual Index](https://github.com/globalwordnet/cili) id |

An old link is resolved in three steps:

1. Its sense name gives the Interlingual Index id (`pwn30-senses`).
2. That id is carried by an Open English WordNet synset as `wn:ili`.
3. The synset gives its words, part of speech, definition, and broader synsets.

An Open English WordNet synset address (`https://en-word.net/id/oewn-07531593-n`) is looked up directly, so
terminology-mcp can link new concepts either way.

WordNet has its own server because the shared Oxigraph (`oxigraph.localdomain`) is used by Concept Clusters
and terminology-mcp. Some of their queries read every graph on the server, so 3.7 million more triples there
pushed Concept Clusters' sync past its timeout.

### Loading it

```bash
node tools/wordnet-load.mjs                     # Open English WordNet 2025 (if missing) and the sense mapping
node tools/wordnet-load.mjs --edition 2026      # a new edition, into its own graph
node tools/wordnet-load.mjs --senses-only       # rebuild only the sense mapping
```

- **Open English WordNet** is loaded with `oxigraph load` on the container, over ssh as root. The service is
  stopped while it loads, for about a minute. One HTTP upload of the whole edition is more than the server
  handles.
- **The sense mapping** is built from Princeton's `index.sense` and CILI's `ili-map-pwn30.tab`, then replaces
  its graph over HTTP. It doesn't depend on the edition.
- **A safety check:** the tool stops if the server holds anything that isn't WordNet, so it can't be pointed at
  the shared Oxigraph by mistake.
- **After loading a new edition:** set `WORDNET_GRAPH` to it, and every link is looked up again on the next
  pass. Then delete the old edition's graph in batches, since one large delete stalls the server:

  ```sparql
  DELETE { GRAPH <urn:wordnet:graph:oewn-2025> { ?s ?p ?o } }
  WHERE { SELECT ?s ?p ?o WHERE { GRAPH <urn:wordnet:graph:oewn-2025> { ?s ?p ?o } } LIMIT 50000 }
  ```

## In the store

`concepts.synset` (schema 9) holds the server's answer as JSON. It records the link it answers (`uri`) and the
edition, so a changed link or a new edition is looked up again:

```json
{ "uri": "http://purl.org/vocabularies/princeton/wn30/synset-anger-noun-1.rdf", "id": "oewn-07531593-n",
  "edition": "oewn-2025", "pos": "noun", "definition": "a strong emotion; …", "words": ["anger", "choler", "ire"],
  "broader": [{ "id": "oewn-07495208-n", "words": ["emotion"] }], "at": "2026-11-18T…" }
```

`id` is null when WordNet has nothing for the link.

**When lookups run:**
- The server looks links up after each terms pass, every minute while `QUOTE_TERMS_SYNC=on`, and
  `quote-mcp terms --apply` does the same.
- A lookup touches only concepts whose link is new or changed, and clears the synset when the link goes.
- If the server can't be reached, the store keeps what it has. The error is logged once and the lookup is
  retried on the next pass.
- `WORDNET_SPARQL=off` turns lookups off.

**Where synsets appear:**
- The admin concept page shows the synset's words, linked to that meaning on en-word.net, with its part of
  speech, definition, and broader synsets. Before a synset is fetched, the page links the link's word on
  en-word.net instead.
- `get_concept` returns the link as `wordnet` and the synset as `synset`.
- The public site doesn't show WordNet.

## Links WordNet doesn't resolve

As of 2026-11-18, 199 of the 201 links resolve. These two name senses that WordNet 3.0 doesn't have, and
need a new link in terminology-mcp or none:

| Concept | Link |
| --- | --- |
| disposability | `expendable-noun-1` |
| group-exclusivity | `group_exclusion-noun-1` |

The old site's links to importance, community, bureaucracy, and integrity pointed at a different sense than
their definitions describe. They were corrected to sense 1 in terminology-mcp on 2026-11-18.
