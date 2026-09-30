import assert from 'node:assert/strict';
import { calculateSettlement } from '../shared/settlement.ts';

const base = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
async function api(method, route, body, token, expected = 200) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return data;
}

await api('GET', '/health');
const input = {
  title: `動作確認 ${new Date().toISOString()}`,
  payerName: '動作確認・立替',
  total: 1_001,
  items: [
    { id: 'shared', name: 'シェア料理', amount: 600 },
    { id: 'drink', name: 'ドリンク', amount: 300 },
  ],
};
await api('POST', '/rooms', { ...input, total: -1 }, undefined, 400);
const created = await api('POST', '/rooms', input, undefined, 201);
const payer = created.identity;
const route = `/rooms/${created.room.id}`;
assert.match(created.room.id, /^[\w-]{32}$/);
assert.match(payer.token, /^[\w-]{43}$/);
const joined = await api('POST', `${route}/members`, { name: '動作確認・参加' }, undefined, 201);
const other = joined.identity;
await api('POST', `${route}/members`, { name: ' 動作確認・参加 ' }, undefined, 409);
await api('PUT', `${route}/selection`, { itemIds: ['shared'], done: true }, undefined, 403);
await api('PUT', `${route}/selection`, { itemIds: ['missing'], done: true }, payer.token, 400);
await api(
  'POST',
  `${route}/close`,
  { closed: true, version: joined.room.version },
  payer.token,
  409,
);
await Promise.all([
  api('PUT', `${route}/selection`, { itemIds: ['shared'], done: true }, payer.token),
  api('PUT', `${route}/selection`, { itemIds: ['shared', 'drink'], done: true }, other.token),
]);
let room = await api('GET', route);
assert.deepEqual(room.selections, {
  [payer.memberId]: ['shared'],
  [other.memberId]: ['shared', 'drink'],
});
assert.equal(room.version, 4);
assert.equal(JSON.stringify(room).includes(payer.token), false);
assert.equal(JSON.stringify(room).includes(other.token), false);
const settlement = calculateSettlement(room);
assert.deepEqual(settlement.memberAmounts, { [payer.memberId]: 334, [other.memberId]: 667 });
assert.equal(settlement.ready, true);
await api('POST', `${route}/close`, { closed: true, version: room.version }, other.token, 403);
await api('POST', `${route}/close`, { closed: true, version: room.version - 1 }, payer.token, 409);
room = await api('POST', `${route}/close`, { closed: true, version: room.version }, payer.token);
assert.equal(room.closed, true);
await api('PUT', `${route}/selection`, { itemIds: [], done: false }, other.token, 409);
await api('POST', `${route}/members`, { name: '参加不可' }, undefined, 409);
await api('DELETE', `${route}/members/${other.memberId}`, {}, payer.token, 409);
room = await api('PUT', `${route}/paid`, { memberId: other.memberId, paid: true }, payer.token);
assert.deepEqual(room.paidMemberIds, [other.memberId]);
room = await api('POST', `${route}/close`, { closed: false, version: room.version }, payer.token);
assert.equal(room.closed, false);
assert.deepEqual(room.paidMemberIds, []);
const mistaken = await api(
  'POST',
  `${route}/members`,
  { name: '動作確認・誤参加' },
  undefined,
  201,
);
await api('DELETE', `${route}/members/${mistaken.identity.memberId}`, {}, other.token, 403);
await api('DELETE', `${route}/members/${payer.memberId}`, {}, payer.token, 400);
room = await api('DELETE', `${route}/members/${mistaken.identity.memberId}`, {}, payer.token);
assert.equal(room.members.length, 2);
assert.equal(room.selections[mistaken.identity.memberId], undefined);
await api('PUT', `${route}/selection`, { itemIds: [], done: true }, mistaken.identity.token, 403);
assert.equal(calculateSettlement(room).ready, true);
room = await api('POST', `${route}/close`, { closed: true, version: room.version }, payer.token);
assert.equal(room.closed, true);
assert.equal(calculateSettlement(room).memberAmounts[other.memberId], 667);

