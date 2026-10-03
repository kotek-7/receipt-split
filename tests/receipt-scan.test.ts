import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app';
import type { ReceiptScanEvent } from '../shared/receipt-progress';
import {
  RetryableReceiptAiError,
  scanReceiptRequest,
  RECEIPT_SCAN_MAX_BYTES,
  type ReceiptScanOptions,
} from '../server/receipt-scan';

const origin = 'https://example.test';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=',
  'base64',
);
const output = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          title: '居酒屋',
          total: 1800,
          items: [{ name: 'ビール', quantity: 3, amount: 1800, unitPrice: 600 }],
          adjustments: [],
        }),
      },
      finish_reason: 'stop',
    },
  ],
};
function request(
  body: Uint8Array = png,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return new Request(`${origin}/api/receipt-scan`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'image/png', ...headers },
    body: new Uint8Array(body),
    signal,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const progressHeaders = { Accept: 'application/x-ndjson' };
function events(text: string): ReceiptScanEvent[] {
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
async function remainingEvents(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return events(text + decoder.decode());
}

async function startExpress(t: TestContext, receiptScan: ReceiptScanOptions) {
  const app = await createApp({ dbPath: ':memory:', receiptScan });
  const server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await app.close();
  });
  return `http://127.0.0.1:${address.port}`;
}

test('scan accepts a bounded prepared image and returns only the validated draft', async () => {
  let called = 0;
  const result = await scanReceiptRequest(request(), {
    allow: async () => true,
    run: async (input) => {
      called++;
      assert.equal(input.messages[1].role, 'user');
      assert.match(JSON.stringify(input), /data:image\/png;base64,/);
      return output;
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const body = await result.json();
  assert.equal(body.receipt.items[0].amount, 1800);
  assert.deepEqual(Object.keys(body), ['receipt']);
  assert.equal(called, 1);
});

test('scan rejects foreign or missing origins before invoking the provider', async () => {
  for (const headers of [
    { Origin: 'https://evil.test' },
    { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ] as Record<string, string>[]) {
    const result = await scanReceiptRequest(request(png, headers), {
      run: async () => {
        assert.fail('must not run');
      },
    });
    assert.equal(result.status, 403);
  }
});

test('scan validates type, signature, dimensions and encoded byte limits', async () => {
  const hugePixels = new Uint8Array(png);
  new DataView(hugePixels.buffer).setUint32(16, 3200);
  new DataView(hugePixels.buffer).setUint32(20, 3200);
  const hugeEdge = new Uint8Array(png);
  new DataView(hugeEdge.buffer).setUint32(16, 3201);
  for (const [req, status] of [
    [request(png, { 'Content-Type': 'application/json' }), 415],
    [request(png, { 'Content-Type': 'image/jpeg' }), 400],
    [request(new Uint8Array()), 400],
    [request(new Uint8Array([1, 2, 3])), 400],
    [request(hugePixels), 413],
    [request(hugeEdge), 413],
    [request(png, { 'Content-Length': String(RECEIPT_SCAN_MAX_BYTES + 1) }), 413],
    [request(new Uint8Array(RECEIPT_SCAN_MAX_BYTES + 1), { 'Content-Length': '1' }), 413],
  ] as const) {
    const result = await scanReceiptRequest(req, {
      run: async () => {
        assert.fail('must not run');
      },
    });
    assert.equal(result.status, status);
  }
});

test('streamed image bytes are bounded without Content-Length', async () => {
  let cancelled = false;
  const req = new Request(`${origin}/api/receipt-scan`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'image/png' },
    body: new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: 'half',
  } as RequestInit);
  assert.equal(
    (
      await scanReceiptRequest(req, {
        run: async () => {
          assert.fail('must not run');
        },
      })
    ).status,
    413,
  );
  assert.equal(cancelled, true);
});

test('rate limiting and unavailable AI do not call the model', async () => {
  const result = await scanReceiptRequest(request(), {
    allow: async () => false,
    run: async () => {
      assert.fail('must not run');
    },
  });
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('retry-after'), '60');
  assert.equal((await scanReceiptRequest(request(), {})).status, 503);
});

test('rejected origin, image and IP limits do not spend the global inference budget', async () => {
  for (const [req, allow, expected] of [
    [request(png, { Origin: 'https://other.test' }), true, 403],
    [request(png, { 'Content-Type': 'text/plain' }), true, 415],
    [request(new Uint8Array([1, 2, 3])), true, 400],
    [request(), false, 429],
  ] as const) {
    const result = await scanReceiptRequest(req, {
      allow: async () => allow,
      allowAttempt: async () => assert.fail('rejected input must not consume budget'),
      run: async () => assert.fail('rejected input must not reach the provider'),
    });
    assert.equal(result.status, expected);
  }
});

test('daily budget exhaustion stops JSON and NDJSON before any provider call', async () => {
  for (const streaming of [false, true]) {
    let budgetCalls = 0;
    const response = await scanReceiptRequest(request(png, streaming ? progressHeaders : {}), {
      allowAttempt: async () => {
        budgetCalls++;
        return false;
      },
      run: async () => assert.fail('exhausted budget must not reach the provider'),
    });
    const text = await response.text();
    assert.equal(budgetCalls, 1);
    assert.match(text, /本日の読み取り上限/);
    assert.match(text, /手入力/);
    assert.equal(
      response.headers.get('Retry-After'),
      null,
      'a daily limit must not promise 60 seconds',
    );
    if (streaming) {
      const rows = events(text);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].type, 'error');
      if (rows[0].type === 'error') assert.equal(rows[0].status, 429);
    } else assert.equal(response.status, 429);
  }
});

