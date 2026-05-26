import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocPaneHeader } from './DocPaneHeader';

afterEach(() => cleanup());

const NOOP_TITLE_SAVE = async () => undefined;

describe('DocPaneHeader', () => {
  describe('static slots', () => {
    it('renders the title, format pill, and save status', () => {
      render(
        <DocPaneHeader
          title="Weekly notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="markdown"
          saveStatus="saved"
        />,
      );
      expect(
        screen.getByRole('button', { name: 'Rename document' }),
      ).toBeInTheDocument();
      expect(screen.getByText('MD')).toBeInTheDocument();
      expect(screen.getByText('Saved')).toBeInTheDocument();
    });

    it('shows the loading placeholder when loading=true', () => {
      render(
        <DocPaneHeader
          title="Weekly notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="markdown"
          saveStatus="idle"
          loading
        />,
      );
      expect(screen.getByText('Loading…')).toBeInTheDocument();
    });

    it('renders the Copy/Export slot when provided', () => {
      render(
        <DocPaneHeader
          title="Weekly notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="markdown"
          saveStatus="idle"
          copyExportSlot={<button>Mock Copy</button>}
        />,
      );
      expect(
        screen.getByRole('button', { name: 'Mock Copy' }),
      ).toBeInTheDocument();
    });
  });

  describe('hide-pane button', () => {
    it('fires onHidePane when clicked', () => {
      const onHidePane = vi.fn();
      render(
        <DocPaneHeader
          title="Notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="markdown"
          saveStatus="idle"
          onHidePane={onHidePane}
        />,
      );
      const btn = screen.getByRole('button', { name: 'Hide document pane' });
      fireEvent.click(btn);
      expect(onHidePane).toHaveBeenCalledTimes(1);
    });

    it('is not rendered when onHidePane is absent', () => {
      render(
        <DocPaneHeader
          title="Notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="markdown"
          saveStatus="idle"
        />,
      );
      expect(
        screen.queryByRole('button', { name: 'Hide document pane' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('Preview/Source toggle (HTML only)', () => {
    it('is omitted for markdown docs', () => {
      render(
        <DocPaneHeader
          title="Notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="markdown"
          saveStatus="idle"
          mode="preview"
          onModeChange={() => undefined}
        />,
      );
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    });

    it('renders an ARIA tablist with two tabs for HTML docs', () => {
      render(
        <DocPaneHeader
          title="Notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="html"
          saveStatus="idle"
          mode="preview"
          onModeChange={() => undefined}
        />,
      );
      const tablist = screen.getByRole('tablist', { name: 'Document view' });
      expect(tablist).toBeInTheDocument();
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    });

    it('arrow key navigation flips selection via onModeChange', () => {
      const onModeChange = vi.fn();
      render(
        <DocPaneHeader
          title="Notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="html"
          saveStatus="idle"
          mode="preview"
          onModeChange={onModeChange}
        />,
      );
      const tablist = screen.getByRole('tablist', { name: 'Document view' });
      fireEvent.keyDown(tablist, { key: 'ArrowRight' });
      expect(onModeChange).toHaveBeenCalledWith('source');
    });

    it('clicking a tab fires onModeChange', () => {
      const onModeChange = vi.fn();
      render(
        <DocPaneHeader
          title="Notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="html"
          saveStatus="idle"
          mode="preview"
          onModeChange={onModeChange}
        />,
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
      expect(onModeChange).toHaveBeenCalledWith('source');
    });
  });

  describe('sanitize warning', () => {
    it('does not render the banner when sanitizeWarning is null', () => {
      render(
        <DocPaneHeader
          title="Notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="html"
          saveStatus="idle"
          mode="preview"
          onModeChange={() => undefined}
          sanitizeWarning={null}
        />,
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('renders the banner with formatted copy when stripped tags arrive', () => {
      render(
        <DocPaneHeader
          title="Notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="html"
          saveStatus="idle"
          mode="preview"
          onModeChange={() => undefined}
          sanitizeWarning={{
            stripped: [
              { tag: 'script', count: 1 },
              { tag: 'iframe', count: 1 },
            ],
          }}
        />,
      );
      expect(
        screen.getByText(/Stripped 2 tags: <script>, <iframe>/),
      ).toBeInTheDocument();
    });

    it('Dismiss button calls onSanitizeWarningDismiss', () => {
      const onDismiss = vi.fn();
      render(
        <DocPaneHeader
          title="Notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="html"
          saveStatus="idle"
          mode="preview"
          onModeChange={() => undefined}
          sanitizeWarning={{ stripped: [{ tag: 'script', count: 1 }] }}
          onSanitizeWarningDismiss={onDismiss}
        />,
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Dismiss sanitize warning' }),
      );
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('Why? button fires onSanitizeWhy when provided', () => {
      const onWhy = vi.fn();
      render(
        <DocPaneHeader
          title="Notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="html"
          saveStatus="idle"
          mode="preview"
          onModeChange={() => undefined}
          sanitizeWarning={{ stripped: [{ tag: 'script', count: 1 }] }}
          onSanitizeWhy={onWhy}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Why?' }));
      expect(onWhy).toHaveBeenCalledTimes(1);
    });

    it('Why? is hidden when onSanitizeWhy is absent', () => {
      render(
        <DocPaneHeader
          title="Notes"
          onTitleSave={NOOP_TITLE_SAVE}
          format="html"
          saveStatus="idle"
          mode="preview"
          onModeChange={() => undefined}
          sanitizeWarning={{ stripped: [{ tag: 'script', count: 1 }] }}
        />,
      );
      expect(
        screen.queryByRole('button', { name: 'Why?' }),
      ).not.toBeInTheDocument();
    });
  });
});
