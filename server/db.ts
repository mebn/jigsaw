import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A prepared statement whose rows have a known shape.
export type Stmt<Row> = Omit<StatementSync, 'get' | 'all'> & {
  get(...params: SQLInputValue[]): Row | undefined
  get(named: Record<string, SQLInputValue>, ...params: SQLInputValue[]): Row | undefined
  all(...params: SQLInputValue[]): Row[]
  all(named: Record<string, SQLInputValue>, ...params: SQLInputValue[]): Row[]
}

export interface Db {
  db: DatabaseSync
  prepare: <Row = unknown>(sql: string) => Stmt<Row>
  // Runs fn in a transaction, rolled back if it throws.
  tx: (fn: () => void) => void
  // Deletes a room and everything that belongs to it.
  deleteRoom: (id: string) => void
}

export function openDb(file: string): Db {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created INTEGER NOT NULL,
      cols INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      shape TEXT NOT NULL,
      seed INTEGER NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      image BLOB NOT NULL,
      image_type TEXT NOT NULL,
      thumb TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pieces (
      room_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      r INTEGER NOT NULL,
      g INTEGER NOT NULL,
      by TEXT,
      PRIMARY KEY (room_id, idx)
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL,
      created INTEGER NOT NULL,
      PRIMARY KEY (room_id, id)
    );
    CREATE TABLE IF NOT EXISTS times (
      room_id TEXT NOT NULL,
      user TEXT NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, user)
    );
  `)
  migrate(db)

  const tx = (fn: () => void) => {
    db.exec('BEGIN')
    try {
      fn()
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  // Every table with a room_id column belongs to a room, so a new one is covered without a change here.
  const roomTables = (
    db
      .prepare(
        `SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = 'table' AND c.name = 'room_id' AND m.name != 'rooms'`,
      )
      .all() as { name: string }[]
  ).map((t) => db.prepare(`DELETE FROM "${t.name}" WHERE room_id = ?`))
  const deleteRoomRow = db.prepare('DELETE FROM rooms WHERE id = ?')

  return {
    db,
    prepare: <Row,>(sql: string) => db.prepare(sql) as Stmt<Row>,
    tx,
    deleteRoom: (id) =>
      tx(() => {
        for (const del of roomTables) del.run(id)
        deleteRoomRow.run(id)
      }),
  }
}

// Applies server/migrations/NNN-name.sql files in order, once each, tracked with PRAGMA user_version.
// The CREATE statements above are the baseline schema and must not change; add a migration instead.
function migrate(db: DatabaseSync) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')
  const files = readdirSync(dir).filter((f) => /^\d+-.+\.sql$/.test(f))
  files.sort((a, b) => parseInt(a) - parseInt(b))
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  for (const f of files) {
    const v = parseInt(f)
    if (v <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(readFileSync(join(dir, f), 'utf8'))
      db.exec(`PRAGMA user_version = ${v}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${f} failed: ${(e as Error).message}`)
    }
  }
}
