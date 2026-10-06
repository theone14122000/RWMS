import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import mysql from 'mysql2/promise';
import type { Pool as MysqlPool, PoolConnection as MysqlConn } from 'mysql2/promise';
import { config } from '../config.js';

export type Row = Record<string, any>;

/**
 * Triple-mode database layer.
 *
 * - MySQL when `DATABASE_URL` starts with `mysql` (production / Railway):
 *   promise pool, per-transaction connection tracked in AsyncLocalStorage so
 *   nested `tx()` calls use savepoints on the same connection.
 * - PostgreSQL when `DATABASE_URL` starts with `postgres`: async pool with the
 *   same AsyncLocalStorage savepoint scheme.
 * - SQLite (node:sqlite) otherwise (local dev / tests): the legacy synchronous
 *   engine, serialized behind a mutex because the public API is now async and
 *   a yielding transaction must not interleave with unrelated queries.
 *
 * Public API (all modes): async `get` / `all` / `run` / `exec` / `tx`.
 * SQLite-flavoured SQL is translated per-dialect at call time (`toMySql`,
 * `toPg`); MySQL keeps `?` placeholders, PostgreSQL rewrites them to `$n`.
 */

const dbDialect: 'sqlite' | 'pg' | 'mysql' = !config.databaseUrl
  ? 'sqlite'
  : /^mysql2?:/i.test(config.databaseUrl)
    ? 'mysql'
    : 'pg';
const usePg = dbDialect === 'pg';
const useMysql = dbDialect === 'mysql';

type PgScope = { kind: 'pg'; client: pg.PoolClient; depth: number };
type MysqlScope = { kind: 'mysql'; conn: MysqlConn; depth: number };
type SqliteScope = { kind: 'sqlite'; depth: number };
type Scope = PgScope | MysqlScope | SqliteScope;

const als = new AsyncLocalStorage<Scope>();

// ---------------------------------------------------------------- PostgreSQL

let pool: pg.Pool | null = null;
let idColumnCache: Map<string, boolean> | null = null;

// int8/numeric come back as strings by default; every column in this schema is
// sized so JS numbers are exact (integer ids, double precision money).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// Dates/timestamps are stored as TEXT ISO strings (SQLite parity): return the
// raw value instead of letting pg parse it into a Date object.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1083, (v) => v);
pg.types.setTypeParser(1114, (v) => v);
pg.types.setTypeParser(1184, (v) => v);

function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.pgPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 20_000,
      // Never keep the process alive just because idle clients are pooled.
      allowExitOnIdle: true,
      // A black-holed proxy connection must fail loudly, not hang a request.
      statement_timeout: 30_000,
      query_timeout: 45_000,
      // Detect silently-dead proxy sockets quickly instead of stalling a query.
      keepAlive: true,
      keepAliveInitialDelayMillis: 15_000,
    });
    pool.on('error', (err) => {
      console.error('[crm] idle postgres client error:', err.message);
    });
  }
  return pool;
}

/** Converts SQLite-flavoured SQL to PostgreSQL at call time. */
function toPgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let i = 0;
  let state: 'code' | 'single' | 'double' | 'line' | 'block' = 'code';
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (state === 'code') {
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '-' && next === '-') state = 'line';
      else if (ch === '/' && next === '*') state = 'block';
      else if (ch === '?') {
        n += 1;
        out += `$${n}`;
        i += 1;
        continue;
      }
      out += ch;
    } else if (state === 'single') {
      out += ch;
      if (ch === "'") {
        if (next === "'") {
          out += next;
          i += 1;
        } else state = 'code';
      }
    } else if (state === 'double') {
      out += ch;
      if (ch === '"') state = 'code';
    } else if (state === 'line') {
      out += ch;
      if (ch === '\n') state = 'code';
    } else {
      out += ch;
      if (ch === '*' && next === '/') {
        out += next;
        i += 1;
        state = 'code';
      }
    }
    i += 1;
  }
  return out;
}

