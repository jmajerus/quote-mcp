import type { DB } from "./db.js";
import { RELATION_LABEL, ToolError, conceptGraph } from "./queries.js";

/**
 * Named concept sets: a part of one scheme, for a map or a theme to draw on, and for search. terminology-mcp
 * is their master: the subscriber (src/terminology.ts) keeps them in the store's concept_sets, and they're read
 * from there on each request. A set is worked out against the store each time, so a concept added later joins
 * the sets whose recipe reaches it, by terminology-mcp's rules for a recipe:
 *
 *   concepts   these concepts
 *   around     each of these and its neighbours, `depth` steps out along relations of `types`
 *              (broader, narrower, related, opposite)
 *   narrower   everything narrower than these, at any depth, without these themselves
 *   exclude    minus these, last
 *
 * Or, for an explicit set, its members: concepts or other sets, in order if it's ordered.
 *
 * A concept the scheme doesn't have (one retired since, or an id from another scheme) is left out and reported
 * as `missing`.
 */

/** One step-out rule of a set: from a concept, `depth` steps along relations of `types`. */
export interface AroundRule { term: string; depth: number; types: string[] }

/** A set as it's worked out, with its terms' ids turned into slugs. */
export interface ConceptSet {
  slug: string;
  scheme: string;
  label: string;
  description?: string | null;
  concepts?: string[];
  around?: AroundRule[];
  narrower?: string[];
  exclude?: string[];
  /** An explicit set's members: concept slugs, or the sets nested in it. */
  members?: (string | ConceptSet)[];
  ordered?: boolean;
  formerSlugs?: string[];
}

interface SetRow { id: string; scheme: string; slug: string; label: string; description: string | null; ordered: number; members: string; recipe: string | null; former_slugs: string }
interface Recipe { concepts?: string[]; narrower?: string[]; around?: AroundRule[]; exclude?: string[] }

