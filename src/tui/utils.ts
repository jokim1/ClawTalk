/**
 * Shared TUI utilities
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Message } from '../types';

export function estimateMessageLines(content: string, width: number): number {
  if (!content) return 3;

  // Account for paddingX(1) on chat area + paddingLeft(2) on message content
  const usableWidth = Math.max(15, width - 6);
  const paragraphs = content.split('\n');
  let contentLines = 0;

  for (const para of paragraphs) {
    if (!para.trim()) {
      contentLines += 1;
      continue;
    }

    const words = para.split(/\s+/);
    let currentLineLength = 0;
    let paraLines = 1;

    for (const word of words) {
      const wordLength = word.length;

      if (wordLength > usableWidth) {
        const wordWraps = Math.ceil(wordLength / usableWidth);
        paraLines += wordWraps - 1;
        currentLineLength = wordLength % usableWidth || usableWidth;
      } else if (currentLineLength + wordLength + 1 > usableWidth) {
        paraLines++;
        currentLineLength = wordLength;
      } else {
        currentLineLength += wordLength + 1;
      }
    }

    contentLines += paraLines;
  }

  // 1 line for speaker name + content lines + 1 line for marginBottom
  return 1 + contentLines + 1;
}

export function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatSessionTime(ts: number): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' });
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${dayOfWeek} ${dateStr} ${time}`;
}

export function formatUpdatedTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const date = new Date(ts);

  if (diff < oneDayMs) {
    // Within past day: show time
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } else {
    // More than a day ago: show date
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

export function exportTranscript(messages: Message[], sessionName: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = path.basename(sessionName.replace(/\s+/g, '-').replace(/[/\\]/g, '_'));
  const filename = `transcript-${safeName}-${timestamp}.txt`;
  const filepath = path.join(process.env.HOME || '~', filename);

  let content = `Transcript: ${sessionName}\n`;
  content += `Exported: ${new Date().toLocaleString()}\n`;
  content += `Messages: ${messages.length}\n`;
  content += '\u2500'.repeat(50) + '\n\n';

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const role = msg.role === 'user' ? 'You' : 'AI';
    content += `[${time}] ${role}:\n${msg.content}\n\n`;
  }

  fs.writeFileSync(filepath, content);
  return filepath;
}