const INSERT_RE = /\bINSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+([A-Za-z_][\w$]*)/i;

async function tableHasId(table: string): Promise<boolean> {
  if (!idColumnCache) idColumnCache = new Map();
  const key = table.toLowerCase();
  const hit = idColumnCache.get(key);
  if (hit !== undefined) return hit;
  const res = await getPool().query(
    `SELECT 1 AS one FROM information_schema.columns
     WHERE table_schema = current_schema AND table_name = $1 AND column_name = 'id'`,
    [key],
  );
  const has = res.rows.length > 0;
  idColumnCache.set(key, has);
  return has;
}

async function toPg(sql: string): Promise<string> {
  let work = sql;
  let conflictDoNothing = false;
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(work)) {
    work = work.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
    conflictDoNothing = true;
  }
  // SQLite's LIKE is case-insensitive for ASCII; ILIKE matches that behaviour.
  work = work.replace(/(?<![A-Za-z_])LIKE(?![A-Za-z_])/gi, 'ILIKE');

  // SQLite COLLATE NOCASE is ASCII case-insensitive; lower() on the operand matches.
  work = work.replace(
    /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)\s+COLLATE\s+NOCASE\b/gi,
    (_m, col: string) => `lower(${col})`,
  );

  // SQLite date('now'[, modifier]) → TEXT calendar date (SQLite returns TEXT;
  // every date column in this schema is TEXT, so the result must be TEXT too).
  work = work.replace(
    /date\('now'(?:,\s*'([+-]?\d+)\s+(days?|hours?|minutes?|months?|years?)')?\)/gi,
    (_m, n: string | undefined, unit: string | undefined) =>
      n === undefined
        ? `to_char(CURRENT_DATE, 'YYYY-MM-DD')`
        : `to_char((CURRENT_DATE + INTERVAL '${n} ${unit}'), 'YYYY-MM-DD')`,
  );

  // SQLite date(substr(col, 1, 19), '+5 hours', '+30 minutes') → local calendar date.
  work = work.replace(
    /date\(substr\(([\w.]+),\s*1,\s*19\)((?:,\s*'[+-]?\d+\s+(?:hours?|minutes?)')+)\)/gi,
    (_m, col: string, modsRaw: string) => {
      const parts = [...modsRaw.matchAll(/'([+-]?\d+)\s+(hours?|minutes?)'/g)].map(
        ([, n, u]) => `INTERVAL '${n} ${u}'`,
      );
      return `to_char(((substr(${col}, 1, 19))::timestamp + ${parts.join(' + ')}), 'YYYY-MM-DD')`;
    },
  );

  // SQLite date(<expr>, '±N unit') with a parameter/column expression → TEXT
  // (keeps the original text-comparison semantics of date()).
  work = work.replace(
    /date\(([\w.$?]+),\s*'([+-]?\d+)\s+(days?|hours?|minutes?|months?|years?)'\)/gi,
    (_m, arg: string, n: string, unit: string) =>
      `to_char((${arg}::timestamp + INTERVAL '${n} ${unit}'), 'YYYY-MM-DD')`,
  );

  const suffix: string[] = [];
  if (conflictDoNothing) suffix.push('ON CONFLICT DO NOTHING');

  const hasReturning = /\bRETURNING\b/i.test(work);
  if (!hasReturning) {
    const m = INSERT_RE.exec(work);
    if (m && (await tableHasId(m[1]))) {
      suffix.push('RETURNING id');
    }
  }

  let converted = toPgPlaceholders(work);
  if (suffix.length) converted = `${converted} ${suffix.join(' ')}`;
  return converted;
}

