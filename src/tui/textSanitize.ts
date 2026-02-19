/**
 * Sanitize text for terminal-safe rendering.
 * Removes ANSI escape sequences and C0/C1 control chars except newline/tab.
 */
export function sanitizeForTerminal(input: string | undefined | null): string {
  if (!input) return '';
  let out = String(input);
  // CSI/SGR escapes: \x1b[ ... final-byte
  out = out.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  // OSC escapes: \x1b] ... BEL or ST
  out = out.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '');
  // Remove remaining control chars except tab/newline.
  out = out.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '');
  return out;
}

