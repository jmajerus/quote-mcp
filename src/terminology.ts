import Database from "better-sqlite3";
import { type DB, getMeta, now, setMeta } from "./db.js";
import { SCHEME } from "./import.js";
import type { ConceptSet } from "./sets.js";

/**
 * Follows terminology-mcp's `human-work` scheme, which is the master of its concepts, labels, slugs,
 * definitions, and relations; the store's concepts and concept_relations for the scheme are its replica
 * (docs/dev-briefs/human-work-from-terminology-mcp.md, on Concept Clusters' subjectsSubscriber). The
 * contract is terminology-mcp's docs/following-changes.md: bootstrap from the scheme's state once, then
 * apply the numbered changes after the cursor, in order, and report how far it got.
 *
 * Each change is applied in one transaction with the cursor, so a pass that stops part-way resumes at
 * the right change. Replacing each touched concept with the change's term snapshots is enough to stay
 * correct; the kind decides whether quotes need anything more. A merge, or a retirement with one
 * replacement, re-points the quotes' tags to the replacement (the tag's words stay), with history. A
 * change that needs a person stops the cursor there and is reported as `blocked`, until it's handled and
 * accepted with `quote-mcp terms --accept <n>`:
 *
 *   split              a concept that quotes use was split
 *   retire-ambiguous   a concept that quotes use was retired with no replacement, or several
 *   slug-in-sets       a slug changed that vocab/sets.json names
 *
 * The bootstrap matches terms to concepts by the `quote-mcp:human-work:<slug>` alias that terminology-mcp's
 * import gave them, and refuses to apply if a slug differs, so public links never change by surprise.
 */

export const SCHEME_ID = SCHEME.slug;
export const SUBSCRIBER_ID = "quote-mcp";
const SUBSCRIBER_LABEL = "Quote MCP";
export const DEFAULT_TERMINOLOGY_BASE = "http://terminology-mcp.localdomain:8000";
const ACTOR = "terminology-mcp";
const CURSOR = `terminology:${SCHEME_ID}`;
const ALIAS = `quote-mcp:${SCHEME_ID}:`;
export const TERMS_INTERVAL_MS = 60_000;
const HEARTBEAT_MS = 5 * 60_000;

export interface Term {
  id: string; scheme?: string; slug: string; formerSlugs?: string[]; label: string; altLabels?: string[]; scopeNote?: string | null;
  status?: "provisional" | "active" | "retired"; replacedBy?: string[]; broader?: string[]; relations?: { type: string; target: string }[];
  links?: { uri: string; match: string }[]; aliases?: string[];
}
export interface Change { n: number; kind: string; terms?: string[]; after?: Term | null; afterTerms?: Term[]; reason?: string | null }
export interface Blocked { at: number; code: string; reason: string }
export interface Cursor { log: string; through: number; blocked: Blocked | null }
export interface Problem { code: string; reason: string }

// --- The client ----------------------------------------------------------------------------------

/** TERMINOLOGY_BASE=off turns following off; unset means the LAN server, where the caller names itself. */
export function terminologyConfig(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; timeoutMs: number } | null {
  const raw = env.TERMINOLOGY_BASE?.trim() ?? "";
  if (raw.toLowerCase() === "off") return null;
  return { baseUrl: (raw || DEFAULT_TERMINOLOGY_BASE).replace(/\/+$/, ""), timeoutMs: 10_000 };
}

export class TerminologyError extends Error {
  /** 0 when the server couldn't be reached. */
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> | null = null) {
    super(message);
  }
}

