#!/usr/bin/env tsx
//
// scripts/latency-bench.ts — T9 synthetic latency harness (per the
// LLM-turn-latency audit plan). Drives a Talk on prod (or any
// configured base URL) end-to-end, capturing the canonical t0–t4
// timestamps so we can baseline before T0/T4/T5/T6/T7/T8 ship and
// re-verify each proposal's claimed savings against measurement.
//
//   t0 — request sent (just before POST /chat)
//   t1 — HTTP response started (POST /chat returned 202)
//   t2 — `talk_response_started` event received over WebSocket
//   t3 — first `talk_response_delta` event (TTFT to client)
//   t4 — `talk_response_completed` event
//
// Run:
//   CLAWTALK_BENCH_TOKEN=<eb_at JWT> tsx scripts/latency-bench.ts
//   CLAWTALK_BENCH_TOKEN=<jwt> tsx scripts/latency-bench.ts --provider=haiku
//
// Required env:
//   CLAWTALK_BENCH_TOKEN  — your eb_at Supabase JWT (paste from
//                           DevTools → Application → Cookies →
//                           https://clawtalk.app → eb_at)
//
// Optional env:
//   CLAWTALK_BASE_URL     — default https://clawtalk.app
//   CLAWTALK_BENCH_RUNS   — default 3
//   CLAWTALK_BENCH_PROMPT — default "Reply with a single sentence about cats."
//   CLAWTALK_BENCH_OUTPUT — default baseline.json
//
// CLI flags:
//   --provider=<name>     — only run one provider (haiku/sonnet/opus/codex/kimi)

import { writeFile } from 'node:fs/promises';

const BASE_URL = (
  process.env.CLAWTALK_BASE_URL ?? 'https://clawtalk.app'
).replace(/\/$/, '');
const BENCH_TOKEN = process.env.CLAWTALK_BENCH_TOKEN;
const RUNS_PER_PROVIDER = Number(process.env.CLAWTALK_BENCH_RUNS ?? '3');
const PROMPT =
  process.env.CLAWTALK_BENCH_PROMPT ??
  'Reply with a single sentence about cats.';
const OUTPUT_FILE = process.env.CLAWTALK_BENCH_OUTPUT ?? 'baseline.json';

// Hard ceiling per run — bigger than the worst provider's TTFT so we
// surface a failure rather than wedge.
const RUN_TIMEOUT_MS = 180_000;

interface ProviderConfig {
  name: string;
  providerId: string;
  modelId: string;
}

const ALL_PROVIDERS: ProviderConfig[] = [
  {
    name: 'haiku',
    providerId: 'provider.anthropic',
    modelId: 'claude-haiku-4-5-20251001',
  },
  {
    name: 'sonnet',
    providerId: 'provider.anthropic',
    modelId: 'claude-sonnet-4-6',
  },
  {
    name: 'opus',
    providerId: 'provider.anthropic',
    modelId: 'claude-opus-4-7',
  },
  {
    name: 'codex',
    providerId: 'provider.openai_codex',
    modelId: 'gpt-5.4',
  },
  {
    name: 'kimi',
    providerId: 'provider.nvidia',
    modelId: 'moonshotai/kimi-k2.6',
  },
];

interface RunMeasurement {
  provider: string;
  providerId: string;
  modelId: string;
  runIndex: number;
  talkId: string | null;
  runId: string | null;
  // Wall-clock epoch ms, captured locally.
  t0_postSent: number;
  t1_postReturned: number | null;
  t2_responseStarted: number | null;
  t3_firstDelta: number | null;
  t4_completed: number | null;
  // Derived deltas (ms). null if the source timestamp never fired.
  d_t1_t0: number | null;
  d_t2_t0: number | null;
  d_t3_t0: number | null;
  d_t4_t0: number | null;
  d_t4_t3: number | null;
  responsePreview: string;
  error: string | null;
}

interface ProviderStats {
  provider: string;
  providerId: string;
  modelId: string;
  runs: RunMeasurement[];
  aggregates: {
    successful: number;
    median: Record<string, number | null>;
    p95: Record<string, number | null>;
  };
}

const cliArgs = parseCliArgs(process.argv.slice(2));

if (!BENCH_TOKEN) {
  console.error(
    'CLAWTALK_BENCH_TOKEN env var is required. Paste your eb_at JWT from DevTools → Application → Cookies → eb_at on the target host.',
  );
  process.exit(1);
}