test('each model call consumes budget, including failures and allowed retries', async () => {
  for (const mode of ['success', 'failure', 'invalid', 'retry'] as const) {
    const sequence: string[] = [];
    let calls = 0;
    const response = await scanReceiptRequest(request(), {
      allowAttempt: async () => {
        sequence.push('budget');
        return true;
      },
      run: async () => {
        sequence.push('model');
        calls++;
        if (mode === 'failure') throw new Error('private-provider-failure');
        if (mode === 'invalid') return {};
        if (mode === 'retry' && calls === 1) throw new RetryableReceiptAiError();
        return output;
      },
    });
    assert.equal(response.status, mode === 'failure' ? 502 : mode === 'invalid' ? 422 : 200);
    assert.deepEqual(
      sequence,
      mode === 'retry' ? ['budget', 'model', 'budget', 'model'] : ['budget', 'model'],
    );
  }
});

test('the daily budget can stop a retry without announcing an unstarted attempt', async () => {
  for (const streaming of [false, true]) {
    let budgetCalls = 0;
    let providerCalls = 0;
    const response = await scanReceiptRequest(request(png, streaming ? progressHeaders : {}), {
      allowAttempt: async () => ++budgetCalls === 1,
      run: async () => {
        providerCalls++;
        throw new RetryableReceiptAiError();
      },
    });
    const text = await response.text();
    assert.equal(providerCalls, 1);
    assert.equal(budgetCalls, 2);
    assert.match(text, /本日の読み取り上限/);
    if (streaming) {
      const rows = events(text);
      assert.deepEqual(rows[0], { type: 'progress', stage: 'reading', attempt: 1 });
      assert.equal(rows.length, 2);
      assert.equal(rows[1].type, 'error');
      if (rows[1].type === 'error') assert.equal(rows[1].status, 429);
    } else assert.equal(response.status, 429);
  }
});

test('budget service errors fail closed and do not expose internal details', async () => {
  const response = await scanReceiptRequest(request(), {
    allowAttempt: async () => {
      throw new Error('private-budget-failure');
    },
    run: async () => assert.fail('budget service failure must not reach the provider'),
  });
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.match(text, /手入力/);
  assert.doesNotMatch(text, /private-budget-failure/);
});

test(
  'budget waits honor the deadline and cancellation without late provider calls',
  { timeout: 2000 },
  async () => {
    for (const mode of ['deadline', 'cancel'] as const) {
      const budget = deferred<boolean>();
      const started = deferred<void>();
      const controller = new AbortController();
      let calls = 0;
      const pending = scanReceiptRequest(request(png, {}, controller.signal), {
        timeoutMs: mode === 'deadline' ? 15 : 1000,
        allowAttempt: () => {
          started.resolve();
          return budget.promise;
        },
        run: async () => {
          calls++;
          return output;
        },
      });
      await started.promise;
      if (mode === 'cancel') controller.abort();
      const response = await pending;
      assert.equal(response.status, mode === 'deadline' ? 504 : 499);
      budget.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(calls, 0, 'late budget approval cannot start cancelled inference');
    }
  },
);

