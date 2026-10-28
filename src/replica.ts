import type Database from "better-sqlite3";

/**
 * The public snapshot's rows as statements for its replica in D1: each table's rows in dependency order,
 * with the key that identifies a row, written as idempotent upserts and deletes. The drain ships them; a
 * SQL file of them loads a local D1 for `wrangler dev`.
 */

type Row = Record<string, unknown>;

/** The replica's tables, in the order rows are written (removals go in reverse), and each one's key. */
export const REPLICA_TABLES: [table: string, key: string[]][] = [
  ["schemes", ["id"]],
  ["concepts", ["id"]],
  ["relations", ["from_id", "to_id", "type"]],
  ["works", ["id"]],
  ["records", ["id"]],
  ["records_fts", ["rowid"]],
  ["record_concepts", ["record_id", "concept_id"]],
  ["sets", ["slug"]],
  ["set_concepts", ["set_slug", "concept_id"]],
  ["maps", ["name"]],
  ["intros", ["key"]],
  ["meta", ["key"]],
];

export interface ReplicaRow { table: string; key: string; row: Row }
export interface Statement { sql: string; params: unknown[] }

/** Every row of a snapshot, table by table in dependency order, with its key as a string. */
export function* snapshotRows(snap: Database.Database): Generator<ReplicaRow> {
  for (const [table, key] of REPLICA_TABLES) {
    const columns = table === "records_fts" ? "rowid, text, words" : "*";
    for (const row of snap.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${key.join(", ")}`).iterate() as Iterable<Row>) {
      yield { table, key: JSON.stringify(key.map((k) => row[k])), row };
    }
  }
}

const keyOf = (table: string) => REPLICA_TABLES.find(([t]) => t === table)![1];

function insert(table: string, row: Row, verb = "INSERT"): Statement {
  const columns = Object.keys(row);
  return { sql: `${verb} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, params: columns.map((c) => row[c]) };
}

/** Writes a row, replacing the one with its key. FTS5 tables take no upsert, so theirs is a delete and an insert. */
export function upsert(table: string, row: Row): Statement[] {
  if (table !== "records_fts") return [insert(table, row, "INSERT OR REPLACE")];
  return [{ sql: "DELETE FROM records_fts WHERE rowid = ?", params: [row.rowid] }, insert(table, row)];
}

/** Removes the row with a key (as snapshotRows gives it). */
export function remove(table: string, key: string): Statement {
  const columns = keyOf(table);
  return { sql: `DELETE FROM ${table} WHERE ${columns.map((c) => `${c} = ?`).join(" AND ")}`, params: JSON.parse(key) as unknown[] };
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  const text = String(v);
  if (text.includes("\0")) throw new Error("A value with a NUL character can't be written as SQL.");
  return `'${text.replace(/'/g, "''")}'`;
}

/** A statement with its parameters written in, for a SQL file. */
export function inline(s: Statement): string {
  let i = 0;
  return `${s.sql.replace(/\?/g, () => literal(s.params[i++]))};`;
}

/** A SQL file that replaces a replica's rows with a snapshot's: clears every table, then writes every row. */
export function replicaScript(snap: Database.Database): string {
  const lines = [...REPLICA_TABLES].reverse().map(([table]) => `DELETE FROM ${table};`);
  for (const { table, row } of snapshotRows(snap)) lines.push(inline(insert(table, row)));
  return `${lines.join("\n")}\n`;
}
