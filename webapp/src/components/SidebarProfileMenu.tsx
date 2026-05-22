import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { SessionUser } from '../lib/api';

type Props = {
  user: SessionUser;
  onSignOut: () => void;
  signOutBusy: boolean;
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #6366f1, #8b5cf6)',
  'linear-gradient(135deg, #3b82f6, #06b6d4)',
  'linear-gradient(135deg, #10b981, #34d399)',
  'linear-gradient(135deg, #f59e0b, #f97316)',
  'linear-gradient(135deg, #ef4444, #f43f5e)',
  'linear-gradient(135deg, #8b5cf6, #ec4899)',
  'linear-gradient(135deg, #14b8a6, #3b82f6)',
  'linear-gradient(135deg, #f97316, #ef4444)',
];

function getAvatarGradient(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

type MenuItem = {
  label: string;
  to: string;
};

const MENU_ITEMS: MenuItem[] = [
  { label: 'Profile', to: '/app/settings?tab=profile' },
  { label: 'API Keys', to: '/app/settings?tab=api-keys' },
  { label: 'AI Agents', to: '/app/settings?tab=agents' },
  { label: 'Tools', to: '/app/settings?tab=tools' },
  { label: 'Connectors', to: '/app/connectors' },
];

export function SidebarProfileMenu({
  user,
  onSignOut,
  signOutBusy,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  const initials = getInitials(user.displayName);
  const gradient = getAvatarGradient(user.id);

  return (
    <div className="clawtalk-sidebar-profile" ref={containerRef}>
      <div className="clawtalk-sidebar-profile-row">
        <span
          className="clawtalk-sidebar-profile-avatar"
          style={{ background: gradient }}
          aria-hidden="true"
        >
          {initials}
        </span>
        <div className="clawtalk-sidebar-profile-meta">
          <strong className="clawtalk-sidebar-profile-name">
            {user.displayName}
          </strong>
          <span className="clawtalk-sidebar-profile-email">{user.email}</span>
        </div>
        <button
          type="button"
          className="clawtalk-sidebar-profile-trigger"
          aria-label="Open profile menu"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden="true">⚙</span>
        </button>
      </div>

      {open ? (
        <div className="clawtalk-sidebar-profile-menu" role="menu">
          <div className="clawtalk-sidebar-profile-menu-header">
            <span
              className="clawtalk-sidebar-profile-avatar clawtalk-sidebar-profile-avatar-md"
              style={{ background: gradient }}
              aria-hidden="true"
            >
              {initials}
            </span>
            <div className="clawtalk-sidebar-profile-meta">
              <strong className="clawtalk-sidebar-profile-name">
                {user.displayName}
              </strong>
              <span className="clawtalk-sidebar-profile-email">
                {user.email}
              </span>
            </div>
          </div>
          <div className="clawtalk-sidebar-profile-menu-divider" />
          {MENU_ITEMS.map((item) => (
            <button
              key={item.to}
              type="button"
              className="clawtalk-sidebar-profile-menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate(item.to);
              }}
            >
              {item.label}
            </button>
          ))}
          <div className="clawtalk-sidebar-profile-menu-divider" />
          <button
            type="button"
            className="clawtalk-sidebar-profile-menu-item clawtalk-sidebar-profile-menu-item-danger"
            role="menuitem"
            disabled={signOutBusy}
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            {signOutBusy ? 'Signing out…' : 'Log out'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
