import {
  all,
  exec,
  get,
  getDb,
  isPostgres,
  nowISO,
  openDatabase,
  run,
  tx,
  type Row,
} from './database.js';
import { migrations } from './migrations.js';
import { pgMigrations } from './pgMigrations.js';
import { config } from '../config.js';

const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`;

export async function migrate(): Promise<void> {
  openDatabase(config.databasePath);
  if (isPostgres()) {
    await migratePostgres();
    return;
  }

  await exec(SCHEMA_MIGRATIONS_DDL);
  const applied = await appliedIds();

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    let sql: string | null;
    try {
      // Pre-checks inspect the live database (SQLite mode only — PG returns
      // early above with its own ported migration list).
      sql = typeof migration.sql === 'function' ? migration.sql(getDb()) : migration.sql;
    } catch (err) {
      throw new Error(
        `Migration ${migration.id} (${migration.name}) pre-check failed: ${(err as Error).message}`,
      );
    }
    if (sql === null) {
      console.warn(
        `[crm] Migration ${migration.id} (${migration.name}) skipped: prerequisites not met; will retry on next start.`,
      );
      continue;
    }
    try {
      await tx(async () => {
        await exec(sql);
        await run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
          migration.id,
          migration.name,
          nowISO(),
        ]);
      });
    } catch (err) {
      throw new Error(
        `Migration ${migration.id} (${migration.name}) failed: ${(err as Error).message}`,
      );
    }
  }
}

async function migratePostgres(): Promise<void> {
  await exec(SCHEMA_MIGRATIONS_DDL);
  const applied = await appliedIds();

  for (const migration of pgMigrations) {
    if (applied.has(migration.id)) continue;
    try {
      await tx(async () => {
        await exec(migration.sql);
        await run(
          'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
          [migration.id, migration.name, nowISO()],
        );
      });
    } catch (err) {
      throw new Error(
        `PostgreSQL migration ${migration.id} (${migration.name}) failed: ${(err as Error).message}`,
      );
    }
  }

  // Explicit-id inserts (none today) would desync identity sequences; keep
  // them in sync defensively so future seeds stay safe.
  await syncIdentitySequences();
}

async function syncIdentitySequences(): Promise<void> {
  const cols = await all<{ tbl: string; col: string }>(
    `SELECT table_name AS tbl, column_name AS col
     FROM information_schema.columns
     WHERE table_schema = current_schema AND is_identity = 'YES'`,
  );
  for (const { tbl, col } of cols) {
    await exec(
      `SELECT setval(pg_get_serial_sequence('${tbl.replace(/'/g, "''")}', '${col.replace(/'/g, "''")}'),
        GREATEST(COALESCE((SELECT max(${col.replace(/'/g, '""')}) FROM ${tbl.replace(/'/g, '"')}), 1), 1))`,
    );
  }
}

async function appliedIds(): Promise<Set<string>> {
  const rows = await all<Row>('SELECT id FROM schema_migrations');
  return new Set(rows.map((r) => String(r.id)));
}

export async function migrationStatus(): Promise<
  Array<{ id: string; name: string; applied: boolean }>
> {
  const rows = await appliedIds();
  const list = isPostgres()
    ? pgMigrations.map((m) => ({ id: m.id, name: m.name }))
    : migrations.map((m) => ({ id: m.id, name: m.name }));
  return list.map((m) => ({ ...m, applied: rows.has(m.id) }));
}

export { exec, get, run };