export interface TerminologyClient {
  baseUrl: string;
  state(): Promise<{ log: string; version: number; head?: number; terms: Term[] }>;
  changes(since: number): Promise<{ log: string; version: number; changes: Change[] }>;
  reportProgress(report: Record<string, unknown>): Promise<unknown>;
  propose(proposal: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function terminologyClient({ baseUrl, timeoutMs = 10_000, fetchImpl = fetch }: { baseUrl: string; timeoutMs?: number; fetchImpl?: typeof fetch }): TerminologyClient {
  const request = async (method: string, path: string, payload?: unknown) => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method, headers: payload === undefined ? {} : { "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TerminologyError(0, `terminology-mcp unreachable at ${baseUrl}: ${(error as Error).message}`);
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = body?.error ?? body?.reason ?? "";
      throw new TerminologyError(res.status, `terminology-mcp ${method} ${path.split("?")[0]} answered ${res.status}${detail ? `: ${detail}` : ""}`, body);
    }
    return body as never;
  };
  const scheme = encodeURIComponent(SCHEME_ID);
  return {
    baseUrl,
    state: () => request("GET", `/api/state?scheme=${scheme}`),
    changes: (since) => request("GET", `/api/changes?since=${since}&scheme=${scheme}`),
    reportProgress: (report) => request("POST", `/api/subscribers/${SUBSCRIBER_ID}/progress`, report),
    propose: (proposal) => request("POST", "/api/proposals", proposal),
  };
}

// --- Terms as concepts ---------------------------------------------------------------------------

const STATUS: Record<string, string> = { provisional: "provisional", active: "confirmed", retired: "retired" };
const RELATION: Record<string, string> = { related: "related", opposite: "inverse" };
/** close_match holds the WordNet synset the old site linked; other close matches stay in terminology-mcp. */
const WORDNET = /wordnet|\/wn\d+\//i;

interface Local { id: number; slug: string; label: string; alt_labels: string; definition: string | null; close_match: string | null; status: string; term_id: string | null }

/** The concept row a term becomes. */
function fields(t: Term) {
  return {
    slug: t.slug, label: t.label, alt_labels: JSON.stringify(t.altLabels ?? []), definition: t.scopeNote || null,
    close_match: t.links?.find((l) => l.match === "closeMatch" && WORDNET.test(l.uri))?.uri ?? null,
    status: STATUS[t.status ?? "active"] ?? "confirmed", former_slugs: JSON.stringify(t.formerSlugs ?? []), term_id: t.id,
    source: t.aliases?.find((a) => a.startsWith("drupal:kid:")) ?? null,
  };
}

const inScheme = (t: Term) => !t.scheme || t.scheme === SCHEME_ID;
const aliasSlug = (t: Term) => t.aliases?.find((a) => a.startsWith(ALIAS))?.slice(ALIAS.length) ?? null;
/** The term snapshots a change carries: every touched term's, or the new term's for an addition. */
const snapshotsOf = (c: Change) => (c.afterTerms ?? (c.after?.id ? [c.after] : [])).filter(inScheme);

class Hold extends Error {
  constructor(readonly code: string, reason: string) {
    super(reason);
  }
}

function schemeId(db: DB): number {
  const id = db.prepare("SELECT id FROM schemes WHERE slug = ?").pluck().get(SCHEME_ID) as number | undefined;
  if (id !== undefined) return id;
  return db.prepare("INSERT INTO schemes (slug, label, description, created_at) VALUES (?, ?, ?, ?) RETURNING id").pluck().get(SCHEME_ID, SCHEME.label, SCHEME.description, now()) as number;
}

const byTerm = (db: DB, termId: string) => db.prepare("SELECT * FROM concepts WHERE term_id = ?").get(termId) as Local | undefined;

/** Overwrites the terms' concepts (adding new ones), then their relations. Throws Hold when one can't be written. */
function writeTerms(db: DB, terms: Term[]): void {
  const scheme = schemeId(db);
  const stamp = now();
  const update = db.prepare(`UPDATE concepts SET slug = @slug, label = @label, alt_labels = @alt_labels, definition = @definition, close_match = @close_match,
    status = @status, former_slugs = @former_slugs, source = COALESCE(@source, source), updated_at = @stamp WHERE term_id = @term_id`);
  const insert = db.prepare(`INSERT INTO concepts (scheme_id, slug, label, alt_labels, definition, close_match, status, former_slugs, term_id, source, created_at, updated_at)
    VALUES (@scheme, @slug, @label, @alt_labels, @definition, @close_match, @status, @former_slugs, @term_id, @source, @stamp, @stamp)`);
  for (const t of terms) {
    try {
      if (!update.run({ ...fields(t), stamp }).changes) insert.run({ ...fields(t), scheme, stamp });
    } catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_CONSTRAINT_UNIQUE") throw error;
      throw new Hold("slug-clash", `"${t.label}" has the slug ${t.slug}, which another concept here has`);
    }
  }
  // A term's own edges are its broader terms and its symmetric relations, stored here in both
  // directions. Its children's edges are theirs, and stay.
  const idOf = (termId: string, from: Term) => {
    const id = db.prepare("SELECT id FROM concepts WHERE term_id = ?").pluck().get(termId) as number | undefined;
    if (id === undefined) throw new Hold("unknown-term", `"${from.label}" names term ${termId}, which isn't here`);
    return id;
  };
  const clear = db.prepare(`DELETE FROM concept_relations WHERE (from_id = @id AND type IN ('broader', 'related', 'inverse'))
    OR (to_id = @id AND type IN ('narrower', 'related', 'inverse'))`);
  const add = db.prepare("INSERT OR IGNORE INTO concept_relations (from_id, to_id, type) VALUES (?, ?, ?)");
  for (const t of terms) clear.run({ id: idOf(t.id, t) });
  for (const t of terms) {
    const id = idOf(t.id, t);
    for (const b of t.broader ?? []) {
      const parent = idOf(b, t);
      add.run(id, parent, "broader");
      add.run(parent, id, "narrower");
    }
    for (const r of t.relations ?? []) {
      const type = RELATION[r.type];
      if (!type) continue;
      const other = idOf(r.target, t);
      add.run(id, other, type);
      add.run(other, id, type);
    }
  }
}

