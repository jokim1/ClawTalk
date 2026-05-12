import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type ThreadContextMenuProps = {
  x: number;
  y: number;
  isPinned: boolean;
  canDelete?: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onClose: () => void;
};

export function ThreadContextMenu({
  x,
  y,
  isPinned,
  canDelete = true,
  onRename,
  onTogglePin,
  onDelete,
  onClose,
}: ThreadContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(() => ({
    top: Math.max(8, y),
    left: Math.max(8, x),
  }));

  useLayoutEffect(() => {
    function updatePosition(): void {
      const menu = menuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const width = rect.width || menu.offsetWidth || 176;
      const height = rect.height || menu.offsetHeight || (canDelete ? 136 : 96);
      setPosition({
        top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
        left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      });
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
    };
  }, [canDelete, x, y]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent): void {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    function handleScroll(): void {
      onClose();
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [onClose]);

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Thread options"
      className="thread-context-menu"
      style={position}
    >
      <button
        type="button"
        role="menuitem"
        className="thread-context-menu-item"
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        className="thread-context-menu-item"
        onClick={() => {
          onClose();
          onTogglePin();
        }}
      >
        {isPinned ? 'Unpin' : 'Pin'}
      </button>
      <button
        type="button"
        role="menuitem"
        className="thread-context-menu-item thread-context-menu-item-danger"
        disabled={!canDelete}
        onClick={() => {
          onClose();
          if (canDelete) {
            onDelete();
          }
        }}
      >
        Delete thread
      </button>
    </div>
  );

  if (typeof document === 'undefined') {
    return menu;
  }

  return createPortal(menu, document.body);
}
