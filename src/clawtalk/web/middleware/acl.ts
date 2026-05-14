import { canUserAccessTalk, canUserEditTalk } from '../../db/index.js';

export async function canAccessTalk(talkId: string): Promise<boolean> {
  return canUserAccessTalk(talkId);
}

export async function canEditTalk(talkId: string): Promise<boolean> {
  return canUserEditTalk(talkId);
}