/** Quotes whose tags or marks use a concept. */
function usedBy(db: DB, conceptId: number): number[] {
  return db.prepare("SELECT quote_id FROM quote_tags WHERE concept_id = ? UNION SELECT quote_id FROM quote_kwic WHERE concept_id = ?").pluck().all(conceptId, conceptId) as number[];
}

/** Points a retired concept's tags and marks at its replacement, keeping their words, with a history entry per quote. */
function repoint(db: DB, from: Local, to: Local, why: string): number {
  const quotes = usedBy(db, from.id);
  const history = db.prepare("INSERT INTO history (quote_id, at, kind, before, after, actor, reason) VALUES (?, ?, 'concept_replaced', ?, ?, ?, ?)");
  const stamp = now();
  for (const q of quotes) history.run(q, stamp, JSON.stringify({ concept: from.slug }), JSON.stringify({ concept: to.slug }), ACTOR, why);
  db.prepare("UPDATE quote_tags SET concept_id = ? WHERE concept_id = ?").run(to.id, from.id);
  db.prepare("UPDATE quote_kwic SET concept_id = ? WHERE concept_id = ?").run(to.id, from.id);
  return quotes.length;
}

/** The sets in vocab/sets.json that name a slug of the scheme. */
function setsNaming(sets: ConceptSet[], slug: string): string[] {
  return sets.filter((s) => s.scheme === SCHEME_ID && [s.concepts, s.around, s.narrower, s.exclude].some((l) => l?.includes(slug))).map((s) => s.slug);
}

const IGNORED = new Set(["scheme-added", "scheme-changed", "set-added", "set-changed", "set-deleted"]);
const APPLIED = new Set(["imported", "added", "noted", "labelled", "updated", "moved", "slugged", "merged", "retired", "split"]);
const quotes = (n: number) => `${n} quote${n === 1 ? "" : "s"}`;

/**
 * Applies one change to the store, or throws Hold for one that needs a person. Run it in a transaction:
 * a hold thrown after some writes leaves nothing behind. Returns a line for each thing it did.
 */
export function applyChange(db: DB, change: Change, sets: ConceptSet[]): string[] {
  if (IGNORED.has(change.kind)) return [];
  if (!APPLIED.has(change.kind)) throw new Hold("unknown-change", `Change kind "${change.kind}" isn't one Quote MCP knows`);
  const terms = snapshotsOf(change);
  const lines: string[] = [];
  const replacing: [Local, string][] = [];
  for (const t of terms) {
    const row = byTerm(db, t.id);
    if (!row) continue;
    if (row.slug !== t.slug) {
      const named = setsNaming(sets, row.slug);
      if (named.length) throw new Hold("slug-in-sets", `The slug ${row.slug} became ${t.slug}, and vocab/sets.json names it (${named.join(", ")})`);
    }
    if (row.status === "retired" || t.status !== "retired") continue;
    const used = usedBy(db, row.id).length;
    const into = t.replacedBy ?? [];
    if (change.kind === "split" && used) throw new Hold("split", `"${row.label}" was split, and ${quotes(used)} use it: a person decides where they go`);
    if (change.kind !== "split" && into.length === 1) replacing.push([row, into[0]]);
    else if (used) throw new Hold("retire-ambiguous", `"${row.label}" was retired with ${into.length} replacements, and ${quotes(used)} use it: a person decides where they go`);
  }
  writeTerms(db, terms);
  if (terms.length) lines.push(`${change.kind}: ${terms.map((t) => `${t.slug}${t.status === "retired" ? " (retired)" : ""}`).join(", ")}`);
  for (const [from, termId] of replacing) {
    const to = byTerm(db, termId);
    if (!to || to.status === "retired") throw new Hold("retire-ambiguous", `"${from.label}" was replaced by a term that isn't a live concept here`);
    const n = repoint(db, from, to, `terminology-mcp change ${change.n} (${change.kind}): ${from.slug} became ${to.slug}`);
    if (n) lines.push(`re-pointed ${quotes(n)} from ${from.slug} to ${to.slug}`);
  }
  return lines;
}

