import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { ReceiptScanProgress } from '../shared/receipt-progress';
import { scanReceiptImage } from '../src/receipt-scan';

const receipt = {
  title: '居酒屋のレシート',
  total: 600,
  rawText: '',
  items: [{ id: 'beer', name: '生ビール', amount: 600, quantity: 1, splitMode: 'quantity' }],
};
const encoder = new TextEncoder();
const image = new Blob(['prepared image'], { type: 'image/png' });
const event = (value: unknown) => `${JSON.stringify(value)}\n`;
const result = event({ type: 'result', receipt });
const progress = event({ type: 'progress', stage: 'reading', attempt: 1 });

function streamResponse(t: TestContext, status = 200, contentType = 'application/x-ndjson') {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  let request: RequestInit | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stream, { status, headers: { 'Content-Type': contentType } });
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, '/api/receipt-scan');
    request = init;
    return response;
  });
  return {
    stream,
    get cancelled() {
      return cancelled;
    },
    get request() {
      return request;
    },
    write(value: string | Uint8Array) {
      controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value);
    },
    close() {
      controller.close();
    },
  };
}

test('receipt progress survives every-byte UTF-8 splits and reports only received stages', async (t) => {
  const source = streamResponse(t);
  const notifications: ReceiptScanProgress[] = [];
  const job = scanReceiptImage(
    image,
    (value) => notifications.push(value),
    new AbortController().signal,
  );
  await setImmediate();
  assert.deepEqual(notifications, []);
  assert.equal(new Headers(source.request?.headers).get('Accept'), 'application/x-ndjson');
  assert.equal(new Headers(source.request?.headers).get('Content-Type'), 'image/png');
  assert.equal(source.request?.body, image);
  const events =
    progress +
    event({ type: 'progress', stage: 'reading', attempt: 2 }) +
    event({ type: 'progress', stage: 'checking' }) +
    result;
  for (const byte of encoder.encode(events)) source.write(new Uint8Array([byte]));
  assert.deepEqual(await job, receipt);
  assert.deepEqual(notifications, [
    { stage: 'reading', attempt: 1 },
    { stage: 'reading', attempt: 2 },
    { stage: 'checking' },
  ]);
  assert.equal(source.cancelled, true, 'terminal result cancels the otherwise-open stream');
  assert.equal(source.stream.locked, false);
});

test('several events per chunk, CRLF, blank lines and a final object without newline work', async (t) => {
  const source = streamResponse(t, 200, 'application/x-ndjson; charset=utf-8');
  source.write(`\r\n${progress.replaceAll('\n', '\r\n')}${result.trim()}`);
  source.close();
  const notifications: ReceiptScanProgress[] = [];
  assert.deepEqual(
    await scanReceiptImage(
      image,
      (value) => notifications.push(value),
      new AbortController().signal,
    ),
    receipt,
  );
  assert.deepEqual(notifications, [{ stage: 'reading', attempt: 1 }]);
  assert.equal(source.stream.locked, false);
});

test('progress is delivered before the result arrives', async (t) => {
  const source = streamResponse(t);
  const notifications: ReceiptScanProgress[] = [];
  const job = scanReceiptImage(
    image,
    (value) => notifications.push(value),
    new AbortController().signal,
  );
  source.write(progress);
  await setImmediate();
  assert.deepEqual(notifications, [{ stage: 'reading', attempt: 1 }]);
  source.write(result);
  assert.deepEqual(await job, receipt);
});

test('truncated, malformed and incomplete event streams never return a receipt', async (t) => {
  const invalid = [
    '',
    progress,
    '{"type":"result","receipt":',
    '{invalid json}\n',
    event({ type: 'result', receipt: { title: 'missing items' } }),
    event({ type: 'progress', stage: 'invented' }),
    event({ type: 'progress', stage: 'reading', attempt: -1 }),
    event({ type: 'unknown' }),
  ];
  for (const [index, value] of invalid.entries()) {
    await t.test(`invalid stream ${index + 1}`, async (subtest) => {
      const source = streamResponse(subtest);
      source.write(value);
      source.close();
      await assert.rejects(
        scanReceiptImage(image, () => {}, new AbortController().signal),
        /読み取れませんでした/,
      );
      assert.equal(source.stream.locked, false);
    });
  }
});