test('cancelling a stream while waiting for budget never starts model inference', async () => {
  const budget = deferred<boolean>();
  const started = deferred<void>();
  let calls = 0;
  const response = await scanReceiptRequest(request(png, progressHeaders), {
    allowAttempt: () => {
      started.resolve();
      return budget.promise;
    },
    run: async () => {
      calls++;
      return output;
    },
  });
  await started.promise;
  await response.body!.cancel();
  budget.resolve(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 0);
});

test('invalid model output and provider failures never expose raw output or secrets', async () => {
  let invalidCalls = 0;
  const invalid = await scanReceiptRequest(request(), {
    run: async () => {
      invalidCalls++;
      return {
        choices: [{ message: { content: JSON.stringify({ title: 'private-model-content' }) } }],
      };
    },
  });
  assert.equal(invalid.status, 422);
  assert.equal(invalidCalls, 1);
  assert.doesNotMatch(await invalid.text(), /private-model-content/);
  let failedCalls = 0;
  const failed = await scanReceiptRequest(request(), {
    run: async () => {
      failedCalls++;
      throw new Error('private-provider-secret');
    },
  });
  assert.equal(failed.status, 502);
  assert.equal(failedCalls, 1);
  assert.doesNotMatch(await failed.text(), /private-provider-secret/);
});

test('scan retries one explicit transient provider failure with the same input', async () => {
  let calls = 0;
  let rateLimitCalls = 0;
  let firstInput: unknown;
  const result = await scanReceiptRequest(request(), {
    allow: async () => {
      rateLimitCalls++;
      return true;
    },
    run: async (input) => {
      calls++;
      if (calls === 1) {
        firstInput = input;
        throw new RetryableReceiptAiError();
      }
      assert.equal(input, firstInput);
      return output;
    },
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).receipt.total, 1800);
  assert.equal(calls, 2);
  assert.equal(rateLimitCalls, 1);
});

test('a second transient provider failure stops without exposing provider details', async () => {
  let calls = 0;
  const result = await scanReceiptRequest(request(), {
    run: async () => {
      calls++;
      throw new RetryableReceiptAiError();
    },
  });
  assert.equal(result.status, 502);
  assert.equal(calls, 2);
  assert.doesNotMatch(await result.text(), /RetryableReceiptAiError|Receipt reader/);
});

test('cancellation prevents a retry after a transient failure', async () => {
  let calls = 0;
  const controller = new AbortController();
  const result = await scanReceiptRequest(request(png, {}, controller.signal), {
    run: async () => {
      calls++;
      controller.abort();
      throw new RetryableReceiptAiError();
    },
  });
  assert.equal(result.status, 499);
  assert.equal(calls, 1);
});

test('the retry remains inside the original deadline', async () => {
  let calls = 0;
  let retrySignal: AbortSignal | undefined;
  const result = await scanReceiptRequest(request(), {
    timeoutMs: 30,
    run: async (_input, signal) => {
      calls++;
      if (calls === 1) throw new RetryableReceiptAiError();
      retrySignal = signal;
      return new Promise(() => {});
    },
  });
  assert.equal(result.status, 504);
  assert.equal(calls, 2);
  assert.equal(retrySignal?.aborted, true);
});

test('deadline and client cancellation abort the provider and return bounded errors', async () => {
  let providerSignal: AbortSignal | undefined;
  const run = async (_input: unknown, signal: AbortSignal) => {
    providerSignal = signal;
    return new Promise(() => {});
  };
  assert.equal((await scanReceiptRequest(request(), { run, timeoutMs: 10 })).status, 504);
  assert.equal(providerSignal?.aborted, true);
  const controller = new AbortController();
  const pending = scanReceiptRequest(request(png, {}, controller.signal), { run });
  controller.abort();
  assert.equal((await pending).status, 499);
});

test('Express advertises unavailable AI and supports an injected provider through the same API', async () => {
  for (const enabled of [false, true]) {
    const app = await createApp({
      dbPath: ':memory:',
      receiptScan: enabled ? { run: async () => output } : {},
    });
    const server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const local = `http://127.0.0.1:${address.port}`;
    try {
      const capabilities = await fetch(`${local}/api/receipt-reader`);
      assert.deepEqual(await capabilities.json(), { ai: enabled });
      const result = await fetch(`${local}/api/receipt-scan`, {
        method: 'POST',
        headers: { Origin: local, 'Content-Type': 'image/png' },
        body: png,
      });
      assert.equal(result.status, enabled ? 200 : 503);
    } finally {
      server.close();
      await once(server, 'close');
      await app.close();
    }
  }
});

