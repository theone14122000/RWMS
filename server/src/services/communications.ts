import { nowISO, run } from '../db/database.js';
import { channelConfig, type ChannelConfig } from './settings.js';

/**
 * Communication boundary (WhatsApp / Email / SMS).
 *
 * A message row is only marked SENT when the configured provider actually
 * accepted it. Without a provider the row is stored as NOT_CONFIGURED so the
 * history shows what *would* have been sent — the API never claims delivery.
 */
export type Channel = 'WHATSAPP' | 'EMAIL' | 'SMS';

export interface SendInput {
  channel: Channel;
  recipient: string;
  body: string;
  subject?: string | null;
  senderId?: number | null;
  leadId?: number | null;
  customerId?: number | null;
  workerId?: number | null;
}

export interface SendResult {
  id: number;
  status: 'QUEUED' | 'SENT' | 'FAILED' | 'NOT_CONFIGURED';
  configured: boolean;
  provider: string;
  error: string | null;
}

function providerSecret(cfg: ChannelConfig): string | undefined {
  return cfg.auth_env ? process.env[cfg.auth_env] : undefined;
}

export function sendCommunication(input: SendInput): SendResult {
  const cfg = channelConfig(input.channel);
  const now = nowISO();

  const insert = run(
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
      cfg.provider === 'none' || !cfg.base_url ? 'NOT_CONFIGURED' : 'QUEUED',
      now,
      now,
    ],
  );
  const id = insert.lastInsertRowid;

  if (cfg.provider === 'none' || !cfg.base_url) {
    return { id, status: 'NOT_CONFIGURED', configured: false, provider: cfg.provider, error: 'Integration Not Configured' };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const secret = providerSecret(cfg);
  if (secret) headers.Authorization = `Bearer ${secret}`;

  // Fire and forget from the caller's perspective: the ledger records the real
  // outcome; failures never block the worker's workflow.
  void (async () => {
    try {
      const res = await fetch(cfg.base_url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          channel: input.channel.toLowerCase(),
          to: input.recipient,
          subject: input.subject ?? null,
          body: input.body,
          lead_id: input.leadId ?? null,
          customer_id: input.customerId ?? null,
          message_id: id,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text().catch(() => '');
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* non JSON */
      }
      const providerMessageId = body?.id ?? body?.message_id ?? null;
      if (res.ok) {
        run('UPDATE communications SET status = ?, provider_message_id = ?, sent_at = ?, updated_at = ? WHERE id = ?', [
          'SENT',
          providerMessageId ? String(providerMessageId) : null,
          nowISO(),
          nowISO(),
          id,
        ]);
      } else {
        run('UPDATE communications SET status = ?, error = ?, updated_at = ? WHERE id = ?', [
          'FAILED',
          `Provider rejected the message (HTTP ${res.status}).`,
          nowISO(),
          id,
        ]);
      }
    } catch (err) {
      run('UPDATE communications SET status = ?, error = ?, updated_at = ? WHERE id = ?', [
        'FAILED',
        `Provider unreachable: ${(err as Error).message}`.slice(0, 300),
        nowISO(),
        id,
      ]);
    }
  })();

  // The row itself starts as QUEUED; only the provider's response (above) can
  // move it to SENT. The API therefore never claims delivery up-front.
  return { id, status: 'QUEUED', configured: true, provider: cfg.provider, error: null };
}

export function channelStatus(channel: Channel): { configured: boolean; provider: string; base_url: string; secret_present: boolean } {
  const cfg = channelConfig(channel);
  return {
    configured: cfg.provider !== 'none' && Boolean(cfg.base_url),
    provider: cfg.provider,
    base_url: cfg.base_url,
    secret_present: Boolean(providerSecret(cfg)),
  };
}
