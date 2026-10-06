import type { Request } from 'express';
import { run } from '../db/database.js';

type Meta = Record<string, unknown>;

export async function audit(
  req: Request | undefined,
  action: string,
  entity: string,
  entityId: string | number | null | undefined,
  metadata: Meta = {},
): Promise<void> {
  try {
    await run(
      'INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        req?.user?.id ?? null,
        action,
        entity,
        entityId === null || entityId === undefined ? null : String(entityId),
        JSON.stringify(metadata),
        req?.ip ?? null,
        new Date().toISOString(),
      ],
    );
  } catch (err) {
    console.error('[audit] failed to write audit log', err);
  }
}

export async function auditAs(
  userId: number | null,
  action: string,
  entity: string,
  entityId: string | number | null,
  metadata: Meta = {},
  ip?: string,
): Promise<void> {
  await run(
    'INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, action, entity, entityId === null ? null : String(entityId), JSON.stringify(metadata), ip ?? null, new Date().toISOString()],
  );
}