/** The sets the subscriber keeps in the store, by slug, with concepts named by slug; an id with no concept here stays as it is, and shows as missing. */
export function storedSets(db: DB): ConceptSet[] {
  const rows = db.prepare("SELECT * FROM concept_sets ORDER BY slug").all() as SetRow[];
  if (!rows.length) return [];
  const slugs = new Map((db.prepare("SELECT term_id, slug FROM concepts WHERE term_id IS NOT NULL").all() as { term_id: string; slug: string }[]).map((c) => [c.term_id, c.slug]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const slugOf = (id: string) => slugs.get(id) ?? id;
  const some = <T>(list: T[] | undefined) => (list?.length ? list : undefined);
  const view = (row: SetRow, path: string[]): ConceptSet => {
    const recipe = JSON.parse(row.recipe ?? "null") as Recipe | null;
    const base = { slug: row.slug, scheme: row.scheme, label: row.label, description: row.description, ordered: !!row.ordered, formerSlugs: JSON.parse(row.former_slugs) as string[] };
    if (recipe) {
      return { ...base, concepts: some(recipe.concepts?.map(slugOf)), narrower: some(recipe.narrower?.map(slugOf)), exclude: some(recipe.exclude?.map(slugOf)),
        around: some(recipe.around?.map((r) => ({ ...r, term: slugOf(r.term) }))) };
    }
    const nested = (JSON.parse(row.members) as string[]).filter((m) => !path.includes(m));
    return { ...base, members: nested.map((m) => (byId.has(m) ? view(byId.get(m)!, [...path, m]) : slugOf(m))) };
  };
  return rows.map((r) => view(r, [r.id]));
}

/** A set by slug, or a slug it used to have; the error lists the sets there are. */
export function findSet(sets: ConceptSet[], name: string): ConceptSet {
  const wanted = name.trim().toLowerCase();
  const set = sets.find((s) => s.slug === wanted) ?? sets.find((s) => s.formerSlugs?.includes(wanted));
  if (!set) throw new ToolError(`No concept set "${name}". ${sets.length ? `Sets: ${sets.map((s) => s.slug).join(", ")}.` : "None are defined."}`);
  return set;
}

type Graph = Pick<ReturnType<typeof conceptGraph>, "relations"> & { concepts: { slug: string; scheme: string }[] };

/** The slugs of a set's concepts, in the store as it is now, and the names it gives that the scheme doesn't have. */
export function resolveSet(set: ConceptSet, graph: Graph): { members: string[]; missing: string[] } {
  const inScheme = new Set(graph.concepts.filter((c) => c.scheme === set.scheme).map((c) => c.slug));
  const next = new Map<string, { to: string; type: string }[]>();
  for (const r of graph.relations) {
    if (!inScheme.has(r.from) || !inScheme.has(r.to)) continue;
    (next.get(r.from) ?? next.set(r.from, []).get(r.from)!).push({ to: r.to, type: RELATION_LABEL[r.type] ?? r.type });
  }
  const missing = new Set<string>();
  const known = (list: string[] = []) => list.filter((s) => inScheme.has(s) || !missing.add(s));
  const work = (s: ConceptSet): string[] => {
    const included = new Set<string>();
    for (const m of s.members ?? []) {
      if (typeof m === "string") known([m]).forEach((k) => included.add(k));
      else work(m).forEach((k) => included.add(k));
    }
    known(s.concepts).forEach((k) => included.add(k));
    for (const root of known(s.narrower)) {
      const queue = (next.get(root) ?? []).filter((e) => e.type === "narrower").map((e) => e.to);
      const seen = new Set<string>();
      for (let i = 0; i < queue.length; i++) {
        if (seen.has(queue[i])) continue;
        seen.add(queue[i]);
        included.add(queue[i]);
        queue.push(...(next.get(queue[i]) ?? []).filter((e) => e.type === "narrower").map((e) => e.to));
      }
    }
    for (const rule of s.around ?? []) {
      if (!known([rule.term]).length) continue;
      const seen = new Set([rule.term]);
      included.add(rule.term);
      let edge = [rule.term];
      for (let i = 0; i < rule.depth; i++) {
        const out: string[] = [];
        for (const from of edge) {
          for (const e of next.get(from) ?? []) {
            if (rule.types.includes(e.type) && !seen.has(e.to)) {
              seen.add(e.to);
              included.add(e.to);
              out.push(e.to);
            }
          }
        }
        edge = out;
      }
    }
    for (const x of known(s.exclude)) included.delete(x);
    return [...included];
  };
  const members = work(set);
  return { members: set.ordered ? members : members.sort(), missing: [...missing] };
}

function about(set: ConceptSet) {
  return { slug: set.slug, scheme: set.scheme, label: set.label, description: set.description || null };
}

/** A set's definition as it's shown: slugs throughout, and a nested set by its slug. */
export function definitionOf(set: ConceptSet) {
  const { concepts, around, narrower, exclude, members, ordered } = set;
  return { concepts, around, narrower, exclude, members: members?.map((m) => (typeof m === "string" ? m : m.slug)), ordered: ordered || undefined };
}

/** How many quotes are tagged with these concepts, as search counts them (unparsed ones left out). */
function quoteCount(db: DB, scheme: string, slugs: string[]): number {
  return db.prepare(`SELECT COUNT(DISTINCT t.quote_id) FROM quote_tags t JOIN quotes q ON q.id = t.quote_id JOIN concepts c ON c.id = t.concept_id JOIN schemes s ON s.id = c.scheme_id
    WHERE q.status != 'unparsed' AND s.slug = ? AND c.slug IN (SELECT value FROM json_each(?))`).pluck().get(scheme, JSON.stringify(slugs)) as number;
}

/** Every set, with how many concepts it has now and how many quotes they have. */
export function listSets(db: DB) {
  const graph = conceptGraph(db);
  return storedSets(db).map((set) => {
    const { members, missing } = resolveSet(set, graph);
    return { ...about(set), concepts: members.length, quotes: quoteCount(db, set.scheme, members), missing };
  });
}

/**
 * One set as a piece of the concept graph: its concepts and the relations between them, in /api/graph's
 * shape, so a map can draw it as it draws a whole scheme. `definition` is the set as it's defined.
 */
export function setGraph(db: DB, name: string) {
  const set = findSet(storedSets(db), name);
  const graph = conceptGraph(db);
  const { members, missing } = resolveSet(set, graph);
  const place = new Map(members.map((slug, i) => [slug, i]));
  const concepts = graph.concepts.filter((c) => c.scheme === set.scheme && place.has(c.slug));
  if (set.ordered) concepts.sort((a, b) => place.get(a.slug)! - place.get(b.slug)!);
  const relations = graph.relations.filter((r) => place.has(r.from) && place.has(r.to));
  return { ...about(set), definition: definitionOf(set), missing, concepts, relations };
}

/** A set's concepts, for search's `within`. */
export function setConcepts(db: DB, name: string): { scheme: string; slugs: string[] } {
  const set = findSet(storedSets(db), name);
  return { scheme: set.scheme, slugs: resolveSet(set, conceptGraph(db)).members };
}
