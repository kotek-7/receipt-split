import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateManifest,
  evaluateReceipt,
  manifestSchema,
  normalizeName,
  type Manifest,
} from '../scripts/receipt-eval/evaluate.ts';

test('receipt evaluation normalizes Japanese widths and spaces without erasing real name errors', () => {
  assert.equal(normalizeName(' Ａ　ビール\t３５０ｍｌ\n'), 'Aビール350ml');
  const result = evaluateReceipt(
    { total: 600, items: [{ name: 'Ａ ビール', amount: 600, quantity: 2 }] },
    { total: 600, items: [{ name: 'Aビール', amount: 600, quantity: 2 }] },
  );
  assert.equal(result.exactItems.f1, 1);
  assert.equal(result.totalExact, true);
  const wrongName = evaluateReceipt(
    { total: 600, items: [{ name: 'Aビール', amount: 600 }] },
    { total: 600, items: [{ name: 'aビール', amount: 600 }] },
  );
  assert.equal(wrongName.exactItems.f1, 0);
  assert.equal(wrongName.amountQuantity.f1, 1);
});

test('same-priced distinct products match by name regardless of row order', () => {
  const items = [
    { name: '生ビール', amount: 600 },
    { name: '唐揚げ', amount: 600 },
  ];
  const result = evaluateReceipt(
    { total: 1200, items },
    { total: 1200, items: [items[1], items[0]] },
  );
  assert.equal(result.exactItems.matched, 2);
  assert.equal(result.exactItems.f1, 1);
});

test('one prediction cannot satisfy duplicate expected rows', () => {
  const item = { name: '生ビール', amount: 600 };
  const result = evaluateReceipt(
    { total: 1200, items: [item, item] },
    { total: 1200, items: [item] },
  );
  assert.deepEqual(result.exactItems, {
    matched: 1,
    expected: 2,
    predicted: 1,
    falsePositives: 0,
    falseNegatives: 1,
    precision: 1,
    recall: 0.5,
    f1: 2 / 3,
  });
  assert.equal(result.amountQuantity.f1, 2 / 3);
});

test('repeated predictions lower precision and cannot inflate same-price matches', () => {
  const beer = { name: '生ビール', amount: 600 };
  const chicken = { name: '唐揚げ', amount: 600 };
  const result = evaluateReceipt(
    { total: 1200, items: [beer, chicken] },
    { total: 1200, items: [beer, beer, beer] },
  );
  assert.equal(result.exactItems.matched, 1);
  assert.equal(result.exactItems.precision, 1 / 3);
  assert.equal(result.exactItems.recall, 0.5);
  assert.equal(result.exactItems.f1, 0.4);
  assert.equal(result.amountQuantity.matched, 2);
  assert.equal(result.amountQuantity.f1, 0.8);
});

test('quantity is mandatory for matching and defaults only when absent', () => {
  const expected = { total: 1800, items: [{ name: '生ビール', amount: 1800, quantity: 3 }] };
  const wrongQuantity = evaluateReceipt(expected, {
    total: 1800,
    items: [{ name: '生ビール', amount: 1800 }],
  });
  assert.equal(wrongQuantity.exactItems.f1, 0);
  assert.equal(wrongQuantity.amountQuantity.f1, 0);
  assert.equal(wrongQuantity.totalExact, true);
  assert.equal(
    evaluateReceipt(
      { total: 600, items: [{ name: '生ビール', amount: 600 }] },
      { total: 600, items: [{ name: '生ビール', amount: 600, quantity: 1 }] },
    ).exactItems.f1,
    1,
  );
});

test('the correct total does not mask missing, wrong or extra item amounts', () => {
  const result = evaluateReceipt(
    {
      total: 900,
      items: [
        { name: '唐揚げ', amount: 1000 },
        { name: '値引', amount: -100 },
      ],
    },
    {
      total: 900,
      items: [
        { name: '唐揚げ', amount: 900 },
        { name: '値引', amount: -100 },
        { name: '電話', amount: 100 },
      ],
    },
  );
  assert.equal(result.exactItems.matched, 1);
  assert.equal(result.exactItems.f1, 0.4);
  assert.equal(result.totalExact, true);
});

