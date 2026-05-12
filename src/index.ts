import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TELEGRAM_BOT_POOL,
  TRIGGER_PATTERN,
} from './config.js';
import {
  getPublicModeConfigErrors,
  getPublicModeDatabaseErrors,
  WEB_ENABLED,
  WEB_HOST,
  WEB_PORT,
} from './clawrocket/config.js';
import './channels/index.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { createLegacyGroupExecutionTarget } from './container-execution-target.js';
import {
  cleanupOrphans,
  ContainerRuntimeUnavailableError,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  ensureSystemManagedTelegramConnection,
  getOwnerUser,
  getTalkChannelBindingById,
  initClawrocketSchema,
  listChannelConnections,
  updateChannelConnectionConfig,
  upsertChannelTarget,
} from './clawrocket/db/index.js';
import { ChannelDeliveryWorker } from './clawrocket/channels/channel-delivery-worker.js';
import { ChannelIngressWorker } from './clawrocket/channels/channel-ingress-worker.js';
import { TalkChannelRouter } from './clawrocket/channels/channel-router.js';
import { ChannelRuntimeManager } from './clawrocket/channels/channel-runtime-manager.js';
import { resolveSlackWorkspaceCredential } from './clawrocket/channels/slack-connector.js';
import {
  probeTelegramBotToken,
  resolveTelegramCredential,
} from './clawrocket/channels/telegram-connector.js';
import { TalkLifecycleWakeBus } from './clawrocket/channels/talk-lifecycle-wake-bus.js';
import { registerClawrocketSchedulerMaintenanceHook } from './clawrocket/scheduler-maintenance.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { SlackChannel } from './channels/slack.js';
import { initBotPool, TelegramChannel } from './channels/telegram.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { startWebServer } from './clawrocket/web/index.js';
import { InstanceCoordinator } from './instance-coordinator.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function assertPublicModeConfigReady(): void {
  const errors = getPublicModeConfigErrors();
  if (errors.length === 0) return;

  logger.fatal(
    { errors },
    'Public mode startup guard failed before database initialization',
  );
  throw new Error(errors.join(' '));
}

function assertPublicModeDatabaseReady(): void {
  const errors = getPublicModeDatabaseErrors(Boolean(getOwnerUser()));
  if (errors.length === 0) return;

  logger.fatal(
    { errors },
    'Public mode startup guard failed after database initialization',
  );
  throw new Error(errors.join(' '));
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

export async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  // --- Pre-flight: check if execution is blocked ---
  const { getActiveExecutorSettingsService } =
    await import('./clawrocket/talks/executor-settings.js');
  const blockedReason =
    getActiveExecutorSettingsService().getExecutionBlockedReason();
  if (blockedReason) {
    logger.error(
      { group: group.folder, reason: blockedReason },
      'Execution blocked',
    );
    return 'error';
  }

  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      createLegacyGroupExecutionTarget(group, chatJid),
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): boolean {
  try {
    ensureContainerRuntimeRunning();
    cleanupOrphans();
    return true;
  } catch (error) {
    if (error instanceof ContainerRuntimeUnavailableError) {
      logger.warn(
        'Continuing without a container runtime; container-backed agent execution is unavailable until Docker is healthy.',
      );
      return false;
    }
    throw error;
  }
}

export function shouldRequireConnectedChannels(webEnabled: boolean): boolean {
  return !webEnabled;
}

