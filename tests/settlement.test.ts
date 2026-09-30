import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateSettlement,
  getItemQuantity,
  getItemSplitMode,
  getSelectionQuantity,
} from '../shared/settlement';
import type { Room } from '../shared/types';

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room',
    title: '夕ごはん',
    payerId: 'a',
    items: [
      { id: 'one', name: 'パスタ', amount: 1_000 },
      { id: 'two', name: 'サラダ', amount: 500 },
    ],
    total: 1_500,
    members: [
      { id: 'a', name: 'あき', done: true },
      { id: 'b', name: 'ぼん', done: true },
    ],
    selections: { a: ['one'], b: ['two'] },
    paidMemberIds: [],
    closed: false,
    createdAt: '',
    updatedAt: '',
    version: 1,
    ...overrides,
  };
}

test('separate orders and zero selections include every member', () => {
  const result = calculateSettlement(
    room({
      members: [...room().members, { id: 'c', name: 'ちえ', done: true }],
    }),
  );
  assert.deepEqual(result.memberAmounts, { a: 1_000, b: 500, c: 0 });
  assert.equal(result.roundingAmount, 0);
  assert.equal(result.pendingParticipantAmount, 0);
  assert.equal(result.ready, true);
});

test('shared items split integer yen in stable room member order', () => {
  const result = calculateSettlement(
    room({
      items: [{ id: 'one', name: 'シェア', amount: 101 }],
      total: 101,
      selections: { b: ['one'], a: ['one'] },
    }),
  );
  assert.deepEqual(result.memberAmounts, { a: 51, b: 50 });
  assert.deepEqual(result.itemAllocations[0].memberAmounts, { a: 51, b: 50 });
  assert.equal(
    Object.values(result.memberAmounts).reduce((sum, amount) => sum + amount, 0),
    101,
  );
});

test('receipt total proportionally includes tax exactly once', () => {
  const result = calculateSettlement(room({ total: 1_650 }));
  assert.deepEqual(result.memberAmounts, { a: 1_100, b: 550 });
  assert.deepEqual(
    result.itemAllocations.map((item) => item.amount),
    [1_100, 550],
  );
});

test('discounts use the same proportional rule and preserve the receipt total', () => {
  const result = calculateSettlement(room({ total: 1_000 }));
  assert.deepEqual(result.memberAmounts, { a: 667, b: 333 });
  assert.equal(result.unassignedAmount, 0);
});

test('largest row remainder wins, with stable input order for ties', () => {
  const result = calculateSettlement(
    room({
      items: [
        { id: 'one', name: 'A', amount: 1 },
        { id: 'two', name: 'B', amount: 1 },
        { id: 'three', name: 'C', amount: 1 },
      ],
      total: 5,
      selections: { a: ['one', 'three'], b: ['two'] },
    }),
  );
  assert.deepEqual(
    result.itemAllocations.map((item) => item.amount),
    [2, 2, 1],
  );
  assert.deepEqual(result.memberAmounts, { a: 3, b: 2 });
});

test('unassigned amounts stay explicit instead of being charged to other members', () => {
  const result = calculateSettlement(room({ total: 1_001, selections: { a: ['one'], b: [] } }));
  assert.deepEqual(result.memberAmounts, { a: 667, b: 0 });
  assert.equal(result.unassignedAmount, 334);
  assert.equal(result.unassignedCount, 1);
  assert.equal(result.assignedCount, 1);
  assert.equal(result.ready, false);
  assert.equal(
    Object.values(result.memberAmounts).reduce((sum, amount) => sum + amount, 0) +
      result.unassignedAmount,
    1_001,
  );
});

test('all participants must finish and zero-yen rounded rows still require selection', () => {
  assert.equal(
    calculateSettlement(
      room({ members: [{ id: 'a', name: 'あき', done: false }, room().members[1]] }),
    ).ready,
    false,
  );
  const result = calculateSettlement(room({ total: 1, selections: { a: ['one'], b: [] } }));
  assert.equal(result.unassignedAmount, 0);
  assert.equal(result.unassignedCount, 1);
  assert.equal(result.ready, false);
});

test('all expected participants must join and finish before settlement is ready', () => {
  const pending = room({ participantCount: 3 });
  const beforeJoin = calculateSettlement(pending);
  assert.equal(beforeJoin.unassignedCount, 0);
  assert.equal(beforeJoin.ready, false);
  assert.deepEqual(beforeJoin.memberAmounts, { a: 1_000, b: 500 });
  pending.members.push({ id: 'c', name: 'ちえ', done: false });
  assert.equal(calculateSettlement(pending).ready, false);
  pending.members[2].done = true;
  assert.equal(calculateSettlement(pending).ready, true);
  pending.members.pop();
  assert.equal(calculateSettlement(pending).ready, false);
  assert.equal(calculateSettlement(room()).ready, true);
});