async function pgQuery(
  client: pg.PoolClient | null,
  sql: string,
  params: unknown[],
): Promise<{ rows: Row[]; rowCount: number }> {
  try {
    const text = await toPg(sql);
    let lastErr: unknown;
    // Transient connection drops (proxy idle resets) are safe to retry when we
    // are not inside an explicit transaction — each attempt grabs a fresh
    // pooled connection.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = client
          ? await client.query(text, params as any[])
          : await getPool().query(text, params as any[]);
        return { rows: res.rows ?? [], rowCount: res.rowCount ?? 0 };
      } catch (err) {
        lastErr = err;
        const code = (err as { code?: string }).code;
        const msg = (err as Error).message ?? '';
        // DNS blips and proxy socket resets: retry on a fresh connection with a
        // short backoff so a transient outage does not fail the request.
        const quick =
          code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE' ||
          code === '57P01' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
        // Black-holed sockets surface as query timeouts: one fresh attempt.
        const slow = msg.includes('Query read timeout');
        if (client || !(quick || slow)) break;
        if (attempt === (quick ? 2 : 1)) break;
        if (quick) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    throw lastErr;
  } catch (err) {
    const e = err as Error & { sql?: string };
    e.sql = sql.replace(/\s+/g, ' ').slice(0, 300);
    e.message = `${e.message}\nSQL: ${e.sql}`;
    throw e;
  }
}

// --------------------------------------------------------------------- MySQL

let myPool: MysqlPool | null = null;

function getMysql(): MysqlPool {
  if (!myPool) {
    const u = new URL(config.databaseUrl);
    const sslParam = u.searchParams.get('ssl');
    myPool = mysql.createPool({
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
      charset: 'utf8mb4',
      connectionLimit: config.pgPoolMax,
      idleTimeout: 30_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 15_000,
      connectTimeout: 20_000,
      // migrate() applies each migration as one multi-statement exec().
      multipleStatements: true,
      // TEXT ISO parity: never parse DATE/DATETIME columns into JS Dates.
      dateStrings: true,
      // DECIMAL -> Number (mirrors pg's setTypeParser(1700)).
      decimalNumbers: true,
      timezone: 'Z',
      ...(sslParam && sslParam !== 'false' ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    (myPool as any).on?.('error', (err: Error) => {
      console.error('[crm] idle mysql connection error:', err.message);
    });
  }
  return myPool;
}

const UNIT = (u: string) => u.replace(/s$/i, '').toUpperCase();
const interval = (n: string, u: string) => `INTERVAL ${n.replace(/^\+/, '')} ${UNIT(u)}`;

/** Converts SQLite-flavoured SQL to MySQL at call time. */
function toMySql(sql: string): string {
  let work = sql;

  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(work)) {
    work = work.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT IGNORE INTO');
  }

  // ON CONFLICT ... DO NOTHING (with or without a conflict target) -> INSERT IGNORE.
  const nothing = /\s*ON\s+CONFLICT(?:\s*\([^)]*\))?\s+DO\s+NOTHING\b/i.exec(work);
  if (nothing) {
    work = work.slice(0, nothing.index) + work.slice(nothing.index + nothing[0].length);
    work = work.replace(/^\s*INSERT\s+INTO\b/i, 'INSERT IGNORE INTO');
  }

  // ON CONFLICT (...) DO UPDATE SET ... excluded.x -> ON DUPLICATE KEY UPDATE ... VALUES(x).
  if (/\bON\s+CONFLICT\b/i.test(work)) {
    work = work.replace(
      /\s*ON\s+CONFLICT(?:\s*\([^)]*\))?\s+DO\s+UPDATE\s+SET\b/i,
      ' ON DUPLICATE KEY UPDATE',
    );
    work = work.replace(/\bexcluded\.([A-Za-z_]\w*)/gi, 'VALUES($1)');
  }

  // SQLite CAST(x AS INTEGER) → MySQL CAST(x AS SIGNED).
  work = work.replace(/(\bCAST\s*\(\s*)([\s\S]*?)(\s+AS\s+)INTEGER\b/gi, '$1$2$3SIGNED');

  // SQLite COLLATE NOCASE is ASCII case-insensitive; lower() on the operand matches.
  work = work.replace(
    /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)\s+COLLATE\s+NOCASE\b/gi,
    (_m, col: string) => `lower(${col})`,
  );

  // SQLite date('now'[, modifier]) -> TEXT calendar date (all date columns are TEXT).
  work = work.replace(
    /date\('now'(?:,\s*'([+-]?\d+)\s+(days?|hours?|minutes?|months?|years?)')?\)/gi,
    (_m, n: string | undefined, u: string | undefined) =>
      n === undefined
        ? `DATE_FORMAT(CURDATE(), '%Y-%m-%d')`
        : `DATE_FORMAT(DATE_ADD(CURDATE(), ${interval(n, u!)}), '%Y-%m-%d')`,
  );

  // SQLite date(substr(col, 1, 19), '+5 hours', '+30 minutes') -> local calendar date.
  work = work.replace(
    /date\(substr\(([\w.]+),\s*1,\s*19\)((?:,\s*'[+-]?\d+\s+(?:hours?|minutes?)')+)\)/gi,
    (_m, col: string, modsRaw: string) => {
      const parts = [...modsRaw.matchAll(/'([+-]?\d+)\s+(hours?|minutes?)'/g)].map(([, n, u]) =>
        interval(n, u),
      );
      let expr = `STR_TO_DATE(SUBSTR(${col}, 1, 19), '%Y-%m-%dT%H:%i:%s')`;
      for (const p of parts) expr = `DATE_ADD(${expr}, ${p})`;
      return `DATE_FORMAT(${expr}, '%Y-%m-%d')`;
    },
  );

  // SQLite date(<expr>, '±N unit') -> local calendar date (text-comparison semantics).
  work = work.replace(
    /date\(([\w.$?]+),\s*'([+-]?\d+)\s+(days?|hours?|minutes?|months?|years?)'\)/gi,
    (_m, arg: string, n: string, u: string) =>
      `DATE_FORMAT(DATE_ADD(STR_TO_DATE(SUBSTRING(${arg}, 1, 19), '%Y-%m-%dT%H:%i:%s'), ${interval(
        n,
        u,
      )}), '%Y-%m-%d')`,
  );

  return work;
}

