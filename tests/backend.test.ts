import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app';
import { calculateSettlement } from '../shared/settlement';
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

const mixedRoom = {
  title: '個別のドリンクとシェア料理',
  payerName: 'あき',
  total: 1_501,
  items: [
    { id: 'drink', name: 'ドリンク', amount: 900, quantity: 3, splitMode: 'quantity' },
    { id: 'shared', name: 'シェア料理', amount: 600, quantity: 1, splitMode: 'equal' },
  ],
};

const fixedRoom = {
  title: '4人の飲み会',
  payerName: 'あき',
  participantCount: 4,
  calculationMode: 'fixed-participants',
  total: 3_000,
  items: [
    { id: 'beer', name: 'ビール', amount: 1_800, quantity: 3, splitMode: 'quantity' },
    { id: 'food', name: '唐揚げ', amount: 1_200, quantity: 1, splitMode: 'equal' },
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

async function fixture(context: TestContext, input = initialRoom) {
  const api = await start();
  context.after(() => api.stop());
  const created = await api.request<SessionResponse>('POST', '/api/rooms', input);
  assert.equal(created.status, 201);
  const { room, identity: payer } = created.data;
  const joined = await api.request<SessionResponse>('POST', `/api/rooms/${room.id}/members`, {
    name: 'はる',
  });
  assert.equal(joined.status, 201);
  return { api, room, payer, other: joined.data.identity };
}

test('participant count accepts integer bounds and remains optional for older clients', async (context) => {
  const api = await start();
  context.after(() => api.stop());
  for (const participantCount of [1, 100]) {
    const created = await api.request<SessionResponse>('POST', '/api/rooms', {
      ...initialRoom,
      participantCount,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.room.participantCount, participantCount);
    assert.equal(created.data.room.members.length, 1);
    if (participantCount === 1) {
      const route = `/api/rooms/${created.data.room.id}`;
      assert.equal(
        (await api.request('POST', `${route}/members`, { name: '追加参加' })).status,
        409,
      );
      const selected = await api.request(
        'PUT',
        `${route}/selection`,
        { itemIds: ['pasta', 'salad'], done: true },
        created.data.identity.token,
      );
      assert.equal(
        (
          await api.request(
            'POST',
            `${route}/close`,
            { closed: true, version: selected.data.version },
            created.data.identity.token,
          )
        ).status,
        200,
      );
    }
  }
  for (const participantCount of [0, -1, 1.5, 101, '2', null, true]) {
    const invalid = await api.request<{ error: string }>('POST', '/api/rooms', {
      ...initialRoom,
      participantCount,
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.data.error, /割り勘人数は 1〜100 人/);
  }
  const legacy = await api.request<SessionResponse>('POST', '/api/rooms', initialRoom);
  assert.equal(legacy.status, 201);
  assert.equal(Object.hasOwn(legacy.data.room, 'participantCount'), false);
});

test('participant count persists and gates closing, concurrent joins, and replacement members', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'receipt-split-count-test-'));
  const dbPath = path.join(directory, 'rooms.sqlite');
  let api = await start(dbPath);
  context.after(async () => {
    await api.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const created = await api.request<SessionResponse>('POST', '/api/rooms', {
    ...initialRoom,
    participantCount: 2,
  });
  assert.equal(created.status, 201);
  const { room, identity: payer } = created.data;
  const route = `/api/rooms/${room.id}`;
  const selected = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['pasta', 'salad'], done: true },
    payer.token,
  );
  const earlyClose = await api.request<{ error: string }>(
    'POST',
    `${route}/close`,
    { closed: true, version: selected.data.version },
    payer.token,
  );
  assert.equal(earlyClose.status, 409);
  assert.match(earlyClose.data.error, /全員の参加/);
  await api.stop();
  api = await start(dbPath);
  const loaded = await api.request('GET', route);
  assert.deepEqual(loaded.data, selected.data);
  assert.equal(loaded.data.participantCount, 2);

  const results = await Promise.all(
    ['参加者 A', '参加者 B'].map((name) =>
      api.request<SessionResponse | { error: string }>('POST', `${route}/members`, { name }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const winner = results.find((result) => result.status === 201)!.data as SessionResponse;
  const rejected = results.find((result) => result.status === 409)!.data as { error: string };
  assert.match(rejected.error, /設定した 2 人/);
  const latest = await api.request('GET', route);
  assert.equal(latest.data.members.length, 2);
  assert.equal(latest.data.version, selected.data.version + 1);
  const completed = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: [], done: true },
    winner.identity.token,
  );
  assert.equal(calculateSettlement(completed.data).ready, true);
  const removed = await api.request(
    'DELETE',
    `${route}/members/${winner.identity.memberId}`,
    {},
    payer.token,
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.data.participantCount, 2);
  assert.equal(calculateSettlement(removed.data).ready, false);
  assert.equal(
    (
      await api.request(
        'POST',
        `${route}/close`,
        { closed: true, version: removed.data.version },
        payer.token,
      )
    ).status,
    409,
  );
  const replacement = await api.request<SessionResponse>('POST', `${route}/members`, {
    name: winner.room.members.find((member) => member.id === winner.identity.memberId)!.name,
  });
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.data.identity.memberId, winner.identity.memberId);
  assert.equal(
    (
      await api.request(
        'PUT',
        `${route}/selection`,
        { itemIds: [], done: true },
        winner.identity.token,
      )
    ).status,
    403,
  );
  const ready = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: [], done: true },
    replacement.data.identity.token,
  );
  const closed = await api.request(
    'POST',
    `${route}/close`,
    { closed: true, version: ready.data.version },
    payer.token,
  );
  assert.equal(closed.status, 200);
  assert.equal(closed.data.closed, true);
});

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

