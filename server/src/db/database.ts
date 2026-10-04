import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export type Row = Record<string, any>;

let db: DatabaseSync | null = null;
let dbPath = '';
const stmtCache = new Map<string, StatementSync>();
let txDepth = 0;

export function openDatabase(filePath: string = config.databasePath): void {
  if (db) closeDatabase();
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  db = new DatabaseSync(filePath);
  dbPath = filePath;
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  stmtCache.clear();
  txDepth = 0;
}

export function closeDatabase(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  db = null;
  stmtCache.clear();
  txDepth = 0;
}

export function databasePath(): string {
  return dbPath;
}

export function getDb(): DatabaseSync {
  if (!db) openDatabase();
  return db!;
}

function normalize(params: unknown[]): any[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}

function stmt(sql: string): StatementSync {
  let s = stmtCache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

function plain<T>(row: any): T {
  return row === undefined || row === null ? (row as T) : ({ ...row } as T);
}

export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  const rows = stmt(sql).all(...normalize(params));
  return rows.map((r) => plain<T>(r));
}

export function get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  const row = stmt(sql).get(...normalize(params));
  return row === undefined ? undefined : plain<T>(row);
}

export function run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number } {
  const res = stmt(sql).run(...normalize(params));
  return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}

export function exec(sql: string): void {
  getDb().exec(sql);
}

/** Runs `fn` inside a transaction (nested calls use savepoints). */
export function tx<T>(fn: () => T): T {
  const database = getDb();
  const savepoint = `sp_${txDepth}`;
  if (txDepth === 0) {
    database.exec('BEGIN IMMEDIATE');
  } else {
    database.exec(`SAVEPOINT ${savepoint}`);
  }
  txDepth += 1;
  try {
    const result = fn();
    txDepth -= 1;
    if (txDepth === 0) {
      database.exec('COMMIT');
    } else {
      database.exec(`RELEASE ${savepoint}`);
    }
    return result;
  } catch (err) {
    txDepth -= 1;
    try {
      if (txDepth === 0) {
        database.exec('ROLLBACK');
      } else {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
      }
    } catch {
      /* rollback best effort */
    }
    throw err;
  }
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** Escapes LIKE wildcards so user input is matched literally. */
export function likeTerm(term: string): string {
  return `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
}
