/**
 * Message Writer
 *
 * Writes formatted messages directly to terminal scrollback.
 * Bypasses Ink rendering so messages persist in terminal history.
 */

import type { Message } from '../types';
import { getModelAlias } from '../models.js';

// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

/**
 * Format and write a message to stdout (terminal scrollback).
 * This bypasses Ink so the message persists when user scrolls up.
 */
export function writeMessageToScrollback(msg: Message): void {
  const speakerName = msg.role === 'user'
    ? 'You'
    : msg.role === 'system'
      ? 'System'
      : getModelAlias(msg.model ?? '');

  const speakerColor = msg.role === 'user'
    ? COLORS.green
    : msg.role === 'system'
      ? COLORS.yellow
      : COLORS.cyan;

  // Format: "Speaker:\n  content"
  const header = `${speakerColor}${COLORS.bold}${speakerName}:${COLORS.reset}`;

  // Indent content with 2 spaces
  const content = (msg.content || ' ')
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');

  // Clear current line and move to start, then write message
  // This ensures we don't overlap with Ink's rendering
  process.stdout.write(`\r\x1b[K${header}\n${content}\n`);
}

/**
 * Write a blank line to scrollback (for spacing).
 */
export function writeBlankLine(): void {
  process.stdout.write('\n');
}

/**
 * Move cursor up N lines (to position Ink render area).
 */
export function moveCursorUp(lines: number): void {
  if (lines > 0) {
    process.stdout.write(`\x1b[${lines}A`);
  }
}

/**
 * Clear from cursor to end of screen.
 */
export function clearToEnd(): void {
  process.stdout.write('\x1b[J');
}

/**
 * Save cursor position.
 */
export function saveCursor(): void {
  process.stdout.write('\x1b[s');
}

/**
 * Restore cursor position.
 */
export function restoreCursor(): void {
  process.stdout.write('\x1b[u');
}