test('combined row rounding and shared rounding conserve all yen for varied receipts', () => {
  for (let total = 1; total <= 127; total++) {
    const result = calculateSettlement(
      room({
        total,
        items: [1, 3, 7, 11].map((amount, index) => ({
          id: String(index),
          name: String(index),
          amount,
        })),
        selections: { a: ['0', '1', '2'], b: ['1', '2'] },
      }),
    );
    assert.equal(
      result.itemAllocations.reduce((sum, item) => sum + item.amount, 0),
      total,
    );
    assert.equal(
      Object.values(result.memberAmounts).reduce((sum, amount) => sum + amount, 0) +
        result.unassignedAmount,
      total,
    );
    assert.ok(
      Object.values(result.memberAmounts).every(
        (amount) => Number.isInteger(amount) && amount >= 0,
      ),
    );
  }
});

test('two purchased units can belong to different members', () => {
  const result = calculateSettlement(
    room({
      items: [{ id: 'one', name: 'おにぎり', amount: 400, quantity: 2, splitMode: 'quantity' }],
      total: 400,
      selections: { a: ['one'], b: ['one'] },
      selectionQuantities: { a: { one: 1 }, b: { one: 1 } },
    }),
  );
  assert.deepEqual(result.memberAmounts, { a: 200, b: 200 });
  assert.equal(result.itemAllocations[0].unassignedQuantity, 0);
  assert.equal(result.assignedCount, 1);
  assert.equal(result.ready, true);
});

test('members pay for their own quantity with stable integer rounding', () => {
  const result = calculateSettlement(
    room({
      items: [{ id: 'one', name: 'おにぎり', amount: 1_000, quantity: 3, splitMode: 'quantity' }],
      total: 1_000,
      selections: { a: ['one'], b: ['one'] },
      selectionQuantities: { a: { one: 2 }, b: { one: 1 } },
    }),
  );
  assert.deepEqual(result.memberAmounts, { a: 667, b: 333 });
  assert.equal(result.unassignedCount, 0);
  assert.equal(result.ready, true);
});

test('quantity allocation and equal sharing coexist on one receipt', () => {
  const result = calculateSettlement(
    room({
      items: [
        { id: 'one', name: '飲み物', amount: 600, quantity: 3, splitMode: 'quantity' },
        { id: 'two', name: 'ピザ', amount: 501, quantity: 2, splitMode: 'equal' },
      ],
      total: 1_101,
      selections: { a: ['one', 'two'], b: ['one', 'two'] },
      selectionQuantities: { a: { one: 2, two: 2 }, b: { one: 1, two: 1 } },
    }),
  );
  assert.deepEqual(
    result.itemAllocations.map((item) => item.memberAmounts),
    [
      { a: 400, b: 200 },
      { a: 251, b: 250 },
    ],
  );
  assert.deepEqual(result.memberAmounts, { a: 651, b: 450 });
  assert.equal(result.ready, true);
});

test('unclaimed units keep their own amount instead of increasing another member share', () => {
  const result = calculateSettlement(
    room({
      items: [{ id: 'one', name: '飲み物', amount: 100, quantity: 3, splitMode: 'quantity' }],
      total: 100,
      selections: { a: ['one'], b: [] },
      selectionQuantities: { a: { one: 1 } },
    }),
  );
  assert.deepEqual(result.memberAmounts, { a: 33, b: 0 });
  assert.equal(result.itemAllocations[0].unassignedQuantity, 2);
  assert.equal(result.itemAllocations[0].unassignedAmount, 67);
  assert.equal(result.unassignedAmount, 67);
  assert.equal(result.unassignedCount, 1);
  assert.equal(result.assignedCount, 0);
  assert.equal(result.ready, false);
});

test('missing units prevent completion even when their share rounds to zero yen', () => {
  const result = calculateSettlement(
    room({
      items: [{ id: 'one', name: '飲み物', amount: 100, quantity: 2, splitMode: 'quantity' }],
      total: 1,
      selections: { a: ['one'], b: [] },
      selectionQuantities: { a: { one: 1 } },
    }),
  );
  assert.deepEqual(result.memberAmounts, { a: 1, b: 0 });
  assert.equal(result.itemAllocations[0].unassignedQuantity, 1);
  assert.equal(result.unassignedAmount, 0);
  assert.equal(result.unassignedCount, 1);
  assert.equal(result.ready, false);
});

