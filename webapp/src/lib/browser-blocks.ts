import type { BrowserBlock } from './api';

const PHONE_APPROVAL_HINT_REGEX =
  /\b(check your phone|check your device|approve sign[- ]?in|approve the sign in|linkedin app|approve on your phone|approve from your phone|approve from another device|trusted device)\b/i;

export function isPhoneApprovalBrowserBlock(
  browserBlock:
    | Pick<BrowserBlock, 'kind' | 'message' | 'url' | 'title'>
    | null
    | undefined,
): boolean {
  if (!browserBlock || browserBlock.kind !== 'auth_required') {
    return false;
  }

  const haystack = [browserBlock.message, browserBlock.url, browserBlock.title]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');

  return PHONE_APPROVAL_HINT_REGEX.test(haystack);
}
