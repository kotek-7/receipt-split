import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildReceiptAiInput,
  parseReceiptAiResponse,
  ReceiptExtractionError,
} from '../shared/receipt-ai';

const item = { name: 'ビール', quantity: 3, amount: 1800, unitPrice: 600 };
const receipt = { title: '居酒屋', total: 1800, items: [item], adjustments: [] };
const envelope = (data: unknown) => ({
  choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }],
});

test('AI receipt preserves printed row totals without multiplying them by quantity', () => {
  const parsed = parseReceiptAiResponse(envelope(receipt));
  assert.equal(parsed.items[0].amount, 1800);
  assert.equal(parsed.items[0].quantity, 3);
  assert.equal(parsed.items[0].splitMode, 'quantity');
  assert.equal(parsed.total, 1800);
  assert.equal(parsed.rawText, '');
  assert.equal(parsed.warnings, undefined);
});

test('included tax does not become an item or cause double counting', () => {
  const parsed = parseReceiptAiResponse(
    envelope({ ...receipt, adjustments: [{ label: '内消費税', kind: 'tax', amount: 163 }] }),
  );
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.total, 1800);
  assert.equal(parsed.warnings, undefined);
});

test('external tax and receipt discounts reconcile without invented item rows', () => {
  const parsed = parseReceiptAiResponse(
    envelope({
      ...receipt,
      total: 1880,
      adjustments: [
        { label: '外税', kind: 'tax', amount: 180 },
        { label: 'クーポン', kind: 'discount', amount: -100 },
      ],
    }),
  );
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].amount, 1800);
  assert.equal(parsed.total, 1880);
  assert.equal(parsed.warnings, undefined);
});

test('unknown amounts and quantities stay invalid draft values for correction', () => {
  const parsed = parseReceiptAiResponse(
    envelope({ ...receipt, total: null, items: [{ ...item, amount: null, quantity: null }] }),
  );
  assert.equal(parsed.total, 0);
  assert.equal(parsed.items[0].amount, 0);
  assert.equal(parsed.items[0].quantity, 0);
  assert.equal(parsed.warnings?.length, 3);
});

test('AI reconciliation reports a mismatch instead of rewriting printed money', () => {
  const parsed = parseReceiptAiResponse(
    envelope({ ...receipt, total: 9999, items: [{ ...item, amount: 1700 }] }),
  );
  assert.equal(parsed.items[0].amount, 1700);
  assert.equal(parsed.total, 9999);
  assert.equal(parsed.warnings?.length, 2);
});

test('zero-price options are omitted but positive repeated rows remain separate', () => {
  const parsed = parseReceiptAiResponse(
    envelope({
      ...receipt,
      total: 3600,
      items: [item, { ...item, name: '氷多め', amount: 0 }, item],
    }),
  );
  assert.equal(parsed.items.length, 2);
  assert.notEqual(parsed.items[0].id, parsed.items[1].id);
});

test('AI schema rejects invalid money, counts, extra keys and excessive output', () => {
  const invalid = [
    { ...receipt, items: [{ ...item, quantity: 0 }] },
    { ...receipt, items: [{ ...item, quantity: 1000 }] },
    { ...receipt, items: [{ ...item, quantity: 1.5 }] },
    { ...receipt, items: [{ ...item, amount: -1 }] },
    { ...receipt, items: [{ ...item, amount: 1_000_001 }] },
    { ...receipt, items: [{ ...item, amount: '1800' }] },
    { ...receipt, items: [{ ...item, name: '品'.repeat(101) }] },
    { ...receipt, items: Array.from({ length: 101 }, () => item) },
    { ...receipt, total: 10_000_001 },
    { ...receipt, title: '店'.repeat(81) },
    { ...receipt, instruction: 'secret' },
    { ...receipt, adjustments: [{ label: 'discount', kind: 'discount', amount: 1 }] },
  ];
  for (const value of invalid)
    assert.throws(() => parseReceiptAiResponse(envelope(value)), ReceiptExtractionError);
});

test('AI extraction rejects empty, truncated and invalid JSON responses', () => {
  for (const response of [
    {},
    { choices: [] },
    { choices: [{ message: { content: 'not json' } }] },
    { choices: [{ message: { content: JSON.stringify(receipt) }, finish_reason: 'length' }] },
    envelope({ ...receipt, items: [] }),
    envelope({ ...receipt, items: [{ ...item, amount: 0 }] }),
  ])
    assert.throws(() => parseReceiptAiResponse(response), ReceiptExtractionError);
});

test('the AI request contains only a fixed extraction task and provided image', () => {
  const request = buildReceiptAiInput('data:image/png;base64,AAAA');
  assert.equal(request.response_format.type, 'json_object');
  assert.equal(request.chat_template_kwargs.enable_thinking, false);
  assert.equal(request.store, false);
  assert.equal(request.stream, false);
  assert.equal(request.messages[1].role, 'user');
  assert.match(JSON.stringify(request), /data:image\/png;base64,AAAA/);
  assert.match(JSON.stringify(request), /never invent/);
  assert.match(JSON.stringify(request), /NOT its unit price/);
});
