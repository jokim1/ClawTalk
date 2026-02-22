/**
 * Shared display formatters.
 *
 * Prefix-aware scope labels, posting priority mapping, and text truncation.
 * Used across SettingsPicker, ChannelConfigPicker, JobsConfigPicker,
 * usePlatformBindings, useTalkHandlers, and useJobHandlers.
 */

export function formatBindingScopeLabel(binding: {
  scope: string;
  displayScope?: string;
  accountId?: string;
}): string {
  const scopeLabel = binding.displayScope?.trim() || binding.scope;
  const accountId = binding.accountId?.trim();
  if (accountId) {
    const prefixed = `${accountId}:`;
    if (scopeLabel.toLowerCase().startsWith(prefixed.toLowerCase())) {
      return scopeLabel;
    }
    return `${accountId}:${scopeLabel}`;
  }
  return scopeLabel;
}

export type PostingPriority = 'adaptive' | 'channel' | 'reply';

export function formatPostingPriority(mode: 'thread' | 'channel' | 'adaptive' | undefined): PostingPriority {
  if (mode === 'thread') return 'reply';
  if (mode === 'channel') return 'channel';
  return 'adaptive';
}

export function toDeliveryMode(priority: PostingPriority): 'thread' | 'channel' | 'adaptive' {
  if (priority === 'channel') return 'channel';
  if (priority === 'reply') return 'thread';
  return 'adaptive';
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}