test('individual quantities and shared items settle together, with partial quantities blocking close', async (context) => {
  const { api, room, payer, other } = await fixture(context, mixedRoom);
  const route = `/api/rooms/${room.id}`;
  assert.deepEqual(room.items, mixedRoom.items);
  await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['drink', 'shared'], quantities: { drink: 2 }, done: true },
    payer.token,
  );
  const partial = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['shared'], done: true },
    other.token,
  );
  const partialSettlement = calculateSettlement(partial.data);
  assert.equal(partialSettlement.ready, false);
  assert.equal(partialSettlement.unassignedCount, 1);
  assert.ok(partialSettlement.unassignedAmount > 0);
  assert.equal(
    (
      await api.request(
        'POST',
        `${route}/close`,
        { closed: true, version: partial.data.version },
        payer.token,
      )
    ).status,
    409,
  );
  const ready = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['drink', 'shared'], quantities: { drink: 1 }, done: true },
    other.token,
  );
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.data.selectionQuantities, {
    [payer.memberId]: { drink: 2 },
    [other.memberId]: { drink: 1 },
  });
  const settlement = calculateSettlement(ready.data);
  assert.equal(settlement.ready, true);
  assert.deepEqual(settlement.memberAmounts, { [payer.memberId]: 901, [other.memberId]: 600 });
  const closed = await api.request(
    'POST',
    `${route}/close`,
    { closed: true, version: ready.data.version },
    payer.token,
  );
  assert.equal(closed.status, 200);
  assert.equal(closed.data.closed, true);
  assert.equal(
    (
      await api.request(
        'PUT',
        `${route}/selection`,
        { itemIds: [], quantities: {}, done: false },
        payer.token,
      )
    ).status,
    409,
  );
});

test('invalid item quantities and selection quantities do not modify the room', async (context) => {
  const { api, room, payer } = await fixture(context, mixedRoom);
  for (const quantity of [0, -1, 1.5, 1000, '2', null]) {
    const invalid = { ...mixedRoom, items: [{ ...mixedRoom.items[0], quantity }] };
    assert.equal((await api.request('POST', '/api/rooms', invalid)).status, 400);
  }
  assert.equal(
    (
      await api.request('POST', '/api/rooms', {
        ...mixedRoom,
        items: [{ ...mixedRoom.items[0], splitMode: 'invalid' }],
      })
    ).status,
    400,
  );
  const route = `/api/rooms/${room.id}`;
  for (const quantities of [
    { drink: 0 },
    { drink: -1 },
    { drink: 1.5 },
    { drink: 1000 },
    { drink: '2' },
    { drink: null },
    { missing: 1 },
    { shared: 1 },
  ]) {
    assert.equal(
      (
        await api.request(
          'PUT',
          `${route}/selection`,
          { itemIds: ['drink', 'shared'], quantities, done: true },
          payer.token,
        )
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await api.request(
        'PUT',
        `${route}/selection`,
        { itemIds: [], quantities: { drink: 1 }, done: true },
        payer.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await api.request(
        'PUT',
        `${route}/selection`,
        { itemIds: ['drink', 'drink'], quantities: { drink: 1 }, done: true },
        payer.token,
      )
    ).status,
    400,
  );
  const tooMany = await api.request<{ error: string }>(
    'PUT',
    `${route}/selection`,
    { itemIds: ['drink'], quantities: { drink: 4 }, done: true },
    payer.token,
  );
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.data.error, /ドリンク.*レシートの数量 3/);
  const unchanged = await api.request('GET', route);
  assert.equal(unchanged.data.version, 2);
  assert.deepEqual(unchanged.data.selections[payer.memberId], []);
});

test('omitted quantities preserve previous choices, deselection clears them, and selection defaults to one', async (context) => {
  const { api, room, payer } = await fixture(context, mixedRoom);
  const route = `/api/rooms/${room.id}`;
  await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['drink'], quantities: { drink: 2 }, done: false },
    payer.token,
  );
  const done = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['drink'], done: true },
    payer.token,
  );
  assert.equal(done.data.selectionQuantities?.[payer.memberId].drink, 2);
  const deselected = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: [], done: false },
    payer.token,
  );
  assert.deepEqual(deselected.data.selectionQuantities?.[payer.memberId], {});
  const selected = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['drink'], done: true },
    payer.token,
  );
  assert.equal(selected.data.selectionQuantities?.[payer.memberId].drink, 1);
});

