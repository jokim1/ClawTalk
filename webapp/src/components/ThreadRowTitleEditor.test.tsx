import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThreadRowTitleEditor } from './ThreadRowTitleEditor';

describe('ThreadRowTitleEditor', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not update state after unmount when a save resolves later', async () => {
    let resolveSave!: () => void;
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const onSave = vi.fn(() => savePromise);
    const onCancel = vi.fn();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const { unmount } = render(
      <ThreadRowTitleEditor
        title="Old title"
        isEditing={true}
        onSave={onSave}
        onCancel={onCancel}
        staticClassName="thread-title"
        inputClassName="thread-input"
        errorClassName="thread-error"
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Rename thread' });
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.blur(input);

    expect(onSave).toHaveBeenCalledWith('New title');

    unmount();

    await act(async () => {
      resolveSave();
      await savePromise;
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