const mixedInput = {
  title: '個別のドリンクとシェア料理',
  payerName: '個数確認・立替',
  total: 1_501,
  items: [
    { id: 'drink', name: 'ドリンク', amount: 900, quantity: 3, splitMode: 'quantity' },
    { id: 'shared', name: 'シェア料理', amount: 600, quantity: 1, splitMode: 'equal' },
  ],
};
await api(
  'POST',
  '/rooms',
  { ...mixedInput, items: [{ ...mixedInput.items[0], quantity: 1.5 }] },
  undefined,
  400,
);
const mixed = await api('POST', '/rooms', mixedInput, undefined, 201);
const mixedRoute = `/rooms/${mixed.room.id}`;
const mixedPayer = mixed.identity;
const mixedOther = (
  await api('POST', `${mixedRoute}/members`, { name: '個数確認・参加' }, undefined, 201)
).identity;
await api(
  'PUT',
  `${mixedRoute}/selection`,
  { itemIds: ['shared'], quantities: { shared: 1 }, done: true },
  mixedPayer.token,
  400,
);
await api(
  'PUT',
  `${mixedRoute}/selection`,
  { itemIds: ['drink'], quantities: { drink: 1.5 }, done: true },
  mixedPayer.token,
  400,
);
await api(
  'PUT',
  `${mixedRoute}/selection`,
  { itemIds: ['drink', 'shared'], quantities: { drink: 2 }, done: true },
  mixedPayer.token,
);
let mixedRoom = await api(
  'PUT',
  `${mixedRoute}/selection`,
  { itemIds: ['shared'], done: true },
  mixedOther.token,
);
assert.equal(calculateSettlement(mixedRoom).ready, false);
await api(
  'POST',
  `${mixedRoute}/close`,
  { closed: true, version: mixedRoom.version },
  mixedPayer.token,
  409,
);
mixedRoom = await api(
  'PUT',
  `${mixedRoute}/selection`,
  { itemIds: ['drink', 'shared'], quantities: { drink: 1 }, done: true },
  mixedOther.token,
);
assert.deepEqual(calculateSettlement(mixedRoom).memberAmounts, {
  [mixedPayer.memberId]: 901,
  [mixedOther.memberId]: 600,
});
mixedRoom = await api(
  'PUT',
  `${mixedRoute}/selection`,
  { itemIds: ['drink', 'shared'], done: true },
  mixedPayer.token,
);
assert.equal(mixedRoom.selectionQuantities[mixedPayer.memberId].drink, 2);
mixedRoom = await api(
  'POST',
  `${mixedRoute}/close`,
  { closed: true, version: mixedRoom.version },
  mixedPayer.token,
);
assert.equal(mixedRoom.closed, true);
await api(
  'PUT',
  `${mixedRoute}/selection`,
  { itemIds: [], quantities: {}, done: false },
  mixedOther.token,
  409,
);

const race = await api(
  'POST',
  '/rooms',
  { ...mixedInput, items: [{ ...mixedInput.items[0], quantity: 2 }] },
  undefined,
  201,
);
const raceRoute = `/rooms/${race.room.id}`;
const racers = await Promise.all(
  ['競合確認・A', '競合確認・B'].map(
    async (name) => (await api('POST', `${raceRoute}/members`, { name }, undefined, 201)).identity,
  ),
);
await api(
  'PUT',
  `${raceRoute}/selection`,
  { itemIds: ['drink'], quantities: { drink: 1 }, done: true },
  race.identity.token,
);
const raceResults = await Promise.all(
  racers.map(async (identity) => {
    const response = await fetch(`${base}/api${raceRoute}/selection`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` },
      body: JSON.stringify({ itemIds: ['drink'], quantities: { drink: 1 }, done: true }),
    });
    return { status: response.status, data: await response.json() };
  }),
);
assert.deepEqual(raceResults.map((result) => result.status).sort(), [200, 409]);
assert.match(raceResults.find((result) => result.status === 409).data.error, /購入数 2 個/);
const winner = racers[raceResults.findIndex((result) => result.status === 200)];
const loser = racers[raceResults.findIndex((result) => result.status === 409)];
const raceRoom = await api('GET', raceRoute);
assert.deepEqual(raceRoom.selections[loser.memberId], []);
const removedRaceRoom = await api(
  'DELETE',
  `${raceRoute}/members/${winner.memberId}`,
  {},
  race.identity.token,
);
assert.equal(removedRaceRoom.selectionQuantities[winner.memberId], undefined);
await api(
  'PUT',
  `${raceRoute}/selection`,
  { itemIds: ['drink'], quantities: { drink: 1 }, done: true },
  loser.token,
);

const oversized = await fetch(`${base}/api/rooms`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ padding: 'あ'.repeat(50_000) }),
});
assert.equal(oversized.status, 400);
await api('POST', route, input, undefined, 404);
await api('GET', '/unknown', undefined, undefined, 404);
const page = await fetch(`${base}/r/${room.id}`, { headers: { Accept: 'text/html' } });
assert.equal(page.status, 200);
assert.match(await page.text(), /id="root"/);
console.log(
  `Cloudflare smoke passed: mixed quantity/shared items, quantity race, persistent room, concurrent selections, exact yen, auth, freeze, removal, receive, reopen, SPA. ${base}/r/${room.id}`,
);
