/**
 * Shared TUI utilities
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Message } from '../types';

/** Format elapsed time as "Xs" or "Xm Ys" */
export function formatElapsed(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  if (elapsed < 60) {
    return `${elapsed}s`;
  }
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * Compute next processingStartTime given current chat state.
 * Returns the new startTime value (number | null).
 */
export function nextProcessingTimerState(
  isProcessing: boolean,
  currentStartTime: number | null,
): number | null {
  if (isProcessing && !currentStartTime) return Date.now();
  if (!isProcessing && currentStartTime) return null;
  return currentStartTime;
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

export function exportTranscriptMd(messages: Message[], sessionName: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = path.basename(sessionName.replace(/\s+/g, '-').replace(/[/\\]/g, '_'));
  const filename = `transcript-${safeName}-${timestamp}.md`;
  const filepath = path.join(process.env.HOME || '~', filename);

  let content = `# Transcript: ${sessionName}\n\n`;
  content += `*Exported: ${new Date().toLocaleString()} | ${messages.length} messages*\n\n`;
  content += '---\n\n';

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const role = msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'AI';
    const modelLabel = msg.model ? ` (${msg.model.split('/').pop()})` : '';
    content += `### [${time}] ${role}${modelLabel}\n\n`;
    content += `${msg.content}\n\n`;
  }

  fs.writeFileSync(filepath, content);
  return filepath;
}

export async function exportTranscriptDocx(messages: Message[], sessionName: string): Promise<string> {
  const { Document, Paragraph, TextRun, HeadingLevel, Packer, BorderStyle } = await import('docx');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = path.basename(sessionName.replace(/\s+/g, '-').replace(/[/\\]/g, '_'));
  const filename = `transcript-${safeName}-${timestamp}.docx`;
  const filepath = path.join(process.env.HOME || '~', filename);

  const children: any[] = [];

  // Title
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: `Transcript: ${sessionName}`, bold: true })],
  }));

  // Metadata
  children.push(new Paragraph({
    children: [new TextRun({
      text: `Exported: ${new Date().toLocaleString()} | ${messages.length} messages`,
      italics: true,
      color: '666666',
    })],
  }));

  // Separator
  children.push(new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
    children: [],
  }));

  children.push(new Paragraph({ children: [] }));

  // Messages
  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const role = msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'AI';
    const modelLabel = msg.model ? ` (${msg.model.split('/').pop()})` : '';

    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_3,
      children: [new TextRun({ text: `[${time}] ${role}${modelLabel}` })],
    }));

    // Split content into paragraphs
    for (const para of msg.content.split('\n')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: para })],
      }));
    }

    children.push(new Paragraph({ children: [] }));
  }

  const doc = new Document({
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}
