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

export function notify(input: NotifyInput): void {
  try {
    run(
      'INSERT INTO notifications (user_id, type, title, body, entity, entity_id, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        input.userId,
        input.type,
        input.title,
        input.body ?? null,
        input.entity ?? null,
        input.entityId ?? null,
        input.link ?? null,
        nowISO(),
      ],
    );
  } catch (err) {
    console.error('[notify] failed', err);
  }
}

export function notifyRole(roleCode: string, input: Omit<NotifyInput, 'userId'>): void {
  const rows = all<{ id: number }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.code = ? AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`,
    [roleCode],
  );
  for (const row of rows) notify({ ...input, userId: row.id });
}