test('unselected quantity and shared items report all missing units', () => {
  const result = calculateSettlement(
    room({
      items: [
        { id: 'one', name: '飲み物', amount: 600, quantity: 3, splitMode: 'quantity' },
        { id: 'two', name: 'ピザ', amount: 400, quantity: 2, splitMode: 'equal' },
      ],
      total: 1_000,
      selections: { a: [], b: [] },
    }),
  );
  assert.deepEqual(
    result.itemAllocations.map((item) => item.unassignedQuantity),
    [3, 2],
  );
  assert.equal(result.unassignedAmount, 1_000);
  assert.equal(result.unassignedCount, 2);
  assert.equal(result.ready, false);
});

test('legacy selections default to one unit and old items keep equal sharing', () => {
  const legacy = room({ selections: { a: ['one'], b: ['one'] } });
  assert.equal(getItemQuantity(legacy.items[0]), 1);
  assert.equal(getItemSplitMode(legacy.items[0]), 'equal');
  assert.equal(getSelectionQuantity(legacy, 'a', legacy.items[0]), 1);
  assert.equal(getSelectionQuantity(legacy, 'b', legacy.items[1]), 0);
  assert.deepEqual(calculateSettlement(legacy).itemAllocations[0].memberAmounts, {
    a: 500,
    b: 500,
  });

  const quantityRoom = room({
    items: [{ id: 'one', name: '飲み物', amount: 600, quantity: 3, splitMode: 'quantity' }],
    total: 600,
    selections: { a: ['one'], b: ['one'] },
  });
  assert.equal(getSelectionQuantity(quantityRoom, 'a', quantityRoom.items[0]), 1);
  const result = calculateSettlement(quantityRoom);
  assert.deepEqual(result.memberAmounts, { a: 200, b: 200 });
  assert.equal(result.itemAllocations[0].unassignedQuantity, 1);
  assert.equal(result.unassignedAmount, 200);
});

test('stale quantity values do not select items or weight equal shares', () => {
  const state = room({
    items: [{ id: 'one', name: 'ピザ', amount: 101, quantity: 3, splitMode: 'equal' }],
    total: 101,
    selections: { a: ['one'], b: [] },
    selectionQuantities: { a: { one: 3 }, b: { one: 2 } },
  });
  assert.equal(getSelectionQuantity(state, 'a', state.items[0]), 1);
  assert.equal(getSelectionQuantity(state, 'b', state.items[0]), 0);
  assert.deepEqual(calculateSettlement(state).memberAmounts, { a: 101, b: 0 });
});

test('tax, discounts, and rounding preserve totals across quantity and equal items', () => {
  for (let total = 1; total <= 1_203; total++) {
    const result = calculateSettlement(
      room({
        items: [
          { id: 'one', name: '飲み物', amount: 600, quantity: 3, splitMode: 'quantity' },
          { id: 'two', name: 'ピザ', amount: 401, splitMode: 'equal' },
        ],
        total,
        selections: { a: ['one', 'two'], b: ['two'] },
        selectionQuantities: { a: { one: 2 } },
      }),
    );
    for (const item of result.itemAllocations) {
      assert.equal(
        Object.values(item.memberAmounts).reduce((sum, amount) => sum + amount, 0) +
          item.unassignedAmount,
        item.amount,
      );
    }
    assert.equal(
      Object.values(result.memberAmounts).reduce((sum, amount) => sum + amount, 0) +
        result.unassignedAmount,
      total,
    );
    assert.equal(result.itemAllocations[0].unassignedQuantity, 1);
    assert.equal(result.ready, false);
  }
});

function fixedRoom(overrides: Partial<Room> = {}): Room {
  return room({
    calculationMode: 'fixed-participants',
    participantCount: 4,
    items: [
      { id: 'beer', name: '生ビール', amount: 1_800, quantity: 3, splitMode: 'quantity' },
      { id: 'food', name: '唐揚げ', amount: 1_200, quantity: 1, splitMode: 'equal' },
    ],
    total: 3_000,
    members: [
      ...room().members,
      { id: 'c', name: 'ちえ', done: true },
      { id: 'd', name: 'だい', done: true },
    ],
    selections: { a: ['beer'], b: ['beer'], c: ['beer'], d: [] },
    selectionQuantities: { a: { beer: 1 }, b: { beer: 1 }, c: { beer: 1 } },
    ...overrides,
  });
}

