type WaitOutcome = 'notified' | 'timeout' | 'aborted';

interface OutboxWaiter {
  topics: Set<string>;
  afterEventId: number;
  resolve: (outcome: WaitOutcome) => void;
  signal: AbortSignal | null;
  timer: ReturnType<typeof setTimeout> | null;
  abortHandler: (() => void) | null;
}

const waiters = new Set<OutboxWaiter>();

function settleWaiter(waiter: OutboxWaiter, outcome: WaitOutcome): void {
  if (!waiters.has(waiter)) return;
  waiters.delete(waiter);
  if (waiter.timer) {
    clearTimeout(waiter.timer);
    waiter.timer = null;
  }
  if (waiter.signal && waiter.abortHandler) {
    waiter.signal.removeEventListener('abort', waiter.abortHandler);
  }
  waiter.resolve(outcome);
}

export function notifyOutboxEvent(input: {
  topic: string;
  eventId: number;
}): void {
  for (const waiter of Array.from(waiters)) {
    if (waiter.topics.has(input.topic) && input.eventId > waiter.afterEventId) {
      settleWaiter(waiter, 'notified');
    }
  }
}

export function waitForOutboxTopics(input: {
  topics: string[];
  afterEventId: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<WaitOutcome> {
  if (input.signal?.aborted) {
    return Promise.resolve('aborted');
  }

  return new Promise<WaitOutcome>((resolve) => {
    const waiter: OutboxWaiter = {
      topics: new Set(input.topics),
      afterEventId: input.afterEventId,
      resolve,
      signal: input.signal ?? null,
      timer: null,
      abortHandler: null,
    };

    waiter.timer = setTimeout(
      () => {
        settleWaiter(waiter, 'timeout');
      },
      Math.max(0, input.timeoutMs),
    );

    if (input.signal) {
      waiter.abortHandler = () => {
        settleWaiter(waiter, 'aborted');
      };
      input.signal.addEventListener('abort', waiter.abortHandler, {
        once: true,
      });
    }

    waiters.add(waiter);
  });
}
