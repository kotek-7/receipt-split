import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import type { Room, SessionResponse } from '../shared/types';

const workerName = 'receipt-storage-test';
const bundledWorker = build({
  stdin: {
    contents: `
      import { DurableObject } from 'cloudflare:workers';
      import worker, { ReceiptRoom as AppReceiptRoom } from './worker/index.ts';
      export * from './worker/index.ts';
      export default worker;
      function snapshot(storage) {
        return {
          bytes: storage.sql.databaseSize,
          tables: storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray(),
        };
      }
      export class ReceiptRoom extends AppReceiptRoom {
        snapshotStorage() { return JSON.stringify(snapshot(this.ctx.storage)); }
      }
      export class EmptyStorage extends DurableObject {
        snapshotStorage() { return JSON.stringify(snapshot(this.ctx.storage)); }
      }
    `,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  external: ['cloudflare:workers'],
  logLevel: 'silent',
});

const roomInput = {
  title: '飲み会',
  payerName: 'あき',
  participantCount: 2,
  calculationMode: 'fixed-participants',
  total: 1_200,
  items: [{ id: 'beer', name: 'ビール', amount: 1_200, quantity: 2, splitMode: 'quantity' }],
};

function requestInit(method: string, body?: unknown, token?: string) {
  return {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

async function fixture(context: TestContext, inspectStorage = false) {
  const directory = await mkdtemp(join(tmpdir(), 'receipt-worker-storage-'));
  const bundle = await bundledWorker;
  const options = convertV4MiniflareOptions({
    name: workerName,
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-29',
    durableObjects: {
      ROOMS: { className: 'ReceiptRoom', useSQLite: true },
      EMPTY: { className: 'EmptyStorage', useSQLite: true },
    },
    outboundService: () => new Response('External requests disabled in tests', { status: 503 }),
  });
  options.resourcePersistencePath = directory;
  options.unsafeInspectDurableObjects = inspectStorage;
  let runtime = new Miniflare(options);
  context.after(async () => {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    async request(method: string, route: string, body?: unknown, token?: string) {
      return runtime.dispatchFetch(`http://local.test${route}`, requestInit(method, body, token));
    },
    async createAt(id: string, body: unknown) {
      const namespace = await runtime.getDurableObjectNamespace('ROOMS');
      return namespace
        .get(namespace.idFromName(id))
        .fetch(`http://room.internal/api/rooms/${id}`, requestInit('POST', body));
    },
    async storage(id: string) {
      return runtime.unsafeGetDurableObjectStorage(workerName, 'ReceiptRoom', { name: id });
    },
    async snapshot(id: string, binding = 'ROOMS') {
      const namespace = await runtime.getDurableObjectNamespace(binding);
      const stub = namespace.get(namespace.idFromName(id)) as unknown as {
        snapshotStorage(): Promise<string>;
      };
      return JSON.parse(await stub.snapshotStorage()) as {
        bytes: number;
        tables: { name: string }[];
      };
    },
    async restart() {
      await runtime.dispose();
      runtime = new Miniflare(options);
    },
  };
}

test('unknown room operations and invalid creation leave Durable Object storage empty', async (context) => {
  const api = await fixture(context);
  const missing = '0'.repeat(32);
  const route = `/api/rooms/${missing}`;
  for (const [method, suffix, body] of [
    ['GET', '', undefined],
    ['POST', '/members', { name: 'はる' }],
    ['PUT', '/selection', { itemIds: [], done: false }],
    ['POST', '/close', { closed: true, version: 1 }],
    ['PUT', '/paid', { memberId: '1'.repeat(32), paid: true }],
    ['DELETE', `/members/${'1'.repeat(32)}`, {}],
  ] as const) {
    const response = await api.request(method, route + suffix, body);
    assert.equal(response.status, 404);
    await response.text();
  }
  const invalid = await api.createAt(missing, { ...roomInput, total: 0 });
  assert.equal(invalid.status, 400);
  await invalid.text();

  async function assertEmpty() {
    // Miniflare allocates an empty SQLite file even without application writes.
    const baseline = await api.snapshot('unused', 'EMPTY');
    assert.deepEqual(baseline.tables, []);
    assert.deepEqual(await api.snapshot(missing), baseline);
  }
  await assertEmpty();
  await api.restart();
  const afterRestart = await api.request('GET', route);
  assert.equal(afterRestart.status, 404);
  await afterRestart.text();
  await assertEmpty();
});

test('room creation stays atomic after an unknown lookup and concurrent creation', async (context) => {
  const api = await fixture(context, true);
  const id = '2'.repeat(32);
  const route = `/api/rooms/${id}`;
  assert.equal((await api.request('GET', route)).status, 404);
  const responses = await Promise.all([
    api.createAt(id, roomInput),
    api.createAt(id, { ...roomInput, title: '別の飲み会' }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const created = (await responses
    .find((response) => response.status === 201)!
    .json()) as SessionResponse;
  await responses.find((response) => response.status === 409)!.text();
  const storage = await api.storage(id);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM rooms'), [{ count: 1 }]);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM sessions'), [{ count: 1 }]);

  await api.restart();
  assert.deepEqual(await (await api.request('GET', route)).json(), created.room);
  const selected = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['beer'], quantities: { beer: 1 }, done: true },
    created.identity.token,
  );
  assert.equal(selected.status, 200);
  const updated = (await selected.json()) as Room;
  assert.equal(updated.selectionQuantities?.[created.identity.memberId]?.beer, 1);
});

test('rooms and token hashes from the previous SQLite schema remain usable', async (context) => {
  const api = await fixture(context, true);
  const id = '3'.repeat(32);
  const payerId = '4'.repeat(32);
  const token = 'a'.repeat(43);
  const legacyRoom: Room = {
    id,
    title: roomInput.title,
    payerId,
    total: roomInput.total,
    items: [{ id: 'beer', name: 'ビール', amount: 1_200, quantity: 2, splitMode: 'quantity' }],
    members: [{ id: payerId, name: 'あき', done: false }],
    selections: { [payerId]: [] },
    paidMemberIds: [],
    closed: false,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const storage = await api.storage(id);
  await storage.exec(`
    CREATE TABLE rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL UNIQUE);
  `);
  await storage.exec('INSERT INTO rooms (id, body) VALUES (?, ?)', id, JSON.stringify(legacyRoom));
  await storage.exec(
    'INSERT INTO sessions (token_hash, member_id) VALUES (?, ?)',
    createHash('sha256').update(token).digest('hex'),
    payerId,
  );
  await api.restart();

  const route = `/api/rooms/${id}`;
  assert.deepEqual(await (await api.request('GET', route)).json(), legacyRoom);
  const selected = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['beer'], quantities: { beer: 1 }, done: true },
    token,
  );
  assert.equal(selected.status, 200);
  assert.equal(((await selected.json()) as Room).selectionQuantities?.[payerId]?.beer, 1);
  const joined = await api.request('POST', `${route}/members`, { name: 'はる' });
  assert.equal(joined.status, 201);
  const updated = (await joined.json()) as SessionResponse;
  assert.equal(updated.room.members.length, 2);
  assert.equal(updated.room.version, 3);
});
