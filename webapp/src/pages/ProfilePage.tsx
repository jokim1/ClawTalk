import { useState } from 'react';
import {
  ApiError,
  SessionUser,
  UnauthorizedError,
  updateSessionMe,
} from '../lib/api';

type Props = {
  user: SessionUser;
  onUnauthorized: () => void;
  onUserUpdated: (user: SessionUser) => void;
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

function formatRole(role: string): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'member':
      return 'Member';
    default:
      return role;
  }
}

function roleDescription(role: string): string {
  switch (role) {
    case 'owner':
      return 'Full access to all settings and billing';
    case 'admin':
      return 'Can manage agents, connectors, and settings';
    case 'member':
      return 'Can create and participate in talks';
    default:
      return '';
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return iso;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function ProfilePage({ user, onUnauthorized, onUserUpdated }: Props) {
  const [nameDraft, setNameDraft] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const hasNameChange =
    nameDraft.trim() !== '' && nameDraft.trim() !== user.displayName;

  const handleSave = async (): Promise<void> => {
    if (!hasNameChange) return;

    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const updatedUser = await updateSessionMe({
        displayName: nameDraft.trim(),
      });
      onUserUpdated(updatedUser);
      setNotice('Profile updated.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to update profile.',
      );
    } finally {
      setSaving(false);
    }
  };

  const initials = getInitials(user.displayName);
  const gradient = getAvatarGradient(user.id);

  return (
    <section className="page-shell profile-shell">
      <header className="page-header">
        <div>
          <h1>My Profile</h1>
          <p>Manage your personal information</p>
        </div>
      </header>

      {error ? (
        <div className="settings-banner settings-banner-error">{error}</div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success">{notice}</div>
      ) : null}

      <section className="settings-card">
        <h2>Profile Picture</h2>
        <div className="profile-avatar-section">
          <span
            className="profile-avatar-lg"
            style={{ background: gradient }}
          >
            {initials}
          </span>
        </div>
      </section>

      <section className="settings-card">
        <h2>Personal Information</h2>
        <label className="profile-field">
          <span className="profile-field-label">Full name</span>
          <input
            type="text"
            className="profile-field-input"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
          />
        </label>
        <label className="profile-field">
          <span className="profile-field-label">Email address</span>
          <input
            type="text"
            className="profile-field-input profile-field-locked"
            value={user.email}
            readOnly
          />
          <span className="profile-field-hint">
            This is the email used for signing in and notifications.
          </span>
        </label>
        <div className="profile-actions">
          <button
            type="button"
            className="primary-btn"
            disabled={!hasNameChange || saving}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h2>Role &amp; Permissions</h2>
        <div className="profile-role-row">
          <strong>{formatRole(user.role)}</strong>
          <span className={`profile-role-badge profile-role-badge-${user.role}`}>
            {user.role}
          </span>
        </div>
        <p className="settings-copy">{roleDescription(user.role)}</p>
      </section>

      <section className="settings-card">
        <h2>Account</h2>
        <div className="profile-meta-grid">
          <div>
            <span className="settings-label">User ID</span>
            <strong className="profile-meta-value">{user.id.slice(0, 12)}…</strong>
          </div>
          <div>
            <span className="settings-label">Member since</span>
            <strong>{formatDate(user.createdAt)}</strong>
          </div>
        </div>
      </section>
    </section>
  );
}
