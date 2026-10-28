import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import { type D1Http, d1Http, d1ConfigFrom } from "./d1-http.js";
import { REPLICA_TABLES, type ReplicaRow, type Statement, remove, snapshotRows, upsert } from "./replica.js";

/**
 * Keeps the public snapshot's replica in D1 in step, on concept-clusters' model (its publishedReplica):
 * a queue of rows to ship, and a drain that ships them. D1 is only a replica; nothing writes it but this.
 *
 * The queue and what was last shipped live in replica.db beside the store, which the server can write
 * though it reads the store read-only. When the snapshot's hash changes (an import, a deploy, or
 * `publish` rebuilt it), each row is compared with what was shipped, by table, key, and a hash of the
 * row; new and changed rows are queued, and shipped rows the snapshot no longer has are queued for
 * removal. A queued row has one entry, so a later change replaces a pending one.
 *
 * The drain sends removals (in reverse dependency order) and then rows (in dependency order, meta last,
 * so the Worker's ETag changes only once the rest is there), in batches that D1 runs as transactions.
 * After a batch succeeds, its rows are recorded as shipped and their queue entries cleared, if their hash
 * is still the one queued. A failure leaves them queued for the next tick; every statement is idempotent,
 * so sending one again is harmless.
 */

const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shipped (tbl TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (tbl, key));
-- hash is the row's, or '' for a removal.
CREATE TABLE IF NOT EXISTS queue (tbl TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, enqueued_at TEXT NOT NULL, PRIMARY KEY (tbl, key));
`;

/** Statements per batch; D1 runs each batch as one transaction. */
const BATCH = 100;
export const DRAIN_INTERVAL_MS = 15_000;

const order = new Map(REPLICA_TABLES.map(([t], i) => [t, i]));
const rowHash = (row: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(row)).digest("hex");

export function openReplicaState(file: string): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(STATE_SCHEMA);
  return db;
}

function stateValue(state: Database.Database, key: string): string | null {
  return (state.prepare("SELECT value FROM state WHERE key = ?").pluck().get(key) as string | undefined) ?? null;
}

function setState(state: Database.Database, key: string, value: string): void {
  state.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

const snapshotHash = (snap: Database.Database) => (snap.prepare("SELECT value FROM meta WHERE key = 'hash'").pluck().get() as string | undefined) ?? "";

/** The snapshot's rows by table and key, with each row's hash. */
function desired(snap: Database.Database): Map<string, ReplicaRow & { hash: string }> {
  const rows = new Map<string, ReplicaRow & { hash: string }>();
  for (const r of snapshotRows(snap)) rows.set(`${r.table}\u0001${r.key}`, { ...r, hash: rowHash(r.row) });
  return rows;
}

/** Queues what changed since the snapshot was last compared; nothing when its hash is the same. Returns how many entries were queued. */
export function enqueue(state: Database.Database, snap: Database.Database): number {
  const hash = snapshotHash(snap);
  if (!hash || stateValue(state, "snapshot_hash") === hash) return 0;
  const want = desired(snap);
  const now = new Date().toISOString();
  let queued = 0;
  state.transaction(() => {
    const shipped = new Map((state.prepare("SELECT tbl, key, hash FROM shipped").all() as { tbl: string; key: string; hash: string }[]).map((r) => [`${r.tbl}\u0001${r.key}`, r.hash]));
    const put = state.prepare("INSERT INTO queue (tbl, key, hash, enqueued_at) VALUES (?, ?, ?, ?) ON CONFLICT (tbl, key) DO UPDATE SET hash = excluded.hash, enqueued_at = excluded.enqueued_at");
    // A queued entry may already be in D1: a batch can commit even when its response is lost. So a row
    // that's queued is sent again with its current value even when that matches what was last shipped,
    // and a queued row that's gone from the snapshot is deleted even if it was never recorded as shipped.
    const waiting = new Set((state.prepare("SELECT tbl, key FROM queue").all() as { tbl: string; key: string }[]).map((q) => `${q.tbl}\u0001${q.key}`));
    for (const [id, r] of want) {
      if (shipped.get(id) === r.hash && !waiting.has(id)) continue;
      put.run(r.table, r.key, r.hash, now);
      queued++;
    }
    for (const id of new Set([...shipped.keys(), ...waiting])) {
      if (want.has(id)) continue;
      const [table, key] = id.split("\u0001");
      put.run(table, key, "", now);
      queued++;
    }
    setState(state, "snapshot_hash", hash);
  })();
  return queued;
}

/** How many entries are waiting, and when the oldest was queued. */
export function pending(state: Database.Database): { rows: number; removals: number; since: string | null } {
  return state.prepare("SELECT COUNT(*) FILTER (WHERE hash != '') AS rows, COUNT(*) FILTER (WHERE hash = '') AS removals, MIN(enqueued_at) AS since FROM queue").get() as never;
}

interface Item { table: string; key: string; hash: string; statements: Statement[] }

/** Ships the queue to D1 in batches; returns how many entries were shipped. Throws, leaving the rest queued, when a batch fails. */
export async function drain(state: Database.Database, snap: Database.Database, d1: D1Http, renew?: () => void): Promise<number> {
  const queue = state.prepare("SELECT tbl, key, hash FROM queue").all() as { tbl: string; key: string; hash: string }[];
  if (!queue.length) return 0;
  const want = desired(snap);
  const items: Item[] = [];
  const removals = queue.filter((q) => q.hash === "").sort((a, b) => order.get(b.tbl)! - order.get(a.tbl)!);
  for (const q of removals) items.push({ table: q.tbl, key: q.key, hash: "", statements: [remove(q.tbl, q.key)] });
  // meta's hash row goes last of all: the Worker serves the replica once it's there, so it marks a whole publication.
  const last = (q: { tbl: string; key: string }) => (q.tbl === "meta" && q.key === '["hash"]' ? 1 : 0);
  const writes = queue.filter((q) => q.hash !== "").sort((a, b) => last(a) - last(b) || order.get(a.tbl)! - order.get(b.tbl)!);
  for (const q of writes) {
    const r = want.get(`${q.tbl}\u0001${q.key}`);
    // Not in this snapshot: enqueue, run with it just before, has queued its removal or dropped it.
    if (!r) continue;
    items.push({ table: q.tbl, key: q.key, hash: r.hash, statements: upsert(q.tbl, r.row) });
  }
  const record = state.transaction((done: Item[]) => {
    const ship = state.prepare("INSERT INTO shipped (tbl, key, hash) VALUES (?, ?, ?) ON CONFLICT (tbl, key) DO UPDATE SET hash = excluded.hash");
    const unship = state.prepare("DELETE FROM shipped WHERE tbl = ? AND key = ?");
    const clear = state.prepare("DELETE FROM queue WHERE tbl = ? AND key = ? AND hash = ?");
    for (const i of done) {
      if (i.hash) ship.run(i.table, i.key, i.hash);
      else unship.run(i.table, i.key);
      clear.run(i.table, i.key, i.hash);
    }
  });
  let shipped = 0;
  for (let start = 0; start < items.length;) {
    const batch: Item[] = [];
    let size = 0;
    while (start < items.length && (size === 0 || size + items[start].statements.length <= BATCH)) {
      size += items[start].statements.length;
      batch.push(items[start++]);
    }
    await d1.batch(batch.flatMap((i) => i.statements));
    record(batch);
    shipped += batch.length;
    renew?.();
  }
  setState(state, "shipped_at", new Date().toISOString());
  return shipped;
}

export interface DrainStatus { phase: "off" | "idle" | "ok" | "error"; pending: number; shipped_at: string | null; error: string | null; at: string | null }

/** How long a tick's lease lasts without renewal; each shipped batch renews it. */
const LEASE_MS = 5 * 60_000;

/**
 * Takes the lease on replica.db, so one tick at a time compares and ships, across processes (the server's
 * drain and `quote-mcp publish`): an older tick finishing after a newer one could otherwise overwrite
 * newer rows in D1. A lease left by a process that died expires.
 */
function takeLease(state: Database.Database, owner: string): boolean {
  const now = Date.now();
  const row = state.prepare(`INSERT INTO state (key, value) VALUES ('lease', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE json_extract(state.value, '$.until') < ? OR json_extract(state.value, '$.owner') = ? RETURNING value`)
    .get(JSON.stringify({ owner, until: now + LEASE_MS }), now, owner);
  return row !== undefined;
}

function releaseLease(state: Database.Database, owner: string): void {
  state.prepare("DELETE FROM state WHERE key = 'lease' AND json_extract(value, '$.owner') = ?").run(owner);
}

/**
 * One tick: compare the snapshot (if it's changed) and ship what's queued. `busy` when another tick holds
 * the lease; the next one picks up whatever is left.
 */
export async function tick(snapshotFile: string, state: Database.Database, d1: D1Http): Promise<{ queued: number; shipped: number; busy?: boolean }> {
  if (!fs.existsSync(snapshotFile)) return { queued: 0, shipped: 0 };
  const owner = `${process.pid}:${randomUUID()}`;
  if (!takeLease(state, owner)) return { queued: 0, shipped: 0, busy: true };
  try {
    const snap = new Database(snapshotFile, { readonly: true, fileMustExist: true });
    try {
      const queued = enqueue(state, snap);
      return { queued, shipped: await drain(state, snap, d1, () => takeLease(state, owner)) };
    } finally {
      snap.close();
    }
  } finally {
    releaseLease(state, owner);
  }
}

/**
 * Runs the drain every 15 seconds while the server is up, when D1 is configured (see d1ConfigFrom), and
 * returns its status for /health. Without D1 settings it doesn't run, and the status says so.
 */
export function startDrain(snapshotFile: string, stateFile: string, env: NodeJS.ProcessEnv = process.env, wranglerFile?: string, intervalMs = DRAIN_INTERVAL_MS): () => DrainStatus {
  const status: DrainStatus = { phase: "off", pending: 0, shipped_at: null, error: null, at: null };
  let config: ReturnType<typeof d1ConfigFrom>;
  try {
    config = d1ConfigFrom(env, wranglerFile);
  } catch (error) {
    // Settings half done: the server runs, and /health says what's missing.
    console.error(`Public replica drain off: ${(error as Error).message}`);
    return () => ({ ...status, phase: "error", error: (error as Error).message });
  }
  if (!config) return () => ({ ...status });
  const d1 = d1Http(config);
  const state = openReplicaState(stateFile);
  status.phase = "idle";
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { queued, shipped } = await tick(snapshotFile, state, d1);
      Object.assign(status, { phase: "ok", error: null });
      if (queued || shipped) console.error(`Public replica: ${queued} queued, ${shipped} shipped to D1.`);
    } catch (error) {
      if (status.error !== (error as Error).message) console.error(`Public replica drain failed: ${(error as Error).message}`);
      Object.assign(status, { phase: "error", error: (error as Error).message });
    } finally {
      const p = pending(state);
      Object.assign(status, { pending: p.rows + p.removals, shipped_at: stateValue(state, "shipped_at"), at: new Date().toISOString() });
      running = false;
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  void run();
  return () => ({ ...status });
}
