import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const workerName = 'receipt-budget-test';
const bundled = build({
  stdin: {
    contents: `
      import { ReceiptScanBudget } from './worker/receipt-scan-budget';
      // This test-only clock changes Date inside the isolated test worker, never production.
      const RealDate = Date;
      let instant = '2026-10-03T23:59:59.999Z';
      globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [instant])); }
      };
      export class TestBudget extends ReceiptScanBudget {
        setTime(value) { instant = value; }
      }
      export default { fetch() { return new Response('No public budget route', { status: 404 }); } };
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

type BudgetStub = { consume(): Promise<boolean>; setTime(instant: string): Promise<void> };

async function fixture(context: TestContext, initialLimit?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'receipt-budget-'));
  const script = (await bundled).outputFiles[0].text;
  function options(limit?: string) {
    const result = convertV4MiniflareOptions({
      name: workerName,
      modules: true,
      script,
      compatibilityDate: '2026-09-29',
      bindings: limit === undefined ? {} : { RECEIPT_SCAN_DAILY_LIMIT: limit },
      durableObjects: { BUDGET: { className: 'TestBudget', useSQLite: true } },
      outboundService: () => new Response('External requests disabled', { status: 503 }),
    });
    result.resourcePersistencePath = directory;
    result.unsafeInspectDurableObjects = true;
    return result;
  }
  let currentLimit = initialLimit;
  let runtime = new Miniflare(options(currentLimit));
  context.after(async () => {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    async stub() {
      const namespace = await runtime.getDurableObjectNamespace('BUDGET');
      return namespace.get(namespace.idFromName('global')) as unknown as BudgetStub;
    },
    async rows() {
      const storage = await runtime.unsafeGetDurableObjectStorage(workerName, 'TestBudget', {
        name: 'global',
      });
      return storage.exec('SELECT day, used FROM receipt_scan_budget');
    },
    async configure(limit?: string) {
      currentLimit = limit;
      await runtime.setOptions(options(currentLimit));
    },
    async restart() {
      await runtime.dispose();
      runtime = new Miniflare(options(currentLimit));
    },
  };
}

test('concurrent budget requests cannot exceed the single persistent daily limit', async (t) => {
  const state = await fixture(t, '7');
  const stub = await state.stub();
  const results = await Promise.all(Array.from({ length: 40 }, () => stub.consume()));
  assert.equal(results.filter(Boolean).length, 7);
  assert.equal(await stub.consume(), false);
  assert.deepEqual(await state.rows(), [{ day: '2026-10-03', used: 7 }]);
  await state.restart();
  assert.equal(
    await (await state.stub()).consume(),
    false,
    'a restart cannot restore spent budget',
  );
  assert.deepEqual(await state.rows(), [{ day: '2026-10-03', used: 7 }]);
});

test('UTC midnight resets the count in the same singleton row', async (t) => {
  const state = await fixture(t, '1');
  const stub = await state.stub();
  assert.equal(await stub.consume(), true);
  assert.equal(await stub.consume(), false);
  await stub.setTime('2026-10-04T08:59:59.999+09:00');
  assert.equal(await stub.consume(), false, 'a Japanese local-date change is not a UTC reset');
  await stub.setTime('2026-10-04T09:00:00.000+09:00');
  assert.equal(await stub.consume(), true);
  assert.equal(await stub.consume(), false);
  assert.deepEqual(await state.rows(), [{ day: '2026-10-04', used: 1 }]);
});

test('the default is 200 and zero or malformed configuration fails closed', async (t) => {
  const state = await fixture(t);
  const stub = await state.stub();
  const results = await Promise.all(Array.from({ length: 205 }, () => stub.consume()));
  assert.equal(results.filter(Boolean).length, 200);
  await state.configure('201');
  assert.equal(
    await (await state.stub()).consume(),
    true,
    'raising the configured limit keeps the used count',
  );
  for (const value of ['0', '', '-1', '1.5', 'NaN', 'Infinity', ' 999', '9007199254740992']) {
    await state.configure(value);
    assert.equal(
      await (await state.stub()).consume(),
      false,
      `invalid or disabled limit: ${value}`,
    );
    assert.deepEqual(await state.rows(), [{ day: '2026-10-03', used: 201 }]);
  }
  await state.configure('202');
  assert.equal(await (await state.stub()).consume(), true);
  assert.equal(await (await state.stub()).consume(), false);
});