test(
  'JSON callers still wait for the validated result rather than receiving progress',
  { timeout: 2000 },
  async () => {
    const started = deferred<void>();
    const model = deferred<unknown>();
    let completed = false;
    const pending = scanReceiptRequest(request(), {
      run: async () => {
        started.resolve();
        return model.promise;
      },
    }).then((response) => {
      completed = true;
      return response;
    });
    await started.promise;
    assert.equal(completed, false);
    model.resolve(output);
    const response = await pending;
    assert.match(response.headers.get('Content-Type')!, /^application\/json/);
    assert.equal((await response.json()).receipt.total, 1800);
  },
);

test(
  'NDJSON reading arrives before a delayed model, then checking and a validated result',
  { timeout: 2000 },
  async (t) => {
    const model = deferred<unknown>();
    const req = request(png, progressHeaders);
    const initialListeners = getEventListeners(req.signal, 'abort').length;
    let providerSignal: AbortSignal | undefined;
    const response = await scanReceiptRequest(req, {
      run: async (_input, signal) => {
        providerSignal = signal;
        return model.promise;
      },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type')!, /^application\/x-ndjson/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const reader = response.body!.getReader();
    t.after(() => reader.cancel());
    const first = await reader.read();
    assert.deepEqual(events(new TextDecoder().decode(first.value)), [
      { type: 'progress', stage: 'reading', attempt: 1 },
    ]);
    assert.equal(
      providerSignal?.aborted,
      false,
      'returning the response must not cancel the model',
    );
    model.resolve(output);
    const rest = await remainingEvents(reader);
    assert.deepEqual(rest[0], { type: 'progress', stage: 'checking' });
    assert.equal(rest.length, 2);
    assert.equal(rest[1].type, 'result');
    if (rest[1].type === 'result') {
      assert.equal(rest[1].receipt.total, 1800);
      assert.equal(rest[1].receipt.rawText, '');
    }
    assert.equal(getEventListeners(req.signal, 'abort').length, initialListeners);
  },
);

test('NDJSON retry progress appears only when the second provider attempt starts', async () => {
  let calls = 0;
  const response = await scanReceiptRequest(request(png, progressHeaders), {
    run: async () => {
      if (++calls === 1) throw new RetryableReceiptAiError();
      return output;
    },
  });
  const result = events(await response.text());
  assert.equal(calls, 2);
  assert.deepEqual(result.slice(0, 3), [
    { type: 'progress', stage: 'reading', attempt: 1 },
    { type: 'progress', stage: 'reading', attempt: 2 },
    { type: 'progress', stage: 'checking' },
  ]);
  assert.equal(result[3].type, 'result');
});

test('NDJSON invalid output and failed providers end with one sanitized error', async () => {
  for (const kind of ['invalid', 'provider', 'retry'] as const) {
    let calls = 0;
    const response = await scanReceiptRequest(request(png, progressHeaders), {
      run: async () => {
        calls++;
        if (kind === 'provider') throw new Error('private-provider-secret');
        if (kind === 'retry') throw new RetryableReceiptAiError();
        return { choices: [{ message: { content: 'private-model-content' } }] };
      },
    });
    const text = await response.text();
    const result = events(text);
    assert.equal(response.status, 200);
    assert.equal(calls, kind === 'retry' ? 2 : 1);
    assert.equal(result.filter((event) => event.type === 'error').length, 1);
    assert.equal(result.filter((event) => event.type === 'result').length, 0);
    assert.equal(result.at(-1)?.type, 'error');
    assert.equal(
      (result.at(-1) as Extract<ReceiptScanEvent, { type: 'error' }>).status,
      kind === 'invalid' ? 422 : 502,
    );
    assert.equal(
      result.some((event) => event.type === 'progress' && event.stage === 'checking'),
      kind === 'invalid',
    );
    assert.doesNotMatch(
      text,
      /private-model-content|private-provider-secret|RetryableReceiptAiError/,
    );
  }
});

test('NDJSON validation failures remain ordinary JSON before progress starts', async () => {
  for (const [req, options, expected] of [
    [request(png, { ...progressHeaders, Origin: 'https://foreign.test' }), {}, 403],
    [request(new Uint8Array([1, 2]), progressHeaders), {}, 400],
    [request(png, progressHeaders), { allow: async () => false }, 429],
  ] as const) {
    const response = await scanReceiptRequest(req, {
      ...options,
      run: async () => {
        assert.fail('validation must complete before invoking the model');
      },
    });
    assert.equal(response.status, expected);
    assert.match(response.headers.get('Content-Type')!, /^application\/json/);
    assert.deepEqual(Object.keys(await response.json()), ['error']);
  }
});

test(
  'NDJSON keeps the deadline after returning its response and aborts a stalled provider',
  { timeout: 2000 },
  async () => {
    let providerSignal: AbortSignal | undefined;
    const response = await scanReceiptRequest(request(png, progressHeaders), {
      timeoutMs: 20,
      run: async (_input, signal) => {
        providerSignal = signal;
        return new Promise(() => {});
      },
    });
    const result = events(await response.text());
    assert.equal(providerSignal?.aborted, true);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { type: 'progress', stage: 'reading', attempt: 1 });
    assert.equal(result[1].type, 'error');
    if (result[1].type === 'error') assert.equal(result[1].status, 504);
  },
);

test(
  'NDJSON request abort ends the stream and cancels the provider',
  { timeout: 2000 },
  async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const response = await scanReceiptRequest(request(png, progressHeaders, controller.signal), {
      run: async (_input, signal) => {
        providerSignal = signal;
        return new Promise(() => {});
      },
    });
    controller.abort();
    const result = events(await response.text());
    assert.equal(providerSignal?.aborted, true);
    assert.equal(result.at(-1)?.type, 'error');
    assert.equal((result.at(-1) as Extract<ReceiptScanEvent, { type: 'error' }>).status, 499);
  },
);

