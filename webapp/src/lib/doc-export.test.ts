import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clipboardCopyHtml,
  clipboardCopyMarkdown,
  clipboardCopyPlain,
  downloadAsHtml,
  downloadAsMarkdown,
  downloadAsPlain,
  isDocEmpty,
  renderHtml,
  renderMarkdown,
  renderPlainText,
  sanitizeFilename,
  stripHtmlTags,
  stripMarkdown,
  type DocSource,
} from './doc-export';

describe('doc-export', () => {
  describe('conversion matrix', () => {
    describe('markdown source', () => {
      const src: DocSource = {
        format: 'markdown',
        bodyMarkdown:
          '# Heading\n\nA paragraph with [a link](https://x.com).\n\n- one\n- two',
        bodyHtml: null,
      };

      it('renderMarkdown returns raw body_markdown', () => {
        expect(renderMarkdown(src)).toBe(src.bodyMarkdown);
      });

      it('renderHtml produces <h1>, <p>, <a>, <ul>', () => {
        const html = renderHtml(src);
        expect(html).toContain('<h1');
        expect(html).toContain('Heading');
        expect(html).toContain('<p');
        expect(html).toContain('<a href="https://x.com">a link</a>');
        expect(html).toContain('<ul');
        expect(html).toContain('<li');
      });

      it('renderPlainText drops syntax and preserves text', () => {
        const text = renderPlainText(src);
        expect(text).toContain('Heading');
        expect(text).toContain('A paragraph with a link');
        expect(text).toContain('one');
        expect(text).toContain('two');
        expect(text).not.toContain('#');
        expect(text).not.toContain('[a link]');
        expect(text).not.toContain('(https://x.com)');
      });
    });

    describe('html source', () => {
      const src: DocSource = {
        format: 'html',
        bodyMarkdown: null,
        bodyHtml:
          '<h1>Heading</h1><p>A paragraph with <a href="https://x.com">a link</a>.</p><ul><li>one</li><li>two</li></ul>',
      };

      it('renderHtml returns raw body_html', () => {
        expect(renderHtml(src)).toBe(src.bodyHtml);
      });

      it('renderMarkdown produces #-headings, list dashes, and link syntax', () => {
        const md = renderMarkdown(src);
        // Turndown sets atx headings by config
        expect(md).toMatch(/^#\s+Heading/m);
        expect(md).toContain('[a link](https://x.com)');
        expect(md).toMatch(/^[-]\s+one/m);
        expect(md).toMatch(/^[-]\s+two/m);
      });

      it('renderPlainText strips tags and preserves text', () => {
        const text = renderPlainText(src);
        expect(text).toContain('Heading');
        expect(text).toContain('A paragraph with a link.');
        expect(text).toContain('one');
        expect(text).toContain('two');
        expect(text).not.toContain('<');
      });
    });

    describe('edge cases', () => {
      it('renders empty bodies as empty strings (not "null")', () => {
        const empty: DocSource = {
          format: 'markdown',
          bodyMarkdown: null,
          bodyHtml: null,
        };
        expect(renderMarkdown(empty)).toBe('');
        expect(renderHtml(empty)).toBe('');
        expect(renderPlainText(empty)).toBe('');
      });
    });
  });

  describe('stripMarkdown / stripHtmlTags helpers', () => {
    it('stripMarkdown drops fenced code fences but keeps content', () => {
      const text = stripMarkdown('```js\nconst x = 1\n```');
      expect(text).toContain('const x = 1');
      expect(text).not.toContain('```');
    });

    it('stripHtmlTags decodes common entities', () => {
      const text = stripHtmlTags('<p>5 &gt; 4 &amp; 3 &lt; 4</p>');
      expect(text).toContain('5 > 4 & 3 < 4');
    });

    it('stripHtmlTags adds newlines between block elements', () => {
      const text = stripHtmlTags('<p>one</p><p>two</p>');
      expect(text).toBe('one\ntwo');
    });
  });

  describe('clipboard', () => {
    let writeMock: ReturnType<typeof vi.fn>;
    let writeTextMock: ReturnType<typeof vi.fn>;
    const originalClipboardItem = globalThis.ClipboardItem;

    beforeEach(() => {
      writeMock = vi.fn().mockResolvedValue(undefined);
      writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { write: writeMock, writeText: writeTextMock },
      });
      // Provide a minimal ClipboardItem in jsdom.
      // @ts-expect-error: shape match is enough for the assertion
      globalThis.ClipboardItem = class FakeClipboardItem {
        public types: string[];
        constructor(public items: Record<string, Blob>) {
          this.types = Object.keys(items);
        }
      };
    });

    afterEach(() => {
      // restore (cast through unknown — the original may be undefined
      // in jsdom; the assignment back is intentional cleanup).
      (
        globalThis as unknown as { ClipboardItem: typeof ClipboardItem }
      ).ClipboardItem = originalClipboardItem;
    });

    it('clipboardCopyHtml writes BOTH text/html and text/plain', async () => {
      const src: DocSource = {
        format: 'markdown',
        bodyMarkdown: '# Hi\n\nWorld',
        bodyHtml: null,
      };
      await clipboardCopyHtml(src);
      expect(writeMock).toHaveBeenCalledTimes(1);
      const items = writeMock.mock.calls[0]?.[0] as Array<{
        items: Record<string, Blob>;
      }>;
      expect(items).toHaveLength(1);
      const mimes = Object.keys(items[0]?.items ?? {});
      expect(mimes).toContain('text/html');
      expect(mimes).toContain('text/plain');
    });

    it('clipboardCopyMarkdown writes markdown via writeText', async () => {
      const src: DocSource = {
        format: 'markdown',
        bodyMarkdown: '# H',
        bodyHtml: null,
      };
      await clipboardCopyMarkdown(src);
      expect(writeTextMock).toHaveBeenCalledWith('# H');
    });

    it('clipboardCopyPlain writes plain text via writeText', async () => {
      const src: DocSource = {
        format: 'markdown',
        bodyMarkdown: '# Hi',
        bodyHtml: null,
      };
      await clipboardCopyPlain(src);
      expect(writeTextMock).toHaveBeenCalledWith('Hi');
    });
  });

  describe('file download', () => {
    let createSpy: ReturnType<typeof vi.fn>;
    let revokeSpy: ReturnType<typeof vi.fn>;
    let clickSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      createSpy = vi.fn().mockReturnValue('blob:fake-url');
      revokeSpy = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: createSpy,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: revokeSpy,
      });
      // Patch synthetic anchor click — we don't actually want a navigation.
      clickSpy = vi.fn();
      const origCreate = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const el = origCreate(tag);
        if (tag === 'a') {
          (el as HTMLAnchorElement).click = clickSpy as () => void;
        }
        return el;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('downloadAsHtml creates a blob URL + triggers anchor click', () => {
      const src: DocSource = {
        format: 'markdown',
        bodyMarkdown: '# Hi',
        bodyHtml: null,
      };
      downloadAsHtml(src, { filenameBase: 'My Doc' });
      expect(createSpy).toHaveBeenCalledTimes(1);
      const blob = createSpy.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toMatch(/text\/html/);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it('downloadAsMarkdown uses .md extension + text/markdown MIME', () => {
      const src: DocSource = {
        format: 'markdown',
        bodyMarkdown: '# Hi',
        bodyHtml: null,
      };
      downloadAsMarkdown(src, { filenameBase: 'My Doc' });
      const blob = createSpy.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toMatch(/text\/markdown/);
    });

    it('downloadAsPlain uses .txt extension + text/plain MIME', () => {
      const src: DocSource = {
        format: 'markdown',
        bodyMarkdown: '# Hi',
        bodyHtml: null,
      };
      downloadAsPlain(src, { filenameBase: 'My Doc' });
      const blob = createSpy.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toMatch(/text\/plain/);
    });
  });

  describe('sanitizeFilename', () => {
    it('replaces filesystem-hostile chars with -', () => {
      expect(sanitizeFilename('My/Doc:Title')).toBe('My-Doc-Title');
    });

    it('collapses whitespace and runs of dashes', () => {
      expect(sanitizeFilename('Hello   World')).toBe('Hello-World');
      expect(sanitizeFilename('a---b')).toBe('a-b');
    });

    it('falls back to document when empty', () => {
      expect(sanitizeFilename('')).toBe('document');
      expect(sanitizeFilename('   ')).toBe('document');
      expect(sanitizeFilename('///')).toBe('document');
    });
  });

  describe('isDocEmpty', () => {
    it('returns true for null/whitespace bodies', () => {
      expect(
        isDocEmpty({ format: 'markdown', bodyMarkdown: null, bodyHtml: null }),
      ).toBe(true);
      expect(
        isDocEmpty({
          format: 'markdown',
          bodyMarkdown: '  \n  ',
          bodyHtml: null,
        }),
      ).toBe(true);
      expect(
        isDocEmpty({ format: 'html', bodyMarkdown: null, bodyHtml: '   ' }),
      ).toBe(true);
    });

    it('returns false for non-empty bodies', () => {
      expect(
        isDocEmpty({
          format: 'markdown',
          bodyMarkdown: '# Hi',
          bodyHtml: null,
        }),
      ).toBe(false);
      expect(
        isDocEmpty({
          format: 'html',
          bodyMarkdown: null,
          bodyHtml: '<p>Hi</p>',
        }),
      ).toBe(false);
    });
  });
});