async function mysqlQuery(
  conn: MysqlConn | null,
  sql: string,
  params: unknown[],
): Promise<{ rows: Row[]; rowCount: number; insertId: number }> {
  try {
    const text = toMySql(sql);
    let lastErr: unknown;
    // Transient proxy/socket drops are safe to retry outside an explicit
    // transaction — each attempt grabs a fresh pooled connection.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const target = conn ?? getMysql();
        const [res] = await target.query(text, normalize(params));
        if (Array.isArray(res)) {
          const rows = res as Row[];
          return { rows, rowCount: rows.length, insertId: 0 };
        }
        const ok = res as { affectedRows?: number; insertId?: number };
        return { rows: [], rowCount: Number(ok.affectedRows ?? 0), insertId: Number(ok.insertId ?? 0) };
      } catch (err) {
        lastErr = err;
        const e = err as { code?: string; errno?: number };
        const code = e.code ?? '';
        const quick =
          code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE' ||
          code === 'ENOTFOUND' || code === 'EAI_AGAIN' ||
          e.errno === 2006 || e.errno === 2013 || e.errno === 2055;
        if (conn || !quick) break;
        if (attempt === 2) break;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    throw lastErr;
  } catch (err) {
    const e = err as Error & { sql?: string };
    e.sql = sql.replace(/\s+/g, ' ').slice(0, 300);
    e.message = `${e.message}\nSQL: ${e.sql}`;
    throw e;
  }
}

// ------------------------------------------------------------------- SQLite