const TARGETS = cliArgs.provider
  ? ALL_PROVIDERS.filter((p) => p.name === cliArgs.provider)
  : ALL_PROVIDERS;

if (TARGETS.length === 0) {
  console.error(
    `Unknown --provider=${cliArgs.provider}. Known: ${ALL_PROVIDERS.map((p) => p.name).join(', ')}`,
  );
  process.exit(1);
}

await main();

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.error(
    `[bench] target=${BASE_URL} providers=${TARGETS.map((t) => t.name).join(',')} runs=${RUNS_PER_PROVIDER}`,
  );

  const allStats: ProviderStats[] = [];
  for (const provider of TARGETS) {
    const runs: RunMeasurement[] = [];
    for (let runIndex = 0; runIndex < RUNS_PER_PROVIDER; runIndex += 1) {
      console.error(
        `[bench] ${provider.name} run ${runIndex + 1}/${RUNS_PER_PROVIDER} ...`,
      );
      const measurement = await runOne(provider, runIndex);
      logSummary(measurement);
      runs.push(measurement);
    }
    allStats.push(aggregate(provider, runs));
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    prompt: PROMPT,
    runsPerProvider: RUNS_PER_PROVIDER,
    providers: allStats,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.error(`[bench] wrote ${OUTPUT_FILE}`);
  console.error(formatTable(allStats));
}

async function runOne(
  provider: ProviderConfig,
  runIndex: number,
): Promise<RunMeasurement> {
  const measurement: RunMeasurement = {
    provider: provider.name,
    providerId: provider.providerId,
    modelId: provider.modelId,
    runIndex,
    talkId: null,
    runId: null,
    t0_postSent: 0,
    t1_postReturned: null,
    t2_responseStarted: null,
    t3_firstDelta: null,
    t4_completed: null,
    d_t1_t0: null,
    d_t2_t0: null,
    d_t3_t0: null,
    d_t4_t0: null,
    d_t4_t3: null,
    responsePreview: '',
    error: null,
  };

  try {
    const talk = await createTalk(`bench-${provider.name}-${Date.now()}`);
    measurement.talkId = talk.id;
    const agentId = await assignAgent(talk.id, provider);

    const events = await openTalkEvents(talk.id);
    try {
      measurement.t0_postSent = Date.now();
      const chatPromise = sendChat(talk.id, agentId);
      const eventsPromise = collectStreamingEvents(events);

      const chatResponse = await chatPromise;
      measurement.t1_postReturned = Date.now();
      measurement.d_t1_t0 =
        measurement.t1_postReturned - measurement.t0_postSent;
      measurement.runId = chatResponse.runId;

      const eventResult = await eventsPromise;
      measurement.t2_responseStarted = eventResult.t2;
      measurement.t3_firstDelta = eventResult.t3;
      measurement.t4_completed = eventResult.t4;
      measurement.responsePreview = eventResult.responsePreview;

      if (eventResult.t2 !== null) {
        measurement.d_t2_t0 = eventResult.t2 - measurement.t0_postSent;
      }
      if (eventResult.t3 !== null) {
        measurement.d_t3_t0 = eventResult.t3 - measurement.t0_postSent;
      }
      if (eventResult.t4 !== null) {
        measurement.d_t4_t0 = eventResult.t4 - measurement.t0_postSent;
      }
      if (eventResult.t3 !== null && eventResult.t4 !== null) {
        measurement.d_t4_t3 = eventResult.t4 - eventResult.t3;
      }
      if (eventResult.error) {
        measurement.error = eventResult.error;
      }
    } finally {
      try {
        events.close();
      } catch {
        // ignore close errors
      }
    }
  } catch (err) {
    measurement.error =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  return measurement;
}

// ── HTTP helpers ────────────────────────────────────────────────────

async function createTalk(title: string): Promise<{ id: string }> {
  const res = await authedFetch('/api/v1/talks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const json = (await res.json()) as ApiEnvelope<{ talk: { id: string } }>;
  if (!res.ok || !json.ok) throw apiError('createTalk', res.status, json);
  return { id: json.data.talk.id };
}

async function assignAgent(
  talkId: string,
  provider: ProviderConfig,
): Promise<string> {
  const agentId = crypto.randomUUID();
  const res = await authedFetch(`/api/v1/talks/${talkId}/agents`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agents: [
        {
          id: agentId,
          role: 'assistant',
          isPrimary: true,
          sourceKind: 'provider',
          providerId: provider.providerId,
          modelId: provider.modelId,
          nickname: `Bench ${provider.name}`,
          nicknameMode: 'custom',
          displayOrder: 0,
        },
      ],
    }),
  });
  const json = (await res.json()) as ApiEnvelope<unknown>;
  if (!res.ok || !json.ok) throw apiError('assignAgent', res.status, json);
  return agentId;
}

