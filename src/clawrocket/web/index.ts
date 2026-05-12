import { logger } from '../../logger.js';
import {
  TALK_RUN_MAX_CONCURRENCY,
  TALK_RUN_POLL_MS,
  WEB_HOST,
  WEB_PORT,
} from '../config.js';
import { MainRunWorker } from '../agents/main-run-worker.js';
import { stopMainSubscriptionWorkerManager } from '../agents/main-subscription-worker-manager.js';
import type { TalkExecutor } from '../talks/executor.js';
import { TalkJobWorker } from '../talks/job-worker.js';
import { CleanTalkExecutor } from '../talks/new-executor.js';
import { TalkRunWorker } from '../talks/run-worker.js';
import type { SlackEventEnvelope } from '../../channels/slack.js';

import { createWebServer, WebServerHandle } from './server.js';

export interface StartWebServerOptions {
  onTalkTerminal?: (talkId: string) => void;
  onChannelDeliveryQueued?: () => void;
  sendChannelTestMessage?: (bindingId: string, text: string) => Promise<void>;
  reloadChannelConnection?: (connectionId: string) => Promise<void>;
  disconnectChannelConnection?: (connectionId: string) => Promise<void>;
  handleSlackEvent?: (
    connectionId: string,
    event: SlackEventEnvelope,
  ) => Promise<void>;
}

export async function startWebServer(
  input?: StartWebServerOptions,
): Promise<WebServerHandle> {
  const executor: TalkExecutor = new CleanTalkExecutor();

  logger.info(
    {
      mode: 'direct_http',
      executor: 'clean',
    },
    'Talk executor mode selected',
  );

  const runWorker = new TalkRunWorker({
    executor,
    pollMs: TALK_RUN_POLL_MS,
    maxConcurrency: TALK_RUN_MAX_CONCURRENCY,
    onTalkTerminal: input?.onTalkTerminal,
    onChannelDeliveryQueued: input?.onChannelDeliveryQueued,
  });
  await runWorker.start();

  const mainRunWorker = new MainRunWorker({
    pollMs: TALK_RUN_POLL_MS,
    maxConcurrency: TALK_RUN_MAX_CONCURRENCY,
  });
  await mainRunWorker.start();

  const jobWorker = new TalkJobWorker({
    pollMs: TALK_RUN_POLL_MS,
    onRunQueued: () => {
      runWorker.wake();
    },
  });
  await jobWorker.start();

  const server = createWebServer({
    host: WEB_HOST,
    port: WEB_PORT,
    runWorker,
    jobWorker,
    mainRunWorker,
    sendChannelTestMessage: input?.sendChannelTestMessage,
    reloadChannelConnection: input?.reloadChannelConnection,
    disconnectChannelConnection: input?.disconnectChannelConnection,
    handleSlackEvent: input?.handleSlackEvent,
  });

  let bound: { host: string; port: number };
  try {
    bound = await server.start();
  } catch (error) {
    await jobWorker.stop();
    await mainRunWorker.stop();
    await runWorker.stop();
    await stopMainSubscriptionWorkerManager();
    throw error;
  }
  logger.info({ host: bound.host, port: bound.port }, 'Web API server started');

  const originalStop = server.stop.bind(server);
  server.stop = async () => {
    await jobWorker.stop();
    await mainRunWorker.stop();
    await runWorker.stop();
    await stopMainSubscriptionWorkerManager();
    await originalStop();
  };
  server.runWorker = runWorker;

  return server;
}
