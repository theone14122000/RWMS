var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all2) => {
  for (var name in all2)
    __defProp(target, name, { get: all2[name], enumerable: true });
};

// src/config.ts
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
function findServerRoot(start) {
  let dir = start;
  for (; ; ) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) {
      let skip = false;
      try {
        skip = Boolean(JSON.parse(fs.readFileSync(pj, "utf8"))?.crmRootSkip);
      } catch {
        skip = false;
      }
      if (!skip) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start, "..");
    dir = parent;
  }
}
function str(key, fallback) {
  const v = process.env[key];
  return v === void 0 || v === "" ? fallback : v;
}
function num(key, fallback) {
  const v = process.env[key];
  if (v === void 0 || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(key, fallback) {
  const v = process.env[key];
  if (v === void 0 || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}
function hops(key, fallback) {
  const v = process.env[key];
  if (v === void 0 || v === "") return fallback;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.trunc(n));
  const s = v.toLowerCase();
  return s === "true" || s === "yes" ? 1 : 0;
}
var here, SERVER_ROOT, PROJECT_ROOT, nodeEnv, isProduction, adminPassword, config;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    here = path.dirname(fileURLToPath(import.meta.url));
    SERVER_ROOT = findServerRoot(here);
    PROJECT_ROOT = path.resolve(SERVER_ROOT, "..");
    try {
      if (fs.existsSync(path.join(SERVER_ROOT, ".env"))) {
        process.loadEnvFile(path.join(SERVER_ROOT, ".env"));
      }
    } catch {
    }
    nodeEnv = str("NODE_ENV", "development");
    isProduction = nodeEnv === "production";
    adminPassword = process.env.ADMIN_PASSWORD?.trim();
    if (isProduction && !adminPassword) {
      throw new Error(
        "[crm] ADMIN_PASSWORD is required in production. Set it in the environment before starting the server."
      );
    }
    config = {
      nodeEnv,
      isProduction,
      isTest: nodeEnv === "test",
      port: num("PORT", 4e3),
      host: str("HOST", "0.0.0.0"),
      databasePath: str("DATABASE_PATH", path.join(SERVER_ROOT, "data", "crm.sqlite")),
      // Database connection string. `mysql://…` uses MySQL, `postgres://…` uses
      // PostgreSQL (production / Railway); empty falls back to the local SQLite
      // file (dev/tests).
      databaseUrl: str("DATABASE_URL", ""),
      pgPoolMax: num("PG_POOL_MAX", 10),
      sessionCookieName: str("SESSION_COOKIE", "ta_crm_session"),
      sessionTtlDays: num("SESSION_TTL_DAYS", 7),
      sessionAbsoluteTtlDays: num("SESSION_ABSOLUTE_TTL_DAYS", 30),
      cookieSecure: bool("COOKIE_SECURE", isProduction),
      trustProxy: hops("TRUST_PROXY", 0),
      businessTimezone: str("BUSINESS_TIMEZONE", "Asia/Kolkata"),
      clientDist: path.join(PROJECT_ROOT, "client", "dist"),
      serveClient: bool("SERVE_CLIENT", true),
      rateLimit: {
        windowMs: num("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1e3),
        max: num("RATE_LIMIT_MAX", 600),
        loginMax: num("LOGIN_RATE_LIMIT_MAX", 15)
      },
      loginLockout: {
        maxAttempts: num("LOGIN_LOCKOUT_MAX_ATTEMPTS", 5),
        minutes: num("LOGIN_LOCKOUT_MINUTES", 15)
      },
      passwordResetTtlMinutes: num("PASSWORD_RESET_TTL_MINUTES", 30),
      admin: {
        name: str("ADMIN_NAME", "System Owner"),
        email: str("ADMIN_EMAIL", "admin@travelcrm.local"),
        password: adminPassword || str("ADMIN_PASSWORD", "Admin@1234!")
      }
    };
  }
});

// src/db/database.ts
import { DatabaseSync } from "node:sqlite";
import fs2 from "node:fs";
import path2 from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import mysql from "mysql2/promise";
function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.pgPoolMax,
      idleTimeoutMillis: 3e4,
      connectionTimeoutMillis: 2e4,
      // Never keep the process alive just because idle clients are pooled.
      allowExitOnIdle: true,
      // A black-holed proxy connection must fail loudly, not hang a request.
      statement_timeout: 3e4,
      query_timeout: 45e3,
      // Detect silently-dead proxy sockets quickly instead of stalling a query.
      keepAlive: true,
      keepAliveInitialDelayMillis: 15e3
    });
    pool.on("error", (err) => {
      console.error("[crm] idle postgres client error:", err.message);
    });
  }
  return pool;
}
function toPgPlaceholders(sql) {
  let out = "";
  let n = 0;
  let i = 0;
  let state = "code";
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (state === "code") {
      if (ch === "'") state = "single";
      else if (ch === '"') state = "double";
      else if (ch === "-" && next === "-") state = "line";
      else if (ch === "/" && next === "*") state = "block";
      else if (ch === "?") {
        n += 1;
        out += `$${n}`;
        i += 1;
        continue;
      }
      out += ch;
    } else if (state === "single") {
      out += ch;
      if (ch === "'") {
        if (next === "'") {
          out += next;
          i += 1;
        } else state = "code";
      }
    } else if (state === "double") {
      out += ch;
      if (ch === '"') state = "code";
    } else if (state === "line") {
      out += ch;
      if (ch === "\n") state = "code";
    } else {
      out += ch;
      if (ch === "*" && next === "/") {
        out += next;
        i += 1;
        state = "code";
      }
    }
    i += 1;
  }
  return out;
}
async function tableHasId(table) {
  if (!idColumnCache) idColumnCache = /* @__PURE__ */ new Map();
  const key = table.toLowerCase();
  const hit = idColumnCache.get(key);
  if (hit !== void 0) return hit;
  const res = await getPool().query(
    `SELECT 1 AS one FROM information_schema.columns
     WHERE table_schema = current_schema AND table_name = $1 AND column_name = 'id'`,
    [key]
  );
  const has = res.rows.length > 0;
  idColumnCache.set(key, has);
  return has;
}
async function toPg(sql) {
  let work = sql;
  let conflictDoNothing = false;
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(work)) {
    work = work.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");
    conflictDoNothing = true;
  }
  work = work.replace(/(?<![A-Za-z_])LIKE(?![A-Za-z_])/gi, "ILIKE");
  work = work.replace(
    /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)\s+COLLATE\s+NOCASE\b/gi,
    (_m, col) => `lower(${col})`
  );
  work = work.replace(
    /date\('now'(?:,\s*'([+-]?\d+)\s+(days?|hours?|minutes?|months?|years?)')?\)/gi,
    (_m, n, unit) => n === void 0 ? `to_char(CURRENT_DATE, 'YYYY-MM-DD')` : `to_char((CURRENT_DATE + INTERVAL '${n} ${unit}'), 'YYYY-MM-DD')`
  );
  work = work.replace(
    /date\(substr\(([\w.]+),\s*1,\s*19\)((?:,\s*'[+-]?\d+\s+(?:hours?|minutes?)')+)\)/gi,
    (_m, col, modsRaw) => {
      const parts = [...modsRaw.matchAll(/'([+-]?\d+)\s+(hours?|minutes?)'/g)].map(
        ([, n, u]) => `INTERVAL '${n} ${u}'`
      );
      return `to_char(((substr(${col}, 1, 19))::timestamp + ${parts.join(" + ")}), 'YYYY-MM-DD')`;
    }
  );
  work = work.replace(
    /date\(([\w.$?]+),\s*'([+-]?\d+)\s+(days?|hours?|minutes?|months?|years?)'\)/gi,
    (_m, arg, n, unit) => `to_char((${arg}::timestamp + INTERVAL '${n} ${unit}'), 'YYYY-MM-DD')`
  );
  const suffix = [];
  if (conflictDoNothing) suffix.push("ON CONFLICT DO NOTHING");
  const hasReturning = /\bRETURNING\b/i.test(work);
  if (!hasReturning) {
    const m = INSERT_RE.exec(work);
    if (m && await tableHasId(m[1])) {
      suffix.push("RETURNING id");
    }
  }
  let converted = toPgPlaceholders(work);
  if (suffix.length) converted = `${converted} ${suffix.join(" ")}`;
  return converted;
}
async function pgQuery(client, sql, params) {
  try {
    const text = await toPg(sql);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = client ? await client.query(text, params) : await getPool().query(text, params);
        return { rows: res.rows ?? [], rowCount: res.rowCount ?? 0 };
      } catch (err) {
        lastErr = err;
        const code = err.code;
        const msg = err.message ?? "";
        const quick = code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EPIPE" || code === "57P01" || code === "ENOTFOUND" || code === "EAI_AGAIN";
        const slow = msg.includes("Query read timeout");
        if (client || !(quick || slow)) break;
        if (attempt === (quick ? 2 : 1)) break;
        if (quick) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    throw lastErr;
  } catch (err) {
    const e = err;
    e.sql = sql.replace(/\s+/g, " ").slice(0, 300);
    e.message = `${e.message}
SQL: ${e.sql}`;
    throw e;
  }
}
function getMysql() {
  if (!myPool) {
    const u = new URL(config.databaseUrl);
    const sslParam = u.searchParams.get("ssl");
    myPool = mysql.createPool({
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ""),
      charset: "utf8mb4",
      connectionLimit: config.pgPoolMax,
      idleTimeout: 3e4,
      enableKeepAlive: true,
      keepAliveInitialDelay: 15e3,
      connectTimeout: 2e4,
      // migrate() applies each migration as one multi-statement exec().
      multipleStatements: true,
      // TEXT ISO parity: never parse DATE/DATETIME columns into JS Dates.
      dateStrings: true,
      // DECIMAL -> Number (mirrors pg's setTypeParser(1700)).
      decimalNumbers: true,
      timezone: "Z",
      ...sslParam && sslParam !== "false" ? { ssl: { rejectUnauthorized: false } } : {}
    });
    myPool.on?.("error", (err) => {
      console.error("[crm] idle mysql connection error:", err.message);
    });
  }
  return myPool;
}
function toMySql(sql) {
  let work = sql;
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(work)) {
    work = work.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT IGNORE INTO");
  }
  const nothing = /\s*ON\s+CONFLICT(?:\s*\([^)]*\))?\s+DO\s+NOTHING\b/i.exec(work);
  if (nothing) {
    work = work.slice(0, nothing.index) + work.slice(nothing.index + nothing[0].length);
    work = work.replace(/^\s*INSERT\s+INTO\b/i, "INSERT IGNORE INTO");
  }
  if (/\bON\s+CONFLICT\b/i.test(work)) {
    work = work.replace(
      /\s*ON\s+CONFLICT(?:\s*\([^)]*\))?\s+DO\s+UPDATE\s+SET\b/i,
      " ON DUPLICATE KEY UPDATE"
    );
    work = work.replace(/\bexcluded\.([A-Za-z_]\w*)/gi, "VALUES($1)");
  }
  work = work.replace(/(\bCAST\s*\(\s*)([\s\S]*?)(\s+AS\s+)INTEGER\b/gi, "$1$2$3SIGNED");
  work = work.replace(
    /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)\s+COLLATE\s+NOCASE\b/gi,
    (_m, col) => `lower(${col})`
  );
  work = work.replace(
    /date\('now'(?:,\s*'([+-]?\d+)\s+(days?|hours?|minutes?|months?|years?)')?\)/gi,
    (_m, n, u) => n === void 0 ? `DATE_FORMAT(CURDATE(), '%Y-%m-%d')` : `DATE_FORMAT(DATE_ADD(CURDATE(), ${interval(n, u)}), '%Y-%m-%d')`
  );
  work = work.replace(
    /date\(substr\(([\w.]+),\s*1,\s*19\)((?:,\s*'[+-]?\d+\s+(?:hours?|minutes?)')+)\)/gi,
    (_m, col, modsRaw) => {
      const parts = [...modsRaw.matchAll(/'([+-]?\d+)\s+(hours?|minutes?)'/g)].map(
        ([, n, u]) => interval(n, u)
      );
      let expr = `STR_TO_DATE(SUBSTR(${col}, 1, 19), '%Y-%m-%dT%H:%i:%s')`;
      for (const p of parts) expr = `DATE_ADD(${expr}, ${p})`;
      return `DATE_FORMAT(${expr}, '%Y-%m-%d')`;
    }
  );
  work = work.replace(
    /date\(([\w.$?]+),\s*'([+-]?\d+)\s+(days?|hours?|minutes?|months?|years?)'\)/gi,
    (_m, arg, n, u) => `DATE_FORMAT(DATE_ADD(STR_TO_DATE(SUBSTRING(${arg}, 1, 19), '%Y-%m-%dT%H:%i:%s'), ${interval(
      n,
      u
    )}), '%Y-%m-%d')`
  );
  return work;
}
async function mysqlQuery(conn, sql, params) {
  try {
    const text = toMySql(sql);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const target = conn ?? getMysql();
        const [res] = await target.query(text, normalize(params));
        if (Array.isArray(res)) {
          const rows = res;
          return { rows, rowCount: rows.length, insertId: 0 };
        }
        const ok2 = res;
        return { rows: [], rowCount: Number(ok2.affectedRows ?? 0), insertId: Number(ok2.insertId ?? 0) };
      } catch (err) {
        lastErr = err;
        const e = err;
        const code = e.code ?? "";
        const quick = code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EPIPE" || code === "ENOTFOUND" || code === "EAI_AGAIN" || e.errno === 2006 || e.errno === 2013 || e.errno === 2055;
        if (conn || !quick) break;
        if (attempt === 2) break;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    throw lastErr;
  } catch (err) {
    const e = err;
    e.sql = sql.replace(/\s+/g, " ").slice(0, 300);
    e.message = `${e.message}
SQL: ${e.sql}`;
    throw e;
  }
}
function withMutex(fn) {
  const next = mutexTail.then(
    () => fn(),
    () => fn()
  );
  mutexTail = next.then(
    () => void 0,
    () => void 0
  );
  return next;
}
function openDatabase(filePath = config.databasePath) {
  if (dbDialect !== "sqlite") return;
  if (db) closeSync();
  if (filePath !== ":memory:") {
    fs2.mkdirSync(path2.dirname(filePath), { recursive: true });
  }
  db = new DatabaseSync(filePath);
  dbPath = filePath;
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  stmtCache.clear();
}
function closeSync() {
  if (db) {
    try {
      db.close();
    } catch {
    }
  }
  db = null;
  stmtCache.clear();
}
function isPostgres() {
  return usePg;
}
function getDialect() {
  return dbDialect;
}
function getDb() {
  if (dbDialect !== "sqlite") throw new Error(`getDb() is unavailable in ${dbDialect} mode`);
  if (!db) openDatabase();
  return db;
}
function normalize(params) {
  return params.map((p) => {
    if (p === void 0 || p === null) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}
function getStmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}
function sqliteExec(sql, params) {
  const stmt = getStmt(sql);
  if (params.length === 0 && /^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
    const rows = stmt.all();
    return { rows: rows.map((r) => ({ ...r })), changes: 0, lastInsertRowid: 0 };
  }
  if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
    const rows = stmt.all(...normalize(params));
    return { rows: rows.map((r) => ({ ...r })), changes: 0, lastInsertRowid: 0 };
  }
  const res = stmt.run(...normalize(params));
  return { rows: [], changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}
async function sqliteQuery(sql, params) {
  const scope = als.getStore();
  if (scope?.kind === "sqlite") return sqliteExec(sql, params);
  return withMutex(async () => sqliteExec(sql, params));
}
async function query(sql, params) {
  if (useMysql) {
    const scope = als.getStore();
    const { rows, rowCount, insertId } = await mysqlQuery(
      scope?.kind === "mysql" ? scope.conn : null,
      sql,
      params
    );
    return { rows, changes: rowCount, lastInsertRowid: insertId || Number(rows[0]?.id ?? 0) };
  }
  if (usePg) {
    const scope = als.getStore();
    const { rows, rowCount } = await pgQuery(scope?.kind === "pg" ? scope.client : null, sql, params);
    return { rows, changes: rowCount, lastInsertRowid: Number(rows[0]?.id ?? 0) };
  }
  return await sqliteQuery(sql, params);
}
async function all(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows.map((r) => ({ ...r }));
}
async function get(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows.length ? { ...rows[0] } : void 0;
}
async function run(sql, params = []) {
  const res = await query(sql, params);
  return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
}
async function exec(sql) {
  if (useMysql) {
    const scope = als.getStore();
    try {
      if (scope?.kind === "mysql") await scope.conn.query(sql);
      else await getMysql().query(sql);
    } catch (err) {
      const e = err;
      e.message = `${e.message}
SQL: ${sql.replace(/\s+/g, " ").slice(0, 300)}`;
      throw e;
    }
    return;
  }
  if (usePg) {
    const scope = als.getStore();
    try {
      if (scope?.kind === "pg") await scope.client.query(sql);
      else await getPool().query(sql);
    } catch (err) {
      const e = err;
      e.message = `${e.message}
SQL: ${sql.replace(/\s+/g, " ").slice(0, 300)}`;
      throw e;
    }
    return;
  }
  const doExec = () => {
    getDb().exec(sql);
  };
  if (als.getStore()?.kind === "sqlite") return doExec();
  await withMutex(async () => doExec());
}
async function tx(fn) {
  if (useMysql) {
    const scope2 = als.getStore();
    if (scope2?.kind === "mysql") {
      const sp = `sp_${scope2.depth}`;
      await scope2.conn.query(`SAVEPOINT ${sp}`);
      try {
        const result = await fn();
        await scope2.conn.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        try {
          await scope2.conn.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await scope2.conn.query(`RELEASE SAVEPOINT ${sp}`);
        } catch {
        }
        throw err;
      }
    }
    const conn = await getMysql().getConnection();
    let socketBroke = false;
    const onConnError = () => {
      socketBroke = true;
    };
    conn.on?.("error", onConnError);
    try {
      await conn.query("BEGIN");
      const result = await als.run({ kind: "mysql", conn, depth: 1 }, fn);
      await conn.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await conn.query("ROLLBACK");
      } catch {
      }
      throw err;
    } finally {
      conn.removeListener?.("error", onConnError);
      if (socketBroke) conn.destroy();
      else conn.release();
    }
  }
  if (usePg) {
    const scope2 = als.getStore();
    if (scope2?.kind === "pg") {
      const sp = `sp_${scope2.depth}`;
      await scope2.client.query(`SAVEPOINT ${sp}`);
      try {
        const result = await fn();
        await scope2.client.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        try {
          await scope2.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await scope2.client.query(`RELEASE SAVEPOINT ${sp}`);
        } catch {
        }
        throw err;
      }
    }
    const client = await getPool().connect();
    let socketBroke = false;
    const onClientError = () => {
      socketBroke = true;
    };
    client.on("error", onClientError);
    try {
      await client.query("BEGIN");
      const result = await als.run({ kind: "pg", client, depth: 1 }, fn);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw err;
    } finally {
      client.removeListener("error", onClientError);
      client.release(socketBroke ? new Error("connection lost mid-transaction") : void 0);
    }
  }
  const scope = als.getStore();
  if (scope?.kind === "sqlite") {
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
      }
      throw err;
    }
  }
  return withMutex(async () => {
    const database = getDb();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = await als.run({ kind: "sqlite", depth: 1 }, fn);
      database.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        database.exec("ROLLBACK");
      } catch {
      }
      throw err;
    }
  });
}
function nowISO() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function likeTerm(term) {
  return `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
}
var dbDialect, usePg, useMysql, als, pool, idColumnCache, INSERT_RE, myPool, UNIT, interval, db, dbPath, stmtCache, mutexTail;
var init_database = __esm({
  "src/db/database.ts"() {
    "use strict";
    init_config();
    dbDialect = !config.databaseUrl ? "sqlite" : /^mysql2?:/i.test(config.databaseUrl) ? "mysql" : "pg";
    usePg = dbDialect === "pg";
    useMysql = dbDialect === "mysql";
    als = new AsyncLocalStorage();
    pool = null;
    idColumnCache = null;
    pg.types.setTypeParser(20, (v) => Number(v));
    pg.types.setTypeParser(1700, (v) => Number(v));
    pg.types.setTypeParser(1082, (v) => v);
    pg.types.setTypeParser(1083, (v) => v);
    pg.types.setTypeParser(1114, (v) => v);
    pg.types.setTypeParser(1184, (v) => v);
    INSERT_RE = /\bINSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+([A-Za-z_][\w$]*)/i;
    myPool = null;
    UNIT = (u) => u.replace(/s$/i, "").toUpperCase();
    interval = (n, u) => `INTERVAL ${n.replace(/^\+/, "")} ${UNIT(u)}`;
    db = null;
    dbPath = "";
    stmtCache = /* @__PURE__ */ new Map();
    mutexTail = Promise.resolve();
  }
});

// src/lib/errors.ts
var HttpError, badRequest, unauthorized, forbidden, notFound, conflict, notConfigured, upstream;
var init_errors = __esm({
  "src/lib/errors.ts"() {
    "use strict";
    HttpError = class _HttpError extends Error {
      status;
      code;
      details;
      constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        Error.captureStackTrace?.(this, _HttpError);
      }
    };
    badRequest = (message = "Invalid request", details) => new HttpError(400, "VALIDATION_ERROR", message, details);
    unauthorized = (message = "Authentication required") => new HttpError(401, "UNAUTHORIZED", message);
    forbidden = (message = "You do not have permission to perform this action") => new HttpError(403, "FORBIDDEN", message);
    notFound = (message = "Resource not found") => new HttpError(404, "NOT_FOUND", message);
    conflict = (message = "Conflict", details) => new HttpError(409, "CONFLICT", message, details);
    notConfigured = (message = "This integration is not configured yet") => new HttpError(409, "INTEGRATION_NOT_CONFIGURED", message);
    upstream = (message = "The upstream provider could not be reached") => new HttpError(502, "UPSTREAM_ERROR", message);
  }
});

// src/services/documents.ts
var documents_exports = {};
__export(documents_exports, {
  deleteDocumentFile: () => deleteDocumentFile,
  documentPath: () => documentPath,
  parseBase64: () => parseBase64,
  recordingPath: () => recordingPath,
  sanitizeFilename: () => sanitizeFilename,
  saveDocument: () => saveDocument,
  saveRecordingFile: () => saveRecordingFile,
  uploadDir: () => uploadDir
});
import fs3 from "node:fs";
import path3 from "node:path";
import crypto3 from "node:crypto";
function uploadDir() {
  return path3.join(path3.dirname(config.databasePath), "uploads");
}
function sanitizeFilename(name) {
  const base = path3.basename(String(name || "file")).split("").map((ch) => ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? "_" : ch).join("");
  return (base || "file").slice(0, 180);
}
function asciiAt(buf, text, offset = 0) {
  return buf.length >= offset + text.length && buf.toString("latin1", offset, offset + text.length) === text;
}
function bytesAt(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}
function assertMagicBytes(mime, buf) {
  const mismatch = () => {
    throw badRequest("File content does not match its declared type.");
  };
  switch (mime) {
    case "application/pdf":
      if (!asciiAt(buf, "%PDF-", 0)) mismatch();
      return;
    case "image/png":
      if (!bytesAt(buf, [137, 80, 78, 71, 13, 10, 26, 10])) mismatch();
      return;
    case "image/jpeg":
      if (!bytesAt(buf, [255, 216, 255])) mismatch();
      return;
    case "image/webp":
      if (!asciiAt(buf, "RIFF", 0) || !asciiAt(buf, "WEBP", 8)) mismatch();
      return;
    case "application/zip":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      if (!bytesAt(buf, [80, 75, 3, 4]) && !bytesAt(buf, [80, 75, 5, 6])) mismatch();
      return;
    case "application/msword":
    case "application/vnd.ms-excel":
      if (!bytesAt(buf, [208, 207, 17, 224, 161, 177, 26, 225])) mismatch();
      return;
    case "text/plain":
    case "text/csv":
      if (buf.subarray(0, 1024).includes(0)) mismatch();
      return;
    default:
      return;
  }
}
async function saveDocument(input) {
  const mime = String(input.mimeType || "").toLowerCase();
  const allowed = ALLOWED_MIME[mime];
  if (!allowed) throw badRequest("This file type is not allowed.");
  if (!input.content.length) throw badRequest("The file is empty.");
  if (input.content.length > MAX_BYTES) throw badRequest("File exceeds the 10 MB limit.");
  assertMagicBytes(mime, input.content);
  const display = sanitizeFilename(input.filename);
  const ext = path3.extname(display).toLowerCase() || allowed[0];
  if (ext && !allowed.includes(ext)) throw badRequest("File extension does not match its content type.");
  const stored = `doc_${crypto3.randomBytes(16).toString("hex")}${ext}`;
  fs3.mkdirSync(uploadDir(), { recursive: true });
  fs3.writeFileSync(path3.join(uploadDir(), stored), input.content, { mode: 384 });
  const res = await run(
    `INSERT INTO documents (entity, entity_id, category, filename, stored_name, mime_type, size_bytes, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.entity, input.entityId, input.category ?? null, display, stored, mime, input.content.length, input.uploadedBy ?? null, await nowISO()]
  );
  return { id: res.lastInsertRowid, stored_name: stored };
}
function documentPath(doc) {
  const dir = uploadDir();
  const full = path3.join(dir, path3.basename(doc.stored_name));
  if (!full.startsWith(dir)) throw notFound("File not found.");
  return full;
}
function deleteDocumentFile(doc) {
  try {
    const full = documentPath(doc);
    if (fs3.existsSync(full)) fs3.unlinkSync(full);
  } catch {
  }
}
function parseBase64(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(String(dataUrl || ""));
  if (match) return { buffer: Buffer.from(match[2], "base64"), mime: match[1] };
  return { buffer: Buffer.from(String(dataUrl || ""), "base64"), mime: null };
}
function assertRecordingBytes(mime, buf) {
  const mismatch = () => {
    throw badRequest("Recording content does not match its declared type.");
  };
  switch (mime) {
    case "audio/mpeg":
    case "audio/mp3":
      if (!asciiAt(buf, "ID3", 0) && !(buf.length >= 2 && buf[0] === 255 && (buf[1] & 224) === 224)) mismatch();
      return;
    case "audio/wav":
    case "audio/x-wav":
      if (!asciiAt(buf, "RIFF", 0) || !asciiAt(buf, "WAVE", 8)) mismatch();
      return;
    case "audio/ogg":
      if (!asciiAt(buf, "OggS", 0)) mismatch();
      return;
    case "audio/webm":
      if (!bytesAt(buf, [26, 69, 223, 163])) mismatch();
      return;
    case "audio/mp4":
    case "audio/x-m4a":
    case "video/mp4":
      if (!asciiAt(buf, "ftyp", 4)) mismatch();
      return;
    case "audio/aac": {
      const adts = buf.length >= 2 && buf[0] === 255 && (buf[1] & 246) === 240;
      if (!adts && !asciiAt(buf, "ftyp", 4)) mismatch();
      return;
    }
    default:
      return;
  }
}
function saveRecordingFile(filename, mimeType, content) {
  const mime = String(mimeType || "").toLowerCase();
  if (!ALLOWED_AUDIO_MIME.has(mime)) throw badRequest("This recording format is not supported.");
  if (!content.length) throw badRequest("The recording is empty.");
  if (content.length > 64 * 1024 * 1024) throw badRequest("Recording exceeds the 64 MB limit.");
  assertRecordingBytes(mime, content);
  const extMap = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
    "audio/x-m4a": ".m4a",
    "video/mp4": ".mp4"
  };
  const ext = extMap[mime];
  const stored = `rec_${crypto3.randomBytes(16).toString("hex")}${ext}`;
  fs3.mkdirSync(uploadDir(), { recursive: true });
  fs3.writeFileSync(path3.join(uploadDir(), stored), content, { mode: 384 });
  return stored;
}
function recordingPath(fileKey) {
  const dir = uploadDir();
  const full = path3.join(dir, path3.basename(fileKey));
  if (!full.startsWith(dir)) throw notFound("Recording not found.");
  return full;
}
var MAX_BYTES, ALLOWED_MIME, ALLOWED_AUDIO_MIME;
var init_documents = __esm({
  "src/services/documents.ts"() {
    "use strict";
    init_config();
    init_errors();
    init_database();
    MAX_BYTES = 10 * 1024 * 1024;
    ALLOWED_MIME = {
      "application/pdf": [".pdf"],
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "image/webp": [".webp"],
      "text/plain": [".txt"],
      "text/csv": [".csv"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/msword": [".doc"],
      "application/vnd.ms-excel": [".xls"],
      "application/zip": [".zip"]
    };
    ALLOWED_AUDIO_MIME = /* @__PURE__ */ new Set([
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/mp4",
      "audio/aac",
      "audio/ogg",
      "audio/webm",
      "audio/x-m4a",
      "video/mp4"
    ]);
  }
});

// src/app.ts
init_config();
import express, { raw as raw3 } from "express";
import fs4 from "node:fs";
import path4 from "node:path";
import rateLimit2 from "express-rate-limit";

// src/middleware/auth.ts
init_config();
init_database();
init_errors();
import { parse as parseCookie, serialize as serializeCookie } from "cookie";

// src/lib/password.ts
import crypto from "node:crypto";
var SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p
  }).toString("hex");
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [scheme, nStr, rStr, pStr, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const expected = Buffer.from(hash, "hex");
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr)
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// src/middleware/auth.ts
var permissionCache = null;
async function rolePermissions(roleId) {
  if (!permissionCache) {
    permissionCache = /* @__PURE__ */ new Map();
    const rows = await all(
      "SELECT rp.role_id, p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id"
    );
    for (const row of rows) {
      if (!permissionCache.has(String(row.role_id))) permissionCache.set(String(row.role_id), /* @__PURE__ */ new Set());
      permissionCache.get(String(row.role_id)).add(String(row.code));
    }
  }
  return permissionCache.get(String(roleId)) ?? /* @__PURE__ */ new Set();
}
function invalidatePermissionCache() {
  permissionCache = null;
}
async function createSession(userId, req) {
  const token = randomToken();
  const hash = sha256(token);
  const now = /* @__PURE__ */ new Date();
  const expires = new Date(now.getTime() + config.sessionTtlDays * 24 * 60 * 60 * 1e3);
  await run(
    "INSERT INTO sessions (id, user_id, ip, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [hash, userId, req.ip ?? null, (req.headers["user-agent"] ?? "").slice(0, 300) || null, now.toISOString(), expires.toISOString()]
  );
  return { token, expiresAt: expires.toISOString() };
}
async function revokeSession(token) {
  await run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [await nowISO(), sha256(token)]);
}
async function revokeAllSessions(userId) {
  await run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [await nowISO(), userId]);
}
function setSessionCookie(res, token) {
  res.append(
    "Set-Cookie",
    serializeCookie(config.sessionCookieName, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/",
      maxAge: config.sessionTtlDays * 24 * 60 * 60
    })
  );
}
function clearSessionCookie(res) {
  res.append(
    "Set-Cookie",
    serializeCookie(config.sessionCookieName, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/",
      maxAge: 0
    })
  );
}
var sessionLoader = async (req, _res, next) => {
  try {
    const cookies = parseCookie(req.headers.cookie ?? "");
    const token = cookies[config.sessionCookieName];
    if (!token) return next();
    const session = await get("SELECT id, user_id, created_at, expires_at, revoked_at FROM sessions WHERE id = ?", [
      sha256(token)
    ]);
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) return next();
    const absoluteMax = new Date(session.created_at).getTime() + config.sessionAbsoluteTtlDays * 24 * 60 * 60 * 1e3;
    if (absoluteMax <= Date.now()) {
      await run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [await nowISO(), session.id]);
      return next();
    }
    const user = await get(
      `SELECT u.id, u.name, u.email, u.phone, u.status, u.role_id, u.last_login_at, u.created_at, r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      [session.user_id]
    );
    if (!user) return next();
    if (user.status !== "ACTIVE") {
      req.blockedReason = user.status;
      return next();
    }
    const permissions = Array.from(await rolePermissions(user.role_id));
    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role_code,
      status: user.status,
      last_login_at: user.last_login_at,
      created_at: user.created_at,
      permissions
    };
    req.sessionId = session.id;
    const remaining = new Date(session.expires_at).getTime() - Date.now();
    if (remaining < config.sessionTtlDays * 24 * 60 * 60 * 1e3 / 2) {
      const expires = Math.min(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1e3, absoluteMax);
      await run("UPDATE sessions SET expires_at = ? WHERE id = ?", [new Date(expires).toISOString(), session.id]);
    }
    next();
  } catch (err) {
    next(err);
  }
};
var requireAuth = (req, _res, next) => {
  if (req.user) return next();
  const blocked = req.blockedReason;
  if (blocked === "INACTIVE" || blocked === "SUSPENDED") {
    return next(unauthorized("This account has been disabled. Contact the administrator."));
  }
  return next(unauthorized());
};
function requirePermission(code) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!req.user.permissions.includes(code)) {
      return next(forbidden("Your account does not have permission to perform this action."));
    }
    next();
  };
}
function currentUser(req) {
  if (!req.user) throw unauthorized();
  return req.user;
}
function can(req, code) {
  return Boolean(req.user?.permissions.includes(code));
}
var originGuard = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  const host = req.headers.host;
  if (!host) return next();
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return next(forbidden("Cross-origin request blocked."));
  }
  if (originUrl.host === host) return next();
  let hostName;
  try {
    hostName = new URL(`http://${host}`).hostname;
  } catch {
    hostName = host.split(":")[0];
  }
  const originName = originUrl.hostname;
  const loopback = (name) => name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "[::1]";
  if (originName === hostName || loopback(originName) && loopback(hostName)) return next();
  return next(forbidden("Cross-origin request blocked."));
};

// src/middleware/error.ts
init_errors();
init_config();

// src/services/audit.ts
init_database();
async function audit(req, action, entity, entityId, metadata = {}) {
  try {
    await run(
      "INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        req?.user?.id ?? null,
        action,
        entity,
        entityId === null || entityId === void 0 ? null : String(entityId),
        JSON.stringify(metadata),
        req?.ip ?? null,
        (/* @__PURE__ */ new Date()).toISOString()
      ]
    );
  } catch (err) {
    console.error("[audit] failed to write audit log", err);
  }
}
async function auditAs(userId, action, entity, entityId, metadata = {}, ip) {
  await run(
    "INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [userId, action, entity, entityId === null ? null : String(entityId), JSON.stringify(metadata), ip ?? null, (/* @__PURE__ */ new Date()).toISOString()]
  );
}

// src/middleware/error.ts
function notFoundHandler(req, _res, next) {
  const path5 = String(req.originalUrl ?? "").split("?")[0].slice(0, 200);
  next(new HttpError(404, "NOT_FOUND", `Route ${req.method} ${path5} not found`));
}
async function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    if (err.status >= 500) console.error("[error]", err);
    const message = err.status >= 500 && config.isProduction ? "Something went wrong. Please try again." : err.message;
    res.status(err.status).json({ error: { code: err.code, message, details: err.status < 500 ? err.details : void 0 } });
    return;
  }
  const anyErr = err;
  if (anyErr?.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Malformed JSON body" } });
    return;
  }
  console.error("[unhandled]", anyErr);
  try {
    await audit(req, "REQUEST_FAILED", "system", String(req.originalUrl).slice(0, 100), {
      message: String(anyErr?.message ?? "Unknown error").slice(0, 300)
    });
  } catch {
  }
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: config.isProduction ? "Something went wrong. Please try again." : String(anyErr?.message ?? err)
    }
  });
}

// src/modules/auth/auth.routes.ts
init_config();
init_database();
init_errors();
import { Router } from "express";
import rateLimit from "express-rate-limit";
import crypto2 from "node:crypto";
import { z } from "zod";

// src/lib/http.ts
init_errors();
function ok(res, data) {
  res.json({ data });
}
function created(res, data) {
  res.status(201).json({ data });
}
function list(res, rows, meta2) {
  res.json({
    data: rows,
    meta: meta2 ?? { page: 1, limit: rows.length || 1, total: rows.length, total_pages: 1 }
  });
}
function meta(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest("Validation failed", formatZodError(result.error));
  }
  return result.data;
}
function formatZodError(error) {
  return error.issues.map((i) => ({ field: i.path.join(".") || "(body)", message: i.message }));
}
function pagination(query2, defaultLimit = 20, maxLimit = 100) {
  const q = query2 ?? {};
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(q.limit) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}
function buildMeta(page, limit, total) {
  return { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) };
}
function toArray(value) {
  if (value === void 0 || value === null || value === "") return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}
function toInt(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : void 0;
}

// src/services/notify.ts
init_database();
async function notify(input) {
  try {
    await run(
      "INSERT INTO notifications (user_id, type, title, body, entity, entity_id, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        input.userId,
        input.type,
        input.title,
        input.body ?? null,
        input.entity ?? null,
        input.entityId ?? null,
        input.link ?? null,
        await nowISO()
      ]
    );
  } catch (err) {
    console.error("[notify] failed", err);
  }
}

// src/services/communications.ts
init_database();

// src/services/settings.ts
init_database();
async function readSetting(key, fallback) {
  const row = await get("SELECT value FROM settings WHERE setting_key = ?", [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}
async function writeSetting(key, value) {
  await run(
    `INSERT INTO settings (setting_key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), await nowISO()]
  );
}
var ASSIGNMENT_FALLBACK = {
  strategy: "MANUAL",
  auto_assign_new: false,
  destination_rules: []
};
async function assignmentConfig() {
  const raw4 = await readSetting("assignment", null);
  if (!raw4) return { ...ASSIGNMENT_FALLBACK, destination_rules: [] };
  return {
    strategy: raw4.strategy ?? "MANUAL",
    auto_assign_new: Boolean(raw4.auto_assign_new),
    destination_rules: Array.isArray(raw4.destination_rules) ? raw4.destination_rules : []
  };
}
async function callPolicy() {
  const raw4 = await readSetting("call_policy", null);
  return {
    recording_mode: raw4?.recording_mode ?? "PROVIDER_DEFAULT",
    consent_notice: raw4?.consent_notice ?? "",
    retention_days: Number(raw4?.retention_days ?? 0) || 0
  };
}
async function telephonyConfig() {
  const raw4 = await readSetting("telephony", null);
  return {
    provider: raw4?.provider ?? "none",
    base_url: String(raw4?.base_url ?? "").trim(),
    auth_env: raw4?.auth_env ?? "TELEPHONY_API_KEY",
    initiate_path: raw4?.initiate_path ?? "/calls",
    recording_path: raw4?.recording_path ?? "/calls/{id}/recording"
  };
}
async function channelConfig(channel) {
  const all_ = await readSetting("communication_providers", {});
  const raw4 = all_?.[channel.toLowerCase()] ?? {};
  return {
    provider: raw4.provider ?? "none",
    base_url: String(raw4.base_url ?? "").trim(),
    auth_env: raw4.auth_env ?? ""
  };
}
async function aiConfig() {
  const raw4 = await readSetting("ai", null);
  return {
    provider: raw4?.provider ?? "none",
    base_url: String(raw4?.base_url ?? "").trim(),
    model: raw4?.model ?? "",
    auth_env: raw4?.auth_env ?? "AI_API_KEY",
    enabled: Boolean(raw4?.enabled)
  };
}
async function retentionConfig() {
  const raw4 = await readSetting("retention", null);
  return {
    call_recordings_days: Number(raw4?.call_recordings_days ?? 0) || 0,
    communications_days: Number(raw4?.communications_days ?? 0) || 0,
    documents_days: Number(raw4?.documents_days ?? 0) || 0,
    audit_logs_days: Number(raw4?.audit_logs_days ?? 0) || 0
  };
}
async function reminderConfig() {
  const raw4 = await readSetting("reminders", null);
  return { enabled: raw4?.enabled !== false, overdue_enabled: raw4?.overdue_enabled !== false };
}

// src/services/communications.ts
function providerSecret(cfg) {
  return cfg.auth_env ? process.env[cfg.auth_env] : void 0;
}
async function sendCommunication(input) {
  const cfg = await channelConfig(input.channel);
  const now = await nowISO();
  const insert = await run(
    `INSERT INTO communications
       (channel, direction, provider, sender_id, recipient, customer_id, lead_id, worker_id, subject, body, status, created_at, updated_at)
     VALUES (?, 'OUTBOUND', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.channel,
      cfg.provider,
      input.senderId ?? null,
      input.recipient,
      input.customerId ?? null,
      input.leadId ?? null,
      input.workerId ?? null,
      input.subject ?? null,
      input.body,
      cfg.provider === "none" || !cfg.base_url ? "NOT_CONFIGURED" : "QUEUED",
      now,
      now
    ]
  );
  const id = insert.lastInsertRowid;
  if (cfg.provider === "none" || !cfg.base_url) {
    return { id, status: "NOT_CONFIGURED", configured: false, provider: cfg.provider, error: "Integration Not Configured" };
  }
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  const secret = providerSecret(cfg);
  if (secret) headers.Authorization = `Bearer ${secret}`;
  void (async () => {
    try {
      const res = await fetch(cfg.base_url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          channel: input.channel.toLowerCase(),
          to: input.recipient,
          subject: input.subject ?? null,
          body: input.body,
          lead_id: input.leadId ?? null,
          customer_id: input.customerId ?? null,
          message_id: id
        }),
        signal: AbortSignal.timeout(15e3)
      });
      const text = await res.text().catch(() => "");
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
      }
      const providerMessageId = body?.id ?? body?.message_id ?? null;
      if (res.ok) {
        await run("UPDATE communications SET status = ?, provider_message_id = ?, sent_at = ?, updated_at = ? WHERE id = ?", [
          "SENT",
          providerMessageId ? String(providerMessageId) : null,
          await nowISO(),
          await nowISO(),
          id
        ]);
      } else {
        await run("UPDATE communications SET status = ?, error = ?, updated_at = ? WHERE id = ?", [
          "FAILED",
          `Provider rejected the message (HTTP ${res.status}).`,
          await nowISO(),
          id
        ]);
      }
    } catch (err) {
      await run("UPDATE communications SET status = ?, error = ?, updated_at = ? WHERE id = ?", [
        "FAILED",
        `Provider unreachable: ${err.message}`.slice(0, 300),
        await nowISO(),
        id
      ]);
    }
  })();
  return { id, status: "QUEUED", configured: true, provider: cfg.provider, error: null };
}
async function channelStatus(channel) {
  const cfg = await channelConfig(channel);
  return {
    configured: cfg.provider !== "none" && Boolean(cfg.base_url),
    provider: cfg.provider,
    base_url: cfg.base_url,
    secret_present: Boolean(providerSecret(cfg))
  };
}

// src/modules/auth/auth.routes.ts
var authRouter = Router();
var loginGuards = config.isTest ? [] : [
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.loginMax,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    message: {
      error: { code: "RATE_LIMITED", message: "Too many login attempts. Please try again later." }
    }
  })
];
var loginSchema = z.object({
  identifier: z.string().trim().min(1, "Email or username is required").max(200),
  password: z.string().min(1, "Password is required").max(200)
});
var newPasswordField = z.string().min(8, "New password must be at least 8 characters").max(200).regex(/[A-Za-z]/, "Must contain a letter").regex(/[0-9]/, "Must contain a number");
var passwordSchema = z.object({
  current_password: z.string().min(1, "Current password is required").max(200),
  new_password: newPasswordField
});
var forgotSchema = z.object({
  identifier: z.string().trim().min(1, "Email or username is required").max(200)
});
var resetSchema = z.object({
  token: z.string().trim().min(16, "Reset link is invalid").max(200),
  new_password: newPasswordField
});
function sha2562(value) {
  return crypto2.createHash("sha256").update(value).digest("hex");
}
function maskIdentifier(value) {
  const s = String(value ?? "");
  if (s.length <= 2) return "***";
  const at = s.indexOf("@");
  if (at > 0) return `${s.slice(0, 2)}***${s.slice(at)}`;
  return `${s.slice(0, 2)}***`;
}
function publicUser(user, permissions) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    username: user.username,
    role: user.role_code,
    status: user.status,
    created_at: user.created_at,
    permissions
  };
}
authRouter.post("/login", ...loginGuards, async (req, res, next) => {
  try {
    const body = meta(loginSchema, req.body);
    const identifier = body.identifier.toLowerCase();
    const masked = maskIdentifier(identifier);
    const user = await get(
      `SELECT u.id, u.name, u.email, u.phone, u.username, u.password_hash, u.status, u.role_id, u.created_at,
              u.failed_login_count, u.locked_until,
              r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE (lower(u.email) = ? OR lower(u.username) = ?) AND u.deleted_at IS NULL`,
      [identifier, identifier]
    );
    if (user && user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      await audit(req, "LOGIN_LOCKED_OUT", "user", user.id, { locked_until: user.locked_until });
      throw unauthorized("Too many failed login attempts. Please try again later.");
    }
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      if (user) {
        const attempts = (user.failed_login_count ?? 0) + 1;
        const lock = attempts >= config.loginLockout.maxAttempts;
        await run(
          "UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?",
          [
            attempts,
            lock ? new Date(Date.now() + config.loginLockout.minutes * 6e4).toISOString() : user.locked_until,
            await nowISO(),
            user.id
          ]
        );
        await audit(req, "LOGIN_FAILED", "user", user.id, {
          identifier: masked,
          attempts,
          locked: lock
        });
      } else {
        await audit(req, "LOGIN_FAILED", "user", null, { identifier: masked });
      }
      throw unauthorized("Invalid email/username or password.");
    }
    if (user.status !== "ACTIVE") {
      await audit(req, "LOGIN_BLOCKED", "user", user.id, { status: user.status });
      throw unauthorized("This account has been disabled. Contact the administrator.");
    }
    const permissions = (await all(
      `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
      [user.role_id]
    )).map((r) => r.code);
    const { token } = await createSession(user.id, req);
    setSessionCookie(res, token);
    await run(
      "UPDATE users SET last_login_at = ?, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
      [await nowISO(), await nowISO(), user.id]
    );
    await audit(req, "LOGIN_SUCCESS", "user", user.id, { role: user.role_code });
    ok(res, publicUser(user, permissions));
  } catch (err) {
    next(err);
  }
});
authRouter.post("/password/forgot", ...loginGuards, async (req, res, next) => {
  try {
    const body = meta(forgotSchema, req.body);
    const identifier = body.identifier.toLowerCase();
    const user = await get(
      `SELECT id, email, name FROM users
       WHERE (lower(email) = ? OR lower(username) = ?) AND deleted_at IS NULL AND status = 'ACTIVE'`,
      [identifier, identifier]
    );
    if (user) {
      const token = crypto2.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + config.passwordResetTtlMinutes * 6e4).toISOString();
      await run(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [user.id, sha2562(token), expiresAt, req.ip ?? null, await nowISO()]
      );
      const origin = `${req.protocol}://${req.get("host") ?? ""}`;
      const link = `${origin}/reset-password?token=${token}`;
      const minutes = config.passwordResetTtlMinutes;
      await sendCommunication({
        channel: "EMAIL",
        recipient: user.email,
        subject: "Reset your CRM password",
        body: `A password reset was requested for your account. The link is valid for ${minutes} minutes:

${link}

If you did not request this, you can ignore this message.`,
        workerId: user.id
      });
      await notify({
        userId: user.id,
        type: "PASSWORD_RESET",
        title: "Password reset requested",
        body: `A reset link was created. It is valid for ${minutes} minutes.`,
        link: `/reset-password?token=${token}`
      });
      await audit(req, "PASSWORD_RESET_REQUESTED", "user", user.id, {});
    } else {
      await audit(req, "PASSWORD_RESET_REQUESTED", "user", null, { known: false });
    }
    ok(res, { requested: true });
  } catch (err) {
    next(err);
  }
});
authRouter.post("/password/reset", ...loginGuards, async (req, res, next) => {
  try {
    const body = meta(resetSchema, req.body);
    const row = await get(
      "SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?",
      [sha2562(body.token)]
    );
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) {
      throw badRequest("This reset link is invalid or has expired.");
    }
    const now = await nowISO();
    await run("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?", [now, row.id]);
    await run("UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?", [
      hashPassword(body.new_password),
      now,
      row.user_id
    ]);
    await revokeAllSessions(row.user_id);
    await audit(req, "PASSWORD_RESET_COMPLETED", "user", row.user_id, {});
    await notify({
      userId: row.user_id,
      type: "PASSWORD_RESET",
      title: "Password was reset",
      body: "Your password was changed and all sessions were signed out. If this was not you, contact the administrator."
    });
    ok(res, { reset: true });
  } catch (err) {
    next(err);
  }
});
authRouter.post("/logout", async (req, res, next) => {
  try {
    const cookies = (req.headers.cookie ?? "").split(";").map((s) => s.trim());
    const raw4 = cookies.find((c) => c.startsWith(`${config.sessionCookieName}=`));
    if (raw4) await revokeSession(decodeURIComponent(raw4.slice(config.sessionCookieName.length + 1)));
    clearSessionCookie(res);
    if (req.user) await audit(req, "LOGOUT", "user", req.user.id, {});
    ok(res, { logged_out: true });
  } catch (err) {
    next(err);
  }
});
authRouter.get("/me", requireAuth, (req, res, next) => {
  try {
    const user = currentUser(req);
    ok(res, user);
  } catch (err) {
    next(err);
  }
});
authRouter.patch("/password", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = meta(passwordSchema, req.body);
    const row = await get("SELECT password_hash FROM users WHERE id = ?", [user.id]);
    if (!row || !verifyPassword(body.current_password, row.password_hash)) {
      throw badRequest("Current password is incorrect.");
    }
    await run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
      hashPassword(body.new_password),
      await nowISO(),
      user.id
    ]);
    await revokeAllSessions(user.id);
    const { token } = await createSession(user.id, req);
    setSessionCookie(res, token);
    await audit(req, "PASSWORD_CHANGED", "user", user.id, {});
    ok(res, { updated: true });
  } catch (err) {
    next(err);
  }
});

// src/modules/users/users.routes.ts
init_database();
init_errors();
import { Router as Router2 } from "express";
import { z as z2 } from "zod";

// src/lib/dates.ts
init_config();
function businessTimezone() {
  return config.businessTimezone;
}
function tzOffsetMs(tz, date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return asUTC - Math.floor(date.getTime() / 1e3) * 1e3;
}
function todayStr(tz = businessTimezone(), at = /* @__PURE__ */ new Date()) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return dtf.format(at);
}
function addDays(dateStr2, days) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr2) ? /* @__PURE__ */ new Date(`${dateStr2}T00:00:00Z`) : new Date(dateStr2);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function startOfDayIso(dateStr2, tz = businessTimezone()) {
  const guess = /* @__PURE__ */ new Date(`${dateStr2}T00:00:00Z`);
  const offset = tzOffsetMs(tz, guess);
  let iso = new Date(guess.getTime() - offset).toISOString();
  const offset2 = tzOffsetMs(tz, new Date(iso));
  if (offset2 !== offset) iso = new Date(guess.getTime() - offset2).toISOString();
  return iso;
}
function endOfDayIso(dateStr2, tz = businessTimezone()) {
  const next = addDays(dateStr2, 1);
  return startOfDayIso(next, tz);
}
function resolvePeriod(period, fromInput, toInput, tz = businessTimezone()) {
  const today = todayStr(tz);
  switch (period) {
    case "today":
      return { from: startOfDayIso(today, tz), to: endOfDayIso(today, tz) };
    case "yesterday":
      return { from: startOfDayIso(addDays(today, -1), tz), to: endOfDayIso(addDays(today, -1), tz) };
    case "7d":
      return { from: startOfDayIso(addDays(today, -6), tz), to: endOfDayIso(today, tz) };
    case "30d":
      return { from: startOfDayIso(addDays(today, -29), tz), to: endOfDayIso(today, tz) };
    case "month":
      return { from: startOfDayIso(`${today.slice(0, 7)}-01`, tz), to: endOfDayIso(today, tz) };
    case "custom": {
      const out = {};
      if (fromInput) out.from = startOfDayIso(fromInput, tz);
      if (toInput) out.to = endOfDayIso(toInput, tz);
      return out;
    }
    default:
      return {};
  }
}
function sqlLocalDate(column, tz = businessTimezone()) {
  const offsetMin = tzOffsetMs(tz, /* @__PURE__ */ new Date()) / 6e4;
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = Math.round(abs % 60);
  const sign = offsetMin < 0 ? "-" : "+";
  const mods = [];
  if (h) mods.push(`'${sign}${h} hours'`);
  if (m) mods.push(`'${sign}${m} minutes'`);
  if (mods.length === 0) mods.push(`'+0 minutes'`);
  return `date(substr(${column}, 1, 19), ${mods.join(", ")})`;
}
function resolvePeriodDates(period, fromInput, toInput, tz = businessTimezone()) {
  const today = todayStr(tz);
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "custom": {
      const out = {};
      if (fromInput) out.from = fromInput;
      if (toInput) out.to = toInput;
      return out;
    }
    default:
      return { from: fromInput, to: toInput };
  }
}

// src/modules/users/users.routes.ts
var usersRouter = Router2();
var WORKER_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED"];
var createSchema = z2.object({
  name: z2.string().trim().min(2, "Name must be at least 2 characters").max(120),
  email: z2.string().trim().email("Valid email is required").max(200),
  phone: z2.string().trim().max(30).optional().nullable(),
  username: z2.string().trim().min(3, "Username must be at least 3 characters").max(60).regex(/^[a-zA-Z0-9._-]+$/, "Username may contain letters, numbers, dot, underscore and hyphen").optional().nullable(),
  password: z2.string().min(8, "Password must be at least 8 characters").max(200).regex(/[A-Za-z]/, "Password must contain a letter").regex(/[0-9]/, "Password must contain a number"),
  role: z2.enum(["ADMIN", "WORKER"]).default("WORKER"),
  status: z2.enum(WORKER_STATUSES).default("ACTIVE")
});
var updateSchema = createSchema.omit({ password: true }).partial().extend({ password: z2.string().min(8).max(200).optional() });
var statusSchema = z2.object({ status: z2.enum(WORKER_STATUSES) });
async function assertUnique(user, excludeId) {
  const emailRow = await get(
    "SELECT id FROM users WHERE lower(email) = lower(?) AND deleted_at IS NULL",
    [user.email]
  );
  if (emailRow && emailRow.id !== excludeId) throw conflict("A worker with this email already exists.");
  if (user.username) {
    const usernameRow = await get(
      "SELECT id FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL",
      [user.username]
    );
    if (usernameRow && usernameRow.id !== excludeId) throw conflict("A worker with this username already exists.");
  }
}
function shape(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    username: row.username,
    role: row.role_code,
    status: row.status,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lead_count: Number(row.lead_count ?? 0),
    open_lead_count: Number(row.open_lead_count ?? 0)
  };
}
usersRouter.get("/", requireAuth, requirePermission("users:manage"), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query);
    const search = String(req.query.search ?? "").trim();
    const status = toArray(req.query.status);
    const role = toArray(req.query.role);
    const where = ["u.deleted_at IS NULL"];
    const params = [];
    if (search) {
      where.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')");
      const term = await likeTerm(search);
      params.push(term, term, term, term);
    }
    if (status.length) {
      where.push(`u.status IN (${status.map(() => "?").join(",")})`);
      params.push(...status);
    }
    if (role.length) {
      where.push(`r.code IN (${role.map(() => "?").join(",")})`);
      params.push(...role);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(
      `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id ${whereSql}`,
      params
    )).c;
    const rows = await all(
      `SELECT u.id, u.name, u.email, u.phone, u.username, u.status, u.last_login_at, u.created_at, u.updated_at,
              r.code AS role_code,
              (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.deleted_at IS NULL) AS lead_count,
              (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
                WHERE l.assigned_to = u.id AND l.deleted_at IS NULL AND s.category = 'OPEN') AS open_lead_count
       FROM users u JOIN roles r ON r.id = u.role_id
       ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    list(res, rows.map(shape), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
usersRouter.post("/", requireAuth, requirePermission("users:manage"), async (req, res, next) => {
  try {
    const body = meta(createSchema, req.body);
    await assertUnique(body);
    const role = await get("SELECT id FROM roles WHERE code = ?", [body.role]);
    if (!role) throw badRequest("Unknown role.");
    const now = await nowISO();
    const result = await tx(async () => {
      const inserted = await run(
        `INSERT INTO users (name, email, phone, username, password_hash, role_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          body.name,
          body.email.toLowerCase(),
          body.phone ?? null,
          body.username?.toLowerCase() ?? null,
          hashPassword(body.password),
          role.id,
          body.status,
          now,
          now
        ]
      );
      return inserted.lastInsertRowid;
    });
    await audit(req, "WORKER_CREATED", "user", result, {
      name: body.name,
      email: body.email,
      role: body.role,
      status: body.status
    });
    const row = await get(`SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [
      result
    ]);
    created(res, shape(row));
  } catch (err) {
    next(err);
  }
});
usersRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const id = Number(req.params.id);
    if (user.role !== "ADMIN" && user.id !== id) throw forbidden();
    const row = await get(
      `SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.deleted_at IS NULL`,
      [id]
    );
    if (!row) throw notFound("Worker not found.");
    const today = todayStr();
    const workload = await get(
      `SELECT
        (SELECT COUNT(*) FROM leads WHERE assigned_to = ? AND deleted_at IS NULL) AS total,
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
          WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category = 'OPEN') AS open,
        (SELECT COUNT(*) FROM follow_ups WHERE worker_id = ? AND deleted_at IS NULL AND scheduled_date = ?
          AND status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')) AS today_fu,
        (SELECT COUNT(*) FROM follow_ups WHERE worker_id = ? AND deleted_at IS NULL AND scheduled_date < ?
          AND status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')) AS overdue_fu`,
      [id, id, id, today, id, today]
    );
    ok(res, { ...shape(row), permissions: row.role_code === "ADMIN" ? ["*"] : [], workload });
  } catch (err) {
    next(err);
  }
});
usersRouter.patch("/:id", requireAuth, requirePermission("users:manage"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await get("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!existing) throw notFound("Worker not found.");
    const body = meta(updateSchema, req.body);
    await assertUnique(
      {
        email: body.email ?? existing.email,
        username: body.username !== void 0 ? body.username : existing.username
      },
      id
    );
    const now = await nowISO();
    let roleId = existing.role_id;
    if (body.role) {
      const role = await get("SELECT id FROM roles WHERE code = ?", [body.role]);
      if (!role) throw badRequest("Unknown role.");
      roleId = role.id;
    }
    const nextStatus = body.status ?? existing.status;
    await run(
      `UPDATE users SET name = ?, email = ?, phone = ?, username = ?, role_id = ?, status = ?,
        password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?`,
      [
        body.name ?? existing.name,
        (body.email ?? existing.email).toLowerCase(),
        body.phone !== void 0 ? body.phone : existing.phone,
        body.username !== void 0 ? body.username ? body.username.toLowerCase() : null : existing.username,
        roleId,
        nextStatus,
        body.password ? hashPassword(body.password) : null,
        now,
        id
      ]
    );
    if (nextStatus !== "ACTIVE" || body.password || roleId !== existing.role_id) {
      await revokeAllSessions(id);
    }
    await audit(req, "WORKER_UPDATED", "user", id, {
      changed: Object.keys(body),
      status: nextStatus,
      role: body.role ?? existing.role_code
    });
    const row = await get(`SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [id]);
    ok(res, shape(row));
  } catch (err) {
    next(err);
  }
});
usersRouter.patch("/:id/status", requireAuth, requirePermission("users:manage"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = meta(statusSchema, req.body);
    const existing = await get("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!existing) throw notFound("Worker not found.");
    if (existing.id === currentUser(req).id && body.status !== "ACTIVE") {
      throw badRequest("You cannot disable your own account.");
    }
    await run("UPDATE users SET status = ?, updated_at = ? WHERE id = ?", [body.status, await nowISO(), id]);
    if (body.status !== "ACTIVE") await revokeAllSessions(id);
    await audit(req, "WORKER_STATUS_CHANGED", "user", id, { from: existing.status, to: body.status });
    const row = await get(`SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, [id]);
    ok(res, shape(row));
  } catch (err) {
    next(err);
  }
});
usersRouter.get("/:id/activity", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const id = Number(req.params.id);
    if (user.role !== "ADMIN" && user.id !== id) throw forbidden();
    const limit = Math.min(100, Number(req.query.limit) || 30);
    const rows = await all(
      `SELECT t.id, t.type, t.summary, t.metadata, t.created_at, t.lead_id, l.lead_number,
              c.name AS customer_name, l.destination
       FROM lead_timeline t
       JOIN leads l ON l.id = t.lead_id
       JOIN customers c ON c.id = l.customer_id
       WHERE t.actor_id = ? AND l.deleted_at IS NULL
       ORDER BY t.created_at DESC
       LIMIT ?`,
      [id, limit]
    );
    list(
      res,
      rows.map((r) => ({
        ...r,
        metadata: safeJson(r.metadata, {})
      })),
      buildMeta(1, rows.length, rows.length)
    );
  } catch (err) {
    next(err);
  }
});
function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// src/modules/customers/customers.routes.ts
init_database();
init_errors();
import { Router as Router3 } from "express";
import { z as z3 } from "zod";
var customersRouter = Router3();
var customerSchema = z3.object({
  name: z3.string().trim().min(2, "Name must be at least 2 characters").max(150),
  phone: z3.string().trim().max(30).optional().nullable(),
  whatsapp: z3.string().trim().max(30).optional().nullable(),
  email: z3.string().trim().email("Valid email required").max(200).optional().nullable().or(z3.literal("").transform(() => null)),
  city: z3.string().trim().max(100).optional().nullable(),
  state: z3.string().trim().max(100).optional().nullable(),
  country: z3.string().trim().max(100).optional().nullable(),
  notes: z3.string().trim().max(4e3).optional().nullable(),
  allow_duplicate: z3.boolean().optional()
});
var updateSchema2 = customerSchema.partial();
function shape2(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    whatsapp: row.whatsapp,
    email: row.email,
    city: row.city,
    state: row.state,
    country: row.country,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lead_count: Number(row.lead_count ?? 0),
    last_lead_at: row.last_lead_at ?? null
  };
}
function duplicateWhere(field, value) {
  if (!value) return null;
  if (field === "email") return { sql: "lower(c.email) = lower(?)", value };
  if (field === "phone" || field === "whatsapp") {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 6) return null;
    const tail = digits.slice(-8);
    return { sql: `(replace(replace(replace(replace(coalesce(c.${field},''), '-',''), ' ',''), '+',''), '.', '') LIKE ?)`, value: `%${tail}` };
  }
  return null;
}
async function findDuplicates(input, excludeId) {
  const clauses = [];
  const params = [];
  for (const field of ["phone", "whatsapp", "email"]) {
    const match = duplicateWhere(field, input[field] ?? "");
    if (match) {
      clauses.push(match.sql);
      params.push(match.value);
    }
  }
  if (!clauses.length) return [];
  let sql = `SELECT c.id, c.name, c.phone, c.whatsapp, c.email, c.city, c.created_at,
      (SELECT COUNT(*) FROM leads l WHERE l.customer_id = c.id AND l.deleted_at IS NULL) AS lead_count
     FROM customers c
     WHERE c.deleted_at IS NULL AND (${clauses.join(" OR ")})`;
  if (excludeId) {
    sql += " AND c.id <> ?";
    params.push(excludeId);
  }
  return await all(sql, params);
}
customersRouter.get("/check-duplicate", requireAuth, async (req, res, next) => {
  try {
    if (!can(req, "customers:manage") && !can(req, "leads:create")) throw forbidden();
    const excludeId = req.query.exclude_id ? Number(req.query.exclude_id) : void 0;
    const matches = await findDuplicates(
      {
        phone: String(req.query.phone ?? ""),
        whatsapp: String(req.query.whatsapp ?? ""),
        email: String(req.query.email ?? "")
      },
      excludeId
    );
    await audit(req, "CUSTOMER_DUPLICATE_CHECKED", "customer", excludeId ?? null, { matches: matches.length });
    ok(res, { duplicates: matches, is_duplicate: matches.length > 0 });
  } catch (err) {
    next(err);
  }
});
customersRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const { page, limit, offset } = pagination(req.query);
    const search = String(req.query.search ?? "").trim();
    const sort = String(req.query.sort ?? "recent");
    const readAll = can(req, "customers:read_all");
    if (!readAll && !can(req, "customers:read_own")) throw forbidden();
    const where = ["c.deleted_at IS NULL"];
    const params = [];
    if (!readAll) {
      where.push("c.id IN (SELECT l.customer_id FROM leads l WHERE l.assigned_to = ? AND l.deleted_at IS NULL)");
      params.push(user.id);
    }
    if (search) {
      where.push(
        `(c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR c.whatsapp LIKE ? ESCAPE '\\'
          OR c.email LIKE ? ESCAPE '\\' OR c.city LIKE ? ESCAPE '\\')`
      );
      const term = await likeTerm(search);
      params.push(term, term, term, term, term);
    }
    const selected = toArray(req.query.selected);
    if (selected.length) {
      where.push(`c.id IN (${selected.map(() => "?").join(",")})`);
      params.push(...selected.map(Number));
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(`SELECT COUNT(*) AS c FROM customers c ${whereSql}`, params)).c;
    const order = sort === "name" ? "c.name COLLATE NOCASE ASC" : sort === "oldest" ? "c.created_at ASC" : "c.created_at DESC";
    const rows = await all(
      `SELECT c.*,
              (SELECT COUNT(*) FROM leads l WHERE l.customer_id = c.id AND l.deleted_at IS NULL) AS lead_count,
              (SELECT MAX(l.created_at) FROM leads l WHERE l.customer_id = c.id AND l.deleted_at IS NULL) AS last_lead_at
       FROM customers c ${whereSql}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    list(res, rows.map(shape2), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
customersRouter.post("/", requireAuth, requirePermission("customers:manage"), async (req, res, next) => {
  try {
    const body = meta(customerSchema, req.body);
    const duplicates = await findDuplicates(body);
    if (duplicates.length && !body.allow_duplicate) {
      throw conflict("Possible duplicate customer found.", { duplicates });
    }
    const now = await nowISO();
    const id = (await run(
      `INSERT INTO customers (name, phone, whatsapp, email, city, state, country, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.name,
        body.phone ?? null,
        body.whatsapp ?? body.phone ?? null,
        body.email ?? null,
        body.city ?? null,
        body.state ?? null,
        body.country ?? null,
        body.notes ?? null,
        currentUser(req).id,
        now,
        now
      ]
    )).lastInsertRowid;
    await audit(req, "CUSTOMER_CREATED", "customer", id, { name: body.name, duplicates: duplicates.length });
    const row = await get("SELECT * FROM customers WHERE id = ?", [id]);
    created(res, shape2({ ...row, lead_count: 0 }));
  } catch (err) {
    next(err);
  }
});
customersRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!row) throw notFound("Customer not found.");
    const readAll = can(req, "customers:read_all");
    const leads = await all(
      `SELECT l.id, l.lead_number, l.destination, l.travel_type, l.trip_type, l.priority, l.budget, l.currency,
              l.created_at, l.next_follow_up_at, s.code AS status_code, s.name AS status_name, s.category AS status_category,
              s.color AS status_color, u.name AS assignee_name, l.assigned_to
       FROM leads l
       JOIN lead_statuses s ON s.id = l.status_id
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.customer_id = ? AND l.deleted_at IS NULL
         ${readAll ? "" : "AND l.assigned_to = ?"}
       ORDER BY l.created_at DESC`,
      readAll ? [id] : [id, user.id]
    );
    if (!readAll && leads.length === 0) {
      const owned = await get("SELECT 1 FROM leads WHERE customer_id = ? AND assigned_to = ? AND deleted_at IS NULL", [
        id,
        user.id
      ]);
      if (!owned) throw forbidden("You do not have access to this customer.");
    }
    ok(res, {
      ...shape2({ ...row, lead_count: leads.length }),
      leads: leads.map((l) => ({
        id: l.id,
        lead_number: l.lead_number,
        destination: l.destination,
        travel_type: l.travel_type,
        trip_type: l.trip_type,
        priority: l.priority,
        budget: l.budget,
        currency: l.currency,
        created_at: l.created_at,
        next_follow_up_at: l.next_follow_up_at,
        status: {
          code: l.status_code,
          name: l.status_name,
          category: l.status_category,
          color: l.status_color
        },
        assignee: l.assigned_to ? { id: l.assigned_to, name: l.assignee_name } : null
      })),
      duplicates: await findDuplicates(row, id)
    });
  } catch (err) {
    next(err);
  }
});
customersRouter.patch("/:id", requireAuth, requirePermission("customers:manage"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await get("SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!existing) throw notFound("Customer not found.");
    const body = meta(updateSchema2, req.body);
    const merged = {
      phone: body.phone !== void 0 ? body.phone : existing.phone,
      whatsapp: body.whatsapp !== void 0 ? body.whatsapp : existing.whatsapp,
      email: body.email !== void 0 ? body.email : existing.email
    };
    const duplicates = await findDuplicates(merged, id);
    if (duplicates.length && !body.allow_duplicate) {
      throw conflict("Possible duplicate customer found.", { duplicates });
    }
    await run(
      `UPDATE customers SET name = ?, phone = ?, whatsapp = ?, email = ?, city = ?, state = ?, country = ?, notes = ?,
        updated_at = ? WHERE id = ?`,
      [
        body.name ?? existing.name,
        merged.phone,
        merged.whatsapp,
        merged.email,
        body.city !== void 0 ? body.city : existing.city,
        body.state !== void 0 ? body.state : existing.state,
        body.country !== void 0 ? body.country : existing.country,
        body.notes !== void 0 ? body.notes : existing.notes,
        await nowISO(),
        id
      ]
    );
    await audit(req, "CUSTOMER_UPDATED", "customer", id, { changed: Object.keys(body) });
    const row = await get("SELECT * FROM customers WHERE id = ?", [id]);
    ok(res, shape2({ ...row, lead_count: Number((await get("SELECT COUNT(*) AS c FROM leads WHERE customer_id = ? AND deleted_at IS NULL", [id]))?.c ?? 0) }));
  } catch (err) {
    next(err);
  }
});
customersRouter.post("/:id/archive", requireAuth, requirePermission("customers:manage"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await get("SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!existing) throw notFound("Customer not found.");
    const activeLeads = await get("SELECT COUNT(*) AS c FROM leads WHERE customer_id = ? AND deleted_at IS NULL", [
      id
    ]);
    if (activeLeads && activeLeads.c > 0) throw conflict("Customer has active leads and cannot be archived.");
    await run("UPDATE customers SET deleted_at = ?, updated_at = ? WHERE id = ?", [await nowISO(), await nowISO(), id]);
    await audit(req, "CUSTOMER_ARCHIVED", "customer", id, { name: existing.name });
    ok(res, { archived: true });
  } catch (err) {
    next(err);
  }
});

// src/modules/leads/leads.routes.ts
init_database();
init_errors();
import { Router as Router4 } from "express";
import { z as z4 } from "zod";

// src/services/timeline.ts
init_database();
var TIMELINE_TYPES = {
  LEAD_CREATED: "LEAD_CREATED",
  LEAD_UPDATED: "LEAD_UPDATED",
  ASSIGNED: "ASSIGNED",
  REASSIGNED: "REASSIGNED",
  UNASSIGNED: "UNASSIGNED",
  STATUS_CHANGED: "STATUS_CHANGED",
  NOTE_ADDED: "NOTE_ADDED",
  FOLLOW_UP_CREATED: "FOLLOW_UP_CREATED",
  FOLLOW_UP_UPDATED: "FOLLOW_UP_UPDATED",
  FOLLOW_UP_COMPLETED: "FOLLOW_UP_COMPLETED",
  CUSTOMER_UPDATED: "CUSTOMER_UPDATED",
  // ---- Part 2 ----
  LEAD_VIEWED: "LEAD_VIEWED",
  CALL_INITIATED: "CALL_INITIATED",
  CALL_COMPLETED: "CALL_COMPLETED",
  CALL_MISSED: "CALL_MISSED",
  CALL_LOGGED: "CALL_LOGGED",
  RECORDING_READY: "RECORDING_READY",
  RECORDING_ACCESSED: "RECORDING_ACCESSED",
  QUOTATION_CREATED: "QUOTATION_CREATED",
  QUOTATION_SENT: "QUOTATION_SENT",
  QUOTATION_STATUS_CHANGED: "QUOTATION_STATUS_CHANGED",
  QUOTATION_EXPIRED: "QUOTATION_EXPIRED",
  BOOKING_CREATED: "BOOKING_CREATED",
  BOOKING_STATUS_CHANGED: "BOOKING_STATUS_CHANGED",
  CUSTOMER_MERGED: "CUSTOMER_MERGED",
  LEAD_MERGED: "LEAD_MERGED",
  DOCUMENT_UPLOADED: "DOCUMENT_UPLOADED",
  MESSAGE_SENT: "MESSAGE_SENT",
  LEAD_IMPORTED: "LEAD_IMPORTED",
  AI_SUMMARY_GENERATED: "AI_SUMMARY_GENERATED"
};
async function addTimelineEvent(input) {
  const res = await run(
    "INSERT INTO lead_timeline (lead_id, type, actor_id, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      input.leadId,
      input.type,
      input.actorId ?? null,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
      await nowISO()
    ]
  );
  return res.lastInsertRowid;
}

// src/modules/leads/leads.service.ts
init_database();
init_errors();
var TERMINAL_FOLLOW_UP_STATUSES = ["COMPLETED", "CONVERTED", "NOT_INTERESTED", "CANCELLED"];
function effectiveFuStatus(statusCol, dateCol) {
  const today = todayStr();
  return {
    sql: `CASE WHEN ${statusCol} IN ('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED') THEN ${statusCol}
               WHEN ${dateCol} < ? THEN 'OVERDUE'
               WHEN ${dateCol} = ? THEN 'TODAY'
               ELSE ${statusCol} END`,
    params: [today, today]
  };
}
async function loadLead(leadId, req) {
  const lead = await get("SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL", [leadId]);
  if (!lead) throw notFound("Lead not found.");
  const user = req.user;
  if (!user) throw forbidden();
  const isAdmin = user.permissions.includes("leads:read_all");
  if (!isAdmin && lead.assigned_to !== user.id) {
    throw forbidden("You do not have access to this lead.");
  }
  return lead;
}
function assertLeadWriteAccess(lead, req) {
  const user = req.user;
  if (!user) throw forbidden();
  if (user.permissions.includes("leads:update")) return;
  if (user.permissions.includes("leads:update_own") && lead.assigned_to === user.id) return;
  throw forbidden("You do not have permission to modify this lead.");
}
async function nextLeadNumber() {
  const prefix = await get("SELECT value FROM settings WHERE setting_key = ?", ["lead_number_prefix"]);
  const base = safeJson2(prefix?.value, "LD");
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 7).replace("-", "");
  const pattern = `${base}-${stamp}-%`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await get(
      `SELECT COALESCE(MAX(CAST(substr(lead_number, length(?) + 1) AS INTEGER)), 0) AS n
       FROM leads WHERE lead_number LIKE ?`,
      [`${base}-${stamp}-`, pattern]
    );
    const next = (row?.n ?? 0) + 1 + attempt;
    const candidate = `${base}-${stamp}-${String(next).padStart(4, "0")}`;
    const clash = await get("SELECT id FROM leads WHERE lead_number = ?", [candidate]);
    if (!clash) return candidate;
  }
  return `${base}-${stamp}-${Date.now().toString().slice(-6)}`;
}
function safeJson2(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
async function assignLead(opts) {
  const { lead, toUserId, actorId } = opts;
  const from = lead.assigned_to;
  if ((from ?? null) === (toUserId ?? null)) return { changed: false, from, to: toUserId };
  if (toUserId !== null) {
    const target = await get(
      "SELECT id, name, status FROM users WHERE id = ? AND deleted_at IS NULL",
      [toUserId]
    );
    if (!target) throw badRequest("Selected worker does not exist.");
    if (target.status !== "ACTIVE") throw badRequest("Selected worker is not active.");
  }
  const now = await nowISO();
  await run("UPDATE lead_assignments SET is_active = 0, released_at = ? WHERE lead_id = ? AND is_active = 1", [
    now,
    lead.id
  ]);
  if (toUserId !== null) {
    await run(
      `INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by, action, reason, assigned_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        lead.id,
        toUserId,
        actorId,
        from ? "REASSIGNED" : "ASSIGNED",
        opts.reason ?? null,
        now
      ]
    );
  }
  await run("UPDATE leads SET assigned_to = ?, updated_at = ?, updated_by = ? WHERE id = ?", [
    toUserId,
    now,
    actorId,
    lead.id
  ]);
  const type = toUserId === null ? TIMELINE_TYPES.UNASSIGNED : from ? TIMELINE_TYPES.REASSIGNED : TIMELINE_TYPES.ASSIGNED;
  const targetName = toUserId === null ? "Unassigned" : (await get("SELECT name FROM users WHERE id = ?", [toUserId]))?.name ?? `#${toUserId}`;
  const fromName = from ? (await get("SELECT name FROM users WHERE id = ?", [from]))?.name ?? `#${from}` : "Unassigned";
  await addTimelineEvent({
    leadId: lead.id,
    type,
    actorId,
    summary: type === TIMELINE_TYPES.UNASSIGNED ? `Lead unassigned from ${fromName}` : from ? `Reassigned from ${fromName} to ${targetName}` : `Assigned to ${targetName}`,
    metadata: { from, to: toUserId, from_name: fromName, to_name: targetName, reason: opts.reason ?? null }
  });
  if (toUserId !== null && toUserId !== actorId) {
    await notify({
      userId: toUserId,
      type: "LEAD_ASSIGNED",
      title: `New lead assigned: ${lead.lead_number}`,
      body: opts.reason ? `Reason: ${opts.reason}` : `${opts.actorName} assigned a lead to you.`,
      entity: "lead",
      entityId: lead.id,
      link: `/leads/${lead.id}`
    });
  }
  const status = await get("SELECT code FROM lead_statuses WHERE id = ?", [lead.status_id]);
  if (toUserId !== null && status?.code === "NEW") {
    await changeLeadStatus({ leadId: lead.id, toCode: "ASSIGNED", actorId, silent: false });
  }
  return { changed: true, from, to: toUserId };
}
async function changeLeadStatus(opts) {
  const lead = await get("SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL", [opts.leadId]);
  if (!lead) throw notFound("Lead not found.");
  const to = await get(
    "SELECT id, code, is_active FROM lead_statuses WHERE code = ?",
    [opts.toCode]
  );
  if (!to) throw badRequest("Unknown lead status.");
  if (to.is_active !== 1) throw badRequest("This lead status is disabled.");
  const current = await get("SELECT id, code FROM lead_statuses WHERE id = ?", [lead.status_id]);
  if (!current || current.id === to.id) return null;
  const now = await nowISO();
  await run("UPDATE leads SET status_id = ?, updated_at = ?, updated_by = ? WHERE id = ?", [
    to.id,
    now,
    opts.actorId,
    opts.leadId
  ]);
  await run(
    "INSERT INTO lead_status_history (lead_id, from_status_id, to_status_id, changed_by, remark, changed_at) VALUES (?, ?, ?, ?, ?, ?)",
    [opts.leadId, current.id, to.id, opts.actorId, opts.remark ?? null, now]
  );
  await addTimelineEvent({
    leadId: opts.leadId,
    type: TIMELINE_TYPES.STATUS_CHANGED,
    actorId: opts.actorId,
    summary: `Status changed from ${current.code} to ${to.code}`,
    metadata: { from: current.code, to: to.code, remark: opts.remark ?? null }
  });
  return { from: current.code, to: to.code };
}
function shapeLead(row) {
  let requirements = [];
  let customFields = {};
  try {
    requirements = JSON.parse(row.requirements ?? "[]");
  } catch {
    requirements = [];
  }
  try {
    customFields = JSON.parse(row.custom_fields ?? "{}");
  } catch {
    customFields = {};
  }
  const today = todayStr();
  const openFuDate = row.next_fu_date ?? null;
  const openFuStatus = row.next_fu_status ?? null;
  let effectiveFu = null;
  if (openFuStatus && openFuDate) {
    if (TERMINAL_FOLLOW_UP_STATUSES.includes(openFuStatus)) effectiveFu = openFuStatus;
    else if (openFuDate < today) effectiveFu = "OVERDUE";
    else if (openFuDate === today) effectiveFu = "TODAY";
    else effectiveFu = openFuStatus;
  }
  return {
    id: row.id,
    lead_number: row.lead_number,
    customer: row.customer_id ? {
      id: row.customer_id,
      name: row.customer_name,
      phone: row.customer_phone,
      whatsapp: row.customer_whatsapp,
      email: row.customer_email,
      city: row.customer_city
    } : null,
    source: row.source_id ? { id: row.source_id, name: row.source_name } : null,
    assignee: row.assigned_to ? { id: row.assigned_to, name: row.assignee_name, status: row.assignee_status } : null,
    destination: row.destination,
    travel_type: row.travel_type,
    trip_type: row.trip_type,
    requirements,
    travel_start_date: row.travel_start_date,
    travel_end_date: row.travel_end_date,
    duration_days: row.duration_days,
    adults: row.adults,
    children: row.children,
    total_travelers: row.total_travelers,
    budget: row.budget,
    currency: row.currency,
    priority: row.priority,
    status: row.status_code ? {
      id: row.status_id,
      code: row.status_code,
      name: row.status_name,
      category: row.status_category,
      color: row.status_color
    } : null,
    last_contacted_at: row.last_contacted_at,
    next_follow_up_at: row.next_follow_up_at,
    next_follow_up_date: openFuDate,
    next_follow_up_status: effectiveFu,
    overdue_follow_ups: Number(row.overdue_follow_ups ?? 0),
    open_follow_ups: Number(row.open_follow_ups ?? 0),
    notes: row.notes,
    custom_fields: customFields,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
var ADMIN_ONLY_LEAD_FIELDS = ["customer_id", "source_id", "assigned_to", "lead_number"];
function shapeFollowUp(row) {
  const today = todayStr();
  const status = row.status;
  const date = row.scheduled_date;
  let effective = status;
  if (!["COMPLETED", "CONVERTED", "NOT_INTERESTED", "CANCELLED"].includes(status)) {
    if (date < today) effective = "OVERDUE";
    else if (date === today) effective = "TODAY";
  }
  let board = "PENDING";
  if (effective === "COMPLETED") board = "COMPLETED";
  else if (effective === "CONVERTED") board = "CONVERTED";
  else if (effective === "NOT_INTERESTED" || effective === "CANCELLED") board = "NOT_INTERESTED";
  else if (effective === "OVERDUE") board = "OVERDUE";
  else if (effective === "TODAY") board = "TODAY";
  return {
    id: row.id,
    lead_id: row.lead_id,
    lead_number: row.lead_number,
    lead_priority: row.lead_priority,
    lead_status: row.lead_status_code,
    lead_status_name: row.lead_status_name,
    destination: row.destination,
    customer: row.customer_id ? { id: row.customer_id, name: row.customer_name, phone: row.customer_phone } : null,
    worker: row.worker_id ? { id: row.worker_id, name: row.worker_name } : null,
    scheduled_date: row.scheduled_date,
    scheduled_time: row.scheduled_time,
    type: row.type,
    status,
    effective_status: effective,
    board_column: board,
    notes: row.notes,
    customer_response: row.customer_response,
    next_action: row.next_action,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    completed_by: row.completed_by,
    completed_by_name: row.completed_by_name,
    created_at: row.created_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at
  };
}

// src/services/assigner.ts
init_database();

// src/services/telephony.ts
init_errors();
import { randomUUID } from "node:crypto";
var NullTelephonyProvider = class {
  code = "none";
  label = "No provider configured";
  isConfigured() {
    return false;
  }
  async initiateCall() {
    throw notConfigured(
      "No telephony provider is configured. Configure one in Settings \u2192 Integrations, or log the call manually."
    );
  }
  async fetchRecordingUrl() {
    return null;
  }
};
var GenericRestTelephonyProvider = class {
  constructor(cfg) {
    this.cfg = cfg;
  }
  cfg;
  code = "generic_rest";
  label = "Generic REST provider";
  isConfigured() {
    return Boolean(this.cfg.base_url);
  }
  headers() {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const secret = this.cfg.auth_env ? process.env[this.cfg.auth_env] : void 0;
    if (secret) headers.Authorization = `Bearer ${secret}`;
    return headers;
  }
  url(template, params) {
    let path5 = template || "/";
    for (const [key, value] of Object.entries(params)) path5 = path5.split(`{${key}}`).join(encodeURIComponent(value));
    return `${this.cfg.base_url.replace(/\/$/, "")}${path5.startsWith("/") ? "" : "/"}${path5}`;
  }
  async initiateCall(input) {
    const endpoint = this.url(this.cfg.initiate_path, {});
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          to: input.toNumber,
          worker_id: input.workerId,
          lead_id: input.leadId ?? null,
          customer_id: input.customerId ?? null,
          client_reference: input.reference ?? randomUUID()
        }),
        signal: AbortSignal.timeout(15e3)
      });
    } catch (err) {
      throw upstream(`Telephony provider unreachable: ${err.message}`);
    }
    const text = await res.text().catch(() => "");
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
    }
    if (!res.ok) {
      throw upstream(`Telephony provider rejected the call request (HTTP ${res.status}).`);
    }
    const providerCallId = String(body?.id ?? body?.call_id ?? body?.provider_call_id ?? "");
    if (!providerCallId) throw upstream("Telephony provider did not return a call id.");
    return { provider: this.code, providerCallId, status: String(body?.status ?? "RINGING") };
  }
  async fetchRecordingUrl(providerRecordingId) {
    const endpoint = this.url(this.cfg.recording_path, { id: providerRecordingId });
    let res;
    try {
      res = await fetch(endpoint, { headers: this.headers(), signal: AbortSignal.timeout(15e3) });
    } catch (err) {
      throw upstream(`Recording provider unreachable: ${err.message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw upstream(`Recording provider returned HTTP ${res.status}.`);
    const body = await res.json().catch(() => ({}));
    const url = String(body?.url ?? body?.recording_url ?? "");
    if (!url) return null;
    return { url, expiresAt: body?.expires_at ? String(body.expires_at) : void 0 };
  }
};
async function getTelephonyProvider() {
  const cfg = await telephonyConfig();
  if (cfg.provider === "generic_rest" && cfg.base_url) return new GenericRestTelephonyProvider(cfg);
  return new NullTelephonyProvider();
}
async function telephonyStatus() {
  const cfg = await telephonyConfig();
  const provider = await getTelephonyProvider();
  return {
    provider: cfg.provider,
    label: provider.label,
    configured: provider.isConfigured(),
    base_url: cfg.base_url,
    auth_env: cfg.auth_env,
    secret_present: Boolean(cfg.auth_env && process.env[cfg.auth_env])
  };
}
var WEBHOOK_SECRET_ENV = "TELEPHONY_WEBHOOK_SECRET";
async function nextRoundRobin(candidates) {
  if (!candidates.length) return null;
  const state = await readSetting("assignment_state", { index: 0 });
  const idx = (Number(state.index) || 0) % candidates.length;
  await writeSetting("assignment_state", { index: idx + 1, last_assigned_to: candidates[idx] });
  return candidates[idx];
}

// src/services/assigner.ts
async function activeWorkers() {
  const rows = await all(
    `SELECT u.id, u.name, u.skills FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'WORKER' AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
     ORDER BY u.id ASC`
  );
  return await Promise.all(
    rows.map(async (row) => {
      let skills = [];
      try {
        const parsed = JSON.parse(row.skills ?? "[]");
        if (Array.isArray(parsed)) skills = parsed.map(String);
      } catch {
        skills = [];
      }
      return { id: row.id, name: row.name, open_leads: await openLeadCount(row.id), skills };
    })
  );
}
async function openLeadCount(workerId) {
  return (await get(
    `SELECT COUNT(*) AS c FROM leads l JOIN lead_statuses s ON s.id = l.status_id
       WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category = 'OPEN'`,
    [workerId]
  ))?.c ?? 0;
}
function openLeadsSafe(c) {
  return Number.isFinite(c.open_leads) ? c.open_leads : 0;
}
function leastLoaded(candidates) {
  return [...candidates].sort((a, b) => openLeadsSafe(a) - openLeadsSafe(b) || a.id - b.id);
}
function matchDestinationRule(cfg, destination) {
  if (!destination) return [];
  const needle = destination.trim().toLowerCase();
  if (!needle) return [];
  for (const rule of cfg.destination_rules ?? []) {
    const pattern = String(rule?.destination ?? "").trim().toLowerCase();
    if (pattern && needle.includes(pattern) && Array.isArray(rule.worker_ids)) {
      const ids = rule.worker_ids.map(Number).filter((n) => Number.isFinite(n));
      if (ids.length) return ids;
    }
  }
  return [];
}
function skillsForLead(lead) {
  const out = /* @__PURE__ */ new Set();
  if (lead.destination) out.add(String(lead.destination).trim().toLowerCase());
  if (lead.trip_type) out.add(String(lead.trip_type).trim().toLowerCase());
  if (lead.travel_type) out.add(String(lead.travel_type).trim().toLowerCase());
  try {
    const reqs = JSON.parse(String(lead.requirements ?? "[]"));
    if (Array.isArray(reqs)) for (const r of reqs) out.add(String(r).trim().toLowerCase());
  } catch {
  }
  return [...out].filter(Boolean);
}
async function pickWorker(lead, cfg) {
  cfg = cfg ?? await assignmentConfig();
  const workers = await activeWorkers();
  if (!workers.length) return null;
  switch (cfg.strategy) {
    case "ROUND_ROBIN":
      return await nextRoundRobin(workers.map((w) => w.id));
    case "WORKLOAD":
      return leastLoaded(workers)[0]?.id ?? null;
    case "DESTINATION": {
      const ids = new Set(matchDestinationRule(cfg, lead.destination ?? null));
      const pool2 = ids.size ? workers.filter((w) => ids.has(w.id)) : workers;
      if (!pool2.length) return leastLoaded(workers)[0]?.id ?? null;
      return leastLoaded(pool2)[0]?.id ?? null;
    }
    case "SKILL": {
      const wanted = new Set(skillsForLead(lead));
      const pool2 = workers.filter((w) => w.skills.some((s) => wanted.has(String(s).trim().toLowerCase())));
      if (!pool2.length) return leastLoaded(workers)[0]?.id ?? null;
      return leastLoaded(pool2)[0]?.id ?? null;
    }
    case "MANUAL":
    default:
      return null;
  }
}
async function autoAssignLead(opts) {
  const cfg = await assignmentConfig();
  const strategy = opts.strategy ?? cfg.strategy;
  if (strategy === "MANUAL") return { changed: false, strategy, to: null, reason: null };
  if (opts.lead.assigned_to) return { changed: false, strategy, to: opts.lead.assigned_to, reason: null };
  const picked = await pickWorker(opts.lead, { ...cfg, strategy });
  if (!picked) return { changed: false, strategy, to: null, reason: null };
  const reason = `auto:${strategy.toLowerCase()}`;
  const res = await assignLead({
    lead: opts.lead,
    toUserId: picked,
    actorId: opts.actorId,
    actorName: opts.actorName,
    reason
  });
  return { changed: res.changed, strategy, to: res.to, reason: res.changed ? reason : null };
}
async function autoAssignPending(opts) {
  const cfg = await assignmentConfig();
  if (cfg.strategy === "MANUAL") return { assigned: 0, strategy: cfg.strategy };
  const rows = await all("SELECT * FROM leads WHERE assigned_to IS NULL AND deleted_at IS NULL ORDER BY id ASC LIMIT 500");
  let assigned = 0;
  for (const lead of rows) {
    try {
      const res = await autoAssignLead({ lead, actorId: opts.actorId, actorName: opts.actorName });
      if (res.changed) assigned += 1;
    } catch (err) {
      console.error("[assigner] failed for lead", lead.id, err.message);
    }
  }
  return { assigned, strategy: cfg.strategy };
}

// src/modules/leads/leads.routes.ts
var leadsRouter = Router4();
var dateStr = z4.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format").or(z4.literal("").transform(() => null));
var isoStr = z4.string().refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date").or(z4.literal("").transform(() => null));
var leadCore = {
  destination: z4.string().trim().min(2, "Destination is required").max(200),
  travel_type: z4.enum(["DOMESTIC", "INTERNATIONAL"]),
  trip_type: z4.string().trim().max(60).optional().nullable(),
  requirements: z4.array(z4.string().trim().max(60)).max(30).default([]),
  travel_start_date: dateStr.optional().nullable(),
  travel_end_date: dateStr.optional().nullable(),
  duration_days: z4.number().int().min(0).max(365).optional().nullable(),
  adults: z4.number().int().min(1).max(99).default(2),
  children: z4.number().int().min(0).max(99).default(0),
  budget: z4.number().min(0).max(1e9).optional().nullable(),
  currency: z4.string().trim().length(3).default("INR"),
  priority: z4.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  notes: z4.string().trim().max(4e3).optional().nullable(),
  last_contacted_at: isoStr.optional().nullable(),
  next_follow_up_at: isoStr.optional().nullable()
};
var createLeadSchema = z4.object({
  customer_id: z4.number().int().positive().optional(),
  customer: z4.object({
    name: z4.string().trim().min(2).max(150),
    phone: z4.string().trim().max(30).optional().nullable(),
    whatsapp: z4.string().trim().max(30).optional().nullable(),
    email: z4.string().trim().email().max(200).optional().nullable().or(z4.literal("")),
    city: z4.string().trim().max(100).optional().nullable(),
    state: z4.string().trim().max(100).optional().nullable(),
    country: z4.string().trim().max(100).optional().nullable()
  }).optional(),
  source_id: z4.number().int().positive().optional().nullable(),
  status: z4.string().trim().min(1).default("NEW"),
  assigned_to: z4.number().int().positive().optional().nullable(),
  allow_duplicate: z4.boolean().optional(),
  ...leadCore
}).refine((v) => v.customer_id || v.customer, { message: "Select an existing customer or provide customer details" }).refine(
  (v) => !v.travel_start_date || !v.travel_end_date || v.travel_end_date >= v.travel_start_date,
  { message: "End date must be on or after start date", path: ["travel_end_date"] }
);
var updateLeadSchema = z4.object({
  customer_id: z4.number().int().positive().optional(),
  source_id: z4.number().int().positive().optional().nullable(),
  status: z4.string().trim().min(1).optional(),
  assigned_to: z4.number().int().positive().optional().nullable(),
  allow_duplicate: z4.boolean().optional(),
  ...leadCore
}).partial();
var assignSchema = z4.object({
  worker_id: z4.number().int().positive().nullable(),
  reason: z4.string().trim().max(500).optional().nullable()
});
var bulkAssignSchema = z4.object({
  lead_ids: z4.array(z4.number().int().positive()).min(1, "Select at least one lead").max(500),
  worker_id: z4.number().int().positive().nullable(),
  reason: z4.string().trim().max(500).optional().nullable()
});
var statusSchema2 = z4.object({
  status: z4.string().trim().min(1),
  remark: z4.string().trim().max(500).optional().nullable()
});
var noteSchema = z4.object({
  content: z4.string().trim().min(1, "Note cannot be empty").max(4e3)
});
var FOLLOW_UP_TERMINAL = `('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')`;
var LEAD_SELECT = `
  SELECT l.*, c.name AS customer_name, c.phone AS customer_phone, c.whatsapp AS customer_whatsapp,
         c.email AS customer_email, c.city AS customer_city,
         s.code AS status_code, s.name AS status_name, s.category AS status_category, s.color AS status_color,
         src.name AS source_name, u.name AS assignee_name, u.status AS assignee_status,
         creator.name AS created_by_name,
         (SELECT MIN(f.scheduled_date) FROM follow_ups f
            WHERE f.lead_id = l.id AND f.deleted_at IS NULL AND f.status NOT IN ${FOLLOW_UP_TERMINAL}) AS next_fu_date,
         (SELECT f.status FROM follow_ups f
            WHERE f.lead_id = l.id AND f.deleted_at IS NULL AND f.status NOT IN ${FOLLOW_UP_TERMINAL}
            ORDER BY f.scheduled_date ASC, f.scheduled_time ASC LIMIT 1) AS next_fu_status,
         (SELECT COUNT(*) FROM follow_ups f
            WHERE f.lead_id = l.id AND f.deleted_at IS NULL AND f.status NOT IN ${FOLLOW_UP_TERMINAL}
              AND f.scheduled_date < '${todayStr()}') AS overdue_follow_ups,
         (SELECT COUNT(*) FROM follow_ups f
            WHERE f.lead_id = l.id AND f.deleted_at IS NULL AND f.status NOT IN ${FOLLOW_UP_TERMINAL}) AS open_follow_ups
  FROM leads l
  JOIN customers c ON c.id = l.customer_id
  JOIN lead_statuses s ON s.id = l.status_id
  LEFT JOIN lead_sources src ON src.id = l.source_id
  LEFT JOIN users u ON u.id = l.assigned_to
  LEFT JOIN users creator ON creator.id = l.created_by`;
async function buildWhere(filters, req) {
  const user = currentUser(req);
  const readAll = can(req, "leads:read_all");
  const where = ["l.deleted_at IS NULL"];
  const params = [];
  if (!readAll) {
    where.push("l.assigned_to = ?");
    params.push(user.id);
  }
  if (filters.search) {
    where.push(
      `(c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR c.whatsapp LIKE ? ESCAPE '\\'
        OR c.email LIKE ? ESCAPE '\\' OR l.lead_number LIKE ? ESCAPE '\\' OR l.destination LIKE ? ESCAPE '\\'
        OR u.name LIKE ? ESCAPE '\\')`
    );
    const term = await likeTerm(filters.search);
    params.push(term, term, term, term, term, term, term);
  }
  if (filters.statuses.length) {
    where.push(`s.code IN (${filters.statuses.map(() => "?").join(",")})`);
    params.push(...filters.statuses);
  }
  if (filters.sources.length) {
    where.push(`l.source_id IN (${filters.sources.map(() => "?").join(",")})`);
    params.push(...filters.sources);
  }
  if (filters.workers.length) {
    where.push(`l.assigned_to IN (${filters.workers.map(() => "?").join(",")})`);
    params.push(...filters.workers);
  }
  if (filters.priorities.length) {
    where.push(`l.priority IN (${filters.priorities.map(() => "?").join(",")})`);
    params.push(...filters.priorities);
  }
  if (filters.travel_type) {
    where.push("l.travel_type = ?");
    params.push(filters.travel_type);
  }
  if (filters.trip_type) {
    where.push("l.trip_type = ?");
    params.push(filters.trip_type);
  }
  if (filters.destination) {
    where.push(`l.destination LIKE ? ESCAPE '\\'`);
    params.push(await likeTerm(filters.destination));
  }
  if (filters.assigned === "unassigned") where.push("l.assigned_to IS NULL");
  if (filters.assigned === "assigned") where.push("l.assigned_to IS NOT NULL");
  if (filters.customerId) {
    where.push("l.customer_id = ?");
    params.push(filters.customerId);
  }
  const range = resolvePeriod(filters.period, filters.dateFrom, filters.dateTo);
  const dateColumn = filters.dateField === "last_contacted" ? "l.last_contacted_at" : filters.dateField === "next_follow_up" ? "l.next_follow_up_at" : "l.created_at";
  if (range.from) {
    where.push(`${dateColumn} >= ?`);
    params.push(range.from);
  }
  if (range.to) {
    where.push(`${dateColumn} < ?`);
    params.push(range.to);
  }
  if (filters.followUpStatuses.length) {
    for (const status of filters.followUpStatuses) {
      const effective = effectiveFuStatus("f.status", "f.scheduled_date");
      where.push(
        `EXISTS (SELECT 1 FROM follow_ups f WHERE f.lead_id = l.id AND f.deleted_at IS NULL AND ${effective.sql} = ?)`
      );
      params.push(...effective.params, status);
    }
  }
  return { where, params };
}
function readFilters(req) {
  return {
    search: String(req.query.search ?? "").trim(),
    statuses: toArray(req.query.status),
    sources: toArray(req.query.source).map(Number).filter(Number.isFinite),
    workers: toArray(req.query.worker).map(Number).filter(Number.isFinite),
    priorities: toArray(req.query.priority),
    travel_type: String(req.query.travel_type ?? "").trim() || void 0,
    trip_type: String(req.query.trip_type ?? "").trim() || void 0,
    destination: String(req.query.destination ?? "").trim(),
    assigned: String(req.query.assigned ?? "").trim() || void 0,
    period: String(req.query.period ?? "").trim() || void 0,
    dateField: String(req.query.date_field ?? "created").trim(),
    dateFrom: String(req.query.date_from ?? "").trim() || void 0,
    dateTo: String(req.query.date_to ?? "").trim() || void 0,
    followUpStatuses: toArray(req.query.follow_up_status),
    customerId: toInt(req.query.customer_id)
  };
}
leadsRouter.get("/check-duplicate", requireAuth, async (req, res, next) => {
  try {
    if (!can(req, "leads:create") && !can(req, "leads:read_all")) throw forbidden();
    const customers = await findDuplicates({
      phone: String(req.query.phone ?? ""),
      whatsapp: String(req.query.whatsapp ?? ""),
      email: String(req.query.email ?? "")
    });
    const leadMatches = customers.length ? await all(
      `SELECT l.id, l.lead_number, l.destination, l.created_at, s.code AS status
           FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.deleted_at IS NULL AND l.customer_id IN (${customers.map(() => "?").join(",")})
           ORDER BY l.created_at DESC LIMIT 20`,
      customers.map((c) => c.id)
    ) : [];
    await audit(req, "LEAD_DUPLICATE_CHECKED", "lead", null, { customer_matches: customers.length });
    ok(res, { customers, leads: leadMatches, is_duplicate: customers.length > 0 });
  } catch (err) {
    next(err);
  }
});
leadsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    if (!can(req, "leads:read_all") && !can(req, "leads:read_own")) throw forbidden();
    const { page, limit, offset } = pagination(req.query, 20, 200);
    const filters = readFilters(req);
    const { where, params } = await buildWhere(filters, req);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(
      `SELECT COUNT(*) AS c FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses s ON s.id = l.status_id
       LEFT JOIN lead_sources src ON src.id = l.source_id
       LEFT JOIN users u ON u.id = l.assigned_to
       ${whereSql}`,
      params
    )).c;
    const sort = String(req.query.sort ?? "recent");
    const orderSql = sort === "oldest" ? "l.created_at ASC, l.id ASC" : sort === "updated" ? "l.updated_at DESC" : sort === "priority" ? `CASE l.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END ASC, l.created_at DESC` : sort === "follow_up" ? "next_fu_date IS NULL, next_fu_date ASC, l.created_at DESC" : "l.created_at DESC, l.id DESC";
    const rows = await all(`${LEAD_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset
    ]);
    list(res, rows.map(shapeLead), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
leadsRouter.post("/", requireAuth, requirePermission("leads:create"), async (req, res, next) => {
  try {
    const body = meta(createLeadSchema, req.body);
    const user = currentUser(req);
    let customerId = body.customer_id ?? null;
    let duplicateWarnings = [];
    if (!customerId && body.customer) {
      duplicateWarnings = await findDuplicates(body.customer);
      if (duplicateWarnings.length && !body.allow_duplicate) {
        return res.status(409).json({
          error: {
            code: "CONFLICT",
            message: "Possible duplicate customer found.",
            details: { duplicates: duplicateWarnings }
          }
        });
      }
      const now2 = await nowISO();
      customerId = (await run(
        `INSERT INTO customers (name, phone, whatsapp, email, city, state, country, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          body.customer.name,
          body.customer.phone ?? null,
          body.customer.whatsapp ?? body.customer.phone ?? null,
          body.customer.email || null,
          body.customer.city ?? null,
          body.customer.state ?? null,
          body.customer.country ?? null,
          user.id,
          now2,
          now2
        ]
      )).lastInsertRowid;
    }
    if (!customerId) throw badRequest("Customer is required.");
    const customer = await get("SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL", [customerId]);
    if (!customer) throw badRequest("Selected customer does not exist.");
    if (body.assigned_to && !can(req, "leads:assign")) {
      throw forbidden("You do not have permission to assign leads.");
    }
    const status = await get("SELECT id FROM lead_statuses WHERE code = ? AND is_active = 1", [body.status]);
    if (!status) throw badRequest("Unknown lead status.");
    if (body.source_id) {
      const source = await get("SELECT id FROM lead_sources WHERE id = ? AND is_active = 1", [body.source_id]);
      if (!source) throw badRequest("Unknown lead source.");
    }
    const now = await nowISO();
    const leadId = await tx(async () => {
      const inserted = (await run(
        `INSERT INTO leads (lead_number, customer_id, source_id, assigned_to, destination, travel_type, trip_type,
          requirements, travel_start_date, travel_end_date, duration_days, adults, children, total_travelers,
          budget, currency, priority, status_id, last_contacted_at, next_follow_up_at, notes, created_by, updated_by,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          await nextLeadNumber(),
          customerId,
          body.source_id ?? null,
          body.assigned_to ?? null,
          body.destination,
          body.travel_type,
          body.trip_type ?? null,
          JSON.stringify(body.requirements ?? []),
          body.travel_start_date ?? null,
          body.travel_end_date ?? null,
          body.duration_days ?? null,
          body.adults,
          body.children,
          body.adults + body.children,
          body.budget ?? null,
          body.currency,
          body.priority,
          status.id,
          body.last_contacted_at ?? null,
          body.next_follow_up_at ?? null,
          body.notes ?? null,
          user.id,
          user.id,
          now,
          now
        ]
      )).lastInsertRowid;
      await addTimelineEvent({
        leadId: inserted,
        type: TIMELINE_TYPES.LEAD_CREATED,
        actorId: user.id,
        summary: `Lead created by ${user.name}`,
        metadata: { destination: body.destination, source_id: body.source_id ?? null, customer_id: customerId }
      });
      return inserted;
    });
    if (body.assigned_to) {
      const lead = await get("SELECT * FROM leads WHERE id = ?", [leadId]);
      await assignLead({ lead, toUserId: body.assigned_to, actorId: user.id, actorName: user.name });
    } else if ((await assignmentConfig()).auto_assign_new) {
      const lead = await get("SELECT * FROM leads WHERE id = ?", [leadId]);
      await autoAssignLead({ lead, actorId: user.id, actorName: user.name });
    }
    await audit(req, "LEAD_CREATED", "lead", leadId, {
      destination: body.destination,
      customer_id: customerId,
      assigned_to: body.assigned_to ?? null,
      duplicates: duplicateWarnings.length
    });
    const row = await get(`${LEAD_SELECT} WHERE l.id = ?`, [leadId]);
    created(res, shapeLead(row));
  } catch (err) {
    next(err);
  }
});
leadsRouter.get("/:id(\\d+)", requireAuth, async (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    await loadLead(leadId, req);
    const row = await get(`${LEAD_SELECT} WHERE l.id = ?`, [leadId]);
    if (!row) throw notFound("Lead not found.");
    const detail = shapeLead(row);
    const statusHistory = await all(
      `SELECT h.id, h.remark, h.changed_at, fs.code AS from_code, fs.name AS from_name, ts.code AS to_code, ts.name AS to_name,
              u.name AS changed_by_name
       FROM lead_status_history h
       LEFT JOIN lead_statuses fs ON fs.id = h.from_status_id
       JOIN lead_statuses ts ON ts.id = h.to_status_id
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.lead_id = ? ORDER BY h.changed_at ASC`,
      [leadId]
    );
    const openFollowUps = await all(
      `SELECT f.*, u.name AS worker_name FROM follow_ups f JOIN users u ON u.id = f.worker_id
       WHERE f.lead_id = ? AND f.deleted_at IS NULL AND f.status NOT IN ${FOLLOW_UP_TERMINAL}
       ORDER BY f.scheduled_date ASC, f.scheduled_time ASC LIMIT 5`,
      [leadId]
    );
    ok(res, {
      ...detail,
      status_history: statusHistory,
      open_follow_ups_list: openFollowUps.map(shapeFollowUp)
    });
  } catch (err) {
    next(err);
  }
});
leadsRouter.patch("/:id(\\d+)", requireAuth, async (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    const lead = await loadLead(leadId, req);
    assertLeadWriteAccess(lead, req);
    const body = meta(updateLeadSchema, req.body);
    const user = currentUser(req);
    const isAdminFieldChange = ADMIN_ONLY_LEAD_FIELDS.some(
      (field) => body[field] !== void 0 && body[field] !== lead[field]
    );
    if (isAdminFieldChange && !can(req, "leads:update")) {
      throw forbidden("Only an administrator can change customer, source or assignment.");
    }
    if (body.travel_start_date && body.travel_end_date && body.travel_end_date < body.travel_start_date) {
      throw badRequest("End date must be on or after start date.");
    }
    const now = await nowISO();
    const changed = [];
    await tx(async () => {
      await run(
        `UPDATE leads SET destination = ?, travel_type = ?, trip_type = ?, requirements = ?,
          travel_start_date = ?, travel_end_date = ?, duration_days = ?, adults = ?, children = ?, total_travelers = ?,
          budget = ?, currency = ?, priority = ?, notes = ?, last_contacted_at = ?, next_follow_up_at = ?,
          source_id = COALESCE(?, source_id), customer_id = COALESCE(?, customer_id),
          updated_at = ?, updated_by = ? WHERE id = ?`,
        [
          body.destination ?? lead.destination,
          body.travel_type ?? lead.travel_type,
          body.trip_type !== void 0 ? body.trip_type : lead.trip_type,
          body.requirements ? JSON.stringify(body.requirements) : lead.requirements,
          body.travel_start_date !== void 0 ? body.travel_start_date : lead.travel_start_date,
          body.travel_end_date !== void 0 ? body.travel_end_date : lead.travel_end_date,
          body.duration_days !== void 0 ? body.duration_days : lead.duration_days,
          body.adults ?? lead.adults,
          body.children ?? lead.children,
          (body.adults ?? lead.adults) + (body.children ?? lead.children),
          body.budget !== void 0 ? body.budget : lead.budget,
          body.currency ?? lead.currency,
          body.priority ?? lead.priority,
          body.notes !== void 0 ? body.notes : lead.notes,
          body.last_contacted_at !== void 0 ? body.last_contacted_at : lead.last_contacted_at,
          body.next_follow_up_at !== void 0 ? body.next_follow_up_at : lead.next_follow_up_at,
          body.source_id !== void 0 ? body.source_id : null,
          body.customer_id !== void 0 ? body.customer_id : null,
          now,
          user.id,
          leadId
        ]
      );
      for (const key of Object.keys(body)) {
        if (key === "allow_duplicate") continue;
        const before = lead[key];
        const after = body[key];
        if (after !== void 0 && JSON.stringify(after) !== JSON.stringify(before)) changed.push(key);
      }
      if (changed.length) {
        await addTimelineEvent({
          leadId,
          type: TIMELINE_TYPES.LEAD_UPDATED,
          actorId: user.id,
          summary: `Lead updated (${changed.join(", ")})`,
          metadata: { fields: changed }
        });
      }
    });
    if (body.status) {
      await changeLeadStatus({ leadId, toCode: body.status, actorId: user.id });
    }
    if (changed.length || body.status) await audit(req, "LEAD_UPDATED", "lead", leadId, { fields: changed, status: body.status });
    const row = await get(`${LEAD_SELECT} WHERE l.id = ?`, [leadId]);
    ok(res, shapeLead(row));
  } catch (err) {
    next(err);
  }
});
leadsRouter.post("/:id(\\d+)/status", requireAuth, async (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    const lead = await loadLead(leadId, req);
    assertLeadWriteAccess(lead, req);
    const body = meta(statusSchema2, req.body);
    const user = currentUser(req);
    const result = await changeLeadStatus({ leadId, toCode: body.status, actorId: user.id, remark: body.remark });
    if (result) {
      await audit(req, "LEAD_STATUS_CHANGED", "lead", leadId, result);
      if (result.to === "CONVERTED") {
        await notifyRoleAdmins(leadId, lead.lead_number, user.name, "converted");
      }
    }
    const row = await get(`${LEAD_SELECT} WHERE l.id = ?`, [leadId]);
    ok(res, { ...shapeLead(row), changed: Boolean(result) });
  } catch (err) {
    next(err);
  }
});
leadsRouter.post("/:id(\\d+)/assign", requireAuth, requirePermission("leads:assign"), async (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    const lead = await loadLead(leadId, req);
    const body = meta(assignSchema, req.body);
    const user = currentUser(req);
    const result = await assignLead({
      lead,
      toUserId: body.worker_id,
      actorId: user.id,
      actorName: user.name,
      reason: body.reason
    });
    if (result.changed) {
      await audit(req, result.to ? result.from ? "LEAD_REASSIGNED" : "LEAD_ASSIGNED" : "LEAD_UNASSIGNED", "lead", leadId, {
        from: result.from,
        to: result.to,
        reason: body.reason ?? null
      });
    }
    const row = await get(`${LEAD_SELECT} WHERE l.id = ?`, [leadId]);
    ok(res, { ...shapeLead(row), changed: result.changed });
  } catch (err) {
    next(err);
  }
});
leadsRouter.post("/bulk/assign", requireAuth, requirePermission("leads:assign"), async (req, res, next) => {
  try {
    const body = meta(bulkAssignSchema, req.body);
    const user = currentUser(req);
    const results = { assigned: 0, reassigned: 0, unchanged: 0, failed: [] };
    for (const leadId of body.lead_ids) {
      try {
        const lead = await get("SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL", [leadId]);
        if (!lead) {
          results.failed.push({ id: leadId, message: "Lead not found" });
          continue;
        }
        const result = await assignLead({
          lead,
          toUserId: body.worker_id,
          actorId: user.id,
          actorName: user.name,
          reason: body.reason
        });
        if (!result.changed) results.unchanged += 1;
        else if (result.from) results.reassigned += 1;
        else results.assigned += 1;
        if (result.changed) {
          await audit(req, result.from ? "LEAD_REASSIGNED" : "LEAD_ASSIGNED", "lead", leadId, {
            from: result.from,
            to: result.to,
            bulk: true
          });
        }
      } catch (err) {
        results.failed.push({ id: leadId, message: err.message });
      }
    }
    ok(res, results);
  } catch (err) {
    next(err);
  }
});
leadsRouter.get("/:id(\\d+)/timeline", requireAuth, async (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    await loadLead(leadId, req);
    const limit = Math.min(300, Number(req.query.limit) || 100);
    const rows = await all(
      `SELECT t.id, t.type, t.summary, t.metadata, t.created_at, u.name AS actor_name, u.id AS actor_id
       FROM lead_timeline t LEFT JOIN users u ON u.id = t.actor_id
       WHERE t.lead_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      [leadId, limit]
    );
    ok(
      res,
      rows.map((r) => ({ ...r, metadata: parseJson(r.metadata, {}) }))
    );
  } catch (err) {
    next(err);
  }
});
leadsRouter.get("/:id(\\d+)/assignments", requireAuth, async (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    await loadLead(leadId, req);
    const rows = await all(
      `SELECT a.id, a.action, a.reason, a.assigned_at, a.released_at, a.is_active,
              to_u.name AS assigned_to_name, to_u.id AS assigned_to_id,
              by_u.name AS assigned_by_name
       FROM lead_assignments a
       JOIN users to_u ON to_u.id = a.assigned_to
       JOIN users by_u ON by_u.id = a.assigned_by
       WHERE a.lead_id = ? ORDER BY a.assigned_at DESC`,
      [leadId]
    );
    ok(res, rows);
  } catch (err) {
    next(err);
  }
});
leadsRouter.get("/:id(\\d+)/notes", requireAuth, async (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    await loadLead(leadId, req);
    const rows = await all(
      `SELECT n.id, n.content, n.created_at, n.updated_at, u.id AS author_id, u.name AS author_name
       FROM notes n JOIN users u ON u.id = n.author_id
       WHERE n.lead_id = ? AND n.deleted_at IS NULL ORDER BY n.created_at DESC`,
      [leadId]
    );
    ok(res, rows);
  } catch (err) {
    next(err);
  }
});
leadsRouter.post("/:id(\\d+)/notes", requireAuth, requirePermission("notes:create"), async (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    const lead = await loadLead(leadId, req);
    if (!can(req, "leads:update") && lead.assigned_to !== currentUser(req).id) {
      throw forbidden("You can only add notes to your own leads.");
    }
    const body = meta(noteSchema, req.body);
    const user = currentUser(req);
    const now = await nowISO();
    const noteId = (await run("INSERT INTO notes (lead_id, author_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
      leadId,
      user.id,
      body.content,
      now,
      now
    ])).lastInsertRowid;
    await addTimelineEvent({
      leadId,
      type: TIMELINE_TYPES.NOTE_ADDED,
      actorId: user.id,
      summary: `Note added by ${user.name}`,
      metadata: { note_id: noteId, preview: body.content.slice(0, 120) }
    });
    await audit(req, "NOTE_ADDED", "lead", leadId, { note_id: noteId });
    created(res, {
      id: noteId,
      content: body.content,
      created_at: now,
      updated_at: now,
      author_id: user.id,
      author_name: user.name
    });
  } catch (err) {
    next(err);
  }
});
async function notifyRoleAdmins(leadId, leadNumber, actorName, outcome) {
  const admins = await all(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'ADMIN' AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`
  );
  for (const admin of admins) {
    await notify({
      userId: admin.id,
      type: "LEAD_CONVERTED",
      title: `${leadNumber} marked as converted`,
      body: `${actorName} marked this lead as converted.`,
      entity: "lead",
      entityId: leadId,
      link: `/leads/${leadId}`
    });
  }
  void outcome;
}
function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// src/modules/followups/followups.routes.ts
init_database();
init_errors();
import { Router as Router5 } from "express";
import { z as z5 } from "zod";

// src/modules/followups/followups.service.ts
init_database();
init_errors();
var FU_SELECT = `
  SELECT f.*, l.lead_number, l.destination, l.priority AS lead_priority, l.assigned_to AS lead_assignee,
         ls.code AS lead_status_code, ls.name AS lead_status_name,
         c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
         w.name AS worker_name, w.id AS worker_id,
         cb.name AS created_by_name, comp.name AS completed_by_name
  FROM follow_ups f
  JOIN leads l ON l.id = f.lead_id
  JOIN customers c ON c.id = l.customer_id
  JOIN lead_statuses ls ON ls.id = l.status_id
  JOIN users w ON w.id = f.worker_id
  LEFT JOIN users cb ON cb.id = f.created_by
  LEFT JOIN users comp ON comp.id = f.completed_by`;
async function createFollowUpRecord(opts) {
  const { input, user } = opts;
  const lead = await get(
    `SELECT l.id, l.assigned_to, l.lead_number FROM leads l
      WHERE l.id = ? AND l.deleted_at IS NULL`,
    [input.lead_id]
  );
  if (!lead) throw notFound("Lead not found.");
  if (!opts.canScheduleOnAnyLead && lead.assigned_to !== user.id) {
    throw forbidden("You can only schedule follow-ups on your own leads.");
  }
  let workerId = input.worker_id ?? user.id;
  if (workerId !== user.id && !opts.canCrossAssign) {
    throw forbidden("You cannot assign follow-ups to another worker.");
  }
  const worker = await get("SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL", [
    workerId
  ]);
  if (!worker) throw badRequest("Selected worker does not exist.");
  if (worker.status !== "ACTIVE") throw badRequest("Selected worker is not active.");
  const now = await nowISO();
  const id = (await run(
    `INSERT INTO follow_ups (lead_id, worker_id, scheduled_date, scheduled_time, type, status, notes, next_action,
      customer_response, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)`,
    [
      input.lead_id,
      workerId,
      input.scheduled_date,
      input.scheduled_time ?? null,
      input.type,
      input.notes ?? null,
      input.next_action ?? null,
      input.customer_response ?? null,
      user.id,
      now,
      now
    ]
  )).lastInsertRowid;
  await addTimelineEvent({
    leadId: input.lead_id,
    type: TIMELINE_TYPES.FOLLOW_UP_CREATED,
    actorId: user.id,
    summary: `Follow-up scheduled for ${input.scheduled_date}${input.scheduled_time ? ` ${input.scheduled_time}` : ""} (${input.type})`,
    metadata: { follow_up_id: id, worker_id: workerId, type: input.type }
  });
  await audit(opts.req, "FOLLOW_UP_CREATED", "follow_up", id, {
    lead_id: input.lead_id,
    worker_id: workerId,
    scheduled_date: input.scheduled_date
  });
  if (workerId !== user.id) {
    await notify({
      userId: workerId,
      type: "FOLLOW_UP_ASSIGNED",
      title: `Follow-up scheduled: ${lead.lead_number}`,
      body: `${user.name} scheduled a follow-up for ${input.scheduled_date}.`,
      entity: "follow_up",
      entityId: id,
      link: `/leads/${input.lead_id}`
    });
  }
  return id;
}

// src/modules/followups/followups.routes.ts
var followUpsRouter = Router5();
var BOARD_COLUMNS = [
  { key: "PENDING", label: "Pending" },
  { key: "TODAY", label: "Today" },
  { key: "OVERDUE", label: "Overdue" },
  { key: "COMPLETED", label: "Completed" },
  { key: "CONVERTED", label: "Converted" },
  { key: "NOT_INTERESTED", label: "Not Interested" }
];
var createSchema2 = z5.object({
  lead_id: z5.number().int().positive(),
  worker_id: z5.number().int().positive().optional(),
  scheduled_date: z5.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  scheduled_time: z5.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format").optional().nullable(),
  type: z5.string().trim().max(40).default("Call"),
  notes: z5.string().trim().max(2e3).optional().nullable(),
  next_action: z5.string().trim().max(500).optional().nullable()
});
var updateSchema3 = z5.object({
  status: z5.string().trim().min(1).optional(),
  scheduled_date: z5.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format").optional(),
  scheduled_time: z5.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format").optional().nullable(),
  type: z5.string().trim().max(40).optional(),
  notes: z5.string().trim().max(2e3).optional().nullable(),
  customer_response: z5.string().trim().max(2e3).optional().nullable(),
  next_action: z5.string().trim().max(500).optional().nullable(),
  worker_id: z5.number().int().positive().optional()
});
var TERMINAL = ["COMPLETED", "CONVERTED", "NOT_INTERESTED", "CANCELLED"];
var OUTCOMES = ["COMPLETED", "CONVERTED", "NOT_INTERESTED", "NO_RESPONSE", "CALLBACK_REQUESTED", "CANCELLED"];
async function loadFollowUp(id, req) {
  const row = await get("SELECT * FROM follow_ups WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!row) throw notFound("Follow-up not found.");
  const user = currentUser(req);
  const readAll = can(req, "follow_ups:read_all");
  if (!readAll && row.worker_id !== user.id) throw forbidden("You do not have access to this follow-up.");
  return row;
}
function assertFollowUpWrite(row, req) {
  const user = currentUser(req);
  if (can(req, "follow_ups:update")) return;
  if (can(req, "follow_ups:update_own") && row.worker_id === user.id) return;
  throw forbidden("You do not have permission to update this follow-up.");
}
async function buildFilters(req) {
  const user = currentUser(req);
  const where = ["f.deleted_at IS NULL", "l.deleted_at IS NULL"];
  const params = [];
  if (!can(req, "follow_ups:read_all")) {
    where.push("f.worker_id = ?");
    params.push(user.id);
  }
  const search = String(req.query.search ?? "").trim();
  if (search) {
    where.push(
      `(c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR l.lead_number LIKE ? ESCAPE '\\'
        OR l.destination LIKE ? ESCAPE '\\' OR w.name LIKE ? ESCAPE '\\')`
    );
    const term = await likeTerm(search);
    params.push(term, term, term, term, term);
  }
  const workerIds = toArray(req.query.worker_id).map(Number).filter(Number.isFinite);
  if (workerIds.length) {
    where.push(`f.worker_id IN (${workerIds.map(() => "?").join(",")})`);
    params.push(...workerIds);
  }
  const leadId = Number(req.query.lead_id);
  if (leadId) {
    where.push("f.lead_id = ?");
    params.push(leadId);
  }
  const statuses = toArray(req.query.status);
  if (statuses.length) {
    const effective = effectiveFuStatus("f.status", "f.scheduled_date");
    const inStored = statuses.filter((s) => !["TODAY", "OVERDUE"].includes(s));
    const inEffective = statuses.filter((s) => ["TODAY", "OVERDUE"].includes(s));
    const clauses = [];
    if (inStored.length) {
      clauses.push(`f.status IN (${inStored.map(() => "?").join(",")})`);
      params.push(...inStored);
    }
    if (inEffective.length) {
      clauses.push(`(${effective.sql}) IN (${inEffective.map(() => "?").join(",")})`);
      params.push(...effective.params, ...inEffective);
    }
    where.push(`(${clauses.join(" OR ")})`);
  }
  const types = toArray(req.query.type);
  if (types.length) {
    where.push(`f.type IN (${types.map(() => "?").join(",")})`);
    params.push(...types);
  }
  const period = String(req.query.period ?? "").trim() || void 0;
  const from = String(req.query.date_from ?? "").trim();
  const to = String(req.query.date_to ?? "").trim();
  const dates = resolvePeriodDates(period, from || void 0, to || void 0);
  if (dates.from) {
    where.push("f.scheduled_date >= ?");
    params.push(dates.from);
  }
  if (dates.to) {
    where.push("f.scheduled_date <= ?");
    params.push(dates.to);
  }
  return { where, params };
}
followUpsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    if (!can(req, "follow_ups:read_all") && !can(req, "follow_ups:read_own")) throw forbidden();
    const { page, limit, offset } = pagination(req.query, 25, 200);
    const { where, params } = await buildFilters(req);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(
      `SELECT COUNT(*) AS c FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
       JOIN users w ON w.id = f.worker_id
       ${whereSql}`,
      params
    )).c;
    const sort = String(req.query.sort ?? "date");
    const order = sort === "recent" ? "f.created_at DESC" : sort === "status" ? "f.status ASC, f.scheduled_date ASC" : "f.scheduled_date ASC, f.scheduled_time ASC, f.id ASC";
    const rows = await all(`${FU_SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    list(res, rows.map(shapeFollowUp), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
followUpsRouter.get("/board", requireAuth, async (req, res, next) => {
  try {
    if (!can(req, "follow_ups:read_all") && !can(req, "follow_ups:read_own")) throw forbidden();
    const { where, params } = await buildFilters(req);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const cap = Math.min(1e3, Number(req.query.limit) || 300);
    const rows = await all(`${FU_SELECT} ${whereSql} ORDER BY f.scheduled_date ASC, f.scheduled_time ASC LIMIT ?`, [
      ...params,
      cap
    ]);
    const shaped = rows.map(shapeFollowUp);
    const counts = await all(
      `SELECT ${effectiveFuStatus("f.status", "f.scheduled_date").sql.replace(/\?/g, `'${todayStr()}'`)} AS eff,
              COUNT(*) AS cnt
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
       JOIN users w ON w.id = f.worker_id
       ${whereSql}
       GROUP BY eff`,
      params
    );
    const columns = BOARD_COLUMNS.map((col) => {
      const items = shaped.filter((f) => f.board_column === col.key);
      const countRow = counts.find((c) => {
        const eff = c.eff;
        if (col.key === "PENDING") return !["COMPLETED", "CONVERTED", "NOT_INTERESTED", "CANCELLED", "OVERDUE", "TODAY"].includes(eff);
        if (col.key === "NOT_INTERESTED") return eff === "NOT_INTERESTED" || eff === "CANCELLED";
        return eff === col.key;
      });
      return { key: col.key, label: col.label, count: Number(countRow?.cnt ?? items.length), items };
    });
    ok(res, { columns, truncated: rows.length >= cap });
  } catch (err) {
    next(err);
  }
});
followUpsRouter.post("/", requireAuth, requirePermission("follow_ups:create"), async (req, res, next) => {
  try {
    const body = meta(createSchema2, req.body);
    const user = currentUser(req);
    const id = await createFollowUpRecord({
      input: body,
      user,
      canCrossAssign: can(req, "follow_ups:update"),
      canScheduleOnAnyLead: can(req, "leads:read_all"),
      req
    });
    const row = await get(`${FU_SELECT} WHERE f.id = ?`, [id]);
    created(res, shapeFollowUp(row));
  } catch (err) {
    next(err);
  }
});
followUpsRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await loadFollowUp(id, req);
    const row = await get(`${FU_SELECT} WHERE f.id = ?`, [id]);
    if (!row) throw notFound("Follow-up not found.");
    ok(res, shapeFollowUp(row));
  } catch (err) {
    next(err);
  }
});
followUpsRouter.patch("/:id", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await loadFollowUp(id, req);
    assertFollowUpWrite(existing, req);
    const body = meta(updateSchema3, req.body);
    const user = currentUser(req);
    const now = await nowISO();
    if (body.worker_id && body.worker_id !== existing.worker_id) {
      if (!can(req, "follow_ups:update")) throw forbidden("You cannot reassign this follow-up.");
      const worker = await get("SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL", [
        body.worker_id
      ]);
      if (!worker || worker.status !== "ACTIVE") throw badRequest("Selected worker is not active.");
    }
    const nextStatus = body.status ?? existing.status;
    if (body.status && !OUTCOMES.includes(body.status) && body.status !== "PENDING" && body.status !== "RESCHEDULED") {
      throw badRequest("Unknown follow-up status.");
    }
    const dateChanged = body.scheduled_date && body.scheduled_date !== existing.scheduled_date;
    let resolvedStatus = nextStatus;
    if (!body.status && dateChanged && !TERMINAL.includes(existing.status)) {
      resolvedStatus = "RESCHEDULED";
    }
    const becameTerminal = TERMINAL.includes(resolvedStatus) && !TERMINAL.includes(existing.status);
    const reopened = !TERMINAL.includes(resolvedStatus) && TERMINAL.includes(existing.status);
    await run(
      `UPDATE follow_ups SET scheduled_date = ?, scheduled_time = ?, type = ?, status = ?, notes = ?,
        customer_response = ?, next_action = ?, worker_id = ?,
        completed_at = ?,
        completed_by = ?,
        updated_at = ? WHERE id = ?`,
      [
        body.scheduled_date ?? existing.scheduled_date,
        body.scheduled_time !== void 0 ? body.scheduled_time : existing.scheduled_time,
        body.type ?? existing.type,
        resolvedStatus,
        body.notes !== void 0 ? body.notes : existing.notes,
        body.customer_response !== void 0 ? body.customer_response : existing.customer_response,
        body.next_action !== void 0 ? body.next_action : existing.next_action,
        body.worker_id ?? existing.worker_id,
        becameTerminal ? now : null,
        becameTerminal ? user.id : null,
        now,
        id
      ]
    );
    const lead = await get(
      "SELECT id, lead_number, assigned_to FROM leads WHERE id = ?",
      [existing.lead_id]
    );
    if (becameTerminal) {
      await addTimelineEvent({
        leadId: existing.lead_id,
        type: TIMELINE_TYPES.FOLLOW_UP_COMPLETED,
        actorId: user.id,
        summary: `Follow-up marked as ${resolvedStatus} by ${user.name}`,
        metadata: {
          follow_up_id: id,
          status: resolvedStatus,
          customer_response: body.customer_response ?? null,
          next_action: body.next_action ?? null
        }
      });
      if (resolvedStatus === "CONVERTED") {
        await changeLeadStatus({ leadId: existing.lead_id, toCode: "CONVERTED", actorId: user.id, remark: "Follow-up converted" });
      } else if (resolvedStatus === "NOT_INTERESTED") {
        await changeLeadStatus({ leadId: existing.lead_id, toCode: "NOT_INTERESTED", actorId: user.id, remark: "Follow-up: not interested" });
      }
    } else {
      await addTimelineEvent({
        leadId: existing.lead_id,
        type: TIMELINE_TYPES.FOLLOW_UP_UPDATED,
        actorId: user.id,
        summary: dateChanged ? `Follow-up rescheduled to ${body.scheduled_date}` : `Follow-up updated (${resolvedStatus})`,
        metadata: { follow_up_id: id, status: resolvedStatus, from_date: existing.scheduled_date }
      });
    }
    await audit(req, becameTerminal ? "FOLLOW_UP_COMPLETED" : "FOLLOW_UP_UPDATED", "follow_up", id, {
      status: resolvedStatus,
      previous_status: existing.status,
      lead_id: existing.lead_id,
      reopened
    });
    if (becameTerminal && lead && lead.assigned_to && lead.assigned_to !== user.id) {
      await notify({
        userId: lead.assigned_to,
        type: "FOLLOW_UP_COMPLETED",
        title: `Follow-up ${resolvedStatus.toLowerCase()}: ${lead.lead_number}`,
        body: `${user.name} marked a follow-up as ${resolvedStatus.replace("_", " ").toLowerCase()}.`,
        entity: "lead",
        entityId: lead.id,
        link: `/leads/${lead.id}`
      });
    }
    const row = await get(`${FU_SELECT} WHERE f.id = ?`, [id]);
    ok(res, shapeFollowUp(row));
  } catch (err) {
    next(err);
  }
});
followUpsRouter.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await loadFollowUp(id, req);
    assertFollowUpWrite(existing, req);
    const user = currentUser(req);
    await run("UPDATE follow_ups SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?", [
      "CANCELLED",
      await nowISO(),
      await nowISO(),
      id
    ]);
    await addTimelineEvent({
      leadId: existing.lead_id,
      type: TIMELINE_TYPES.FOLLOW_UP_UPDATED,
      actorId: user.id,
      summary: "Follow-up cancelled",
      metadata: { follow_up_id: id }
    });
    await audit(req, "FOLLOW_UP_CANCELLED", "follow_up", id, { lead_id: existing.lead_id });
    ok(res, { cancelled: true });
  } catch (err) {
    next(err);
  }
});

// src/modules/dashboard/dashboard.routes.ts
init_database();
init_errors();
import { Router as Router6 } from "express";
var dashboardRouter = Router6();
var TERMINAL_SQL = `('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')`;
function dimensionFilters(req, alias = "l") {
  const where = [];
  const params = [];
  const workerId = Number(req.query.worker_id);
  if (workerId) {
    where.push(`${alias}.assigned_to = ?`);
    params.push(workerId);
  }
  const sourceId = Number(req.query.source_id);
  if (sourceId) {
    where.push(`${alias}.source_id = ?`);
    params.push(sourceId);
  }
  const statusCodes = String(req.query.status ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (statusCodes.length) {
    where.push(`s.code IN (${statusCodes.map(() => "?").join(",")})`);
    params.push(...statusCodes);
  }
  const destination = String(req.query.destination ?? "").trim();
  if (destination) {
    where.push(`${alias}.destination LIKE ? ESCAPE '\\'`);
    params.push(`%${destination.replace(/[%_]/g, (m) => `\\${m}`)}%`);
  }
  return { where, params };
}
dashboardRouter.get("/admin", requireAuth, requirePermission("dashboard:admin"), async (req, res, next) => {
  try {
    const today = todayStr();
    const dims = dimensionFilters(req);
    const dates = resolvePeriodDates(
      String(req.query.period ?? "").trim() || void 0,
      String(req.query.date_from ?? "").trim() || void 0,
      String(req.query.date_to ?? "").trim() || void 0
    );
    const baseWhere = ["l.deleted_at IS NULL", ...dims.where];
    const baseParams = [...dims.params];
    if (dates.from) {
      baseWhere.push("l.created_at >= ?");
      baseParams.push(`${dates.from}T00:00:00.000Z`);
    }
    if (dates.to) {
      baseWhere.push("l.created_at < ?");
      baseParams.push(`${addDays(dates.to, 1)}T00:00:00.000Z`);
    }
    const whereSql = baseWhere.length ? `WHERE ${baseWhere.join(" AND ")}` : "";
    const totals = await get(
      `SELECT
        COUNT(*) AS total_leads,
        SUM(CASE WHEN s.code = 'NEW' THEN 1 ELSE 0 END) AS new_leads,
        SUM(CASE WHEN l.assigned_to IS NULL THEN 1 ELSE 0 END) AS unassigned_leads,
        SUM(CASE WHEN l.assigned_to IS NOT NULL THEN 1 ELSE 0 END) AS assigned_leads,
        SUM(CASE WHEN s.category = 'WON' THEN 1 ELSE 0 END) AS conversions,
        SUM(CASE WHEN s.code = 'NOT_INTERESTED' THEN 1 ELSE 0 END) AS not_interested,
        SUM(CASE WHEN s.category = 'OPEN' THEN 1 ELSE 0 END) AS open_leads
       FROM leads l
       JOIN lead_statuses s ON s.id = l.status_id
       ${whereSql}`,
      baseParams
    );
    const followUpWhere = ["f.deleted_at IS NULL", "l.deleted_at IS NULL"];
    const followUpParams = [];
    if (req.query.worker_id) {
      followUpWhere.push("f.worker_id = ?");
      followUpParams.push(Number(req.query.worker_id));
    }
    if (dates.from) {
      followUpWhere.push("f.scheduled_date >= ?");
      followUpParams.push(dates.from);
    }
    if (dates.to) {
      followUpWhere.push("f.scheduled_date <= ?");
      followUpParams.push(dates.to);
    }
    const fuWhereSql = `WHERE ${followUpWhere.join(" AND ")}`;
    const fuCounts = await get(
      `SELECT
        SUM(CASE WHEN f.scheduled_date = '${today}' AND f.status NOT IN ${TERMINAL_SQL} THEN 1 ELSE 0 END) AS todays_follow_ups,
        SUM(CASE WHEN f.scheduled_date < '${today}' AND f.status NOT IN ${TERMINAL_SQL} THEN 1 ELSE 0 END) AS overdue_follow_ups,
        COUNT(*) AS total_follow_ups
       FROM follow_ups f JOIN leads l ON l.id = f.lead_id
       ${fuWhereSql}`,
      followUpParams
    );
    const activeWorkers2 = (await get(
      `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.code = 'WORKER' AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`
    )).c;
    const callScope = req.query.worker_id ? "AND cl.worker_id = ?" : "";
    const callParams = req.query.worker_id ? [Number(req.query.worker_id)] : [];
    const callsToday = await get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN cl.status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS connected,
              SUM(CASE WHEN cl.status IN ('MISSED','NO_ANSWER') THEN 1 ELSE 0 END) AS missed,
              COALESCE(SUM(cl.duration_seconds), 0) AS seconds
       FROM calls cl
       WHERE cl.deleted_at IS NULL AND substr(COALESCE(cl.started_at, cl.created_at), 1, 10) = '${today}' ${callScope}`,
      callParams
    );
    const pipeline = await get(
      `SELECT
         (SELECT COUNT(*) FROM quotations WHERE deleted_at IS NULL AND status NOT IN ('ACCEPTED','REJECTED','CANCELLED','EXPIRED')) AS open_quotations,
         (SELECT COALESCE(SUM(total_amount), 0) FROM quotations
            WHERE deleted_at IS NULL AND status NOT IN ('ACCEPTED','REJECTED','CANCELLED','EXPIRED')) AS open_quotation_amount,
         (SELECT COUNT(*) FROM bookings WHERE deleted_at IS NULL AND status NOT IN ('CANCELLED','COMPLETED')) AS active_bookings,
         (SELECT COALESCE(SUM(total_amount - paid_amount), 0) FROM bookings WHERE deleted_at IS NULL AND status != 'CANCELLED') AS outstanding_amount,
         (SELECT COALESCE(SUM(paid_amount), 0) FROM bookings WHERE deleted_at IS NULL AND status != 'CANCELLED') AS collected_amount`
    );
    const recentCalls = await all(
      `SELECT cl.id, cl.lead_id, cl.direction, cl.status, cl.phone_number, cl.started_at, cl.duration_seconds,
              cl.recording_available, l.lead_number, c.name AS customer_name, u.name AS worker_name
       FROM calls cl
       LEFT JOIN leads l ON l.id = cl.lead_id
       LEFT JOIN customers c ON c.id = cl.customer_id
       LEFT JOIN users u ON u.id = cl.worker_id
       WHERE cl.deleted_at IS NULL
       ORDER BY COALESCE(cl.started_at, cl.created_at) DESC LIMIT 6`
    );
    const leadsByStatus = await all(
      `SELECT s.code, s.name, s.color, s.category, COUNT(*) AS count
       FROM leads l JOIN lead_statuses s ON s.id = l.status_id
       ${whereSql} GROUP BY s.id ORDER BY s.sort_order`,
      baseParams
    );
    const leadsBySource = await all(
      `SELECT COALESCE(src.name, 'Unknown') AS name, COUNT(*) AS count
       FROM leads l
       JOIN lead_statuses s ON s.id = l.status_id
       LEFT JOIN lead_sources src ON src.id = l.source_id
       ${whereSql} GROUP BY src.id ORDER BY count DESC LIMIT 12`,
      baseParams
    );
    const trendFrom = dates.from ? dates.from : addDays(today, -13);
    const trendTo = dates.to ? dates.to : today;
    const trendWhere = [...dims.where, "l.deleted_at IS NULL", "l.created_at >= ?", "l.created_at < ?"];
    const trendParams = [
      ...dims.params,
      `${trendFrom}T00:00:00.000Z`,
      `${addDays(trendTo, 1)}T00:00:00.000Z`
    ];
    const trendRows = await all(
      `SELECT ${sqlLocalDate("l.created_at")} AS d, COUNT(*) AS c
       FROM leads l JOIN lead_statuses s ON s.id = l.status_id
       WHERE ${trendWhere.join(" AND ")} GROUP BY d`,
      trendParams
    );
    const trend = [];
    const trendMap = new Map(trendRows.map((r) => [r.d, Number(r.c)]));
    let cursor = trendFrom;
    let guard = 0;
    while (cursor <= trendTo && guard < 400) {
      trend.push({ date: cursor, count: trendMap.get(cursor) ?? 0 });
      cursor = addDays(cursor, 1);
      guard += 1;
    }
    const fuOutcomes = await all(
      `SELECT ${effectiveFuStatus("f.status", "f.scheduled_date").sql.replace(/\?/g, `'${today}'`)} AS status, COUNT(*) AS count
       FROM follow_ups f JOIN leads l ON l.id = f.lead_id
       ${fuWhereSql} GROUP BY 1 ORDER BY count DESC`,
      followUpParams
    );
    const recentLeads = await all(
      `SELECT l.id, l.lead_number, l.destination, l.priority, l.created_at, l.budget, l.currency,
              c.name AS customer_name, s.code AS status_code, s.name AS status_name, s.color AS status_color,
              u.name AS assignee_name
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses s ON s.id = l.status_id
       LEFT JOIN users u ON u.id = l.assigned_to
       ${whereSql} ORDER BY l.created_at DESC LIMIT 8`,
      baseParams
    );
    const listFuSelect = `
      SELECT f.id, f.lead_id, f.scheduled_date, f.scheduled_time, f.status, f.type, f.next_action,
             l.lead_number, l.destination, l.priority AS lead_priority,
             c.name AS customer_name, c.phone AS customer_phone, u.name AS worker_name
      FROM follow_ups f
      JOIN leads l ON l.id = f.lead_id
      JOIN customers c ON c.id = l.customer_id
      JOIN users u ON u.id = f.worker_id
      WHERE f.deleted_at IS NULL AND l.deleted_at IS NULL AND f.status NOT IN ${TERMINAL_SQL}`;
    const todaysFollowUps = await all(`${listFuSelect} AND f.scheduled_date = '${today}' ORDER BY f.scheduled_time ASC LIMIT 8`);
    const overdueFollowUps = await all(`${listFuSelect} AND f.scheduled_date < '${today}' ORDER BY f.scheduled_date ASC LIMIT 8`);
    const unassigned = await all(
      `SELECT l.id, l.lead_number, l.destination, l.priority, l.created_at,
              c.name AS customer_name, s.code AS status_code, s.color AS status_color, src.name AS source_name
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses s ON s.id = l.status_id
       LEFT JOIN lead_sources src ON src.id = l.source_id
       WHERE l.deleted_at IS NULL AND l.assigned_to IS NULL
       ORDER BY l.created_at ASC LIMIT 8`
    );
    ok(res, {
      totals: {
        total_leads: Number(totals.total_leads ?? 0),
        new_leads: Number(totals.new_leads ?? 0),
        unassigned_leads: Number(totals.unassigned_leads ?? 0),
        assigned_leads: Number(totals.assigned_leads ?? 0),
        open_leads: Number(totals.open_leads ?? 0),
        conversions: Number(totals.conversions ?? 0),
        not_interested: Number(totals.not_interested ?? 0),
        todays_follow_ups: Number(fuCounts.todays_follow_ups ?? 0),
        overdue_follow_ups: Number(fuCounts.overdue_follow_ups ?? 0),
        total_follow_ups: Number(fuCounts.total_follow_ups ?? 0),
        active_workers: activeWorkers2,
        calls_today: Number(callsToday.total ?? 0),
        calls_connected_today: Number(callsToday.connected ?? 0),
        calls_missed_today: Number(callsToday.missed ?? 0),
        open_quotations: Number(pipeline.open_quotations ?? 0),
        open_quotation_amount: Number(pipeline.open_quotation_amount ?? 0),
        active_bookings: Number(pipeline.active_bookings ?? 0),
        outstanding_amount: Number(pipeline.outstanding_amount ?? 0),
        collected_amount: Number(pipeline.collected_amount ?? 0)
      },
      charts: {
        leads_by_status: leadsByStatus.map((r) => ({
          code: r.code,
          name: r.name,
          color: r.color,
          category: r.category,
          count: Number(r.count)
        })),
        leads_by_source: leadsBySource.map((r) => ({ name: r.name, count: Number(r.count) })),
        leads_trend: trend,
        follow_up_outcomes: fuOutcomes.map((r) => ({ status: r.status, count: Number(r.count) }))
      },
      lists: {
        recent_leads: recentLeads,
        todays_follow_ups: todaysFollowUps,
        overdue_follow_ups: overdueFollowUps,
        unassigned_leads: unassigned,
        recent_calls: recentCalls
      },
      filters: { dates, today }
    });
  } catch (err) {
    next(err);
  }
});
dashboardRouter.get("/worker", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    if (!can(req, "dashboard:worker") && !can(req, "dashboard:admin")) throw forbidden();
    const workerId = can(req, "dashboard:admin") && req.query.worker_id ? Number(req.query.worker_id) : user.id;
    const today = todayStr();
    const stats = await get(
      `SELECT
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.assigned_to = ? AND l.deleted_at IS NULL
             AND s.category = 'OPEN'
             AND (
               l.id IN (SELECT lead_id FROM follow_ups WHERE deleted_at IS NULL AND status NOT IN ${TERMINAL_SQL} AND scheduled_date = '${today}')
               OR substr(COALESCE(l.next_follow_up_at, ''), 1, 10) = '${today}'
               OR EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id AND a.assigned_to = ? AND a.is_active = 1 AND substr(a.assigned_at, 1, 10) = '${today}')
             )) AS today_leads,
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category = 'OPEN') AS pending_leads,
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category IN ('WON','LOST')) AS completed_leads,
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category = 'WON') AS converted,
        (SELECT COUNT(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
           WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.code = 'NOT_INTERESTED') AS not_interested,
        (SELECT COUNT(*) FROM follow_ups
           WHERE worker_id = ? AND deleted_at IS NULL AND scheduled_date = '${today}' AND status NOT IN ${TERMINAL_SQL}) AS today_follow_ups,
        (SELECT COUNT(*) FROM follow_ups
           WHERE worker_id = ? AND deleted_at IS NULL AND scheduled_date < '${today}' AND status NOT IN ${TERMINAL_SQL}) AS overdue_follow_ups,
        (SELECT COUNT(*) FROM follow_ups
           WHERE worker_id = ? AND deleted_at IS NULL AND status IN ('COMPLETED','CONVERTED')) AS completed_follow_ups`,
      [workerId, workerId, workerId, workerId, workerId, workerId, workerId, workerId, workerId]
    );
    const todayLeads = await all(
      `SELECT l.id, l.lead_number, l.destination, l.priority, l.budget, l.currency, l.travel_start_date,
              l.next_follow_up_at, l.created_at, c.name AS customer_name, c.phone AS customer_phone,
              s.code AS status_code, s.name AS status_name, s.color AS status_color,
              (SELECT MIN(f.scheduled_date) FROM follow_ups f WHERE f.lead_id = l.id AND f.deleted_at IS NULL
                 AND f.status NOT IN ${TERMINAL_SQL}) AS next_fu_date
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses s ON s.id = l.status_id
       WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND s.category = 'OPEN'
         AND (
           l.id IN (SELECT lead_id FROM follow_ups WHERE deleted_at IS NULL AND status NOT IN ${TERMINAL_SQL} AND scheduled_date = '${today}')
           OR substr(COALESCE(l.next_follow_up_at, ''), 1, 10) = '${today}'
           OR EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id AND a.assigned_to = ? AND a.is_active = 1 AND substr(a.assigned_at, 1, 10) = '${today}')
         )
       ORDER BY CASE l.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, l.created_at DESC
       LIMIT 12`,
      [workerId, workerId]
    );
    const followUpSelect = `
      SELECT f.id, f.lead_id, f.scheduled_date, f.scheduled_time, f.status, f.type, f.next_action,
             l.lead_number, l.destination, l.priority AS lead_priority,
             c.name AS customer_name, c.phone AS customer_phone, u.name AS worker_name
      FROM follow_ups f
      JOIN leads l ON l.id = f.lead_id
      JOIN customers c ON c.id = l.customer_id
      JOIN users u ON u.id = f.worker_id
      WHERE f.deleted_at IS NULL AND l.deleted_at IS NULL AND f.worker_id = ? AND f.status NOT IN ${TERMINAL_SQL}`;
    const todaysFollowUps = await all(`${followUpSelect} AND f.scheduled_date = '${today}' ORDER BY f.scheduled_time ASC LIMIT 10`, [
      workerId
    ]);
    const overdueFollowUps = await all(
      `${followUpSelect} AND f.scheduled_date < '${today}' ORDER BY f.scheduled_date ASC LIMIT 10`,
      [workerId]
    );
    const activity = await all(
      `SELECT t.id, t.type, t.summary, t.created_at, t.lead_id, l.lead_number, c.name AS customer_name
       FROM lead_timeline t
       JOIN leads l ON l.id = t.lead_id
       JOIN customers c ON c.id = l.customer_id
       WHERE l.assigned_to = ? AND l.deleted_at IS NULL
       ORDER BY t.created_at DESC LIMIT 12`,
      [workerId]
    );
    const myCalls = await get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS connected,
              SUM(CASE WHEN status IN ('MISSED','NO_ANSWER') THEN 1 ELSE 0 END) AS missed
       FROM calls
       WHERE worker_id = ? AND deleted_at IS NULL AND substr(COALESCE(started_at, created_at), 1, 10) = '${today}'`,
      [workerId]
    );
    const todayCalls = await all(
      `SELECT cl.id, cl.lead_id, cl.direction, cl.status, cl.phone_number, cl.started_at, cl.duration_seconds,
              l.lead_number, c.name AS customer_name
       FROM calls cl
       LEFT JOIN leads l ON l.id = cl.lead_id
       LEFT JOIN customers c ON c.id = cl.customer_id
       WHERE cl.worker_id = ? AND cl.deleted_at IS NULL
         AND substr(COALESCE(cl.started_at, cl.created_at), 1, 10) = '${today}'
       ORDER BY COALESCE(cl.started_at, cl.created_at) DESC LIMIT 6`,
      [workerId]
    );
    ok(res, {
      stats: {
        today_leads: Number(stats.today_leads ?? 0),
        pending_leads: Number(stats.pending_leads ?? 0),
        completed: Number(stats.completed_leads ?? 0),
        converted: Number(stats.converted ?? 0),
        not_interested: Number(stats.not_interested ?? 0),
        today_follow_ups: Number(stats.today_follow_ups ?? 0),
        overdue_follow_ups: Number(stats.overdue_follow_ups ?? 0),
        completed_follow_ups: Number(stats.completed_follow_ups ?? 0),
        calls_today: Number(myCalls.total ?? 0),
        calls_connected_today: Number(myCalls.connected ?? 0),
        calls_missed_today: Number(myCalls.missed ?? 0)
      },
      lists: {
        today_leads: todayLeads,
        today_follow_ups: todaysFollowUps,
        overdue_follow_ups: overdueFollowUps,
        recent_activity: activity,
        today_calls: todayCalls
      },
      filters: { today }
    });
  } catch (err) {
    next(err);
  }
});

// src/modules/workload/workload.routes.ts
init_database();
init_errors();
import { Router as Router7 } from "express";
var workloadRouter = Router7();
var TERMINAL_SQL2 = `('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')`;
workloadRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const readAll = can(req, "leads:read_all") || can(req, "dashboard:admin");
    if (!readAll && !can(req, "dashboard:worker")) throw forbidden();
    const today = todayStr();
    const dates = resolvePeriodDates(
      String(req.query.period ?? "").trim() || void 0,
      String(req.query.date_from ?? "").trim() || void 0,
      String(req.query.date_to ?? "").trim() || void 0
    );
    const requestedWorker = Number(req.query.worker_id) || void 0;
    const workerId = readAll ? requestedWorker : user.id;
    const where = ["u.deleted_at IS NULL", "r.code = 'WORKER'"];
    const params = [];
    if (!readAll) {
      where.push("u.id = ?");
      params.push(user.id);
    } else if (workerId) {
      where.push("u.id = ?");
      params.push(workerId);
    }
    const statusFilter = String(req.query.status ?? "").trim();
    if (statusFilter) {
      where.push("u.status = ?");
      params.push(statusFilter);
    }
    const search = String(req.query.search ?? "").trim();
    if (search) {
      where.push(`(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`);
      params.push(`%${search.replace(/[%_]/g, (m) => `\\${m}`)}%`);
    }
    const workers = await all(
      `SELECT u.id, u.name, u.email, u.status
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE ${where.join(" AND ")}
       ORDER BY u.name COLLATE NOCASE ASC`,
      params
    );
    const rows = await Promise.all(
      workers.map(async (w) => {
        const assignmentWhere = ["a.assigned_to = ?", "a.is_active = 1", "l.deleted_at IS NULL"];
        const assignmentParams = [w.id];
        if (dates.from) {
          assignmentWhere.push("a.assigned_at >= ?");
          assignmentParams.push(`${dates.from}T00:00:00.000Z`);
        }
        if (dates.to) {
          assignmentWhere.push("a.assigned_at < ?");
          assignmentParams.push(`${dates.to}T00:00:00.000Z`);
        }
        const counts = await get(
          `SELECT
          COUNT(*) AS assigned,
          SUM(CASE WHEN s.category IN ('WON','LOST') THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN s.category = 'OPEN' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN s.category = 'OPEN' AND (
                l.id IN (SELECT lead_id FROM follow_ups WHERE deleted_at IS NULL AND status NOT IN ${TERMINAL_SQL2} AND scheduled_date < '${today}')
                OR substr(COALESCE(l.next_follow_up_at, ''), 1, 10) < '${today}'
              ) THEN 1 ELSE 0 END) AS overdue,
          SUM(CASE WHEN s.category = 'WON' THEN 1 ELSE 0 END) AS converted
         FROM lead_assignments a
         JOIN leads l ON l.id = a.lead_id
         JOIN lead_statuses s ON s.id = l.status_id
         WHERE ${assignmentWhere.join(" AND ")}`,
          assignmentParams
        );
        const fu = await get(
          `SELECT
           SUM(CASE WHEN scheduled_date = '${today}' AND status NOT IN ${TERMINAL_SQL2} THEN 1 ELSE 0 END) AS today,
           SUM(CASE WHEN scheduled_date < '${today}' AND status NOT IN ${TERMINAL_SQL2} THEN 1 ELSE 0 END) AS overdue,
           SUM(CASE WHEN status IN ('COMPLETED','CONVERTED') THEN 1 ELSE 0 END) AS done
         FROM follow_ups WHERE worker_id = ? AND deleted_at IS NULL`,
          [w.id]
        );
        return {
          worker_id: w.id,
          name: w.name,
          email: w.email,
          status: w.status,
          assigned: Number(counts.assigned ?? 0),
          completed: Number(counts.completed ?? 0),
          pending: Number(counts.pending ?? 0),
          overdue: Number(counts.overdue ?? 0),
          converted: Number(counts.converted ?? 0),
          follow_ups_today: Number(fu.today ?? 0),
          follow_ups_overdue: Number(fu.overdue ?? 0),
          follow_ups_done: Number(fu.done ?? 0)
        };
      })
    );
    ok(res, {
      period: dates,
      today,
      rows,
      totals: rows.reduce(
        (acc, r) => ({
          assigned: acc.assigned + r.assigned,
          completed: acc.completed + r.completed,
          pending: acc.pending + r.pending,
          overdue: acc.overdue + r.overdue,
          converted: acc.converted + r.converted,
          follow_ups_today: acc.follow_ups_today + r.follow_ups_today,
          follow_ups_overdue: acc.follow_ups_overdue + r.follow_ups_overdue
        }),
        {
          assigned: 0,
          completed: 0,
          pending: 0,
          overdue: 0,
          converted: 0,
          follow_ups_today: 0,
          follow_ups_overdue: 0
        }
      )
    });
  } catch (err) {
    next(err);
  }
});
workloadRouter.get("/today", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const readAll = can(req, "leads:read_all") || can(req, "dashboard:admin");
    if (!readAll && !can(req, "leads:read_own")) throw forbidden();
    const requested = Number(req.query.worker_id) || user.id;
    if (!readAll && requested !== user.id) throw forbidden();
    const today = todayStr();
    const rows = await all(
      `SELECT l.id, l.lead_number, l.destination, l.priority, l.travel_start_date, l.budget, l.currency,
              l.created_at, l.next_follow_up_at, c.name AS customer_name, c.phone AS customer_phone,
              s.code AS status_code, s.name AS status_name, s.color AS status_color,
              (SELECT MIN(f.scheduled_date) FROM follow_ups f WHERE f.lead_id = l.id AND f.deleted_at IS NULL
                 AND f.status NOT IN ${TERMINAL_SQL2}) AS next_fu_date
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses s ON s.id = l.status_id
       WHERE l.assigned_to = ? AND l.deleted_at IS NULL AND (
         l.id IN (SELECT lead_id FROM follow_ups WHERE deleted_at IS NULL AND status NOT IN ${TERMINAL_SQL2} AND scheduled_date = '${today}')
         OR substr(COALESCE(l.next_follow_up_at, ''), 1, 10) = '${today}'
         OR EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id AND a.assigned_to = ? AND a.is_active = 1 AND substr(a.assigned_at, 1, 10) = '${today}')
       )
       ORDER BY CASE l.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, l.created_at DESC
       LIMIT 50`,
      [requested, requested]
    );
    ok(res, rows);
  } catch (err) {
    next(err);
  }
});

// src/modules/meta/meta.routes.ts
init_database();
init_errors();
import { Router as Router8 } from "express";
import { z as z6 } from "zod";

// src/services/ai.ts
init_errors();
var NullAiProvider = class {
  code = "none";
  model = "";
  isConfigured() {
    return false;
  }
  async complete() {
    throw upstream("AI provider is not configured.");
  }
};
var HttpAiProvider = class {
  constructor(baseUrl, authEnv, model, code = "openai_compatible") {
    this.baseUrl = baseUrl;
    this.authEnv = authEnv;
    this.code = code;
    this.model = model;
  }
  baseUrl;
  authEnv;
  code;
  model;
  isConfigured() {
    return Boolean(this.baseUrl && this.model);
  }
  async complete(system, user) {
    const secret = this.authEnv ? process.env[this.authEnv] : void 0;
    const headers = { "Content-Type": "application/json" };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    let res;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0.2
        }),
        signal: AbortSignal.timeout(2e4)
      });
    } catch (err) {
      throw upstream(`AI provider unreachable: ${err.message}`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw upstream(`AI provider returned HTTP ${res.status}.`);
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      throw upstream("AI provider returned an unreadable response.");
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw upstream("AI provider returned no content.");
    return content.trim();
  }
};
async function getAiProvider() {
  const cfg = await aiConfig();
  if (cfg.enabled && cfg.provider !== "none" && cfg.base_url && cfg.model) {
    return new HttpAiProvider(cfg.base_url, cfg.auth_env, cfg.model, cfg.provider);
  }
  return new NullAiProvider();
}
async function aiStatus() {
  const cfg = await aiConfig();
  const provider = await getAiProvider();
  const configured = provider.isConfigured();
  return {
    configured,
    provider: cfg.provider,
    model: cfg.model,
    enabled: cfg.enabled,
    auth_env: cfg.auth_env,
    secret_present: Boolean(cfg.auth_env && process.env[cfg.auth_env]),
    reason: configured ? null : "Integration Not Configured"
  };
}

// src/modules/meta/meta.routes.ts
var metaRouter = Router8();
var sourceSchema = z6.object({
  name: z6.string().trim().min(2, "Name must be at least 2 characters").max(80),
  is_active: z6.boolean().optional(),
  sort_order: z6.number().int().min(0).max(9999).optional()
});
var statusSchema3 = z6.object({
  code: z6.string().trim().min(2).max(40).regex(/^[A-Z0-9_]+$/, "Code must be uppercase letters, numbers and underscores"),
  name: z6.string().trim().min(2).max(60),
  category: z6.enum(["OPEN", "WON", "LOST", "NEUTRAL"]).default("OPEN"),
  color: z6.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be a hex value like #2563eb").default("#64748b"),
  is_active: z6.boolean().optional(),
  sort_order: z6.number().int().min(0).max(9999).optional()
});
var statusPatchSchema = statusSchema3.partial().omit({ code: true });
var settingsSchema = z6.object({
  value: z6.any().refine((v) => JSON.stringify(v).length <= 2e4, "Setting value is too large")
});
var PUBLIC_SETTING_KEYS = /* @__PURE__ */ new Set([
  "trip_types",
  "requirements_options",
  "priorities",
  "follow_up_types",
  "currencies",
  "lead_number_prefix",
  "business"
]);
metaRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const statuses = await all("SELECT * FROM lead_statuses ORDER BY sort_order ASC, id ASC");
    const sources = await all("SELECT * FROM lead_sources ORDER BY sort_order ASC, id ASC");
    const canManageSettings = can(req, "settings:manage");
    const settings = await all("SELECT setting_key, value FROM settings");
    const options = {};
    for (const s of settings) {
      if (!canManageSettings && !PUBLIC_SETTING_KEYS.has(s.setting_key)) continue;
      try {
        options[s.setting_key] = JSON.parse(s.value);
      } catch {
        options[s.setting_key] = null;
      }
    }
    const roles = await all("SELECT id, code, name, description FROM roles ORDER BY id ASC");
    const permissions = await all("SELECT id, code, name, category FROM permissions ORDER BY category ASC, code ASC");
    ok(res, {
      statuses,
      sources,
      options,
      roles,
      permissions,
      follow_up_board: [
        { key: "PENDING", label: "Pending" },
        { key: "TODAY", label: "Today" },
        { key: "OVERDUE", label: "Overdue" },
        { key: "COMPLETED", label: "Completed" },
        { key: "CONVERTED", label: "Converted" },
        { key: "NOT_INTERESTED", label: "Not Interested" }
      ]
    });
  } catch (err) {
    next(err);
  }
});
metaRouter.post("/sources", requireAuth, requirePermission("settings:manage"), async (req, res, next) => {
  try {
    const body = meta(sourceSchema, req.body);
    const existing = await get("SELECT id FROM lead_sources WHERE lower(name) = lower(?)", [body.name]);
    if (existing) throw badRequest("A lead source with this name already exists.");
    const now = await nowISO();
    const maxOrder = (await get("SELECT COALESCE(MAX(sort_order), 0) AS n FROM lead_sources")).n;
    const id = (await run(
      "INSERT INTO lead_sources (name, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [body.name, body.is_active === false ? 0 : 1, body.sort_order ?? maxOrder + 10, now, now]
    )).lastInsertRowid;
    await audit(req, "LEAD_SOURCE_CREATED", "lead_source", id, { name: body.name });
    created(res, await get("SELECT * FROM lead_sources WHERE id = ?", [id]));
  } catch (err) {
    next(err);
  }
});
metaRouter.patch("/sources/:id", requireAuth, requirePermission("settings:manage"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await get("SELECT * FROM lead_sources WHERE id = ?", [id]);
    if (!existing) throw notFound("Lead source not found.");
    const body = meta(sourceSchema.partial(), req.body);
    await run("UPDATE lead_sources SET name = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?", [
      body.name ?? existing.name,
      body.is_active === void 0 ? existing.is_active : body.is_active ? 1 : 0,
      body.sort_order ?? existing.sort_order,
      await nowISO(),
      id
    ]);
    await audit(req, "LEAD_SOURCE_UPDATED", "lead_source", id, { changed: Object.keys(body) });
    ok(res, await get("SELECT * FROM lead_sources WHERE id = ?", [id]));
  } catch (err) {
    next(err);
  }
});
metaRouter.post("/statuses", requireAuth, requirePermission("settings:manage"), async (req, res, next) => {
  try {
    const body = meta(statusSchema3, req.body);
    const existing = await get("SELECT id FROM lead_statuses WHERE code = ?", [body.code]);
    if (existing) throw badRequest("A status with this code already exists.");
    const now = await nowISO();
    const maxOrder = (await get("SELECT COALESCE(MAX(sort_order), 0) AS n FROM lead_statuses")).n;
    const id = (await run(
      `INSERT INTO lead_statuses (code, name, category, color, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.code,
        body.name,
        body.category,
        body.color,
        body.is_active === false ? 0 : 1,
        body.sort_order ?? maxOrder + 10,
        now,
        now
      ]
    )).lastInsertRowid;
    await audit(req, "LEAD_STATUS_CREATED", "lead_status", id, { code: body.code });
    created(res, await get("SELECT * FROM lead_statuses WHERE id = ?", [id]));
  } catch (err) {
    next(err);
  }
});
metaRouter.patch("/statuses/:id", requireAuth, requirePermission("settings:manage"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await get("SELECT * FROM lead_statuses WHERE id = ?", [id]);
    if (!existing) throw notFound("Lead status not found.");
    const body = meta(statusPatchSchema, req.body);
    await run(
      "UPDATE lead_statuses SET name = ?, category = ?, color = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?",
      [
        body.name ?? existing.name,
        body.category ?? existing.category,
        body.color ?? existing.color,
        body.is_active === void 0 ? existing.is_active : body.is_active ? 1 : 0,
        body.sort_order ?? existing.sort_order,
        await nowISO(),
        id
      ]
    );
    await audit(req, "LEAD_STATUS_UPDATED", "lead_status", id, { changed: Object.keys(body) });
    ok(res, await get("SELECT * FROM lead_statuses WHERE id = ?", [id]));
  } catch (err) {
    next(err);
  }
});
metaRouter.get("/settings", requireAuth, requirePermission("settings:manage"), async (_req, res, next) => {
  try {
    const rows = await all(
      "SELECT setting_key, value, updated_at FROM settings ORDER BY setting_key ASC"
    );
    ok(
      res,
      rows.map((r) => ({
        key: r.setting_key,
        value: safeParse(r.value),
        updated_at: r.updated_at
      }))
    );
  } catch (err) {
    next(err);
  }
});
metaRouter.patch("/settings/:key", requireAuth, requirePermission("settings:manage"), async (req, res, next) => {
  try {
    const key = String(req.params.key);
    const existing = await get("SELECT setting_key FROM settings WHERE setting_key = ?", [key]);
    if (!existing) throw notFound("Setting not found.");
    const body = meta(settingsSchema, req.body);
    await run("UPDATE settings SET value = ?, updated_at = ? WHERE setting_key = ?", [
      JSON.stringify(body.value),
      await nowISO(),
      key
    ]);
    await audit(req, "SETTING_UPDATED", "setting", key, {});
    ok(res, { key, value: body.value });
  } catch (err) {
    next(err);
  }
});
metaRouter.post("/permissions/cache/reset", requireAuth, requirePermission("settings:manage"), async (req, res, next) => {
  try {
    invalidatePermissionCache();
    await audit(req, "PERMISSION_CACHE_RESET", "system", null, {});
    ok(res, { reset: true });
  } catch (err) {
    next(err);
  }
});
metaRouter.get("/integrations", requireAuth, requirePermission("settings:manage"), async (_req, res, next) => {
  try {
    ok(res, {
      telephony: await telephonyStatus(),
      channels: {
        whatsapp: await channelStatus("WHATSAPP"),
        email: await channelStatus("EMAIL"),
        sms: await channelStatus("SMS"),
        in_app: { configured: true, provider: "internal", base_url: "", secret_present: true }
      },
      ai: await aiStatus(),
      assignment: await assignmentConfig(),
      call_policy: await callPolicy(),
      reminders: await reminderConfig(),
      retention: await retentionConfig()
    });
  } catch (err) {
    next(err);
  }
});
function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// src/modules/audit/audit.routes.ts
init_database();
import { Router as Router9 } from "express";
var auditRouter = Router9();
auditRouter.get("/audit-logs", requireAuth, requirePermission("audit:read"), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query, 25, 200);
    const where = ["1 = 1"];
    const params = [];
    const search = String(req.query.search ?? "").trim();
    if (search) {
      where.push(
        `(a.action LIKE ? ESCAPE '\\' OR a.entity LIKE ? ESCAPE '\\' OR a.entity_id LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')`
      );
      const term = await likeTerm(search);
      params.push(term, term, term, term);
    }
    const actions = toArray(req.query.action);
    if (actions.length) {
      where.push(`a.action IN (${actions.map(() => "?").join(",")})`);
      params.push(...actions);
    }
    const entities = toArray(req.query.entity);
    if (entities.length) {
      where.push(`a.entity IN (${entities.map(() => "?").join(",")})`);
      params.push(...entities);
    }
    const userId = Number(req.query.user_id);
    if (userId) {
      where.push("a.user_id = ?");
      params.push(userId);
    }
    const dates = resolvePeriodDates(
      String(req.query.period ?? "").trim() || void 0,
      String(req.query.date_from ?? "").trim() || void 0,
      String(req.query.date_to ?? "").trim() || void 0
    );
    if (dates.from) {
      where.push("a.created_at >= ?");
      params.push(`${dates.from}T00:00:00.000Z`);
    }
    if (dates.to) {
      where.push("a.created_at < ?");
      params.push(`${dates.to}T00:00:00.000Z`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(
      `SELECT COUNT(*) AS c FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${whereSql}`,
      params
    )).c;
    const rows = await all(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.metadata, a.ip, a.created_at,
              u.id AS user_id, u.name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       ${whereSql} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    list(
      res,
      rows.map((r) => ({ ...r, metadata: safeParse2(r.metadata) })),
      buildMeta(page, limit, total)
    );
  } catch (err) {
    next(err);
  }
});
auditRouter.get("/audit-logs/actions", requireAuth, requirePermission("audit:read"), async (_req, res, next) => {
  try {
    const rows = await all(
      "SELECT action, COUNT(*) AS c FROM audit_logs GROUP BY action ORDER BY c DESC"
    );
    ok(res, rows.map((r) => ({ action: r.action, count: Number(r.c) })));
  } catch (err) {
    next(err);
  }
});
function safeParse2(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

// src/modules/notifications/notifications.routes.ts
init_database();
init_errors();
import { Router as Router10 } from "express";
var notificationsRouter = Router10();
notificationsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const unreadOnly = String(req.query.unread ?? "") === "1";
    const where = ["n.user_id = ?"];
    const params = [user.id];
    if (unreadOnly) where.push("n.read_at IS NULL");
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(`SELECT COUNT(*) AS c FROM notifications n ${whereSql}`, params)).c;
    const unread = (await get("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL", [
      user.id
    ])).c;
    const rows = await all(
      `SELECT n.* FROM notifications n ${whereSql} ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    list(res, rows, { ...buildMeta(page, limit, total), unread });
  } catch (err) {
    next(err);
  }
});
notificationsRouter.post("/read-all", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const result = await run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", [
      await nowISO(),
      user.id
    ]);
    ok(res, { updated: result.changes });
  } catch (err) {
    next(err);
  }
});
notificationsRouter.patch("/:id/read", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const id = Number(req.params.id);
    const row = await get("SELECT id FROM notifications WHERE id = ? AND user_id = ?", [id, user.id]);
    if (!row) throw notFound("Notification not found.");
    await run("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?", [await nowISO(), id]);
    ok(res, { read: true });
  } catch (err) {
    next(err);
  }
});

// src/modules/calls/calls.routes.ts
init_database();
init_errors();
import { Router as Router11, raw } from "express";
import { z as z7 } from "zod";
var callsRouter = Router11();
var CALL_SELECT = `
  SELECT cl.*, l.lead_number, l.assigned_to AS lead_assignee, l.destination AS lead_destination,
         c.name AS customer_name, c.phone AS customer_phone,
         w.name AS worker_name,
         fu.scheduled_date AS follow_up_date, fu.status AS follow_up_status, fu.scheduled_time AS follow_up_time
  FROM calls cl
  LEFT JOIN leads l ON l.id = cl.lead_id
  LEFT JOIN customers c ON c.id = cl.customer_id
  LEFT JOIN users w ON w.id = cl.worker_id
  LEFT JOIN follow_ups fu ON fu.id = cl.follow_up_id`;
function shapeCall(row) {
  return {
    id: row.id,
    lead_id: row.lead_id,
    lead_number: row.lead_number ?? null,
    lead_destination: row.lead_destination ?? null,
    lead_assignee: row.lead_assignee ?? null,
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? null,
    customer_phone: row.customer_phone ?? null,
    worker_id: row.worker_id,
    worker_name: row.worker_name ?? null,
    provider: row.provider,
    provider_call_id: row.provider_call_id ?? null,
    direction: row.direction,
    phone_number: row.phone_number ?? null,
    started_at: row.started_at ?? null,
    answered_at: row.answered_at ?? null,
    ended_at: row.ended_at ?? null,
    duration_seconds: row.duration_seconds ?? null,
    status: row.status,
    disposition: row.disposition ?? null,
    recording_available: Number(row.recording_available ?? 0) === 1,
    consent: row.consent ?? null,
    notes: row.notes ?? null,
    follow_up_id: row.follow_up_id ?? null,
    follow_up_date: row.follow_up_date ?? null,
    follow_up_time: row.follow_up_time ?? null,
    follow_up_status: row.follow_up_status ?? null,
    has_follow_up: Boolean(row.follow_up_id),
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
async function getCallRow(id) {
  return await get("SELECT * FROM calls WHERE id = ? AND deleted_at IS NULL", [id]);
}
async function loadCall(id, req) {
  const row = await getCallRow(id);
  if (!row) throw notFound("Call not found.");
  const user = req.user;
  if (!user) throw forbidden();
  if (!user.permissions.includes("calls:read_all") && row.worker_id !== user.id) {
    throw forbidden("You do not have access to this call.");
  }
  return row;
}
function assertCallWriteAccess(call, req) {
  const user = req.user;
  const allowed = user.permissions.includes("calls:update") || user.permissions.includes("calls:update_own") && call.worker_id === user.id;
  if (!allowed) throw forbidden("You cannot modify this call.");
}
async function resolveTargets(req, body) {
  let leadId = body.lead_id ?? null;
  let customerId = body.customer_id ?? null;
  if (leadId) {
    const lead = await loadLead(leadId, req);
    if (!customerId) customerId = lead.customer_id;
  } else if (customerId) {
    const customer = await get("SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL", [customerId]);
    if (!customer) throw notFound("Customer not found.");
    if (!can(req, "leads:read_all")) {
      const owned = await get(
        "SELECT COUNT(*) AS c FROM leads WHERE customer_id = ? AND assigned_to = ? AND deleted_at IS NULL",
        [customerId, currentUser(req).id]
      );
      if (!owned?.c) throw forbidden("You do not have access to this customer.");
    }
  }
  return { leadId, customerId };
}
async function phoneForTargets(leadId, customerId, explicit) {
  if (explicit) return explicit;
  if (leadId) {
    const row = await get(
      "SELECT c.phone FROM leads l JOIN customers c ON c.id = l.customer_id WHERE l.id = ?",
      [leadId]
    );
    if (row?.phone) return row.phone;
  }
  if (customerId) {
    const row = await get("SELECT phone FROM customers WHERE id = ?", [customerId]);
    if (row?.phone) return row.phone;
  }
  return null;
}
callsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const where = ["cl.deleted_at IS NULL"];
    const params = [];
    if (!can(req, "calls:read_all")) {
      where.push("cl.worker_id = ?");
      params.push(user.id);
    }
    const leadId = Number(req.query.lead_id);
    if (leadId) {
      where.push("cl.lead_id = ?");
      params.push(leadId);
    }
    const customerId = Number(req.query.customer_id);
    if (customerId) {
      where.push("cl.customer_id = ?");
      params.push(customerId);
    }
    const workerId = Number(req.query.worker_id);
    if (workerId && can(req, "calls:read_all")) {
      where.push("cl.worker_id = ?");
      params.push(workerId);
    }
    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`cl.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    const directions = toArray(req.query.direction);
    if (directions.length) {
      where.push(`cl.direction IN (${directions.map(() => "?").join(",")})`);
      params.push(...directions);
    }
    const search = String(req.query.search ?? "").trim();
    if (search) {
      where.push(
        `(cl.phone_number LIKE ? ESCAPE '\\' OR cl.notes LIKE ? ESCAPE '\\' OR l.lead_number LIKE ? ESCAPE '\\'
          OR c.name LIKE ? ESCAPE '\\' OR w.name LIKE ? ESCAPE '\\')`
      );
      const term = await likeTerm(search);
      params.push(term, term, term, term, term);
    }
    const dates = resolvePeriodDates(
      String(req.query.period ?? "").trim() || void 0,
      String(req.query.date_from ?? "").trim() || void 0,
      String(req.query.date_to ?? "").trim() || void 0
    );
    if (dates.from) {
      where.push("substr(COALESCE(cl.started_at, cl.created_at), 1, 10) >= ?");
      params.push(dates.from);
    }
    if (dates.to) {
      where.push("substr(COALESCE(cl.started_at, cl.created_at), 1, 10) <= ?");
      params.push(dates.to);
    }
    const sortMap = {
      recent: "COALESCE(cl.started_at, cl.created_at) DESC",
      oldest: "COALESCE(cl.started_at, cl.created_at) ASC",
      duration: "COALESCE(cl.duration_seconds, 0) DESC"
    };
    const orderSql = sortMap[String(req.query.sort ?? "recent")] ?? sortMap.recent;
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(`SELECT COUNT(*) AS c FROM calls cl
      LEFT JOIN leads l ON l.id = cl.lead_id
      LEFT JOIN customers c ON c.id = cl.customer_id
      LEFT JOIN users w ON w.id = cl.worker_id ${whereSql}`, params)).c;
    const rows = await all(`${CALL_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    list(res, rows.map(shapeCall), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
var createCallSchema = z7.object({
  lead_id: z7.number().int().positive().optional().nullable(),
  customer_id: z7.number().int().positive().optional().nullable(),
  worker_id: z7.number().int().positive().optional().nullable(),
  direction: z7.enum(["INBOUND", "OUTBOUND"]).default("OUTBOUND"),
  phone_number: z7.string().trim().max(40).optional().nullable(),
  status: z7.enum(["RINGING", "ANSWERED", "MISSED", "BUSY", "FAILED", "NO_ANSWER", "COMPLETED"]).default("COMPLETED"),
  started_at: z7.string().trim().max(40).optional().nullable(),
  answered_at: z7.string().trim().max(40).optional().nullable(),
  ended_at: z7.string().trim().max(40).optional().nullable(),
  duration_seconds: z7.number().int().min(0).max(86400 * 7).optional().nullable(),
  disposition: z7.string().trim().max(60).optional().nullable(),
  notes: z7.string().trim().max(4e3).optional().nullable(),
  provider: z7.string().trim().max(40).optional(),
  provider_call_id: z7.string().trim().max(120).optional().nullable()
});
callsRouter.post("/", requireAuth, requirePermission("calls:create"), async (req, res, next) => {
  try {
    const body = meta(createCallSchema, req.body);
    const user = currentUser(req);
    const { leadId, customerId } = await resolveTargets(req, body);
    let workerId = user.id;
    if (body.worker_id && body.worker_id !== user.id) {
      if (!can(req, "calls:read_all")) throw forbidden("You cannot log calls for another worker.");
      const target = await get("SELECT status FROM users WHERE id = ? AND deleted_at IS NULL", [body.worker_id]);
      if (!target) throw badRequest("Selected worker does not exist.");
      if (target.status !== "ACTIVE") throw badRequest("Selected worker is not active.");
      workerId = body.worker_id;
    }
    const policy = await callPolicy();
    const now = await nowISO();
    const startedAt = body.started_at ?? (body.status === "RINGING" ? null : now);
    const provider = body.provider ?? "manual";
    if (body.provider_call_id) {
      const clash = await get("SELECT id FROM calls WHERE provider = ? AND provider_call_id = ?", [
        provider,
        body.provider_call_id
      ]);
      if (clash) throw conflict("A call with this provider reference already exists.", { existing_id: clash.id });
    }
    const id = (await run(
      `INSERT INTO calls (lead_id, customer_id, worker_id, provider, provider_call_id, direction, phone_number,
        started_at, answered_at, ended_at, duration_seconds, status, disposition, notes, consent, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        leadId,
        customerId,
        workerId,
        provider,
        body.provider_call_id ?? null,
        body.direction,
        await phoneForTargets(leadId, customerId, body.phone_number),
        startedAt,
        body.answered_at ?? null,
        body.ended_at ?? null,
        body.duration_seconds ?? null,
        body.status,
        body.disposition ?? null,
        body.notes ?? null,
        policy.recording_mode === "DO_NOT_RECORD" ? "OPTED_OUT" : policy.recording_mode === "RECORD" ? "NOTICE_SHOWN" : "PROVIDER_DEFAULT",
        user.id,
        now,
        now
      ]
    )).lastInsertRowid;
    await finalizeCallCreation({ id, leadId, status: body.status, req, actorName: user.name });
    const row = await get(`${CALL_SELECT} WHERE cl.id = ?`, [id]);
    created(res, shapeCall(row));
  } catch (err) {
    next(err);
  }
});
async function finalizeCallCreation(opts) {
  const { id, leadId, status } = opts;
  const type = status === "MISSED" || status === "NO_ANSWER" ? TIMELINE_TYPES.CALL_MISSED : status === "RINGING" ? TIMELINE_TYPES.CALL_INITIATED : TIMELINE_TYPES.CALL_LOGGED;
  if (leadId) {
    await addTimelineEvent({
      leadId,
      type,
      actorId: opts.actorId ?? opts.req?.user?.id ?? null,
      summary: type === TIMELINE_TYPES.CALL_MISSED ? `Call missed (${status})` : type === TIMELINE_TYPES.CALL_INITIATED ? "Call initiated" : `Call ${status.toLowerCase()} (${status})`,
      metadata: { call_id: id, status }
    });
    if (status === "COMPLETED" || status === "ANSWERED") {
      await run("UPDATE leads SET last_contacted_at = ?, updated_at = ? WHERE id = ?", [await nowISO(), await nowISO(), leadId]);
    }
  }
  await audit(opts.req, "CALL_CREATED", "call", id, { status, lead_id: leadId });
  if (status === "MISSED" && leadId) {
    const lead = await get(
      "SELECT assigned_to, lead_number FROM leads WHERE id = ?",
      [leadId]
    );
    if (lead?.assigned_to) {
      await notify({
        userId: lead.assigned_to,
        type: "CALL_MISSED",
        title: `Missed call: ${lead.lead_number}`,
        body: `${opts.actorName ?? "A worker"} missed a call.`,
        entity: "lead",
        entityId: leadId,
        link: `/leads/${leadId}`
      });
    }
  }
}
callsRouter.get("/:id(\\d+)", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await loadCall(id, req);
    const row = await get(`${CALL_SELECT} WHERE cl.id = ?`, [id]);
    if (!row) throw notFound("Call not found.");
    ok(res, shapeCall(row));
  } catch (err) {
    next(err);
  }
});
var patchCallSchema = z7.object({
  status: z7.enum(["RINGING", "ANSWERED", "MISSED", "BUSY", "FAILED", "NO_ANSWER", "COMPLETED"]).optional(),
  disposition: z7.string().trim().max(60).optional().nullable(),
  notes: z7.string().trim().max(4e3).optional().nullable(),
  duration_seconds: z7.number().int().min(0).max(86400 * 7).optional().nullable(),
  answered_at: z7.string().trim().max(40).optional().nullable(),
  ended_at: z7.string().trim().max(40).optional().nullable()
}).partial();
callsRouter.patch("/:id(\\d+)", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await loadCall(id, req);
    assertCallWriteAccess(call, req);
    const body = meta(patchCallSchema, req.body);
    const fields = [];
    const params = [];
    for (const key of ["status", "disposition", "notes", "duration_seconds", "answered_at", "ended_at"]) {
      if (body[key] !== void 0) {
        fields.push(`${key} = ?`);
        params.push(body[key]);
      }
    }
    if (!fields.length) throw badRequest("No changes supplied.");
    fields.push("updated_at = ?");
    params.push(await nowISO(), id);
    await run(`UPDATE calls SET ${fields.join(", ")} WHERE id = ?`, params);
    await audit(req, "CALL_UPDATED", "call", id, { ...body });
    const row = await get(`${CALL_SELECT} WHERE cl.id = ?`, [id]);
    ok(res, shapeCall(row));
  } catch (err) {
    next(err);
  }
});
var nextActionSchema = z7.object({
  disposition: z7.string().trim().max(60).optional(),
  customer_response: z7.string().trim().max(2e3).optional().nullable(),
  next_action: z7.string().trim().max(500).optional().nullable(),
  lead_status: z7.string().trim().max(40).optional().nullable(),
  add_note: z7.string().trim().max(4e3).optional().nullable(),
  follow_up: z7.object({
    scheduled_date: z7.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
    scheduled_time: z7.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format").optional().nullable(),
    type: z7.string().trim().max(40).default("Call"),
    notes: z7.string().trim().max(2e3).optional().nullable()
  }).optional().nullable()
});
callsRouter.post("/:id(\\d+)/next-action", requireAuth, requirePermission("calls:create"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await loadCall(id, req);
    assertCallWriteAccess(call, req);
    const body = meta(nextActionSchema, req.body);
    const user = currentUser(req);
    const leadId = call.lead_id;
    if (!leadId && body.follow_up) throw badRequest("Attach the call to a lead before scheduling a follow-up.");
    const result = {};
    if (body.disposition !== void 0 || body.customer_response !== void 0) {
      const notes = [body.disposition ? `Disposition: ${body.disposition}` : "", body.customer_response ?? ""].filter(Boolean).join("\n");
      const existing = call.notes ? `${call.notes}
` : "";
      await run("UPDATE calls SET disposition = COALESCE(?, disposition), notes = ?, updated_at = ? WHERE id = ?", [
        body.disposition ?? null,
        notes ? `${existing}${notes}` : call.notes,
        await nowISO(),
        id
      ]);
      result.disposition = body.disposition ?? call.disposition;
    }
    if (body.add_note && leadId) {
      const noteId = (await run("INSERT INTO notes (lead_id, author_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
        leadId,
        user.id,
        body.add_note,
        await nowISO(),
        await nowISO()
      ])).lastInsertRowid;
      await addTimelineEvent({
        leadId,
        type: TIMELINE_TYPES.NOTE_ADDED,
        actorId: user.id,
        summary: "Note added after call",
        metadata: { note_id: noteId, call_id: id }
      });
      await audit(req, "NOTE_ADDED", "note", noteId, { lead_id: leadId, call_id: id });
      result.note_id = noteId;
    }
    if (body.lead_status && leadId) {
      const change = await changeLeadStatus({ leadId, toCode: body.lead_status, actorId: user.id, remark: body.customer_response ?? "Call outcome" });
      if (change) await audit(req, "LEAD_STATUS_CHANGED", "lead", leadId, { from: change.from, to: change.to, call_id: id });
      result.lead_status = change ? change.to : body.lead_status;
    }
    if (body.follow_up && leadId) {
      const fuId = await createFollowUpRecord({
        input: {
          lead_id: leadId,
          worker_id: call.worker_id,
          scheduled_date: body.follow_up.scheduled_date,
          scheduled_time: body.follow_up.scheduled_time ?? null,
          type: body.follow_up.type ?? "Call",
          notes: body.follow_up.notes ?? body.customer_response ?? null,
          next_action: body.next_action ?? null,
          customer_response: body.customer_response ?? null
        },
        user,
        canCrossAssign: can(req, "follow_ups:update") || call.worker_id === user.id,
        canScheduleOnAnyLead: can(req, "leads:read_all"),
        req
      });
      await run("UPDATE calls SET follow_up_id = ?, updated_at = ? WHERE id = ?", [fuId, await nowISO(), id]);
      result.follow_up_id = fuId;
    }
    await audit(req, "CALL_NEXT_ACTION", "call", id, {
      disposition: body.disposition ?? null,
      has_follow_up: Boolean(body.follow_up),
      lead_status: body.lead_status ?? null
    });
    const row = await get(`${CALL_SELECT} WHERE cl.id = ?`, [id]);
    ok(res, { call: shapeCall(row), ...result });
  } catch (err) {
    next(err);
  }
});
callsRouter.post("/initiate", requireAuth, requirePermission("calls:create"), async (req, res, next) => {
  try {
    const body = meta(
      z7.object({
        lead_id: z7.number().int().positive().optional().nullable(),
        customer_id: z7.number().int().positive().optional().nullable(),
        phone_number: z7.string().trim().max(40).optional().nullable()
      }),
      req.body
    );
    const user = currentUser(req);
    const { leadId, customerId } = await resolveTargets(req, body);
    const phone = await phoneForTargets(leadId, customerId, body.phone_number);
    if (!phone) throw badRequest("No phone number available for this lead or customer.");
    const provider = await getTelephonyProvider();
    const result = await provider.initiateCall({
      toNumber: phone,
      workerId: user.id,
      leadId,
      customerId
    });
    const policy = await callPolicy();
    const now = await nowISO();
    const id = (await run(
      `INSERT INTO calls (lead_id, customer_id, worker_id, provider, provider_call_id, direction, phone_number,
        started_at, status, consent, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'OUTBOUND', ?, ?, 'RINGING', ?, ?, ?, ?)`,
      [
        leadId,
        customerId,
        user.id,
        result.provider,
        result.providerCallId,
        phone,
        now,
        policy.recording_mode === "DO_NOT_RECORD" ? "OPTED_OUT" : policy.recording_mode === "RECORD" ? "NOTICE_SHOWN" : "PROVIDER_DEFAULT",
        user.id,
        now,
        now
      ]
    )).lastInsertRowid;
    await finalizeCallCreation({ id, leadId, status: "RINGING", req, actorName: user.name });
    await audit(req, "CALL_INITIATED", "call", id, { provider: result.provider, provider_call_id: result.providerCallId });
    const row = await get(`${CALL_SELECT} WHERE cl.id = ?`, [id]);
    created(res, shapeCall(row));
  } catch (err) {
    next(err);
  }
});
async function loadRecording(callId) {
  return await get(
    "SELECT * FROM call_recordings WHERE call_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
    [callId]
  );
}
callsRouter.get("/:id(\\d+)/recording", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await loadCall(id, req);
    const rec = await loadRecording(id);
    if (!rec) {
      ok(res, { available: false, reason: "No recording is attached to this call." });
      return;
    }
    ok(res, {
      available: rec.status === "AVAILABLE",
      status: rec.status,
      storage: rec.storage,
      duration_seconds: rec.duration_seconds,
      consent: rec.consent,
      retention_until: rec.retention_until,
      can_play: rec.status === "AVAILABLE" && can(req, "recordings:access")
    });
  } catch (err) {
    next(err);
  }
});
callsRouter.get("/:id(\\d+)/recording/stream", requireAuth, requirePermission("recordings:access"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await loadCall(id, req);
    const rec = await loadRecording(id);
    if (!rec || rec.status !== "AVAILABLE") throw notFound("Recording is not available.");
    if (rec.retention_until && rec.retention_until < todayStr()) {
      await run("UPDATE call_recordings SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?", [
        "DELETED",
        await nowISO(),
        await nowISO(),
        rec.id
      ]);
      throw notFound("This recording has passed the retention period.");
    }
    await audit(req, "RECORDING_ACCESSED", "call_recording", rec.id, { call_id: call.id, storage: rec.storage });
    if (rec.storage === "provider") {
      const provider = await getTelephonyProvider();
      const ticket = await provider.fetchRecordingUrl(String(rec.provider_recording_id ?? rec.id));
      if (!ticket) throw notFound("The provider no longer has this recording.");
      const upstreamRes = await fetch(ticket.url, { signal: AbortSignal.timeout(2e4) });
      if (!upstreamRes.ok || !upstreamRes.body) throw notFound("The recording could not be fetched.");
      res.setHeader("Content-Type", upstreamRes.headers.get("content-type") || "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      res.setHeader("Content-Length", String(buf.length));
      res.end(buf);
      return;
    }
    const fs5 = await import("node:fs");
    const { recordingPath: recordingPath2 } = await Promise.resolve().then(() => (init_documents(), documents_exports));
    const file = recordingPath2(String(rec.file_key ?? ""));
    if (!fs5.existsSync(file)) throw notFound("The recording file is missing.");
    res.setHeader("Content-Type", rec.mime_type || "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", String(fs5.statSync(file).size));
    fs5.createReadStream(file).pipe(res);
  } catch (err) {
    next(err);
  }
});
var attachRecordingSchema = z7.object({
  storage: z7.enum(["provider", "local"]).default("provider"),
  provider_recording_id: z7.string().trim().max(120).optional().nullable(),
  source_url: z7.string().trim().max(2e3).optional().nullable(),
  filename: z7.string().trim().max(180).optional().nullable(),
  mime_type: z7.string().trim().max(120).optional().nullable(),
  content_base64: z7.string().max(14e6).optional().nullable(),
  duration_seconds: z7.number().int().min(0).max(86400 * 7).optional().nullable()
});
async function attachRecordingToCall(opts) {
  const { call, req } = opts;
  const id = call.id;
  const now = await nowISO();
  const existing = await loadRecording(id);
  if (existing && existing.status === "AVAILABLE") throw conflict("A recording is already attached to this call.");
  const retentionDays = (await retentionConfig()).call_recordings_days || (await callPolicy()).retention_days;
  const retentionUntil = retentionDays > 0 ? new Date(Date.now() + retentionDays * 864e5).toISOString().slice(0, 10) : null;
  let recId;
  if (existing) {
    recId = existing.id;
    await run(
      `UPDATE call_recordings SET status = 'AVAILABLE', storage = ?, provider_recording_id = ?, source_url = ?,
         file_key = ?, mime_type = ?, duration_seconds = ?, retention_until = ?, updated_at = ?, deleted_at = NULL
       WHERE id = ?`,
      [
        opts.storage,
        opts.providerRecordingId ?? null,
        opts.sourceUrl ?? null,
        opts.fileKey,
        opts.mime,
        opts.durationSeconds ?? null,
        retentionUntil,
        now,
        existing.id
      ]
    );
  } else {
    recId = (await run(
      `INSERT INTO call_recordings (call_id, provider, provider_recording_id, storage, source_url, file_key,
         mime_type, duration_seconds, status, consent, retention_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, ?)`,
      [
        id,
        call.provider ?? "manual",
        opts.providerRecordingId ?? null,
        opts.storage,
        opts.sourceUrl ?? null,
        opts.fileKey,
        opts.mime,
        opts.durationSeconds ?? null,
        call.consent ?? null,
        retentionUntil,
        now,
        now
      ]
    )).lastInsertRowid;
  }
  await run("UPDATE calls SET recording_available = 1, updated_at = ? WHERE id = ?", [now, id]);
  if (call.lead_id) {
    await addTimelineEvent({
      leadId: call.lead_id,
      type: TIMELINE_TYPES.RECORDING_READY,
      actorId: opts.actorId,
      summary: "Call recording is available",
      metadata: { call_id: id, recording_id: recId }
    });
  }
  await notify({
    userId: call.worker_id,
    type: "CALL_RECORDING_READY",
    title: "Call recording ready",
    body: `Recording available for ${call.phone_number ?? "call"}${call.lead_number ? ` \xB7 ${call.lead_number}` : ""}.`,
    entity: "call",
    entityId: id,
    link: call.lead_id ? `/leads/${call.lead_id}#calls` : void 0
  });
  await audit(req, "RECORDING_ATTACHED", "call_recording", recId, { call_id: id, storage: opts.storage });
  return { id: recId };
}
callsRouter.post("/:id(\\d+)/recording", requireAuth, requirePermission("calls:create"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await loadCall(id, req);
    assertCallWriteAccess(call, req);
    const body = meta(attachRecordingSchema, req.body);
    const user = currentUser(req);
    let fileKey = null;
    let mime = body.mime_type ?? "audio/mpeg";
    if (body.storage === "local") {
      if (!body.content_base64) throw badRequest("Provide the recording content to upload.");
      const { parseBase64: parseBase642, saveRecordingFile: saveRecordingFile2 } = await Promise.resolve().then(() => (init_documents(), documents_exports));
      const parsed = parseBase642(body.content_base64);
      if (parsed.mime) mime = parsed.mime;
      fileKey = saveRecordingFile2(body.filename ?? `call-${id}`, mime, parsed.buffer);
    } else if (!body.source_url && !body.provider_recording_id) {
      throw badRequest("Provide a provider recording id or reference URL.");
    }
    const { id: recId } = await attachRecordingToCall({
      call,
      req,
      actorId: user.id,
      storage: body.storage,
      fileKey,
      mime,
      providerRecordingId: body.provider_recording_id ?? null,
      sourceUrl: body.source_url ?? null,
      durationSeconds: body.duration_seconds ?? null
    });
    created(res, { id: recId, available: true });
  } catch (err) {
    next(err);
  }
});
callsRouter.post(
  "/:id(\\d+)/recording/file",
  requireAuth,
  requirePermission("calls:create"),
  raw({ type: ["audio/*", "video/mp4", "application/octet-stream"], limit: "64mb" }),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const call = await loadCall(id, req);
      assertCallWriteAccess(call, req);
      const user = currentUser(req);
      const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!content.length) throw badRequest("No recording bytes were received.");
      const mime = String(req.header("x-mime-type") || "audio/mpeg").slice(0, 120);
      const filename = String(req.header("x-filename") || `call-${id}.bin`).slice(0, 180);
      const durationHeader = Number(req.header("x-duration-seconds"));
      const duration = Number.isFinite(durationHeader) && durationHeader >= 0 ? Math.trunc(durationHeader) : null;
      const { saveRecordingFile: saveRecordingFile2 } = await Promise.resolve().then(() => (init_documents(), documents_exports));
      const fileKey = saveRecordingFile2(filename, mime, content);
      const { id: recId } = await attachRecordingToCall({
        call,
        req,
        actorId: user.id,
        storage: "local",
        fileKey,
        mime,
        durationSeconds: duration
      });
      created(res, { id: recId, available: true, size_bytes: content.length });
    } catch (err) {
      next(err);
    }
  }
);
callsRouter.delete("/:id(\\d+)/recording", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await loadCall(id, req);
    assertCallWriteAccess(call, req);
    const rec = await loadRecording(id);
    if (!rec) throw notFound("No recording is attached to this call.");
    const now = await nowISO();
    await run("UPDATE call_recordings SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?", ["DELETED", now, now, rec.id]);
    await run("UPDATE calls SET recording_available = 0, updated_at = ? WHERE id = ?", [now, id]);
    await audit(req, "RECORDING_DELETED", "call_recording", rec.id, { call_id: id });
    ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});
callsRouter.get("/stats/summary", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const requestedWorker = Number(req.query.worker_id) || 0;
    const scopeAll = String(req.query.scope ?? "") === "all";
    const workerId = can(req, "calls:read_all") ? requestedWorker || (scopeAll ? 0 : user.id) : user.id;
    const workerClause = workerId ? "AND worker_id = ?" : "";
    const workerParams = workerId ? [workerId] : [];
    const dates = resolvePeriodDates(String(req.query.period ?? "").trim() || "today", void 0, void 0);
    const from = dates.from ?? todayStr();
    const to = dates.to ?? todayStr();
    const rows = await get(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS answered,
         SUM(CASE WHEN status IN ('MISSED','NO_ANSWER') THEN 1 ELSE 0 END) AS missed,
         SUM(CASE WHEN status IN ('RINGING','BUSY','FAILED') THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN direction = 'OUTBOUND' THEN 1 ELSE 0 END) AS outbound,
         SUM(CASE WHEN direction = 'INBOUND' THEN 1 ELSE 0 END) AS inbound,
         SUM(COALESCE(duration_seconds, 0)) AS total_seconds
       FROM calls
       WHERE deleted_at IS NULL
         ${workerClause}
         AND substr(COALESCE(started_at, created_at), 1, 10) BETWEEN ? AND ?`,
      [...workerParams, from, to]
    );
    const connected = (await get(
      `SELECT COUNT(*) AS c FROM calls WHERE deleted_at IS NULL
         ${workerClause}
         AND status IN ('ANSWERED','COMPLETED') AND COALESCE(duration_seconds,0) > 0
         AND substr(COALESCE(started_at, created_at), 1, 10) BETWEEN ? AND ?`,
      [...workerParams, from, to]
    )).c;
    ok(res, {
      period: { from, to },
      total: Number(rows.total ?? 0),
      answered: Number(rows.answered ?? 0),
      missed: Number(rows.missed ?? 0),
      failed: Number(rows.failed ?? 0),
      outbound: Number(rows.outbound ?? 0),
      inbound: Number(rows.inbound ?? 0),
      connected,
      total_seconds: Number(rows.total_seconds ?? 0)
    });
  } catch (err) {
    next(err);
  }
});

// src/modules/calls/webhooks.routes.ts
init_database();
init_errors();
import { Router as Router12 } from "express";
import crypto4 from "node:crypto";
import { z as z8 } from "zod";
var telephonyWebhooksRouter = Router12();
var eventSchema = z8.object({
  event_id: z8.string().trim().min(1).max(120),
  event_type: z8.string().trim().min(1).max(80),
  occurred_at: z8.string().trim().max(40).optional(),
  worker_id: z8.number().int().positive().optional(),
  lead_id: z8.number().int().positive().optional(),
  customer_id: z8.number().int().positive().optional(),
  call: z8.object({
    provider_call_id: z8.string().trim().min(1).max(120),
    direction: z8.enum(["INBOUND", "OUTBOUND"]).optional(),
    phone_number: z8.string().trim().max(40).optional().nullable(),
    status: z8.string().trim().max(30).optional(),
    started_at: z8.string().trim().max(40).optional().nullable(),
    answered_at: z8.string().trim().max(40).optional().nullable(),
    ended_at: z8.string().trim().max(40).optional().nullable(),
    duration_seconds: z8.number().int().min(0).max(86400 * 7).optional().nullable(),
    disposition: z8.string().trim().max(60).optional().nullable()
  }).passthrough().optional(),
  recording: z8.object({
    provider_recording_id: z8.string().trim().max(120).optional().nullable(),
    url: z8.string().trim().max(2e3).optional().nullable(),
    duration_seconds: z8.number().int().min(0).max(86400 * 7).optional().nullable()
  }).optional()
}).passthrough();
function timingSafeEquals(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto4.timingSafeEqual(bufA, bufB);
}
function verifyWebhookAuth(req, rawBody) {
  const secret = process.env[WEBHOOK_SECRET_ENV];
  if (!secret) {
    throw notConfigured(
      `Webhook authentication is not configured. Set the ${WEBHOOK_SECRET_ENV} environment variable.`
    );
  }
  const signature = String(req.headers["x-signature"] || req.headers["x-hub-signature-256"] || "");
  if (signature) {
    const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    const expected = crypto4.createHmac("sha256", secret).update(rawBody).digest("hex");
    if (!timingSafeEquals(provided.toLowerCase(), expected.toLowerCase())) {
      throw forbidden("Invalid webhook signature.");
    }
    return;
  }
  const token = String(
    req.headers["x-webhook-secret"] || (String(req.headers.authorization || "").startsWith("Bearer ") ? String(req.headers.authorization).slice(7) : "") || req.query.secret || ""
  );
  if (!token || !timingSafeEquals(token, secret)) throw forbidden("Invalid webhook secret.");
}
function mapEventToStatus(eventType) {
  const e = eventType.toLowerCase();
  if (e.includes("recording")) return null;
  if (e.includes("ring") || e.includes("initiat") || e.includes("dial")) return "RINGING";
  if (e.includes("no_answer") || e.includes("noanswer")) return "NO_ANSWER";
  if (e.includes("answer") || e.includes("pickup")) return "ANSWERED";
  if (e.includes("miss")) return "MISSED";
  if (e.includes("busy")) return "BUSY";
  if (e.includes("fail") || e.includes("error") || e.includes("reject")) return "FAILED";
  if (e.includes("completed") || e.includes("hangup") || e.includes("disconnect") || e.includes("end")) {
    return "COMPLETED";
  }
  return null;
}
function isUniqueViolation(err) {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint failed/i.test(err.message) || /Duplicate entry/i.test(err.message) || err.code === "23505" || err.code === "ER_DUP_ENTRY" || err.errno === 1062;
}
async function findCall(provider, providerCallId) {
  return await get("SELECT * FROM calls WHERE provider = ? AND provider_call_id = ? AND deleted_at IS NULL", [
    provider,
    providerCallId
  ]);
}
async function resolveWorker(event) {
  let leadId = event.lead_id ?? null;
  let workerId = event.worker_id ?? 0;
  if (leadId) {
    const lead = await get(
      "SELECT assigned_to, customer_id FROM leads WHERE id = ? AND deleted_at IS NULL",
      [leadId]
    );
    if (!lead) throw badRequest(`Unknown lead_id ${leadId} on webhook event.`);
    workerId = workerId || lead.assigned_to || 0;
  } else if (event.customer_id) {
    const lead = await get(
      `SELECT id, assigned_to FROM leads WHERE customer_id = ? AND deleted_at IS NULL
       ORDER BY COALESCE(last_contacted_at, created_at) DESC, id DESC LIMIT 1`,
      [event.customer_id]
    );
    if (lead) {
      leadId = lead.id;
      workerId = workerId || lead.assigned_to || 0;
    }
  }
  if (!workerId) {
    throw badRequest("Cannot attribute this call: include worker_id or lead_id in the webhook payload.");
  }
  const worker = await get(
    "SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL",
    [workerId]
  );
  if (!worker) throw badRequest(`Worker ${workerId} does not exist.`);
  if (worker.status !== "ACTIVE") throw badRequest(`Worker ${workerId} is not active.`);
  return { workerId, leadId };
}
async function processEvent(provider, event, req) {
  const callInfo = event.call;
  if (!callInfo && !event.recording) {
    throw badRequest("Webhook payload must include a call object.");
  }
  const providerCallId = callInfo?.provider_call_id;
  if (!providerCallId) throw badRequest("call.provider_call_id is required.");
  const incomingStatus = mapEventToStatus(event.event_type);
  const now = await nowISO();
  let call = await findCall(provider, providerCallId);
  let action;
  if (!call) {
    const { workerId, leadId } = await resolveWorker(event);
    const status = incomingStatus ?? callInfo?.status ?? "COMPLETED";
    const policy = await callPolicy();
    const newId = (await run(
      `INSERT INTO calls (lead_id, customer_id, worker_id, provider, provider_call_id, direction, phone_number,
        started_at, answered_at, ended_at, duration_seconds, status, disposition, consent, webhook_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        leadId,
        event.customer_id ?? null,
        workerId,
        provider,
        providerCallId,
        callInfo?.direction ?? "INBOUND",
        callInfo?.phone_number ?? null,
        callInfo?.started_at ?? event.occurred_at ?? now,
        callInfo?.answered_at ?? null,
        callInfo?.ended_at ?? null,
        callInfo?.duration_seconds ?? null,
        status,
        callInfo?.disposition ?? null,
        policy.recording_mode === "DO_NOT_RECORD" ? "OPTED_OUT" : policy.recording_mode === "RECORD" ? "NOTICE_SHOWN" : "PROVIDER_DEFAULT",
        event.event_id,
        now,
        now
      ]
    )).lastInsertRowid;
    await finalizeCallCreation({ id: newId, leadId, status, req, actorName: `Provider ${provider}` });
    call = await getCallRow(newId);
    action = "call_created";
  } else if (incomingStatus && incomingStatus !== call.status) {
    await run(
      `UPDATE calls SET status = ?, answered_at = COALESCE(?, answered_at), ended_at = COALESCE(?, ended_at),
         duration_seconds = COALESCE(?, duration_seconds), disposition = COALESCE(?, disposition),
         webhook_event_id = ?, updated_at = ? WHERE id = ?`,
      [
        incomingStatus,
        callInfo?.answered_at ?? (incomingStatus === "ANSWERED" ? now : null),
        callInfo?.ended_at ?? null,
        callInfo?.duration_seconds ?? null,
        callInfo?.disposition ?? null,
        event.event_id,
        now,
        call.id
      ]
    );
    await emitCallOutcome({ callId: call.id, leadId: call.lead_id, status: incomingStatus, req, actorName: `Provider ${provider}` });
    call = await getCallRow(call.id);
    action = "call_updated";
  } else if (callInfo) {
    await run(
      `UPDATE calls SET answered_at = COALESCE(?, answered_at), ended_at = COALESCE(?, ended_at),
         duration_seconds = COALESCE(?, duration_seconds), disposition = COALESCE(?, disposition),
         webhook_event_id = ?, updated_at = ? WHERE id = ?`,
      [
        callInfo.answered_at ?? null,
        callInfo.ended_at ?? null,
        callInfo.duration_seconds ?? null,
        callInfo.disposition ?? null,
        event.event_id,
        now,
        call.id
      ]
    );
    action = "call_updated";
  } else {
    action = "call_unchanged";
  }
  if (event.event_type.toLowerCase().includes("recording")) {
    if (!event.recording) throw badRequest("recording payload is required for recording events.");
    const existing = await loadRecording(call.id);
    if (!existing || existing.status !== "AVAILABLE") {
      await attachRecordingToCall({
        call,
        req,
        actorId: null,
        storage: "provider",
        fileKey: null,
        mime: "audio/mpeg",
        providerRecordingId: event.recording.provider_recording_id ?? event.recording.url ?? null,
        sourceUrl: event.recording.url ?? null,
        durationSeconds: event.recording.duration_seconds ?? null
      });
      action = "recording_attached";
    } else {
      action = "recording_already_attached";
    }
  }
  return { callId: call.id, action };
}
async function emitCallOutcome(opts) {
  const { callId, leadId, status } = opts;
  if (!leadId) return;
  const type = status === "MISSED" || status === "NO_ANSWER" ? TIMELINE_TYPES.CALL_MISSED : status === "RINGING" ? TIMELINE_TYPES.CALL_INITIATED : TIMELINE_TYPES.CALL_COMPLETED;
  await addTimelineEvent({
    leadId,
    type,
    actorId: null,
    summary: `Call ${status.toLowerCase()} (provider event)`,
    metadata: { call_id: callId, status, source: "provider_webhook" }
  });
  if (status === "COMPLETED" || status === "ANSWERED") {
    await run("UPDATE leads SET last_contacted_at = ?, updated_at = ? WHERE id = ?", [await nowISO(), await nowISO(), leadId]);
  }
  if (status === "MISSED") {
    const lead = await get(
      "SELECT assigned_to, lead_number FROM leads WHERE id = ?",
      [leadId]
    );
    if (lead?.assigned_to) {
      await notify({
        userId: lead.assigned_to,
        type: "CALL_MISSED",
        title: `Missed call: ${lead.lead_number}`,
        body: `${opts.actorName ?? "A provider"} reported a missed call.`,
        entity: "lead",
        entityId: leadId,
        link: `/leads/${leadId}`
      });
    }
  }
}
telephonyWebhooksRouter.post("/telephony/:provider", async (req, res, next) => {
  try {
    const provider = String(req.params.provider || "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(provider)) throw badRequest("Invalid provider code.");
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    verifyWebhookAuth(req, rawBody);
    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw badRequest("Webhook body must be valid JSON.");
    }
    const event = meta(eventSchema, payload);
    const now = await nowISO();
    let eventRowId;
    try {
      eventRowId = (await run(
        `INSERT INTO webhook_events (provider, event_id, event_type, signature, status, payload, received_at, created_at)
         VALUES (?, ?, ?, ?, 'RECEIVED', ?, ?, ?)`,
        [
          provider,
          event.event_id,
          event.event_type,
          String(req.headers["x-signature"] || req.headers["x-webhook-secret"] ? "signature" : "secret"),
          JSON.stringify(event),
          now,
          now
        ]
      )).lastInsertRowid;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const dup = await get(
          "SELECT id, status, call_id FROM webhook_events WHERE provider = ? AND event_id = ?",
          [provider, event.event_id]
        );
        ok(res, { duplicate: true, id: dup?.id ?? null, status: dup?.status ?? "DUPLICATE" });
        return;
      }
      throw err;
    }
    try {
      const result = await processEvent(provider, event, req);
      await run("UPDATE webhook_events SET status = ?, call_id = ?, processed_at = ? WHERE id = ?", [
        "PROCESSED",
        result.callId,
        await nowISO(),
        eventRowId
      ]);
      await audit(req, "WEBHOOK_PROCESSED", "webhook_event", eventRowId, {
        provider,
        event_type: event.event_type,
        call_id: result.callId,
        action: result.action
      });
      ok(res, { ok: true, call_id: result.callId, action: result.action });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Processing failed.";
      await run("UPDATE webhook_events SET status = ?, error = ?, processed_at = ? WHERE id = ?", [
        "FAILED",
        message,
        await nowISO(),
        eventRowId
      ]);
      if (err instanceof HttpError && err.status < 500) {
        ok(res, { ok: false, error: message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});
telephonyWebhooksRouter.get("/telephony/events", requireAuth, requirePermission("calls:read_all"), async (req, res, next) => {
  try {
    const where = ["1=1"];
    const params = [];
    const provider = String(req.query.provider ?? "").trim();
    if (provider) {
      where.push("provider = ?");
      params.push(provider);
    }
    const statuses = Array.isArray(req.query.status) ? req.query.status : typeof req.query.status === "string" && req.query.status ? [req.query.status] : [];
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    const search = String(req.query.search ?? "").trim();
    if (search) {
      where.push(`(event_id LIKE ? OR event_type LIKE ? OR provider LIKE ?)`);
      const term = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
      params.push(term, term, term);
    }
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(`SELECT COUNT(*) AS c FROM webhook_events ${whereSql}`, params)).c;
    const rows = await all(
      `SELECT id, provider, event_id, event_type, status, error, call_id, received_at, processed_at, created_at
       FROM webhook_events ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    list(res, rows, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});

// src/modules/quotations/quotations.routes.ts
init_database();
init_errors();
import { Router as Router14 } from "express";
import { z as z10 } from "zod";

// src/modules/bookings/bookings.routes.ts
init_database();
init_errors();
import { Router as Router13 } from "express";
import { z as z9 } from "zod";
var bookingsRouter = Router13();
var BOOKING_STATUSES = ["PENDING", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
var TRANSITIONS = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: []
};
var BOOKING_SELECT = `
  SELECT b.*, l.lead_number, c.name AS customer_name, c.phone AS customer_phone,
         q.quotation_number, w.name AS worker_name, cb.name AS created_by_name, ub.name AS updated_by_name
  FROM bookings b
  LEFT JOIN leads l ON l.id = b.lead_id
  JOIN customers c ON c.id = b.customer_id
  LEFT JOIN quotations q ON q.id = b.quotation_id
  LEFT JOIN users w ON w.id = b.worker_id
  LEFT JOIN users cb ON cb.id = b.created_by
  LEFT JOIN users ub ON ub.id = b.updated_by`;
function parseJson2(raw4, fallback) {
  if (!raw4) return fallback;
  try {
    return JSON.parse(raw4);
  } catch {
    return fallback;
  }
}
function shapeBooking(row) {
  return {
    id: row.id,
    booking_number: row.booking_number,
    lead_id: row.lead_id,
    lead_number: row.lead_number ?? null,
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? null,
    customer_phone: row.customer_phone ?? null,
    quotation_id: row.quotation_id ?? null,
    quotation_number: row.quotation_number ?? null,
    worker_id: row.worker_id,
    worker_name: row.worker_name ?? null,
    destination: row.destination ?? null,
    travel_start_date: row.travel_start_date ?? null,
    travel_end_date: row.travel_end_date ?? null,
    travelers: row.travelers ?? null,
    services: parseJson2(row.services, []),
    currency: row.currency ?? "INR",
    total_amount: Number(row.total_amount ?? 0),
    paid_amount: Number(row.paid_amount ?? 0),
    balance_due: Number(row.total_amount ?? 0) - Number(row.paid_amount ?? 0),
    payment_status: row.payment_status,
    status: row.status,
    status_history: parseJson2(row.status_history, []),
    notes: row.notes ?? null,
    booked_at: row.booked_at ?? null,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name ?? null,
    updated_by: row.updated_by ?? null,
    updated_by_name: row.updated_by_name ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
async function loadBooking(id, req) {
  const row = await get("SELECT * FROM bookings WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!row) throw notFound("Booking not found.");
  const user = req.user;
  if (!user) throw forbidden();
  if (!user.permissions.includes("bookings:read_all") && row.worker_id !== user.id && row.created_by !== user.id) {
    throw forbidden("You do not have access to this booking.");
  }
  return row;
}
function assertBookingWrite(b, req) {
  const user = req.user;
  if (user.permissions.includes("bookings:manage")) return;
  if (!user.permissions.includes("bookings:update_own")) throw forbidden("You cannot modify bookings.");
  if (b.worker_id !== user.id && b.created_by !== user.id) {
    throw forbidden("You can only modify bookings you own.");
  }
}
async function nextBookingNumber() {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "");
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await get(
      `SELECT COALESCE(MAX(CAST(substr(booking_number, length(?) + 1) AS INTEGER)), 0) AS n
       FROM bookings WHERE booking_number LIKE ?`,
      [`BK-${stamp}-`, `BK-${stamp}-%`]
    );
    const candidate = `BK-${stamp}-${String((row?.n ?? 0) + 1 + attempt).padStart(4, "0")}`;
    if (!await get("SELECT id FROM bookings WHERE booking_number = ?", [candidate])) return candidate;
  }
  return `BK-${stamp}-${Date.now().toString().slice(-6)}`;
}
async function recomputePayment(bookingId) {
  const booking = await get(
    "SELECT total_amount, currency FROM bookings WHERE id = ?",
    [bookingId]
  );
  const sums = await get(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE booking_id = ? AND deleted_at IS NULL AND currency = ?",
    [bookingId, booking?.currency ?? "INR"]
  );
  const paid = Number(sums?.paid ?? 0);
  const total = Number(booking?.total_amount ?? 0);
  const paymentStatus = paid <= 0 ? "UNPAID" : paid + 1e-3 >= total ? "PAID" : "PARTIAL";
  await run("UPDATE bookings SET paid_amount = ?, payment_status = ?, updated_at = ? WHERE id = ?", [
    paid,
    paymentStatus,
    await nowISO(),
    bookingId
  ]);
}
bookingsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const where = ["b.deleted_at IS NULL"];
    const params = [];
    if (!can(req, "bookings:read_all")) {
      where.push("(b.worker_id = ? OR b.created_by = ?)");
      params.push(user.id, user.id);
    }
    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`b.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    const paymentStatuses = toArray(req.query.payment_status);
    if (paymentStatuses.length) {
      where.push(`b.payment_status IN (${paymentStatuses.map(() => "?").join(",")})`);
      params.push(...paymentStatuses);
    }
    const customerId = Number(req.query.customer_id);
    if (customerId) {
      where.push("b.customer_id = ?");
      params.push(customerId);
    }
    const leadId = Number(req.query.lead_id);
    if (leadId) {
      where.push("b.lead_id = ?");
      params.push(leadId);
    }
    const workerId = Number(req.query.worker_id);
    if (workerId && can(req, "bookings:read_all")) {
      where.push("b.worker_id = ?");
      params.push(workerId);
    }
    const search = String(req.query.search ?? "").trim();
    if (search) {
      where.push(
        `(b.booking_number LIKE ? ESCAPE '\\' OR b.destination LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR q.quotation_number LIKE ? ESCAPE '\\')`
      );
      const term = await likeTerm(search);
      params.push(term, term, term, term);
    }
    const dates = resolvePeriodDates(
      String(req.query.period ?? "").trim() || void 0,
      String(req.query.date_from ?? "").trim() || void 0,
      String(req.query.date_to ?? "").trim() || void 0
    );
    if (dates.from) {
      where.push("substr(b.created_at, 1, 10) >= ?");
      params.push(dates.from);
    }
    if (dates.to) {
      where.push("substr(b.created_at, 1, 10) <= ?");
      params.push(dates.to);
    }
    const sortMap = {
      recent: "b.created_at DESC",
      oldest: "b.created_at ASC",
      amount: "b.total_amount DESC",
      travel: "b.travel_start_date IS NULL, b.travel_start_date ASC"
    };
    const orderSql = sortMap[String(req.query.sort ?? "recent")] ?? sortMap.recent;
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(
      `SELECT COUNT(*) AS c FROM bookings b
         JOIN customers c ON c.id = b.customer_id
         LEFT JOIN quotations q ON q.id = b.quotation_id ${whereSql}`,
      params
    )).c;
    const rows = await all(`${BOOKING_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    list(res, rows.map(shapeBooking), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
var createSchema3 = z9.object({
  lead_id: z9.number().int().positive().optional().nullable(),
  customer_id: z9.number().int().positive().optional().nullable(),
  quotation_id: z9.number().int().positive().optional().nullable(),
  worker_id: z9.number().int().positive().optional().nullable(),
  destination: z9.string().trim().max(160).optional().nullable(),
  travel_start_date: z9.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travel_end_date: z9.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travelers: z9.number().int().min(1).max(999).optional().nullable(),
  services: z9.array(z9.object({ name: z9.string().trim().min(1).max(200), amount: z9.number().min(0).optional() })).max(100).default([]),
  currency: z9.string().trim().max(8).default("INR"),
  total_amount: z9.number().min(0).max(1e9).default(0),
  notes: z9.string().trim().max(4e3).optional().nullable(),
  status: z9.enum(BOOKING_STATUSES).default("PENDING")
});
bookingsRouter.post("/", requireAuth, requirePermission("bookings:create"), async (req, res, next) => {
  try {
    const body = meta(createSchema3, req.body);
    const user = currentUser(req);
    let leadId = body.lead_id ?? null;
    let customerId = body.customer_id ?? null;
    let workerId = body.worker_id ?? null;
    let quotationId = body.quotation_id ?? null;
    let destination = body.destination ?? null;
    let travelStart = body.travel_start_date ?? null;
    let travelEnd = body.travel_end_date ?? null;
    let travelers = body.travelers ?? null;
    let total = body.total_amount;
    let currency = body.currency;
    if (quotationId) {
      const existing = await get(
        "SELECT id FROM bookings WHERE quotation_id = ? AND deleted_at IS NULL",
        [quotationId]
      );
      if (existing) throw conflict("A booking already exists for this quotation.");
      const q = await get("SELECT * FROM quotations WHERE id = ? AND deleted_at IS NULL", [quotationId]);
      if (!q) throw notFound("Quotation not found.");
      if (!can(req, "quotations:read_all") && q.worker_id !== user.id && q.created_by !== user.id) {
        throw forbidden("You do not have access to that quotation.");
      }
      leadId = leadId ?? q.lead_id;
      customerId = customerId ?? q.customer_id;
      workerId = workerId ?? q.worker_id;
      destination = destination ?? q.destination;
      travelStart = travelStart ?? q.travel_start_date;
      travelEnd = travelEnd ?? q.travel_end_date;
      travelers = travelers ?? q.travelers;
      total = Number(q.total_amount ?? 0);
      currency = currency || q.currency || "INR";
    } else if (leadId) {
      const lead = await loadLead(leadId, req);
      customerId = customerId ?? lead.customer_id;
      workerId = workerId ?? lead.assigned_to ?? user.id;
      destination = destination ?? lead.destination ?? null;
    }
    if (!customerId) throw badRequest("A customer (or lead, or quotation) is required.");
    const customer = await get("SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL", [customerId]);
    if (!customer) throw notFound("Customer not found.");
    if (workerId && workerId !== user.id && !can(req, "bookings:manage") && workerId !== (leadId ? (await loadLead(leadId, req)).assigned_to : null)) {
      throw forbidden("You cannot create bookings for another worker.");
    }
    if (!workerId) workerId = user.id;
    const worker = await get("SELECT status FROM users WHERE id = ? AND deleted_at IS NULL", [workerId]);
    if (!worker) throw badRequest("Selected worker does not exist.");
    if (worker.status !== "ACTIVE") throw badRequest("Selected worker is not active.");
    if (!quotationId && body.services.length > 0) {
      total = body.services.reduce((sum, s) => sum + Number(s.amount ?? 0), 0);
    }
    const now = await nowISO();
    const bookingId = await tx(async () => {
      const newId = (await run(
        `INSERT INTO bookings (booking_number, lead_id, customer_id, quotation_id, worker_id, destination,
        travel_start_date, travel_end_date, travelers, services, currency, total_amount, paid_amount,
        payment_status, status, status_history, notes, booked_at, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'UNPAID', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          await nextBookingNumber(),
          leadId,
          customerId,
          quotationId,
          workerId,
          destination,
          travelStart,
          travelEnd,
          travelers,
          JSON.stringify(body.services),
          currency,
          total,
          body.status,
          JSON.stringify(
            body.status === "PENDING" ? [] : [{ from: "PENDING", to: body.status, at: now, by: user.id, reason: "Created in this status" }]
          ),
          body.notes ?? null,
          now,
          user.id,
          user.id,
          now,
          now
        ]
      )).lastInsertRowid;
      if (leadId) {
        await addTimelineEvent({
          leadId,
          type: TIMELINE_TYPES.BOOKING_CREATED,
          actorId: user.id,
          summary: `Booking created (${String((await get("SELECT booking_number AS n FROM bookings WHERE id = ?", [Number(newId)])).n)})`,
          metadata: { booking_id: Number(newId), total_amount: total }
        });
      }
      await audit(req, "BOOKING_CREATED", "booking", Number(newId), {
        customer_id: customerId,
        lead_id: leadId,
        quotation_id: quotationId,
        total_amount: total
      });
      return Number(newId);
    });
    if (workerId !== user.id) {
      await notify({
        userId: workerId,
        type: "BOOKING_ASSIGNED",
        title: "New booking assigned",
        body: `${user.name} created a booking${destination ? ` for ${destination}` : ""}.`,
        entity: "booking",
        entityId: bookingId,
        link: `/bookings/${bookingId}`
      });
    }
    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [bookingId]);
    created(res, shapeBooking(row));
  } catch (err) {
    next(err);
  }
});
bookingsRouter.get("/:id(\\d+)", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await loadBooking(id, req);
    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [id]);
    if (!row) throw notFound("Booking not found.");
    ok(res, shapeBooking(row));
  } catch (err) {
    next(err);
  }
});
var patchSchema = z9.object({
  destination: z9.string().trim().max(160).optional().nullable(),
  travel_start_date: z9.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travel_end_date: z9.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travelers: z9.number().int().min(1).max(999).optional().nullable(),
  services: z9.array(z9.object({ name: z9.string().trim().min(1).max(200), amount: z9.number().min(0).optional() })).max(100).optional(),
  currency: z9.string().trim().max(8).optional(),
  total_amount: z9.number().min(0).max(1e9).optional(),
  notes: z9.string().trim().max(4e3).optional().nullable()
}).partial();
bookingsRouter.patch("/:id(\\d+)", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const booking = await loadBooking(id, req);
    assertBookingWrite(booking, req);
    const body = meta(patchSchema, req.body);
    const user = currentUser(req);
    const fields = [];
    const params = [];
    for (const key of ["destination", "travel_start_date", "travel_end_date", "travelers", "currency", "notes"]) {
      if (body[key] !== void 0) {
        fields.push(`${key} = ?`);
        params.push(body[key]);
      }
    }
    if (body.services !== void 0) {
      fields.push("services = ?");
      params.push(JSON.stringify(body.services));
    }
    if (body.total_amount !== void 0 || body.services !== void 0) {
      let newTotal;
      if (booking.quotation_id) {
        const q = await get("SELECT total_amount FROM quotations WHERE id = ?", [
          booking.quotation_id
        ]);
        newTotal = Number(q?.total_amount ?? booking.total_amount ?? 0);
        if (body.total_amount !== void 0 && Math.abs(newTotal - body.total_amount) > 1e-3) {
          throw badRequest("Total is derived from the linked quotation and cannot be changed here.");
        }
      } else if (body.services !== void 0 && body.services.length > 0) {
        newTotal = body.services.reduce((sum, s) => sum + Number(s.amount ?? 0), 0);
      } else if (body.total_amount !== void 0) {
        newTotal = body.total_amount;
      } else {
        newTotal = Number(booking.total_amount ?? 0);
      }
      const current = Number(booking.total_amount ?? 0);
      if (newTotal + 1e-3 < Number(booking.paid_amount ?? 0)) {
        throw badRequest("Total cannot be lower than the amount already paid.");
      }
      if (Math.abs(newTotal - current) > 1e-3) {
        fields.push("total_amount = ?");
        params.push(newTotal);
        await audit(req, "BOOKING_TOTAL_CHANGED", "booking", id, { from: current, to: newTotal });
      }
    }
    if (!fields.length) throw badRequest("No changes supplied.");
    fields.push("updated_by = ?", "updated_at = ?");
    params.push(user.id, await nowISO(), id);
    await tx(async () => {
      await run(`UPDATE bookings SET ${fields.join(", ")} WHERE id = ?`, params);
      if (fields.some((f) => f.startsWith("total_amount"))) await recomputePayment(id);
    });
    await audit(req, "BOOKING_UPDATED", "booking", id, { fields: Object.keys(body) });
    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [id]);
    ok(res, shapeBooking(row));
  } catch (err) {
    next(err);
  }
});
var statusSchema4 = z9.object({
  status: z9.enum(BOOKING_STATUSES),
  remark: z9.string().trim().max(500).optional().nullable()
});
bookingsRouter.post("/:id(\\d+)/status", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const booking = await loadBooking(id, req);
    assertBookingWrite(booking, req);
    const body = meta(statusSchema4, req.body);
    const user = currentUser(req);
    if (booking.status === body.status) throw conflict("Booking is already in that status.");
    const allowed = TRANSITIONS[booking.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw conflict(`Cannot move a ${booking.status} booking to ${body.status}.`, { allowed });
    }
    const now = await nowISO();
    const history = parseJson2(booking.status_history, []);
    history.push({
      from: booking.status,
      to: body.status,
      at: now,
      by: user.id,
      by_name: user.name,
      remark: body.remark ?? null
    });
    await run("UPDATE bookings SET status = ?, status_history = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      body.status,
      JSON.stringify(history),
      user.id,
      now,
      id
    ]);
    if (booking.lead_id) {
      await addTimelineEvent({
        leadId: booking.lead_id,
        type: TIMELINE_TYPES.BOOKING_STATUS_CHANGED,
        actorId: user.id,
        summary: `Booking ${booking.status} \u2192 ${body.status}${body.remark ? ` (${body.remark})` : ""}`,
        metadata: { booking_id: id, from: booking.status, to: body.status }
      });
    }
    await audit(req, "BOOKING_STATUS_CHANGED", "booking", id, {
      from: booking.status,
      to: body.status,
      remark: body.remark ?? null
    });
    if (booking.worker_id && booking.worker_id !== user.id) {
      await notify({
        userId: booking.worker_id,
        type: "BOOKING_STATUS_CHANGED",
        title: `Booking ${booking.booking_number} is now ${body.status}`,
        body: body.remark ?? `${user.name} updated the booking.`,
        entity: "booking",
        entityId: id,
        link: `/bookings/${id}`
      });
    }
    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [id]);
    ok(res, shapeBooking(row));
  } catch (err) {
    next(err);
  }
});
function shapePayment(row) {
  return {
    id: row.id,
    booking_id: row.booking_id,
    amount: Number(row.amount ?? 0),
    currency: row.currency ?? "INR",
    method: row.method ?? null,
    reference: row.reference ?? null,
    status: row.status,
    paid_at: row.paid_at ?? null,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name ?? null,
    created_at: row.created_at
  };
}
bookingsRouter.get("/:id(\\d+)/payments", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await loadBooking(id, req);
    const rows = await all(
      `SELECT p.*, u.name AS created_by_name FROM payments p
         LEFT JOIN users u ON u.id = p.created_by
       WHERE p.booking_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at DESC`,
      [id]
    );
    list(res, rows.map(shapePayment));
  } catch (err) {
    next(err);
  }
});
var paymentSchema = z9.object({
  amount: z9.number().positive().max(1e9),
  currency: z9.string().trim().max(8).optional(),
  method: z9.string().trim().max(40).optional().nullable(),
  reference: z9.string().trim().max(120).optional().nullable(),
  status: z9.enum(["RECORDED", "PENDING", "CONFIRMED"]).default("RECORDED"),
  paid_at: z9.string().trim().max(40).refine((v) => /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)), "paid_at must be a valid date").optional().nullable()
});
bookingsRouter.post("/:id(\\d+)/payments", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const booking = await loadBooking(id, req);
    assertBookingWrite(booking, req);
    if (booking.status === "CANCELLED") throw conflict("Payments cannot be added to a cancelled booking.");
    const body = meta(paymentSchema, req.body);
    const user = currentUser(req);
    const now = await nowISO();
    const balance = Number(booking.total_amount ?? 0) - Number(booking.paid_amount ?? 0);
    if (Number(booking.total_amount ?? 0) > 0 && body.amount > balance + 1e-3) {
      throw badRequest(
        `Payment exceeds the outstanding balance (${Math.max(balance, 0).toFixed(2)} ${booking.currency ?? "INR"}).`
      );
    }
    const paymentId = await tx(async () => {
      const createdId = (await run(
        `INSERT INTO payments (booking_id, amount, currency, method, reference, status, paid_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          body.amount,
          body.currency || booking.currency || "INR",
          body.method ?? null,
          body.reference ?? null,
          body.status,
          body.paid_at ?? now,
          user.id,
          now,
          now
        ]
      )).lastInsertRowid;
      await recomputePayment(id);
      return Number(createdId);
    });
    await audit(req, "PAYMENT_RECORDED", "payment", paymentId, {
      booking_id: id,
      amount: body.amount,
      method: body.method ?? null
    });
    if (booking.worker_id && booking.worker_id !== user.id) {
      await notify({
        userId: booking.worker_id,
        type: "PAYMENT_RECORDED",
        title: `Payment recorded for ${booking.booking_number}`,
        body: `${body.currency || booking.currency || "INR"} ${body.amount.toFixed(2)} recorded.`,
        entity: "booking",
        entityId: id,
        link: `/bookings/${id}`
      });
    }
    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [id]);
    created(res, { payment_id: paymentId, booking: shapeBooking(row) });
  } catch (err) {
    next(err);
  }
});
bookingsRouter.delete("/:id(\\d+)/payments/:paymentId(\\d+)", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const booking = await loadBooking(id, req);
    assertBookingWrite(booking, req);
    const paymentId = Number(req.params.paymentId);
    const payment = await get(
      "SELECT id FROM payments WHERE id = ? AND booking_id = ? AND deleted_at IS NULL",
      [paymentId, id]
    );
    if (!payment) throw notFound("Payment not found.");
    await tx(async () => {
      await run("UPDATE payments SET deleted_at = ?, updated_at = ? WHERE id = ?", [await nowISO(), await nowISO(), paymentId]);
      await recomputePayment(id);
    });
    await audit(req, "PAYMENT_VOIDED", "payment", paymentId, { booking_id: id });
    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [id]);
    ok(res, shapeBooking(row));
  } catch (err) {
    next(err);
  }
});
bookingsRouter.get("/stats/summary", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const scopeSelf = !can(req, "bookings:read_all");
    const rows = await all(
      `SELECT status, COUNT(*) AS c, COALESCE(SUM(total_amount), 0) AS amount, COALESCE(SUM(paid_amount), 0) AS paid
       FROM bookings
       WHERE deleted_at IS NULL ${scopeSelf ? "AND (worker_id = ? OR created_by = ?)" : ""}
       GROUP BY status`,
      scopeSelf ? [user.id, user.id] : []
    );
    const byStatus = {};
    for (const r of rows) {
      byStatus[r.status] = { count: Number(r.c), amount: Number(r.amount), paid: Number(r.paid) };
    }
    const payment = await get(
      `SELECT
         SUM(CASE WHEN payment_status = 'UNPAID' THEN 1 ELSE 0 END) AS unpaid,
         SUM(CASE WHEN payment_status = 'PARTIAL' THEN 1 ELSE 0 END) AS partial,
         SUM(CASE WHEN payment_status = 'PAID' THEN 1 ELSE 0 END) AS paid
       FROM bookings WHERE deleted_at IS NULL ${scopeSelf ? "AND (worker_id = ? OR created_by = ?)" : ""}`,
      scopeSelf ? [user.id, user.id] : []
    );
    ok(res, {
      by_status: byStatus,
      payment: { unpaid: Number(payment.unpaid ?? 0), partial: Number(payment.partial ?? 0), paid: Number(payment.paid ?? 0) }
    });
  } catch (err) {
    next(err);
  }
});

// src/modules/quotations/quotations.routes.ts
var quotationsRouter = Router14();
var QUOTE_STATUSES = ["DRAFT", "SENT", "VIEWED", "NEGOTIATION", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"];
var TRANSITIONS2 = {
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["VIEWED", "NEGOTIATION", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
  VIEWED: ["NEGOTIATION", "ACCEPTED", "REJECTED", "CANCELLED"],
  NEGOTIATION: ["SENT", "ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["CANCELLED"],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: []
};
var QUOT_SELECT = `
  SELECT q.*, l.lead_number, c.name AS customer_name, c.phone AS customer_phone,
         w.name AS worker_name, cb.name AS created_by_name, ub.name AS updated_by_name
  FROM quotations q
  JOIN leads l ON l.id = q.lead_id
  JOIN customers c ON c.id = q.customer_id
  LEFT JOIN users w ON w.id = q.worker_id
  LEFT JOIN users cb ON cb.id = q.created_by
  LEFT JOIN users ub ON ub.id = q.updated_by`;
function parseJson3(raw4, fallback) {
  if (!raw4) return fallback;
  try {
    return JSON.parse(raw4);
  } catch {
    return fallback;
  }
}
function shapeQuotation(row) {
  return {
    id: row.id,
    quotation_number: row.quotation_number,
    lead_id: row.lead_id,
    lead_number: row.lead_number ?? null,
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? null,
    customer_phone: row.customer_phone ?? null,
    worker_id: row.worker_id,
    worker_name: row.worker_name ?? null,
    destination: row.destination ?? null,
    travel_start_date: row.travel_start_date ?? null,
    travel_end_date: row.travel_end_date ?? null,
    travelers: row.travelers ?? null,
    accommodation: row.accommodation ?? null,
    transport: row.transport ?? null,
    activities: row.activities ?? null,
    inclusions: parseJson3(row.inclusions, []),
    exclusions: parseJson3(row.exclusions, []),
    items: parseJson3(row.items, []),
    currency: row.currency ?? "INR",
    total_amount: Number(row.total_amount ?? 0),
    notes: row.notes ?? null,
    valid_until: row.valid_until ?? null,
    status: row.status,
    status_history: parseJson3(row.status_history, []),
    sent_at: row.sent_at ?? null,
    accepted_at: row.accepted_at ?? null,
    rejected_at: row.rejected_at ?? null,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name ?? null,
    updated_by: row.updated_by ?? null,
    updated_by_name: row.updated_by_name ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
async function loadQuotation(id, req) {
  const row = await get("SELECT * FROM quotations WHERE id = ? AND deleted_at IS NULL", [id]);
  if (!row) throw notFound("Quotation not found.");
  const user = req.user;
  if (!user) throw forbidden();
  if (!user.permissions.includes("quotations:read_all") && row.worker_id !== user.id && row.created_by !== user.id) {
    throw forbidden("You do not have access to this quotation.");
  }
  return row;
}
function assertQuotationWrite(q, req) {
  const user = req.user;
  if (user.permissions.includes("quotations:manage")) return;
  if (!user.permissions.includes("quotations:update_own")) throw forbidden("You cannot modify quotations.");
  if (q.worker_id !== user.id && q.created_by !== user.id) {
    throw forbidden("You can only modify quotations you own.");
  }
}
async function nextQuotationNumber() {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "");
  const pattern = `QT-${stamp}-%`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await get(
      `SELECT COALESCE(MAX(CAST(substr(quotation_number, length(?) + 1) AS INTEGER)), 0) AS n
       FROM quotations WHERE quotation_number LIKE ?`,
      [`QT-${stamp}-`, pattern]
    );
    const candidate = `QT-${stamp}-${String((row?.n ?? 0) + 1 + attempt).padStart(4, "0")}`;
    if (!await get("SELECT id FROM quotations WHERE quotation_number = ?", [candidate])) return candidate;
  }
  return `QT-${stamp}-${Date.now().toString().slice(-6)}`;
}
var itemSchema = z10.object({
  description: z10.string().trim().min(1).max(300),
  quantity: z10.number().min(0).max(1e5).default(1),
  unit_price: z10.number().min(0).max(1e9).default(0),
  amount: z10.number().min(0).max(1e9).optional()
});
var createSchema4 = z10.object({
  lead_id: z10.number().int().positive(),
  worker_id: z10.number().int().positive().optional().nullable(),
  destination: z10.string().trim().max(160).optional().nullable(),
  travel_start_date: z10.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travel_end_date: z10.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travelers: z10.number().int().min(1).max(999).optional().nullable(),
  accommodation: z10.string().trim().max(500).optional().nullable(),
  transport: z10.string().trim().max(500).optional().nullable(),
  activities: z10.string().trim().max(1e3).optional().nullable(),
  inclusions: z10.array(z10.string().trim().max(300)).max(100).default([]),
  exclusions: z10.array(z10.string().trim().max(300)).max(100).default([]),
  items: z10.array(itemSchema).max(200).default([]),
  currency: z10.string().trim().max(8).default("INR"),
  notes: z10.string().trim().max(4e3).optional().nullable(),
  valid_until: z10.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable()
});
function totalFromItems(items) {
  return items.reduce((sum, it) => sum + (it.amount ?? it.quantity * it.unit_price), 0);
}
quotationsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    if (!can(req, "quotations:read_all") && !can(req, "quotations:read_own")) throw forbidden();
    const user = currentUser(req);
    const where = ["q.deleted_at IS NULL"];
    const params = [];
    if (!can(req, "quotations:read_all")) {
      where.push("(q.worker_id = ? OR q.created_by = ?)");
      params.push(user.id, user.id);
    }
    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`q.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    const leadId = Number(req.query.lead_id);
    if (leadId) {
      where.push("q.lead_id = ?");
      params.push(leadId);
    }
    const customerId = Number(req.query.customer_id);
    if (customerId) {
      where.push("q.customer_id = ?");
      params.push(customerId);
    }
    const workerId = Number(req.query.worker_id);
    if (workerId && can(req, "quotations:read_all")) {
      where.push("q.worker_id = ?");
      params.push(workerId);
    }
    const search = String(req.query.search ?? "").trim();
    if (search) {
      where.push(
        `(q.quotation_number LIKE ? ESCAPE '\\' OR q.destination LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR l.lead_number LIKE ? ESCAPE '\\')`
      );
      const term = await likeTerm(search);
      params.push(term, term, term, term);
    }
    const dates = resolvePeriodDates(
      String(req.query.period ?? "").trim() || void 0,
      String(req.query.date_from ?? "").trim() || void 0,
      String(req.query.date_to ?? "").trim() || void 0
    );
    if (dates.from) {
      where.push("substr(q.created_at, 1, 10) >= ?");
      params.push(dates.from);
    }
    if (dates.to) {
      where.push("substr(q.created_at, 1, 10) <= ?");
      params.push(dates.to);
    }
    const sortMap = {
      recent: "q.created_at DESC",
      oldest: "q.created_at ASC",
      amount: "q.total_amount DESC",
      valid: "q.valid_until IS NULL, q.valid_until ASC"
    };
    const orderSql = sortMap[String(req.query.sort ?? "recent")] ?? sortMap.recent;
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(
      `SELECT COUNT(*) AS c FROM quotations q
         JOIN customers c ON c.id = q.customer_id
         JOIN leads l ON l.id = q.lead_id ${whereSql}`,
      params
    )).c;
    const rows = await all(`${QUOT_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    list(res, rows.map(shapeQuotation), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
quotationsRouter.post("/", requireAuth, requirePermission("quotations:create"), async (req, res, next) => {
  try {
    const body = meta(createSchema4, req.body);
    const user = currentUser(req);
    const lead = await loadLead(body.lead_id, req);
    let workerId = body.worker_id ?? lead.assigned_to ?? user.id;
    if (workerId !== user.id && !can(req, "quotations:manage")) {
      if (!lead.assigned_to || workerId !== lead.assigned_to) {
        throw forbidden("You can only create quotations on leads assigned to you.");
      }
    }
    const worker = await get("SELECT status FROM users WHERE id = ? AND deleted_at IS NULL", [workerId]);
    if (!worker) throw badRequest("Selected worker does not exist.");
    const now = await nowISO();
    const id = (await run(
      `INSERT INTO quotations (quotation_number, lead_id, customer_id, worker_id, destination, travel_start_date,
        travel_end_date, travelers, accommodation, transport, activities, inclusions, exclusions, items, currency,
        total_amount, notes, valid_until, status, status_history, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', '[]', ?, ?, ?, ?)`,
      [
        await nextQuotationNumber(),
        lead.id,
        lead.customer_id,
        workerId,
        body.destination ?? lead.destination ?? null,
        body.travel_start_date ?? null,
        body.travel_end_date ?? null,
        body.travelers ?? null,
        body.accommodation ?? null,
        body.transport ?? null,
        body.activities ?? null,
        JSON.stringify(body.inclusions),
        JSON.stringify(body.exclusions),
        JSON.stringify(body.items),
        body.currency,
        totalFromItems(body.items),
        body.notes ?? null,
        body.valid_until ?? null,
        user.id,
        user.id,
        now,
        now
      ]
    )).lastInsertRowid;
    await addTimelineEvent({
      leadId: lead.id,
      type: TIMELINE_TYPES.QUOTATION_CREATED,
      actorId: user.id,
      summary: `Quotation created (${String((await get("SELECT quotation_number AS n FROM quotations WHERE id = ?", [id])).n)})`,
      metadata: { quotation_id: id, total_amount: totalFromItems(body.items) }
    });
    await audit(req, "QUOTATION_CREATED", "quotation", id, { lead_id: lead.id, total: totalFromItems(body.items) });
    if (workerId !== user.id) {
      await notify({
        userId: workerId,
        type: "QUOTATION_ASSIGNED",
        title: `Quotation prepared for ${lead.lead_number}`,
        body: `${user.name} prepared a quotation for ${lead.destination ?? "this lead"}.`,
        entity: "quotation",
        entityId: id,
        link: `/quotations/${id}`
      });
    }
    const row = await get(`${QUOT_SELECT} WHERE q.id = ?`, [id]);
    created(res, shapeQuotation(row));
  } catch (err) {
    next(err);
  }
});
quotationsRouter.get("/:id(\\d+)", requireAuth, async (req, res, next) => {
  try {
    if (!can(req, "quotations:read_all") && !can(req, "quotations:read_own")) throw forbidden();
    const id = Number(req.params.id);
    await loadQuotation(id, req);
    const row = await get(`${QUOT_SELECT} WHERE q.id = ?`, [id]);
    if (!row) throw notFound("Quotation not found.");
    ok(res, shapeQuotation(row));
  } catch (err) {
    next(err);
  }
});
var patchSchema2 = z10.object({
  destination: z10.string().trim().max(160).optional().nullable(),
  travel_start_date: z10.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travel_end_date: z10.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  travelers: z10.number().int().min(1).max(999).optional().nullable(),
  accommodation: z10.string().trim().max(500).optional().nullable(),
  transport: z10.string().trim().max(500).optional().nullable(),
  activities: z10.string().trim().max(1e3).optional().nullable(),
  inclusions: z10.array(z10.string().trim().max(300)).max(100).optional(),
  exclusions: z10.array(z10.string().trim().max(300)).max(100).optional(),
  items: z10.array(itemSchema).max(200).optional(),
  currency: z10.string().trim().max(8).optional(),
  notes: z10.string().trim().max(4e3).optional().nullable(),
  valid_until: z10.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable()
}).partial();
var CLOSED_STATUSES = ["ACCEPTED", "REJECTED", "CANCELLED", "EXPIRED"];
quotationsRouter.patch("/:id(\\d+)", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const q = await loadQuotation(id, req);
    assertQuotationWrite(q, req);
    if (CLOSED_STATUSES.includes(q.status) && !can(req, "quotations:manage")) {
      throw conflict(`A ${q.status.toLowerCase()} quotation cannot be edited.`);
    }
    const body = meta(patchSchema2, req.body);
    const user = currentUser(req);
    const fields = [];
    const params = [];
    const allowed = [
      "destination",
      "travel_start_date",
      "travel_end_date",
      "travelers",
      "accommodation",
      "transport",
      "activities",
      "currency",
      "notes",
      "valid_until"
    ];
    for (const key of allowed) {
      if (body[key] !== void 0) {
        fields.push(`${key} = ?`);
        params.push(body[key]);
      }
    }
    if (body.inclusions !== void 0) {
      fields.push("inclusions = ?");
      params.push(JSON.stringify(body.inclusions));
    }
    if (body.exclusions !== void 0) {
      fields.push("exclusions = ?");
      params.push(JSON.stringify(body.exclusions));
    }
    if (body.items !== void 0) {
      fields.push("items = ?");
      params.push(JSON.stringify(body.items));
      fields.push("total_amount = ?");
      params.push(totalFromItems(body.items));
    }
    if (!fields.length) throw badRequest("No changes supplied.");
    fields.push("updated_by = ?", "updated_at = ?");
    params.push(user.id, await nowISO(), id);
    await run(`UPDATE quotations SET ${fields.join(", ")} WHERE id = ?`, params);
    await audit(req, "QUOTATION_UPDATED", "quotation", id, { fields: Object.keys(body) });
    const row = await get(`${QUOT_SELECT} WHERE q.id = ?`, [id]);
    ok(res, shapeQuotation(row));
  } catch (err) {
    next(err);
  }
});
var statusSchema5 = z10.object({
  status: z10.enum(QUOTE_STATUSES),
  remark: z10.string().trim().max(500).optional().nullable()
});
quotationsRouter.post("/:id(\\d+)/status", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const q = await loadQuotation(id, req);
    assertQuotationWrite(q, req);
    const body = meta(statusSchema5, req.body);
    const user = currentUser(req);
    if (q.status === body.status) throw conflict("Quotation is already in that status.");
    const allowed = TRANSITIONS2[q.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw conflict(`Cannot move a ${q.status} quotation to ${body.status}.`, { allowed });
    }
    const now = await nowISO();
    const history = parseJson3(q.status_history, []);
    history.push({
      from: q.status,
      to: body.status,
      at: now,
      by: user.id,
      by_name: user.name,
      remark: body.remark ?? null
    });
    await run(
      `UPDATE quotations SET status = ?, status_history = ?, sent_at = COALESCE(sent_at, ?), accepted_at = ?,
         rejected_at = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [
        body.status,
        JSON.stringify(history),
        body.status === "SENT" ? now : null,
        body.status === "ACCEPTED" ? now : q.accepted_at,
        body.status === "REJECTED" ? now : q.rejected_at,
        user.id,
        now,
        id
      ]
    );
    if (q.lead_id) {
      const type = body.status === "SENT" ? TIMELINE_TYPES.QUOTATION_SENT : TIMELINE_TYPES.QUOTATION_STATUS_CHANGED;
      await addTimelineEvent({
        leadId: q.lead_id,
        type,
        actorId: user.id,
        summary: `Quotation ${q.status} \u2192 ${body.status}${body.remark ? ` (${body.remark})` : ""}`,
        metadata: { quotation_id: id, from: q.status, to: body.status }
      });
    }
    await audit(req, "QUOTATION_STATUS_CHANGED", "quotation", id, { from: q.status, to: body.status, remark: body.remark ?? null });
    if (q.worker_id && q.worker_id !== user.id) {
      await notify({
        userId: q.worker_id,
        type: "QUOTATION_STATUS_CHANGED",
        title: `${q.quotation_number} is now ${body.status}`,
        body: body.remark ?? `${user.name} changed the quotation status.`,
        entity: "quotation",
        entityId: id,
        link: `/quotations/${id}`
      });
    }
    const row = await get(`${QUOT_SELECT} WHERE q.id = ?`, [id]);
    ok(res, shapeQuotation(row));
  } catch (err) {
    next(err);
  }
});
quotationsRouter.post("/:id(\\d+)/convert", requireAuth, requirePermission("bookings:create"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const q = await loadQuotation(id, req);
    const user = currentUser(req);
    if (q.status !== "ACCEPTED") throw conflict("Only an accepted quotation can be converted to a booking.");
    let bookingNumber = "";
    const bookingId = await tx(async () => {
      const already = await get(
        "SELECT id, booking_number FROM bookings WHERE quotation_id = ? AND deleted_at IS NULL",
        [id]
      );
      if (already) throw conflict("This quotation has already been converted.", { booking_id: already.id });
      const now = await nowISO();
      const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "");
      for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = `BK-${stamp}-${String(attempt + 1).padStart(4, "0")}`;
        if (!await get("SELECT id FROM bookings WHERE booking_number = ?", [candidate])) {
          bookingNumber = candidate;
          break;
        }
      }
      if (!bookingNumber) bookingNumber = `BK-${stamp}-${Date.now().toString().slice(-6)}`;
      const newId = Number(
        (await run(
          `INSERT INTO bookings (booking_number, lead_id, customer_id, quotation_id, worker_id, destination,
            travel_start_date, travel_end_date, travelers, currency, total_amount, paid_amount, payment_status,
            status, status_history, notes, booked_at, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'UNPAID', 'CONFIRMED', ?, ?, ?, ?, ?, ?, ?)`,
          [
            bookingNumber,
            q.lead_id,
            q.customer_id,
            q.id,
            q.worker_id,
            q.destination ?? null,
            q.travel_start_date ?? null,
            q.travel_end_date ?? null,
            q.travelers ?? null,
            q.currency ?? "INR",
            Number(q.total_amount ?? 0),
            JSON.stringify([{ from: "PENDING", to: "CONFIRMED", at: now, by: user.id, reason: "Converted from quotation" }]),
            q.notes ?? null,
            now,
            user.id,
            user.id,
            now,
            now
          ]
        )).lastInsertRowid
      );
      if (q.lead_id) {
        await addTimelineEvent({
          leadId: q.lead_id,
          type: TIMELINE_TYPES.BOOKING_CREATED,
          actorId: user.id,
          summary: `Booking ${bookingNumber} created from ${q.quotation_number}`,
          metadata: { booking_id: newId, quotation_id: id }
        });
        const lead = await get("SELECT status_id FROM leads WHERE id = ?", [q.lead_id]);
        const converted = await get(`SELECT id FROM lead_statuses WHERE code = 'CONVERTED'`);
        if (lead && converted && lead.status_id !== converted.id) {
          await changeLeadStatus({
            leadId: q.lead_id,
            toCode: "CONVERTED",
            actorId: user.id,
            remark: `Booking ${bookingNumber}`,
            silent: true
          });
        }
      }
      await audit(req, "BOOKING_CREATED", "booking", newId, { quotation_id: id, lead_id: q.lead_id, booking_number: bookingNumber });
      return newId;
    });
    if (q.worker_id && q.worker_id !== user.id) {
      await notify({
        userId: q.worker_id,
        type: "BOOKING_CREATED",
        title: `Booking ${bookingNumber} created`,
        body: `Converted from quotation ${q.quotation_number}.`,
        entity: "booking",
        entityId: bookingId,
        link: `/bookings/${bookingId}`
      });
    }
    const row = await get(`${BOOKING_SELECT} WHERE b.id = ?`, [bookingId]);
    created(res, { booking_id: bookingId, booking_number: bookingNumber, data: row ? shapeBooking(row) : null });
  } catch (err) {
    next(err);
  }
});
quotationsRouter.get("/stats/summary", requireAuth, async (req, res, next) => {
  try {
    if (!can(req, "quotations:read_all") && !can(req, "quotations:read_own")) throw forbidden();
    const user = currentUser(req);
    const scopeSelf = !can(req, "quotations:read_all");
    const rows = await all(
      `SELECT status, COUNT(*) AS c, COALESCE(SUM(total_amount), 0) AS amount
       FROM quotations
       WHERE deleted_at IS NULL ${scopeSelf ? "AND (worker_id = ? OR created_by = ?)" : ""}
       GROUP BY status`,
      scopeSelf ? [user.id, user.id] : []
    );
    const byStatus = {};
    for (const r of rows) byStatus[r.status] = { count: Number(r.c), amount: Number(r.amount) };
    const expiring = (await get(
      `SELECT COUNT(*) AS c FROM quotations
       WHERE deleted_at IS NULL AND status IN ('SENT','VIEWED','NEGOTIATION')
         AND valid_until IS NOT NULL AND valid_until >= ? AND valid_until <= date('now', '+7 day')
         ${scopeSelf ? "AND (worker_id = ? OR created_by = ?)" : ""}`,
      scopeSelf ? [todayStr(), user.id, user.id] : [todayStr()]
    )).c;
    ok(res, { by_status: byStatus, expiring_in_7_days: expiring });
  } catch (err) {
    next(err);
  }
});

// src/modules/invoices/invoices.routes.ts
init_database();
init_errors();
import { Router as Router15 } from "express";
import { z as z11 } from "zod";
var invoicesRouter = Router15();
var INVOICE_STATUSES = ["DRAFT", "ISSUED", "PAID", "VOID"];
var TRANSITIONS3 = {
  DRAFT: ["ISSUED", "VOID"],
  ISSUED: ["PAID", "VOID"],
  PAID: ["VOID"],
  VOID: []
};
var INVOICE_SELECT = `
  SELECT i.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         b.booking_number, q.quotation_number, l.lead_number,
         w.name AS worker_name, cb.name AS created_by_name,
         CASE WHEN i.booking_id IS NOT NULL
           THEN COALESCE((SELECT SUM(p.amount) FROM payments p
                          WHERE p.booking_id = i.booking_id AND p.deleted_at IS NULL), 0)
           ELSE i.paid_amount END AS live_paid_amount
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
  LEFT JOIN bookings b ON b.id = i.booking_id
  LEFT JOIN quotations q ON q.id = i.quotation_id
  LEFT JOIN leads l ON l.id = i.lead_id
  LEFT JOIN users w ON w.id = i.worker_id
  LEFT JOIN users cb ON cb.id = i.created_by`;
function parseJson4(raw4, fallback) {
  if (!raw4) return fallback;
  try {
    return JSON.parse(raw4);
  } catch {
    return fallback;
  }
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function shapeInvoice(row) {
  const total = Number(row.total_amount ?? 0);
  const paid = Number(row.live_paid_amount ?? row.paid_amount ?? 0);
  return {
    id: row.id,
    invoice_number: row.invoice_number,
    booking_id: row.booking_id ?? null,
    booking_number: row.booking_number ?? null,
    quotation_id: row.quotation_id ?? null,
    quotation_number: row.quotation_number ?? null,
    lead_id: row.lead_id ?? null,
    lead_number: row.lead_number ?? null,
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? null,
    customer_email: row.customer_email ?? null,
    customer_phone: row.customer_phone ?? null,
    worker_id: row.worker_id ?? null,
    worker_name: row.worker_name ?? null,
    issue_date: row.issue_date,
    due_date: row.due_date ?? null,
    items: parseJson4(row.items, []),
    currency: row.currency ?? "INR",
    subtotal: Number(row.subtotal ?? 0),
    tax_rate: Number(row.tax_rate ?? 0),
    tax_amount: Number(row.tax_amount ?? 0),
    total_amount: total,
    paid_amount: paid,
    balance_due: round2(total - paid),
    status: row.status,
    notes: row.notes ?? null,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
function canWrite(req, invoice) {
  if (can(req, "invoices:manage")) return true;
  if (!can(req, "invoices:update_own")) return false;
  const user = currentUser(req);
  return invoice.worker_id === user.id || invoice.created_by === user.id;
}
async function loadInvoice(id, req) {
  const row = await get(
    `SELECT i.*, c.name AS customer_name,
            CASE WHEN i.booking_id IS NOT NULL
              THEN COALESCE((SELECT SUM(p.amount) FROM payments p
                             WHERE p.booking_id = i.booking_id AND p.deleted_at IS NULL), 0)
              ELSE i.paid_amount END AS live_paid_amount
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE i.id = ? AND i.deleted_at IS NULL`,
    [id]
  );
  if (!row) throw notFound("Invoice not found.");
  if (!can(req, "invoices:read_all") && row.worker_id !== currentUser(req).id && row.created_by !== currentUser(req).id) {
    throw notFound("Invoice not found.");
  }
  return row;
}
invoicesRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const user = currentUser(req);
    if (!can(req, "invoices:read_all") && !can(req, "invoices:read_own")) throw forbidden();
    const where = ["i.deleted_at IS NULL"];
    const params = [];
    if (!can(req, "invoices:read_all")) {
      where.push("(i.worker_id = ? OR i.created_by = ?)");
      params.push(user.id, user.id);
    }
    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`i.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    const bookingId = Number(req.query.booking_id);
    if (bookingId) {
      where.push("i.booking_id = ?");
      params.push(bookingId);
    }
    const customerId = Number(req.query.customer_id);
    if (customerId) {
      where.push("i.customer_id = ?");
      params.push(customerId);
    }
    const workerId = Number(req.query.worker_id);
    if (workerId && can(req, "invoices:read_all")) {
      where.push("i.worker_id = ?");
      params.push(workerId);
    }
    const search = String(req.query.search ?? "").trim();
    if (search) {
      where.push(`(i.invoice_number LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR b.booking_number LIKE ? ESCAPE '\\')`);
      const term = await likeTerm(search);
      params.push(term, term, term);
    }
    const dates = resolvePeriodDates(
      String(req.query.period ?? "").trim() || void 0,
      String(req.query.date_from ?? "").trim() || void 0,
      String(req.query.date_to ?? "").trim() || void 0
    );
    if (dates.from) {
      where.push("i.issue_date >= ?");
      params.push(dates.from);
    }
    if (dates.to) {
      where.push("i.issue_date <= ?");
      params.push(dates.to);
    }
    const sortMap = {
      recent: "i.created_at DESC",
      oldest: "i.created_at ASC",
      amount: "i.total_amount DESC",
      due: "i.due_date IS NULL, i.due_date ASC"
    };
    const orderSql = sortMap[String(req.query.sort ?? "recent")] ?? sortMap.recent;
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(
      `SELECT COUNT(*) AS c FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN bookings b ON b.id = i.booking_id ${whereSql}`,
      params
    )).c;
    const rows = await all(`${INVOICE_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset
    ]);
    const shaped = rows.map(shapeInvoice);
    const totalsRow = await get(
      `SELECT COALESCE(SUM(i.total_amount), 0) AS total_amount,
              COALESCE(SUM(CASE WHEN i.booking_id IS NOT NULL
                THEN COALESCE((SELECT SUM(p.amount) FROM payments p
                               WHERE p.booking_id = i.booking_id AND p.deleted_at IS NULL), 0)
                ELSE i.paid_amount END), 0) AS paid_amount
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN bookings b ON b.id = i.booking_id ${whereSql}`,
      params
    );
    const totals = {
      total_amount: round2(Number(totalsRow.total_amount ?? 0)),
      paid_amount: round2(Number(totalsRow.paid_amount ?? 0)),
      balance_due: round2(Number(totalsRow.total_amount ?? 0) - Number(totalsRow.paid_amount ?? 0)),
      count: total
    };
    list(res, shaped, { ...buildMeta(page, limit, total), totals });
  } catch (err) {
    next(err);
  }
});
invoicesRouter.get("/:id(\\d+)", requireAuth, async (req, res, next) => {
  try {
    const row = await get(`${INVOICE_SELECT} WHERE i.id = ? AND i.deleted_at IS NULL`, [
      Number(req.params.id)
    ]);
    if (!row) throw notFound("Invoice not found.");
    if (!can(req, "invoices:read_all") && row.worker_id !== currentUser(req).id && row.created_by !== currentUser(req).id) {
      throw notFound("Invoice not found.");
    }
    ok(res, shapeInvoice(row));
  } catch (err) {
    next(err);
  }
});
var itemSchema2 = z11.object({
  description: z11.string().trim().min(1, "Item description is required").max(300),
  qty: z11.number().min(0.01).max(1e5).default(1),
  unit_price: z11.number().min(0).max(1e9)
});
var createSchema5 = z11.object({
  customer_id: z11.number().int().positive("Customer is required"),
  booking_id: z11.number().int().positive().optional().nullable(),
  quotation_id: z11.number().int().positive().optional().nullable(),
  lead_id: z11.number().int().positive().optional().nullable(),
  worker_id: z11.number().int().positive().optional().nullable(),
  issue_date: z11.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Issue date must be YYYY-MM-DD").default(() => todayStr()),
  due_date: z11.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must be YYYY-MM-DD").optional().nullable(),
  items: z11.array(itemSchema2).min(1, "Add at least one line item").max(200),
  tax_rate: z11.number().min(0).max(100).default(0),
  currency: z11.string().trim().max(8).default("INR"),
  notes: z11.string().trim().max(4e3).optional().nullable()
});
invoicesRouter.post("/", requireAuth, requirePermission("invoices:create"), async (req, res, next) => {
  try {
    const body = meta(createSchema5, req.body);
    const user = currentUser(req);
    const customer = await get("SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL", [
      body.customer_id
    ]);
    if (!customer) throw badRequest("Customer not found.");
    let currency = body.currency;
    let workerId = body.worker_id ?? null;
    if (body.booking_id) {
      const booking = await get(
        "SELECT id, customer_id, worker_id, currency, booking_number FROM bookings WHERE id = ? AND deleted_at IS NULL",
        [body.booking_id]
      );
      if (!booking) throw badRequest("Booking not found.");
      if (booking.customer_id !== body.customer_id) {
        throw badRequest("The invoice customer must match the booking customer.");
      }
      if (!can(req, "bookings:read_all") && booking.worker_id !== user.id) {
        throw forbidden();
      }
      currency = booking.currency;
      workerId = workerId ?? booking.worker_id;
    }
    if (body.quotation_id) {
      const quotation = await get(
        "SELECT id, customer_id, worker_id FROM quotations WHERE id = ? AND deleted_at IS NULL",
        [body.quotation_id]
      );
      if (!quotation) throw badRequest("Quotation not found.");
      if (quotation.customer_id !== body.customer_id) {
        throw badRequest("The invoice customer must match the quotation customer.");
      }
      workerId = workerId ?? quotation.worker_id;
    }
    if (body.lead_id) {
      const lead = await get("SELECT id FROM leads WHERE id = ? AND deleted_at IS NULL", [body.lead_id]);
      if (!lead) throw badRequest("Lead not found.");
    }
    const subtotal = round2(body.items.reduce((sum, it) => sum + it.qty * it.unit_price, 0));
    const taxAmount = round2(subtotal * body.tax_rate / 100);
    const total = round2(subtotal + taxAmount);
    const now = await nowISO();
    const stamp = body.issue_date.replace(/-/g, "");
    let invoiceNumber = "";
    const invoiceId = await tx(async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const row2 = await get(
          `SELECT COUNT(*) AS n FROM invoices WHERE invoice_number LIKE ?`,
          [`INV-${stamp}-%`]
        );
        const candidate = `INV-${stamp}-${String((row2?.n ?? 0) + 1 + attempt).padStart(4, "0")}`;
        if (!await get("SELECT id FROM invoices WHERE invoice_number = ?", [candidate])) {
          invoiceNumber = candidate;
          break;
        }
      }
      if (!invoiceNumber) invoiceNumber = `INV-${stamp}-${Date.now().toString().slice(-6)}`;
      const newId = Number(
        (await run(
          `INSERT INTO invoices (invoice_number, booking_id, quotation_id, lead_id, customer_id, worker_id,
            issue_date, due_date, items, currency, subtotal, tax_rate, tax_amount, total_amount, paid_amount,
            status, notes, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'DRAFT', ?, ?, ?, ?, ?)`,
          [
            invoiceNumber,
            body.booking_id ?? null,
            body.quotation_id ?? null,
            body.lead_id ?? null,
            body.customer_id,
            workerId,
            body.issue_date,
            body.due_date ?? null,
            JSON.stringify(body.items),
            currency,
            subtotal,
            body.tax_rate,
            taxAmount,
            total,
            body.notes ?? null,
            user.id,
            user.id,
            now,
            now
          ]
        )).lastInsertRowid
      );
      await audit(req, "INVOICE_CREATED", "invoice", newId, {
        invoice_number: invoiceNumber,
        total_amount: total,
        booking_id: body.booking_id ?? null
      });
      return newId;
    });
    const row = await get(`${INVOICE_SELECT} WHERE i.id = ?`, [invoiceId]);
    created(res, row ? shapeInvoice(row) : { id: invoiceId, invoice_number: invoiceNumber });
  } catch (err) {
    next(err);
  }
});
var updateSchema4 = z11.object({
  customer_id: z11.number().int().positive().optional(),
  booking_id: z11.number().int().positive().optional().nullable(),
  quotation_id: z11.number().int().positive().optional().nullable(),
  lead_id: z11.number().int().positive().optional().nullable(),
  worker_id: z11.number().int().positive().optional().nullable(),
  issue_date: z11.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  due_date: z11.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  items: z11.array(itemSchema2).min(1).max(200).optional(),
  tax_rate: z11.number().min(0).max(100).optional(),
  notes: z11.string().trim().max(4e3).optional().nullable()
});
invoicesRouter.patch("/:id(\\d+)", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const invoice = await loadInvoice(id, req);
    if (!canWrite(req, invoice)) throw forbidden();
    if (invoice.status !== "DRAFT") {
      throw conflict("Only draft invoices can be edited. Revert the status or create a new invoice.");
    }
    const body = meta(updateSchema4, req.body);
    if (!Object.keys(body).length) throw badRequest("No changes supplied.");
    let items = parseJson4(invoice.items, []);
    let taxRate = Number(invoice.tax_rate ?? 0);
    if (body.items) items = body.items;
    if (body.tax_rate !== void 0) taxRate = body.tax_rate;
    const subtotal = round2(items.reduce((sum, it) => sum + Number(it.qty ?? 1) * Number(it.unit_price ?? 0), 0));
    const taxAmount = round2(subtotal * taxRate / 100);
    const total = round2(subtotal + taxAmount);
    const alreadyPaid = Number(invoice.live_paid_amount ?? invoice.paid_amount ?? 0);
    if (total < alreadyPaid) {
      throw conflict("Total cannot be less than the amount already paid.");
    }
    const user = currentUser(req);
    await run(
      `UPDATE invoices SET customer_id = ?, booking_id = ?, quotation_id = ?, lead_id = ?, worker_id = ?,
         issue_date = ?, due_date = ?, items = ?, tax_rate = ?, subtotal = ?, tax_amount = ?, total_amount = ?,
         notes = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [
        body.customer_id ?? invoice.customer_id,
        body.booking_id !== void 0 ? body.booking_id : invoice.booking_id,
        body.quotation_id !== void 0 ? body.quotation_id : invoice.quotation_id,
        body.lead_id !== void 0 ? body.lead_id : invoice.lead_id,
        body.worker_id !== void 0 ? body.worker_id : invoice.worker_id,
        body.issue_date ?? invoice.issue_date,
        body.due_date !== void 0 ? body.due_date : invoice.due_date,
        JSON.stringify(items),
        taxRate,
        subtotal,
        taxAmount,
        total,
        body.notes !== void 0 ? body.notes : invoice.notes,
        user.id,
        await nowISO(),
        id
      ]
    );
    await audit(req, "INVOICE_UPDATED", "invoice", id, { changed: Object.keys(body), total_amount: total });
    const row = await get(`${INVOICE_SELECT} WHERE i.id = ?`, [id]);
    ok(res, row ? shapeInvoice(row) : null);
  } catch (err) {
    next(err);
  }
});
var statusSchema6 = z11.object({ status: z11.enum(INVOICE_STATUSES) });
invoicesRouter.patch("/:id(\\d+)/status", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const invoice = await loadInvoice(id, req);
    if (!canWrite(req, invoice)) throw forbidden();
    const body = meta(statusSchema6, req.body);
    const allowed = TRANSITIONS3[invoice.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw conflict(`An invoice cannot move from ${invoice.status} to ${body.status}.`);
    }
    await run("UPDATE invoices SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      body.status,
      currentUser(req).id,
      await nowISO(),
      id
    ]);
    await audit(req, "INVOICE_STATUS_CHANGED", "invoice", id, {
      from: invoice.status,
      to: body.status,
      invoice_number: invoice.invoice_number
    });
    const row = await get(`${INVOICE_SELECT} WHERE i.id = ?`, [id]);
    ok(res, row ? shapeInvoice(row) : null);
  } catch (err) {
    next(err);
  }
});
invoicesRouter.delete("/:id(\\d+)", requireAuth, requirePermission("invoices:manage"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const invoice = await loadInvoice(id, req);
    const now = await nowISO();
    await run("UPDATE invoices SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    await audit(req, "INVOICE_DELETED", "invoice", id, { invoice_number: invoice.invoice_number });
    ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});

// src/modules/reports/reports.routes.ts
init_database();
init_errors();
import { Router as Router16 } from "express";

// src/services/csv.ts
function parseCsv(input) {
  const text = input.replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}
function toCsv(rows) {
  return rows.map(
    (row) => row.map((cell) => {
      let value = cell === null || cell === void 0 ? "" : String(cell);
      const isNumeric = /^-?\d+(\.\d+)?$/.test(value);
      if (!isNumeric && /^[=+@\-\t\r]/.test(value)) value = `'${value}`;
      return /["\n\r,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    }).join(",")
  ).join("\r\n");
}
function guessColumn(header, candidates) {
  const norm = header.trim().toLowerCase().replace(/[\s_-]+/g, "");
  for (const candidate of candidates) {
    const c = candidate.toLowerCase().replace(/[\s_-]+/g, "");
    if (norm === c) return candidate;
  }
  for (const candidate of candidates) {
    const c = candidate.toLowerCase().replace(/[\s_-]+/g, "");
    if (norm.includes(c) || c.includes(norm)) return candidate;
  }
  return null;
}

// src/modules/reports/reports.routes.ts
var reportsRouter = Router16();
function periodWindow(query2) {
  const q = query2 ?? {};
  const from = String(q.date_from ?? "").trim() || void 0;
  const to = String(q.date_to ?? "").trim() || void 0;
  const period = String(q.period ?? "").trim() || "month";
  if (from || to) return { from: from ?? "1970-01-01", to: to ?? todayStr() };
  const now = /* @__PURE__ */ new Date();
  if (period === "today") {
    const d = todayStr();
    return { from: d, to: d };
  }
  if (period === "week") {
    const day = now.getUTCDay() || 7;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1)));
    return { from: start.toISOString().slice(0, 10), to: todayStr() };
  }
  if (period === "year") return { from: `${now.getUTCFullYear()}-01-01`, to: todayStr() };
  return { from: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`, to: todayStr() };
}
reportsRouter.get("/summary", requireAuth, requirePermission("reports:read"), async (req, res, next) => {
  try {
    const { from, to } = periodWindow(req.query);
    const dates = [from, to];
    const leadStatusRows = await all(
      `SELECT ls.code, ls.name, COUNT(l.id) AS c
       FROM lead_statuses ls LEFT JOIN leads l ON l.status_id = ls.id AND l.deleted_at IS NULL
       WHERE ls.is_active = 1
       GROUP BY ls.id ORDER BY ls.sort_order`
    );
    const totalLeads = leadStatusRows.reduce((s, r) => s + Number(r.c), 0);
    const createdInPeriod = (await get(
      "SELECT COUNT(*) AS c FROM leads WHERE deleted_at IS NULL AND substr(created_at, 1, 10) BETWEEN ? AND ?",
      dates
    )).c;
    const converted = Number(
      leadStatusRows.find((r) => r.code === "CONVERTED")?.c ?? 0
    );
    const fu = await get(
      `SELECT
         COUNT(*) AS due,
         SUM(CASE WHEN status IN ('COMPLETED','CONVERTED') THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED') AND scheduled_date < ? THEN 1 ELSE 0 END) AS overdue
       FROM follow_ups WHERE scheduled_date BETWEEN ? AND ?`,
      [todayStr(), from, to]
    );
    const calls = await get(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS connected,
         SUM(CASE WHEN status IN ('MISSED','NO_ANSWER') THEN 1 ELSE 0 END) AS missed,
         COALESCE(SUM(duration_seconds), 0) AS seconds
       FROM calls WHERE deleted_at IS NULL AND substr(COALESCE(started_at, created_at), 1, 10) BETWEEN ? AND ?`,
      dates
    );
    const quotes = await get(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'ACCEPTED' THEN 1 ELSE 0 END) AS accepted,
         COALESCE(SUM(CASE WHEN status = 'ACCEPTED' THEN total_amount ELSE 0 END), 0) AS accepted_amount,
         COALESCE(SUM(total_amount), 0) AS amount
       FROM quotations WHERE deleted_at IS NULL AND substr(created_at, 1, 10) BETWEEN ? AND ?`,
      dates
    );
    const bookings = await get(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(total_amount), 0) AS amount,
         COALESCE(SUM(paid_amount), 0) AS paid,
         COALESCE(SUM(total_amount - paid_amount), 0) AS outstanding
       FROM bookings
       WHERE deleted_at IS NULL AND status != 'CANCELLED' AND substr(created_at, 1, 10) BETWEEN ? AND ?`,
      dates
    );
    ok(res, {
      period: { from, to },
      leads: {
        total: totalLeads,
        created_in_period: Number(createdInPeriod),
        converted,
        conversion_rate: totalLeads ? Math.round(converted / totalLeads * 1e3) / 10 : 0,
        by_status: leadStatusRows.map((r) => ({ code: r.code, name: r.name, count: Number(r.c) }))
      },
      follow_ups: {
        due: Number(fu.due ?? 0),
        completed: Number(fu.completed ?? 0),
        overdue: Number(fu.overdue ?? 0),
        completion_rate: Number(fu.due) ? Math.round(Number(fu.completed) / Number(fu.due) * 1e3) / 10 : 0
      },
      calls: {
        total: Number(calls.total ?? 0),
        connected: Number(calls.connected ?? 0),
        missed: Number(calls.missed ?? 0),
        avg_seconds: Number(calls.connected) > 0 ? Math.round(Number(calls.seconds) / Number(calls.connected)) : 0
      },
      quotations: {
        total: Number(quotes.total ?? 0),
        accepted: Number(quotes.accepted ?? 0),
        amount: Number(quotes.amount ?? 0),
        accepted_amount: Number(quotes.accepted_amount ?? 0),
        conversion_rate: Number(quotes.total) ? Math.round(Number(quotes.accepted) / Number(quotes.total) * 1e3) / 10 : 0
      },
      bookings: {
        total: Number(bookings.total ?? 0),
        amount: Number(bookings.amount ?? 0),
        paid: Number(bookings.paid ?? 0),
        outstanding: Number(bookings.outstanding ?? 0)
      }
    });
  } catch (err) {
    next(err);
  }
});
var EXPORTS = {
  leads: async () => ({
    header: [
      "lead_number",
      "customer",
      "phone",
      "destination",
      "status",
      "priority",
      "assigned_to",
      "source",
      "budget",
      "travel_start",
      "travel_end",
      "last_contacted",
      "created_at"
    ],
    rows: await all(
      `SELECT l.lead_number AS lead_number, c.name AS customer, c.phone AS phone,
              l.destination AS destination, ls.code AS status, l.priority AS priority,
              COALESCE(w.name, '') AS assigned_to, COALESCE(src.name, '') AS source,
              l.budget AS budget, l.travel_start_date AS travel_start,
              l.travel_end_date AS travel_end, l.last_contacted_at AS last_contacted,
              l.created_at AS created_at
       FROM leads l
       JOIN customers c ON c.id = l.customer_id
       JOIN lead_statuses ls ON ls.id = l.status_id
       LEFT JOIN users w ON w.id = l.assigned_to
       LEFT JOIN lead_sources src ON src.id = l.source_id
       WHERE l.deleted_at IS NULL
       ORDER BY l.created_at DESC`
    )
  }),
  customers: async () => ({
    header: ["name", "phone", "whatsapp", "email", "city", "state", "country", "created_at"],
    rows: await all(
      `SELECT name AS name, phone AS phone, whatsapp AS whatsapp, email AS email,
              city AS city, state AS state, country AS country, created_at AS created_at
       FROM customers WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`
    )
  }),
  "follow-ups": async () => ({
    header: ["lead_number", "customer", "worker", "scheduled_date", "scheduled_time", "type", "status", "next_action", "notes"],
    rows: await all(
      `SELECT l.lead_number AS lead_number, c.name AS customer, w.name AS worker,
              f.scheduled_date AS scheduled_date, f.scheduled_time AS scheduled_time,
              f.type AS type, f.status AS status,
              COALESCE(f.next_action, '') AS next_action, COALESCE(f.notes, '') AS notes
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
       JOIN users w ON w.id = f.worker_id
       WHERE l.deleted_at IS NULL
       ORDER BY f.scheduled_date DESC, f.scheduled_time DESC`
    )
  }),
  calls: async () => ({
    header: ["lead_number", "customer", "worker", "direction", "phone", "status", "duration_seconds", "started_at", "disposition", "recording"],
    rows: await all(
      `SELECT COALESCE(l.lead_number, '') AS lead_number, COALESCE(c.name, '') AS customer,
              COALESCE(w.name, '') AS worker, cl.direction AS direction,
              COALESCE(cl.phone_number, '') AS phone, cl.status AS status,
              cl.duration_seconds AS duration_seconds, cl.started_at AS started_at,
              COALESCE(cl.disposition, '') AS disposition, cl.recording_available AS recording
       FROM calls cl
       LEFT JOIN leads l ON l.id = cl.lead_id
       LEFT JOIN customers c ON c.id = cl.customer_id
       LEFT JOIN users w ON w.id = cl.worker_id
       WHERE cl.deleted_at IS NULL
       ORDER BY COALESCE(cl.started_at, cl.created_at) DESC`
    )
  }),
  quotations: async () => ({
    header: ["quotation_number", "lead_number", "customer", "destination", "status", "total_amount", "currency", "valid_until", "created_at"],
    rows: await all(
      `SELECT q.quotation_number AS quotation_number, l.lead_number AS lead_number,
              c.name AS customer, COALESCE(q.destination, '') AS destination,
              q.status AS status, q.total_amount AS total_amount, q.currency AS currency,
              COALESCE(q.valid_until, '') AS valid_until, q.created_at AS created_at
       FROM quotations q
       JOIN leads l ON l.id = q.lead_id
       JOIN customers c ON c.id = q.customer_id
       WHERE q.deleted_at IS NULL ORDER BY q.created_at DESC`
    )
  }),
  bookings: async () => ({
    header: ["booking_number", "customer", "destination", "status", "total_amount", "paid_amount", "payment_status", "travel_start", "created_at"],
    rows: await all(
      `SELECT b.booking_number AS booking_number, c.name AS customer,
              COALESCE(b.destination, '') AS destination, b.status AS status,
              b.total_amount AS total_amount, b.paid_amount AS paid_amount,
              b.payment_status AS payment_status, COALESCE(b.travel_start_date, '') AS travel_start,
              b.created_at AS created_at
       FROM bookings b JOIN customers c ON c.id = b.customer_id
       WHERE b.deleted_at IS NULL ORDER BY b.created_at DESC`
    )
  })
};
function packRows(header, rows) {
  return rows.map((row) => header.map((key) => row[key] ?? null));
}
reportsRouter.get("/exports/:entity", requireAuth, requirePermission("exports:run"), async (req, res, next) => {
  try {
    const entity = String(req.params.entity).toLowerCase();
    const build = EXPORTS[entity];
    if (!build) throw notFound(`Unknown export entity. Available: ${Object.keys(EXPORTS).join(", ")}`);
    const { header, rows } = await build(req.query);
    const csv = toCsv([header, ...packRows(header, rows)]);
    const stamp = todayStr();
    const filename = `${entity}-${stamp}.csv`;
    await audit(req, "DATA_EXPORTED", "export", entity, { entity, rows: rows.length });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
reportsRouter.get("/exports/:entity/preview", requireAuth, requirePermission("reports:read"), async (req, res, next) => {
  try {
    const entity = String(req.params.entity).toLowerCase();
    const build = EXPORTS[entity];
    if (!build) throw notFound(`Unknown export entity. Available: ${Object.keys(EXPORTS).join(", ")}`);
    const { header, rows } = await build(req.query);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    ok(res, {
      entity,
      header,
      rows: rows.slice(0, limit),
      total: rows.length,
      truncated: rows.length > limit
    });
  } catch (err) {
    next(err);
  }
});

// src/modules/imports/imports.routes.ts
init_database();
init_errors();
import { Router as Router17 } from "express";
import { z as z12 } from "zod";
init_documents();
var importsRouter = Router17();
var CANONICAL = [
  "name",
  "phone",
  "email",
  "city",
  "destination",
  "source",
  "budget",
  "priority",
  "trip_type",
  "travel_start",
  "travel_end",
  "notes"
];
var PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.replace(/^0+/, "").slice(0, 15);
}
function jobShape(row) {
  let preview = [];
  let errors = [];
  let columnMap = {};
  try {
    preview = JSON.parse(row.preview ?? "[]");
  } catch {
    preview = [];
  }
  try {
    errors = JSON.parse(row.errors ?? "[]");
  } catch {
    errors = [];
  }
  try {
    columnMap = JSON.parse(row.column_map ?? "{}");
  } catch {
    columnMap = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    status: row.status,
    column_map: columnMap,
    preview: Array.isArray(preview) ? preview.slice(0, 20) : [],
    total_rows: row.total_rows,
    valid_rows: row.valid_rows,
    invalid_rows: row.invalid_rows,
    duplicate_rows: row.duplicate_rows,
    imported_rows: row.imported_rows,
    failed_rows: row.failed_rows,
    errors,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? null
  };
}
var uploadSchema = z12.object({
  filename: z12.string().trim().min(1).max(180),
  content_base64: z12.string().min(1).max(4e6)
});
importsRouter.post("/", requireAuth, requirePermission("imports:manage"), async (req, res, next) => {
  try {
    const body = meta(uploadSchema, req.body);
    const user = currentUser(req);
    const { buffer } = parseBase64(body.content_base64);
    const text = buffer.toString("utf8");
    const rows = parseCsv(text);
    if (rows.length < 2) throw badRequest("The file needs a header row and at least one data row.");
    const headers = rows[0].map((h) => h.trim());
    const columnMap = {};
    for (const canonical of CANONICAL) {
      const idx = headers.findIndex((h) => guessColumn(h, [canonical]) !== null);
      if (idx >= 0) columnMap[canonical] = idx;
    }
    if (columnMap.name === void 0) throw badRequest('No "name" column was found in the header row.');
    if (columnMap.phone === void 0) throw badRequest('No "phone" column was found in the header row.');
    const existingPhones = new Set(
      (await all("SELECT phone FROM customers WHERE deleted_at IS NULL AND phone IS NOT NULL")).map(
        (r) => normalizePhone(r.phone)
      )
    );
    const parsed = [];
    const errors = [];
    const seenPhones = /* @__PURE__ */ new Set();
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i];
      const values = {};
      for (const canonical of CANONICAL) {
        const idx = columnMap[canonical];
        if (idx !== void 0 && cells[idx] !== void 0) values[canonical] = String(cells[idx]).trim();
      }
      const rowNo = i + 1;
      const name = values.name ?? "";
      const phone = normalizePhone(values.phone ?? "");
      if (!name) {
        parsed.push({ row: rowNo, status: "INVALID", error: "Customer name is required.", values });
        if (errors.length < 50) errors.push({ row: rowNo, message: "Customer name is required." });
        continue;
      }
      if (phone.length < 7) {
        parsed.push({ row: rowNo, status: "INVALID", error: "Phone number looks too short.", values });
        if (errors.length < 50) errors.push({ row: rowNo, message: "Phone number looks too short." });
        continue;
      }
      if (existingPhones.has(phone)) {
        parsed.push({ row: rowNo, status: "DUPLICATE", error: "A customer with this phone already exists.", values });
        continue;
      }
      if (seenPhones.has(phone)) {
        parsed.push({ row: rowNo, status: "DUPLICATE", error: "Duplicate phone within this file.", values });
        continue;
      }
      seenPhones.add(phone);
      parsed.push({ row: rowNo, status: "VALID", values });
    }
    const total = parsed.length;
    const valid = parsed.filter((r) => r.status === "VALID").length;
    const invalid = parsed.filter((r) => r.status === "INVALID").length;
    const duplicates = parsed.filter((r) => r.status === "DUPLICATE").length;
    const now = await nowISO();
    const jobId = (await run(
      `INSERT INTO import_jobs (kind, filename, status, column_map, preview, total_rows, valid_rows, invalid_rows,
        duplicate_rows, imported_rows, failed_rows, errors, created_by, created_at, updated_at)
       VALUES ('LEADS', ?, 'PARSED', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      [
        body.filename,
        JSON.stringify(columnMap),
        JSON.stringify(parsed),
        total,
        valid,
        invalid,
        duplicates,
        JSON.stringify(errors),
        user.id,
        now,
        now
      ]
    )).lastInsertRowid;
    await audit(req, "IMPORT_PARSED", "import_job", jobId, {
      filename: body.filename,
      total,
      valid,
      invalid,
      duplicates
    });
    const row = await get("SELECT * FROM import_jobs WHERE id = ?", [jobId]);
    created(res, jobShape(row));
  } catch (err) {
    next(err);
  }
});
importsRouter.get("/", requireAuth, requirePermission("imports:manage"), async (req, res, next) => {
  try {
    const where = ["deleted_at IS NULL"];
    const params = [];
    const statuses = Array.isArray(req.query.status) ? req.query.status : typeof req.query.status === "string" && req.query.status ? [req.query.status] : [];
    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    const search = String(req.query.search ?? "").trim();
    if (search) {
      where.push("filename LIKE ? ESCAPE '\\'");
      params.push(await likeTerm(search));
    }
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(`SELECT COUNT(*) AS c FROM import_jobs ${whereSql}`, params)).c;
    const rows = await all(`SELECT * FROM import_jobs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset
    ]);
    list(res, rows.map(jobShape), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
importsRouter.get("/:id(\\d+)", requireAuth, requirePermission("imports:manage"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM import_jobs WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!row) throw notFound("Import job not found.");
    ok(res, jobShape(row));
  } catch (err) {
    next(err);
  }
});
var runSchema = z12.object({
  import_duplicates: z12.boolean().default(false),
  assign: z12.enum(["AUTO", "MANUAL", "NONE"]).default("AUTO"),
  worker_id: z12.number().int().positive().optional()
});
async function resolveSourceId(name) {
  if (!name) return null;
  const existing = await get("SELECT id FROM lead_sources WHERE lower(name) = lower(?)", [name]);
  if (existing) return existing.id;
  const now = await nowISO();
  return (await run("INSERT INTO lead_sources (name, sort_order, created_at, updated_at) VALUES (?, 999, ?, ?)", [
    name,
    now,
    now
  ])).lastInsertRowid;
}
async function defaultStatusId() {
  const preferred = await get(`SELECT id FROM lead_statuses WHERE code = 'NEW' AND is_active = 1`);
  if (preferred) return preferred.id;
  const first = await get("SELECT id FROM lead_statuses WHERE is_active = 1 ORDER BY sort_order, id LIMIT 1");
  if (!first) throw badRequest("No active lead status is configured.");
  return first.id;
}
importsRouter.post("/:id(\\d+)/run", requireAuth, requirePermission("imports:manage"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const job = await get("SELECT * FROM import_jobs WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!job) throw notFound("Import job not found.");
    if (job.status === "COMPLETED") throw conflict("This import has already been run.");
    if (job.status !== "PARSED") throw conflict(`An import in status ${job.status} cannot be run.`);
    const body = meta(runSchema, req.body);
    const user = currentUser(req);
    if (body.assign === "MANUAL") {
      if (!body.worker_id) throw badRequest("worker_id is required when assign is MANUAL.");
      const worker = await get("SELECT status FROM users WHERE id = ? AND deleted_at IS NULL", [
        body.worker_id
      ]);
      if (!worker) throw badRequest("Selected worker does not exist.");
      if (worker.status !== "ACTIVE") throw badRequest("Selected worker is not active.");
    }
    const rows = JSON.parse(job.preview ?? "[]");
    const now = await nowISO();
    await run("UPDATE import_jobs SET status = ?, updated_at = ? WHERE id = ?", ["IMPORTING", now, id]);
    const cfg = await assignmentConfig();
    let imported = 0;
    let failed = 0;
    const runErrors = JSON.parse(job.errors ?? "[]");
    const phoneIndex = /* @__PURE__ */ new Map();
    for (const r of await all(
      "SELECT id, phone FROM customers WHERE deleted_at IS NULL"
    )) {
      const key = normalizePhone(r.phone ?? "");
      if (key.length >= 7 && !phoneIndex.has(key)) phoneIndex.set(key, r.id);
    }
    for (const parsedRow of rows) {
      if (parsedRow.status === "INVALID") {
        failed += 1;
        continue;
      }
      if (parsedRow.status === "DUPLICATE" && !body.import_duplicates) continue;
      const values = parsedRow.values;
      const phoneDigits = normalizePhone(values.phone ?? "");
      try {
        await tx(async () => {
          let customerId;
          const existingCustomerId = phoneIndex.get(phoneDigits);
          if (existingCustomerId) {
            customerId = existingCustomerId;
          } else {
            customerId = (await run(
              `INSERT INTO customers (name, phone, whatsapp, email, city, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                values.name,
                values.phone ?? null,
                values.phone ?? null,
                values.email || null,
                values.city || null,
                user.id,
                now,
                now
              ]
            )).lastInsertRowid;
            phoneIndex.set(phoneDigits, customerId);
            await audit(req, "CUSTOMER_CREATED", "customer", customerId, { via: "import", job_id: id });
          }
          const priority = PRIORITY_VALUES.includes(String(values.priority).toUpperCase()) ? String(values.priority).toUpperCase() : "MEDIUM";
          const travelType = ["DOMESTIC", "INTERNATIONAL"].includes(String(values.trip_type).toUpperCase()) ? String(values.trip_type).toUpperCase() : null;
          const leadId = (await run(
            `INSERT INTO leads (lead_number, customer_id, source_id, assigned_to, destination, travel_type, trip_type,
              requirements, travel_start_date, travel_end_date, budget, priority, status_id, notes, custom_fields,
              import_job_id, created_by, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
            [
              await nextLeadNumber(),
              customerId,
              await resolveSourceId(values.source),
              values.destination || null,
              travelType,
              null,
              values.travel_start || null,
              values.travel_end || null,
              values.budget ? Number(String(values.budget).replace(/[^\d.]/g, "")) || null : null,
              priority,
              await defaultStatusId(),
              values.notes || null,
              id,
              user.id,
              user.id,
              now,
              now
            ]
          )).lastInsertRowid;
          await addTimelineEvent({
            leadId,
            type: TIMELINE_TYPES.LEAD_IMPORTED,
            actorId: user.id,
            summary: `Lead imported from ${job.filename}`,
            metadata: { import_job_id: id, row: parsedRow.row }
          });
          if (body.assign === "MANUAL" && body.worker_id) {
            const lead = await get("SELECT * FROM leads WHERE id = ?", [leadId]);
            await autoAssignLead({ lead, actorId: user.id, actorName: user.name, strategy: "MANUAL" });
            await run("UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ?", [body.worker_id, now, leadId]);
            await run(
              `INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by, action, reason, assigned_at)
               VALUES (?, ?, ?, 'ASSIGNED', 'import:manual', ?)`,
              [leadId, body.worker_id, user.id, now]
            );
          } else if (body.assign === "AUTO" && cfg.auto_assign_new) {
            const lead = await get("SELECT * FROM leads WHERE id = ?", [leadId]);
            await autoAssignLead({ lead, actorId: user.id, actorName: user.name });
          }
          imported += 1;
        });
      } catch (err) {
        failed += 1;
        if (runErrors.length < 50) {
          runErrors.push({
            row: parsedRow.row,
            message: err instanceof Error ? err.message : "Row import failed."
          });
        }
      }
    }
    await run(
      `UPDATE import_jobs SET status = 'COMPLETED', imported_rows = ?, failed_rows = ?, errors = ?, updated_at = ?,
         completed_at = ? WHERE id = ?`,
      [imported, failed, JSON.stringify(runErrors), await nowISO(), await nowISO(), id]
    );
    await audit(req, "IMPORT_COMPLETED", "import_job", id, { imported, failed, filename: job.filename });
    const row = await get("SELECT * FROM import_jobs WHERE id = ?", [id]);
    ok(res, { ...jobShape(row), imported_rows: imported, failed_rows: failed, error_count: runErrors.length });
  } catch (err) {
    next(err);
  }
});
importsRouter.delete("/:id(\\d+)", requireAuth, requirePermission("imports:manage"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const job = await get("SELECT id FROM import_jobs WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!job) throw notFound("Import job not found.");
    await run("UPDATE import_jobs SET deleted_at = ?, updated_at = ? WHERE id = ?", [await nowISO(), await nowISO(), id]);
    await audit(req, "IMPORT_DELETED", "import_job", id, {});
    ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});

// src/modules/duplicates/duplicates.routes.ts
init_database();
init_errors();
import { Router as Router18 } from "express";
import { z as z13 } from "zod";
var duplicatesRouter = Router18();
var DECISIONS = ["KEPT_SEPARATE", "MERGED", "LINKED", "IGNORED"];
function normalizePhone2(value) {
  const digits = String(value || "").replace(/\D/g, "").replace(/^0+/, "");
  return digits.slice(0, 15);
}
function shapeReview(row) {
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata ?? "{}");
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    entity: row.entity,
    entity_id: row.entity_id,
    candidate_id: row.candidate_id,
    reason: row.reason ?? null,
    score: row.score ?? null,
    status: row.status,
    decided_by: row.decided_by ?? null,
    decided_at: row.decided_at ?? null,
    metadata,
    entity_data: row.entity_data ?? null,
    candidate_data: row.candidate_data ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
async function reviewExists(entity, a, b) {
  const row = await get(
    `SELECT id FROM duplicate_reviews
     WHERE entity = ? AND ((entity_id = ? AND candidate_id = ?) OR (entity_id = ? AND candidate_id = ?))
       AND status IN ('OPEN','LINKED')`,
    [entity, a, b, b, a]
  );
  return Boolean(row);
}
duplicatesRouter.post("/scan", requireAuth, requirePermission("leads:read_all"), async (req, res, next) => {
  try {
    const now = await nowISO();
    let customersFound = 0;
    let leadsFound = 0;
    const byPhone = /* @__PURE__ */ new Map();
    for (const row of await all(
      "SELECT id, name, phone FROM customers WHERE deleted_at IS NULL AND phone IS NOT NULL"
    )) {
      const key = normalizePhone2(row.phone);
      if (key.length < 7) continue;
      const group = byPhone.get(key) ?? [];
      group.push({ id: row.id, name: row.name });
      byPhone.set(key, group);
    }
    for (const [phone, group] of byPhone) {
      if (group.length < 2) continue;
      const base = group[0];
      for (const other of group.slice(1)) {
        if (await reviewExists("CUSTOMER", other.id, base.id)) continue;
        await run(
          `INSERT INTO duplicate_reviews (entity, entity_id, candidate_id, reason, score, status, metadata, created_at, updated_at)
           VALUES ('CUSTOMER', ?, ?, 'Same phone number', 'HIGH', 'OPEN', ?, ?, ?)`,
          [other.id, base.id, JSON.stringify({ phone }), now, now]
        );
        customersFound += 1;
      }
    }
    const leadGroups = /* @__PURE__ */ new Map();
    for (const row of await all(
      `SELECT l.id, l.lead_number, l.customer_id, l.destination, ls.code AS status
       FROM leads l JOIN lead_statuses ls ON ls.id = l.status_id
       WHERE l.deleted_at IS NULL AND ls.category = 'OPEN'`
    )) {
      const key = `${row.customer_id}::${String(row.destination ?? "").trim().toLowerCase()}`;
      if (!row.destination) continue;
      const group = leadGroups.get(key) ?? [];
      group.push({ id: row.id, lead_number: row.lead_number });
      leadGroups.set(key, group);
    }
    for (const [, group] of leadGroups) {
      if (group.length < 2) continue;
      const base = group[0];
      for (const other of group.slice(1)) {
        if (await reviewExists("LEAD", other.id, base.id)) continue;
        await run(
          `INSERT INTO duplicate_reviews (entity, entity_id, candidate_id, reason, score, status, metadata, created_at, updated_at)
           VALUES ('LEAD', ?, ?, 'Same customer and destination', 'MEDIUM', 'OPEN', '{}', ?, ?)`,
          [other.id, base.id, now, now]
        );
        leadsFound += 1;
      }
    }
    await audit(req, "DUPLICATES_SCANNED", "duplicate_review", null, { customers: customersFound, leads: leadsFound });
    created(res, { customers_found: customersFound, leads_found: leadsFound });
  } catch (err) {
    next(err);
  }
});
duplicatesRouter.get("/", requireAuth, requirePermission("leads:read_all"), async (req, res, next) => {
  try {
    const where = ["1=1"];
    const params = [];
    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`d.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    } else {
      where.push(`d.status = 'OPEN'`);
    }
    const entities = toArray(req.query.entity);
    if (entities.length) {
      where.push(`d.entity IN (${entities.map(() => "?").join(",")})`);
      params.push(...entities);
    }
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(`SELECT COUNT(*) AS c FROM duplicate_reviews d ${whereSql}`, params)).c;
    const rows = await all(`SELECT d.* FROM duplicate_reviews d ${whereSql} ORDER BY d.id DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset
    ]);
    const hydrated = await Promise.all(
      rows.map(async (row) => {
        let entityData = null;
        let candidateData = null;
        if (row.entity === "CUSTOMER") {
          entityData = await get("SELECT id, name, phone, email, city, created_at FROM customers WHERE id = ?", [row.entity_id]);
          candidateData = await get("SELECT id, name, phone, email, city, created_at FROM customers WHERE id = ?", [
            row.candidate_id
          ]);
        } else {
          entityData = await get(
            `SELECT l.id, l.lead_number, l.destination, c.name AS customer_name, ls.code AS status, l.created_at
           FROM leads l JOIN customers c ON c.id = l.customer_id JOIN lead_statuses ls ON ls.id = l.status_id
           WHERE l.id = ?`,
            [row.entity_id]
          );
          candidateData = await get(
            `SELECT l.id, l.lead_number, l.destination, c.name AS customer_name, ls.code AS status, l.created_at
           FROM leads l JOIN customers c ON c.id = l.customer_id JOIN lead_statuses ls ON ls.id = l.status_id
           WHERE l.id = ?`,
            [row.candidate_id]
          );
        }
        return shapeReview({ ...row, entity_data: entityData, candidate_data: candidateData });
      })
    );
    list(res, hydrated, buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
var decideSchema = z13.object({
  action: z13.enum(DECISIONS),
  target_id: z13.number().int().positive().optional(),
  remark: z13.string().trim().max(500).optional().nullable()
});
async function mergeCustomers(sourceId, targetId, req) {
  if (sourceId === targetId) throw badRequest("A customer cannot be merged into itself.");
  const now = await nowISO();
  const counts = {};
  counts.leads = (await run("UPDATE leads SET customer_id = ?, updated_at = ? WHERE customer_id = ? AND deleted_at IS NULL", [
    targetId,
    now,
    sourceId
  ])).changes;
  counts.calls = (await run("UPDATE calls SET customer_id = ? WHERE customer_id = ?", [targetId, sourceId])).changes;
  counts.quotations = (await run("UPDATE quotations SET customer_id = ? WHERE customer_id = ?", [targetId, sourceId])).changes;
  counts.bookings = (await run("UPDATE bookings SET customer_id = ? WHERE customer_id = ?", [targetId, sourceId])).changes;
  counts.communications = (await run("UPDATE communications SET customer_id = ? WHERE customer_id = ?", [targetId, sourceId])).changes;
  counts.documents = (await run(`UPDATE documents SET entity_id = ? WHERE entity = 'CUSTOMER' AND entity_id = ?`, [
    targetId,
    sourceId
  ])).changes;
  const target = await get("SELECT * FROM customers WHERE id = ?", [targetId]);
  const source = await get("SELECT * FROM customers WHERE id = ?", [sourceId]);
  if (target && source) {
    const patch = [];
    const params = [];
    for (const field of ["phone", "whatsapp", "email", "city", "state", "country", "notes"]) {
      if (!target[field] && source[field]) {
        patch.push(`${field} = ?`);
        params.push(source[field]);
      }
    }
    if (patch.length) {
      patch.push("updated_at = ?");
      params.push(now, targetId);
      await run(`UPDATE customers SET ${patch.join(", ")} WHERE id = ?`, params);
    }
  }
  await run("UPDATE customers SET deleted_at = ?, merged_into_id = ?, updated_at = ? WHERE id = ?", [
    now,
    targetId,
    now,
    sourceId
  ]);
  return counts;
}
async function mergeLeads(sourceId, targetId, actorId) {
  if (sourceId === targetId) throw badRequest("A lead cannot be merged into itself.");
  const now = await nowISO();
  const counts = {};
  counts.follow_ups = (await run("UPDATE follow_ups SET lead_id = ? WHERE lead_id = ?", [targetId, sourceId])).changes;
  counts.notes = (await run("UPDATE notes SET lead_id = ? WHERE lead_id = ?", [targetId, sourceId])).changes;
  counts.calls = (await run("UPDATE calls SET lead_id = ? WHERE lead_id = ?", [targetId, sourceId])).changes;
  counts.timeline = (await run("UPDATE lead_timeline SET lead_id = ? WHERE lead_id = ?", [targetId, sourceId])).changes;
  await run("UPDATE leads SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, sourceId]);
  const dupNumber = await get("SELECT lead_number FROM leads WHERE id = ?", [sourceId]);
  await addTimelineEvent({
    leadId: targetId,
    type: TIMELINE_TYPES.LEAD_MERGED,
    actorId,
    summary: `Merged duplicate lead ${dupNumber?.lead_number ?? sourceId}`,
    metadata: { merged_lead_id: sourceId }
  });
  return counts;
}
duplicatesRouter.post("/:id(\\d+)/decide", requireAuth, requirePermission("leads:read_all"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = meta(decideSchema, req.body);
    const user = currentUser(req);
    const review = await get("SELECT * FROM duplicate_reviews WHERE id = ?", [id]);
    if (!review) throw notFound("Duplicate review not found.");
    if (review.status !== "OPEN") throw conflict(`This review is already ${review.status.toLowerCase()}.`);
    const now = await nowISO();
    let counts = null;
    if (body.action === "MERGED") {
      if (!req.user.permissions.includes("customers:merge")) {
        throw forbidden("You do not have permission to merge records.");
      }
      const targetId = body.target_id ?? review.candidate_id;
      const sourceId = targetId === review.entity_id ? review.candidate_id : review.entity_id;
      counts = review.entity === "CUSTOMER" ? await mergeCustomers(sourceId, targetId, req) : await mergeLeads(sourceId, targetId, user.id);
      const existing = JSON.parse(review.metadata ?? "{}");
      await run(
        `UPDATE duplicate_reviews SET status = 'MERGED', decided_by = ?, decided_at = ?, metadata = ?, updated_at = ?
         WHERE id = ?`,
        [user.id, now, JSON.stringify({ ...existing, source_id: sourceId, target_id: targetId, counts }), now, id]
      );
      await audit(req, "CUSTOMER_MERGED".replace("CUSTOMER", review.entity), "duplicate_review", id, {
        source_id: sourceId,
        target_id: targetId,
        counts
      });
      if (review.entity === "CUSTOMER") {
        await notify({
          userId: user.id,
          type: "CUSTOMER_MERGED",
          title: "Duplicate customers merged",
          body: `${counts.leads} lead(s) and related records were moved to the kept customer.`,
          entity: "customer",
          entityId: targetId,
          link: `/customers?search=`
        });
      }
    } else if (body.action === "LINKED") {
      const existing = JSON.parse(review.metadata ?? "{}");
      await run(
        `UPDATE duplicate_reviews SET status = 'LINKED', decided_by = ?, decided_at = ?, metadata = ?, updated_at = ?
         WHERE id = ?`,
        [user.id, now, JSON.stringify({ ...existing, linked_to: review.candidate_id, remark: body.remark ?? null }), now, id]
      );
    } else {
      await run(
        "UPDATE duplicate_reviews SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?",
        [body.action, user.id, now, now, id]
      );
    }
    if (body.action !== "MERGED") {
      await audit(req, "DUPLICATE_DECIDED", "duplicate_review", id, { action: body.action, entity: review.entity });
    }
    const row = await get("SELECT * FROM duplicate_reviews WHERE id = ?", [id]);
    ok(res, { ...shapeReview(row), counts });
  } catch (err) {
    next(err);
  }
});
duplicatesRouter.post("/bulk-decide", requireAuth, requirePermission("leads:read_all"), async (req, res, next) => {
  try {
    const body = meta(
      z13.object({ action: z13.enum(["KEPT_SEPARATE", "IGNORED"]), ids: z13.array(z13.number().int().positive()).max(500) }),
      req.body
    );
    const user = currentUser(req);
    const now = await nowISO();
    let updated = 0;
    for (const id of body.ids) {
      const res2 = await run(
        `UPDATE duplicate_reviews SET status = ?, decided_by = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND status = 'OPEN'`,
        [body.action, user.id, now, now, id]
      );
      updated += res2.changes;
    }
    await audit(req, "DUPLICATE_DECIDED", "duplicate_review", null, { action: body.action, updated });
    ok(res, { updated });
  } catch (err) {
    next(err);
  }
});

// src/modules/documents/documents.routes.ts
init_database();
init_errors();
import { Router as Router19, raw as raw2 } from "express";
import { z as z14 } from "zod";
init_documents();
var documentsRouter = Router19();
var ENTITIES = ["CUSTOMER", "LEAD", "QUOTATION", "BOOKING", "CALL", "GENERAL"];
function shapeDocument(row) {
  return {
    id: row.id,
    entity: row.entity,
    entity_id: row.entity_id,
    category: row.category ?? null,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    uploaded_by: row.uploaded_by ?? null,
    uploaded_by_name: row.uploaded_by_name ?? null,
    created_at: row.created_at
  };
}
async function assertEntityAccess(entity, entityId, req, opts) {
  const user = req.user;
  if (entity === "GENERAL") {
    if (opts?.forWrite) return;
    if (!user.permissions.includes("documents:manage")) {
      throw forbidden("General documents are restricted to administrators.");
    }
    return;
  }
  if (entity === "LEAD") {
    const lead = await get(
      "SELECT assigned_to FROM leads WHERE id = ? AND deleted_at IS NULL",
      [entityId]
    );
    if (!lead) throw notFound("Lead not found.");
    if (!user.permissions.includes("leads:read_all") && lead.assigned_to !== user.id) {
      throw forbidden("You do not have access to this lead.");
    }
    return;
  }
  if (entity === "CUSTOMER") {
    const customer = await get("SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL", [entityId]);
    if (!customer) throw notFound("Customer not found.");
    if (!user.permissions.includes("leads:read_all")) {
      const owned = await get(
        "SELECT COUNT(*) AS c FROM leads WHERE customer_id = ? AND assigned_to = ? AND deleted_at IS NULL",
        [entityId, user.id]
      );
      if (!owned?.c) throw forbidden("You do not have access to this customer.");
    }
    return;
  }
  if (entity === "QUOTATION" || entity === "BOOKING") {
    const table = entity === "QUOTATION" ? "quotations" : "bookings";
    const row = await get(
      `SELECT worker_id, created_by FROM ${table} WHERE id = ? AND deleted_at IS NULL`,
      [entityId]
    );
    if (!row) throw notFound(entity === "QUOTATION" ? "Quotation not found." : "Booking not found.");
    const readAll = user.permissions.includes(entity === "QUOTATION" ? "quotations:read_all" : "bookings:read_all");
    if (!readAll && row.worker_id !== user.id && row.created_by !== user.id) {
      throw forbidden("You do not have access to this record.");
    }
    return;
  }
  if (entity === "CALL") {
    const call = await get("SELECT worker_id FROM calls WHERE id = ? AND deleted_at IS NULL", [
      entityId
    ]);
    if (!call) throw notFound("Call not found.");
    if (!user.permissions.includes("calls:read_all") && call.worker_id !== user.id) {
      throw forbidden("You do not have access to this call.");
    }
  }
}
documentsRouter.get("/", requireAuth, requirePermission("documents:read"), async (req, res, next) => {
  try {
    const entity = String(req.query.entity ?? "").trim().toUpperCase();
    const entityId = Number(req.query.entity_id);
    const isManager = can(req, "documents:manage");
    const where = ["d.deleted_at IS NULL"];
    const params = [];
    if (!isManager) {
      if (!entity || !entityId) throw badRequest("entity and entity_id are required.");
    }
    if (entity) {
      if (!ENTITIES.includes(entity)) throw badRequest("Unknown entity.");
      where.push("d.entity = ?");
      params.push(entity);
      if (entityId) {
        where.push("d.entity_id = ?");
        params.push(entityId);
        await assertEntityAccess(entity, entityId, req);
      }
    } else if (isManager) {
      await audit(req, "DOCUMENT_LISTED", "document", null, { scope: "all" });
    }
    const categories = toArray(req.query.category);
    if (categories.length) {
      where.push(`d.category IN (${categories.map(() => "?").join(",")})`);
      params.push(...categories);
    }
    const search = String(req.query.search ?? "").trim();
    if (search) {
      where.push(`d.filename LIKE ? ESCAPE '\\'`);
      params.push(`%${search.replace(/[%_\\]/g, "\\$&")}%`);
    }
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(`SELECT COUNT(*) AS c FROM documents d ${whereSql}`, params)).c;
    const rows = await all(
      `SELECT d.*, u.name AS uploaded_by_name FROM documents d
         LEFT JOIN users u ON u.id = d.uploaded_by ${whereSql}
       ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    list(res, rows.map(shapeDocument), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
var uploadSchema2 = z14.object({
  entity: z14.enum(ENTITIES),
  entity_id: z14.number().int().positive(),
  category: z14.string().trim().max(60).optional().nullable(),
  filename: z14.string().trim().min(1).max(180),
  mime_type: z14.string().trim().max(120).default("application/octet-stream"),
  content_base64: z14.string().min(1).max(14e6)
});
documentsRouter.post("/", requireAuth, requirePermission("documents:upload"), async (req, res, next) => {
  try {
    const body = meta(uploadSchema2, req.body);
    await assertEntityAccess(body.entity, body.entity_id, req, { forWrite: true });
    const user = currentUser(req);
    const parsed = parseBase64(body.content_base64);
    const saved = await saveDocument({
      entity: body.entity,
      entityId: body.entity_id,
      category: body.category ?? null,
      filename: body.filename,
      mimeType: body.mime_type || parsed.mime || "application/octet-stream",
      content: parsed.buffer,
      uploadedBy: user.id
    });
    await afterUpload(body.entity, body.entity_id, saved.id, user.id, req);
    const row = await get(
      `SELECT d.*, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = ?`,
      [saved.id]
    );
    created(res, shapeDocument(row));
  } catch (err) {
    next(err);
  }
});
documentsRouter.post(
  "/file",
  requireAuth,
  requirePermission("documents:upload"),
  raw2({ limit: "10mb" }),
  async (req, res, next) => {
    try {
      const entity = String(req.header("x-entity") ?? "").toUpperCase();
      if (!ENTITIES.includes(entity)) throw badRequest("A valid X-Entity header is required.");
      const entityId = Number(req.header("x-entity-id"));
      if (!entityId) throw badRequest("An X-Entity-Id header is required.");
      await assertEntityAccess(entity, entityId, req, { forWrite: true });
      const content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!content.length) throw badRequest("No file bytes were received.");
      const user = currentUser(req);
      const filename = String(req.header("x-filename") || "file.bin").slice(0, 180);
      const mime = String(req.header("x-mime-type") || "application/octet-stream").slice(0, 120);
      const category = String(req.header("x-category") || "").slice(0, 60) || null;
      const saved = await saveDocument({
        entity,
        entityId,
        category,
        filename,
        mimeType: mime,
        content,
        uploadedBy: user.id
      });
      await afterUpload(entity, entityId, saved.id, user.id, req);
      const row = await get(
        `SELECT d.*, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = ?`,
        [saved.id]
      );
      created(res, shapeDocument(row));
    } catch (err) {
      next(err);
    }
  }
);
async function afterUpload(entity, entityId, docId, actorId, req) {
  await audit(req, "DOCUMENT_UPLOADED", "document", docId, { entity, entity_id: entityId });
  if (entity === "LEAD") {
    await addTimelineEvent({
      leadId: entityId,
      type: TIMELINE_TYPES.DOCUMENT_UPLOADED,
      actorId,
      summary: "Document uploaded",
      metadata: { document_id: docId }
    });
  }
}
documentsRouter.get("/:id(\\d+)", requireAuth, requirePermission("documents:read"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!row) throw notFound("Document not found.");
    if (row.entity === "GENERAL") {
      const user = currentUser(req);
      if (!user.permissions.includes("documents:manage") && row.uploaded_by !== user.id) {
        throw forbidden("You do not have access to this document.");
      }
    } else {
      await assertEntityAccess(row.entity, row.entity_id, req);
    }
    const full = await get(
      `SELECT d.*, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = ?`,
      [id]
    );
    ok(res, shapeDocument(full));
  } catch (err) {
    next(err);
  }
});
documentsRouter.get("/:id(\\d+)/file", requireAuth, requirePermission("documents:read"), (req, res, next) => {
  void (async () => {
    try {
      const id = Number(req.params.id);
      const row = await get("SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL", [id]);
      if (!row) throw notFound("Document not found.");
      if (row.entity === "GENERAL") {
        const user = currentUser(req);
        if (!user.permissions.includes("documents:manage") && row.uploaded_by !== user.id) {
          throw forbidden("You do not have access to this document.");
        }
      } else {
        await assertEntityAccess(row.entity, row.entity_id, req);
      }
      const { documentPath: documentPath2 } = await Promise.resolve().then(() => (init_documents(), documents_exports));
      const fs5 = await import("node:fs");
      const file = documentPath2(row);
      if (!fs5.existsSync(file)) throw notFound("The file is missing from storage.");
      await audit(req, "DOCUMENT_ACCESSED", "document", row.id, { entity: row.entity, entity_id: row.entity_id });
      res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${row.filename.replace(/"/g, "")}"`);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Length", String(fs5.statSync(file).size));
      fs5.createReadStream(file).pipe(res);
    } catch (err) {
      next(err);
    }
  })();
});
documentsRouter.delete("/:id(\\d+)", requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!row) throw notFound("Document not found.");
    const user = currentUser(req);
    const isUploader = row.uploaded_by === user.id;
    const isManager = user.permissions.includes("documents:manage");
    if (!isManager && !isUploader) {
      throw forbidden("Only the uploader or an admin can delete this document.");
    }
    if (!isManager) {
      if (row.entity === "GENERAL") {
      } else {
        await assertEntityAccess(row.entity, row.entity_id, req);
      }
    }
    const now = await nowISO();
    await run("UPDATE documents SET deleted_at = ? WHERE id = ?", [now, id]);
    deleteDocumentFile(row);
    await audit(req, "DOCUMENT_DELETED", "document", id, { entity: row.entity, entity_id: row.entity_id });
    ok(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});

// src/modules/communications/communications.routes.ts
init_database();
init_errors();
import { Router as Router20 } from "express";
import { z as z15 } from "zod";
var communicationsRouter = Router20();
var CHANNELS = ["WHATSAPP", "EMAIL", "SMS", "IN_APP"];
function shapeMessage(row) {
  return {
    id: row.id,
    channel: row.channel,
    direction: row.direction,
    provider: row.provider ?? null,
    sender_id: row.sender_id ?? null,
    sender_name: row.sender_name ?? null,
    recipient: row.recipient,
    customer_id: row.customer_id ?? null,
    customer_name: row.customer_name ?? null,
    lead_id: row.lead_id ?? null,
    lead_number: row.lead_number ?? null,
    worker_id: row.worker_id ?? null,
    worker_name: row.worker_name ?? null,
    subject: row.subject ?? null,
    body: row.body ?? null,
    status: row.status,
    error: row.error ?? null,
    sent_at: row.sent_at ?? null,
    delivered_at: row.delivered_at ?? null,
    created_at: row.created_at
  };
}
var MSG_SELECT = `
  SELECT m.*, s.name AS sender_name, c.name AS customer_name, l.lead_number, w.name AS worker_name
  FROM communications m
  LEFT JOIN users s ON s.id = m.sender_id
  LEFT JOIN customers c ON c.id = m.customer_id
  LEFT JOIN leads l ON l.id = m.lead_id
  LEFT JOIN users w ON w.id = m.worker_id`;
communicationsRouter.get("/", requireAuth, requirePermission("communications:read"), async (req, res, next) => {
  try {
    const user = currentUser(req);
    const where = ["m.deleted_at IS NULL"];
    const params = [];
    if (!can(req, "leads:read_all")) {
      where.push(
        "(m.worker_id = ? OR m.sender_id = ? OR m.lead_id IN (SELECT id FROM leads WHERE assigned_to = ? AND deleted_at IS NULL))"
      );
      params.push(user.id, user.id, user.id);
    }
    const channels = toArray(req.query.channel);
    if (channels.length) {
      where.push(`m.channel IN (${channels.map(() => "?").join(",")})`);
      params.push(...channels);
    }
    const statuses = toArray(req.query.status);
    if (statuses.length) {
      where.push(`m.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    const leadId = Number(req.query.lead_id);
    if (leadId) {
      where.push("m.lead_id = ?");
      params.push(leadId);
    }
    const customerId = Number(req.query.customer_id);
    if (customerId) {
      where.push("m.customer_id = ?");
      params.push(customerId);
    }
    const search = String(req.query.search ?? "").trim();
    if (search) {
      where.push(`(m.recipient LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\' OR m.body LIKE ? ESCAPE '\\')`);
      const term = await likeTerm(search);
      params.push(term, term, term);
    }
    const dates = resolvePeriodDates(
      String(req.query.period ?? "").trim() || void 0,
      String(req.query.date_from ?? "").trim() || void 0,
      String(req.query.date_to ?? "").trim() || void 0
    );
    if (dates.from) {
      where.push("substr(m.created_at, 1, 10) >= ?");
      params.push(dates.from);
    }
    if (dates.to) {
      where.push("substr(m.created_at, 1, 10) <= ?");
      params.push(dates.to);
    }
    const { page, limit, offset } = pagination(req.query, 20, 100);
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const total = (await get(
      `SELECT COUNT(*) AS c FROM communications m
         LEFT JOIN customers c ON c.id = m.customer_id
         LEFT JOIN leads l ON l.id = m.lead_id
         LEFT JOIN users w ON w.id = m.worker_id
         LEFT JOIN users s ON s.id = m.sender_id ${whereSql}`,
      params
    )).c;
    const rows = await all(`${MSG_SELECT} ${whereSql} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset
    ]);
    list(res, rows.map(shapeMessage), buildMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
});
communicationsRouter.get("/channels", requireAuth, requirePermission("communications:read"), async (_req, res, next) => {
  try {
    ok(res, {
      whatsapp: await channelStatus("WHATSAPP"),
      email: await channelStatus("EMAIL"),
      sms: await channelStatus("SMS"),
      in_app: { configured: true, provider: "internal", base_url: "", secret_present: false }
    });
  } catch (err) {
    next(err);
  }
});
var sendSchema = z15.object({
  channel: z15.enum(CHANNELS),
  lead_id: z15.number().int().positive().optional().nullable(),
  customer_id: z15.number().int().positive().optional().nullable(),
  worker_id: z15.number().int().positive().optional().nullable(),
  recipient: z15.string().trim().max(200).optional().nullable(),
  subject: z15.string().trim().max(300).optional().nullable(),
  body: z15.string().trim().min(1).max(4e3)
}).refine((v) => Boolean(v.lead_id || v.customer_id || v.worker_id || v.recipient), {
  message: "Provide lead_id, customer_id, worker_id, or an explicit recipient."
});
async function resolveRecipient(channel, input, req) {
  if (input.recipient) return input.recipient;
  if (channel === "IN_APP") {
    const target = input.worker_id;
    if (!target) throw badRequest("IN_APP messages need a worker_id.");
    const user = await get("SELECT id, email FROM users WHERE id = ? AND deleted_at IS NULL", [
      target
    ]);
    if (!user) throw notFound("Worker not found.");
    return user.email || `user-${target}`;
  }
  if (input.lead_id) {
    const lead = await get(
      "SELECT c.phone, c.email FROM leads l JOIN customers c ON c.id = l.customer_id WHERE l.id = ?",
      [input.lead_id]
    );
    if (!lead) throw notFound("Lead not found.");
    const value = channel === "EMAIL" ? lead.email : lead.phone;
    if (!value) {
      throw badRequest(
        channel === "EMAIL" ? "This customer has no email address." : "This customer has no phone number."
      );
    }
    return value;
  }
  if (input.customer_id) {
    const customer = await get(
      "SELECT phone, email FROM customers WHERE id = ? AND deleted_at IS NULL",
      [input.customer_id]
    );
    if (!customer) throw notFound("Customer not found.");
    const value = channel === "EMAIL" ? customer.email : customer.phone;
    if (!value) {
      throw badRequest(
        channel === "EMAIL" ? "This customer has no email address." : "This customer has no phone number."
      );
    }
    return value;
  }
  throw badRequest("No recipient could be resolved.");
}
communicationsRouter.post("/", requireAuth, requirePermission("communications:send"), async (req, res, next) => {
  try {
    const body = meta(sendSchema, req.body);
    const user = currentUser(req);
    if (body.lead_id) {
      const lead = await get(
        "SELECT assigned_to FROM leads WHERE id = ? AND deleted_at IS NULL",
        [body.lead_id]
      );
      if (!lead) throw notFound("Lead not found.");
      if (!can(req, "leads:read_all") && lead.assigned_to !== user.id) {
        throw forbidden("You do not have access to this lead.");
      }
    }
    if (body.customer_id && !can(req, "leads:read_all") && !body.lead_id) {
      const owned = await get(
        "SELECT COUNT(*) AS c FROM leads WHERE customer_id = ? AND assigned_to = ? AND deleted_at IS NULL",
        [body.customer_id, user.id]
      );
      if (!owned?.c) throw forbidden("You do not have access to this customer.");
    }
    const recipient = await resolveRecipient(body.channel, body, req);
    if (body.channel === "IN_APP") {
      const now = await nowISO();
      const targetWorker = body.worker_id;
      const id = (await run(
        `INSERT INTO communications
           (channel, direction, provider, sender_id, recipient, customer_id, lead_id, worker_id, subject, body,
            status, sent_at, created_at, updated_at)
         VALUES ('IN_APP', 'OUTBOUND', 'internal', ?, ?, ?, ?, ?, ?, ?, 'SENT', ?, ?, ?)`,
        [
          user.id,
          recipient,
          body.customer_id ?? null,
          body.lead_id ?? null,
          targetWorker,
          body.subject ?? null,
          body.body,
          now,
          now,
          now
        ]
      )).lastInsertRowid;
      await notify({
        userId: targetWorker,
        type: "MESSAGE_RECEIVED",
        title: body.subject || `Message from ${user.name}`,
        body: body.body.slice(0, 400),
        entity: body.lead_id ? "lead" : "customer",
        entityId: body.lead_id ?? body.customer_id ?? 0,
        link: body.lead_id ? `/leads/${body.lead_id}` : "/inbox"
      });
      await audit(req, "MESSAGE_SENT", "communication", id, { channel: "IN_APP", recipient });
      if (body.lead_id) {
        await addTimelineEvent({
          leadId: body.lead_id,
          type: TIMELINE_TYPES.MESSAGE_SENT,
          actorId: user.id,
          summary: `In-app message sent to a worker`,
          metadata: { communication_id: id, channel: "IN_APP" }
        });
      }
      const row2 = await get(`${MSG_SELECT} WHERE m.id = ?`, [id]);
      created(res, { ...shapeMessage(row2), configured: true, reason: null });
      return;
    }
    const result = await sendCommunication({
      channel: body.channel,
      recipient,
      body: body.body,
      subject: body.subject ?? null,
      senderId: user.id,
      leadId: body.lead_id ?? null,
      customerId: body.customer_id ?? null,
      workerId: body.worker_id ?? null
    });
    await audit(req, "MESSAGE_SENT", "communication", result.id, {
      channel: body.channel,
      configured: result.configured,
      status: result.status
    });
    if (body.lead_id) {
      await addTimelineEvent({
        leadId: body.lead_id,
        type: TIMELINE_TYPES.MESSAGE_SENT,
        actorId: user.id,
        summary: result.configured ? `${body.channel} message submitted to provider` : `${body.channel} message recorded (Integration Not Configured)`,
        metadata: { communication_id: result.id, channel: body.channel, status: result.status }
      });
    }
    const row = await get(`${MSG_SELECT} WHERE m.id = ?`, [result.id]);
    created(res, {
      ...shapeMessage(row),
      configured: result.configured,
      reason: result.configured ? null : "Integration Not Configured"
    });
  } catch (err) {
    next(err);
  }
});
communicationsRouter.get("/:id(\\d+)", requireAuth, requirePermission("communications:read"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await get(`${MSG_SELECT} WHERE m.id = ? AND m.deleted_at IS NULL`, [id]);
    if (!row) throw notFound("Message not found.");
    const user = currentUser(req);
    let allowed = can(req, "leads:read_all") || row.worker_id === user.id || row.sender_id === user.id;
    if (!allowed && row.lead_id) {
      const lead = await get("SELECT assigned_to FROM leads WHERE id = ?", [row.lead_id]);
      allowed = lead?.assigned_to === user.id;
    }
    if (!allowed) throw forbidden("You do not have access to this message.");
    ok(res, shapeMessage(row));
  } catch (err) {
    next(err);
  }
});

// src/modules/analytics/analytics.routes.ts
init_database();
init_errors();
import { Router as Router21 } from "express";
var analyticsRouter = Router21();
function periodWindow2(query2) {
  const q = query2 ?? {};
  const period = String(q.period ?? "").trim() || "month";
  const now = /* @__PURE__ */ new Date();
  const today = todayStr();
  if (period === "today") return { from: today, to: today, granularity: "day" };
  if (period === "week") {
    const day = now.getUTCDay() || 7;
    const start2 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1)));
    return { from: start2.toISOString().slice(0, 10), to: today, granularity: "day" };
  }
  if (period === "quarter") {
    const month = Math.floor(now.getUTCMonth() / 3) * 3 + 1;
    return { from: `${now.getUTCFullYear()}-${String(month).padStart(2, "0")}-01`, to: today, granularity: "day" };
  }
  if (period === "year") return { from: `${now.getUTCFullYear()}-01-01`, to: today, granularity: "month" };
  const days = Number(q.days) || 30;
  const start = new Date(now.getTime() - (days - 1) * 864e5);
  return { from: start.toISOString().slice(0, 10), to: today, granularity: "day" };
}
analyticsRouter.get("/overview", requireAuth, requirePermission("analytics:read"), async (req, res, next) => {
  try {
    const { from, to, granularity } = periodWindow2(req.query);
    const leadsCreated = await all(
      `SELECT substr(created_at, 1, ${granularity === "month" ? 7 : 10}) AS bucket, COUNT(*) AS c
       FROM leads WHERE deleted_at IS NULL AND substr(created_at, 1, 10) BETWEEN ? AND ?
       GROUP BY bucket ORDER BY bucket`,
      [from, to]
    );
    const leadsWon = await all(
      `SELECT substr(h.changed_at, 1, ${granularity === "month" ? 7 : 10}) AS bucket, COUNT(*) AS c
       FROM lead_status_history h
       JOIN lead_statuses ts ON ts.id = h.to_status_id
       WHERE ts.code = 'CONVERTED' AND substr(h.changed_at, 1, 10) BETWEEN ? AND ?
       GROUP BY bucket ORDER BY bucket`,
      [from, to]
    );
    const followUps = await all(
      `SELECT substr(scheduled_date, 1, ${granularity === "month" ? 7 : 10}) AS bucket,
              COUNT(*) AS due,
              SUM(CASE WHEN status IN ('COMPLETED','CONVERTED') THEN 1 ELSE 0 END) AS completed
       FROM follow_ups WHERE scheduled_date BETWEEN ? AND ?
       GROUP BY bucket ORDER BY bucket`,
      [from, to]
    );
    const calls = await all(
      `SELECT substr(COALESCE(started_at, created_at), 1, ${granularity === "month" ? 7 : 10}) AS bucket,
              COUNT(*) AS total,
              SUM(CASE WHEN status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS connected,
              COALESCE(SUM(duration_seconds), 0) AS seconds
       FROM calls WHERE deleted_at IS NULL AND substr(COALESCE(started_at, created_at), 1, 10) BETWEEN ? AND ?
       GROUP BY bucket ORDER BY bucket`,
      [from, to]
    );
    const revenue = await all(
      `SELECT substr(created_at, 1, 7) AS bucket,
              COALESCE(SUM(total_amount), 0) AS amount,
              COALESCE(SUM(paid_amount), 0) AS paid,
              COUNT(*) AS count
       FROM bookings
       WHERE deleted_at IS NULL AND status != 'CANCELLED'
         AND substr(created_at, 1, 10) BETWEEN date(?, '-365 day') AND ?
       GROUP BY bucket ORDER BY bucket`,
      [from, to]
    );
    ok(res, {
      period: { from, to, granularity },
      leads_created: leadsCreated.map((r) => ({ bucket: r.bucket, count: Number(r.c) })),
      leads_won: leadsWon.map((r) => ({ bucket: r.bucket, count: Number(r.c) })),
      follow_ups: followUps.map((r) => ({
        bucket: r.bucket,
        due: Number(r.due),
        completed: Number(r.completed)
      })),
      calls: calls.map((r) => ({
        bucket: r.bucket,
        total: Number(r.total),
        connected: Number(r.connected),
        seconds: Number(r.seconds)
      })),
      bookings: revenue.map((r) => ({
        bucket: r.bucket,
        count: Number(r.count),
        amount: Number(r.amount),
        paid: Number(r.paid)
      }))
    });
  } catch (err) {
    next(err);
  }
});
async function metricsFor(workerId, from, to) {
  const leadScope = workerId ? "AND l.assigned_to = ?" : "";
  const fuScope = workerId ? "AND f.worker_id = ?" : "";
  const callScope = workerId ? "AND cl.worker_id = ?" : "";
  const quoteScope = workerId ? "AND q.worker_id = ?" : "";
  const bookingScope = workerId ? "AND b.worker_id = ?" : "";
  const p1 = workerId ? [workerId] : [];
  const leads = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN ls.code = 'CONVERTED' THEN 1 ELSE 0 END) AS converted
     FROM leads l JOIN lead_statuses ls ON ls.id = l.status_id
     WHERE l.deleted_at IS NULL AND substr(l.created_at, 1, 10) BETWEEN ? AND ? ${leadScope}`,
    [from, to, ...p1]
  );
  const fu = await get(
    `SELECT COUNT(*) AS due,
            SUM(CASE WHEN f.status IN ('COMPLETED','CONVERTED') THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN f.status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED') AND f.scheduled_date < ?
                THEN 1 ELSE 0 END) AS overdue
     FROM follow_ups f
     WHERE f.scheduled_date BETWEEN ? AND ? ${fuScope}`,
    [todayStr(), from, to, ...p1]
  );
  const calls = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN cl.status IN ('ANSWERED','COMPLETED') THEN 1 ELSE 0 END) AS connected,
            COALESCE(SUM(cl.duration_seconds), 0) AS seconds
     FROM calls cl
     WHERE cl.deleted_at IS NULL AND substr(COALESCE(cl.started_at, cl.created_at), 1, 10) BETWEEN ? AND ? ${callScope}`,
    [from, to, ...p1]
  );
  const quotes = await get(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN q.status = 'ACCEPTED' THEN 1 ELSE 0 END) AS accepted
     FROM quotations q
     WHERE q.deleted_at IS NULL AND substr(q.created_at, 1, 10) BETWEEN ? AND ? ${quoteScope}`,
    [from, to, ...p1]
  );
  const bookings = await get(
    `SELECT COUNT(*) AS total, COALESCE(SUM(b.total_amount), 0) AS amount, COALESCE(SUM(b.paid_amount), 0) AS paid
     FROM bookings b
     WHERE b.deleted_at IS NULL AND b.status != 'CANCELLED'
       AND substr(b.created_at, 1, 10) BETWEEN ? AND ? ${bookingScope}`,
    [from, to, ...p1]
  );
  let name = "";
  let status = "ACTIVE";
  if (workerId) {
    const user = await get("SELECT name, status FROM users WHERE id = ?", [workerId]);
    if (!user) return null;
    name = user.name;
    status = user.status;
  }
  return {
    id: workerId ?? 0,
    name,
    status,
    leads: Number(leads.total ?? 0),
    leads_converted: Number(leads.converted ?? 0),
    follow_ups_due: Number(fu.due ?? 0),
    follow_ups_completed: Number(fu.completed ?? 0),
    follow_ups_overdue: Number(fu.overdue ?? 0),
    calls: Number(calls.total ?? 0),
    calls_connected: Number(calls.connected ?? 0),
    call_seconds: Number(calls.seconds ?? 0),
    quotations: Number(quotes.total ?? 0),
    quotations_accepted: Number(quotes.accepted ?? 0),
    bookings: Number(bookings.total ?? 0),
    booking_amount: Number(bookings.amount ?? 0),
    booking_paid: Number(bookings.paid ?? 0)
  };
}
analyticsRouter.get("/workers", requireAuth, requirePermission("analytics:read"), async (req, res, next) => {
  try {
    const { from, to } = periodWindow2(req.query);
    const workers = await all(
      `SELECT id, name, status FROM users
       WHERE deleted_at IS NULL AND id != 1
       ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, name COLLATE NOCASE`
    );
    const rows = (await Promise.all(
      workers.map(async (w) => {
        const m = await metricsFor(w.id, from, to);
        return m ? { ...m, name: w.name, status: w.status } : null;
      })
    )).filter(Boolean);
    ok(res, { period: { from, to }, workers: rows });
  } catch (err) {
    next(err);
  }
});
analyticsRouter.get("/workers/:id(\\d+)", requireAuth, requirePermission("analytics:read"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { from, to } = periodWindow2(req.query);
    const worker = await get(
      "SELECT id, name, email, status, role_id FROM users WHERE id = ? AND deleted_at IS NULL",
      [id]
    );
    if (!worker) throw notFound("Worker not found.");
    const metrics = await metricsFor(id, from, to);
    const byLeadStatus = await all(
      `SELECT ls.code, ls.name, COUNT(l.id) AS c
       FROM lead_statuses ls
       LEFT JOIN leads l ON l.status_id = ls.id AND l.deleted_at IS NULL AND l.assigned_to = ?
       WHERE ls.is_active = 1
       GROUP BY ls.id ORDER BY ls.sort_order`,
      [id]
    );
    const upcoming = await all(
      `SELECT f.id, f.scheduled_date, f.scheduled_time, f.type, f.status, l.lead_number, l.destination, c.name AS customer_name
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
       WHERE f.worker_id = ? AND f.status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED')
         AND l.deleted_at IS NULL
       ORDER BY f.scheduled_date ASC, f.scheduled_time ASC LIMIT 10`,
      [id]
    );
    const recentActivity = await all(
      `SELECT t.id, t.type, t.summary, t.created_at, l.lead_number
       FROM lead_timeline t
       JOIN leads l ON l.id = t.lead_id
       WHERE t.actor_id = ? AND l.deleted_at IS NULL
       ORDER BY t.id DESC LIMIT 20`,
      [id]
    );
    const leadsByDestination = await all(
      `SELECT destination, COUNT(*) AS c FROM leads
       WHERE assigned_to = ? AND deleted_at IS NULL AND substr(created_at, 1, 10) BETWEEN ? AND ?
       GROUP BY destination ORDER BY c DESC LIMIT 10`,
      [id, from, to]
    );
    ok(res, {
      period: { from, to },
      worker: { id: worker.id, name: worker.name, email: worker.email, status: worker.status },
      metrics,
      by_lead_status: byLeadStatus.map((r) => ({ code: r.code, name: r.name, count: Number(r.c) })),
      by_destination: leadsByDestination.map((r) => ({ destination: r.destination ?? "(unset)", count: Number(r.c) })),
      upcoming_follow_ups: upcoming,
      recent_activity: recentActivity
    });
  } catch (err) {
    next(err);
  }
});

// src/modules/ai/ai.routes.ts
init_database();
init_errors();
import { Router as Router22 } from "express";
import { z as z16 } from "zod";
var aiRouter = Router22();
aiRouter.get("/status", requireAuth, requirePermission("ai:use"), async (_req, res, next) => {
  try {
    ok(res, await aiStatus());
  } catch (err) {
    next(err);
  }
});
async function leadContext(req, leadId) {
  await loadLead(leadId, req);
  const lead = await get(
    `SELECT l.*, ls.code AS status_code, ls.name AS status_name, c.name AS customer_name, c.phone AS customer_phone,
            c.email AS customer_email, src.name AS source_name, w.name AS worker_name
     FROM leads l
     JOIN customers c ON c.id = l.customer_id
     JOIN lead_statuses ls ON ls.id = l.status_id
     LEFT JOIN lead_sources src ON src.id = l.source_id
     LEFT JOIN users w ON w.id = l.assigned_to
     WHERE l.id = ? AND l.deleted_at IS NULL`,
    [leadId]
  );
  if (!lead) throw notFound("Lead not found.");
  const followUps = await all(
    `SELECT f.scheduled_date, f.scheduled_time, f.type, f.status, f.notes, f.next_action, f.customer_response, w.name AS worker
     FROM follow_ups f JOIN users w ON w.id = f.worker_id
     WHERE f.lead_id = ? ORDER BY f.scheduled_date DESC, f.id DESC LIMIT 10`,
    [leadId]
  );
  const calls = await all(
    `SELECT cl.direction, cl.status, cl.duration_seconds, cl.started_at, cl.disposition, cl.notes, w.name AS worker
     FROM calls cl LEFT JOIN users w ON w.id = cl.worker_id
     WHERE cl.lead_id = ? AND cl.deleted_at IS NULL
     ORDER BY COALESCE(cl.started_at, cl.created_at) DESC LIMIT 10`,
    [leadId]
  );
  const notes = await all(
    `SELECT n.content, n.created_at, u.name AS author FROM notes n LEFT JOIN users u ON u.id = n.author_id
     WHERE n.lead_id = ? AND n.deleted_at IS NULL ORDER BY n.id DESC LIMIT 10`,
    [leadId]
  );
  const quotations = await all(
    `SELECT quotation_number, status, total_amount, currency, valid_until FROM quotations
     WHERE lead_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`,
    [leadId]
  );
  const promptData = [
    `Lead: ${lead.lead_number} | Customer: ${lead.customer_name} (${lead.customer_phone ?? "no phone"})`,
    `Status: ${lead.status_code} | Priority: ${lead.priority} | Source: ${lead.source_name ?? "unknown"} | Owner: ${lead.worker_name ?? "unassigned"}`,
    `Destination: ${lead.destination ?? "unset"} | Trip: ${lead.trip_type ?? "-"} | Travel: ${lead.travel_start_date ?? "?"} \u2192 ${lead.travel_end_date ?? "?"} | Budget: ${lead.budget ?? "unset"} ${lead.currency}`,
    `Requirements: ${lead.requirements}`,
    `Notes: ${lead.notes ?? "-"}`,
    followUps.length ? `Recent follow-ups:
${followUps.map(
      (f) => `- ${f.scheduled_date} ${f.scheduled_time ?? ""} ${f.type} [${f.status}] by ${f.worker}: ${f.notes ?? ""}${f.customer_response ? ` | response: ${f.customer_response}` : ""}`
    ).join("\n")}` : "Recent follow-ups: none",
    calls.length ? `Recent calls:
${calls.map(
      (c) => `- ${c.started_at ?? "-"} ${c.direction} ${c.status} ${c.duration_seconds ?? 0}s by ${c.worker ?? "-"}: ${c.disposition ?? ""} ${c.notes ?? ""}`
    ).join("\n")}` : "Recent calls: none",
    quotations.length ? `Quotations:
${quotations.map((q) => `- ${q.quotation_number} ${q.status} ${q.currency} ${q.total_amount} valid until ${q.valid_until ?? "-"}`).join("\n")}` : "Quotations: none",
    notes.length ? `Notes:
${notes.map((n) => `- (${n.created_at}, ${n.author ?? "-"}) ${n.content}`).join("\n")}` : "Notes: none"
  ].join("\n");
  return { promptData, lead };
}
aiRouter.post("/summary", requireAuth, requirePermission("ai:use"), async (req, res, next) => {
  try {
    const body = meta(z16.object({ lead_id: z16.number().int().positive() }), req.body);
    const status = await aiStatus();
    if (!status.configured) {
      ok(res, { configured: false, reason: status.reason ?? "Integration Not Configured", draft: null });
      return;
    }
    const { promptData, lead } = await leadContext(req, body.lead_id);
    const provider = await getAiProvider();
    const draft = await provider.complete(
      [
        "You are a concise travel-agency CRM assistant.",
        "Summarise the lead for the assigned worker: current situation, customer intent,",
        "what happened so far, risks, and the recommended next action.",
        "Use short bullet points. Do not invent facts that are not in the data.",
        "Max 150 words. This is a draft for human review."
      ].join(" "),
      promptData
    );
    const user = currentUser(req);
    await audit(req, "AI_SUMMARY_DRAFTED", "lead", body.lead_id, { provider: provider.code, model: provider.model });
    await addTimelineEvent({
      leadId: body.lead_id,
      type: TIMELINE_TYPES.AI_SUMMARY_GENERATED,
      actorId: user.id,
      summary: "AI draft summary generated (not saved)",
      metadata: { provider: provider.code, model: provider.model }
    });
    ok(res, { configured: true, reason: null, draft, provider: provider.code, model: provider.model });
  } catch (err) {
    next(err);
  }
});
aiRouter.post("/message-draft", requireAuth, requirePermission("ai:use"), async (req, res, next) => {
  try {
    const body = meta(
      z16.object({
        lead_id: z16.number().int().positive(),
        channel: z16.enum(["WHATSAPP", "EMAIL", "SMS", "IN_APP"]).default("WHATSAPP"),
        purpose: z16.string().trim().max(200).optional().nullable()
      }),
      req.body
    );
    const status = await aiStatus();
    if (!status.configured) {
      ok(res, { configured: false, reason: status.reason ?? "Integration Not Configured", draft: null });
      return;
    }
    const { promptData } = await leadContext(req, body.lead_id);
    const provider = await getAiProvider();
    const draft = await provider.complete(
      [
        `Draft a friendly ${body.channel} message from a travel agency to this customer.`,
        body.purpose ? `Purpose: ${body.purpose}.` : "Purpose: follow up on the enquiry.",
        "Tone: warm, professional, max 80 words, no placeholders like [NAME].",
        "Return only the message text."
      ].join(" "),
      promptData
    );
    const user = currentUser(req);
    await audit(req, "AI_MESSAGE_DRAFTED", "lead", body.lead_id, {
      provider: provider.code,
      channel: body.channel
    });
    ok(res, { configured: true, reason: null, draft, provider: provider.code, model: provider.model });
  } catch (err) {
    next(err);
  }
});

// src/modules/automation/automation.routes.ts
init_database();
init_errors();
import { Router as Router23 } from "express";
import { z as z17 } from "zod";

// src/services/scheduler.ts
init_database();
var TERMINAL_SQL3 = `('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')`;
async function purgeExpiredAuth() {
  const now = await nowISO();
  const graceCutoff = addDays(now, -7);
  const sessions = (await run("DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?", [now, graceCutoff])).changes;
  const resetTokens = (await run("DELETE FROM password_reset_tokens WHERE expires_at < ? OR used_at < ?", [
    now,
    graceCutoff
  ])).changes;
  return { sessions, reset_tokens: resetTokens };
}
async function notifyDueFollowUps() {
  const { enabled } = await reminderConfig();
  if (!enabled) return 0;
  const today = todayStr();
  const rows = await all(
    `SELECT f.id, f.worker_id, f.lead_id, f.scheduled_date, l.lead_number, c.name AS customer_name
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
      WHERE f.deleted_at IS NULL AND l.deleted_at IS NULL
        AND f.status NOT IN ${TERMINAL_SQL3}
        AND f.scheduled_date = ?
        AND f.reminder_sent_at IS NULL
      ORDER BY f.scheduled_date ASC, f.scheduled_time ASC
      LIMIT 200`,
    [today]
  );
  let count = 0;
  for (const row of rows) {
    await notify({
      userId: row.worker_id,
      type: "FOLLOW_UP_DUE",
      title: `Follow-up due today: ${row.lead_number}`,
      body: `${row.customer_name} \xB7 scheduled ${row.scheduled_date}`,
      entity: "follow_up",
      entityId: row.id,
      link: `/follow-ups?lead_id=${row.lead_id}`
    });
    await run("UPDATE follow_ups SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL", [await nowISO(), row.id]);
    count += 1;
  }
  return count;
}
async function notifyOverdueFollowUps() {
  const { overdue_enabled } = await reminderConfig();
  if (!overdue_enabled) return 0;
  const today = todayStr();
  const rows = await all(
    `SELECT f.id, f.worker_id, f.lead_id, f.scheduled_date, l.lead_number, c.name AS customer_name
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
       JOIN customers c ON c.id = l.customer_id
      WHERE f.deleted_at IS NULL AND l.deleted_at IS NULL
        AND f.status NOT IN ${TERMINAL_SQL3}
        AND f.scheduled_date < ?
        AND f.overdue_reminder_sent_at IS NULL
      ORDER BY f.scheduled_date ASC
      LIMIT 200`,
    [today]
  );
  let count = 0;
  for (const row of rows) {
    await notify({
      userId: row.worker_id,
      type: "FOLLOW_UP_OVERDUE",
      title: `Overdue follow-up: ${row.lead_number}`,
      body: `${row.customer_name} \xB7 was due ${row.scheduled_date}`,
      entity: "follow_up",
      entityId: row.id,
      link: `/follow-ups?lead_id=${row.lead_id}`
    });
    await run("UPDATE follow_ups SET overdue_reminder_sent_at = ? WHERE id = ? AND overdue_reminder_sent_at IS NULL", [
      await nowISO(),
      row.id
    ]);
    count += 1;
  }
  return count;
}
async function expireQuotations() {
  const today = todayStr();
  const rows = await all(
    `SELECT id, lead_id, quotation_number, created_by FROM quotations
      WHERE deleted_at IS NULL AND valid_until IS NOT NULL AND valid_until < ?
        AND status IN ('SENT','VIEWED','NEGOTIATION')`,
    [today]
  );
  if (!rows.length) return 0;
  const now = await nowISO();
  await tx(async () => {
    for (const row of rows) {
      const history = await appendStatusHistory(row.id, "EXPIRED", row.created_by);
      await run(`UPDATE quotations SET status = 'EXPIRED', status_history = ?, updated_at = ? WHERE id = ?`, [
        history,
        now,
        row.id
      ]);
      await addTimelineEvent({
        leadId: row.lead_id,
        type: TIMELINE_TYPES.QUOTATION_EXPIRED,
        actorId: row.created_by,
        summary: `Quotation ${row.quotation_number} expired`,
        metadata: { quotation_id: row.id }
      });
      if (row.created_by) {
        await notify({
          userId: row.created_by,
          type: "QUOTATION_EXPIRED",
          title: `Quotation expired: ${row.quotation_number}`,
          body: "The validity date has passed.",
          entity: "quotation",
          entityId: row.id,
          link: `/quotations?lead_id=${row.lead_id}`
        });
      }
    }
  });
  return rows.length;
}
function pushHistoryEntry(current, entry) {
  try {
    const parsed = JSON.parse(current ?? "[]");
    const list2 = Array.isArray(parsed) ? parsed : [];
    list2.push(entry);
    return JSON.stringify(list2.slice(-50));
  } catch {
    return JSON.stringify([entry]);
  }
}
async function appendStatusHistory(quotationId, toStatus, actorId) {
  const row = await get("SELECT status_history, status FROM quotations WHERE id = ?", [
    quotationId
  ]);
  return pushHistoryEntry(row?.status_history ?? "[]", {
    from: row?.status,
    to: toStatus,
    actor_id: actorId,
    at: await nowISO(),
    source: "automation"
  });
}
async function runAutomationOnce() {
  const ran = {
    due_reminders: 0,
    overdue_reminders: 0,
    quotations_expired: 0,
    recordings_expired: 0,
    ran_at: await nowISO()
  };
  try {
    ran.due_reminders = await notifyDueFollowUps();
    ran.overdue_reminders = await notifyOverdueFollowUps();
    ran.quotations_expired = await expireQuotations();
    await applyRecordingRetention();
    await purgeExpiredAuth();
  } catch (err) {
    console.error("[automation] run failed", err);
  }
  await writeSetting("automation_last_run", ran);
  return ran;
}
async function applyRecordingRetention() {
  const policyRetention = (await callPolicy()).retention_days;
  const now = await nowISO();
  const rows = await all(
    `SELECT id, call_id FROM call_recordings
      WHERE deleted_at IS NULL AND retention_until IS NOT NULL AND retention_until < ?`,
    [now.slice(0, 10)]
  );
  if (!rows.length) return 0;
  for (const row of rows) {
    await run("UPDATE call_recordings SET status = ?, deleted_at = ?, updated_at = ? WHERE id = ?", ["DELETED", now, now, row.id]);
    await run("UPDATE calls SET recording_available = 0, updated_at = ? WHERE id = ?", [now, row.call_id]);
  }
  await auditAs(null, "RETENTION_APPLIED", "call_recording", null, { count: rows.length, policy_days: policyRetention });
  return rows.length;
}
var timer = null;
async function automationStatus() {
  return {
    last_run: await readSetting("automation_last_run", null),
    scheduler_enabled: Boolean(timer),
    reminders: await reminderConfig()
  };
}

// src/modules/automation/automation.routes.ts
var automationRouter = Router23();
var runSchema2 = z17.object({
  assign: z17.boolean().optional()
}).strict();
automationRouter.get("/status", requireAuth, requirePermission("automation:manage"), async (_req, res, next) => {
  try {
    const status = await automationStatus();
    const counts = {
      unassigned_leads: (await get(
        "SELECT COUNT(*) AS c FROM leads WHERE assigned_to IS NULL AND deleted_at IS NULL"
      )).c,
      overdue_follow_ups: (await get(
        `SELECT COUNT(*) AS c FROM follow_ups f JOIN leads l ON l.id = f.lead_id
         WHERE f.deleted_at IS NULL AND l.deleted_at IS NULL
           AND f.scheduled_date < date('now') AND f.status NOT IN ('COMPLETED','CONVERTED','NOT_INTERESTED','CANCELLED')`
      )).c,
      expiring_quotations: (await get(
        `SELECT COUNT(*) AS c FROM quotations
         WHERE deleted_at IS NULL AND status IN ('SENT','VIEWED','NEGOTIATION')
           AND valid_until IS NOT NULL AND valid_until < date('now')`
      )).c,
      open_duplicate_reviews: (await get(
        `SELECT COUNT(*) AS c FROM duplicate_reviews WHERE status = 'OPEN'`
      )).c,
      pending_imports: (await get(`SELECT COUNT(*) AS c FROM import_jobs WHERE status IN ('PARSED')`)).c
    };
    ok(res, { ...status, assignment: await assignmentConfig(), counts });
  } catch (err) {
    next(err);
  }
});
automationRouter.post("/run", requireAuth, requirePermission("automation:manage"), async (req, res, next) => {
  try {
    const user = currentUser(req);
    if (req.body !== void 0 && req.body !== null && (typeof req.body !== "object" || Array.isArray(req.body))) {
      throw badRequest("Request body must be a JSON object.");
    }
    const parsed = runSchema2.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("Invalid automation run payload.");
    const assign = parsed.data.assign === true;
    const ran = await runAutomationOnce();
    const assigned = assign ? await autoAssignPending({ actorId: user.id, actorName: user.name }) : null;
    await audit(req, "AUTOMATION_RUN", "automation", null, { ...ran, assigned });
    ok(res, { ran, assigned });
  } catch (err) {
    next(err);
  }
});
automationRouter.post("/assign", requireAuth, requirePermission("automation:manage"), async (req, res, next) => {
  try {
    const user = currentUser(req);
    const result = await autoAssignPending({ actorId: user.id, actorName: user.name });
    await audit(req, "AUTO_ASSIGN_RUN", "lead", null, result);
    ok(res, result);
  } catch (err) {
    next(err);
  }
});

// src/app.ts
function createApp() {
  const app2 = express();
  app2.disable("x-powered-by");
  app2.set("trust proxy", config.trustProxy);
  app2.use("/api/webhooks", raw3({ type: "*/*", limit: "2mb" }));
  app2.use(express.json({ limit: "1mb" }));
  app2.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "font-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'"
      ].join("; ")
    );
    if (config.isProduction && (req.secure || config.trustProxy)) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });
  app2.use(originGuard);
  app2.use(sessionLoader);
  app2.use("/api/webhooks", telephonyWebhooksRouter);
  if (!config.isTest) {
    app2.use(
      "/api",
      rateLimit2({
        windowMs: config.rateLimit.windowMs,
        max: config.rateLimit.max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." } }
      })
    );
  }
  app2.get("/api/health", (_req, res) => {
    res.json({ status: "ok", time: (/* @__PURE__ */ new Date()).toISOString(), version: "1.0.0" });
  });
  app2.use("/api/auth", authRouter);
  app2.use("/api/users", usersRouter);
  app2.use("/api/customers", customersRouter);
  app2.use("/api/leads", leadsRouter);
  app2.use("/api/follow-ups", followUpsRouter);
  app2.use("/api/calls", callsRouter);
  app2.use("/api/quotations", quotationsRouter);
  app2.use("/api/bookings", bookingsRouter);
  app2.use("/api/invoices", invoicesRouter);
  app2.use("/api/reports", reportsRouter);
  app2.use("/api/imports", importsRouter);
  app2.use("/api/duplicates", duplicatesRouter);
  app2.use("/api/documents", documentsRouter);
  app2.use("/api/communications", communicationsRouter);
  app2.use("/api/analytics", analyticsRouter);
  app2.use("/api/ai", aiRouter);
  app2.use("/api/automation", automationRouter);
  app2.use("/api/dashboard", dashboardRouter);
  app2.use("/api/workload", workloadRouter);
  app2.use("/api/meta", metaRouter);
  app2.use("/api", auditRouter);
  app2.use("/api/notifications", notificationsRouter);
  app2.use("/api", notFoundHandler);
  if (config.serveClient && fs4.existsSync(path4.join(config.clientDist, "index.html"))) {
    app2.use(express.static(config.clientDist, { index: false, maxAge: "1h" }));
    app2.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path4.join(config.clientDist, "index.html"));
    });
  }
  app2.use(notFoundHandler);
  app2.use(errorHandler);
  return app2;
}

// src/db/migrate.ts
init_database();

// src/db/migrations.ts
var migrations = [
  {
    id: "001",
    name: "core_schema",
    sql: `
-- ============================ RBAC ============================
CREATE TABLE roles (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE permissions (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',
  created_at TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  username      TEXT,
  password_hash TEXT NOT NULL,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  status        TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED')),
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE UNIQUE INDEX idx_users_email ON users(lower(email)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_users_username ON users(lower(username)) WHERE username IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,          -- sha256(token)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ========================= CUSTOMERS ==========================
CREATE TABLE customers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  whatsapp   TEXT,
  email      TEXT,
  city       TEXT,
  state      TEXT,
  country    TEXT,
  notes      TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_customers_name ON customers(name);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_whatsapp ON customers(whatsapp);
CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_active ON customers(deleted_at, name);

-- ============================ LEADS ===========================
CREATE TABLE lead_sources (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE lead_statuses (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'OPEN'
             CHECK (category IN ('OPEN','WON','LOST','NEUTRAL')),
  color      TEXT NOT NULL DEFAULT '#64748b',
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE leads (
  id               INTEGER PRIMARY KEY,
  lead_number      TEXT NOT NULL UNIQUE,
  customer_id      INTEGER NOT NULL REFERENCES customers(id),
  source_id        INTEGER REFERENCES lead_sources(id),
  assigned_to      INTEGER REFERENCES users(id),
  destination      TEXT,
  travel_type      TEXT CHECK (travel_type IN ('DOMESTIC','INTERNATIONAL')),
  trip_type        TEXT,
  requirements     TEXT NOT NULL DEFAULT '[]',
  travel_start_date TEXT,
  travel_end_date   TEXT,
  duration_days    INTEGER,
  adults           INTEGER,
  children         INTEGER,
  total_travelers  INTEGER,
  budget           REAL,
  currency         TEXT NOT NULL DEFAULT 'INR',
  priority         TEXT NOT NULL DEFAULT 'MEDIUM'
                   CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status_id        INTEGER NOT NULL REFERENCES lead_statuses(id),
  last_contacted_at TEXT,
  next_follow_up_at TEXT,
  notes             TEXT,
  custom_fields    TEXT NOT NULL DEFAULT '{}',
  created_by       INTEGER REFERENCES users(id),
  updated_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX idx_leads_customer ON leads(customer_id);
CREATE INDEX idx_leads_status ON leads(status_id);
CREATE INDEX idx_leads_source ON leads(source_id);
CREATE INDEX idx_leads_created ON leads(created_at);
CREATE INDEX idx_leads_next_fu ON leads(next_follow_up_at);
CREATE INDEX idx_leads_active ON leads(deleted_at, assigned_to, status_id);
CREATE INDEX idx_leads_dest ON leads(destination);

CREATE TABLE lead_assignments (
  id          INTEGER PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL CHECK (action IN ('ASSIGNED','REASSIGNED','UNASSIGNED')),
  reason      TEXT,
  assigned_at TEXT NOT NULL,
  released_at TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_assign_lead ON lead_assignments(lead_id, is_active);
CREATE INDEX idx_assign_worker ON lead_assignments(assigned_to, is_active);
CREATE INDEX idx_assign_at ON lead_assignments(assigned_at);

CREATE TABLE lead_status_history (
  id             INTEGER PRIMARY KEY,
  lead_id        INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_status_id INTEGER REFERENCES lead_statuses(id),
  to_status_id   INTEGER NOT NULL REFERENCES lead_statuses(id),
  changed_by     INTEGER REFERENCES users(id),
  remark         TEXT,
  changed_at     TEXT NOT NULL
);
CREATE INDEX idx_status_hist_lead ON lead_status_history(lead_id, changed_at);

-- Extensible event log powering the lead timeline.
-- Part 2 will append new event types (CALL_INITIATED, QUOTATION_SENT, ...)
-- without changing this schema.
CREATE TABLE lead_timeline (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  actor_id   INTEGER REFERENCES users(id),
  summary    TEXT NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_timeline_lead ON lead_timeline(lead_id, created_at);
CREATE INDEX idx_timeline_actor ON lead_timeline(actor_id, created_at);
CREATE INDEX idx_timeline_type ON lead_timeline(type, created_at);

CREATE TABLE notes (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_notes_lead ON notes(lead_id, created_at);

-- ========================== FOLLOW-UPS ========================
CREATE TABLE follow_ups (
  id                INTEGER PRIMARY KEY,
  lead_id           INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  worker_id         INTEGER NOT NULL REFERENCES users(id),
  scheduled_date    TEXT NOT NULL,          -- YYYY-MM-DD (business timezone)
  scheduled_time    TEXT,                   -- HH:MM
  type              TEXT NOT NULL DEFAULT 'CALL',
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','TODAY','COMPLETED','CONVERTED','NOT_INTERESTED',
                                      'RESCHEDULED','NO_RESPONSE','CALLBACK_REQUESTED','OVERDUE','CANCELLED')),
  notes             TEXT,
  customer_response TEXT,
  next_action       TEXT,
  created_by        INTEGER REFERENCES users(id),
  completed_by      INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  completed_at      TEXT,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_fu_worker_date ON follow_ups(worker_id, scheduled_date);
CREATE INDEX idx_fu_lead ON follow_ups(lead_id, scheduled_date);
CREATE INDEX idx_fu_status ON follow_ups(status);
CREATE INDEX idx_fu_date ON follow_ups(scheduled_date);
CREATE INDEX idx_fu_active ON follow_ups(deleted_at, worker_id, scheduled_date);

-- ======================== NOTIFICATIONS =======================
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  entity     TEXT,
  entity_id  INTEGER,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notif_user ON notifications(user_id, read_at, created_at);

-- ========================== AUDIT LOG =========================
CREATE TABLE audit_logs (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  metadata   TEXT NOT NULL DEFAULT '{}',
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at);

-- =========================== SETTINGS =========================
CREATE TABLE settings (
  setting_key TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`
  },
  {
    id: "002",
    name: "part2_operations",
    sql: `
-- ============================ CALLS ===========================
-- Provider-independent call records. Written manually by workers or by
-- telephony webhooks; provider_call_id is unique per provider so duplicate
-- webhook events can never create a second row.
CREATE TABLE calls (
  id                INTEGER PRIMARY KEY,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  worker_id         INTEGER NOT NULL REFERENCES users(id),
  provider          TEXT NOT NULL DEFAULT 'manual',
  provider_call_id  TEXT,
  direction         TEXT NOT NULL DEFAULT 'OUTBOUND'
                    CHECK (direction IN ('INBOUND','OUTBOUND')),
  phone_number      TEXT,
  started_at        TEXT,
  answered_at       TEXT,
  ended_at          TEXT,
  duration_seconds  INTEGER,
  status            TEXT NOT NULL DEFAULT 'RINGING',
  disposition       TEXT,
  recording_available INTEGER NOT NULL DEFAULT 0,
  recording_ref     TEXT,
  consent           TEXT,
  notes             TEXT,
  follow_up_id      INTEGER REFERENCES follow_ups(id) ON DELETE SET NULL,
  webhook_event_id  TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE UNIQUE INDEX idx_calls_provider ON calls(provider, provider_call_id)
  WHERE provider_call_id IS NOT NULL;
CREATE INDEX idx_calls_lead ON calls(lead_id, started_at);
CREATE INDEX idx_calls_customer ON calls(customer_id, started_at);
CREATE INDEX idx_calls_worker ON calls(worker_id, started_at);
CREATE INDEX idx_calls_started ON calls(started_at);
CREATE INDEX idx_calls_status ON calls(status);

-- Recordings are never linked from public URLs: source_url/file_key stay
-- server-side and playback goes through an authenticated, audited endpoint.
CREATE TABLE call_recordings (
  id                   INTEGER PRIMARY KEY,
  call_id              INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL DEFAULT 'manual',
  provider_recording_id TEXT,
  storage              TEXT NOT NULL DEFAULT 'provider'
                       CHECK (storage IN ('provider','local')),
  source_url           TEXT,
  file_key             TEXT,
  mime_type            TEXT,
  duration_seconds     INTEGER,
  status               TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','AVAILABLE','FAILED','DELETED')),
  consent              TEXT,
  retention_until      TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT
);
CREATE UNIQUE INDEX idx_recording_provider ON call_recordings(provider, provider_recording_id)
  WHERE provider_recording_id IS NOT NULL;
CREATE INDEX idx_recording_call ON call_recordings(call_id);
CREATE INDEX idx_recording_retention ON call_recordings(retention_until);

-- Webhook inbox: (provider, event_id) is unique so retries/duplicates are
-- detected before any business logic runs.
CREATE TABLE webhook_events (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  signature    TEXT,
  status       TEXT NOT NULL DEFAULT 'RECEIVED'
               CHECK (status IN ('RECEIVED','PROCESSED','DUPLICATE','FAILED','IGNORED')),
  payload      TEXT NOT NULL,
  error        TEXT,
  call_id      INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  received_at  TEXT NOT NULL,
  processed_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_webhook_event ON webhook_events(provider, event_id);
CREATE INDEX idx_webhook_received ON webhook_events(received_at);

-- ========================= QUOTATIONS =========================
CREATE TABLE quotations (
  id                INTEGER PRIMARY KEY,
  quotation_number  TEXT NOT NULL UNIQUE,
  lead_id           INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  worker_id         INTEGER REFERENCES users(id),
  destination       TEXT,
  travel_start_date TEXT,
  travel_end_date   TEXT,
  travelers         INTEGER,
  accommodation     TEXT,
  transport         TEXT,
  activities        TEXT,
  inclusions        TEXT NOT NULL DEFAULT '[]',
  exclusions        TEXT NOT NULL DEFAULT '[]',
  items             TEXT NOT NULL DEFAULT '[]',
  currency          TEXT NOT NULL DEFAULT 'INR',
  total_amount      REAL NOT NULL DEFAULT 0,
  notes             TEXT,
  valid_until       TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','SENT','VIEWED','NEGOTIATION','ACCEPTED','REJECTED','EXPIRED','CANCELLED')),
  status_history    TEXT NOT NULL DEFAULT '[]',
  sent_at           TEXT,
  accepted_at       TEXT,
  rejected_at       TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_quot_lead ON quotations(lead_id, created_at);
CREATE INDEX idx_quot_customer ON quotations(customer_id, created_at);
CREATE INDEX idx_quot_worker ON quotations(worker_id, created_at);
CREATE INDEX idx_quot_status ON quotations(status);
CREATE INDEX idx_quot_valid ON quotations(valid_until);

-- =========================== BOOKINGS =========================
CREATE TABLE bookings (
  id                INTEGER PRIMARY KEY,
  booking_number    TEXT NOT NULL UNIQUE,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  quotation_id      INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
  worker_id         INTEGER REFERENCES users(id),
  destination       TEXT,
  travel_start_date TEXT,
  travel_end_date   TEXT,
  travelers         INTEGER,
  services          TEXT NOT NULL DEFAULT '[]',
  currency          TEXT NOT NULL DEFAULT 'INR',
  total_amount      REAL NOT NULL DEFAULT 0,
  paid_amount       REAL NOT NULL DEFAULT 0,
  payment_status    TEXT NOT NULL DEFAULT 'UNPAID'
                    CHECK (payment_status IN ('UNPAID','PARTIAL','PAID','REFUNDED')),
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED')),
  status_history    TEXT NOT NULL DEFAULT '[]',
  notes             TEXT,
  booked_at         TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_book_lead ON bookings(lead_id);
CREATE INDEX idx_book_customer ON bookings(customer_id, created_at);
CREATE INDEX idx_book_worker ON bookings(worker_id, created_at);
CREATE INDEX idx_book_status ON bookings(status);

-- Payments stay a separate architecture so a payment gateway can be added
-- later without touching bookings.
CREATE TABLE payments (
  id          INTEGER PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'INR',
  method      TEXT,
  reference   TEXT,
  status      TEXT NOT NULL DEFAULT 'RECORDED'
              CHECK (status IN ('RECORDED','PENDING','CONFIRMED','FAILED','REFUNDED')),
  paid_at     TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX idx_payment_booking ON payments(booking_id, created_at);

-- ======================== COMMUNICATIONS ======================
-- Channel-agnostic outbound/inbound message ledger. status stays QUEUED or
-- NOT_CONFIGURED until a provider actually confirms delivery.
CREATE TABLE communications (
  id                 INTEGER PRIMARY KEY,
  channel            TEXT NOT NULL
                     CHECK (channel IN ('WHATSAPP','EMAIL','SMS','IN_APP')),
  direction          TEXT NOT NULL DEFAULT 'OUTBOUND'
                     CHECK (direction IN ('INBOUND','OUTBOUND')),
  provider           TEXT,
  provider_message_id TEXT,
  sender_id          INTEGER REFERENCES users(id),
  recipient          TEXT NOT NULL,
  customer_id        INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  lead_id            INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  worker_id          INTEGER REFERENCES users(id),
  subject            TEXT,
  body               TEXT,
  status             TEXT NOT NULL DEFAULT 'QUEUED'
                     CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','NOT_CONFIGURED')),
  error              TEXT,
  sent_at            TEXT,
  delivered_at       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);
CREATE INDEX idx_comm_lead ON communications(lead_id, created_at);
CREATE INDEX idx_comm_customer ON communications(customer_id, created_at);
CREATE INDEX idx_comm_worker ON communications(worker_id, created_at);
CREATE INDEX idx_comm_status ON communications(status, created_at);
CREATE INDEX idx_comm_provider ON communications(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ========================== DOCUMENTS =========================
-- stored_name is a random token: private files are never reachable through a
-- predictable public URL, only through the authenticated file endpoint.
CREATE TABLE documents (
  id           INTEGER PRIMARY KEY,
  entity       TEXT NOT NULL
               CHECK (entity IN ('CUSTOMER','LEAD','QUOTATION','BOOKING','CALL','GENERAL')),
  entity_id    INTEGER NOT NULL,
  category     TEXT,
  filename     TEXT NOT NULL,
  stored_name  TEXT NOT NULL UNIQUE,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_docs_entity ON documents(entity, entity_id, created_at);

-- =========================== IMPORTS ==========================
CREATE TABLE import_jobs (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'LEADS',
  filename      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','PARSED','IMPORTING','COMPLETED','FAILED')),
  column_map    TEXT NOT NULL DEFAULT '{}',
  preview       TEXT NOT NULL DEFAULT '[]',
  total_rows    INTEGER NOT NULL DEFAULT 0,
  valid_rows    INTEGER NOT NULL DEFAULT 0,
  invalid_rows  INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows   INTEGER NOT NULL DEFAULT 0,
  errors        TEXT NOT NULL DEFAULT '[]',
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT,
  deleted_at    TEXT
);
CREATE INDEX idx_imports_created ON import_jobs(created_at);

ALTER TABLE leads ADD COLUMN import_job_id INTEGER REFERENCES import_jobs(id);

-- ==================== DUPLICATE REVIEWS ======================
CREATE TABLE duplicate_reviews (
  id           INTEGER PRIMARY KEY,
  entity       TEXT NOT NULL CHECK (entity IN ('LEAD','CUSTOMER')),
  entity_id    INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  reason       TEXT,
  score        TEXT,
  status       TEXT NOT NULL DEFAULT 'OPEN'
               CHECK (status IN ('OPEN','KEPT_SEPARATE','MERGED','LINKED','IGNORED')),
  decided_by   INTEGER REFERENCES users(id),
  decided_at   TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_dup_status ON duplicate_reviews(status, created_at);
CREATE INDEX idx_dup_entity ON duplicate_reviews(entity, entity_id);

ALTER TABLE customers ADD COLUMN merged_into_id INTEGER REFERENCES customers(id);

-- =================== AUTOMATION SUPPORT ======================
ALTER TABLE users ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE follow_ups ADD COLUMN reminder_sent_at TEXT;
ALTER TABLE follow_ups ADD COLUMN overdue_reminder_sent_at TEXT;
CREATE INDEX idx_fu_reminder ON follow_ups(overdue_reminder_sent_at, scheduled_date);
`
  },
  {
    id: "003",
    name: "security_hardening",
    sql: `
-- Per-account login lockout (complements the IP-based rate limiter).
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;

-- Password reset tokens: only the sha256 hash is stored, never the raw token.
CREATE TABLE password_reset_tokens (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_prt_user ON password_reset_tokens(user_id, created_at);
CREATE INDEX idx_prt_expires ON password_reset_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_docs_uploader ON documents(uploaded_by, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_revoked ON sessions(revoked_at);
`
  },
  {
    id: "004",
    name: "bookings_financial_checks",
    // Table rebuild is the only way to add CHECKs in SQLite. Skipped (and
    // retried next boot) if legacy rows would violate the constraints.
    sql: (db2) => {
      const bad = db2.prepare("SELECT COUNT(*) AS n FROM bookings WHERE paid_amount < 0 OR total_amount < 0").get();
      if (Number(bad?.n ?? 0) > 0) {
        console.warn(
          `[crm] Migration 004 (bookings_financial_checks) skipped: ${bad.n} row(s) with negative amounts; fix them to enable CHECK constraints.`
        );
        return null;
      }
      return `
PRAGMA legacy_alter_table = ON;
ALTER TABLE bookings RENAME TO bookings_legacy;
CREATE TABLE bookings (
  id                INTEGER PRIMARY KEY,
  booking_number    TEXT NOT NULL UNIQUE,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  quotation_id      INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
  worker_id         INTEGER REFERENCES users(id),
  destination       TEXT,
  travel_start_date TEXT,
  travel_end_date   TEXT,
  travelers         INTEGER,
  services          TEXT NOT NULL DEFAULT '[]',
  currency          TEXT NOT NULL DEFAULT 'INR',
  total_amount      REAL NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  paid_amount       REAL NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  payment_status    TEXT NOT NULL DEFAULT 'UNPAID'
                    CHECK (payment_status IN ('UNPAID','PARTIAL','PAID','REFUNDED')),
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED')),
  status_history    TEXT NOT NULL DEFAULT '[]',
  notes             TEXT,
  booked_at         TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
INSERT INTO bookings (id, booking_number, lead_id, customer_id, quotation_id, worker_id, destination,
  travel_start_date, travel_end_date, travelers, services, currency, total_amount, paid_amount,
  payment_status, status, status_history, notes, booked_at, created_by, updated_by, created_at, updated_at, deleted_at)
SELECT id, booking_number, lead_id, customer_id, quotation_id, worker_id, destination,
  travel_start_date, travel_end_date, travelers, services, currency, total_amount, paid_amount,
  payment_status, status, status_history, notes, booked_at, created_by, updated_by, created_at, updated_at, deleted_at
FROM bookings_legacy;
DROP TABLE bookings_legacy;
PRAGMA legacy_alter_table = OFF;
CREATE INDEX IF NOT EXISTS idx_book_lead ON bookings(lead_id);
CREATE INDEX IF NOT EXISTS idx_book_customer ON bookings(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_book_worker ON bookings(worker_id, created_at);
CREATE INDEX IF NOT EXISTS idx_book_status ON bookings(status);
`;
    }
  },
  {
    id: "005",
    name: "payments_financial_checks",
    sql: (db2) => {
      const bad = db2.prepare("SELECT COUNT(*) AS n FROM payments WHERE amount <= 0").get();
      if (Number(bad?.n ?? 0) > 0) {
        console.warn(
          `[crm] Migration 005 (payments_financial_checks) skipped: ${bad.n} non-positive payment row(s); fix them to enable CHECK constraints.`
        );
        return null;
      }
      return `
ALTER TABLE payments RENAME TO payments_legacy;
CREATE TABLE payments (
  id          INTEGER PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount      REAL NOT NULL CHECK (amount > 0),
  currency    TEXT NOT NULL DEFAULT 'INR',
  method      TEXT,
  reference   TEXT,
  status      TEXT NOT NULL DEFAULT 'RECORDED'
              CHECK (status IN ('RECORDED','PENDING','CONFIRMED','FAILED','REFUNDED')),
  paid_at     TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
INSERT INTO payments (id, booking_id, amount, currency, method, reference, status, paid_at,
  created_by, created_at, updated_at, deleted_at)
SELECT id, booking_id, amount, currency, method, reference, status, paid_at,
  created_by, created_at, updated_at, deleted_at
FROM payments_legacy;
DROP TABLE payments_legacy;
CREATE INDEX IF NOT EXISTS idx_payment_booking ON payments(booking_id, created_at);
`;
    }
  },
  {
    id: "006",
    name: "booking_quotation_unique",
    // Race guard: one active booking per quotation. Skipped (and retried) if
    // legacy data already contains duplicates.
    sql: (db2) => {
      const dups = db2.prepare(
        `SELECT COUNT(*) AS n FROM (
             SELECT quotation_id FROM bookings
             WHERE quotation_id IS NOT NULL AND deleted_at IS NULL
             GROUP BY quotation_id HAVING COUNT(*) > 1)`
      ).get();
      if (Number(dups?.n ?? 0) > 0) {
        console.warn(
          `[crm] Migration 006 (booking_quotation_unique) skipped: ${dups.n} quotation(s) converted more than once; resolve duplicates to enable the unique index.`
        );
        return null;
      }
      return `CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_quotation
        ON bookings(quotation_id) WHERE quotation_id IS NOT NULL AND deleted_at IS NULL;`;
    }
  },
  {
    id: "007",
    name: "invoices",
    sql: `
-- Billing documents. Money math (subtotal/tax/total) is computed server-side
-- on write; paid_amount is derived from linked booking payments at read time.
CREATE TABLE invoices (
  id             INTEGER PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  booking_id     INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  quotation_id   INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
  lead_id        INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_id    INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  worker_id      INTEGER REFERENCES users(id),
  issue_date     TEXT NOT NULL,
  due_date       TEXT,
  items          TEXT NOT NULL DEFAULT '[]',
  currency       TEXT NOT NULL DEFAULT 'INR',
  subtotal       REAL NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_rate       REAL NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  tax_amount     REAL NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount   REAL NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  paid_amount    REAL NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status         TEXT NOT NULL DEFAULT 'DRAFT'
                 CHECK (status IN ('DRAFT','ISSUED','PAID','VOID')),
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  updated_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX idx_invoices_customer ON invoices(customer_id, created_at);
CREATE INDEX idx_invoices_booking ON invoices(booking_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_worker ON invoices(worker_id, created_at);
CREATE INDEX idx_invoices_due ON invoices(due_date);
`
  }
];

// src/db/pgMigrations.ts
var pgMigrations = [
  {
    id: "001",
    name: "core_schema",
    sql: `

-- ============================ RBAC ============================
CREATE TABLE roles (
  id          INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE permissions (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',
  created_at TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  username      TEXT,
  password_hash TEXT NOT NULL,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  status        TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED')),
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE UNIQUE INDEX idx_users_email ON users(lower(email)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_users_username ON users(lower(username)) WHERE username IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,          -- sha256(token)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ========================= CUSTOMERS ==========================
CREATE TABLE customers (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  whatsapp   TEXT,
  email      TEXT,
  city       TEXT,
  state      TEXT,
  country    TEXT,
  notes      TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_customers_name ON customers(name);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_whatsapp ON customers(whatsapp);
CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_active ON customers(deleted_at, name);

-- ============================ LEADS ===========================
CREATE TABLE lead_sources (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE lead_statuses (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'OPEN'
             CHECK (category IN ('OPEN','WON','LOST','NEUTRAL')),
  color      TEXT NOT NULL DEFAULT '#64748b',
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE leads (
  id               INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  lead_number      TEXT NOT NULL UNIQUE,
  customer_id      INTEGER NOT NULL REFERENCES customers(id),
  source_id        INTEGER REFERENCES lead_sources(id),
  assigned_to      INTEGER REFERENCES users(id),
  destination      TEXT,
  travel_type      TEXT CHECK (travel_type IN ('DOMESTIC','INTERNATIONAL')),
  trip_type        TEXT,
  requirements     TEXT NOT NULL DEFAULT '[]',
  travel_start_date TEXT,
  travel_end_date   TEXT,
  duration_days    INTEGER,
  adults           INTEGER,
  children         INTEGER,
  total_travelers  INTEGER,
  budget           DOUBLE PRECISION,
  currency         TEXT NOT NULL DEFAULT 'INR',
  priority         TEXT NOT NULL DEFAULT 'MEDIUM'
                   CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status_id        INTEGER NOT NULL REFERENCES lead_statuses(id),
  last_contacted_at TEXT,
  next_follow_up_at TEXT,
  notes             TEXT,
  custom_fields    TEXT NOT NULL DEFAULT '{}',
  created_by       INTEGER REFERENCES users(id),
  updated_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX idx_leads_customer ON leads(customer_id);
CREATE INDEX idx_leads_status ON leads(status_id);
CREATE INDEX idx_leads_source ON leads(source_id);
CREATE INDEX idx_leads_created ON leads(created_at);
CREATE INDEX idx_leads_next_fu ON leads(next_follow_up_at);
CREATE INDEX idx_leads_active ON leads(deleted_at, assigned_to, status_id);
CREATE INDEX idx_leads_dest ON leads(destination);

CREATE TABLE lead_assignments (
  id          INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL CHECK (action IN ('ASSIGNED','REASSIGNED','UNASSIGNED')),
  reason      TEXT,
  assigned_at TEXT NOT NULL,
  released_at TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_assign_lead ON lead_assignments(lead_id, is_active);
CREATE INDEX idx_assign_worker ON lead_assignments(assigned_to, is_active);
CREATE INDEX idx_assign_at ON lead_assignments(assigned_at);

CREATE TABLE lead_status_history (
  id             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  lead_id        INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_status_id INTEGER REFERENCES lead_statuses(id),
  to_status_id   INTEGER NOT NULL REFERENCES lead_statuses(id),
  changed_by     INTEGER REFERENCES users(id),
  remark         TEXT,
  changed_at     TEXT NOT NULL
);
CREATE INDEX idx_status_hist_lead ON lead_status_history(lead_id, changed_at);

-- Extensible event log powering the lead timeline.
-- Part 2 will append new event types (CALL_INITIATED, QUOTATION_SENT, ...)
-- without changing this schema.
CREATE TABLE lead_timeline (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  actor_id   INTEGER REFERENCES users(id),
  summary    TEXT NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_timeline_lead ON lead_timeline(lead_id, created_at);
CREATE INDEX idx_timeline_actor ON lead_timeline(actor_id, created_at);
CREATE INDEX idx_timeline_type ON lead_timeline(type, created_at);

CREATE TABLE notes (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_notes_lead ON notes(lead_id, created_at);

-- ========================== FOLLOW-UPS ========================
CREATE TABLE follow_ups (
  id                INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  lead_id           INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  worker_id         INTEGER NOT NULL REFERENCES users(id),
  scheduled_date    TEXT NOT NULL,          -- YYYY-MM-DD (business timezone)
  scheduled_time    TEXT,                   -- HH:MM
  type              TEXT NOT NULL DEFAULT 'CALL',
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','TODAY','COMPLETED','CONVERTED','NOT_INTERESTED',
                                      'RESCHEDULED','NO_RESPONSE','CALLBACK_REQUESTED','OVERDUE','CANCELLED')),
  notes             TEXT,
  customer_response TEXT,
  next_action       TEXT,
  created_by        INTEGER REFERENCES users(id),
  completed_by      INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  completed_at      TEXT,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_fu_worker_date ON follow_ups(worker_id, scheduled_date);
CREATE INDEX idx_fu_lead ON follow_ups(lead_id, scheduled_date);
CREATE INDEX idx_fu_status ON follow_ups(status);
CREATE INDEX idx_fu_date ON follow_ups(scheduled_date);
CREATE INDEX idx_fu_active ON follow_ups(deleted_at, worker_id, scheduled_date);

-- ======================== NOTIFICATIONS =======================
CREATE TABLE notifications (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  entity     TEXT,
  entity_id  INTEGER,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notif_user ON notifications(user_id, read_at, created_at);

-- ========================== AUDIT LOG =========================
CREATE TABLE audit_logs (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  metadata   TEXT NOT NULL DEFAULT '{}',
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at);

-- =========================== SETTINGS =========================
CREATE TABLE settings (
  setting_key TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

`
  },
  {
    id: "002",
    name: "part2_operations",
    sql: `

-- ============================ CALLS ===========================
-- Provider-independent call records. Written manually by workers or by
-- telephony webhooks; provider_call_id is unique per provider so duplicate
-- webhook events can never create a second row.
CREATE TABLE calls (
  id                INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  worker_id         INTEGER NOT NULL REFERENCES users(id),
  provider          TEXT NOT NULL DEFAULT 'manual',
  provider_call_id  TEXT,
  direction         TEXT NOT NULL DEFAULT 'OUTBOUND'
                    CHECK (direction IN ('INBOUND','OUTBOUND')),
  phone_number      TEXT,
  started_at        TEXT,
  answered_at       TEXT,
  ended_at          TEXT,
  duration_seconds  INTEGER,
  status            TEXT NOT NULL DEFAULT 'RINGING',
  disposition       TEXT,
  recording_available INTEGER NOT NULL DEFAULT 0,
  recording_ref     TEXT,
  consent           TEXT,
  notes             TEXT,
  follow_up_id      INTEGER REFERENCES follow_ups(id) ON DELETE SET NULL,
  webhook_event_id  TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE UNIQUE INDEX idx_calls_provider ON calls(provider, provider_call_id)
  WHERE provider_call_id IS NOT NULL;
CREATE INDEX idx_calls_lead ON calls(lead_id, started_at);
CREATE INDEX idx_calls_customer ON calls(customer_id, started_at);
CREATE INDEX idx_calls_worker ON calls(worker_id, started_at);
CREATE INDEX idx_calls_started ON calls(started_at);
CREATE INDEX idx_calls_status ON calls(status);

-- Recordings are never linked from public URLs: source_url/file_key stay
-- server-side and playback goes through an authenticated, audited endpoint.
CREATE TABLE call_recordings (
  id                   INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  call_id              INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL DEFAULT 'manual',
  provider_recording_id TEXT,
  storage              TEXT NOT NULL DEFAULT 'provider'
                       CHECK (storage IN ('provider','local')),
  source_url           TEXT,
  file_key             TEXT,
  mime_type            TEXT,
  duration_seconds     INTEGER,
  status               TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','AVAILABLE','FAILED','DELETED')),
  consent              TEXT,
  retention_until      TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT
);
CREATE UNIQUE INDEX idx_recording_provider ON call_recordings(provider, provider_recording_id)
  WHERE provider_recording_id IS NOT NULL;
CREATE INDEX idx_recording_call ON call_recordings(call_id);
CREATE INDEX idx_recording_retention ON call_recordings(retention_until);

-- Webhook inbox: (provider, event_id) is unique so retries/duplicates are
-- detected before any business logic runs.
CREATE TABLE webhook_events (
  id           INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  signature    TEXT,
  status       TEXT NOT NULL DEFAULT 'RECEIVED'
               CHECK (status IN ('RECEIVED','PROCESSED','DUPLICATE','FAILED','IGNORED')),
  payload      TEXT NOT NULL,
  error        TEXT,
  call_id      INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  received_at  TEXT NOT NULL,
  processed_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_webhook_event ON webhook_events(provider, event_id);
CREATE INDEX idx_webhook_received ON webhook_events(received_at);

-- ========================= QUOTATIONS =========================
CREATE TABLE quotations (
  id                INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  quotation_number  TEXT NOT NULL UNIQUE,
  lead_id           INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  worker_id         INTEGER REFERENCES users(id),
  destination       TEXT,
  travel_start_date TEXT,
  travel_end_date   TEXT,
  travelers         INTEGER,
  accommodation     TEXT,
  transport         TEXT,
  activities        TEXT,
  inclusions        TEXT NOT NULL DEFAULT '[]',
  exclusions        TEXT NOT NULL DEFAULT '[]',
  items             TEXT NOT NULL DEFAULT '[]',
  currency          TEXT NOT NULL DEFAULT 'INR',
  total_amount      DOUBLE PRECISION NOT NULL DEFAULT 0,
  notes             TEXT,
  valid_until       TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','SENT','VIEWED','NEGOTIATION','ACCEPTED','REJECTED','EXPIRED','CANCELLED')),
  status_history    TEXT NOT NULL DEFAULT '[]',
  sent_at           TEXT,
  accepted_at       TEXT,
  rejected_at       TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_quot_lead ON quotations(lead_id, created_at);
CREATE INDEX idx_quot_customer ON quotations(customer_id, created_at);
CREATE INDEX idx_quot_worker ON quotations(worker_id, created_at);
CREATE INDEX idx_quot_status ON quotations(status);
CREATE INDEX idx_quot_valid ON quotations(valid_until);

-- =========================== BOOKINGS =========================
CREATE TABLE bookings (
  id                INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  booking_number    TEXT NOT NULL UNIQUE,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  quotation_id      INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
  worker_id         INTEGER REFERENCES users(id),
  destination       TEXT,
  travel_start_date TEXT,
  travel_end_date   TEXT,
  travelers         INTEGER,
  services          TEXT NOT NULL DEFAULT '[]',
  currency          TEXT NOT NULL DEFAULT 'INR',
  total_amount      DOUBLE PRECISION NOT NULL DEFAULT 0,
  paid_amount       DOUBLE PRECISION NOT NULL DEFAULT 0,
  payment_status    TEXT NOT NULL DEFAULT 'UNPAID'
                    CHECK (payment_status IN ('UNPAID','PARTIAL','PAID','REFUNDED')),
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED')),
  status_history    TEXT NOT NULL DEFAULT '[]',
  notes             TEXT,
  booked_at         TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_book_lead ON bookings(lead_id);
CREATE INDEX idx_book_customer ON bookings(customer_id, created_at);
CREATE INDEX idx_book_worker ON bookings(worker_id, created_at);
CREATE INDEX idx_book_status ON bookings(status);

-- Payments stay a separate architecture so a payment gateway can be added
-- later without touching bookings.
CREATE TABLE payments (
  id          INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount      DOUBLE PRECISION NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'INR',
  method      TEXT,
  reference   TEXT,
  status      TEXT NOT NULL DEFAULT 'RECORDED'
              CHECK (status IN ('RECORDED','PENDING','CONFIRMED','FAILED','REFUNDED')),
  paid_at     TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX idx_payment_booking ON payments(booking_id, created_at);

-- ======================== COMMUNICATIONS ======================
-- Channel-agnostic outbound/inbound message ledger. status stays QUEUED or
-- NOT_CONFIGURED until a provider actually confirms delivery.
CREATE TABLE communications (
  id                 INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  channel            TEXT NOT NULL
                     CHECK (channel IN ('WHATSAPP','EMAIL','SMS','IN_APP')),
  direction          TEXT NOT NULL DEFAULT 'OUTBOUND'
                     CHECK (direction IN ('INBOUND','OUTBOUND')),
  provider           TEXT,
  provider_message_id TEXT,
  sender_id          INTEGER REFERENCES users(id),
  recipient          TEXT NOT NULL,
  customer_id        INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  lead_id            INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  worker_id          INTEGER REFERENCES users(id),
  subject            TEXT,
  body               TEXT,
  status             TEXT NOT NULL DEFAULT 'QUEUED'
                     CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','NOT_CONFIGURED')),
  error              TEXT,
  sent_at            TEXT,
  delivered_at       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);
CREATE INDEX idx_comm_lead ON communications(lead_id, created_at);
CREATE INDEX idx_comm_customer ON communications(customer_id, created_at);
CREATE INDEX idx_comm_worker ON communications(worker_id, created_at);
CREATE INDEX idx_comm_status ON communications(status, created_at);
CREATE INDEX idx_comm_provider ON communications(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ========================== DOCUMENTS =========================
-- stored_name is a random token: private files are never reachable through a
-- predictable public URL, only through the authenticated file endpoint.
CREATE TABLE documents (
  id           INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  entity       TEXT NOT NULL
               CHECK (entity IN ('CUSTOMER','LEAD','QUOTATION','BOOKING','CALL','GENERAL')),
  entity_id    INTEGER NOT NULL,
  category     TEXT,
  filename     TEXT NOT NULL,
  stored_name  TEXT NOT NULL UNIQUE,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_docs_entity ON documents(entity, entity_id, created_at);

-- =========================== IMPORTS ==========================
CREATE TABLE import_jobs (
  id            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'LEADS',
  filename      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','PARSED','IMPORTING','COMPLETED','FAILED')),
  column_map    TEXT NOT NULL DEFAULT '{}',
  preview       TEXT NOT NULL DEFAULT '[]',
  total_rows    INTEGER NOT NULL DEFAULT 0,
  valid_rows    INTEGER NOT NULL DEFAULT 0,
  invalid_rows  INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows   INTEGER NOT NULL DEFAULT 0,
  errors        TEXT NOT NULL DEFAULT '[]',
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT,
  deleted_at    TEXT
);
CREATE INDEX idx_imports_created ON import_jobs(created_at);

ALTER TABLE leads ADD COLUMN import_job_id INTEGER REFERENCES import_jobs(id);

-- ==================== DUPLICATE REVIEWS ======================
CREATE TABLE duplicate_reviews (
  id           INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  entity       TEXT NOT NULL CHECK (entity IN ('LEAD','CUSTOMER')),
  entity_id    INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  reason       TEXT,
  score        TEXT,
  status       TEXT NOT NULL DEFAULT 'OPEN'
               CHECK (status IN ('OPEN','KEPT_SEPARATE','MERGED','LINKED','IGNORED')),
  decided_by   INTEGER REFERENCES users(id),
  decided_at   TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_dup_status ON duplicate_reviews(status, created_at);
CREATE INDEX idx_dup_entity ON duplicate_reviews(entity, entity_id);

ALTER TABLE customers ADD COLUMN merged_into_id INTEGER REFERENCES customers(id);

-- =================== AUTOMATION SUPPORT ======================
ALTER TABLE users ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE follow_ups ADD COLUMN reminder_sent_at TEXT;
ALTER TABLE follow_ups ADD COLUMN overdue_reminder_sent_at TEXT;
CREATE INDEX idx_fu_reminder ON follow_ups(overdue_reminder_sent_at, scheduled_date);

`
  },
  {
    id: "003",
    name: "security_hardening",
    sql: `

-- Per-account login lockout (complements the IP-based rate limiter).
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;

-- Password reset tokens: only the sha256 hash is stored, never the raw token.
CREATE TABLE password_reset_tokens (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_prt_user ON password_reset_tokens(user_id, created_at);
CREATE INDEX idx_prt_expires ON password_reset_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_docs_uploader ON documents(uploaded_by, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_revoked ON sessions(revoked_at);

`
  },
  {
    id: "004",
    name: "bookings_financial_checks",
    sql: `

ALTER TABLE bookings ADD CONSTRAINT bookings_total_nonneg CHECK (total_amount >= 0);
ALTER TABLE bookings ADD CONSTRAINT bookings_paid_nonneg CHECK (paid_amount >= 0);

`
  },
  {
    id: "005",
    name: "payments_financial_checks",
    sql: `

ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (amount > 0);

`
  },
  {
    id: "006",
    name: "booking_quotation_unique",
    sql: `

CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_quotation
  ON bookings(quotation_id) WHERE quotation_id IS NOT NULL AND deleted_at IS NULL;

`
  },
  {
    id: "007",
    name: "invoices",
    sql: `

-- Billing documents. Money math (subtotal/tax/total) is computed server-side
-- on write; paid_amount is derived from linked booking payments at read time.
CREATE TABLE invoices (
  id             INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  booking_id     INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  quotation_id   INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
  lead_id        INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_id    INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  worker_id      INTEGER REFERENCES users(id),
  issue_date     TEXT NOT NULL,
  due_date       TEXT,
  items          TEXT NOT NULL DEFAULT '[]',
  currency       TEXT NOT NULL DEFAULT 'INR',
  subtotal       DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_rate       DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  tax_amount     DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount   DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  paid_amount    DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status         TEXT NOT NULL DEFAULT 'DRAFT'
                 CHECK (status IN ('DRAFT','ISSUED','PAID','VOID')),
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  updated_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX idx_invoices_customer ON invoices(customer_id, created_at);
CREATE INDEX idx_invoices_booking ON invoices(booking_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_worker ON invoices(worker_id, created_at);
CREATE INDEX idx_invoices_due ON invoices(due_date);

`
  }
];

// src/db/mysqlMigrations.ts
var mysqlMigrations = [
  {
    id: "001",
    name: "core_schema",
    statements: [
      "-- ============================ RBAC ============================\nCREATE TABLE roles (\n\n  id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  code        VARCHAR(191) NOT NULL UNIQUE,\n  name        TEXT NOT NULL,\n  description TEXT,\n  created_at  TEXT NOT NULL,\n  updated_at  TEXT NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE TABLE permissions (\n\n  id         BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  code       VARCHAR(191) NOT NULL UNIQUE,\n  name       TEXT NOT NULL,\n  category   TEXT NOT NULL DEFAULT ('general'),\n  created_at TEXT NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE TABLE role_permissions (\n\n  role_id       BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,\n  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,\n  PRIMARY KEY (role_id, permission_id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE TABLE users (\n\n  id            BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  name          TEXT NOT NULL,\n  email         VARCHAR(191) NOT NULL,\n  phone         TEXT,\n  username      VARCHAR(191),\n  password_hash TEXT NOT NULL,\n  role_id       BIGINT NOT NULL REFERENCES roles(id),\n  status        VARCHAR(191) NOT NULL DEFAULT 'ACTIVE'\n                CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED')),\n  last_login_at TEXT,\n  created_at    TEXT NOT NULL,\n  updated_at    TEXT NOT NULL,\n  deleted_at    TEXT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE UNIQUE INDEX idx_users_email ON users(email)",
      "CREATE UNIQUE INDEX idx_users_username ON users(username)",
      "CREATE INDEX idx_users_role ON users(role_id)",
      "CREATE INDEX idx_users_status ON users(status)",
      "CREATE TABLE sessions (\n\n  id         VARCHAR(191) PRIMARY KEY,          -- sha256(token)\n  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  ip         TEXT,\n  user_agent TEXT,\n  created_at TEXT NOT NULL,\n  expires_at VARCHAR(191) NOT NULL,\n  revoked_at VARCHAR(191)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_sessions_user ON sessions(user_id)",
      "CREATE INDEX idx_sessions_expires ON sessions(expires_at)",
      "-- ========================= CUSTOMERS ==========================\nCREATE TABLE customers (\n\n  id         BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  name       VARCHAR(191) NOT NULL,\n  phone      VARCHAR(191),\n  whatsapp   VARCHAR(191),\n  email      VARCHAR(191),\n  city       TEXT,\n  state      TEXT,\n  country    TEXT,\n  notes      TEXT,\n  created_by BIGINT REFERENCES users(id),\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  deleted_at VARCHAR(191)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_customers_name ON customers(name)",
      "CREATE INDEX idx_customers_phone ON customers(phone)",
      "CREATE INDEX idx_customers_whatsapp ON customers(whatsapp)",
      "CREATE INDEX idx_customers_email ON customers(email)",
      "CREATE INDEX idx_customers_active ON customers(deleted_at, name)",
      "-- ============================ LEADS ===========================\nCREATE TABLE lead_sources (\n\n  id         BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  name       VARCHAR(191) NOT NULL UNIQUE,\n  is_active  INTEGER NOT NULL DEFAULT 1,\n  sort_order INTEGER NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE TABLE lead_statuses (\n\n  id         BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  code       VARCHAR(191) NOT NULL UNIQUE,\n  name       TEXT NOT NULL,\n  category   TEXT NOT NULL DEFAULT ('OPEN')\n             CHECK (category IN ('OPEN','WON','LOST','NEUTRAL')),\n  color      TEXT NOT NULL DEFAULT ('#64748b'),\n  is_active  INTEGER NOT NULL DEFAULT 1,\n  sort_order INTEGER NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE TABLE leads (\n\n  id               BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  lead_number      VARCHAR(191) NOT NULL UNIQUE,\n  customer_id      BIGINT NOT NULL REFERENCES customers(id),\n  source_id        BIGINT REFERENCES lead_sources(id),\n  assigned_to      BIGINT REFERENCES users(id),\n  destination      VARCHAR(191),\n  travel_type      TEXT CHECK (travel_type IN ('DOMESTIC','INTERNATIONAL')),\n  trip_type        TEXT,\n  requirements     TEXT NOT NULL DEFAULT ('[]'),\n  travel_start_date TEXT,\n  travel_end_date   TEXT,\n  duration_days    INTEGER,\n  adults           INTEGER,\n  children         INTEGER,\n  total_travelers  INTEGER,\n  budget           DOUBLE PRECISION,\n  currency         TEXT NOT NULL DEFAULT ('INR'),\n  priority         TEXT NOT NULL DEFAULT ('MEDIUM')\n                   CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),\n  status_id        BIGINT NOT NULL REFERENCES lead_statuses(id),\n  last_contacted_at TEXT,\n  next_follow_up_at VARCHAR(191),\n  notes             TEXT,\n  custom_fields    TEXT NOT NULL DEFAULT ('{}'),\n  created_by       BIGINT REFERENCES users(id),\n  updated_by       BIGINT REFERENCES users(id),\n  created_at       VARCHAR(191) NOT NULL,\n  updated_at       TEXT NOT NULL,\n  deleted_at       VARCHAR(191)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_leads_customer ON leads(customer_id)",
      "CREATE INDEX idx_leads_status ON leads(status_id)",
      "CREATE INDEX idx_leads_source ON leads(source_id)",
      "CREATE INDEX idx_leads_created ON leads(created_at)",
      "CREATE INDEX idx_leads_next_fu ON leads(next_follow_up_at)",
      "CREATE INDEX idx_leads_active ON leads(deleted_at, assigned_to, status_id)",
      "CREATE INDEX idx_leads_dest ON leads(destination)",
      "CREATE TABLE lead_assignments (\n\n  id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  lead_id     BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,\n  assigned_to BIGINT NOT NULL REFERENCES users(id),\n  assigned_by BIGINT NOT NULL REFERENCES users(id),\n  action      TEXT NOT NULL CHECK (action IN ('ASSIGNED','REASSIGNED','UNASSIGNED')),\n  reason      TEXT,\n  assigned_at VARCHAR(191) NOT NULL,\n  released_at TEXT,\n  is_active   INTEGER NOT NULL DEFAULT 1\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_assign_lead ON lead_assignments(lead_id, is_active)",
      "CREATE INDEX idx_assign_worker ON lead_assignments(assigned_to, is_active)",
      "CREATE INDEX idx_assign_at ON lead_assignments(assigned_at)",
      "CREATE TABLE lead_status_history (\n\n  id             BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  lead_id        BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,\n  from_status_id BIGINT REFERENCES lead_statuses(id),\n  to_status_id   BIGINT NOT NULL REFERENCES lead_statuses(id),\n  changed_by     BIGINT REFERENCES users(id),\n  remark         TEXT,\n  changed_at     VARCHAR(191) NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_status_hist_lead ON lead_status_history(lead_id, changed_at)",
      "-- Extensible event log powering the lead timeline.\n-- Part 2 will append new event types (CALL_INITIATED, QUOTATION_SENT, ...)\n-- without changing this schema.\nCREATE TABLE lead_timeline (\n\n  id         BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  lead_id    BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,\n  type       VARCHAR(191) NOT NULL,\n  actor_id   BIGINT REFERENCES users(id),\n  summary    TEXT NOT NULL,\n  metadata   TEXT NOT NULL DEFAULT ('{}'),\n  created_at VARCHAR(191) NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_timeline_lead ON lead_timeline(lead_id, created_at)",
      "CREATE INDEX idx_timeline_actor ON lead_timeline(actor_id, created_at)",
      "CREATE INDEX idx_timeline_type ON lead_timeline(type, created_at)",
      "CREATE TABLE notes (\n\n  id         BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  lead_id    BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,\n  author_id  BIGINT NOT NULL REFERENCES users(id),\n  content    TEXT NOT NULL,\n  created_at VARCHAR(191) NOT NULL,\n  updated_at TEXT NOT NULL,\n  deleted_at TEXT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_notes_lead ON notes(lead_id, created_at)",
      "-- ========================== FOLLOW-UPS ========================\nCREATE TABLE follow_ups (\n\n  id                BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  lead_id           BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,\n  worker_id         BIGINT NOT NULL REFERENCES users(id),\n  scheduled_date    VARCHAR(191) NOT NULL,          -- YYYY-MM-DD (business timezone)\n  scheduled_time    TEXT,                   -- HH:MM\n  type              TEXT NOT NULL DEFAULT ('CALL'),\n  status            VARCHAR(191) NOT NULL DEFAULT 'PENDING'\n                    CHECK (status IN ('PENDING','TODAY','COMPLETED','CONVERTED','NOT_INTERESTED',\n                                      'RESCHEDULED','NO_RESPONSE','CALLBACK_REQUESTED','OVERDUE','CANCELLED')),\n  notes             TEXT,\n  customer_response TEXT,\n  next_action       TEXT,\n  created_by        BIGINT REFERENCES users(id),\n  completed_by      BIGINT REFERENCES users(id),\n  created_at        TEXT NOT NULL,\n  completed_at      TEXT,\n  updated_at        TEXT NOT NULL,\n  deleted_at        VARCHAR(191)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_fu_worker_date ON follow_ups(worker_id, scheduled_date)",
      "CREATE INDEX idx_fu_lead ON follow_ups(lead_id, scheduled_date)",
      "CREATE INDEX idx_fu_status ON follow_ups(status)",
      "CREATE INDEX idx_fu_date ON follow_ups(scheduled_date)",
      "CREATE INDEX idx_fu_active ON follow_ups(deleted_at, worker_id, scheduled_date)",
      "-- ======================== NOTIFICATIONS =======================\nCREATE TABLE notifications (\n\n  id         BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  type       TEXT NOT NULL,\n  title      TEXT NOT NULL,\n  body       TEXT,\n  entity     TEXT,\n  entity_id  INTEGER,\n  link       TEXT,\n  read_at    VARCHAR(191),\n  created_at VARCHAR(191) NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_notif_user ON notifications(user_id, read_at, created_at)",
      "-- ========================== AUDIT LOG =========================\nCREATE TABLE audit_logs (\n\n  id         BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  user_id    BIGINT REFERENCES users(id),\n  action     VARCHAR(191) NOT NULL,\n  entity     VARCHAR(191) NOT NULL,\n  entity_id  VARCHAR(191),\n  metadata   TEXT NOT NULL DEFAULT ('{}'),\n  ip         TEXT,\n  created_at VARCHAR(191) NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at)",
      "CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id)",
      "CREATE INDEX idx_audit_created ON audit_logs(created_at)",
      "CREATE INDEX idx_audit_action ON audit_logs(action, created_at)",
      "-- =========================== SETTINGS =========================\nCREATE TABLE settings (\n\n  setting_key VARCHAR(191) PRIMARY KEY,\n  value       TEXT NOT NULL,\n  updated_at  TEXT NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
    ]
  },
  {
    id: "002",
    name: "part2_operations",
    statements: [
      "-- ============================ CALLS ===========================\n-- Provider-independent call records. Written manually by workers or by\n-- telephony webhooks; provider_call_id is unique per provider so duplicate\n-- webhook events can never create a second row.\nCREATE TABLE calls (\n\n  id                BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  lead_id           BIGINT REFERENCES leads(id) ON DELETE SET NULL,\n  customer_id       BIGINT REFERENCES customers(id) ON DELETE SET NULL,\n  worker_id         BIGINT NOT NULL REFERENCES users(id),\n  provider          VARCHAR(191) NOT NULL DEFAULT 'manual',\n  provider_call_id  VARCHAR(191),\n  direction         TEXT NOT NULL DEFAULT ('OUTBOUND')\n                    CHECK (direction IN ('INBOUND','OUTBOUND')),\n  phone_number      TEXT,\n  started_at        VARCHAR(191),\n  answered_at       TEXT,\n  ended_at          TEXT,\n  duration_seconds  INTEGER,\n  status            VARCHAR(191) NOT NULL DEFAULT 'RINGING',\n  disposition       TEXT,\n  recording_available INTEGER NOT NULL DEFAULT 0,\n  recording_ref     TEXT,\n  consent           TEXT,\n  notes             TEXT,\n  follow_up_id      BIGINT REFERENCES follow_ups(id) ON DELETE SET NULL,\n  webhook_event_id  TEXT,\n  created_by        BIGINT REFERENCES users(id),\n  created_at        TEXT NOT NULL,\n  updated_at        TEXT NOT NULL,\n  deleted_at        TEXT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE UNIQUE INDEX idx_calls_provider ON calls(provider, provider_call_id)",
      "CREATE INDEX idx_calls_lead ON calls(lead_id, started_at)",
      "CREATE INDEX idx_calls_customer ON calls(customer_id, started_at)",
      "CREATE INDEX idx_calls_worker ON calls(worker_id, started_at)",
      "CREATE INDEX idx_calls_started ON calls(started_at)",
      "CREATE INDEX idx_calls_status ON calls(status)",
      "-- Recordings are never linked from public URLs: source_url/file_key stay\n-- server-side and playback goes through an authenticated, audited endpoint.\nCREATE TABLE call_recordings (\n\n  id                   BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  call_id              BIGINT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,\n  provider             VARCHAR(191) NOT NULL DEFAULT 'manual',\n  provider_recording_id VARCHAR(191),\n  storage              TEXT NOT NULL DEFAULT ('provider')\n                       CHECK (storage IN ('provider','local')),\n  source_url           TEXT,\n  file_key             TEXT,\n  mime_type            TEXT,\n  duration_seconds     INTEGER,\n  status               TEXT NOT NULL DEFAULT ('PENDING')\n                       CHECK (status IN ('PENDING','AVAILABLE','FAILED','DELETED')),\n  consent              TEXT,\n  retention_until      VARCHAR(191),\n  created_at           TEXT NOT NULL,\n  updated_at           TEXT NOT NULL,\n  deleted_at           TEXT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE UNIQUE INDEX idx_recording_provider ON call_recordings(provider, provider_recording_id)",
      "CREATE INDEX idx_recording_call ON call_recordings(call_id)",
      "CREATE INDEX idx_recording_retention ON call_recordings(retention_until)",
      "-- Webhook inbox: (provider, event_id) is unique so retries/duplicates are\n-- detected before any business logic runs.\nCREATE TABLE webhook_events (\n\n  id           BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  provider     VARCHAR(191) NOT NULL,\n  event_id     VARCHAR(191) NOT NULL,\n  event_type   TEXT NOT NULL,\n  signature    TEXT,\n  status       TEXT NOT NULL DEFAULT ('RECEIVED')\n               CHECK (status IN ('RECEIVED','PROCESSED','DUPLICATE','FAILED','IGNORED')),\n  payload      TEXT NOT NULL,\n  error        TEXT,\n  call_id      BIGINT REFERENCES calls(id) ON DELETE SET NULL,\n  received_at  VARCHAR(191) NOT NULL,\n  processed_at TEXT,\n  created_at   TEXT NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE UNIQUE INDEX idx_webhook_event ON webhook_events(provider, event_id)",
      "CREATE INDEX idx_webhook_received ON webhook_events(received_at)",
      "-- ========================= QUOTATIONS =========================\nCREATE TABLE quotations (\n\n  id                BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  quotation_number  VARCHAR(191) NOT NULL UNIQUE,\n  lead_id           BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,\n  customer_id       BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,\n  worker_id         BIGINT REFERENCES users(id),\n  destination       TEXT,\n  travel_start_date TEXT,\n  travel_end_date   TEXT,\n  travelers         INTEGER,\n  accommodation     TEXT,\n  transport         TEXT,\n  activities        TEXT,\n  inclusions        TEXT NOT NULL DEFAULT ('[]'),\n  exclusions        TEXT NOT NULL DEFAULT ('[]'),\n  items             TEXT NOT NULL DEFAULT ('[]'),\n  currency          TEXT NOT NULL DEFAULT ('INR'),\n  total_amount      DOUBLE PRECISION NOT NULL DEFAULT 0,\n  notes             TEXT,\n  valid_until       VARCHAR(191),\n  status            VARCHAR(191) NOT NULL DEFAULT 'DRAFT'\n                    CHECK (status IN ('DRAFT','SENT','VIEWED','NEGOTIATION','ACCEPTED','REJECTED','EXPIRED','CANCELLED')),\n  status_history    TEXT NOT NULL DEFAULT ('[]'),\n  sent_at           TEXT,\n  accepted_at       TEXT,\n  rejected_at       TEXT,\n  created_by        BIGINT REFERENCES users(id),\n  updated_by        BIGINT REFERENCES users(id),\n  created_at        VARCHAR(191) NOT NULL,\n  updated_at        TEXT NOT NULL,\n  deleted_at        TEXT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_quot_lead ON quotations(lead_id, created_at)",
      "CREATE INDEX idx_quot_customer ON quotations(customer_id, created_at)",
      "CREATE INDEX idx_quot_worker ON quotations(worker_id, created_at)",
      "CREATE INDEX idx_quot_status ON quotations(status)",
      "CREATE INDEX idx_quot_valid ON quotations(valid_until)",
      "-- =========================== BOOKINGS =========================\nCREATE TABLE bookings (\n\n  id                BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  booking_number    VARCHAR(191) NOT NULL UNIQUE,\n  lead_id           BIGINT REFERENCES leads(id) ON DELETE SET NULL,\n  customer_id       BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,\n  quotation_id      BIGINT REFERENCES quotations(id) ON DELETE SET NULL,\n  worker_id         BIGINT REFERENCES users(id),\n  destination       TEXT,\n  travel_start_date TEXT,\n  travel_end_date   TEXT,\n  travelers         INTEGER,\n  services          TEXT NOT NULL DEFAULT ('[]'),\n  currency          TEXT NOT NULL DEFAULT ('INR'),\n  total_amount      DOUBLE PRECISION NOT NULL DEFAULT 0,\n  paid_amount       DOUBLE PRECISION NOT NULL DEFAULT 0,\n  payment_status    TEXT NOT NULL DEFAULT ('UNPAID')\n                    CHECK (payment_status IN ('UNPAID','PARTIAL','PAID','REFUNDED')),\n  status            VARCHAR(191) NOT NULL DEFAULT 'PENDING'\n                    CHECK (status IN ('PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED')),\n  status_history    TEXT NOT NULL DEFAULT ('[]'),\n  notes             TEXT,\n  booked_at         TEXT,\n  created_by        BIGINT REFERENCES users(id),\n  updated_by        BIGINT REFERENCES users(id),\n  created_at        VARCHAR(191) NOT NULL,\n  updated_at        TEXT NOT NULL,\n  deleted_at        TEXT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_book_lead ON bookings(lead_id)",
      "CREATE INDEX idx_book_customer ON bookings(customer_id, created_at)",
      "CREATE INDEX idx_book_worker ON bookings(worker_id, created_at)",
      "CREATE INDEX idx_book_status ON bookings(status)",
      "-- Payments stay a separate architecture so a payment gateway can be added\n-- later without touching bookings.\nCREATE TABLE payments (\n\n  id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  booking_id  BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,\n  amount      DOUBLE PRECISION NOT NULL,\n  currency    TEXT NOT NULL DEFAULT ('INR'),\n  method      TEXT,\n  reference   TEXT,\n  status      TEXT NOT NULL DEFAULT ('RECORDED')\n              CHECK (status IN ('RECORDED','PENDING','CONFIRMED','FAILED','REFUNDED')),\n  paid_at     TEXT,\n  created_by  BIGINT REFERENCES users(id),\n  created_at  VARCHAR(191) NOT NULL,\n  updated_at  TEXT NOT NULL,\n  deleted_at  TEXT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_payment_booking ON payments(booking_id, created_at)",
      "-- ======================== COMMUNICATIONS ======================\n-- Channel-agnostic outbound/inbound message ledger. status stays QUEUED or\n-- NOT_CONFIGURED until a provider actually confirms delivery.\nCREATE TABLE communications (\n\n  id                 BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  channel            TEXT NOT NULL\n                     CHECK (channel IN ('WHATSAPP','EMAIL','SMS','IN_APP')),\n  direction          TEXT NOT NULL DEFAULT ('OUTBOUND')\n                     CHECK (direction IN ('INBOUND','OUTBOUND')),\n  provider           VARCHAR(191),\n  provider_message_id VARCHAR(191),\n  sender_id          BIGINT REFERENCES users(id),\n  recipient          TEXT NOT NULL,\n  customer_id        BIGINT REFERENCES customers(id) ON DELETE SET NULL,\n  lead_id            BIGINT REFERENCES leads(id) ON DELETE SET NULL,\n  worker_id          BIGINT REFERENCES users(id),\n  subject            TEXT,\n  body               TEXT,\n  status             VARCHAR(191) NOT NULL DEFAULT 'QUEUED'\n                     CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','NOT_CONFIGURED')),\n  error              TEXT,\n  sent_at            TEXT,\n  delivered_at       TEXT,\n  created_at         VARCHAR(191) NOT NULL,\n  updated_at         TEXT NOT NULL,\n  deleted_at         TEXT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_comm_lead ON communications(lead_id, created_at)",
      "CREATE INDEX idx_comm_customer ON communications(customer_id, created_at)",
      "CREATE INDEX idx_comm_worker ON communications(worker_id, created_at)",
      "CREATE INDEX idx_comm_status ON communications(status, created_at)",
      "CREATE INDEX idx_comm_provider ON communications(provider, provider_message_id)",
      "-- ========================== DOCUMENTS =========================\n-- stored_name is a random token: private files are never reachable through a\n-- predictable public URL, only through the authenticated file endpoint.\nCREATE TABLE documents (\n\n  id           BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  entity       VARCHAR(191) NOT NULL\n               CHECK (entity IN ('CUSTOMER','LEAD','QUOTATION','BOOKING','CALL','GENERAL')),\n  entity_id    INTEGER NOT NULL,\n  category     TEXT,\n  filename     TEXT NOT NULL,\n  stored_name  VARCHAR(191) NOT NULL UNIQUE,\n  mime_type    TEXT NOT NULL,\n  size_bytes   INTEGER NOT NULL,\n  uploaded_by  BIGINT REFERENCES users(id),\n  created_at   VARCHAR(191) NOT NULL,\n  deleted_at   TEXT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_docs_entity ON documents(entity, entity_id, created_at)",
      "-- =========================== IMPORTS ==========================\nCREATE TABLE import_jobs (\n\n  id            BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  kind          TEXT NOT NULL DEFAULT ('LEADS'),\n  filename      TEXT NOT NULL,\n  status        TEXT NOT NULL DEFAULT ('PENDING')\n                CHECK (status IN ('PENDING','PARSED','IMPORTING','COMPLETED','FAILED')),\n  column_map    TEXT NOT NULL DEFAULT ('{}'),\n  preview       TEXT NOT NULL DEFAULT ('[]'),\n  total_rows    INTEGER NOT NULL DEFAULT 0,\n  valid_rows    INTEGER NOT NULL DEFAULT 0,\n  invalid_rows  INTEGER NOT NULL DEFAULT 0,\n  duplicate_rows INTEGER NOT NULL DEFAULT 0,\n  imported_rows INTEGER NOT NULL DEFAULT 0,\n  failed_rows   INTEGER NOT NULL DEFAULT 0,\n  errors        TEXT NOT NULL DEFAULT ('[]'),\n  created_by    BIGINT REFERENCES users(id),\n  created_at    VARCHAR(191) NOT NULL,\n  updated_at    TEXT NOT NULL,\n  completed_at  TEXT,\n  deleted_at    TEXT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_imports_created ON import_jobs(created_at)",
      "ALTER TABLE leads ADD COLUMN import_job_id BIGINT REFERENCES import_jobs(id)",
      "-- ==================== DUPLICATE REVIEWS ======================\nCREATE TABLE duplicate_reviews (\n\n  id           BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  entity       VARCHAR(191) NOT NULL CHECK (entity IN ('LEAD','CUSTOMER')),\n  entity_id    INTEGER NOT NULL,\n  candidate_id INTEGER NOT NULL,\n  reason       TEXT,\n  score        TEXT,\n  status       VARCHAR(191) NOT NULL DEFAULT 'OPEN'\n               CHECK (status IN ('OPEN','KEPT_SEPARATE','MERGED','LINKED','IGNORED')),\n  decided_by   BIGINT REFERENCES users(id),\n  decided_at   TEXT,\n  metadata     TEXT NOT NULL DEFAULT ('{}'),\n  created_at   VARCHAR(191) NOT NULL,\n  updated_at   TEXT NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_dup_status ON duplicate_reviews(status, created_at)",
      "CREATE INDEX idx_dup_entity ON duplicate_reviews(entity, entity_id)",
      "ALTER TABLE customers ADD COLUMN merged_into_id BIGINT REFERENCES customers(id)",
      "-- =================== AUTOMATION SUPPORT ======================\nALTER TABLE users ADD COLUMN skills TEXT NOT NULL DEFAULT ('[]')",
      "ALTER TABLE follow_ups ADD COLUMN reminder_sent_at TEXT",
      "ALTER TABLE follow_ups ADD COLUMN overdue_reminder_sent_at VARCHAR(191)",
      "CREATE INDEX idx_fu_reminder ON follow_ups(overdue_reminder_sent_at, scheduled_date)"
    ]
  },
  {
    id: "003",
    name: "security_hardening",
    statements: [
      "-- Per-account login lockout (complements the IP-based rate limiter).\nALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE users ADD COLUMN locked_until TEXT",
      "-- Password reset tokens: only the sha256 hash is stored, never the raw token.\nCREATE TABLE password_reset_tokens (\n\n  id         BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  token_hash VARCHAR(191) NOT NULL UNIQUE,\n  expires_at VARCHAR(191) NOT NULL,\n  used_at    TEXT,\n  ip         TEXT,\n  created_at VARCHAR(191) NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_prt_user ON password_reset_tokens(user_id, created_at)",
      "CREATE INDEX idx_prt_expires ON password_reset_tokens(expires_at)",
      "CREATE INDEX idx_docs_uploader ON documents(uploaded_by, created_at)",
      "CREATE INDEX idx_sessions_revoked ON sessions(revoked_at)"
    ]
  },
  {
    id: "004",
    name: "bookings_financial_checks",
    statements: [
      "ALTER TABLE bookings ADD CONSTRAINT bookings_total_nonneg CHECK (total_amount >= 0)",
      "ALTER TABLE bookings ADD CONSTRAINT bookings_paid_nonneg CHECK (paid_amount >= 0)"
    ]
  },
  {
    id: "005",
    name: "payments_financial_checks",
    statements: [
      "ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (amount > 0)"
    ]
  },
  {
    id: "006",
    name: "booking_quotation_unique",
    statements: [
      "CREATE UNIQUE INDEX uq_bookings_quotation ON bookings(quotation_id)"
    ]
  },
  {
    id: "007",
    name: "invoices",
    statements: [
      "-- Billing documents. Money math (subtotal/tax/total) is computed server-side\n-- on write; paid_amount is derived from linked booking payments at read time.\nCREATE TABLE invoices (\n\n  id             BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  invoice_number VARCHAR(191) NOT NULL UNIQUE,\n  booking_id     BIGINT REFERENCES bookings(id) ON DELETE SET NULL,\n  quotation_id   BIGINT REFERENCES quotations(id) ON DELETE SET NULL,\n  lead_id        BIGINT REFERENCES leads(id) ON DELETE SET NULL,\n  customer_id    BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,\n  worker_id      BIGINT REFERENCES users(id),\n  issue_date     TEXT NOT NULL,\n  due_date       VARCHAR(191),\n  items          TEXT NOT NULL DEFAULT ('[]'),\n  currency       TEXT NOT NULL DEFAULT ('INR'),\n  subtotal       DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (subtotal >= 0),\n  tax_rate       DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 100),\n  tax_amount     DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),\n  total_amount   DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (total_amount >= 0),\n  paid_amount    DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),\n  status         VARCHAR(191) NOT NULL DEFAULT 'DRAFT'\n                 CHECK (status IN ('DRAFT','ISSUED','PAID','VOID')),\n  notes          TEXT,\n  created_by     BIGINT REFERENCES users(id),\n  updated_by     BIGINT REFERENCES users(id),\n  created_at     VARCHAR(191) NOT NULL,\n  updated_at     TEXT NOT NULL,\n  deleted_at     TEXT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
      "CREATE INDEX idx_invoices_customer ON invoices(customer_id, created_at)",
      "CREATE INDEX idx_invoices_booking ON invoices(booking_id)",
      "CREATE INDEX idx_invoices_status ON invoices(status)",
      "CREATE INDEX idx_invoices_worker ON invoices(worker_id, created_at)",
      "CREATE INDEX idx_invoices_due ON invoices(due_date)"
    ]
  }
];

// src/db/migrate.ts
init_config();
var SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;
var MYSQL_SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
async function migrate() {
  openDatabase(config.databasePath);
  if (isPostgres()) {
    await migratePostgres();
    return;
  }
  if (getDialect() === "mysql") {
    await migrateMysql();
    return;
  }
  await exec(SCHEMA_MIGRATIONS_DDL);
  const applied = await appliedIds();
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    let sql;
    try {
      sql = typeof migration.sql === "function" ? migration.sql(getDb()) : migration.sql;
    } catch (err) {
      throw new Error(
        `Migration ${migration.id} (${migration.name}) pre-check failed: ${err.message}`
      );
    }
    if (sql === null) {
      console.warn(
        `[crm] Migration ${migration.id} (${migration.name}) skipped: prerequisites not met; will retry on next start.`
      );
      continue;
    }
    try {
      await tx(async () => {
        await exec(sql);
        await run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [
          migration.id,
          migration.name,
          nowISO()
        ]);
      });
    } catch (err) {
      throw new Error(
        `Migration ${migration.id} (${migration.name}) failed: ${err.message}`
      );
    }
  }
}
async function migratePostgres() {
  await exec(SCHEMA_MIGRATIONS_DDL);
  const applied = await appliedIds();
  for (const migration of pgMigrations) {
    if (applied.has(migration.id)) continue;
    try {
      await tx(async () => {
        await exec(migration.sql);
        await run(
          "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          [migration.id, migration.name, nowISO()]
        );
      });
    } catch (err) {
      throw new Error(
        `PostgreSQL migration ${migration.id} (${migration.name}) failed: ${err.message}`
      );
    }
  }
  await syncIdentitySequences();
}
async function migrateMysql() {
  await exec(MYSQL_SCHEMA_MIGRATIONS_DDL);
  const applied = await appliedIds();
  for (const migration of mysqlMigrations) {
    if (applied.has(migration.id)) continue;
    for (const statement of migration.statements) {
      try {
        await exec(statement);
      } catch (err) {
        const e = err;
        if (e.errno === 1050 || e.errno === 1060 || e.errno === 1061 || e.code === "ER_TABLE_EXISTS_ERROR" || e.code === "ER_DUP_FIELDNAME" || e.code === "ER_DUP_KEYNAME") {
          continue;
        }
        throw new Error(
          `MySQL migration ${migration.id} (${migration.name}) failed: ${err.message}`
        );
      }
    }
    try {
      await run(
        "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        [migration.id, migration.name, nowISO()]
      );
    } catch (err) {
      throw new Error(
        `MySQL migration ${migration.id} (${migration.name}) marker failed: ${err.message}`
      );
    }
  }
}
async function syncIdentitySequences() {
  const cols = await all(
    `SELECT table_name AS tbl, column_name AS col
     FROM information_schema.columns
     WHERE table_schema = current_schema AND is_identity = 'YES'`
  );
  for (const { tbl, col } of cols) {
    await exec(
      `SELECT setval(pg_get_serial_sequence('${tbl.replace(/'/g, "''")}', '${col.replace(/'/g, "''")}'),
        GREATEST(COALESCE((SELECT max(${col.replace(/'/g, '""')}) FROM ${tbl.replace(/'/g, '"')}), 1), 1))`
    );
  }
}
async function appliedIds() {
  const rows = await all("SELECT id FROM schema_migrations");
  return new Set(rows.map((r) => String(r.id)));
}

// src/db/seed.ts
init_database();
init_config();

// src/lib/permissions.ts
var PERMISSIONS = [
  { code: "dashboard:admin", name: "View admin dashboard", category: "Dashboard" },
  { code: "dashboard:worker", name: "View worker dashboard", category: "Dashboard" },
  { code: "users:manage", name: "Create and manage workers", category: "Workers" },
  { code: "customers:read_all", name: "View all customers", category: "Customers" },
  { code: "customers:read_own", name: "View assigned customers", category: "Customers" },
  { code: "customers:manage", name: "Create and edit customers", category: "Customers" },
  { code: "customers:merge", name: "Merge duplicate customers", category: "Customers" },
  { code: "leads:read_all", name: "View all leads", category: "Leads" },
  { code: "leads:read_own", name: "View assigned leads", category: "Leads" },
  { code: "leads:create", name: "Create leads", category: "Leads" },
  { code: "leads:update", name: "Edit any lead", category: "Leads" },
  { code: "leads:update_own", name: "Edit assigned leads", category: "Leads" },
  { code: "leads:assign", name: "Assign and reassign leads", category: "Leads" },
  { code: "follow_ups:read_all", name: "View all follow-ups", category: "Follow-ups" },
  { code: "follow_ups:read_own", name: "View own follow-ups", category: "Follow-ups" },
  { code: "follow_ups:create", name: "Create follow-ups", category: "Follow-ups" },
  { code: "follow_ups:update", name: "Update any follow-up", category: "Follow-ups" },
  { code: "follow_ups:update_own", name: "Update assigned follow-ups", category: "Follow-ups" },
  { code: "notes:create", name: "Add lead notes", category: "Leads" },
  { code: "calls:read_all", name: "View all calls", category: "Calling" },
  { code: "calls:read_own", name: "View own calls", category: "Calling" },
  { code: "calls:create", name: "Log and place calls", category: "Calling" },
  { code: "calls:update", name: "Edit any call", category: "Calling" },
  { code: "calls:update_own", name: "Edit own calls", category: "Calling" },
  { code: "recordings:access", name: "Play call recordings", category: "Calling" },
  { code: "quotations:read_all", name: "View all quotations", category: "Sales" },
  { code: "quotations:read_own", name: "View own quotations", category: "Sales" },
  { code: "quotations:create", name: "Create quotations", category: "Sales" },
  { code: "quotations:update_own", name: "Update own quotations", category: "Sales" },
  { code: "quotations:manage", name: "Update any quotation", category: "Sales" },
  { code: "bookings:read_all", name: "View all bookings", category: "Sales" },
  { code: "bookings:read_own", name: "View own bookings", category: "Sales" },
  { code: "bookings:create", name: "Create bookings", category: "Sales" },
  { code: "bookings:update_own", name: "Update own bookings", category: "Sales" },
  { code: "bookings:manage", name: "Update any booking", category: "Sales" },
  { code: "invoices:read_all", name: "View all invoices", category: "Sales" },
  { code: "invoices:read_own", name: "View own invoices", category: "Sales" },
  { code: "invoices:create", name: "Create invoices", category: "Sales" },
  { code: "invoices:update_own", name: "Update own invoices", category: "Sales" },
  { code: "invoices:manage", name: "Update and delete any invoice", category: "Sales" },
  { code: "communications:read", name: "View communications", category: "Communication" },
  { code: "communications:send", name: "Send messages", category: "Communication" },
  { code: "documents:read", name: "View documents", category: "Documents" },
  { code: "documents:upload", name: "Upload documents", category: "Documents" },
  { code: "documents:manage", name: "Delete documents", category: "Documents" },
  { code: "reports:read", name: "Run reports", category: "Reporting" },
  { code: "exports:run", name: "Export CRM data", category: "Reporting" },
  { code: "imports:manage", name: "Import leads", category: "Reporting" },
  { code: "analytics:read", name: "View worker performance", category: "Reporting" },
  { code: "automation:manage", name: "Manage assignment and reminder automation", category: "Automation" },
  { code: "ai:use", name: "Use AI assistance", category: "Automation" },
  { code: "settings:manage", name: "Manage CRM settings", category: "Settings" },
  { code: "audit:read", name: "View audit logs", category: "Settings" }
];
var ALL_PERMISSION_CODES = PERMISSIONS.map((p) => p.code);
var ROLE_PERMISSIONS = {
  ADMIN: ALL_PERMISSION_CODES,
  WORKER: [
    "dashboard:worker",
    "customers:read_own",
    "leads:read_own",
    "leads:update_own",
    "follow_ups:read_own",
    "follow_ups:create",
    "follow_ups:update_own",
    "notes:create",
    "calls:read_own",
    "calls:create",
    "calls:update_own",
    "recordings:access",
    "quotations:read_own",
    "quotations:create",
    "quotations:update_own",
    "bookings:read_own",
    "bookings:create",
    "bookings:update_own",
    "invoices:read_own",
    "invoices:create",
    "invoices:update_own",
    "communications:read",
    "communications:send",
    "documents:read",
    "documents:upload",
    "ai:use"
  ]
};
var ROLES = [
  { code: "ADMIN", name: "Admin / Owner", description: "Full access to the CRM" },
  { code: "WORKER", name: "Worker / Employee", description: "Access limited to assigned work" }
];

// src/db/seed.ts
var LEAD_STATUSES = [
  { code: "NEW", name: "New", category: "OPEN", color: "#0284c7", sort: 10 },
  { code: "ASSIGNED", name: "Assigned", category: "OPEN", color: "#2563eb", sort: 20 },
  { code: "CONTACTED", name: "Contacted", category: "OPEN", color: "#7c3aed", sort: 30 },
  { code: "INTERESTED", name: "Interested", category: "OPEN", color: "#0891b2", sort: 40 },
  { code: "FOLLOW_UP", name: "Follow-up", category: "OPEN", color: "#d97706", sort: 50 },
  { code: "QUOTATION_SENT", name: "Quotation Sent", category: "OPEN", color: "#ea580c", sort: 60 },
  { code: "NEGOTIATION", name: "Negotiation", category: "OPEN", color: "#c026d3", sort: 70 },
  { code: "CONVERTED", name: "Converted", category: "WON", color: "#16a34a", sort: 80 },
  { code: "NOT_INTERESTED", name: "Not Interested", category: "LOST", color: "#dc2626", sort: 90 },
  { code: "NO_RESPONSE", name: "No Response", category: "LOST", color: "#9f1239", sort: 100 },
  { code: "INVALID", name: "Invalid", category: "LOST", color: "#6b7280", sort: 110 },
  { code: "CLOSED", name: "Closed", category: "LOST", color: "#475569", sort: 120 }
];
var LEAD_SOURCES = [
  "Website",
  "WhatsApp",
  "Facebook",
  "Instagram",
  "Google Ads",
  "Google Business",
  "Referral",
  "Phone",
  "Walk-in",
  "Partner",
  "Existing Customer",
  "Manual Entry",
  "Imported Lead"
];
var DEFAULT_SETTINGS = {
  trip_types: ["Family", "Couple", "Honeymoon", "Group", "Corporate", "Adventure", "Trekking", "Pilgrimage", "Luxury", "Budget", "Custom"],
  requirements_options: ["Hotel", "Cab", "Flight", "Train", "Bus", "Sightseeing", "Activities", "Trek", "Guide", "Transfers", "Complete Package", "Custom Itinerary"],
  priorities: [
    { value: "LOW", label: "Low", color: "#64748b" },
    { value: "MEDIUM", label: "Medium", color: "#2563eb" },
    { value: "HIGH", label: "High", color: "#d97706" },
    { value: "URGENT", label: "Urgent", color: "#dc2626" }
  ],
  follow_up_types: ["Call", "WhatsApp", "Email", "Meeting", "Site Visit", "Other"],
  currencies: ["INR", "USD", "EUR", "GBP", "AED", "THB", "SGD"],
  lead_number_prefix: "LD",
  business: { name: "Travel Agency CRM", timezone: config.businessTimezone },
  // ---- Part 2 configuration (all editable from Settings, nothing hardcoded) ----
  assignment: {
    strategy: "MANUAL",
    // MANUAL | ROUND_ROBIN | WORKLOAD | DESTINATION | SKILL
    auto_assign_new: false,
    destination_rules: []
  },
  call_policy: {
    recording_mode: "PROVIDER_DEFAULT",
    // PROVIDER_DEFAULT | RECORD | DO_NOT_RECORD
    consent_notice: "This call may be recorded for quality and training purposes.",
    retention_days: 180
  },
  reminders: { enabled: true, overdue_enabled: true },
  telephony: {
    provider: "none",
    // none | generic_rest
    base_url: "",
    auth_env: "TELEPHONY_API_KEY",
    initiate_path: "/calls",
    recording_path: "/calls/{id}/recording"
  },
  communication_providers: {
    whatsapp: { provider: "none", base_url: "", auth_env: "WHATSAPP_API_KEY" },
    email: { provider: "none", base_url: "", auth_env: "EMAIL_API_KEY" },
    sms: { provider: "none", base_url: "", auth_env: "SMS_API_KEY" }
  },
  ai: { provider: "none", base_url: "", model: "", auth_env: "AI_API_KEY", enabled: false },
  retention: { call_recordings_days: 180, communications_days: 0, documents_days: 0, audit_logs_days: 0 }
};
async function seedRbac() {
  const now = nowISO();
  for (const role of ROLES) {
    const existing = await get("SELECT id FROM roles WHERE code = ?", [role.code]);
    if (existing) {
      await run("UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ?", [
        role.name,
        role.description,
        now,
        existing.id
      ]);
    } else {
      await run("INSERT INTO roles (code, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
        role.code,
        role.name,
        role.description,
        now,
        now
      ]);
    }
  }
  for (const perm of PERMISSIONS) {
    await run(
      `INSERT INTO permissions (code, name, category, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name, category = excluded.category`,
      [perm.code, perm.name, perm.category, now]
    );
  }
  for (const role of ROLES) {
    const roleRow = await get("SELECT id FROM roles WHERE code = ?", [role.code]);
    if (!roleRow) continue;
    const codes = ROLE_PERMISSIONS[role.code] ?? [];
    const rows = await all("SELECT id, code FROM permissions");
    const allowed = new Set(codes);
    await run("DELETE FROM role_permissions WHERE role_id = ?", [roleRow.id]);
    for (const row of rows) {
      if (!allowed.has(row.code)) continue;
      await run("INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)", [
        roleRow.id,
        row.id
      ]);
    }
  }
}
async function seedStatuses() {
  const now = nowISO();
  for (const s of LEAD_STATUSES) {
    const existing = await get("SELECT id FROM lead_statuses WHERE code = ?", [s.code]);
    if (existing) {
      await run("UPDATE lead_statuses SET name = ?, category = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?", [
        s.name,
        s.category,
        s.color,
        s.sort,
        now,
        existing.id
      ]);
    } else {
      await run(
        "INSERT INTO lead_statuses (code, name, category, color, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
        [s.code, s.name, s.category, s.color, s.sort, now, now]
      );
    }
  }
}
async function seedSources() {
  const now = nowISO();
  for (const [index, name] of LEAD_SOURCES.entries()) {
    await run(
      `INSERT INTO lead_sources (name, is_active, sort_order, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
      [name, (index + 1) * 10, now, now]
    );
  }
}
async function seedSettings() {
  const now = nowISO();
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await run(
      `INSERT INTO settings (setting_key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(setting_key) DO NOTHING`,
      [key, JSON.stringify(value), now]
    );
  }
}
async function seedAdmin() {
  const now = nowISO();
  const adminRole = await get("SELECT id FROM roles WHERE code = ?", ["ADMIN"]);
  if (!adminRole) return;
  const existing = await get(
    "SELECT id FROM users WHERE lower(email) = lower(?) AND deleted_at IS NULL",
    [config.admin.email]
  );
  if (existing) return;
  await run(
    `INSERT INTO users (name, email, phone, username, password_hash, role_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    [
      config.admin.name,
      config.admin.email.toLowerCase(),
      null,
      "admin",
      hashPassword(config.admin.password),
      adminRole.id,
      now,
      now
    ]
  );
}
async function seed() {
  await seedRbac();
  await seedStatuses();
  await seedSources();
  await seedSettings();
  await seedAdmin();
}

// src/api.ts
function redact(message) {
  return message.replace(/(?:postgres(?:ql)?|mysql2?):\/\/[^\s'"]+/gi, (m) => `${m.split("://")[0]}://[REDACTED]`).replace(/([?&](?:password|pwd)=)[^\s&]+/gi, "$1[REDACTED]").replace(/\b(password|pwd)(["'\s:=]+)[^\s,'"]+/gi, "$1$2[REDACTED]");
}
async function boot() {
  await migrate();
  await seed();
  return createApp();
}
var app = await boot().catch((err) => {
  const detail = redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  const stack = err instanceof Error && err.stack ? redact(err.stack) : void 0;
  console.error("[crm] FATAL boot failure:", detail, stack ?? "");
  return (req, res) => res.status(500).json({ ok: false, error: "BOOT_FAILED", detail, ...stack ? { stack } : {} });
});
var api_default = app;
export {
  api_default as default
};
