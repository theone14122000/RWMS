import { all, get, nowISO, run } from '../db/database.js';

/** Reads a JSON settings row, falling back when missing or malformed. */
export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await get<{ value: string }>('SELECT value FROM settings WHERE setting_key = ?', [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function writeSetting(key: string, value: unknown): Promise<void> {
  await run(
    `INSERT INTO settings (setting_key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), await nowISO()],
  );
}

export async function readAllSettings(): Promise<Record<string, unknown>> {
  const rows = await all<{ setting_key: string; value: string }>('SELECT setting_key, value FROM settings');
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.setting_key] = JSON.parse(row.value);
    } catch {
      out[row.setting_key] = null;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Typed shapes for the Part 2 configuration objects.                  */
/* Every one of these is editable from Settings — nothing is hardcoded */
/* into business behaviour.                                            */
/* ------------------------------------------------------------------ */

export type AssignmentStrategy = 'MANUAL' | 'ROUND_ROBIN' | 'WORKLOAD' | 'DESTINATION' | 'SKILL';

export interface AssignmentConfig {
  strategy: AssignmentStrategy;
  auto_assign_new: boolean;
  destination_rules: Array<{ destination: string; worker_ids: number[] }>;
}

export interface CallPolicy {
  recording_mode: 'PROVIDER_DEFAULT' | 'RECORD' | 'DO_NOT_RECORD';
  consent_notice: string;
  retention_days: number;
}

export interface TelephonyConfig {
  provider: string;
  base_url: string;
  auth_env: string;
  initiate_path: string;
  recording_path: string;
}

export interface ChannelConfig {
  provider: string;
  base_url: string;
  auth_env: string;
}

export interface AiConfig {
  provider: string;
  base_url: string;
  model: string;
  auth_env: string;
  enabled: boolean;
}

export interface RetentionConfig {
  call_recordings_days: number;
  communications_days: number;
  documents_days: number;
  audit_logs_days: number;
}

export interface ReminderConfig {
  enabled: boolean;
  overdue_enabled: boolean;
}

const ASSIGNMENT_FALLBACK: AssignmentConfig = {
  strategy: 'MANUAL',
  auto_assign_new: false,
  destination_rules: [],
};

export async function assignmentConfig(): Promise<AssignmentConfig> {
  const raw = await readSetting<Partial<AssignmentConfig> | null>('assignment', null);
  if (!raw) return { ...ASSIGNMENT_FALLBACK, destination_rules: [] };
  return {
    strategy: (raw.strategy as AssignmentStrategy) ?? 'MANUAL',
    auto_assign_new: Boolean(raw.auto_assign_new),
    destination_rules: Array.isArray(raw.destination_rules) ? raw.destination_rules : [],
  };
}

export async function callPolicy(): Promise<CallPolicy> {
  const raw = await readSetting<Partial<CallPolicy> | null>('call_policy', null);
  return {
    recording_mode: raw?.recording_mode ?? 'PROVIDER_DEFAULT',
    consent_notice: raw?.consent_notice ?? '',
    retention_days: Number(raw?.retention_days ?? 0) || 0,
  };
}

export async function telephonyConfig(): Promise<TelephonyConfig> {
  const raw = await readSetting<Partial<TelephonyConfig> | null>('telephony', null);
  return {
    provider: raw?.provider ?? 'none',
    base_url: String(raw?.base_url ?? '').trim(),
    auth_env: raw?.auth_env ?? 'TELEPHONY_API_KEY',
    initiate_path: raw?.initiate_path ?? '/calls',
    recording_path: raw?.recording_path ?? '/calls/{id}/recording',
  };
}

export async function channelConfig(channel: 'WHATSAPP' | 'EMAIL' | 'SMS'): Promise<ChannelConfig> {
  const all_ = await readSetting<Record<string, Partial<ChannelConfig>>>('communication_providers', {});
  const raw = all_?.[channel.toLowerCase()] ?? {};
  return {
    provider: raw.provider ?? 'none',
    base_url: String(raw.base_url ?? '').trim(),
    auth_env: raw.auth_env ?? '',
  };
}

export async function aiConfig(): Promise<AiConfig> {
  const raw = await readSetting<Partial<AiConfig> | null>('ai', null);
  return {
    provider: raw?.provider ?? 'none',
    base_url: String(raw?.base_url ?? '').trim(),
    model: raw?.model ?? '',
    auth_env: raw?.auth_env ?? 'AI_API_KEY',
    enabled: Boolean(raw?.enabled),
  };
}

export async function retentionConfig(): Promise<RetentionConfig> {
  const raw = await readSetting<Partial<RetentionConfig> | null>('retention', null);
  return {
    call_recordings_days: Number(raw?.call_recordings_days ?? 0) || 0,
    communications_days: Number(raw?.communications_days ?? 0) || 0,
    documents_days: Number(raw?.documents_days ?? 0) || 0,
    audit_logs_days: Number(raw?.audit_logs_days ?? 0) || 0,
  };
}

export async function reminderConfig(): Promise<ReminderConfig> {
  const raw = await readSetting<Partial<ReminderConfig> | null>('reminders', null);
  return { enabled: raw?.enabled !== false, overdue_enabled: raw?.overdue_enabled !== false };
}
