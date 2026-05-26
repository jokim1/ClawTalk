import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocPaneEdgeTab } from './DocPaneEdgeTab';

afterEach(() => cleanup());

describe('DocPaneEdgeTab', () => {
  it('renders the title text and a format pill', () => {
    render(
      <DocPaneEdgeTab
        docTitle="Plan: Q3"
        format="html"
        onClick={() => undefined}
      />,
    );
    expect(screen.getByText('Plan: Q3')).toBeInTheDocument();
    expect(screen.getByText('HTML')).toBeInTheDocument();
  });

  it('uses a descriptive aria-label including the full title', () => {
    render(
      <DocPaneEdgeTab
        docTitle="Some really really long doc title that may visually truncate"
        format="markdown"
        onClick={() => undefined}
      />,
    );
    const btn = screen.getByRole('button', {
      name: /Show Some really really long doc title that may visually truncate document/,
    });
    expect(btn).toBeInTheDocument();
  });

  it('fires onClick when activated', () => {
    const onClick = vi.fn();
    render(
      <DocPaneEdgeTab docTitle="Plan" format="markdown" onClick={onClick} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
