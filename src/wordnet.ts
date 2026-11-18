import type { DB } from "./db.js";

/**
 * A concept's WordNet synset, from the WordNet Oxigraph server (docs/wordnet.md). terminology-mcp holds each
 * concept's WordNet link (close_match); this asks the server what that link names and keeps the answer in
 * concepts.synset, so the pages never wait on the server and keep what they had while it's away.
 *
 * Two kinds of link are understood:
 *   http://purl.org/vocabularies/princeton/wn30/synset-anger-noun-1.rdf   the old site's: Princeton WordNet 3.0's
 *       first noun sense of "anger". purl.org no longer resolves these; the server maps the sense name to its
 *       Interlingual Index id, and the id to Open English WordNet's synset.
 *   https://en-word.net/id/oewn-07531593-n                                 an Open English WordNet synset itself
 */
export const DEFAULT_WORDNET_SPARQL = "http://wordnet.localdomain:7878";
export const DEFAULT_WORDNET_GRAPH = "urn:wordnet:graph:oewn-2025";
const SENSES_GRAPH = "urn:wordnet:graph:pwn30-senses";
const SENSE = "urn:wordnet:pwn30-sense";
const OEWN_ID = "https://en-word.net/id/";

export interface Synset {
  /** The close_match this answers, so a changed link is looked up again. */
  uri: string;
  /** The Open English WordNet synset ("oewn-07531593-n"), or null when WordNet has nothing for the link. */
  id: string | null;
  edition: string;
  pos?: string;
  definition?: string;
  words?: string[];
  broader?: { id: string; words: string[] }[];
  at: string;
}

export interface WordnetConfig { baseUrl: string; graph: string; timeoutMs: number }

/** WORDNET_SPARQL=off turns lookups off; unset means the LAN server. WORDNET_GRAPH names the edition's graph. */
export function wordnetConfig(env: NodeJS.ProcessEnv = process.env): WordnetConfig | null {
  const raw = env.WORDNET_SPARQL?.trim() ?? "";
  if (raw.toLowerCase() === "off") return null;
  return { baseUrl: (raw || DEFAULT_WORDNET_SPARQL).replace(/\/+$/, ""), graph: env.WORDNET_GRAPH?.trim() || DEFAULT_WORDNET_GRAPH, timeoutMs: 10_000 };
}

/** The WordNet 3.0 sense a purl.org link names ("anger-noun-1"; lemmas are lower case in WordNet's index), or null. */
export function senseKey(uri: string): string | null {
  const m = uri.match(/\/wn30\/synset-(.+)-(noun|verb|adjective|adjectivesatellite|adverb)-(\d+)(?:\.rdf)?$/);
  return m ? `${m[1].toLowerCase()}-${m[2]}-${m[3]}` : null;
}

/** Whether a link is one this module can look up. */
export const isWordnetLink = (uri: string | null | undefined): uri is string => !!uri && (senseKey(uri) !== null || uri.startsWith(OEWN_ID));

const sparqlString = (s: string) => JSON.stringify(s);

/** The query for a link: its synset with part of speech, definition, words, and broader synsets' words. */
export function synsetQuery(uri: string, graph: string): string | null {
  const key = senseKey(uri);
  const id = uri.startsWith(OEWN_ID) ? uri.slice(OEWN_ID.length) : null;
  if (!key && !(id && /^[\w.-]+$/.test(id))) return null;
  const find = key
    ? `GRAPH <${SENSES_GRAPH}> { ?ili <${SENSE}> ${sparqlString(key)} }\n    GRAPH <${graph}> { ?synset wn:ili ?ili }`
    : `BIND(<${OEWN_ID}${id}> AS ?synset)`;
  return `PREFIX wn: <https://globalwordnet.github.io/schemas/wn#>
PREFIX ontolex: <http://www.w3.org/ns/lemon/ontolex#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?synset ?pos ?def ?word ?broader ?broaderWord WHERE {
    ${find}
  GRAPH <${graph}> {
    ?synset wn:partOfSpeech ?pos ; wn:definition ?d . ?d rdf:value ?def .
    { ?sense ontolex:isLexicalizedSenseOf ?synset . ?entry ontolex:sense ?sense ; ontolex:canonicalForm ?f . ?f ontolex:writtenRep ?word }
    UNION
    { ?synset wn:hypernym ?broader . ?bs ontolex:isLexicalizedSenseOf ?broader . ?be ontolex:sense ?bs ; ontolex:canonicalForm ?bf . ?bf ontolex:writtenRep ?broaderWord }
  }
}`;
}

