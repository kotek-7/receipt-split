import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app';
import type { Room, SessionResponse } from '../shared/types';

const initialRoom = {
  title: '京都でごはん',
  payerName: 'あき',
  total: 1_100,
  items: [
    { id: 'pasta', name: 'パスタ', amount: 700 },
    { id: 'salad', name: 'サラダ', amount: 300 },
  ],
};

async function start(dbPath = ':memory:') {
  const application = await createApp({ dbPath });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    async request<T = Room>(method: string, route: string, body?: unknown, token?: string) {
      const response = await fetch(origin + route, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        data: (await response.json()) as T,
        headers: response.headers,
      };
    },
    async stop() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await application.close();
    },
  };
}

async function fixture(context: TestContext) {
  const api = await start();
  context.after(() => api.stop());
  const created = await api.request<SessionResponse>('POST', '/api/rooms', initialRoom);
  assert.equal(created.status, 201);
  const { room, identity: payer } = created.data;
  const joined = await api.request<SessionResponse>('POST', `/api/rooms/${room.id}/members`, {
    name: 'はる',
  });
  assert.equal(joined.status, 201);
  return { api, room, payer, other: joined.data.identity };
}

test('independent member sessions update only their own selections without losing concurrent writes', async (context) => {
  const { api, room, payer, other } = await fixture(context);
  const results = await Promise.all([
    api.request(
      'PUT',
      `/api/rooms/${room.id}/selection`,
      { itemIds: ['pasta'], done: true },
      payer.token,
    ),
    api.request(
      'PUT',
      `/api/rooms/${room.id}/selection`,
      { itemIds: ['salad'], done: true },
      other.token,
    ),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
  );
  const latest = await api.request('GET', `/api/rooms/${room.id}`);
  assert.deepEqual(latest.data.selections, {
    [payer.memberId]: ['pasta'],
    [other.memberId]: ['salad'],
  });
  assert.ok(latest.data.members.every((member) => member.done));
  assert.equal(latest.data.version, 4);
  const publicJson = JSON.stringify(latest.data);
  assert.ok(!publicJson.includes(payer.token));
  assert.ok(!publicJson.includes(other.token));
  assert.ok(!publicJson.includes('token'));
  assert.equal(latest.headers.get('cache-control'), 'no-store');
  assert.ok(room.id.length >= 22);
  assert.ok(payer.token.length >= 43);
});

test('room and member credentials survive a server restart', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'receipt-split-test-'));
  const dbPath = path.join(directory, 'rooms.sqlite');
  let api = await start(dbPath);
  context.after(async () => {
    await api.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const created = await api.request<SessionResponse>('POST', '/api/rooms', initialRoom);
  const { room, identity } = created.data;
  await api.stop();
  api = await start(dbPath);
  const loaded = await api.request('GET', `/api/rooms/${room.id}`);
  assert.deepEqual(loaded.data, room);
  const updated = await api.request(
    'PUT',
    `/api/rooms/${room.id}/selection`,
    { itemIds: ['pasta', 'salad'], done: true },
    identity.token,
  );
  assert.equal(updated.status, 200);
  assert.equal(updated.data.members[0].done, true);
});

test('invalid values, duplicate names, unknown items, and invalid authorization are rejected', async (context) => {
  const { api, room, payer } = await fixture(context);
  for (const body of [
    { ...initialRoom, payerName: '  ' },
    { ...initialRoom, title: '' },
    { ...initialRoom, total: 0 },
    { ...initialRoom, total: 1.5 },
    { ...initialRoom, total: 10_000_001 },
    { ...initialRoom, items: [] },
    { ...initialRoom, items: [{ id: 'x', name: 'X', amount: -1 }] },
    { ...initialRoom, items: [initialRoom.items[0], initialRoom.items[0]] },
  ])
    assert.equal((await api.request('POST', '/api/rooms', body)).status, 400);
  const duplicate = await api.request<{ error: string }>('POST', `/api/rooms/${room.id}/members`, {
    name: ' あき ',
  });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.data.error, /同じ名前/);
  assert.equal(
    (
      await api.request('PUT', `/api/rooms/${room.id}/selection`, {
        itemIds: ['pasta'],
        done: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api.request(
        'PUT',
        `/api/rooms/${room.id}/selection`,
        { itemIds: ['pasta'], done: true },
        'x'.repeat(43),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api.request(
        'PUT',
        `/api/rooms/${room.id}/selection`,
        { itemIds: ['missing'], done: true },
        payer.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await api.request(
        'PUT',
        `/api/rooms/${room.id}/selection`,
        { itemIds: ['pasta', 'pasta'], done: true },
        payer.token,
      )
    ).status,
    400,
  );
  assert.equal((await api.request('GET', '/api/rooms/missing')).status, 404);
});

test('a member credential cannot edit another room or invoke payer operations', async (context) => {
  const { api, room, other } = await fixture(context);
  const second = await api.request<SessionResponse>('POST', '/api/rooms', initialRoom);
  assert.equal(
    (
      await api.request(
        'PUT',
        `/api/rooms/${second.data.room.id}/selection`,
        { itemIds: ['pasta'], done: true },
        other.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api.request(
        'POST',
        `/api/rooms/${room.id}/close`,
        { closed: true, version: 2 },
        other.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api.request(
        'PUT',
        `/api/rooms/${room.id}/paid`,
        { memberId: other.memberId, paid: true },
        other.token,
      )
    ).status,
    403,
  );
});

test('closing requires complete selections and a current version, then freezes amounts until reopened', async (context) => {
  const { api, room, payer, other } = await fixture(context);
  const route = `/api/rooms/${room.id}`;
  assert.equal(
    (await api.request('POST', `${route}/close`, { closed: true, version: 2 }, payer.token)).status,
    409,
  );
  assert.equal(
    (
      await api.request(
        'PUT',
        `${route}/paid`,
        { memberId: other.memberId, paid: true },
        payer.token,
      )
    ).status,
    409,
  );
  await api.request('PUT', `${route}/selection`, { itemIds: ['pasta'], done: true }, payer.token);
  const incomplete = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: [], done: true },
    other.token,
  );
  assert.equal(
    (
      await api.request(
        'POST',
        `${route}/close`,
        { closed: true, version: incomplete.data.version },
        payer.token,
      )
    ).status,
    409,
  );
  const ready = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['salad'], done: true },
    other.token,
  );
  assert.equal(
    (
      await api.request(
        'POST',
        `${route}/close`,
        { closed: true, version: ready.data.version - 1 },
        payer.token,
      )
    ).status,
    409,
  );
  const closed = await api.request(
    'POST',
    `${route}/close`,
    { closed: true, version: ready.data.version },
    payer.token,
  );
  assert.equal(closed.status, 200);
  assert.equal(closed.data.closed, true);
  assert.equal(
    (await api.request('PUT', `${route}/selection`, { itemIds: [], done: false }, other.token))
      .status,
    409,
  );
  assert.equal((await api.request('POST', `${route}/members`, { name: '新しい人' })).status, 409);
  assert.equal(
    (
      await api.request(
        'PUT',
        `${route}/paid`,
        { memberId: payer.memberId, paid: true },
        payer.token,
      )
    ).status,
    400,
  );
  const paid = await api.request(
    'PUT',
    `${route}/paid`,
    { memberId: other.memberId, paid: true },
    payer.token,
  );
  assert.deepEqual(paid.data.paidMemberIds, [other.memberId]);
  const reopened = await api.request(
    'POST',
    `${route}/close`,
    { closed: false, version: paid.data.version },
    payer.token,
  );
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.closed, false);
  assert.deepEqual(reopened.data.paidMemberIds, []);
  assert.deepEqual(reopened.data.selections, ready.data.selections);
  assert.equal(
    (await api.request('PUT', `${route}/selection`, { itemIds: [], done: false }, other.token))
      .status,
    200,
  );
});

