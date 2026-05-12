import path from 'path';

import { DATA_DIR } from './config.js';
import type { RegisteredGroup } from './types.js';

export const WEB_EXECUTOR_FOLDER = 'web-executor';
export const WEB_EXECUTOR_JID = 'internal:web-executor';
export const WEB_EXECUTOR_NAME = 'Web Executor';

export interface LegacyGroupExecutionTarget {
  kind: 'legacy_group';
  jid: string;
  group: RegisteredGroup;
}

export interface WebRuntimeExecutionTarget {
  kind: 'web_runtime';
  jid: typeof WEB_EXECUTOR_JID;
  folder: typeof WEB_EXECUTOR_FOLDER;
  name: typeof WEB_EXECUTOR_NAME;
  logsDir: string;
}

export type ContainerExecutionTarget =
  | LegacyGroupExecutionTarget
  | WebRuntimeExecutionTarget;

export function createLegacyGroupExecutionTarget(
  group: RegisteredGroup,
  jid: string,
): LegacyGroupExecutionTarget {
  return {
    kind: 'legacy_group',
    jid,
    group,
  };
}

export function createWebRuntimeExecutionTarget(): WebRuntimeExecutionTarget {
  return {
    kind: 'web_runtime',
    jid: WEB_EXECUTOR_JID,
    folder: WEB_EXECUTOR_FOLDER,
    name: WEB_EXECUTOR_NAME,
    logsDir: path.join(DATA_DIR, 'container-runs', WEB_EXECUTOR_FOLDER, 'logs'),
  };
}

export function getExecutionTargetFolder(
  target: ContainerExecutionTarget,
): string {
  return target.kind === 'legacy_group' ? target.group.folder : target.folder;
}

export function getExecutionTargetName(
  target: ContainerExecutionTarget,
): string {
  return target.kind === 'legacy_group' ? target.group.name : target.name;
}
