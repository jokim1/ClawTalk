import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../lib/api';
import * as picker from '../lib/googlePicker';
import { TalkToolsPanel } from './TalkToolsPanel';

const TALK_ID = 'talk-abc';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TalkToolsPanel', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getTalkResources').mockResolvedValue({
      talkId: TALK_ID,
      bindings: [],
    });
  });

  it('shows an empty-state hint when there are no bindings', async () => {
    render(<TalkToolsPanel talkId={TALK_ID} />);
    await waitFor(() => {
      expect(
        screen.getByText(/No Drive resources bound yet/i),
      ).toBeInTheDocument();
    });
  });

  it('renders existing bindings with kind label and Remove button', async () => {
    vi.spyOn(api, 'getTalkResources').mockResolvedValueOnce({
      talkId: TALK_ID,
      bindings: [
        {
          id: 'b1',
          kind: 'google_drive_file',
          externalId: 'doc-1',
          displayName: 'Spec Doc',
          metadata: { url: 'https://docs.google.com/document/d/doc-1/edit' },
          createdAt: '2026-05-22T00:00:00Z',
          createdBy: 'u1',
        },
        {
          id: 'b2',
          kind: 'google_drive_folder',
          externalId: 'folder-1',
          displayName: 'Project Folder',
          metadata: null,
          createdAt: '2026-05-22T00:00:00Z',
          createdBy: 'u1',
        },
      ],
    });
    render(<TalkToolsPanel talkId={TALK_ID} />);
    expect(await screen.findByText('Spec Doc')).toBeInTheDocument();
    expect(screen.getByText('Project Folder')).toBeInTheDocument();
    expect(screen.getByText('File')).toBeInTheDocument();
    expect(screen.getByText('Folder')).toBeInTheDocument();
    // The file binding has a URL → "Open in Drive" link.
    const openLink = screen.getByRole('link', { name: 'Open in Drive' });
    expect(openLink).toHaveAttribute(
      'href',
      'https://docs.google.com/document/d/doc-1/edit',
    );
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
  });

  it('removes a binding when Remove is clicked', async () => {
    vi.spyOn(api, 'getTalkResources').mockResolvedValueOnce({
      talkId: TALK_ID,
      bindings: [
        {
          id: 'b1',
          kind: 'google_drive_file',
          externalId: 'doc-1',
          displayName: 'Removable Doc',
          metadata: null,
          createdAt: '2026-05-22T00:00:00Z',
          createdBy: 'u1',
        },
      ],
    });
    const deleteSpy = vi
      .spyOn(api, 'deleteTalkResource')
      .mockResolvedValueOnce(undefined);

    const user = userEvent.setup();
    render(<TalkToolsPanel talkId={TALK_ID} />);
    await screen.findByText('Removable Doc');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(deleteSpy).toHaveBeenCalledWith({ talkId: TALK_ID, resourceId: 'b1' });
    await waitFor(() => {
      expect(screen.queryByText('Removable Doc')).not.toBeInTheDocument();
    });
  });

  it('launches the picker, creates the bindings, then reloads', async () => {
    // Initial load: empty. Reload after create: returns the new doc.
    vi.spyOn(api, 'getTalkResources')
      .mockResolvedValueOnce({ talkId: TALK_ID, bindings: [] })
      .mockResolvedValueOnce({
        talkId: TALK_ID,
        bindings: [
          {
            id: 'b-new',
            kind: 'google_drive_file',
            externalId: 'doc-picked',
            displayName: 'Picked Doc',
            metadata: null,
            createdAt: '2026-05-22T00:00:00Z',
            createdBy: 'u1',
          },
        ],
      });
    vi.spyOn(api, 'getGooglePickerSession').mockResolvedValueOnce({
      oauthToken: 'token',
      developerKey: 'devkey',
      appId: 'appid',
    });
    vi.spyOn(picker, 'openGoogleDrivePicker').mockResolvedValueOnce([
      {
        externalId: 'doc-picked',
        displayName: 'Picked Doc',
        kind: 'google_drive_file',
        metadata: { mimeType: null, url: null },
      },
    ]);
    const createSpy = vi
      .spyOn(api, 'createTalkGoogleDriveResource')
      .mockResolvedValueOnce({
        id: 'b-new',
        kind: 'google_drive_file',
        externalId: 'doc-picked',
        displayName: 'Picked Doc',
        metadata: null,
        createdAt: '2026-05-22T00:00:00Z',
        createdBy: 'u1',
      });

    const user = userEvent.setup();
    render(<TalkToolsPanel talkId={TALK_ID} />);
    await screen.findByText(/No Drive resources bound yet/i);
    await user.click(
      screen.getByRole('button', { name: /Add file from Drive/i }),
    );
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith({
        talkId: TALK_ID,
        kind: 'google_drive_file',
        externalId: 'doc-picked',
        displayName: 'Picked Doc',
        metadata: { mimeType: null, url: null },
      });
    });
    expect(await screen.findByText('Picked Doc')).toBeInTheDocument();
  });

  it('surfaces API errors inline without crashing', async () => {
    vi.spyOn(api, 'getTalkResources').mockRejectedValueOnce(
      new Error('Boom: 500'),
    );
    render(<TalkToolsPanel talkId={TALK_ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom: 500');
  });
});
