import { useEffect, useMemo, useRef } from 'react';
import type { ContextSource } from '../lib/api';

export type SourceMentionOption =
  | { kind: 'doc'; insertion: string; title: string }
  | { kind: 'source'; insertion: string; source: ContextSource };

type SourceMentionPickerProps = {
  options: SourceMentionOption[];
  selectedIndex: number;
  onSelect: (option: SourceMentionOption) => void;
  onDismiss: () => void;
};

/**
 * Composer `@`-popover that lists pickable mention options. Purely
 * presentational — the parent owns the filter text + selectedIndex
 * and intercepts keyboard navigation on the underlying textarea
 * (ArrowUp/ArrowDown/Enter/Escape).
 *
 * Click selection fires `onSelect`. Clicking outside fires `onDismiss`.
 */
export function SourceMentionPicker({
  options,
  selectedIndex,
  onSelect,
  onDismiss,
}: SourceMentionPickerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Dismiss when the user clicks outside the popover. Pointerdown
  // (rather than click) so we beat the textarea's focus loss.
  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const node = containerRef.current;
      if (!node) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      onDismiss();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onDismiss]);

  return (
    <div
      ref={containerRef}
      className="source-mention-menu"
      role="listbox"
      aria-label="Mention picker"
    >
      {options.length === 0 ? (
        <div className="source-mention-menu-empty">No matching sources.</div>
      ) : (
        options.map((option, index) => (
          <SourceMentionMenuItem
            key={option.kind === 'doc' ? '__doc__' : option.source.id}
            option={option}
            selected={index === selectedIndex}
            onSelect={onSelect}
          />
        ))
      )}
    </div>
  );
}

function SourceMentionMenuItem({
  option,
  selected,
  onSelect,
}: {
  option: SourceMentionOption;
  selected: boolean;
  onSelect: (option: SourceMentionOption) => void;
}): JSX.Element {
  const title = option.kind === 'doc' ? option.title : option.source.title;
  const refLabel = option.kind === 'doc' ? '@doc' : option.source.sourceRef;
  const note =
    option.kind === 'doc'
      ? 'Attached document'
      : (option.source.note ?? '').trim() ||
        (option.source.sourceType === 'url'
          ? (option.source.sourceUrl ?? '')
          : option.source.sourceType === 'file'
            ? (option.source.fileName ?? '')
            : '');

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className="source-mention-menu-item"
      // Prevent the underlying textarea from losing focus on click.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(option)}
    >
      <span className="source-mention-menu-item-title-row">
        <span>{title}</span>
        <span className="source-mention-menu-item-ref">{refLabel}</span>
      </span>
      {note ? (
        <span className="source-mention-menu-item-note">{note}</span>
      ) : null}
    </button>
  );
}

type BuildOptionsInput = {
  sources: ContextSource[];
  filter: string;
  contentTitle: string | null;
};

/**
 * Build the set of mention options the picker should show given the
 * current sources, filter text, and whether the Talk has an attached
 * doc.
 *
 * Insertion form:
 * - `@doc` for the attached doc.
 * - `@<title_slug>` for a source when its slug is unique within the
 *   Talk's READY sources. Falls back to `@S<n>` when the slug collides
 *   with another ready source — that's the deterministic resolver form.
 *
 * Only `status === 'ready'` sources are listed; pending/failed sources
 * have no useful content to inline and would emit a placeholder rather
 * than the source body.
 */
export function buildSourceMentionOptions(
  input: BuildOptionsInput,
): SourceMentionOption[] {
  const filter = input.filter.toLowerCase().trim();
  const readySources = input.sources.filter((s) => s.status === 'ready');

  const slugCounts = new Map<string, number>();
  for (const source of readySources) {
    const slug = deriveDisplaySlug(source);
    if (slug) {
      slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
    }
  }

  const options: SourceMentionOption[] = [];

  if (input.contentTitle && matchesFilter('doc', input.contentTitle, filter)) {
    options.push({
      kind: 'doc',
      insertion: '@doc ',
      title: input.contentTitle,
    });
  }

  for (const source of readySources) {
    const slug = deriveDisplaySlug(source);
    const haystacks = [
      source.title,
      source.sourceRef,
      source.note ?? '',
      slug,
    ];
    const filterHits = haystacks.some((h) =>
      h.toLowerCase().includes(filter),
    );
    if (filter && !filterHits) continue;

    // Insert slug-form when unique; fall back to ref-form on collision.
    const useSlug =
      !!slug && (slugCounts.get(slug) ?? 0) === 1 && slug !== 'doc';
    const insertion = useSlug
      ? `@${slug} `
      : `@${source.sourceRef} `;

    options.push({
      kind: 'source',
      insertion,
      source,
    });
  }

  return options;
}

const SLUG_CHARS = /[^a-z0-9]+/g;

function deriveDisplaySlug(source: ContextSource): string {
  const fromTitle = source.title
    .toLowerCase()
    .replace(SLUG_CHARS, '-')
    .replace(/^-+|-+$/g, '');
  return fromTitle;
}

function matchesFilter(slug: string, title: string, filter: string): boolean {
  if (!filter) return true;
  return (
    slug.toLowerCase().includes(filter) ||
    title.toLowerCase().includes(filter)
  );
}

// Re-export the use-once helper so picker callers can rebuild options
// inside a useMemo without re-importing the file.
export function useSourceMentionOptions(
  input: BuildOptionsInput,
): SourceMentionOption[] {
  return useMemo(() => buildSourceMentionOptions(input), [
    input.sources,
    input.filter,
    input.contentTitle,
  ]);
}
