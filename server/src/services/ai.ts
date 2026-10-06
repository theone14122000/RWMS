import { upstream } from '../lib/errors.js';
import { aiConfig } from './settings.js';

/**
 * AI assistance boundary.
 *
 * The CRM never pretends to be intelligent: when no provider is configured
 * the API answers `{configured:false, reason:'Integration Not Configured'}`
 * and the UI shows that state. When configured, every call is audited and the
 * output is returned as a *draft* for human review — AI never mutates business
 * records by itself.
 */
export interface AiProvider {
  readonly code: string;
  readonly model: string;
  isConfigured(): boolean;
  complete(system: string, user: string): Promise<string>;
}

export class NullAiProvider implements AiProvider {
  readonly code = 'none';
  readonly model = '';
  isConfigured(): boolean {
    return false;
  }
  async complete(): Promise<string> {
    throw upstream('AI provider is not configured.');
  }
}

export class HttpAiProvider implements AiProvider {
  readonly code: string;
  readonly model: string;

  constructor(
    private baseUrl: string,
    private authEnv: string,
    model: string,
    code = 'openai_compatible',
  ) {
    this.code = code;
    this.model = model;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.model);
  }

  async complete(system: string, user: string): Promise<string> {
    const secret = this.authEnv ? process.env[this.authEnv] : undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw upstream(`AI provider unreachable: ${(err as Error).message}`);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw upstream(`AI provider returned HTTP ${res.status}.`);
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      throw upstream('AI provider returned an unreadable response.');
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw upstream('AI provider returned no content.');
    return content.trim();
  }
}

export async function getAiProvider(): Promise<AiProvider> {
  const cfg = await aiConfig();
  if (cfg.enabled && cfg.provider !== 'none' && cfg.base_url && cfg.model) {
    return new HttpAiProvider(cfg.base_url, cfg.auth_env, cfg.model, cfg.provider);
  }
  return new NullAiProvider();
}

export async function aiStatus(): Promise<{
  configured: boolean;
  provider: string;
  model: string;
  enabled: boolean;
  auth_env: string;
  secret_present: boolean;
  reason: string | null;
}> {
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
    reason: configured ? null : 'Integration Not Configured',
  };
}
