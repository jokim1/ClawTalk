/**
 * Configuration management for RemoteClaw
 *
 * Persists gateway URL, token, and preferences to ~/.remoteclaw/config.json
 */

import * as fs from 'fs';
import * as path from 'path';

export interface BillingOverride {
  mode: 'api' | 'subscription';
  plan?: string;
  monthlyPrice?: number;
}

export interface VoiceConfig {
  autoSend?: boolean;
  autoPlay?: boolean;
  ttsVoice?: string;
  ttsSpeed?: number;
}

export interface RemoteClawConfig {
  gatewayUrl: string;
  gatewayToken?: string;
  defaultModel?: string;
  agentId?: string;
  billing?: Record<string, BillingOverride>;
  voice?: VoiceConfig;
  anthropicApiKey?: string;
}

const CONFIG_DIR = path.join(process.env.HOME || '~', '.remoteclaw');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/** Validate that a gateway URL is a well-formed HTTP(S) URL. */
export function validateGatewayUrl(urlString: string): { ok: true; warnings: string[] } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, error: `Invalid gateway URL: "${urlString}". Must be a valid HTTP(S) URL.` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Gateway URL must use http:// or https:// (got "${parsed.protocol}")` };
  }

  const warnings: string[] = [];
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol === 'http:' && !isLocalhost) {
    warnings.push(`Warning: Gateway URL uses HTTP on non-localhost address (${parsed.hostname}). Auth tokens will be sent in plaintext.`);
  }

  return { ok: true, warnings };
}

const DEFAULT_CONFIG: RemoteClawConfig = {
  gatewayUrl: 'http://127.0.0.1:18789',
  agentId: 'remoteclaw',
};

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): RemoteClawConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.debug('Failed to load config:', err);
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: RemoteClawConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  // Restrict permissions (secrets stored in plaintext)
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch (err) {
    console.debug('chmod failed:', err);
    process.stderr.write('Warning: could not set restrictive permissions on config file\n');
  }
}

export interface CliFlags {
  gateway?: string;
  token?: string;
  model?: string;
  anthropicKey?: string;
}

/**
 * Resolve gateway config from CLI flags > env vars > config file > defaults
 */
export function resolveGatewayConfig(flags: CliFlags): RemoteClawConfig {
  const fileConfig = loadConfig();

  const gatewayUrl =
    flags.gateway
    || process.env.REMOTECLAW_GATEWAY_URL
    || fileConfig.gatewayUrl
    || DEFAULT_CONFIG.gatewayUrl;

  const urlCheck = validateGatewayUrl(gatewayUrl);
  if (!urlCheck.ok) {
    process.stderr.write(`${urlCheck.error}\n`);
  }
  // Warnings (e.g. HTTP plaintext) are not printed here — they would
  // pollute the TUI scrollback. Callers can inspect urlCheck.warnings.

  return {
    gatewayUrl,
    gatewayToken:
      flags.token
      || process.env.REMOTECLAW_GATEWAY_TOKEN
      || fileConfig.gatewayToken,
    defaultModel:
      flags.model
      || fileConfig.defaultModel,
    agentId: fileConfig.agentId || DEFAULT_CONFIG.agentId,
    billing: fileConfig.billing,
    anthropicApiKey:
      flags.anthropicKey
      || process.env.ANTHROPIC_API_KEY
      || fileConfig.anthropicApiKey,
  };
}

const DEFAULT_BILLING: BillingOverride = { mode: 'api' };

/**
 * Get billing override for a provider, defaulting to API mode
 */
export function getBillingForProvider(
  config: RemoteClawConfig,
  provider: string,
): BillingOverride {
  return config.billing?.[provider] ?? DEFAULT_BILLING;
}
