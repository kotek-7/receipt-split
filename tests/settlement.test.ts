import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateSettlement } from '../shared/settlement';
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
