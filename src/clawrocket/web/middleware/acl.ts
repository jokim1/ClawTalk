import { canUserAccessTalk, canUserEditTalk } from '../../db/index.js';
import { UserRole } from '../../types.js';

export function canAccessTalk(talkId: string, userId: string): boolean {
  return canUserAccessTalk(talkId, userId);
}

export function canEditTalk(
  talkId: string,
  userId: string,
  role: UserRole,
): boolean {
  if (role === 'owner' || role === 'admin') return true;
  return canUserEditTalk(talkId, userId);
}
