import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { d1ConfigFrom, d1Http } from "../src/d1-http.js";
import type { DB } from "../src/db.js";
import { enqueue, openReplicaState, pending, tick } from "../src/drain.js";
import { readIntro } from "../src/intro.js";
import { snapshotRows } from "../src/replica.js";
import { buildSnapshot } from "../src/snapshot.js";
import { type ProxyEnv, handleProxy } from "../worker/proxy.js";
import { makeStore } from "./fixture.js";

const MIGRATION = path.join(import.meta.dirname, "..", "worker", "migrations", "0001_snapshot.sql");
const TOKEN = "test-token";

/** A stand-in for a D1 binding on better-sqlite3, with batch() as one transaction, as D1's is. */
function binding(db: Database.Database): ProxyEnv["DB"] {
  const prepared = (sql: string, params: unknown[] = []) => ({
    sql, params,
    bind: (...values: unknown[]) => prepared(sql, values),
    all: async () => {
      const s = db.prepare(sql);
      return { success: true, results: s.reader ? s.all(...params) : (s.run(...params), []) };
    },
  });
  return {
    prepare: (sql) => prepared(sql),
    batch: async (statements) => db.transaction(() => statements.map((p) => {
      const { sql, params } = p as unknown as { sql: string; params: unknown[] };
      const s = db.prepare(sql);
      return { success: true, results: s.reader ? s.all(...params) : (s.run(...params), []) };
    }))(),
  };
}

let store: DB;
let dir: string;
let n = 0;

function setup() {
  const work = path.join(dir, `run-${n++}`);
  fs.mkdirSync(work);
  const file = path.join(work, "public.db");
  const build = () => buildSnapshot(store, { level: "quotes", notes: false, intro: readIntro("# Work quotes"), collections: {}, sets: [], maps: [] }, file);
  build();
  const replica = new Database(":memory:");
  replica.exec(fs.readFileSync(MIGRATION, "utf8"));
  const env: ProxyEnv = { DB: binding(replica), D1_PROXY_TOKEN: TOKEN };
  const calls: { statements: number }[] = [];
  let failNext = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (failNext) {
      failNext = false;
      throw new Error("connection reset");
    }
    const body = JSON.parse(String(init.body));
    calls.push({ statements: body.batch ? body.batch.length : 1 });
    return handleProxy(new Request(url, init), env);
  }) as typeof fetch;
  const d1 = d1Http({ endpoint: "https://proxy.example/query", token: TOKEN }, fetchImpl);
  const state = openReplicaState(path.join(work, "replica.db"));
  const same = () => {
    const rows = (db: Database.Database) => [...snapshotRows(db)].map((r) => JSON.stringify(r));
    const snap = new Database(file, { readonly: true });
    const equal = JSON.stringify(rows(replica)) === JSON.stringify(rows(snap));
    snap.close();
    return equal;
  };
  return { file, build, replica, state, d1, calls, same, fail: () => (failNext = true), run: () => tick(file, state, d1) };
}