function fixedSettlement(state: Room) {
  const result = calculateSettlement(state);
  for (const item of result.itemAllocations) {
    assert.equal(
      Object.values(item.memberAmounts).reduce((sum, amount) => sum + amount, 0) +
        item.unassignedAmount +
        item.roundingAmount!,
      item.amount,
      `item ${item.itemId} must retain every yen`,
    );
  }
  assert.equal(
    Object.values(result.memberAmounts).reduce((sum, amount) => sum + amount, 0) +
      result.unassignedAmount,
    state.total,
    'the receipt total must include pending shares, unclaimed units, and payer rounding once',
  );
  assert.equal(
    result.roundingAmount,
    result.itemAllocations.reduce((sum, item) => sum + item.roundingAmount!, 0),
  );
  for (const member of state.members) {
    assert.equal(
      result.memberAmounts[member.id],
      result.itemAllocations.reduce((sum, item) => sum + (item.memberAmounts[member.id] ?? 0), 0) +
        (member.id === state.payerId ? result.roundingAmount : 0),
      'only the payer receives the separately reported rounding amount',
    );
  }
  return result;
}

test('fixed participants pay 600 yen for one beer plus 300 yen for food shared by four', () => {
  const result = fixedSettlement(fixedRoom());
  assert.deepEqual(result.memberAmounts, { a: 900, b: 900, c: 900, d: 300 });
  assert.deepEqual(result.itemAllocations[1].memberAmounts, { a: 300, b: 300, c: 300, d: 300 });
  assert.equal(result.unassignedAmount, 0);
  assert.equal(result.pendingParticipantAmount, 0);
  assert.equal(result.roundingAmount, 0);
  assert.equal(result.ready, true);
});

test('fixed prices and payer rounding survive other members joining, selecting, and leaving', () => {
  const state = fixedRoom({
    items: [
      { id: 'beer', name: '生ビール', amount: 101, quantity: 3, splitMode: 'quantity' },
      { id: 'food', name: '唐揚げ', amount: 103, splitMode: 'equal' },
    ],
    total: 204,
    members: room().members,
    selections: { a: ['beer'], b: ['beer'] },
    selectionQuantities: { a: { beer: 1 }, b: { beer: 1 } },
  });
  const initial = fixedSettlement(state);
  assert.deepEqual(initial.memberAmounts, { a: 63, b: 58 });
  assert.equal(initial.roundingAmount, 5);
  assert.equal(initial.pendingParticipantAmount, 50);
  assert.equal(initial.unassignedAmount, 83);
  const unchanged = () => {
    const result = fixedSettlement(state);
    assert.equal(result.memberAmounts.a, initial.memberAmounts.a);
    assert.equal(result.memberAmounts.b, initial.memberAmounts.b);
    assert.equal(result.roundingAmount, initial.roundingAmount);
    return result;
  };
  state.members.push({ id: 'c', name: 'ちえ', done: false });
  state.selections.c = [];
  assert.equal(unchanged().pendingParticipantAmount, 25);
  state.selections.c = ['beer'];
  state.selectionQuantities!.c = { beer: 1 };
  assert.equal(unchanged().unassignedAmount, 25);
  state.members[2].done = true;
  state.members.push({ id: 'd', name: 'だい', done: true });
  state.selections.d = [];
  assert.equal(unchanged().ready, true);
  state.members = state.members.filter((member) => member.id !== 'c');
  delete state.selections.c;
  delete state.selectionQuantities!.c;
  const removed = unchanged();
  assert.equal(removed.pendingParticipantAmount, 25);
  assert.equal(removed.unassignedAmount, 58);
  assert.equal(removed.ready, false);
  state.members.reverse();
  unchanged();
});