test(
  'cancelling the NDJSON body aborts the provider and prevents a later retry',
  { timeout: 2000 },
  async () => {
    const model = deferred<unknown>();
    const req = request(png, progressHeaders);
    const initialListeners = getEventListeners(req.signal, 'abort').length;
    let providerSignal: AbortSignal | undefined;
    let calls = 0;
    const response = await scanReceiptRequest(req, {
      run: async (_input, signal) => {
        calls++;
        providerSignal = signal;
        return model.promise;
      },
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(providerSignal?.aborted, true);
    model.reject(new RetryableReceiptAiError());
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(getEventListeners(req.signal, 'abort').length, initialListeners);
    reader.releaseLock();
  },
);

test(
  'completed NDJSON work releases its deadline and abort listener',
  { timeout: 2000 },
  async () => {
    const req = request(png, progressHeaders);
    const initialListeners = getEventListeners(req.signal, 'abort').length;
    let providerSignal: AbortSignal | undefined;
    const response = await scanReceiptRequest(req, {
      timeoutMs: 20,
      run: async (_input, signal) => {
        providerSignal = signal;
        return output;
      },
    });
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(providerSignal?.aborted, false);
    assert.equal(getEventListeners(req.signal, 'abort').length, initialListeners);
  },
);

test(
  'Express forwards the first progress chunk before model completion',
  { timeout: 5000 },
  async (t) => {
    const model = deferred<unknown>();
    const base = await startExpress(t, { run: async () => model.promise });
    const response = await fetch(`${base}/api/receipt-scan`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'image/png', ...progressHeaders },
      body: png,
    });
    assert.match(response.headers.get('Content-Type')!, /^application\/x-ndjson/);
    const reader = response.body!.getReader();
    t.after(() => reader.cancel());
    const first = await reader.read();
    assert.deepEqual(events(new TextDecoder().decode(first.value)), [
      { type: 'progress', stage: 'reading', attempt: 1 },
    ]);
    model.resolve(output);
    const rest = await remainingEvents(reader);
    assert.deepEqual(rest[0], { type: 'progress', stage: 'checking' });
    assert.equal(rest[1].type, 'result');
  },
);

test('disconnecting from Express cancels the active provider', { timeout: 5000 }, async (t) => {
  const aborted = deferred<void>();
  const base = await startExpress(t, {
    run: async (_input, signal) => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      return new Promise(() => {});
    },
  });
  const controller = new AbortController();
  const response = await fetch(`${base}/api/receipt-scan`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'image/png', ...progressHeaders },
    body: png,
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  await aborted.promise;
  await reader.cancel().catch(() => undefined);
  reader.releaseLock();
});