async function main(): Promise<void> {
  const coordinator = new InstanceCoordinator({
    dataDir: DATA_DIR,
    webHost: WEB_ENABLED ? WEB_HOST : null,
    webPort: WEB_ENABLED ? WEB_PORT : null,
  });
  let webServer:
    | {
        stop: () => Promise<void>;
        runWorker?: {
          wake: () => void;
          abortTalk: (talkId: string) => void;
          abortThread: (threadId: string) => void;
        };
      }
    | undefined;
  let channelIngressWorker: ChannelIngressWorker | undefined;
  let channelDeliveryWorker: ChannelDeliveryWorker | undefined;
  const channelRuntimeManager = new ChannelRuntimeManager();
  let shutdownPromise: Promise<void> | null = null;
  let signalHandlersInstalled = false;
  const talkLifecycleBus = new TalkLifecycleWakeBus();

  const gracefulShutdown = (
    reason: string,
    options?: { exitCode?: number; terminateProcess?: boolean },
  ): Promise<void> => {
    if (shutdownPromise) {
      logger.warn(
        { reason },
        'Shutdown already in progress, waiting for active shutdown',
      );
      return shutdownPromise;
    }

    const exitCode = options?.exitCode ?? 0;
    const terminateProcess = options?.terminateProcess ?? true;
    shutdownPromise = (async () => {
      logger.info({ reason, exitCode }, 'Shutting down NanoClaw');

      let releaseError: unknown;

      try {
        await queue.shutdown(10_000);
      } catch (error) {
        releaseError = releaseError ?? error;
        logger.error({ err: error, reason }, 'Failed to drain group queue');
      }

      if (channelIngressWorker) {
        try {
          await channelIngressWorker.stop();
        } catch (error) {
          releaseError = releaseError ?? error;
          logger.error(
            { err: error, reason },
            'Failed to stop talk channel ingress worker',
          );
        }
      }

      if (channelDeliveryWorker) {
        try {
          await channelDeliveryWorker.stop();
        } catch (error) {
          releaseError = releaseError ?? error;
          logger.error(
            { err: error, reason },
            'Failed to stop talk channel delivery worker',
          );
        }
      }

      try {
        await channelRuntimeManager.stop();
      } catch (error) {
        releaseError = releaseError ?? error;
        logger.error(
          { err: error, reason },
          'Failed to stop channel runtime manager',
        );
      }

      if (webServer) {
        try {
          await webServer.stop();
        } catch (error) {
          releaseError = releaseError ?? error;
          logger.error({ err: error, reason }, 'Failed to stop web server');
        }
      }

      await Promise.all(
        channels.map(async (channel) => {
          try {
            await channel.disconnect();
          } catch (error) {
            releaseError = releaseError ?? error;
            logger.error(
              { err: error, reason, channel: channel.name },
              'Failed to disconnect channel during shutdown',
            );
          }
        }),
      );

      try {
        await coordinator.release();
      } catch (error) {
        releaseError = releaseError ?? error;
        logger.error(
          { err: error, reason },
          'Failed to release singleton coordinator',
        );
      }

      if (terminateProcess) {
        process.exit(releaseError ? 1 : exitCode);
      }

      if (releaseError) {
        throw releaseError;
      }
    })();

    return shutdownPromise;
  };

  const installSignalHandlers = () => {
    if (signalHandlersInstalled) return;
    signalHandlersInstalled = true;
    process.once('SIGTERM', () => {
      void gracefulShutdown('SIGTERM');
    });
    process.once('SIGINT', () => {
      void gracefulShutdown('SIGINT');
    });
  };
  installSignalHandlers();

  await coordinator.acquire(async () => {
    await gracefulShutdown('takeover_request');
  });

  try {
    ensureContainerSystemRunning();
    assertPublicModeConfigReady();
    initDatabase();
    // ClawRocket integration seam: initialize ClawRocket schema in shared DB.
    initClawrocketSchema();
    assertPublicModeDatabaseReady();
    const telegramConnection = ensureSystemManagedTelegramConnection();
    // ClawRocket integration seam: register scheduler maintenance callbacks.
    registerClawrocketSchedulerMaintenanceHook();
    logger.info('Database initialized');
    loadState();
    let reloadChannelConnection = async (
      _connectionId: string,
    ): Promise<void> => {
      /* replaced after worker wiring */
    };

    if (WEB_ENABLED) {
      webServer = await startWebServer({
        onTalkTerminal: (talkId) => {
          talkLifecycleBus.notifyTalkTerminal(talkId);
        },
        onChannelDeliveryQueued: () => {
          channelDeliveryWorker?.wake();
        },
        sendChannelTestMessage: async (bindingId, text) => {
          const binding = getTalkChannelBindingById(bindingId);
          if (!binding) {
            throw new Error('Talk channel binding not found');
          }
          await channelRuntimeManager.sendDelivery({
            connectionId: binding.connection_id,
            targetId: binding.target_id,
            content: text,
            deliveryMode: binding.delivery_mode,
          });
        },
        reloadChannelConnection: (connectionId) =>
          reloadChannelConnection(connectionId),
        disconnectChannelConnection: (connectionId) =>
          channelRuntimeManager.disconnectRuntime(connectionId),
        handleSlackEvent: (connectionId, event) =>
          channelRuntimeManager.routePlatformEvent(connectionId, event),
      });
    } else {
      logger.info('Web API server is disabled (WEB_ENABLED=false)');
    }

    if (webServer?.runWorker) {
      channelIngressWorker = new ChannelIngressWorker({
        runWorker: webServer.runWorker,
        talkLifecycleBus,
      });
      channelDeliveryWorker = new ChannelDeliveryWorker({
        sendDelivery: async (payload) => {
          await channelRuntimeManager.sendDelivery(payload);
        },
      });
    }

    const talkChannelRouter = channelIngressWorker
      ? new TalkChannelRouter(channelIngressWorker)
      : null;

    const buildChannelOpts = (connectionId: string) => ({
      connectionId,
      onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => {
        storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
      },
      onTargetObserved: async (
        observation: import('./types.js').ChannelTargetObservation,
      ) => {
        upsertChannelTarget({
          connectionId: observation.connection_id,
          targetKind: observation.target_kind,
          targetId: observation.target_id,
          displayName: observation.display_name || observation.target_id,
          metadataJson: JSON.stringify(observation.metadata || {}),
          lastSeenAt: observation.observed_at,
        });
      },
      onInboundEvent: talkChannelRouter
        ? (event: import('./types.js').TalkChannelInboundEvent) =>
            talkChannelRouter.handleInboundEvent(event)
        : undefined,
      registeredGroups: () => registeredGroups,
    });

    const parseConfigJson = (
      raw: string | null,
    ): Record<string, unknown> | null => {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    };

    const removeConnectedTelegramChannel = async () => {
      await channelRuntimeManager.disconnectRuntime(telegramConnection.id);
      const remaining: Channel[] = [];
      for (const channel of channels) {
        if (channel.name !== 'telegram') {
          remaining.push(channel);
          continue;
        }
        await channel.disconnect();
      }
      channels.splice(0, channels.length, ...remaining);
    };

    const reloadTelegramConnection = async () => {
      const timestamp = new Date().toISOString();
      await removeConnectedTelegramChannel();

      const credential = resolveTelegramCredential();
      const baseConfig = {
        managedBy: 'runtime',
        platform: 'telegram',
        tokenSource: credential.tokenSource,
        envTokenAvailable: credential.envTokenAvailable,
        hasStoredSecret: credential.hasStoredSecret,
      };

      if (!credential.token) {
        updateChannelConnectionConfig({
          connectionId: telegramConnection.id,
          config: {
            ...baseConfig,
            botUserId: null,
            botUsername: null,
            botDisplayName: null,
          },
          healthStatus: 'disconnected',
          lastHealthCheckAt: timestamp,
          lastHealthError: 'Telegram bot token not configured.',
        });
        return;
      }

      try {
        const identity = await probeTelegramBotToken(credential.token);
        const channel = new TelegramChannel(
          credential.token,
          buildChannelOpts(telegramConnection.id),
        );
        await channelRuntimeManager.connectRuntime({
          connectionId: telegramConnection.id,
          channel,
          pollMs: 60_000,
        });
        channels.push(channel);
        updateChannelConnectionConfig({
          connectionId: telegramConnection.id,
          config: {
            ...baseConfig,
            botUserId: identity.botUserId,
            botUsername: identity.botUsername,
            botDisplayName: identity.botDisplayName,
            canJoinGroups: identity.canJoinGroups,
          },
          healthStatus: 'healthy',
          lastHealthCheckAt: timestamp,
          lastHealthError: null,
        });
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'Failed to connect Telegram';
        updateChannelConnectionConfig({
          connectionId: telegramConnection.id,
          config: {
            ...baseConfig,
            botUserId: null,
            botUsername: null,
            botDisplayName: null,
          },
          healthStatus: 'error',
          lastHealthCheckAt: timestamp,
          lastHealthError: detail,
        });
        logger.error({ err: error }, 'Failed to connect Telegram channel');
      }
    };

    const reloadSlackWorkspaceConnection = async (
      connectionId: string,
    ): Promise<void> => {
      const connection = listChannelConnections().find(
        (candidate) => candidate.id === connectionId,
      );
      if (!connection || connection.platform !== 'slack') {
        await channelRuntimeManager.disconnectRuntime(connectionId);
        return;
      }

      const timestamp = new Date().toISOString();
      const credential = resolveSlackWorkspaceCredential(connectionId);
      const existingConfig = parseConfigJson(connection.config_json) || {};

      if (!credential?.botToken) {
        await channelRuntimeManager.disconnectRuntime(connectionId);
        updateChannelConnectionConfig({
          connectionId,
          config: {
            ...existingConfig,
            managedBy: 'runtime',
            platform: 'slack',
            tokenSource: 'missing',
          },
          healthStatus: 'disconnected',
          lastHealthCheckAt: timestamp,
          lastHealthError: 'Slack workspace token not configured.',
        });
        return;
      }

      try {
        const channel = new SlackChannel(
          credential.botToken,
          buildChannelOpts(connectionId),
        );
        await channelRuntimeManager.connectRuntime({
          connectionId,
          channel,
          pollMs: 60_000,
        });
        updateChannelConnectionConfig({
          connectionId,
          config: {
            ...existingConfig,
            managedBy: 'runtime',
            platform: 'slack',
            tokenSource: 'db',
          },
          healthStatus: 'healthy',
          lastHealthCheckAt: timestamp,
          lastHealthError: null,
        });
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : 'Failed to connect Slack';
        await channelRuntimeManager.disconnectRuntime(connectionId);
        updateChannelConnectionConfig({
          connectionId,
          config: {
            ...existingConfig,
            managedBy: 'runtime',
            platform: 'slack',
            tokenSource: credential ? 'db' : 'missing',
          },
          healthStatus: 'error',
          lastHealthCheckAt: timestamp,
          lastHealthError: detail,
        });
        logger.error(
          { err: error, connectionId },
          'Failed to connect Slack workspace',
        );
      }
    };

    reloadChannelConnection = async (connectionId: string) => {
      if (connectionId === telegramConnection.id) {
        await reloadTelegramConnection();
        return;
      }
      await reloadSlackWorkspaceConnection(connectionId);
    };

    await reloadTelegramConnection();
    const slackConnections = listChannelConnections().filter(
      (connection) => connection.platform === 'slack',
    );
    for (const connection of slackConnections) {
      await reloadSlackWorkspaceConnection(connection.id);
    }
    if (channelRuntimeManager.getConnectionCount() === 0) {
      if (shouldRequireConnectedChannels(WEB_ENABLED)) {
        throw new Error('No channels connected');
      }
      logger.warn(
        'No chat channels connected; continuing in web-only mode and skipping channel subsystems.',
      );
    }
    if (channelIngressWorker) {
      await channelIngressWorker.start();
    }
    if (channelDeliveryWorker) {
      await channelDeliveryWorker.start();
    }

    // Initialize Telegram bot pool for agent teams
    if (TELEGRAM_BOT_POOL.length > 0) {
      await initBotPool(TELEGRAM_BOT_POOL);
    }

    // Start subsystems (independently of connection handler)
    startSchedulerLoop({
      registeredGroups: () => registeredGroups,
      getSessions: () => sessions,
      queue,
      onProcess: (groupJid, proc, containerName, groupFolder) =>
        queue.registerProcess(groupJid, proc, containerName, groupFolder),
      sendMessage: async (jid, rawText) => {
        const channel = findChannel(channels, jid);
        if (!channel) {
          logger.warn({ jid }, 'No channel owns JID, cannot send message');
          return;
        }
        const text = formatOutbound(rawText);
        if (text) await channel.sendMessage(jid, text);
      },
    });
    startIpcWatcher({
      sendMessage: (jid, text) => {
        const channel = findChannel(channels, jid);
        if (!channel) throw new Error(`No channel for JID: ${jid}`);
        return channel.sendMessage(jid, text);
      },
      registeredGroups: () => registeredGroups,
      registerGroup,
      syncGroups: async (force: boolean) => {
        await Promise.all(
          channels
            .filter((ch) => ch.syncGroups)
            .map((ch) => ch.syncGroups!(force)),
        );
      },
      getAvailableGroups,
      writeGroupsSnapshot: (gf, im, ag, rj) =>
        writeGroupsSnapshot(gf, im, ag, rj),
    });
    queue.setProcessMessagesFn(processGroupMessages);
    recoverPendingMessages();
    startMessageLoop().catch((err) => {
      logger.fatal({ err }, 'Message loop crashed unexpectedly');
      void gracefulShutdown('message_loop_crash', { exitCode: 1 });
    });
  } catch (error) {
    try {
      await gracefulShutdown('startup_failure', {
        exitCode: 1,
        terminateProcess: false,
      });
    } catch (shutdownError) {
      logger.error(
        { err: shutdownError, startupErr: error },
        'Failed to shut down cleanly after startup error',
      );
    }
    throw error;
  }
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