// --- The cursor ----------------------------------------------------------------------------------

export class CursorMovedError extends Error {
  constructor() {
    super("The terminology cursor moved during this pass (another run, or an --accept); the next pass starts from it.");
  }
}

export function readCursor(db: DB): Cursor | null {
  const value = getMeta(db, CURSOR);
  return value ? (JSON.parse(value) as Cursor) : null;
}

/** Writes the cursor if it's still at `expected` (null: there's none yet); call it in the transaction that applied the change. */
function writeCursor(db: DB, cursor: Cursor, expected: number | null): void {
  const current = readCursor(db);
  if ((current?.through ?? null) !== expected || (current && current.log !== cursor.log)) throw new CursorMovedError();
  setMeta(db, CURSOR, JSON.stringify(cursor));
}

export function clearCursor(db: DB): void {
  db.prepare("DELETE FROM meta WHERE key = ?").run(CURSOR);
}

// --- Bootstrap -----------------------------------------------------------------------------------

/** Problems that stop the bootstrap: applying it would change a slug, or attach a term to the wrong concept. */
const BLOCKING = new Set(["slug-mismatch", "term-mismatch", "slug-clash"]);

/**
 * How the scheme's terms line up with the store's concepts: which concept each term is (by its term id,
 * else its quote-mcp alias), what would change, and what doesn't match.
 */
export function planBootstrap(db: DB, terms: Term[]) {
  const rows = db.prepare("SELECT c.* FROM concepts c JOIN schemes s ON s.id = c.scheme_id WHERE s.slug = ?").all(SCHEME_ID) as Local[];
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const byId = new Map(rows.filter((r) => r.term_id).map((r) => [r.term_id!, r]));
  const matches: [Local, Term][] = [];
  const added: Term[] = [];
  const changes: string[] = [];
  const problems: Problem[] = [];
  for (const t of terms) {
    const alias = aliasSlug(t);
    const row = byId.get(t.id) ?? (alias ? bySlug.get(alias) : undefined);
    if (!row) {
      if (bySlug.has(t.slug)) problems.push({ code: "slug-clash", reason: `Term ${t.id} "${t.label}" has the slug ${t.slug}, but isn't the concept with it here` });
      else added.push(t);
      continue;
    }
    if (row.term_id && row.term_id !== t.id) problems.push({ code: "term-mismatch", reason: `${row.slug} is term ${row.term_id} here, but ${t.id} names it` });
    if (row.slug !== t.slug) problems.push({ code: "slug-mismatch", reason: `${row.slug} is ${t.slug} in terminology-mcp` });
    matches.push([row, t]);
    const want = fields(t);
    for (const k of ["label", "alt_labels", "definition", "close_match", "status"] as const) {
      if ((row[k] ?? null) !== want[k]) changes.push(`${row.slug}: ${k} ${JSON.stringify(row[k])} -> ${JSON.stringify(want[k])}`);
    }
  }
  const matched = new Set(matches.map(([r]) => r.id));
  for (const r of rows) if (!matched.has(r.id)) problems.push({ code: "not-in-terminology", reason: `${r.slug} isn't in terminology-mcp's ${SCHEME_ID}; it's left as it is` });

  // Relations, by slug: what the terms say against what's stored.
  const slugOf = new Map(terms.map((t) => [t.id, t.slug]));
  const want = new Set<string>();
  for (const t of terms) {
    for (const b of t.broader ?? []) want.add(`${t.slug} broader ${slugOf.get(b)}`).add(`${slugOf.get(b)} narrower ${t.slug}`);
    for (const r of t.relations ?? []) if (RELATION[r.type]) want.add(`${t.slug} ${RELATION[r.type]} ${slugOf.get(r.target)}`).add(`${slugOf.get(r.target)} ${RELATION[r.type]} ${t.slug}`);
  }
  const have = new Set((db.prepare(`SELECT a.slug || ' ' || r.type || ' ' || b.slug FROM concept_relations r JOIN concepts a ON a.id = r.from_id JOIN concepts b ON b.id = r.to_id
    JOIN schemes s ON s.id = a.scheme_id WHERE s.slug = ?`).pluck().all(SCHEME_ID) as string[]));
  for (const e of want) if (!have.has(e)) changes.push(`relation ${e}: added`);
  for (const e of have) if (!want.has(e)) changes.push(`relation ${e}: removed`);
  return { matches, added, changes, problems, blocked: problems.some((p) => BLOCKING.has(p.code)) };
}

