import type {
  ChannelHealthStatus,
  ChannelResponseMode,
} from '../db/channel-accessors.js';

export type DiagnosisStatus =
  | 'ok'
  | 'warning'
  | 'error'
  | 'quarantined'
  | 'paused';

export type DiagnosisActionType = 'retry' | 'unquarantine' | 'test' | 'dismiss';

export interface BindingDiagnosis {
  status: DiagnosisStatus;
  headline: string;
  detail: string | null;
  action: { label: string; type: DiagnosisActionType } | null;
}

export interface DiagnosisInput {
  active: number;
  healthQuarantined: number;
  healthQuarantineCode: string | null;
  connectionHealthStatus: ChannelHealthStatus;
  deadLetterCount: number;
  unresolvedIngressCount: number;
  responseMode: ChannelResponseMode;
  lastIngressAt: string | null;
  lastDeliveryAt: string | null;
}

const QUARANTINE_CODE_MAP: Record<
  string,
  { headline: string; detail: string }
> = {
  bot_kicked: {
    headline: 'Bot was removed from group',
    detail:
      'The bot is no longer a member of this chat. Re-add the bot and test the connection.',
  },
  chat_not_found: {
    headline: 'Chat not found',
    detail:
      'The target chat no longer exists or the bot has been permanently removed.',
  },
  rate_limited: {
    headline: 'Quarantined due to rate limiting',
    detail:
      'Persistent rate limiting caused this binding to be quarantined. Wait and try again.',
  },
  forbidden: {
    headline: 'Bot lacks permission',
    detail: 'The bot does not have permission to send messages to this chat.',
  },
};

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function diagnoseBinding(input: DiagnosisInput): BindingDiagnosis {
  // 1. Paused by user
  if (input.active === 0) {
    return {
      status: 'paused',
      headline: 'Paused by user',
      detail: null,
      action: null,
    };
  }

  // 2. Quarantined
  if (input.healthQuarantined === 1) {
    const code = input.healthQuarantineCode || 'unknown';
    const mapped = QUARANTINE_CODE_MAP[code];
    return {
      status: 'quarantined',
      headline: mapped?.headline || `Quarantined: ${code}`,
      detail:
        mapped?.detail ||
        'This binding has been quarantined due to persistent delivery failures.',
      action: { label: 'Test and reconnect', type: 'unquarantine' },
    };
  }

  // 3. Connection disconnected
  if (input.connectionHealthStatus === 'disconnected') {
    return {
      status: 'error',
      headline: 'Platform API unreachable',
      detail:
        'The connection to the messaging platform has failed multiple consecutive probes.',
      action: { label: 'Check bot token', type: 'test' },
    };
  }

  // 4. Dead-lettered deliveries
  if (input.deadLetterCount > 0) {
    return {
      status: 'warning',
      headline: `${input.deadLetterCount} message${input.deadLetterCount === 1 ? '' : 's'} failed to deliver`,
      detail:
        'Some outbound messages could not be delivered after all retry attempts.',
      action: { label: 'Review failures', type: 'retry' },
    };
  }

  // 5. Unresolved ingress
  if (input.unresolvedIngressCount > 0) {
    return {
      status: 'warning',
      headline: `${input.unresolvedIngressCount} inbound message${input.unresolvedIngressCount === 1 ? '' : 's'} waiting`,
      detail: null,
      action: null,
    };
  }

  // 6. Connection degraded
  if (input.connectionHealthStatus === 'degraded') {
    return {
      status: 'warning',
      headline: 'Connection intermittent',
      detail: 'Recent probe failures indicate the connection is unstable.',
      action: null,
    };
  }

  // 7. Response mode off
  if (input.responseMode === 'off') {
    return {
      status: 'ok',
      headline: 'Connected \u00b7 responses paused',
      detail:
        'This binding is connected but will not respond to incoming messages.',
      action: null,
    };
  }

  // 8. No activity yet
  if (!input.lastIngressAt && !input.lastDeliveryAt) {
    return {
      status: 'warning',
      headline: 'No activity yet',
      detail: 'No messages have been received or sent through this binding.',
      action: { label: 'Send a test message', type: 'test' },
    };
  }

  // 9. OK — build activity headline
  const parts: string[] = [];
  if (input.lastIngressAt) {
    parts.push(`Receiving \u00b7 ${relativeTime(input.lastIngressAt)}`);
  }
  if (input.lastDeliveryAt) {
    parts.push(`Sending \u00b7 ${relativeTime(input.lastDeliveryAt)}`);
  }
  return {
    status: 'ok',
    headline: parts.join(' | ') || 'Connected',
    detail: null,
    action: null,
  };
}