beforeAll(() => {
  store = makeStore();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-mcp-drain-"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the replica drain", () => {
  it("ships the whole snapshot the first time, in batches D1 runs as transactions, and nothing the second", async () => {
    const r = setup();
    const first = await r.run();
    expect(first.queued).toBeGreaterThan(0);
    expect(first.shipped).toBe(first.queued);
    expect(r.same()).toBe(true);
    expect(r.calls.every((c) => c.statements <= 100)).toBe(true);
    expect(pending(r.state)).toMatchObject({ rows: 0, removals: 0 });
    const calls = r.calls.length;
    expect(await r.run()).toEqual({ queued: 0, shipped: 0 });
    expect(r.calls.length).toBe(calls);
  });

  it("ships only what changed when the snapshot is rebuilt", async () => {
    const r = setup();
    await r.run();
    const id = store.prepare("SELECT id FROM quotes WHERE text LIKE 'Abuse at work%'").pluck().get() as number;
    const before = store.prepare("SELECT text FROM quotes WHERE id = ?").pluck().get(id) as string;
    store.prepare("UPDATE quotes SET text = ? WHERE id = ?").run("Abuse at work rarely announces itself, she says.", id);
    try {
      r.build();
      const second = await r.run();
      // The record, its search row, and the snapshot's hash and build time in meta.
      expect(second).toEqual({ queued: 4, shipped: 4 });
      expect(r.same()).toBe(true);
      expect(r.replica.prepare("SELECT text FROM records WHERE id = ?").pluck().get(id)).toBe("Abuse at work rarely announces itself, she says.");
    } finally {
      store.prepare("UPDATE quotes SET text = ? WHERE id = ?").run(before, id);
    }
  });

  it("removes rows the snapshot no longer has, and their search rows and links", async () => {
    const r = setup();
    await r.run();
    const id = store.prepare("SELECT id FROM quotes WHERE text LIKE 'Everyone deserves%'").pluck().get() as number;
    store.prepare("UPDATE quotes SET status = 'unparsed' WHERE id = ?").run(id);
    try {
      r.build();
      await r.run();
      expect(r.same()).toBe(true);
      expect(r.replica.prepare("SELECT COUNT(*) FROM records WHERE id = ?").pluck().get(id)).toBe(0);
      expect(r.replica.prepare("SELECT COUNT(*) FROM records_fts WHERE rowid = ?").pluck().get(id)).toBe(0);
      expect(r.replica.prepare("SELECT COUNT(*) FROM record_concepts WHERE record_id = ?").pluck().get(id)).toBe(0);
    } finally {
      store.prepare("UPDATE quotes SET status = 'transcribed' WHERE id = ?").run(id);
    }
  });

  it("leaves the queue as it was when D1 can't be reached, and ships it on the next tick", async () => {
    const r = setup();
    r.fail();
    await expect(r.run()).rejects.toThrow(/connection reset/);
    const waiting = pending(r.state);
    expect(waiting.rows).toBeGreaterThan(0);
    expect(r.replica.prepare("SELECT COUNT(*) FROM records").pluck().get()).toBe(0);
    const next = await r.run();
    expect(next).toEqual({ queued: 0, shipped: waiting.rows });
    expect(r.same()).toBe(true);
  });

  it("replaces a pending entry when the row changes again before it ships", async () => {
    const r = setup();
    const snap = () => new Database(r.file, { readonly: true });
    const first = snap();
    enqueue(r.state, first);
    first.close();
    const id = store.prepare("SELECT id FROM quotes WHERE text LIKE 'Mobbing is%'").pluck().get() as number;
    const before = store.prepare("SELECT text FROM quotes WHERE id = ?").pluck().get(id) as string;
    store.prepare("UPDATE quotes SET text = ? WHERE id = ?").run("Mobbing is an emotional assault, first.", id);
    try {
      r.build();
      const queuedBefore = pending(r.state).rows;
      await r.run();
      expect(pending(r.state).rows).toBe(0);
      expect(r.state.prepare("SELECT COUNT(*) FROM queue").pluck().get()).toBe(0);
      expect(queuedBefore).toBeGreaterThan(0);
      expect(r.same()).toBe(true);
    } finally {
      store.prepare("UPDATE quotes SET text = ? WHERE id = ?").run(before, id);
    }
  });
});

describe("the D1 proxy", () => {
  const env = (token?: string): ProxyEnv => ({ DB: binding(new Database(":memory:")), D1_PROXY_TOKEN: token });
  const post = (e: ProxyEnv, body: unknown, auth = `Bearer ${TOKEN}`, p = "/query") =>
    handleProxy(new Request(`https://proxy.example${p}`, { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) }), e);

  it("refuses requests without the token, and everything when it has none", async () => {
    expect((await post(env(TOKEN), { sql: "SELECT 1" }, "Bearer wrong")).status).toBe(401);
    expect((await post(env(TOKEN), { sql: "SELECT 1" }, "")).status).toBe(401);
    expect((await post(env(), { sql: "SELECT 1" })).status).toBe(503);
    expect((await post(env(TOKEN), { sql: "SELECT 1" }, undefined, "/other")).status).toBe(404);
    expect((await post(env(TOKEN), { nope: true })).status).toBe(400);
  });

  it("answers in the REST API's shape", async () => {
    const res = await post(env(TOKEN), { sql: "SELECT ? AS n", params: [2] });
    expect(await res.json()).toEqual({ success: true, errors: [], result: [{ success: true, results: [{ n: 2 }], meta: {} }] });
  });
});

describe("D1 settings", () => {
  it("takes the proxy, or the REST API's three settings, and says what's missing", () => {
    expect(d1ConfigFrom({})).toBeNull();
    expect(d1ConfigFrom({ QUOTE_D1_PROXY_URL: "https://p.example", QUOTE_D1_PROXY_TOKEN: "t" })).toEqual({ endpoint: "https://p.example/query", token: "t" });
    expect(d1ConfigFrom({ QUOTE_D1_PROXY_URL: "https://p.example/query", QUOTE_D1_PROXY_TOKEN: "t" })!.endpoint).toBe("https://p.example/query");
    expect(() => d1ConfigFrom({ QUOTE_D1_PROXY_URL: "https://p.example" })).toThrow(/QUOTE_D1_PROXY_TOKEN/);
    expect(d1ConfigFrom({ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", QUOTE_D1_DATABASE_ID: "d" })).toMatchObject({ accountId: "a", databaseId: "d", token: "t" });
    expect(() => d1ConfigFrom({ CLOUDFLARE_ACCOUNT_ID: "a" })).toThrow(/CLOUDFLARE_API_TOKEN and QUOTE_D1_DATABASE_ID/);
  });
});