// --- A pass --------------------------------------------------------------------------------------

export interface SyncResult {
  outcome: "bootstrap" | "bootstrapped" | "bootstrap-held" | "rebuilt" | "applied" | "current" | "held";
  log: string | null; through: number | null; head?: number; blocked?: Blocked | null; reset?: boolean;
  /** What was applied, or with apply false, what would be. */
  lines: string[];
  problems?: Problem[];
}

async function bootstrap(db: DB, client: TerminologyClient, apply: boolean): Promise<SyncResult> {
  const state = await client.state();
  const terms = state.terms.filter(inScheme);
  const plan = planBootstrap(db, terms);
  const base = { log: state.log, through: state.version, head: state.head ?? state.version, problems: plan.problems };
  const lines = [`${plan.matches.length} terms matched to concepts, ${plan.added.length} new`, ...plan.added.map((t) => `add ${t.slug}`), ...plan.changes];
  if (plan.blocked) return { outcome: "bootstrap-held", ...base, lines };
  if (!apply) return { outcome: "bootstrap", ...base, lines };
  db.transaction(() => {
    const attach = db.prepare("UPDATE concepts SET term_id = ? WHERE id = ?");
    for (const [row, t] of plan.matches) attach.run(t.id, row.id);
    writeTerms(db, terms);
    writeCursor(db, { log: state.log, through: state.version, blocked: null }, null);
  }).immediate();
  return { outcome: "bootstrapped", ...base, lines, reset: true };
}

const ROLLBACK = new Error("dry run");

/**
 * One pass: bootstrap when there's no cursor, else apply the changes after it in order, stopping at the
 * first that needs a person. With apply false the same work runs and is rolled back, so `lines` says
 * exactly what a pass would do and `blocked` where it would stop.
 */