async function sendChat(
  talkId: string,
  targetAgentId: string,
): Promise<{ runId: string | null }> {
  const res = await authedFetch(`/api/v1/talks/${talkId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: PROMPT,
      targetAgentIds: [targetAgentId],
    }),
  });
  const json = (await res.json()) as ApiEnvelope<{
    runs?: Array<{ id: string }>;
  }>;
  if (!res.ok || !json.ok) throw apiError('sendChat', res.status, json);
  const runs = json.data?.runs ?? [];
  return { runId: runs[0]?.id ?? null };
}

async function authedFetch(path: string, init: RequestInit): Promise<Response> {
  return await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${BENCH_TOKEN}`,
    },
  });
}

// ── WebSocket helpers ────────────────────────────────────────────────

interface TalkEventStream {
  next(): Promise<TalkEventFrame | null>;
  close(): void;
}

interface TalkEventFrame {
  event: string;
  data: unknown;
  id: number;
}

interface StreamingResult {
  t2: number | null;
  t3: number | null;
  t4: number | null;
  responsePreview: string;
  error: string | null;
}

async function openTalkEvents(talkId: string): Promise<TalkEventStream> {
  const wsUrl = `${BASE_URL.replace(/^http/, 'ws')}/api/v1/talks/${talkId}/events?lastEventId=0`;
  // The DOM WebSocket type doesn't model the `headers` option, but Node's
  // global WebSocket (undici) accepts it as a non-standard extension —
  // load-bearing for sending the Bearer token on the upgrade request.
  // See undici/lib/web/websocket/connection.js: "undici extension, allow
  // setting custom headers."
  const wsOptions = {
    headers: { authorization: `Bearer ${BENCH_TOKEN}` },
  } as unknown as string[];
  const ws = new WebSocket(wsUrl, wsOptions);

  const incoming: TalkEventFrame[] = [];
  const waiters: Array<(frame: TalkEventFrame | null) => void> = [];
  let closed = false;
  let openResolve: (() => void) | null = null;
  let openReject: ((err: unknown) => void) | null = null;
  const openPromise = new Promise<void>((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });

  ws.addEventListener('open', () => openResolve?.());
  ws.addEventListener('error', (event) => {
    openReject?.(
      new Error(
        `websocket error: ${String((event as { message?: unknown }).message ?? '')}`,
      ),
    );
  });
  ws.addEventListener('message', (event) => {
    const data = typeof event.data === 'string' ? event.data : '';
    if (!data) return;
    let parsed: { event?: unknown; data?: unknown; id?: unknown };
    try {
      parsed = JSON.parse(data) as typeof parsed;
    } catch {
      return;
    }
    if (typeof parsed.event !== 'string' || typeof parsed.id !== 'number') {
      return;
    }
    const frame: TalkEventFrame = {
      event: parsed.event,
      data: parsed.data,
      id: parsed.id,
    };
    if (waiters.length > 0) {
      waiters.shift()?.(frame);
    } else {
      incoming.push(frame);
    }
  });
  ws.addEventListener('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()?.(null);
  });

  await openPromise;

  return {
    async next() {
      if (incoming.length > 0) return incoming.shift() ?? null;
      if (closed) return null;
      return new Promise<TalkEventFrame | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
  };
}

async function collectStreamingEvents(
  events: TalkEventStream,
): Promise<StreamingResult> {
  const result: StreamingResult = {
    t2: null,
    t3: null,
    t4: null,
    responsePreview: '',
    error: null,
  };
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      result.error = 'timeout waiting for talk_response_completed';
      return result;
    }
    const frame = await Promise.race([
      events.next(),
      sleep(remaining).then(() => null as TalkEventFrame | null),
    ]);
    if (!frame) {
      if (result.t4 === null) {
        result.error = result.error ?? 'event stream closed before completion';
      }
      return result;
    }
    switch (frame.event) {
      case 'talk_response_started':
        if (result.t2 === null) result.t2 = Date.now();
        break;
      case 'talk_response_delta': {
        if (result.t3 === null) result.t3 = Date.now();
        const text = readDeltaText(frame.data);
        if (text) result.responsePreview += text;
        break;
      }
      case 'talk_response_completed':
        if (result.t4 === null) result.t4 = Date.now();
        return result;
      case 'talk_response_failed':
      case 'talk_run_failed':
        result.error = readErrorMessage(frame.data) ?? frame.event;
        if (result.t4 === null) result.t4 = Date.now();
        return result;
      case 'talk_response_cancelled':
      case 'talk_run_cancelled':
        result.error = 'cancelled';
        if (result.t4 === null) result.t4 = Date.now();
        return result;
      default:
        // ignore unrelated frames (lifecycle, content, browser, etc.)
        break;
    }
  }
}

