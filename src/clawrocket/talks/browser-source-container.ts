import { spawn } from 'child_process';
import path from 'path';

import { CONTAINER_IMAGE, TIMEZONE } from '../../config.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
} from '../../container-runtime.js';

export interface BrowserSourceFetchResult {
  finalUrl: string;
  pageTitle: string | null;
  extractedText: string;
  contentType: 'text/html';
  strategy: 'browser';
}

interface BrowserSourceContainerOutput {
  status: 'success' | 'error';
  finalUrl?: string;
  pageTitle?: string | null;
  extractedText?: string;
  contentType?: 'text/html';
  error?: string;
}

export async function runBrowserSourceFetchInContainer(input: {
  url: string;
  timeoutMs: number;
}): Promise<BrowserSourceFetchResult> {
  const projectRoot = process.cwd();
  const sourceDir = path.join(projectRoot, 'container', 'agent-runner', 'src');
  const containerName = `nanoclaw-browser-fetch-${Date.now()}`;
  const compileAndRun =
    'cd /app && ' +
    './node_modules/.bin/tsc --outDir /tmp/dist >/dev/stderr 2>&1 && ' +
    'ln -sf /app/node_modules /tmp/dist/node_modules && ' +
    'node /tmp/dist/browser-fetch.js';

  const args = [
    'run',
    '-i',
    '--rm',
    '--name',
    containerName,
    '-e',
    `TZ=${TIMEZONE}`,
    ...readonlyMountArgs(sourceDir, '/app/src'),
    '--entrypoint',
    '/bin/bash',
    CONTAINER_IMAGE,
    '-lc',
    compileAndRun,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(CONTAINER_RUNTIME_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Browser ingestion timed out after ${input.timeoutMs}ms${
            stderr ? ` (${stderr.trim()})` : ''
          }`,
        ),
      );
    }, input.timeoutMs);

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            `Browser ingestion container exited with code ${code}${
              stderr ? `: ${stderr.trim()}` : ''
            }`,
          ),
        );
        return;
      }

      let parsed: BrowserSourceContainerOutput;
      try {
        parsed = JSON.parse(stdout.trim()) as BrowserSourceContainerOutput;
      } catch (err) {
        reject(
          new Error(
            `Browser ingestion returned invalid JSON: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
        return;
      }

      if (
        parsed.status !== 'success' ||
        typeof parsed.finalUrl !== 'string' ||
        typeof parsed.extractedText !== 'string'
      ) {
        reject(
          new Error(
            parsed.error || 'Browser ingestion failed without content.',
          ),
        );
        return;
      }

      resolve({
        finalUrl: parsed.finalUrl,
        pageTitle:
          typeof parsed.pageTitle === 'string' ? parsed.pageTitle : null,
        extractedText: parsed.extractedText,
        contentType: 'text/html',
        strategy: 'browser',
      });
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}