export async function runTermSync({ db, client, sets, apply = true }: { db: DB; client: TerminologyClient; sets: ConceptSet[]; apply?: boolean }): Promise<SyncResult> {
  const cursor = readCursor(db);
  if (!cursor) return bootstrap(db, client, apply);
  let response: Awaited<ReturnType<TerminologyClient["changes"]>> | null;
  try {
    response = await client.changes(cursor.through);
  } catch (error) {
    // `since` past the head: the store was rebuilt under the same log id.
    if (!(error instanceof TerminologyError && error.status === 400)) throw error;
    response = null;
  }
  if (!response || response.log !== cursor.log) {
    if (apply) clearCursor(db);
    return { outcome: "rebuilt", log: response?.log ?? null, through: cursor.through, lines: [] };
  }
  const { log, version } = response;
  const pass = () => {
    let through = cursor.through;
    let blocked: Blocked | null = null;
    const lines: string[] = [];
    for (const change of response.changes) {
      try {
        lines.push(...db.transaction(() => {
          const done = applyChange(db, change, sets);
          writeCursor(db, { log, through: change.n, blocked: null }, through);
          return done;
        }).immediate().map((l) => `${change.n} ${l}`));
        through = change.n;
      } catch (error) {
        if (!(error instanceof Hold)) throw error;
        blocked = { at: change.n, code: error.code, reason: error.message };
        break;
      }
    }
    const written = through;
    if (!blocked) through = version;
    db.transaction(() => writeCursor(db, { log, through, blocked }, written)).immediate();
    return { outcome: blocked ? "held" as const : through > cursor.through ? "applied" as const : "current" as const, log, through, head: version, blocked, lines };
  };
  if (apply) return pass();
  let result: SyncResult | undefined;
  try {
    db.transaction(() => {
      result = pass();
      throw ROLLBACK;
    })();
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return result!;
}

/**
 * Marks the change the cursor is held at as handled by a person: its terms are written as they are, and
 * the cursor moves past it. `repointTo` (a slug) re-points the quotes of the concepts it retired, for a
 * split or a retirement a person has decided; without it they keep the retired concept.
 */
export async function acceptHeldChange({ db, client, n, repointTo }: { db: DB; client: TerminologyClient; n: number; repointTo?: string }) {
  const cursor = readCursor(db);
  if (!cursor?.blocked) throw new Error("The subscriber isn't held at any change.");
  if (cursor.blocked.at !== n) throw new Error(`The subscriber is held at change ${cursor.blocked.at}, not ${n}.`);
  const response = await client.changes(cursor.through);
  if (response.log !== cursor.log) throw new Error("terminology-mcp's log changed; the next pass bootstraps again.");
  const change = response.changes.find((c) => c.n === n);
  if (!change) throw new Error(`Change ${n} isn't after the cursor (${cursor.through}).`);
  const lines: string[] = [];
  db.transaction(() => {
    const terms = snapshotsOf(change);
    const retiring = terms.map((t) => [byTerm(db, t.id), t] as const).filter(([row, t]) => row && row.status !== "retired" && t.status === "retired").map(([row]) => row!);
    writeTerms(db, terms);
    if (repointTo) {
      const to = db.prepare("SELECT * FROM concepts c WHERE slug = ? AND status != 'retired' AND scheme_id = (SELECT id FROM schemes WHERE slug = ?)").get(repointTo, SCHEME_ID) as Local | undefined;
      if (!to) throw new Error(`No live concept ${repointTo} in ${SCHEME_ID}.`);
      for (const from of retiring) {
        const count = repoint(db, from, to, `terminology-mcp change ${n} (${change.kind}), accepted by hand: ${from.slug} became ${to.slug}`);
        lines.push(`re-pointed ${quotes(count)} from ${from.slug} to ${to.slug}`);
      }
    }
    writeCursor(db, { log: cursor.log, through: n, blocked: null }, cursor.through);
  }).immediate();
  return { log: cursor.log, through: n, change, lines };
}

// --- Progress ------------------------------------------------------------------------------------

export function progressReport(result: Pick<SyncResult, "log" | "through" | "blocked" | "reset">): Record<string, unknown> {
  return {
    log: result.log, through: result.through, label: SUBSCRIBER_LABEL, schemes: [SCHEME_ID],
    ...(result.blocked ? { blocked: result.blocked } : {}), ...(result.reset ? { reset: true } : {}),
  };
}

/** Reports progress; a cursor behind the last report (wiped, or restored from a backup) is resent with reset. */
export async function reportProgress(client: TerminologyClient, result: Pick<SyncResult, "log" | "through" | "blocked" | "reset">): Promise<unknown> {
  const report = progressReport(result);
  try {
    return await client.reportProgress(report);
  } catch (error) {
    if (error instanceof TerminologyError && error.status === 409 && Number.isInteger(error.body?.through)) return client.reportProgress({ ...report, reset: true });
    throw error;
  }
}

// --- In the server -------------------------------------------------------------------------------

export interface TermSyncStatus { phase: "off" | "pending" | "ok" | "held" | "error"; through: number | null; head: number | null; blocked: Blocked | null; error: string | null; at: string | null }

export const termSyncEnabled = (env: NodeJS.ProcessEnv = process.env) => env.QUOTE_TERMS_SYNC?.trim().toLowerCase() === "on";

/**
 * Follows the scheme every minute while the server is up, when QUOTE_TERMS_SYNC=on, through its own
 * writable connection to the store (the server's other one is read-only). Reports when the cursor or the
 * hold changes, and every five minutes besides, so terminology-mcp's lastSeen means alive. `onApplied`
 * runs after a pass that changed the store (the public snapshot is rebuilt then). Returns its status for
 * /health.
 */
export function startTermSync({ file, sets, env = process.env, onApplied, client, intervalMs = TERMS_INTERVAL_MS }: {
  file: string; sets: ConceptSet[]; env?: NodeJS.ProcessEnv; onApplied?: () => void; client?: TerminologyClient; intervalMs?: number;
}): () => TermSyncStatus {
  const status: TermSyncStatus = { phase: "off", through: null, head: null, blocked: null, error: null, at: null };
  const config = terminologyConfig(env);
  if (!termSyncEnabled(env) || (!client && !config)) return () => ({ ...status });
  const target = client ?? terminologyClient(config!);
  const db = new Database(file, { fileMustExist: true });
  db.pragma("busy_timeout = 30000");
  db.pragma("foreign_keys = ON");
  status.phase = "pending";
  let running = false;
  let lastReport = "";
  let lastReportAt = 0;
  const say = (message: string) => {
    if (status.error !== message) console.error(message);
  };
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runTermSync({ db, client: target, sets });
      for (const line of result.lines) if (result.outcome !== "current") console.error(`Concepts from terminology-mcp: ${line}`);
      if (result.outcome === "bootstrap-held") throw new Error(`the bootstrap is held: ${result.problems!.filter((p) => BLOCKING.has(p.code)).map((p) => p.reason).join("; ")}`);
      if (result.outcome === "held") say(`Concepts from terminology-mcp held at change ${result.blocked!.at} (${result.blocked!.code}): ${result.blocked!.reason}`);
      Object.assign(status, { phase: result.outcome === "held" ? "held" : "ok", through: result.through, head: result.head ?? null, blocked: result.blocked ?? null,
        error: result.outcome === "held" ? `${result.blocked!.code}: ${result.blocked!.reason}` : null });
      if (result.outcome === "applied" || result.outcome === "bootstrapped" || (result.outcome === "held" && result.lines.length)) onApplied?.();
      if (result.outcome === "rebuilt") return;
      const key = JSON.stringify([result.log, result.through, result.blocked ?? null]);
      if (key !== lastReport || Date.now() - lastReportAt >= HEARTBEAT_MS) {
        await reportProgress(target, result);
        lastReport = key;
        lastReportAt = Date.now();
      }
    } catch (error) {
      const message = (error as Error).message;
      say(`Concepts from terminology-mcp failed (retrying): ${message}`);
      Object.assign(status, { phase: "error", error: message });
    } finally {
      status.at = new Date().toISOString();
      running = false;
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  void run();
  return () => ({ ...status });
}

// --- Proposals -----------------------------------------------------------------------------------

/**
 * A proposal to terminology-mcp for a tag that isn't a concept, with a quote that uses it as evidence
 * (POST /api/proposals, or its MCP propose_term tool). The quote is the first one with the tag unless
 * one is named. Retries with the same tag return the term already proposed.
 */
export function proposal(db: DB, tag: string, o: { quote?: number; label?: string; broader?: string; note?: string; altLabels?: string[] } = {}): Record<string, unknown> {
  const quote = db.prepare("SELECT quote_id FROM quote_tags WHERE tag = ? COLLATE NOCASE AND concept_id IS NULL AND (? IS NULL OR quote_id = ?) ORDER BY quote_id LIMIT 1")
    .pluck().get(tag, o.quote ?? null, o.quote ?? null) as number | undefined;
  if (quote === undefined) {
    throw new Error(o.quote === undefined ? `No quote has the tag "${tag}" without a concept; quote_worklist unresolved_tags lists them.`
      : `Quote ${o.quote} doesn't have the tag "${tag}" without a concept.`);
  }
  const q = db.prepare("SELECT kind, text, comment FROM quotes WHERE id = ?").get(quote) as { kind: string; text: string; comment: string | null } | undefined;
  if (!q) throw new Error(`No quote ${quote}.`);
  const words = (q.kind === "note" ? q.comment : q.text) ?? "";
  return {
    scheme: SCHEME_ID, label: o.label ?? tag, ...(o.note ? { scopeNote: o.note } : {}), ...(o.altLabels?.length ? { altLabels: o.altLabels } : {}),
    ...(o.broader ? { broader: o.broader } : {}),
    evidence: { quote, text: words.length > 500 ? `${words.slice(0, 499)}…` : words, tag },
    proposer: SUBSCRIBER_ID, requestId: `tag:${tag.toLowerCase()}`,
  };
}
