import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const origin = 'https://receipt.test';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=',
  'base64',
);
const bundled = build({
  stdin: {
    contents: `
      import worker, { ReceiptScanBudget } from './worker/index';
      export { ReceiptScanBudget };
      let providerCalls = 0;
      const counts = new Map();
      const fakeAI = {
        async run() {
          providerCalls++;
          return Response.json({ choices: [{ finish_reason: 'stop', message: {
            content: JSON.stringify({ title: '居酒屋', total: 600, items: [
              { name: 'ビール', quantity: 1, amount: 600, unitPrice: 600 }
            ] })
          } }] });
        }
      };
      const fakeLimiter = {
        async limit({ key }) {
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return { success: count <= 6 };
        }
      };
      export default {
        fetch(request, env) {
          if (new URL(request.url).pathname === '/__test__/metrics') {
            return Response.json({ providerCalls, keys: [...counts.keys()] });
          }
          // Only this isolated test fixture supplies edge headers. This does not
          // claim that a real client can forge Cloudflare's CF-Connecting-IP.
          const headers = new Headers(request.headers);
          headers.set('CF-Connecting-IP', headers.get('X-Test-Client-IP') ?? '192.0.2.1');
          headers.delete('X-Test-Client-IP');
          return worker.fetch(new Request(request, { headers }), {
            ...env, AI: fakeAI, RECEIPT_SCAN_LIMITER: fakeLimiter
          });
        }
      };
    `,
    resolveDir: dirname(fileURLToPath(new URL('../package.json', import.meta.url))),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  external: ['cloudflare:workers'],
  logLevel: 'silent',
});

type Metrics = { providerCalls: number; keys: string[] };

async function fixture(context: TestContext, dailyLimit: string, budgetAvailable = true) {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'worker-receipt-scan-test',
      modules: true,
      script: (await bundled).outputFiles[0].text,
      compatibilityDate: '2026-09-29',
      bindings: { RECEIPT_SCAN_DAILY_LIMIT: dailyLimit },
      durableObjects: budgetAvailable
        ? { RECEIPT_SCAN_BUDGET: { className: 'ReceiptScanBudget', useSQLite: true } }
        : {},
      outboundService: () => new Response('External requests disabled', { status: 503 }),
    }),
  );
  context.after(() => runtime.dispose());
  return {
    scan(address: string) {
      return runtime.dispatchFetch(`${origin}/api/receipt-scan`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'image/png',
          'X-Test-Client-IP': address,
        },
        body: png,
      });
    },
    async reader() {
      const response = await runtime.dispatchFetch(`${origin}/api/receipt-reader`);
      assert.equal(response.status, 200);
      return response.json();
    },
    async metrics(): Promise<Metrics> {
      const response = await runtime.dispatchFetch(`${origin}/__test__/metrics`);
      assert.equal(response.status, 200);
      return response.json() as Promise<Metrics>;
    },
  };
}

test('Worker groups seven source addresses in one IPv6 /64 into one six-request quota', async (t) => {
  const app = await fixture(t, '200');
  assert.deepEqual(await app.reader(), { ai: true });
  const statuses: number[] = [];
  for (let index = 1; index <= 7; index++) {
    const response = await app.scan(`2001:db8:1234:5678::${index}`);
    statuses.push(response.status);
    const body = (await response.json()) as { receipt?: { total: number }; error?: string };
    if (index <= 6) assert.equal(body.receipt?.total, 600);
    else {
      assert.match(body.error ?? '', /1分/);
      assert.equal(response.headers.get('Retry-After'), '60');
    }
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
  assert.deepEqual(await app.metrics(), {
    providerCalls: 6,
    keys: ['receipt-scan:2001:db8:1234:5678::/64'],
  });
});

test('Worker shares the actual durable daily budget across different IPv4 source addresses', async (t) => {
  const app = await fixture(t, '2');
  const statuses: number[] = [];
  for (let index = 1; index <= 3; index++) {
    const response = await app.scan(`192.0.2.${index}`);
    statuses.push(response.status);
    const body = (await response.json()) as { receipt?: { total: number }; error?: string };
    if (index <= 2) assert.equal(body.receipt?.total, 600);
    else {
      assert.match(body.error ?? '', /本日の読み取り上限/);
      assert.equal(response.headers.get('Retry-After'), null);
    }
  }
  assert.deepEqual(statuses, [200, 200, 429]);
  assert.deepEqual(await app.metrics(), {
    providerCalls: 2,
    keys: ['receipt-scan:192.0.2.1', 'receipt-scan:192.0.2.2', 'receipt-scan:192.0.2.3'],
  });
});

test('Worker disables AI capability and refuses scans when the budget binding is missing', async (t) => {
  const app = await fixture(t, '200', false);
  assert.deepEqual(await app.reader(), { ai: false });
  const response = await app.scan('192.0.2.1');
  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /手入力/);
  assert.deepEqual(await app.metrics(), { providerCalls: 0, keys: [] });
});
