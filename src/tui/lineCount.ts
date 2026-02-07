/**
 * Shared line-counting utilities for TUI rendering.
 *
 * Uses wrap-ansi with the EXACT same options as Ink's internal renderer
 * ({ hard: true, trim: false }) to guarantee line count === rendered lines.
 */

import type { Message } from '../types.js';
import { getModelAlias } from '../models.js';

// wrap-ansi v6 is a CJS dependency of Ink, available in node_modules
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wrapAnsi = require('wrap-ansi') as (input: string, columns: number, options?: { hard?: boolean; wordWrap?: boolean; trim?: boolean }) => string;

/**
 * Pre-wrap text to a given width using Ink's exact wrapping options.
 * Returns the wrapped string with \n at wrap points.
 */
export function preWrapText(text: string, width: number): string {
  if (!text || width <= 0) return text || '';
  return wrapAnsi(text, width, { hard: true, trim: false });
}

/**
 * Count how many visual terminal lines a string occupies when wrapped to `width`.
 */
export function countVisualLines(text: string, width: number): number {
  if (!text || width <= 0) return 0;
  const wrapped = preWrapText(text, width);
  return wrapped.split('\n').length;
}

/**
 * How many visual lines a message occupies (speaker line + indented content).
 */
export function messageVisualLines(msg: Message, width: number): number {
  const speakerName = msg.role === 'user'
    ? 'You'
    : msg.role === 'system'
      ? 'System'
      : getModelAlias(msg.model ?? '');

  // Speaker line: "Name:" — always 1 visual line
  const speakerLines = countVisualLines(`${speakerName}:`, width);

  // Content indented by 2 chars
  const contentWidth = Math.max(10, width - 2);
  const content = msg.content || ' ';
  const contentLines = countVisualLines(content, contentWidth);

  return speakerLines + contentLines;
}

/**
 * Get the speaker name for a message.
 */
export function getSpeakerName(msg: Message): string {
  return msg.role === 'user'
    ? 'You'
    : msg.role === 'system'
      ? 'System'
      : getModelAlias(msg.model ?? '');
}