test('payer can remove an accidental participant and close with the remaining members', async (context) => {
  const { api, room, payer, other } = await fixture(context);
  const route = `/api/rooms/${room.id}`;
  const accidental = await api.request<SessionResponse>('POST', `${route}/members`, {
    name: '参加し直した人',
  });
  const removedMember = accidental.data.identity;
  await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['pasta'], done: false },
    removedMember.token,
  );
  await api.request('PUT', `${route}/selection`, { itemIds: ['pasta'], done: true }, payer.token);
  const remainingReady = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['salad'], done: true },
    other.token,
  );
  assert.equal(
    (
      await api.request(
        'POST',
        `${route}/close`,
        { closed: true, version: remainingReady.data.version },
        payer.token,
      )
    ).status,
    409,
  );

  const removed = await api.request(
    'DELETE',
    `${route}/members/${removedMember.memberId}`,
    {},
    payer.token,
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.data.version, remainingReady.data.version + 1);
  assert.deepEqual(
    removed.data.members.map((member) => member.id),
    [payer.memberId, other.memberId],
  );
  assert.deepEqual(removed.data.selections, {
    [payer.memberId]: ['pasta'],
    [other.memberId]: ['salad'],
  });
  assert.ok(!removed.data.paidMemberIds.includes(removedMember.memberId));
  assert.equal(
    (
      await api.request(
        'PUT',
        `${route}/selection`,
        { itemIds: ['pasta'], done: true },
        removedMember.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await api.request('DELETE', `${route}/members/${other.memberId}`, {}, removedMember.token))
      .status,
    403,
  );
  assert.equal(
    (await api.request('DELETE', `${route}/members/${removedMember.memberId}`, {}, payer.token))
      .status,
    404,
  );

  const closed = await api.request(
    'POST',
    `${route}/close`,
    { closed: true, version: removed.data.version },
    payer.token,
  );
  assert.equal(closed.status, 200);
  assert.equal(closed.data.closed, true);
});

test('participant removal rejects unauthenticated, non-payer, self, missing, and closed-room requests', async (context) => {
  const { api, room, payer, other } = await fixture(context);
  const route = `/api/rooms/${room.id}`;
  const removeOther = `${route}/members/${other.memberId}`;
  assert.equal((await api.request('DELETE', removeOther, {})).status, 403);
  assert.equal((await api.request('DELETE', removeOther, {}, other.token)).status, 403);
  assert.equal(
    (await api.request('DELETE', `${route}/members/${payer.memberId}`, {}, payer.token)).status,
    400,
  );
  assert.equal(
    (await api.request('DELETE', `${route}/members/missing`, {}, payer.token)).status,
    404,
  );
  assert.equal(
    (await api.request('DELETE', removeOther, { memberId: other.memberId }, payer.token)).status,
    400,
  );
  const unchanged = await api.request('GET', route);
  assert.equal(unchanged.data.version, 2);
  assert.equal(unchanged.data.members.length, 2);

  await api.request('PUT', `${route}/selection`, { itemIds: ['pasta'], done: true }, payer.token);
  const ready = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['salad'], done: true },
    other.token,
  );
  await api.request(
    'POST',
    `${route}/close`,
    { closed: true, version: ready.data.version },
    payer.token,
  );
  const paid = await api.request(
    'PUT',
    `${route}/paid`,
    { memberId: other.memberId, paid: true },
    payer.token,
  );
  assert.equal((await api.request('DELETE', removeOther, {}, payer.token)).status, 409);
  const stillClosed = await api.request('GET', route);
  assert.deepEqual(stillClosed.data, paid.data);
});
