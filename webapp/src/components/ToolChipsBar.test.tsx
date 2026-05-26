import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../lib/api';
import { ToolChipsBar } from './ToolChipsBar';

const TALK_ID = 'talk-abc';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ToolChipsBar', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getTalkTools').mockResolvedValue({
      talkId: TALK_ID,
      active: { web: true, gmail_read: false },
      available: ['web', 'gmail_read'],
    });
  });

  it('renders one chip per available family in TOOL_FAMILY_ORDER', async () => {
    vi.spyOn(api, 'getTalkTools').mockResolvedValueOnce({
      talkId: TALK_ID,
      active: { web: true, google_read: false },
      // Server may return out-of-order — chip render order is locked to
      // TOOL_FAMILY_ORDER (Heavy → Web → Connectors → Google → Messaging).
      available: ['google_read', 'web'],
    });
    render(<ToolChipsBar talkId={TALK_ID} />);
    const web = await screen.findByRole('button', { name: 'Web' });
    const googleRead = screen.getByRole('button', { name: 'Google Read' });
    // Web comes BEFORE Google Read per TOOL_FAMILY_ORDER.
    expect(web.compareDocumentPosition(googleRead)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('renders nothing when available is empty', async () => {
    vi.spyOn(api, 'getTalkTools').mockResolvedValueOnce({
      talkId: TALK_ID,
      active: {},
      available: [],
    });
    const { container } = render(<ToolChipsBar talkId={TALK_ID} />);
    // The initial loading state returns null. After the fetch resolves with
    // empty available, still null. The container should be empty.
    await waitFor(() => {
      expect(api.getTalkTools).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it('shows web chip as on (aria-pressed=true) when active.web is true', async () => {
    render(<ToolChipsBar talkId={TALK_ID} />);
    const web = await screen.findByRole('button', { name: 'Web' });
    expect(web).toHaveAttribute('aria-pressed', 'true');
    const gmail = screen.getByRole('button', { name: 'Gmail Read' });
    expect(gmail).toHaveAttribute('aria-pressed', 'false');
  });

  it('click flips chip state optimistically and PATCHes the server', async () => {
    const update = vi
      .spyOn(api, 'updateTalkTool')
      .mockResolvedValueOnce({
        talkId: TALK_ID,
        active: { web: false, gmail_read: false },
        available: ['web', 'gmail_read'],
      });

    render(<ToolChipsBar talkId={TALK_ID} />);
    const web = await screen.findByRole('button', { name: 'Web' });
    expect(web).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(web);

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        talkId: TALK_ID,
        family: 'web',
        enabled: false,
      });
    });
    expect(web).toHaveAttribute('aria-pressed', 'false');
  });

  it('reverts state + surfaces error when PATCH fails', async () => {
    vi.spyOn(api, 'updateTalkTool').mockRejectedValueOnce(
      new Error('network down'),
    );
    const onError = vi.fn();

    render(<ToolChipsBar talkId={TALK_ID} onError={onError} />);
    const web = await screen.findByRole('button', { name: 'Web' });

    await userEvent.click(web);

    // The optimistic update flips it off briefly, then reverts.
    await waitFor(() => {
      expect(web).toHaveAttribute('aria-pressed', 'true');
    });
    expect(onError).toHaveBeenCalledWith('network down');
  });

  it('refreshKey change re-fetches the active set (talk_tools_changed external event)', async () => {
    const get = vi
      .spyOn(api, 'getTalkTools')
      .mockResolvedValueOnce({
        talkId: TALK_ID,
        active: { web: true },
        available: ['web'],
      })
      .mockResolvedValueOnce({
        talkId: TALK_ID,
        active: { web: false },
        available: ['web'],
      });

    const { rerender } = render(
      <ToolChipsBar talkId={TALK_ID} refreshKey={0} />,
    );
    await screen.findByRole('button', { name: 'Web' });
    expect(
      screen.getByRole('button', { name: 'Web' }),
    ).toHaveAttribute('aria-pressed', 'true');

    rerender(<ToolChipsBar talkId={TALK_ID} refreshKey={1} />);
    await waitFor(() => {
      expect(get).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Web' }),
      ).toHaveAttribute('aria-pressed', 'false');
    });
  });
});
