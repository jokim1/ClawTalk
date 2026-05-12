import type {
  BrowserResumeMetadata,
  CarriedBrowserSessionMetadata,
} from './metadata.js';

function parseObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseBrowserResume(
  metadata: Record<string, unknown>,
): BrowserResumeMetadata | null {
  const resume = parseObject(metadata.browserResume);
  if (!resume || typeof resume.kind !== 'string') {
    return null;
  }
  return {
    kind: resume.kind as BrowserResumeMetadata['kind'],
    resumedAt: typeof resume.resumedAt === 'string' ? resume.resumedAt : '',
    resumedBy: typeof resume.resumedBy === 'string' ? resume.resumedBy : null,
    sessionId: typeof resume.sessionId === 'string' ? resume.sessionId : null,
    confirmationId:
      typeof resume.confirmationId === 'string' ? resume.confirmationId : null,
    note: typeof resume.note === 'string' ? resume.note : null,
    pendingToolCall:
      resume.pendingToolCall &&
      typeof resume.pendingToolCall === 'object' &&
      !Array.isArray(resume.pendingToolCall)
        ? {
            toolName:
              typeof (resume.pendingToolCall as { toolName?: unknown })
                .toolName === 'string'
                ? (resume.pendingToolCall as { toolName: string }).toolName
                : 'browser_act',
            args:
              parseObject(
                (resume.pendingToolCall as { args?: unknown }).args,
              ) || {},
          }
        : null,
  };
}

export function parseCarriedBrowserSessions(
  metadata: Record<string, unknown>,
): CarriedBrowserSessionMetadata[] {
  if (!Array.isArray(metadata.carriedBrowserSessions)) {
    return [];
  }
  return metadata.carriedBrowserSessions
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
    )
    .map((entry) => ({
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
      siteKey: typeof entry.siteKey === 'string' ? entry.siteKey : '',
      accountLabel:
        typeof entry.accountLabel === 'string' ? entry.accountLabel : null,
      lastKnownState:
        typeof entry.lastKnownState === 'string'
          ? (entry.lastKnownState as CarriedBrowserSessionMetadata['lastKnownState'])
          : 'dead',
      blockedKind:
        typeof entry.blockedKind === 'string'
          ? (entry.blockedKind as CarriedBrowserSessionMetadata['blockedKind'])
          : null,
      lastKnownUrl:
        typeof entry.lastKnownUrl === 'string' ? entry.lastKnownUrl : '',
      lastKnownTitle:
        typeof entry.lastKnownTitle === 'string' ? entry.lastKnownTitle : '',
      lastUpdatedAt:
        typeof entry.lastUpdatedAt === 'string' ? entry.lastUpdatedAt : '',
    }))
    .filter((entry) => entry.sessionId && entry.siteKey);
}

export function buildBrowserResumeSection(
  metadata: Record<string, unknown>,
): string | null {
  const resume = parseBrowserResume(metadata);
  const carriedSessions = parseCarriedBrowserSessions(metadata);

  if (!resume && carriedSessions.length === 0) {
    return null;
  }

  const lines: string[] = [
    'This run has existing browser state from a prior blocked or promoted step.',
  ];

  if (resume) {
    lines.push(`Resume kind: ${resume.kind}`);
    if (resume.sessionId) {
      lines.push(`Resume session: ${resume.sessionId}`);
    }
    if (resume.note) {
      lines.push(`Resume note: ${resume.note}`);
    }
    if (resume.pendingToolCall) {
      lines.push(
        `Pending browser tool: ${resume.pendingToolCall.toolName} ${JSON.stringify(resume.pendingToolCall.args)}`,
      );
      if (resume.kind === 'confirmation_approved') {
        lines.push(
          'The user approved the previously blocked browser action. If you still need to perform it, you may repeat it with confirm=true.',
        );
      }
    }
  }

  if (carriedSessions.length > 0) {
    lines.push('Carried browser sessions:');
    for (const session of carriedSessions) {
      lines.push(
        `- ${session.sessionId} (${session.siteKey}${session.accountLabel ? `/${session.accountLabel}` : ''}) state=${session.lastKnownState} blocked=${session.blockedKind || 'none'} url=${session.lastKnownUrl}`,
      );
    }
  }

  return lines.join('\n');
}