test('concurrent claims for the final unit permit one writer and removal releases the quantity', async (context) => {
  const input = { ...mixedRoom, items: [{ ...mixedRoom.items[0], quantity: 2 }] };
  const { api, room, payer, other } = await fixture(context, input);
  const route = `/api/rooms/${room.id}`;
  const joined = await api.request<SessionResponse>('POST', `${route}/members`, { name: 'なつ' });
  const third = joined.data.identity;
  await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['drink'], quantities: { drink: 1 }, done: true },
    payer.token,
  );
  const identities = [other, third];
  const results = await Promise.all(
    identities.map((identity) =>
      api.request(
        'PUT',
        `${route}/selection`,
        { itemIds: ['drink'], quantities: { drink: 1 }, done: true },
        identity.token,
      ),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const winner = identities[results.findIndex((result) => result.status === 200)];
  const loser = identities[results.findIndex((result) => result.status === 409)];
  const latest = await api.request('GET', route);
  assert.equal(latest.data.version, 5);
  assert.deepEqual(latest.data.selections[loser.memberId], []);
  assert.deepEqual(latest.data.selectionQuantities?.[winner.memberId], { drink: 1 });
  const removed = await api.request(
    'DELETE',
    `${route}/members/${winner.memberId}`,
    {},
    payer.token,
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.data.selectionQuantities?.[winner.memberId], undefined);
  assert.equal(
    (
      await api.request(
        'PUT',
        `${route}/selection`,
        { itemIds: ['drink'], quantities: { drink: 1 }, done: true },
        loser.token,
      )
    ).status,
    200,
  );
});

test('quantity selections and split modes survive a server restart', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'receipt-split-quantity-test-'));
  const dbPath = path.join(directory, 'rooms.sqlite');
  let api = await start(dbPath);
  context.after(async () => {
    await api.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const created = await api.request<SessionResponse>('POST', '/api/rooms', mixedRoom);
  const { room, identity } = created.data;
  const route = `/api/rooms/${room.id}`;
  const selected = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['drink', 'shared'], quantities: { drink: 3 }, done: false },
    identity.token,
  );
  await api.stop();
  api = await start(dbPath);
  const loaded = await api.request('GET', route);
  assert.deepEqual(loaded.data, selected.data);
  const done = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['drink', 'shared'], done: true },
    identity.token,
  );
  assert.equal(done.status, 200);
  assert.equal(done.data.selectionQuantities?.[identity.memberId].drink, 3);
  assert.equal(calculateSettlement(done.data).ready, true);
});

test('fixed participant calculation requires its initial count and preserves legacy rooms', async (context) => {
  const api = await start();
  context.after(() => api.stop());
  for (const input of [
    { ...fixedRoom, participantCount: undefined },
    { ...fixedRoom, participantCount: null },
    { ...fixedRoom, calculationMode: 'unknown' },
  ]) {
    assert.equal((await api.request('POST', '/api/rooms', input)).status, 400);
  }
  const created = await api.request<SessionResponse>('POST', '/api/rooms', fixedRoom);
  assert.equal(created.status, 201);
  assert.equal(created.data.room.calculationMode, 'fixed-participants');
  assert.equal(created.data.room.participantCount, 4);
  const legacy = await api.request<SessionResponse>('POST', '/api/rooms', {
    ...initialRoom,
    participantCount: 4,
  });
  assert.equal(legacy.status, 201);
  assert.equal(Object.hasOwn(legacy.data.room, 'calculationMode'), false);
  assert.equal(calculateSettlement(legacy.data.room).memberAmounts[legacy.data.room.payerId], 0);
});