function readDeltaText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const text = (data as { deltaText?: unknown }).deltaText;
  return typeof text === 'string' ? text : '';
}

function readErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as { errorMessage?: unknown; errorCode?: unknown };
  if (typeof obj.errorMessage === 'string') return obj.errorMessage;
  if (typeof obj.errorCode === 'string') return obj.errorCode;
  return null;
}

// ── stats ──────────────────────────────────────────────────────────

function aggregate(
  provider: ProviderConfig,
  runs: RunMeasurement[],
): ProviderStats {
  const successful = runs.filter((r) => !r.error && r.d_t4_t0 !== null);
  const keys = ['d_t1_t0', 'd_t2_t0', 'd_t3_t0', 'd_t4_t0', 'd_t4_t3'] as const;
  const median: Record<string, number | null> = {};
  const p95: Record<string, number | null> = {};
  for (const key of keys) {
    const values = successful
      .map((r) => r[key])
      .filter((v): v is number => typeof v === 'number');
    median[key] = values.length > 0 ? quantile(values, 0.5) : null;
    p95[key] = values.length > 0 ? quantile(values, 0.95) : null;
  }
  return {
    provider: provider.name,
    providerId: provider.providerId,
    modelId: provider.modelId,
    runs,
    aggregates: { successful: successful.length, median, p95 },
  };
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── reporting ──────────────────────────────────────────────────────

function logSummary(m: RunMeasurement): void {
  if (m.error) {
    console.error(`[bench]   FAIL ${m.provider} run ${m.runIndex}: ${m.error}`);
    return;
  }
  console.error(
    `[bench]   ${m.provider} run ${m.runIndex}: t1-t0=${fmt(m.d_t1_t0)}ms t3-t0=${fmt(m.d_t3_t0)}ms t4-t3=${fmt(m.d_t4_t3)}ms`,
  );
}

function formatTable(stats: ProviderStats[]): string {
  const header =
    'provider'.padEnd(10) +
    '  ok/total'.padEnd(12) +
    'median(t1-t0)'.padEnd(16) +
    'median(t3-t0)'.padEnd(16) +
    'p95(t3-t0)'.padEnd(13) +
    'median(t4-t3)'.padEnd(16) +
    'p95(t4-t3)';
  const lines = [header, '-'.repeat(header.length)];
  for (const s of stats) {
    lines.push(
      s.provider.padEnd(10) +
        `  ${s.aggregates.successful}/${s.runs.length}`.padEnd(12) +
        `${fmt(s.aggregates.median.d_t1_t0)}ms`.padEnd(16) +
        `${fmt(s.aggregates.median.d_t3_t0)}ms`.padEnd(16) +
        `${fmt(s.aggregates.p95.d_t3_t0)}ms`.padEnd(13) +
        `${fmt(s.aggregates.median.d_t4_t3)}ms`.padEnd(16) +
        `${fmt(s.aggregates.p95.d_t4_t3)}ms`,
    );
  }
  return lines.join('\n');
}

function fmt(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '   -';
  return Math.round(value).toString();
}

// ── misc ────────────────────────────────────────────────────────────

interface ApiEnvelopeOk<T> {
  ok: true;
  data: T;
}
interface ApiEnvelopeErr {
  ok: false;
  error: { code: string; message: string };
}
type ApiEnvelope<T> = ApiEnvelopeOk<T> | ApiEnvelopeErr;

function apiError(op: string, status: number, json: unknown): Error {
  const code =
    json &&
    typeof json === 'object' &&
    !(json as ApiEnvelopeOk<unknown>).ok &&
    (json as ApiEnvelopeErr).error?.code
      ? (json as ApiEnvelopeErr).error.code
      : 'unknown';
  return new Error(`${op} failed (${status}): ${code}`);
}

function parseCliArgs(argv: string[]): { provider?: string } {
  const out: { provider?: string } = {};
  for (const arg of argv) {
    const match = /^--provider=(.+)$/.exec(arg);
    if (match) out.provider = match[1];
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
