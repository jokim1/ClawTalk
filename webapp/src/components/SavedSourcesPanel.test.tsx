import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SavedSourcesPanel } from './SavedSourcesPanel';
import type { ContextSource } from '../lib/api';

vi.mock('../lib/api', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    patchTalkContextSource: vi.fn(),
  };
});

import { patchTalkContextSource } from '../lib/api';

const patchMock = patchTalkContextSource as unknown as ReturnType<typeof vi.fn>;

function makeSource(input: Partial<ContextSource> & { id: string }): ContextSource {
  return {
    id: input.id,
    sourceRef: input.sourceRef ?? 'S1',
    sourceType: input.sourceType ?? 'text',
    title: input.title ?? 'Test source',
    note: input.note ?? null,
    sourceUrl: input.sourceUrl ?? null,
    fileName: input.fileName ?? null,
    fileSize: input.fileSize ?? null,
    status: input.status ?? 'ready',
    extractedTextLength: input.extractedTextLength ?? 120,
    extractedAt: input.extractedAt ?? '2026-05-26T00:00:00Z',
    isTruncated: input.isTruncated ?? false,
    extractionError: input.extractionError ?? null,
    mimeType: input.mimeType ?? null,
    lastFetchedAt: input.lastFetchedAt ?? null,
    fetchStrategy: input.fetchStrategy ?? null,
    sortOrder: input.sortOrder ?? 0,
    createdAt: '2026-05-26T00:00:00Z',
    updatedAt: '2026-05-26T00:00:00Z',
  };
}

afterEach(() => {
  cleanup();
  patchMock.mockReset();
});

describe('SavedSourcesPanel', () => {
  it('renders title, ref, and status badge for each source', () => {
    const source = makeSource({
      id: 's1',
      sourceRef: 'S1',
      title: 'Investor memo',
      note: 'routing hint',
      sourceType: 'text',
    });
    render(
      <SavedSourcesPanel
        talkId="t1"
        sources={[source]}
        setSources={() => undefined}
        canEdit
        onUnauthorized={() => undefined}
      />,
    );
    expect(screen.getByText('S1')).toBeInTheDocument();
    expect(screen.getByText('Investor memo')).toBeInTheDocument();
    expect(screen.getByText('routing hint')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText(/120 chars extracted/)).toBeInTheDocument();
  });

  it('shows the routing-hint placeholder when note is empty', () => {
    const source = makeSource({ id: 's1', note: null });
    render(
      <SavedSourcesPanel
        talkId="t1"
        sources={[source]}
        setSources={() => undefined}
        canEdit
        onUnauthorized={() => undefined}
      />,
    );
    expect(
      screen.getByText(
        'Add a one-line routing hint (when to use this source)',
      ),
    ).toBeInTheDocument();
  });

  it('inline-edits the title via PATCH and updates the source list on save', async () => {
    const source = makeSource({
      id: 's1',
      sourceRef: 'S1',
      title: 'Old title',
    });
    const updated = makeSource({ id: 's1', sourceRef: 'S1', title: 'New title' });
    patchMock.mockResolvedValueOnce(updated);

    const setSources = vi.fn();
    render(
      <SavedSourcesPanel
        talkId="t1"
        sources={[source]}
        setSources={setSources}
        canEdit
        onUnauthorized={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Old title'));
    const input = screen.getByLabelText('Edit source title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith({
        talkId: 't1',
        sourceId: 's1',
        title: 'New title',
      });
    });
    expect(setSources).toHaveBeenCalled();
  });

  it('inline-edits the note via PATCH (with null when cleared)', async () => {
    const source = makeSource({
      id: 's1',
      sourceRef: 'S1',
      title: 'My source',
      note: 'old note',
    });
    const updated = makeSource({
      id: 's1',
      sourceRef: 'S1',
      title: 'My source',
      note: null,
    });
    patchMock.mockResolvedValueOnce(updated);

    render(
      <SavedSourcesPanel
        talkId="t1"
        sources={[source]}
        setSources={() => undefined}
        canEdit
        onUnauthorized={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('old note'));
    const input = screen.getByLabelText('Edit source note') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith({
        talkId: 't1',
        sourceId: 's1',
        note: null,
      });
    });
  });

  it('cancels edit on Escape without calling PATCH', async () => {
    const source = makeSource({
      id: 's1',
      sourceRef: 'S1',
      title: 'Keep me',
    });
    render(
      <SavedSourcesPanel
        talkId="t1"
        sources={[source]}
        setSources={() => undefined}
        canEdit
        onUnauthorized={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText('Keep me'));
    const input = screen.getByLabelText('Edit source title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Whatever' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('renders the @-ref guidance in the panel header', () => {
    render(
      <SavedSourcesPanel
        talkId="t1"
        sources={[]}
        setSources={() => undefined}
        canEdit
        onUnauthorized={() => undefined}
      />,
    );
    // The panel header explains @-ref usage to users.
    expect(screen.getByText(/@S1/)).toBeInTheDocument();
    expect(screen.getByText(/@title-slug/)).toBeInTheDocument();
  });
});