test('fixed participant amounts stay 900 yen as other people join, change, and leave', async (context) => {
  const api = await start();
  context.after(() => api.stop());
  const created = await api.request<SessionResponse>('POST', '/api/rooms', fixedRoom);
  assert.equal(created.status, 201);
  const { room, identity: payer } = created.data;
  const route = `/api/rooms/${room.id}`;
  const select = async (token: string, quantity: number, done = true) => {
    const response = await api.request(
      'PUT',
      `${route}/selection`,
      { itemIds: quantity ? ['beer'] : [], quantities: quantity ? { beer: quantity } : {}, done },
      token,
    );
    assert.equal(response.status, 200);
    return response.data;
  };
  const expectPayerAmount = (current: Room) => {
    const settlement = calculateSettlement(current);
    assert.equal(settlement.memberAmounts[payer.memberId], 900);
    assert.equal(
      Object.values(settlement.memberAmounts).reduce((sum, amount) => sum + amount, 0) +
        settlement.unassignedAmount,
      3_000,
    );
    return settlement;
  };
  const selected = await select(payer.token, 1);
  const initial = expectPayerAmount(selected);
  assert.equal(initial.pendingParticipantAmount, 900);
  assert.equal(initial.ready, false);
  const earlyClose = await api.request(
    'POST',
    `${route}/close`,
    { closed: true, version: selected.version },
    payer.token,
  );
  assert.equal(earlyClose.status, 409);
  const joined = await api.request<SessionResponse>('POST', `${route}/members`, { name: 'はる' });
  assert.equal(joined.status, 201);
  expectPayerAmount(joined.data.room);
  const other = joined.data.identity;
  expectPayerAmount(await select(other.token, 2));
  expectPayerAmount(await select(other.token, 0, false));
  expectPayerAmount(await select(other.token, 1));
  const accidental = await api.request<SessionResponse>('POST', `${route}/members`, {
    name: 'まちがえて参加',
  });
  assert.equal(accidental.status, 201);
  expectPayerAmount(await select(accidental.data.identity.token, 1));
  const removed = await api.request(
    'DELETE',
    `${route}/members/${accidental.data.identity.memberId}`,
    {},
    payer.token,
  );
  assert.equal(removed.status, 200);
  expectPayerAmount(removed.data);
  assert.equal(removed.data.participantCount, 4);
  assert.equal(calculateSettlement(removed.data).pendingParticipantAmount, 600);
  assert.equal(
    (
      await api.request(
        'PUT',
        `${route}/selection`,
        { itemIds: [], done: true },
        accidental.data.identity.token,
      )
    ).status,
    403,
  );
  const third = await api.request<SessionResponse>('POST', `${route}/members`, { name: 'なつ' });
  const fourth = await api.request<SessionResponse>('POST', `${route}/members`, { name: 'ふゆ' });
  assert.equal(third.status, 201);
  assert.equal(fourth.status, 201);
  await select(third.data.identity.token, 0);
  const incomplete = await select(fourth.data.identity.token, 0);
  expectPayerAmount(incomplete);
  assert.equal(calculateSettlement(incomplete).ready, false);
  assert.equal(
    (
      await api.request(
        'POST',
        `${route}/close`,
        { closed: true, version: incomplete.version },
        payer.token,
      )
    ).status,
    409,
  );
  const ready = await select(third.data.identity.token, 1);
  const settlement = expectPayerAmount(ready);
  assert.equal(settlement.ready, true);
  assert.equal(settlement.pendingParticipantAmount, 0);
  assert.equal(settlement.unassignedAmount, 0);
  assert.deepEqual(settlement.memberAmounts, {
    [payer.memberId]: 900,
    [other.memberId]: 900,
    [third.data.identity.memberId]: 900,
    [fourth.data.identity.memberId]: 300,
  });
  assert.equal(
    (
      await api.request(
        'POST',
        `${route}/close`,
        { closed: true, version: ready.version },
        other.token,
      )
    ).status,
    403,
  );
  const closed = await api.request(
    'POST',
    `${route}/close`,
    { closed: true, version: ready.version },
    payer.token,
  );
  assert.equal(closed.status, 200);
  assert.equal(closed.data.closed, true);
  expectPayerAmount(closed.data);
  assert.equal(
    (await api.request('PUT', `${route}/selection`, { itemIds: [], done: false }, other.token))
      .status,
    409,
  );
  const paid = await api.request(
    'PUT',
    `${route}/paid`,
    { memberId: other.memberId, paid: true },
    payer.token,
  );
  assert.equal(paid.status, 200);
  assert.deepEqual(paid.data.paidMemberIds, [other.memberId]);
  const reopened = await api.request(
    'POST',
    `${route}/close`,
    { closed: false, version: paid.data.version },
    payer.token,
  );
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.data.paidMemberIds, []);
  expectPayerAmount(reopened.data);
  expectPayerAmount(await select(other.token, 0, false));
});