const manifest: Manifest = {
  dataset: 'evaluation-test',
  revision: '1',
  license: 'test only',
  fixtures: [
    {
      id: 'dev-1',
      image: 'dev.png',
      split: 'dev',
      expected: { total: 600, items: [{ name: '生ビール', amount: 600 }] },
    },
    {
      id: 'holdout-1',
      image: 'holdout.png',
      split: 'holdout',
      expected: {
        total: 1800,
        items: [
          { name: '生ビール', amount: 600 },
          { name: '唐揚げ', amount: 700 },
          { name: '枝豆', amount: 500 },
        ],
      },
    },
  ],
};

test('dataset report uses micro F1, preserves the holdout split and counts failures', () => {
  const report = evaluateManifest(manifest, [
    { id: 'dev-1', prediction: manifest.fixtures[0].expected },
    { id: 'holdout-1', prediction: { total: null, items: [] }, error: 'OCR failed' },
  ]);
  assert.equal(report.summary.exactItems.matched, 1);
  assert.equal(report.summary.exactItems.f1, 0.4);
  assert.equal(report.summary.totalAccuracy, 0.5);
  assert.equal(report.summary.errors, 1);
  assert.equal(report.bySplit.dev.exactItems.f1, 1);
  assert.equal(report.bySplit.holdout.exactItems.f1, 0);
  assert.equal(report.bySplit.holdout.errors, 1);
  assert.equal(report.fixtures[1].totalExact, false);
});

test('missing, duplicate and unknown predictions are never silently dropped', () => {
  const dev = { id: 'dev-1', prediction: manifest.fixtures[0].expected };
  assert.throws(() => evaluateManifest(manifest, [dev]), /Missing prediction: holdout-1/);
  assert.throws(() => evaluateManifest(manifest, [dev, dev]), /Duplicate prediction: dev-1/);
  assert.throws(
    () => evaluateManifest(manifest, [{ ...dev, id: 'wrong' }]),
    /Unknown prediction: wrong/,
  );
  const report = evaluateManifest(manifest, [dev], 'dev');
  assert.equal(report.summary.fixtures, 1);
  assert.equal(report.bySplit.holdout.totalAccuracy, null);
  assert.equal(report.bySplit.holdout.exactItems.precision, null);
  assert.equal(report.bySplit.holdout.exactItems.recall, null);
  assert.equal(report.bySplit.holdout.exactItems.f1, null);
  assert.equal(report.bySplit.holdout.amountQuantity.f1, null);
});

test('empty receipt and failed OCR have distinct total outcomes', () => {
  const empty = { total: 0, items: [] };
  assert.equal(evaluateReceipt(empty, empty).exactItems.f1, 1);
  assert.equal(evaluateReceipt(empty, empty).totalExact, true);
  assert.equal(evaluateReceipt(empty, { total: null, items: [] }).totalExact, false);
  assert.equal(
    evaluateReceipt(empty, { total: 100, items: [{ name: 'noise', amount: 100 }] }).exactItems.f1,
    0,
  );
});

test('manifest rejects ambiguous IDs, invalid quantities and unassigned splits', () => {
  assert.deepEqual(manifestSchema.parse(manifest), manifest);
  assert.throws(() =>
    manifestSchema.parse({ ...manifest, fixtures: [manifest.fixtures[0], manifest.fixtures[0]] }),
  );
  assert.throws(() =>
    manifestSchema.parse({
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0], split: 'train' }],
    }),
  );
  assert.throws(() =>
    manifestSchema.parse({
      ...manifest,
      fixtures: [
        {
          ...manifest.fixtures[0],
          expected: { total: 600, items: [{ name: 'beer', amount: 600, quantity: 0 }] },
        },
      ],
    }),
  );
});
