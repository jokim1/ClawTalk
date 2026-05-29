import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import {
  extractAttachmentText,
  inferSupportedAttachmentMimeType,
  isImageAttachmentMimeType,
  stripNullBytes,
} from './attachment-extraction.js';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function makeXlsxBuffer(
  sheets: Array<{ name: string; rows: unknown[][] }>,
): Buffer {
  const wb = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

describe('attachment extraction MIME helpers', () => {
  it('falls back from generic MIME types to supported extensions', () => {
    expect(
      inferSupportedAttachmentMimeType('notes.txt', 'application/octet-stream'),
    ).toBe('text/plain');
    expect(
      inferSupportedAttachmentMimeType(
        'diagram.png',
        'application/octet-stream',
      ),
    ).toBe('image/png');
  });

  it('preserves already-supported MIME types', () => {
    expect(
      inferSupportedAttachmentMimeType('report.pdf', 'application/pdf'),
    ).toBe('application/pdf');
    expect(inferSupportedAttachmentMimeType('photo.jpg', 'image/jpeg')).toBe(
      'image/jpeg',
    );
  });

  it('recognizes only the image MIME types supported by the current Talk UI', () => {
    expect(isImageAttachmentMimeType('image/png')).toBe(true);
    expect(isImageAttachmentMimeType('image/jpeg')).toBe(true);
    expect(isImageAttachmentMimeType('image/webp')).toBe(true);
    expect(isImageAttachmentMimeType('image/gif')).toBe(false);
    expect(isImageAttachmentMimeType('application/pdf')).toBe(false);
  });
});

describe('extractAttachmentText — xlsx', () => {
  it('extracts cells from a simple workbook as a markdown table', async () => {
    const buffer = makeXlsxBuffer([
      {
        name: 'Sheet1',
        rows: [
          ['Name', 'Revenue', 'Region'],
          ['Lila', 1234, 'US'],
          ['Acme', 567, 'IN'],
        ],
      },
    ]);
    const text = await extractAttachmentText(buffer, XLSX_MIME, 'report.xlsx');
    expect(text).toContain('## Sheet: Sheet1');
    expect(text).toContain('| Name | Revenue | Region |');
    expect(text).toContain('| --- | --- | --- |');
    expect(text).toContain('| Lila | 1234 | US |');
    expect(text).toContain('| Acme | 567 | IN |');
  });

  it('walks multiple sheets and labels them', async () => {
    const buffer = makeXlsxBuffer([
      { name: 'Summary', rows: [['Total'], [42]] },
      {
        name: 'Detail',
        rows: [
          ['Item', 'Count'],
          ['A', 1],
        ],
      },
    ]);
    const text = await extractAttachmentText(buffer, XLSX_MIME, 'multi.xlsx');
    expect(text).toContain('## Sheet: Summary');
    expect(text).toContain('## Sheet: Detail');
    expect(text).toContain('| Total |');
    expect(text).toContain('| Item | Count |');
  });

  it('caps at MAX_EXCEL_SHEETS (10) and emits an omitted-sheets note', async () => {
    const sheets = Array.from({ length: 14 }, (_, i) => ({
      name: `S${i + 1}`,
      rows: [['col'], [`row-${i + 1}`]],
    }));
    const buffer = makeXlsxBuffer(sheets);
    const text = await extractAttachmentText(buffer, XLSX_MIME, 'many.xlsx');
    expect(text).toContain('## Sheet: S1');
    expect(text).toContain('## Sheet: S10');
    expect(text).not.toContain('## Sheet: S11');
    expect(text).toContain('4 additional sheet(s) omitted');
  });

  it('still emits the sheet header for a sheet with no rows', async () => {
    // Matches prior ExcelJS-based behavior: a present but empty sheet
    // produces a `## Sheet: …` line and no table. The fully-empty
    // workbook placeholder fires only when the file has zero sheets.
    const buffer = makeXlsxBuffer([{ name: 'Empty', rows: [] }]);
    const text = await extractAttachmentText(buffer, XLSX_MIME, 'blank.xlsx');
    expect(text).toContain('## Sheet: Empty');
  });
});

describe('extractAttachmentText — NUL byte sanitization', () => {
  // Postgres rejects 0x00 in text columns; unpdf emits it for glyphs it
  // cannot map (observed on Substack PDFs, where "(" and "-" became NUL).
  const NUL = String.fromCharCode(0);

  it('strips NUL bytes from extracted text so it can be stored', async () => {
    const buffer = Buffer.from(
      `Director ${NUL}Game Design) and AI${NUL}generated`,
      'utf-8',
    );
    const text = await extractAttachmentText(buffer, 'text/plain', 'notes.txt');
    expect(text).not.toContain(NUL);
    expect(text).toBe('Director Game Design) and AIgenerated');
  });
});

describe('stripNullBytes', () => {
  const NUL = String.fromCharCode(0);

  it('removes every NUL and leaves clean text untouched', () => {
    expect(stripNullBytes(`a${NUL}b${NUL}c`)).toBe('abc');
    expect(stripNullBytes('no nulls here')).toBe('no nulls here');
  });
});