test('fixed rooms reject automatic shared selections without changing room state', async (context) => {
  const api = await start();
  context.after(() => api.stop());
  const created = await api.request<SessionResponse>('POST', '/api/rooms', {
    ...fixedRoom,
    items: [...fixedRoom.items, { id: 'legacy-shared', name: '枝豆', amount: 300 }],
  });
  assert.equal(created.status, 201);
  const { room, identity } = created.data;
  const route = `/api/rooms/${room.id}`;
  for (const itemIds of [['food'], ['legacy-shared'], ['beer', 'food']]) {
    const invalid = await api.request<{ error: string }>(
      'PUT',
      `${route}/selection`,
      { itemIds, done: true },
      identity.token,
    );
    assert.equal(invalid.status, 400);
    assert.match(invalid.data.error, /自動で含まれます/);
  }
  assert.deepEqual((await api.request('GET', route)).data, room);
});

test('fixed room count, mode, selected quantities, and rounding survive restart', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'receipt-split-fixed-test-'));
  const dbPath = path.join(directory, 'rooms.sqlite');
  let api = await start(dbPath);
  context.after(async () => {
    await api.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const created = await api.request<SessionResponse>('POST', '/api/rooms', {
    ...fixedRoom,
    participantCount: 2,
    total: 3_001,
  });
  assert.equal(created.status, 201);
  const { room, identity } = created.data;
  const route = `/api/rooms/${room.id}`;
  const selected = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['beer'], quantities: { beer: 1 }, done: true },
    identity.token,
  );
  assert.equal(selected.status, 200);
  const before = calculateSettlement(selected.data);
  assert.equal(before.roundingAmount, 1);
  assert.equal(before.memberAmounts[identity.memberId], 1_201);
  await api.stop();
  api = await start(dbPath);
  const loaded = await api.request('GET', route);
  assert.deepEqual(loaded.data, selected.data);
  assert.equal(loaded.data.calculationMode, 'fixed-participants');
  const other = await api.request<SessionResponse>('POST', `${route}/members`, { name: 'はる' });
  const complete = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: ['beer'], quantities: { beer: 2 }, done: true },
    other.data.identity.token,
  );
  assert.equal(complete.status, 200);
  const settlement = calculateSettlement(complete.data);
  assert.deepEqual(settlement.memberAmounts, {
    [identity.memberId]: 1_201,
    [other.data.identity.memberId]: 1_800,
  });
  const closed = await api.request(
    'POST',
    `${route}/close`,
    { closed: true, version: complete.data.version },
    identity.token,
  );
  assert.equal(closed.status, 200);
  assert.equal(closed.data.closed, true);
});

test('fixed shared-only receipt completes without selecting a shared item', async (context) => {
  const api = await start();
  context.after(() => api.stop());
  const created = await api.request<SessionResponse>('POST', '/api/rooms', {
    ...fixedRoom,
    participantCount: 1,
    total: 1_200,
    items: [fixedRoom.items[1]],
  });
  assert.equal(created.status, 201);
  const { room, identity } = created.data;
  const route = `/api/rooms/${room.id}`;
  const complete = await api.request(
    'PUT',
    `${route}/selection`,
    { itemIds: [], done: true },
    identity.token,
  );
  assert.equal(complete.status, 200);
  const settlement = calculateSettlement(complete.data);
  assert.equal(settlement.memberAmounts[identity.memberId], 1_200);
  assert.equal(settlement.ready, true);
  const closed = await api.request(
    'POST',
    `${route}/close`,
    { closed: true, version: complete.data.version },
    identity.token,
  );
  assert.equal(closed.status, 200);
  assert.equal(closed.data.closed, true);
});
