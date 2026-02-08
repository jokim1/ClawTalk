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

/** Remove leaked control characters from the input field (Ink workaround). */
export function cleanInputChar(
  setter: (fn: (prev: string) => string) => void,
  char: string,
): void {
  setTimeout(() => {
    setter(prev => prev.replace(new RegExp(char, 'g'), ''));
  }, INPUT_CLEANUP_DELAY_MS);
}
