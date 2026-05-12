import { createHash } from 'crypto';

export function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  return JSON.stringify(value, Object.keys(value as object).sort());
}

export function fingerprintStableJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
