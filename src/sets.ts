import fs from "node:fs";
import { z } from "zod";
import type { DB } from "./db.js";
import { RELATION_LABEL, ToolError, conceptGraph } from "./queries.js";

/**
 * Named concept sets (SKOS collections): a part of one scheme, for a map or a theme to draw on, and for
 * search. They're editorial, so they're defined in a JSON file kept in git (vocab/sets.json, or
 * QUOTE_SETS), not imported. A set lists its concepts, or gives a recipe that is worked out against the
 * store on each request, so a concept added later joins the sets whose recipe reaches it:
 *
 *   concepts   these concepts
 *   around     these and their neighbours, `depth` steps out (default 1) along relations of `types`
 *              (broader, narrower, related, opposite; default all)
 *   narrower   these and everything narrower, at any depth
 *   exclude    minus these
 *
 * A mistake in the file's shape stops the server from starting. A slug the scheme doesn't have (a typo,
 * or a concept retired since) is left out and reported as `missing`, so it shows without taking the
 * service down.
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

/** A set by slug; the error lists the sets there are. */
export function findSet(sets: ConceptSet[], name: string): ConceptSet {
  const set = sets.find((s) => s.slug === name.trim().toLowerCase());
  if (!set) throw new ToolError(`No concept set "${name}". ${sets.length ? `Sets: ${sets.map((s) => s.slug).join(", ")}.` : "None are defined."}`);
  return set;
}

type Graph = ReturnType<typeof conceptGraph>;

/** The slugs of a set's concepts, in the store as it is now, and the slugs it names that the scheme doesn't have. */
export function resolveSet(set: ConceptSet, graph: Graph): { members: string[]; missing: string[] } {
  const inScheme = new Set(graph.concepts.filter((c) => c.scheme === set.scheme).map((c) => c.slug));
  const named = [...(set.concepts ?? []), ...(set.around ?? []), ...(set.narrower ?? []), ...(set.exclude ?? [])];
  const missing = [...new Set(named.filter((s) => !inScheme.has(s)))];
  const known = (list: string[] = []) => list.filter((s) => inScheme.has(s));
  const steps = (types: string[] | undefined) => {
    const next = new Map<string, string[]>();
    for (const r of graph.relations) {
      if (!inScheme.has(r.from) || !inScheme.has(r.to) || (types && !types.includes(RELATION_LABEL[r.type] ?? r.type))) continue;
      (next.get(r.from) ?? next.set(r.from, []).get(r.from)!).push(r.to);
    }
    return next;
  };
  const members = new Set(known(set.concepts));
  if (set.around?.length) {
    const next = steps(set.types);
    let edge = known(set.around);
    for (const s of edge) members.add(s);
    const seen = new Set(edge);
    for (let i = 0; i < (set.depth ?? 1); i++) {
      edge = edge.flatMap((s) => next.get(s) ?? []).filter((s) => !seen.has(s));
      for (const s of edge) seen.add(s), members.add(s);
    }
  }
  if (set.narrower?.length) {
    const next = steps(["narrower"]);
    const seen = new Set(known(set.narrower));
    for (const s of seen) for (const t of next.get(s) ?? []) seen.add(t);
    for (const s of seen) members.add(s);
  }
  for (const s of set.exclude ?? []) members.delete(s);
  return { members: [...members].sort(), missing };
}

function about(set: ConceptSet) {
  return { slug: set.slug, scheme: set.scheme, label: set.label, description: set.description ?? null };
}

/** Every set, with how many concepts it has now. */
export function listSets(db: DB, sets: ConceptSet[]) {
  const graph = conceptGraph(db);
  return sets.map((set) => {
    const { members, missing } = resolveSet(set, graph);
    return { ...about(set), concepts: members.length, missing };
  });
}

/**
 * One set as a piece of the concept graph: its concepts and the relations between them, in /api/graph's
 * shape, so a map can draw it as it draws a whole scheme. `definition` is the set as the file gives it.
 */
export function setGraph(db: DB, sets: ConceptSet[], name: string) {
  const set = findSet(sets, name);
  const graph = conceptGraph(db);
  const { members, missing } = resolveSet(set, graph);
  const keep = new Set(members);
  const concepts = graph.concepts.filter((c) => c.scheme === set.scheme && keep.has(c.slug));
  const relations = graph.relations.filter((r) => keep.has(r.from) && keep.has(r.to));
  const { concepts: listed, around, depth, types, narrower, exclude } = set;
  return { ...about(set), definition: { concepts: listed, around, depth, types, narrower, exclude }, missing, concepts, relations };
}

/** A set's concepts, for search's `within`. */
export function setConcepts(db: DB, sets: ConceptSet[], name: string): { scheme: string; slugs: string[] } {
  const set = findSet(sets, name);
  return { scheme: set.scheme, slugs: resolveSet(set, conceptGraph(db)).members };
}