let db: DatabaseSync | null = null;
let dbPath = '';
const stmtCache = new Map<string, StatementSync>();
let mutexTail: Promise<unknown> = Promise.resolve();

function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutexTail.then(
    () => fn(),
    () => fn(),
  );
  mutexTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function openDatabase(filePath: string = config.databasePath): void {
  if (dbDialect !== 'sqlite') return;
  if (db) closeSync();
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
}

function closeSync(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  db = null;
  stmtCache.clear();
}

export async function closeDatabase(): Promise<void> {
  closeSync();
  if (pool) {
    const p = pool;
    pool = null;
    idColumnCache = null;
    await p.end();
  }
  if (myPool) {
    const p = myPool;
    myPool = null;
    await p.end();
  }
}

export function databasePath(): string {
  if (usePg || useMysql) {
    try {
      const u = new URL(config.databaseUrl);
      return `${useMysql ? 'mysql' : 'postgres'}://${u.host}${u.pathname}`;
    } catch {
      return useMysql ? 'mysql' : 'postgres';
    }
  }
  return dbPath;
}

export function isPostgres(): boolean {
  return usePg;
}

export function getDialect(): 'sqlite' | 'pg' | 'mysql' {
  return dbDialect;
}

export function getDb(): DatabaseSync {
  if (dbDialect !== 'sqlite') throw new Error(`getDb() is unavailable in ${dbDialect} mode`);
  if (!db) openDatabase();
  return db!;
}

function normalize(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}

function getStmt(sql: string): StatementSync {
  let s = stmtCache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

type SqliteResult = { rows: Row[]; changes: number; lastInsertRowid: number };

function sqliteExec(sql: string, params: unknown[]): SqliteResult {
  const stmt = getStmt(sql);
  if (params.length === 0 && /^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
    const rows = stmt.all() as Row[];
    return { rows: rows.map((r) => ({ ...r })), changes: 0, lastInsertRowid: 0 };
  }
  if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
    const rows = stmt.all(...(normalize(params) as any[])) as Row[];
    return { rows: rows.map((r) => ({ ...r })), changes: 0, lastInsertRowid: 0 };
  }
  const res = stmt.run(...(normalize(params) as any[]));
  return { rows: [], changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}

async function sqliteQuery(sql: string, params: unknown[]): Promise<SqliteResult> {
  const scope = als.getStore();
  if (scope?.kind === 'sqlite') return sqliteExec(sql, params);
  return withMutex(async () => sqliteExec(sql, params));
}

// ------------------------------------------------------------------ Queries

async function query(
  sql: string,
  params: unknown[],
): Promise<{ rows: Row[]; changes: number; lastInsertRowid: number }> {
  if (useMysql) {
    const scope = als.getStore();
    const { rows, rowCount, insertId } = await mysqlQuery(
      scope?.kind === 'mysql' ? scope.conn : null,
      sql,
      params,
    );
    return { rows, changes: rowCount, lastInsertRowid: insertId || Number(rows[0]?.id ?? 0) };
  }
  if (usePg) {
    const scope = als.getStore();
    const { rows, rowCount } = await pgQuery(scope?.kind === 'pg' ? scope.client : null, sql, params);
    return { rows, changes: rowCount, lastInsertRowid: Number(rows[0]?.id ?? 0) };
  }
  return await sqliteQuery(sql, params);
}

export async function all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await query(sql, params);
  return rows.map((r) => ({ ...r }) as T);
}

export async function get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await query(sql, params);
  return rows.length ? ({ ...rows[0] } as T) : undefined;
}

export async function run(
  sql: string,
  params: unknown[] = [],
): Promise<{ changes: number; lastInsertRowid: number }> {
  const res = await query(sql, params);
  return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
}

