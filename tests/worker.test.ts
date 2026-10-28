import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DB } from "../src/db.js";
import { readIntro } from "../src/intro.js";
import { openSnapshot } from "../src/published-sqlite.js";
import { remove, replicaScript, snapshotRows, upsert } from "../src/replica.js";
import { renderSite } from "../src/site.js";
import { SNAPSHOT_SCHEMA, type SnapshotOptions, buildSnapshot } from "../src/snapshot.js";
import type { D1Database, D1PreparedStatement } from "../worker/d1.js";
import { type Env, handle } from "../worker/index.js";
import { makeStore } from "./fixture.js";

const MIGRATION = path.join(import.meta.dirname, "..", "worker", "migrations", "0001_snapshot.sql");

/** A stand-in for the D1 binding, on better-sqlite3: the calls the Worker makes, with D1's shapes. */
function fakeD1(db: Database.Database): D1Database {
  const statement = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
    bind: (...values) => statement(sql, values),
    all: async <T>() => ({ results: db.prepare(sql).all(...params) as T[] }),
    first: async <T>() => (db.prepare(sql).get(...params) as T | undefined) ?? null,
  });
  return { prepare: (sql) => statement(sql) };
}

let store: DB;
let dir: string;
let n = 0;

/** A snapshot of the test store, and an empty replica (the migration applied) loaded from it by the SQL file. */
function publish(rest: Partial<SnapshotOptions> = {}) {
  const file = path.join(dir, `public-${n++}.db`);
  buildSnapshot(store, { level: "quotes", notes: false, intro: readIntro("# Work quotes\n\nQuotes about work."), collections: {}, sets: [{ slug: "harm", scheme: "human-work", label: "Harm", narrower: ["abuse"] }], maps: [], ...rest }, file);
  const snap = new Database(file, { readonly: true });
  const replica = new Database(":memory:");
  replica.exec(fs.readFileSync(MIGRATION, "utf8"));
  replica.exec(replicaScript(snap));
  return { file, snap, replica, env: { DB: fakeD1(replica) } as Env };
}

const get = (env: Env, p: string, init: RequestInit = {}) => handle(new Request(`https://quotes.example${p}`, init), env);

beforeAll(() => {
  store = makeStore();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-mcp-worker-"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the replica", () => {
  it("has the snapshot's schema, as the D1 migration creates it", () => {
    const strip = (sql: string) => sql.replace(/^--.*$/gm, "").replace(/\s+/g, " ").trim();
    expect(strip(fs.readFileSync(MIGRATION, "utf8"))).toBe(strip(SNAPSHOT_SCHEMA));
  });

  it("holds every row of the snapshot once loaded from the SQL file", () => {
    const { snap, replica } = publish();
    const rows = (db: Database.Database) => [...snapshotRows(db)].map((r) => JSON.stringify(r));
    expect(rows(replica)).toEqual(rows(snap));
    expect(replica.prepare("SELECT COUNT(*) FROM records_fts WHERE records_fts MATCH 'assault'").pluck().get()).toBe(1);
  });

  it("writes rows idempotently and removes them by key", () => {
    const { replica } = publish();
    const run = (statements: { sql: string; params: unknown[] }[]) => { for (const s of statements) replica.prepare(s.sql).run(...s.params); };
    const record = replica.prepare("SELECT * FROM records LIMIT 1").get() as Record<string, unknown>;
    const fts = replica.prepare("SELECT rowid, text, words FROM records_fts WHERE rowid = ?").get(record.id) as Record<string, unknown>;
    run(upsert("records", { ...record, text: "Changed." }));
    run(upsert("records", { ...record, text: "Changed." }));
    run(upsert("records_fts", { ...fts, text: "Changed." }));
    run(upsert("records_fts", { ...fts, text: "Changed." }));
    expect(replica.prepare("SELECT text FROM records WHERE id = ?").all(record.id)).toEqual([{ text: "Changed." }]);
    expect(replica.prepare("SELECT COUNT(*) FROM records_fts WHERE rowid = ?").pluck().get(record.id)).toBe(1);
    const link = replica.prepare("SELECT * FROM record_concepts LIMIT 1").get() as { record_id: number; concept_id: number };
    run([remove("record_concepts", JSON.stringify([link.record_id, link.concept_id]))]);
    expect(replica.prepare("SELECT COUNT(*) FROM record_concepts WHERE record_id = ? AND concept_id = ?").pluck().get(link.record_id, link.concept_id)).toBe(0);
  });
});

describe("the Worker", () => {
  it("renders the same pages from D1 as the LAN preview does from the snapshot", async () => {
    const { file, env } = publish();
    const local = await openSnapshot(file);
    for (const p of ["/", "/concepts", "/concepts/abuse", "/sets/harm", "/works", "/search?q=assault"]) {
      const [pathname, query] = p.split("?");
      const res = await get(env, p);
      expect(res.status, p).toBe(200);
      expect(await res.text(), p).toBe(await renderSite(local, pathname, new URLSearchParams(query)));
    }
  });

  it("caches for a minute, with the snapshot's hash as the ETag", async () => {
    const { env } = publish();
    const res = await get(env, "/");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"[0-9a-f]{20}"$/);
    expect((await get(env, "/concepts", { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await get(publish({ intro: readIntro("# Changed") }).env, "/", { headers: { "if-none-match": etag } })).status).toBe(200);
  });

  it("serves the maps' API from D1, and 403 for quotes below the quotes level", async () => {
    const { env } = publish();
    const graph = await (await get(env, "/api/graph")).json() as { concepts: { slug: string; quotes: number }[] };
    expect(graph.concepts.find((c) => c.slug === "mobbing")!.quotes).toBe(1);
    const quotes = await (await get(env, "/api/concepts/human-work%3Aabuse/quotes?limit=1")).json() as { total: number; quotes: { text: string }[] };
    expect(quotes).toMatchObject({ total: 2, limit: 1 });
    expect((await get(env, "/api/concepts/abuse/quotes?limit=many")).status).toBe(400);
    expect((await get(env, "/api/concepts/nothing")).status).toBe(404);
    expect((await get(env, "/api/sets/harm")).status).toBe(200);
    expect((await get(publish({ level: "catalogue" }).env, "/api/concepts/abuse/quotes")).status).toBe(403);
  });

  it("answers only public routes, and sends a bare /map to the maps", async () => {
    const { env } = publish();
    for (const p of ["/admin", "/mcp", "/health", "/api/nowhere", "/anything"]) expect((await get(env, p)).status, p).toBe(404);
    expect((await get(env, "/concepts/nothing")).status).toBe(404);
    expect((await get(env, "/", { method: "POST" })).status).toBe(405);
    const map = await get(env, "/map?x=1", { redirect: "manual" });
    expect(map.status).toBe(301);
    expect(map.headers.get("location")).toBe("/map/?x=1");
  });

  it("says the site isn't published yet when D1 is empty", async () => {
    const empty = new Database(":memory:");
    expect((await get({ DB: fakeD1(empty) }, "/")).status).toBe(503);
    empty.exec(fs.readFileSync(MIGRATION, "utf8"));
    const res = await get({ DB: fakeD1(empty) }, "/");
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/hasn't been published/);
  });
});