test('fixed shared-only receipts need no selections but wait for the original count and completion', () => {
  const state = fixedRoom({
    participantCount: 3,
    items: [{ id: 'food', name: '唐揚げ', amount: 101, quantity: 5, splitMode: 'equal' }],
    total: 101,
    members: [room().members[0]],
    selections: { a: [] },
    selectionQuantities: {},
  });
  const pending = fixedSettlement(state);
  assert.deepEqual(pending.memberAmounts, { a: 35 });
  assert.equal(pending.itemAllocations[0].unassignedQuantity, 0);
  assert.equal(pending.unassignedCount, 0);
  assert.equal(pending.assignedCount, 1);
  assert.equal(pending.pendingParticipantAmount, 66);
  assert.equal(pending.unassignedAmount, 66);
  assert.equal(pending.ready, false);
  state.members.push({ id: 'b', name: 'ぼん', done: false }, { id: 'c', name: 'ちえ', done: true });
  state.selections.b = [];
  state.selections.c = [];
  const unfinished = fixedSettlement(state);
  assert.deepEqual(unfinished.memberAmounts, { a: 35, b: 33, c: 33 });
  assert.equal(unfinished.pendingParticipantAmount, 0);
  assert.equal(unfinished.ready, false);
  state.members[1].done = true;
  assert.equal(fixedSettlement(state).ready, true);
  // Old/stale shared selections never change the automatic per-person share.
  state.selections.b = ['food'];
  state.selectionQuantities!.b = { food: 5 };
  assert.deepEqual(fixedSettlement(state).memberAmounts, unfinished.memberAmounts);
});

test('one fixed participant pays the full receipt including all shared food and rounding', () => {
  const result = fixedSettlement(
    fixedRoom({
      participantCount: 1,
      items: [
        { id: 'beer', name: '生ビール', amount: 100, quantity: 3, splitMode: 'quantity' },
        { id: 'food', name: '唐揚げ', amount: 101, splitMode: 'equal' },
      ],
      total: 201,
      members: [room().members[0]],
      selections: { a: ['beer'] },
      selectionQuantities: { a: { beer: 3 } },
    }),
  );
  assert.deepEqual(result.memberAmounts, { a: 201 });
  assert.equal(result.roundingAmount, 1);
  assert.equal(result.unassignedAmount, 0);
  assert.equal(result.ready, true);
});

test('fixed units block completion even when their price rounds to zero', () => {
  const state = fixedRoom({
    participantCount: 2,
    items: [{ id: 'beer', name: '生ビール', amount: 100, quantity: 2, splitMode: 'quantity' }],
    total: 1,
    members: room().members,
    selections: { a: ['beer'], b: [] },
    selectionQuantities: { a: { beer: 1 } },
  });
  const pending = fixedSettlement(state);
  assert.deepEqual(pending.memberAmounts, { a: 1, b: 0 });
  assert.equal(pending.roundingAmount, 1);
  assert.equal(pending.unassignedAmount, 0);
  assert.equal(pending.unassignedCount, 1);
  assert.equal(pending.itemAllocations[0].unassignedQuantity, 1);
  assert.equal(pending.ready, false);
  state.selections.b = ['beer'];
  state.selectionQuantities!.b = { beer: 1 };
  assert.equal(fixedSettlement(state).ready, true);
});

test('fixed shares preserve tax, discounts, unclaimed units, pending participants, and every rounding yen', () => {
  for (let total = 1; total <= 257; total++) {
    const result = fixedSettlement(
      fixedRoom({
        items: [
          { id: 'beer', name: '生ビール', amount: 101, quantity: 3, splitMode: 'quantity' },
          { id: 'food', name: '唐揚げ', amount: 103, splitMode: 'equal' },
        ],
        total,
        members: room().members,
        selections: { a: ['beer'], b: ['beer'] },
        selectionQuantities: { a: { beer: 1 }, b: { beer: 1 } },
      }),
    );
    assert.equal(result.itemAllocations[0].unassignedQuantity, 1);
    assert.equal(result.unassignedCount, 1);
    assert.equal(result.ready, false);
    assert.ok(
      Object.values(result.memberAmounts).every(
        (amount) => Number.isInteger(amount) && amount >= 0,
      ),
    );
  }
});

test('fixed calculations cap corrupt quantity claims and excess participants to conserve totals', () => {
  const result = fixedSettlement(
    fixedRoom({
      participantCount: 2,
      items: [
        { id: 'beer', name: '生ビール', amount: 101, quantity: 3, splitMode: 'quantity' },
        { id: 'food', name: '唐揚げ', amount: 103, splitMode: 'equal' },
      ],
      total: 204,
      selectionQuantities: { a: { beer: 9 }, b: { beer: 9 }, c: { beer: 9 } },
    }),
  );
  assert.deepEqual(result.itemAllocations[0].memberAmounts, { a: 99 });
  assert.deepEqual(result.itemAllocations[1].memberAmounts, { a: 51, b: 51 });
  assert.deepEqual(result.memberAmounts, { a: 153, b: 51, c: 0, d: 0 });
  assert.equal(result.roundingAmount, 3);
  assert.equal(result.unassignedAmount, 0);
});
