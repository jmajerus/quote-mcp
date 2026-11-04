import fs from "node:fs";
import { z } from "zod";
import type { DB } from "./db.js";
import { RELATION_LABEL, ToolError, conceptGraph } from "./queries.js";

/**
 * Named concept sets: a part of one scheme, for a map or a theme to draw on, and for search. terminology-mcp
 * is their master: the subscriber (src/terminology.ts) keeps them in the store's concept_sets, and they're read
 * from there on each request. vocab/sets.json (or QUOTE_SETS) is used only while the store has none, and goes
 * once the sets have moved. Either way a set is worked out against the store on each request, so a concept
 * added later joins the sets whose recipe reaches it, by terminology-mcp's rules for a recipe:
 *
 *   concepts   these concepts
 *   around     these and their neighbours, `depth` steps out (default 1) along relations of `types`
 *              (broader, narrower, related, opposite; default all). In the store each has its own depth and types.
 *   narrower   everything narrower than these, at any depth, without these themselves
 *   exclude    minus these, last
 *
 * Or, for an explicit set in the store, its members: concepts or other sets, in order if it's ordered.
 *
 * A mistake in the file's shape stops the server from starting. A concept the scheme doesn't have (a typo, one
 * retired since, or an id from another scheme) is left out and reported as `missing`, so it shows without
 * taking the service down.
 */

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a slug: lower-case words joined by -");
const TYPES = Object.values(RELATION_LABEL) as [string, ...string[]];

const SetDefinition = z.object({
  slug,
  scheme: slug,
  label: z.string().min(1),
  description: z.string().optional(),
  concepts: z.array(slug).optional(),
  around: z.array(slug).optional(),
  depth: z.number().int().min(0).max(5).optional(),
  types: z.array(z.enum(TYPES)).optional(),
  narrower: z.array(slug).optional(),
  exclude: z.array(slug).optional(),
}).strict()
  .refine((s) => s.concepts?.length || s.around?.length || s.narrower?.length, "a set needs concepts, around, or narrower")
  .refine((s) => s.around?.length || (s.depth === undefined && s.types === undefined), "depth and types go with around");

const SetFile = z.object({ sets: z.array(SetDefinition) }).strict();

export type ConceptSet = z.infer<typeof SetDefinition>;

/** The sets in a definition file; throws, naming the file and the problem, when it's malformed. */
export function loadSets(file: string): ConceptSet[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the concept sets in ${file} (${(error as Error).message}).`);
  }
  const parsed = SetFile.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`);
    throw new Error(`The concept sets in ${file} aren't valid:\n  ${problems.join("\n  ")}`);
  }
  const seen = new Set<string>();
  for (const s of parsed.data.sets) {
    if (seen.has(s.slug)) throw new Error(`The concept sets in ${file} define "${s.slug}" twice.`);
    seen.add(s.slug);
  }
  return parsed.data.sets;
}

/** One step-out rule of a set: from a concept, `depth` steps along relations of `types`. */
export interface AroundRule { term: string; depth: number; types: string[] }

/** A set as it's worked out: the file's shape, or the store's with its terms' ids turned into slugs. */
export type SetView = Omit<ConceptSet, "around" | "description"> & {
  description?: string | null;
  around?: (string | AroundRule)[];
  /** An explicit set's members: concept slugs, or the sets nested in it. */
  members?: (string | SetView)[];
  ordered?: boolean;
  formerSlugs?: string[];
};

interface SetRow { id: string; scheme: string; slug: string; label: string; description: string | null; ordered: number; members: string; recipe: string | null; former_slugs: string }
interface Recipe { concepts?: string[]; narrower?: string[]; around?: AroundRule[]; exclude?: string[] }

