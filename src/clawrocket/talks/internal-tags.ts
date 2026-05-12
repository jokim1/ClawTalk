const INTERNAL_TAG_PATTERN = /<internal>[\s\S]*?(?:<\/internal>|$)/g;
const NO_CHANNEL_REPLY_DIRECTIVE_PATTERN = /^\s*\[\[NO_CHANNEL_REPLY\]\]\s*/;

export function extractChannelReplyControl(text: string): {
  suppressDelivery: boolean;
  visibleText: string;
  rationale: string | null;
} {
  if (!text) {
    return {
      suppressDelivery: false,
      visibleText: '',
      rationale: null,
    };
  }
  const withoutInternal = text.replace(INTERNAL_TAG_PATTERN, '');
  const suppressDelivery =
    NO_CHANNEL_REPLY_DIRECTIVE_PATTERN.test(withoutInternal);
  const visibleText = suppressDelivery
    ? withoutInternal.replace(NO_CHANNEL_REPLY_DIRECTIVE_PATTERN, '')
    : withoutInternal;
  const trimmedVisibleText = visibleText.trim();
  return {
    suppressDelivery,
    visibleText: trimmedVisibleText ? visibleText : trimmedVisibleText,
    rationale: suppressDelivery ? trimmedVisibleText || null : null,
  };
}

export function stripInternalTalkResponseText(text: string): string {
  return extractChannelReplyControl(text).visibleText;
}

export interface TalkResponseStreamSanitizer {
  push(chunk: string): string;
}

export function createTalkResponseStreamSanitizer(): TalkResponseStreamSanitizer {
  let rawText = '';
  let visibleText = '';

  return {
    push(chunk: string): string {
      rawText += chunk;
      const nextVisibleText = stripInternalTalkResponseText(rawText);
      const nextDeltaText = nextVisibleText.slice(visibleText.length);
      visibleText = nextVisibleText;
      return nextDeltaText;
    },
  };
}
