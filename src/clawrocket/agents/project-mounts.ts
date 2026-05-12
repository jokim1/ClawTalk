import { validateMount } from '../../mount-security.js';

export class ProjectMountValidationError extends Error {
  constructor(
    message: string,
    public readonly code = 'PROJECT_MOUNT_INVALID',
  ) {
    super(message);
    this.name = 'ProjectMountValidationError';
  }
}

export function resolveValidatedProjectMountPath(
  rawPath: string | null | undefined,
  isMain: boolean,
): string | null {
  const normalized = rawPath?.trim() || null;
  if (!normalized) {
    return null;
  }

  const result = validateMount(
    {
      hostPath: normalized,
      readonly: true,
    },
    isMain,
  );
  if (!result.allowed || !result.realHostPath) {
    throw new ProjectMountValidationError(
      result.reason || 'Configured project mount is not allowed.',
    );
  }

  return result.realHostPath;
}
