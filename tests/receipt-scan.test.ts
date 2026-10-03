import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../server/app';
import {
  RetryableReceiptAiError,
  scanReceiptRequest,
  RECEIPT_SCAN_MAX_BYTES,
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
