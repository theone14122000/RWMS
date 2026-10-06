import { all, nowISO, run } from '../db/database.js';

export interface NotifyInput {
  userId: number;
  type: string;
  title: string;
  body?: string;
  entity?: string;
  entityId?: number;
  link?: string;
}

export async function notify(input: NotifyInput): Promise<void> {
  try {
    await run(
      'INSERT INTO notifications (user_id, type, title, body, entity, entity_id, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        input.userId,
        input.type,
        input.title,
        input.body ?? null,
        input.entity ?? null,
        input.entityId ?? null,
        input.link ?? null,
        await nowISO(),
      ],
    );
  } catch (err) {
    console.error('[notify] failed', err);
  }
}

export async function notifyRole(roleCode: string, input: Omit<NotifyInput, 'userId'>): Promise<void> {
  const rows = await all<{ id: number }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.code = ? AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`,
    [roleCode],
  );
  for (const row of rows) await notify({ ...input, userId: row.id });
}
