/**
 * Shared helper functions for the TUI layer
 */

import { randomUUID } from 'crypto';
import type { Message, AgentRole } from '../types.js';
import { INPUT_CLEANUP_DELAY_MS } from '../constants.js';

/** Create a Message object with a unique ID and current timestamp. */
export function createMessage(
  role: Message['role'],
  content: string,
  model?: string,
  agentName?: string,
  agentRole?: AgentRole,
): Message {
  return {
    id: randomUUID(),
    role,
    content,
    timestamp: Date.now(),
    ...(model && { model }),
    ...(agentName && { agentName }),
    ...(agentRole && { agentRole }),
  };
}

/** Extract ```job``` blocks from AI response text. */
export function parseJobBlocks(text: string): Array<{ schedule: string; prompt: string }> {
  const results: Array<{ schedule: string; prompt: string }> = [];
  const regex = /```job\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const scheduleLine = block.match(/^schedule:\s*(.+)$/m);
    const promptLine = block.match(/^prompt:\s*([\s\S]+?)$/m);
    if (scheduleLine && promptLine) {
      results.push({
        schedule: scheduleLine[1].trim(),
        prompt: promptLine[1].trim(),
      });
    }
  }
  return results;
}

/**
 * Remove a leaked control character from the input field (Ink workaround).
 *
 * When Ctrl+key shortcuts fire, Ink sometimes leaks the raw character into
 * the input. This records the current input length and, after a short delay,
 * removes the character only if one was actually appended at that position.
 * Previous implementation used a global regex which destroyed ALL occurrences
 * of the character in the user's text (e.g. every "a" after Ctrl+A).
 */
export function cleanInputChar(
  setter: (fn: (prev: string) => string) => void,
  char: string,
): void {
  // Capture current length synchronously so the delayed check knows
  // where a leaked character would appear.
  let snapshotLength = -1;
  setter(prev => {
    snapshotLength = prev.length;
    return prev; // no-op — just reading the length
  });

  setTimeout(() => {
    setter(prev => {
      // Only remove if a character was appended right at the snapshot position
      if (prev.length > snapshotLength && prev[snapshotLength] === char) {
        return prev.slice(0, snapshotLength) + prev.slice(snapshotLength + 1);
      }
      return prev;
    });
  }, INPUT_CLEANUP_DELAY_MS);
}
