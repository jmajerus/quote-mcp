import type { SnapshotStore } from "../src/published.js";

/** The part of the D1 binding the public site uses, so the Worker needs no Cloudflare type package. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

/** The snapshot's replica in D1, as the public site's queries read it. */
export function d1Store(db: D1Database): SnapshotStore {
  return {
    all: async <T>(sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).all<T>()).results,
    get: async <T>(sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).first<T>()) ?? undefined,
  };
}