test('a server error after progress rejects and closes its open stream', async (t) => {
  const source = streamResponse(t);
  source.write(progress + event({ type: 'error', error: 'もう一度お試しください。', status: 502 }));
  await assert.rejects(
    scanReceiptImage(image, () => {}, new AbortController().signal),
    /もう一度お試しください/,
  );
  assert.equal(source.cancelled, true);
  assert.equal(source.stream.locked, false);
});

test('legacy JSON results and early JSON errors remain compatible without invented progress', async (t) => {
  for (const status of [200, 413]) {
    await t.test(`HTTP ${status}`, async (subtest) => {
      const source = streamResponse(subtest, status, 'application/json');
      source.write(
        JSON.stringify(status === 200 ? { receipt } : { error: '画像が大きすぎます。' }),
      );
      source.close();
      const notifications: ReceiptScanProgress[] = [];
      const job = scanReceiptImage(
        image,
        (value) => notifications.push(value),
        new AbortController().signal,
      );
      if (status === 200) assert.deepEqual(await job, receipt);
      else await assert.rejects(job, /画像が大きすぎます/);
      assert.deepEqual(notifications, []);
      assert.equal(source.stream.locked, false);
    });
  }
});

test('cancellation while awaiting more events stops callbacks and releases the reader', async (t) => {
  const source = streamResponse(t);
  const abort = new AbortController();
  const notifications: ReceiptScanProgress[] = [];
  const job = scanReceiptImage(image, (value) => notifications.push(value), abort.signal);
  source.write(progress);
  await setImmediate();
  abort.abort();
  await assert.rejects(job, { name: 'AbortError' });
  assert.deepEqual(notifications, [{ stage: 'reading', attempt: 1 }]);
  assert.equal(source.cancelled, true);
  assert.equal(source.stream.locked, false);
  assert.equal(source.request?.signal?.aborted, true);
});

test('cancellation during a progress callback discards subsequent events in the same chunk', async (t) => {
  const source = streamResponse(t);
  const abort = new AbortController();
  const notifications: ReceiptScanProgress[] = [];
  source.write(progress + event({ type: 'progress', stage: 'checking' }) + result);
  const job = scanReceiptImage(
    image,
    (value) => {
      notifications.push(value);
      abort.abort();
    },
    abort.signal,
  );
  await assert.rejects(job, { name: 'AbortError' });
  assert.deepEqual(notifications, [{ stage: 'reading', attempt: 1 }]);
  assert.equal(source.stream.locked, false);
});

test('the 50 second deadline remains active after response headers and progress arrive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = streamResponse(t);
  source.write(progress);
  const job = scanReceiptImage(image, () => {}, new AbortController().signal);
  let settled = false;
  const rejected = assert.rejects(job, { name: 'TimeoutError' }).finally(() => {
    settled = true;
  });
  await setImmediate();
  t.mock.timers.tick(49_999);
  await setImmediate();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(source.cancelled, true);
  assert.equal(source.stream.locked, false);
  assert.equal(source.request?.signal?.aborted, true);
});

test('the deadline also stops a fetch that never returns headers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(() => {}));
  const job = scanReceiptImage(
    image,
    () => assert.fail('unexpected progress'),
    new AbortController().signal,
  );
  const rejected = assert.rejects(job, { name: 'TimeoutError' });
  t.mock.timers.tick(50_000);
  await rejected;
});

test('an already cancelled request never uploads an image', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected upload'));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    scanReceiptImage(image, () => {}, abort.signal),
    { name: 'AbortError' },
  );
});

test('oversized or invalid UTF-8 streams fail without retaining the stream', async (t) => {
  for (const bytes of [new Uint8Array(1024 * 1024 + 1), new Uint8Array([0xff, 0xff])]) {
    await t.test(`invalid bytes ${bytes.length}`, async (subtest) => {
      const source = streamResponse(subtest);
      source.write(bytes);
      await assert.rejects(scanReceiptImage(image, () => {}, new AbortController().signal));
      assert.equal(source.cancelled, true);
      assert.equal(source.stream.locked, false);
    });
  }
});