type Binding = Record<string, { value: string } | undefined>;

/** Folds the query's rows into a synset; no rows means WordNet has nothing for the link. */
export function synsetFrom(uri: string, graph: string, rows: Binding[], at: string): Synset {
  const edition = graph.replace(/^urn:wordnet:graph:/, "");
  const first = rows[0];
  if (!first?.synset) return { uri, id: null, edition, at };
  const tail = (v: string) => v.slice(v.lastIndexOf("/") + 1).replace(/^.*#/, "");
  const words = new Set<string>();
  const broader = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.word) words.add(r.word.value);
    if (r.broader && r.broaderWord) {
      const id = tail(r.broader.value);
      if (!broader.has(id)) broader.set(id, new Set());
      broader.get(id)!.add(r.broaderWord.value);
    }
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return {
    uri, id: tail(first.synset.value), edition, pos: first.pos ? tail(first.pos.value) : undefined, definition: first.def?.value,
    words: sorted(words), broader: [...broader].map(([id, w]) => ({ id, words: sorted(w) })), at,
  };
}

export type WordnetLookup = (uri: string) => Promise<Synset>;

export function wordnetLookup({ baseUrl, graph, timeoutMs = 10_000 }: WordnetConfig, fetchImpl: typeof fetch = fetch): WordnetLookup {
  return async (uri) => {
    const query = synsetQuery(uri, graph);
    if (!query) return { uri, id: null, edition: graph.replace(/^urn:wordnet:graph:/, ""), at: new Date().toISOString() };
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/query`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/sparql-results+json" },
        body: new URLSearchParams({ query }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`the WordNet server at ${baseUrl} is unreachable: ${(error as Error).message}`);
    }
    if (!res.ok) throw new Error(`the WordNet server at ${baseUrl} answered ${res.status}`);
    const body = (await res.json()) as { results: { bindings: Binding[] } };
    return synsetFrom(uri, graph, body.results.bindings, new Date().toISOString());
  };
}

/** A stored synset, or null for none (or one this build can't read). */
export function readSynset(value: unknown): Synset | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const s = JSON.parse(value) as Synset;
    return s && typeof s.uri === "string" ? s : null;
  } catch {
    return null;
  }
}

/**
 * Looks up the synset of each concept whose WordNet link is new or changed (or whose synset is from another
 * edition), and clears it where the link is gone. Stops at the first lookup that fails, keeping what's
 * stored, so the next pass picks up there. Returns how many concepts changed.
 */
export async function refreshSynsets(db: DB, lookup: WordnetLookup, graph = DEFAULT_WORDNET_GRAPH): Promise<number> {
  const edition = graph.replace(/^urn:wordnet:graph:/, "");
  const rows = db.prepare("SELECT id, close_match, synset FROM concepts").all() as { id: number; close_match: string | null; synset: string | null }[];
  const set = db.prepare("UPDATE concepts SET synset = ? WHERE id = ?");
  let changed = 0;
  for (const r of rows) {
    const stored = readSynset(r.synset);
    if (!isWordnetLink(r.close_match)) {
      if (r.synset !== null) { set.run(null, r.id); changed++; }
      continue;
    }
    if (stored && stored.uri === r.close_match && stored.edition === edition) continue;
    set.run(JSON.stringify(await lookup(r.close_match)), r.id);
    changed++;
  }
  return changed;
}
