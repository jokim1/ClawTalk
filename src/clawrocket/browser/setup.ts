import { initDatabase } from '../../db.js';
import { logger } from '../../logger.js';
import { initClawrocketSchema } from '../db/init.js';
import { getBrowserService } from './service.js';

function parseArgs(argv: string[]): {
  siteKey: string;
  accountLabel: string | null;
  url: string | null;
} {
  let siteKey = '';
  let accountLabel: string | null = null;
  let url: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--site' && next) {
      siteKey = next;
      index += 1;
      continue;
    }
    if (token === '--account' && next) {
      accountLabel = next;
      index += 1;
      continue;
    }
    if (token === '--url' && next) {
      url = next;
      index += 1;
    }
  }

  if (!siteKey.trim()) {
    throw new Error('Missing required --site argument');
  }

  return {
    siteKey,
    accountLabel,
    url,
  };
}

async function waitForCompletionPrompt(): Promise<void> {
  process.stdout.write(
    '\nComplete authentication in the opened browser, then press Enter here to close the setup session.\n',
  );
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  initDatabase();
  initClawrocketSchema();

  const service = getBrowserService();
  const result = await service.openSetupSession({
    siteKey: parsed.siteKey,
    accountLabel: parsed.accountLabel,
    url: parsed.url,
  });

  if (result.status !== 'ok' || !result.sessionId) {
    throw new Error(result.message);
  }

  logger.info(
    {
      siteKey: result.siteKey,
      accountLabel: result.accountLabel,
      sessionId: result.sessionId,
      url: result.url,
    },
    'Browser setup session opened',
  );

  await waitForCompletionPrompt();
  await service.close({
    sessionId: result.sessionId,
  });
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((error) => {
    logger.error({ err: error }, 'Browser setup failed');
    process.exit(1);
  });
}