/** The sets the subscriber keeps in the store, by slug, with concepts named by slug; an id with no concept here stays as it is, and shows as missing. */
export function storedSets(db: DB): SetView[] {
  const rows = db.prepare("SELECT * FROM concept_sets ORDER BY slug").all() as SetRow[];
  if (!rows.length) return [];
  const slugs = new Map((db.prepare("SELECT term_id, slug FROM concepts WHERE term_id IS NOT NULL").all() as { term_id: string; slug: string }[]).map((c) => [c.term_id, c.slug]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const slugOf = (id: string) => slugs.get(id) ?? id;
  const some = <T>(list: T[] | undefined) => (list?.length ? list : undefined);
  const view = (row: SetRow, path: string[]): SetView => {
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

/** The sets in effect: the store's, or the file's while the store has none. */
export function currentSets(db: DB, file: ConceptSet[] = []): SetView[] {
  const stored = storedSets(db);
  return stored.length ? stored : file;
}

/** A set by slug, or a slug it used to have; the error lists the sets there are. */
export function findSet(sets: SetView[], name: string): SetView {
  const wanted = name.trim().toLowerCase();
  const set = sets.find((s) => s.slug === wanted) ?? sets.find((s) => s.formerSlugs?.includes(wanted));
  if (!set) throw new ToolError(`No concept set "${name}". ${sets.length ? `Sets: ${sets.map((s) => s.slug).join(", ")}.` : "None are defined."}`);
  return set;
}

type Graph = Pick<ReturnType<typeof conceptGraph>, "relations"> & { concepts: { slug: string; scheme: string }[] };

const ALL_TYPES = Object.values(RELATION_LABEL);

/** The slugs of a set's concepts, in the store as it is now, and the names it gives that the scheme doesn't have. */
export function resolveSet(set: SetView, graph: Graph): { members: string[]; missing: string[] } {
  const inScheme = new Set(graph.concepts.filter((c) => c.scheme === set.scheme).map((c) => c.slug));
  const next = new Map<string, { to: string; type: string }[]>();
  for (const r of graph.relations) {
    if (!inScheme.has(r.from) || !inScheme.has(r.to)) continue;
    (next.get(r.from) ?? next.set(r.from, []).get(r.from)!).push({ to: r.to, type: RELATION_LABEL[r.type] ?? r.type });
  }
  const missing = new Set<string>();
  const known = (list: string[] = []) => list.filter((s) => inScheme.has(s) || !missing.add(s));
  const work = (s: SetView): string[] => {
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
    for (const a of s.around ?? []) {
      // The file gives one depth and types for its whole list; the store, each rule its own.
      const rule = typeof a === "string" ? { term: a, depth: s.depth ?? 1, types: s.types ?? ALL_TYPES } : a;
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

function about(set: SetView) {
  return { slug: set.slug, scheme: set.scheme, label: set.label, description: set.description || null };
}

/** A set's definition as it's shown: slugs throughout, and a nested set by its slug. */
export function definitionOf(set: SetView) {
  const { concepts, around, depth, types, narrower, exclude, members } = set;
  return { concepts, around, depth, types, narrower, exclude, members: members?.map((m) => (typeof m === "string" ? m : m.slug)) };
}

/** How many quotes are tagged with these concepts, as search counts them (unparsed ones left out). */
function quoteCount(db: DB, scheme: string, slugs: string[]): number {
  return db.prepare(`SELECT COUNT(DISTINCT t.quote_id) FROM quote_tags t JOIN quotes q ON q.id = t.quote_id JOIN concepts c ON c.id = t.concept_id JOIN schemes s ON s.id = c.scheme_id
    WHERE q.status != 'unparsed' AND s.slug = ? AND c.slug IN (SELECT value FROM json_each(?))`).pluck().get(scheme, JSON.stringify(slugs)) as number;
}

/** Every set, with how many concepts it has now and how many quotes they have. */
export function listSets(db: DB, file: ConceptSet[] = []) {
  const graph = conceptGraph(db);
  return currentSets(db, file).map((set) => {
    const { members, missing } = resolveSet(set, graph);
    return { ...about(set), concepts: members.length, quotes: quoteCount(db, set.scheme, members), missing };
  });
}

/**
 * One set as a piece of the concept graph: its concepts and the relations between them, in /api/graph's
 * shape, so a map can draw it as it draws a whole scheme. `definition` is the set as it's defined.
 */
export function setGraph(db: DB, file: ConceptSet[], name: string) {
  const set = findSet(currentSets(db, file), name);
  const graph = conceptGraph(db);
  const { members, missing } = resolveSet(set, graph);
  const place = new Map(members.map((slug, i) => [slug, i]));
  const concepts = graph.concepts.filter((c) => c.scheme === set.scheme && place.has(c.slug));
  if (set.ordered) concepts.sort((a, b) => place.get(a.slug)! - place.get(b.slug)!);
  const relations = graph.relations.filter((r) => place.has(r.from) && place.has(r.to));
  return { ...about(set), definition: definitionOf(set), missing, concepts, relations };
}

/** A set's concepts, for search's `within`. */
export function setConcepts(db: DB, file: ConceptSet[], name: string): { scheme: string; slugs: string[] } {
  const set = findSet(currentSets(db, file), name);
  return { scheme: set.scheme, slugs: resolveSet(set, conceptGraph(db)).members };
}
