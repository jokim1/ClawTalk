import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SessionUser } from '../lib/api';

type Props = {
  user: SessionUser;
  canManageSettings: boolean;
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

export function AvatarMenu({
  user,
  canManageSettings,
  onSignOut,
  signOutBusy,
}: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const initials = getInitials(user.displayName);
  const gradient = getAvatarGradient(user.id);

  return (
    <div className="app-avatar-menu" ref={menuRef}>
      <button
        type="button"
        className="app-avatar-btn"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={user.displayName}
        title={user.displayName}
      >
        <span
          className="app-avatar-circle"
          style={{ background: gradient }}
        >
          {initials}
        </span>
      </button>

      {open ? (
        <div className="app-avatar-dropdown" role="menu">
          <div className="app-avatar-dropdown-header">
            <span
              className="app-avatar-circle app-avatar-circle-sm"
              style={{ background: gradient }}
            >
              {initials}
            </span>
            <div className="app-avatar-dropdown-user">
              <strong>{user.displayName}</strong>
              <span>{user.email}</span>
            </div>
          </div>
          <div className="app-avatar-dropdown-divider" />
          <button
            type="button"
            className="app-avatar-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              navigate('/app/profile');
            }}
          >
            Profile
          </button>
          {canManageSettings ? (
            <button
              type="button"
              className="app-avatar-menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate('/app/settings');
              }}
            >
              Settings
            </button>
          ) : null}
          <div className="app-avatar-dropdown-divider" />
          <button
            type="button"
            className="app-avatar-menu-item app-avatar-menu-item-danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            disabled={signOutBusy}
          >
            {signOutBusy ? 'Signing out…' : 'Log Out'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
