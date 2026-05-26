// DOMPurify-backed render primitive for AI-generated and user-authored
// HTML doc bodies. Ports rocketboard's SafeHtml allowlist and extends
// it with the surface clawtalk needs: scoped <style> blocks for CSS
// animations and a sanitized SVG subset (no foreignObject, no
// <animate*>, no scripts inside SVG). The allowlist constants are
// duplicated here verbatim from
// /src/shared/rich-text/html-sanitize-config.ts (PR A1) so the webapp
// bundle never pulls Node-only deps. Any change to allowed tags/attrs
// MUST be mirrored in both files.
//
// Implementation notes for DOMPurify quirks:
//   - All tag and attribute names MUST be lowercase. DOMPurify
//     normalizes the input HTML to lowercase before checking allowlists;
//     a camelCase entry like 'viewBox' silently never matches.
//   - We do NOT pass USE_PROFILES alongside ALLOWED_ATTR — DOMPurify's
//     profile attribute list overrides the explicit one when both are
//     present, which strips SVG geometry attrs.
//   - FORCE_BODY: true is REQUIRED for <style> blocks to survive — by
//     default DOMPurify treats <style> as document-head content and
//     drops it from a body-only parse.

import DOMPurify from 'dompurify';
import { useMemo, type HTMLAttributes } from 'react';

// Allowed elements (all lowercase — DOMPurify normalizes input case).
// Comments group the rationale.
export const SAFE_HTML_ALLOWED_TAGS = [
  // Structural + textual (rocketboard baseline)
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  // Scoped CSS (enables @keyframes / animation properties)
  'style',
  // Sanitized SVG subset — see plan §"What we reuse from rocketboard".
  // Banned SVG: <foreignobject>, <animate>, <animatemotion>,
  // <animatetransform>, <script>, <feimage> w/ external href.
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'circle',
  'rect',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
  'tspan',
  'lineargradient',
  'radialgradient',
  'stop',
];

export const SAFE_HTML_ALLOWED_ATTR = [
  // Anchor + structural
  'data-anchor-id',
  'class',
  'id',
  'style',
  // Links + media
  'alt',
  'href',
  'rel',
  'src',
  'target',
  'title',
  // Table layout
  'colspan',
  'rowspan',
  // ARIA passthrough
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-hidden',
  'aria-expanded',
  'aria-controls',
  'aria-live',
  // SVG geometry (lowercased — DOMPurify normalizes to lowercase)
  'viewbox',
  'preserveaspectratio',
  'xmlns',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'points',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'width',
  'height',
  'transform',
  'opacity',
  'gradienttransform',
  'gradientunits',
  'spreadmethod',
  'offset',
  'stop-color',
  'stop-opacity',
  'text-anchor',
  'font-family',
  'font-size',
  'font-weight',
  'dx',
  'dy',
  // <use> internal-href only. The URI regex below blocks javascript:.
  'xlink:href',
];

// Belt-and-suspenders deny list (lowercased per DOMPurify
// normalization). DOMPurify already blocks script/iframe/form by
// default; listing them makes the deny surface legible at call sites.
export const SAFE_HTML_FORBID_TAGS = [
  'animate',
  'animatemotion',
  'animatetransform',
  'foreignobject',
  'feimage',
  'iframe',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'script',
  'object',
  'embed',
  'link',
  'meta',
];

export const SAFE_HTML_FORBID_ATTR = ['formaction', 'srcdoc'];

// Block javascript: URLs while allowing the usual safe schemes for
// links and embedded data (e.g. inline SVG base64 images).
const SAFE_HTML_URI_REGEXP = /^(?:(?:https?|mailto|tel|data|#|\/):)/i;

// Attributes whose values are inert (no URI-style sanitization needed).
// DOMPurify defaults this set to a small list (alt/class/id/etc.); any
// attribute outside it gets value-checked against ALLOWED_URI_REGEXP,
// which kills non-URI values like `viewBox="0 0 100 100"` or numeric
// SVG geometry. Listing SVG attrs as URI-safe keeps the geometry
// intact while still URI-validating href/src elsewhere.
export const SAFE_HTML_URI_SAFE_ATTR = [
  'data-anchor-id',
  // SVG geometry attrs (lowercased per DOMPurify normalization)
  'viewbox',
  'preserveaspectratio',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'points',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'width',
  'height',
  'transform',
  'opacity',
  'gradienttransform',
  'gradientunits',
  'spreadmethod',
  'offset',
  'stop-color',
  'stop-opacity',
  'text-anchor',
  'font-family',
  'font-size',
  'font-weight',
  'dx',
  'dy',
  // Table layout
  'colspan',
  'rowspan',
];

export function sanitizeDocHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: SAFE_HTML_ALLOWED_TAGS,
    ALLOWED_ATTR: SAFE_HTML_ALLOWED_ATTR,
    FORBID_TAGS: SAFE_HTML_FORBID_TAGS,
    FORBID_ATTR: SAFE_HTML_FORBID_ATTR,
    ALLOWED_URI_REGEXP: SAFE_HTML_URI_REGEXP,
    ADD_URI_SAFE_ATTR: SAFE_HTML_URI_SAFE_ATTR,
    // Without FORCE_BODY, <style> blocks are treated as <head> content
    // and dropped from a body-only parse.
    FORCE_BODY: true,
  });
}

export type SafeHtmlProps = HTMLAttributes<HTMLDivElement> & {
  html: string;
};

export function SafeHtml({
  html,
  className,
  ...rest
}: SafeHtmlProps): JSX.Element {
  const clean = useMemo(() => sanitizeDocHtml(html), [html]);
  const classes = ['safe-html', className].filter(Boolean).join(' ');
  return (
    <div
      {...rest}
      className={classes}
      // sanitizeDocHtml ran through DOMPurify above; this is the
      // canonical render path.
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
