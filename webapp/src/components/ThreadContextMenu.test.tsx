import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThreadContextMenu } from './ThreadContextMenu';

function mockViewport(width: number, height: number): () => void {
  const previousWidth = window.innerWidth;
  const previousHeight = window.innerHeight;

  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height,
  });

  return () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: previousWidth,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: previousHeight,
    });
  };
}

function mockMenuSize(width: number, height: number): () => void {
  const widthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetWidth',
  );
  const heightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight',
  );

  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      if ((this as HTMLElement).classList.contains('thread-context-menu')) {
        return width;
      }
      return widthDescriptor?.get
        ? widthDescriptor.get.call(this)
        : (widthDescriptor?.value as number | undefined) || 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      if ((this as HTMLElement).classList.contains('thread-context-menu')) {
        return height;
      }
      return heightDescriptor?.get
        ? heightDescriptor.get.call(this)
        : (heightDescriptor?.value as number | undefined) || 0;
    },
  });

  return () => {
    if (widthDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDescriptor);
    }
    if (heightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        'offsetHeight',
        heightDescriptor,
      );
    }
  };
}

describe('ThreadContextMenu', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('measures the rendered menu and recomputes its position on resize', async () => {
    const restoreViewport = mockViewport(320, 280);
    const restoreMenuSize = mockMenuSize(180, 140);

    try {
      render(
        <ThreadContextMenu
          x={280}
          y={240}
          isPinned={false}
          onRename={vi.fn()}
          onTogglePin={vi.fn()}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />,
      );

      const menu = screen.getByRole('menu', { name: 'Thread options' });
      expect(menu.parentElement).toBe(document.body);

      await waitFor(() => {
        expect(menu.style.left).toBe('132px');
        expect(menu.style.top).toBe('132px');
      });

      act(() => {
        Object.defineProperty(window, 'innerWidth', {
          configurable: true,
          writable: true,
          value: 520,
        });
        Object.defineProperty(window, 'innerHeight', {
          configurable: true,
          writable: true,
          value: 520,
        });
        window.dispatchEvent(new Event('resize'));
      });

      await waitFor(() => {
        expect(menu.style.left).toBe('280px');
        expect(menu.style.top).toBe('240px');
      });
    } finally {
      restoreMenuSize();
      restoreViewport();
    }
  });

  it('does not close in response to the opening contextmenu event', async () => {
    const onClose = vi.fn();

    render(
      <ThreadContextMenu
        x={40}
        y={48}
        isPinned={false}
        onRename={vi.fn()}
        onTogglePin={vi.fn()}
        onDelete={vi.fn()}
        onClose={onClose}
      />,
    );

    const menu = screen.getByRole('menu', { name: 'Thread options' });
    expect(menu).toBeTruthy();

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 48 }),
      );
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('menu', { name: 'Thread options' })).toBeTruthy();
  });
});