/** Executes one or more raw statements (no parameters). */
export async function exec(sql: string): Promise<void> {
  if (useMysql) {
    const scope = als.getStore();
    try {
      if (scope?.kind === 'mysql') await scope.conn.query(sql);
      else await getMysql().query(sql);
    } catch (err) {
      const e = err as Error;
      e.message = `${e.message}\nSQL: ${sql.replace(/\s+/g, ' ').slice(0, 300)}`;
      throw e;
    }
    return;
  }
  if (usePg) {
    const scope = als.getStore();
    try {
      if (scope?.kind === 'pg') await scope.client.query(sql);
      else await getPool().query(sql);
    } catch (err) {
      const e = err as Error;
      e.message = `${e.message}\nSQL: ${sql.replace(/\s+/g, ' ').slice(0, 300)}`;
      throw e;
    }
    return;
  }
  const doExec = () => {
    getDb().exec(sql);
  };
  if (als.getStore()?.kind === 'sqlite') return doExec();
  await withMutex(async () => doExec());
}

/** Runs `fn` inside a transaction (nested calls use savepoints). */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (useMysql) {
    const scope = als.getStore();
    if (scope?.kind === 'mysql') {
      const sp = `sp_${scope.depth}`;
      await scope.conn.query(`SAVEPOINT ${sp}`);
      try {
        const result = await fn();
        await scope.conn.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        try {
          await scope.conn.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await scope.conn.query(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          /* rollback best effort */
        }
        throw err;
      }
    }
    const conn = await getMysql().getConnection();
    // A fatal socket error on the checked-out connection must not crash the
    // process (EventEmitter throws when 'error' has no listeners).
    let socketBroke = false;
    const onConnError = () => {
      socketBroke = true;
    };
    (conn as any).on?.('error', onConnError);
    try {
      await conn.query('BEGIN');
      const result = await als.run({ kind: 'mysql', conn, depth: 1 }, fn);
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await conn.query('ROLLBACK');
      } catch {
        /* rollback best effort */
      }
      throw err;
    } finally {
      (conn as any).removeListener?.('error', onConnError);
      if (socketBroke) conn.destroy();
      else conn.release();
    }
  }
  if (usePg) {
    const scope = als.getStore();
    if (scope?.kind === 'pg') {
      const sp = `sp_${scope.depth}`;
      await scope.client.query(`SAVEPOINT ${sp}`);
      try {
        const result = await fn();
        await scope.client.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        try {
          await scope.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await scope.client.query(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          /* rollback best effort */
        }
        throw err;
      }
    }
    const client = await getPool().connect();
    // pg-pool strips its idle 'error' listener while a client is checked out;
    // a proxy socket reset would otherwise crash the process (EventEmitter
    // throws when 'error' has no listeners). Track it and discard the client.
    let socketBroke = false;
    const onClientError = () => {
      socketBroke = true;
    };
    client.on('error', onClientError);
    try {
      await client.query('BEGIN');
      const result = await als.run({ kind: 'pg', client, depth: 1 }, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* rollback best effort */
      }
      throw err;
    } finally {
      client.removeListener('error', onClientError);
      client.release(socketBroke ? new Error('connection lost mid-transaction') : undefined);
    }
  }

  const scope = als.getStore();
  if (scope?.kind === 'sqlite') {
    // Nested inside an open transaction: savepoints on the shared connection.
    const database = getDb();
    const sp = `sp_${scope.depth}`;
    database.exec(`SAVEPOINT ${sp}`);
    try {
      const result = await fn();
      database.exec(`RELEASE ${sp}`);
      return result;
    } catch (err) {
      try {
        database.exec(`ROLLBACK TO ${sp}`);
        database.exec(`RELEASE ${sp}`);
      } catch {
        /* rollback best effort */
      }
      throw err;
    }
  }

  return withMutex(async () => {
    const database = getDb();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await als.run({ kind: 'sqlite', depth: 1 }, fn);
      database.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* rollback best effort */
      }
      throw err;
    }
  });
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** Escapes LIKE wildcards so user input is matched literally. */
export function likeTerm(term: string): string {
  return `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
}
