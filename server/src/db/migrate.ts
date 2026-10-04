import { exec, get, run, nowISO, openDatabase, getDb, type Row } from './database.js';
import { migrations } from './migrations.js';
import { config } from '../config.js';

export function migrate(): void {
  openDatabase(config.databasePath);
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Row[]).map((r) => String(r.id)),
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
        migration.id,
        migration.name,
        nowISO(),
      ]);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${migration.id} (${migration.name}) failed: ${(err as Error).message}`);
    }
  }
}

export function migrationStatus(): Array<{ id: string; name: string; applied: boolean }> {
  const rows = allApplied();
  return migrations.map((m) => ({
    id: m.id,
    name: m.name,
    applied: rows.has(m.id),
  }));
}

function allApplied(): Set<string> {
  const rows = getDb().prepare('SELECT id FROM schema_migrations').all() as Row[];
  return new Set(rows.map((r) => String(r.id)));
}

export { exec, get, run };
