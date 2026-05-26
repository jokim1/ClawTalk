import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SAFE_HTML_ALLOWED_TAGS, SafeHtml, sanitizeDocHtml } from './SafeHtml';

afterEach(() => {
  cleanup();
});

describe('SafeHtml', () => {
  describe('attack-surface strips dangerous tags + attrs', () => {
    it('strips <script>', () => {
      const html = '<p>hello</p><script>alert(1)</script>';
      const clean = sanitizeDocHtml(html);
      expect(clean).not.toContain('<script');
      expect(clean).not.toContain('alert');
      expect(clean).toContain('<p>hello</p>');
    });

    it('strips <iframe>', () => {
      const html = '<p>hi</p><iframe src="https://example.com"></iframe>';
      const clean = sanitizeDocHtml(html);
      expect(clean).not.toContain('<iframe');
      expect(clean).toContain('<p>hi</p>');
    });

    it('strips <form>, <input>, <button>', () => {
      const html =
        '<form><input type="text" /><button>submit</button></form><p>after</p>';
      const clean = sanitizeDocHtml(html);
      expect(clean).not.toContain('<form');
      expect(clean).not.toContain('<input');
      expect(clean).not.toContain('<button');
      expect(clean).toContain('<p>after</p>');
    });

    it('strips on* event handler attributes', () => {
      const html = '<p onclick="alert(1)">click me</p>';
      const clean = sanitizeDocHtml(html);
      expect(clean).not.toContain('onclick');
      expect(clean).not.toContain('alert');
      // The element survives sans handler.
      expect(clean).toContain('click me');
    });

    it('blocks javascript: URLs', () => {
      const html = '<a href="javascript:alert(1)">bad</a>';
      const clean = sanitizeDocHtml(html);
      expect(clean.toLowerCase()).not.toContain('javascript:');
    });

    it('strips <foreignObject> SVG escape vector', () => {
      const html =
        '<svg><foreignObject><div>escape</div></foreignObject></svg>';
      const clean = sanitizeDocHtml(html);
      expect(clean).not.toContain('<foreignObject');
      expect(clean).not.toContain('foreignobject');
    });

    it('strips <animate*> SVG script-like elements', () => {
      const html =
        '<svg><animate attributeName="opacity" /><animateMotion path="M0,0" /></svg>';
      const clean = sanitizeDocHtml(html);
      expect(clean).not.toContain('<animate');
    });
  });

  describe('preserves safe constructs the doc surface needs', () => {
    it('preserves <style> blocks with @keyframes', () => {
      const html =
        '<style>@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }</style><p>hi</p>';
      const clean = sanitizeDocHtml(html);
      expect(clean).toContain('@keyframes');
      expect(clean).toContain('fadeIn');
    });

    it('preserves sanitized SVG subset (element + attribute survives)', () => {
      const html =
        '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="10" fill="red" /></svg>';
      const clean = sanitizeDocHtml(html);
      expect(clean).toContain('<svg');
      expect(clean).toContain('<circle');
      // SVG geometry attrs vary in casing by DOM serialization between
      // jsdom and browsers. Assert the attribute name appears with its
      // value rather than pinning a specific case.
      expect(clean.toLowerCase()).toContain('cx="50"');
      expect(clean.toLowerCase()).toContain('fill="red"');
    });

    it('preserves https/mailto/tel/data link schemes', () => {
      const cases: Array<[string, string]> = [
        ['<a href="https://example.com">w</a>', 'href="https://example.com"'],
        ['<a href="mailto:a@b.com">m</a>', 'href="mailto:a@b.com"'],
        ['<a href="tel:+1234">p</a>', 'href="tel:+1234"'],
      ];
      for (const [input, expected] of cases) {
        const clean = sanitizeDocHtml(input);
        expect(clean).toContain(expected);
      }
    });

    it('preserves <table> structure', () => {
      const html =
        '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>';
      const clean = sanitizeDocHtml(html);
      expect(clean).toContain('<table');
      expect(clean).toContain('<thead');
      expect(clean).toContain('<th');
      expect(clean).toContain('<td');
    });

    it('preserves data-anchor-id on top-level blocks', () => {
      const html = '<p data-anchor-id="abc-123">anchor me</p>';
      const clean = sanitizeDocHtml(html);
      expect(clean).toContain('data-anchor-id="abc-123"');
    });

    it('preserves inline style="" on blocks', () => {
      const html = '<p style="color: #c1272d">red</p>';
      const clean = sanitizeDocHtml(html);
      expect(clean).toMatch(/style=/);
    });
  });

  describe('allowlist matches the rocketboard baseline', () => {
    it('includes the structural+textual elements rocketboard ships', () => {
      // Sample drawn from rocketboard/src/components/SafeHtml.allowlist.ts —
      // we don't import to avoid cross-repo coupling, just spot-check
      // representative tags that are load-bearing for the render surface.
      const baseline = [
        'a',
        'blockquote',
        'br',
        'code',
        'div',
        'em',
        'h1',
        'h2',
        'h3',
        'img',
        'li',
        'mark',
        'ol',
        'p',
        'pre',
        'span',
        'strong',
        'table',
        'tbody',
        'td',
        'tr',
        'ul',
      ];
      for (const tag of baseline) {
        expect(SAFE_HTML_ALLOWED_TAGS).toContain(tag);
      }
    });
  });

  describe('component', () => {
    it('renders sanitized html inside a div with the safe-html class', () => {
      const { container } = render(
        <SafeHtml html="<p>hello <script>bad</script></p>" />,
      );
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('safe-html');
      expect(wrapper.innerHTML).toContain('<p>hello </p>');
      expect(wrapper.innerHTML).not.toContain('<script');
    });

    it('merges caller className with safe-html', () => {
      const { container } = render(
        <SafeHtml className="my-doc" html="<p>x</p>" />,
      );
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('safe-html');
      expect(wrapper.className).toContain('my-doc');
    });
  });
});
