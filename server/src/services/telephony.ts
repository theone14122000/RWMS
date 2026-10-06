import { randomUUID } from 'node:crypto';
import { notConfigured, upstream } from '../lib/errors.js';
import { readSetting, telephonyConfig, writeSetting, type TelephonyConfig } from './settings.js';

/**
 * Provider-independent telephony boundary.
 *
 * The CRM never talks to a specific vendor directly from routes: it talks to
 * a TelephonyProvider. Adding/exchanging a provider is a configuration plus a
 * new implementation — routes, call records, webhooks and the UI stay as-is.
 * Workers' personal phones are never monitored or dialled secretly: a call is
 * either placed through the configured business provider or logged manually.
 */
export interface InitiateCallInput {
  toNumber: string;
  workerId: number;
  leadId?: number | null;
  customerId?: number | null;
  reference?: string;
}

export interface InitiateCallResult {
  provider: string;
  providerCallId: string;
  status: string;
}

export interface RecordingTicket {
  url: string;
  expiresAt?: string;
}

export interface TelephonyProvider {
  readonly code: string;
  readonly label: string;
  isConfigured(): boolean;
  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;
  fetchRecordingUrl(providerRecordingId: string): Promise<RecordingTicket | null>;
}

/** Used when no business telephony provider is configured yet. */
export class NullTelephonyProvider implements TelephonyProvider {
  readonly code = 'none';
  readonly label = 'No provider configured';

  isConfigured(): boolean {
    return false;
  }

  async initiateCall(): Promise<InitiateCallResult> {
    throw notConfigured(
      'No telephony provider is configured. Configure one in Settings → Integrations, or log the call manually.',
    );
  }

  async fetchRecordingUrl(): Promise<RecordingTicket | null> {
    return null;
  }
}

/**
 * Generic REST provider: any vendor that exposes an HTTP API can be wired in
 * through Settings (base URL + endpoint paths + API key env var). Kept
 * deliberately small — vendor-specific shaping belongs in a dedicated
 * implementation of TelephonyProvider.
 */
export class GenericRestTelephonyProvider implements TelephonyProvider {
  readonly code = 'generic_rest';
  readonly label = 'Generic REST provider';

  constructor(private cfg: TelephonyConfig) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.base_url);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const secret = this.cfg.auth_env ? process.env[this.cfg.auth_env] : undefined;
    if (secret) headers.Authorization = `Bearer ${secret}`;
    return headers;
  }

  private url(template: string, params: Record<string, string>): string {
    let path = template || '/';
    for (const [key, value] of Object.entries(params)) path = path.split(`{${key}}`).join(encodeURIComponent(value));
    return `${this.cfg.base_url.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const endpoint = this.url(this.cfg.initiate_path, {});
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          to: input.toNumber,
          worker_id: input.workerId,
          lead_id: input.leadId ?? null,
          customer_id: input.customerId ?? null,
          client_reference: input.reference ?? randomUUID(),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw upstream(`Telephony provider unreachable: ${(err as Error).message}`);
    }
    const text = await res.text().catch(() => '');
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON provider response */
    }
    if (!res.ok) {
      throw upstream(`Telephony provider rejected the call request (HTTP ${res.status}).`);
    }
    const providerCallId = String(body?.id ?? body?.call_id ?? body?.provider_call_id ?? '');
    if (!providerCallId) throw upstream('Telephony provider did not return a call id.');
    return { provider: this.code, providerCallId, status: String(body?.status ?? 'RINGING') };
  }

  async fetchRecordingUrl(providerRecordingId: string): Promise<RecordingTicket | null> {
    const endpoint = this.url(this.cfg.recording_path, { id: providerRecordingId });
    let res: Response;
    try {
      res = await fetch(endpoint, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw upstream(`Recording provider unreachable: ${(err as Error).message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw upstream(`Recording provider returned HTTP ${res.status}.`);
    const body: any = await res.json().catch(() => ({}));
    const url = String(body?.url ?? body?.recording_url ?? '');
    if (!url) return null;
    return { url, expiresAt: body?.expires_at ? String(body.expires_at) : undefined };
  }
}

export async function getTelephonyProvider(): Promise<TelephonyProvider> {
  const cfg = await telephonyConfig();
  if (cfg.provider === 'generic_rest' && cfg.base_url) return new GenericRestTelephonyProvider(cfg);
  return new NullTelephonyProvider();
}

export async function telephonyStatus(): Promise<{
  provider: string;
  label: string;
  configured: boolean;
  base_url: string;
  auth_env: string;
  secret_present: boolean;
}> {
  const cfg = await telephonyConfig();
  const provider = await getTelephonyProvider();
  return {
    provider: cfg.provider,
    label: provider.label,
    configured: provider.isConfigured(),
    base_url: cfg.base_url,
    auth_env: cfg.auth_env,
    secret_present: Boolean(cfg.auth_env && process.env[cfg.auth_env]),
  };
}

/** Simple shared-secret HMAC-free signature check used by webhook endpoints. */
export function verifyWebhookSecret(provided: string | undefined, secretEnv: string): boolean {
  const expected = secretEnv ? process.env[secretEnv] : undefined;
  if (!expected) return false;
  if (!provided) return false;
  return provided === expected;
}

export const WEBHOOK_SECRET_ENV = 'TELEPHONY_WEBHOOK_SECRET';

/* ------------------------------------------------------------------ */
/* Round-robin pointer is stored as a setting so state survives restarts */
/* without an extra table.                                              */
/* ------------------------------------------------------------------ */
export async function nextRoundRobin(candidates: number[]): Promise<number | null> {
  if (!candidates.length) return null;
  const state = await readSetting<{ index: number }>('assignment_state', { index: 0 });
  const idx = (Number(state.index) || 0) % candidates.length;
  await writeSetting('assignment_state', { index: idx + 1, last_assigned_to: candidates[idx] });
  return candidates[idx];
}
