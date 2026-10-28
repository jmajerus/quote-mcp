import fs from "node:fs";
import Database from "better-sqlite3";
import { Published, type SnapshotStore } from "./published.js";

/** The public snapshot read with better-sqlite3, for the LAN preview, the public port, and tests. */

export function sqliteStore(db: Database.Database): SnapshotStore {
  return {
    all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    get: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
  };
}

/** A snapshot file, opened read-only. */
export function openSnapshot(file: string): Promise<Published> {
  return Published.open(sqliteStore(new Database(file, { readonly: true, fileMustExist: true })));
}

/**
 * The snapshot at a path, reopened when the file is replaced (a rebuild renames a new file into place),
 * or null when there isn't one yet. A snapshot doesn't change once written, so one Published serves every
 * request until it's replaced.
 */
export function snapshotReader(file: string): () => Promise<Published | null> {
  let open: { ino: number; mtime: number; db: Database.Database; published: Promise<Published> } | null = null;
  return async () => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    if (!open || open.ino !== stat.ino || open.mtime !== stat.mtimeMs) {
      open?.db.close();
      const db = new Database(file, { readonly: true, fileMustExist: true });
      open = { ino: stat.ino, mtime: stat.mtimeMs, db, published: Published.open(sqliteStore(db)) };
    }
    return open.published;
  };
}
