import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt } from '../shared/parse-receipt.ts';

const entries = (text: string) =>
  parseReceipt(text).items.map(({ name, amount }) => ({ name, amount }));

test('Japanese receipt parses item prices and the payable total without payment or tax metadata', () => {
  const text = `居酒屋 はなび
東京都新宿区新宿1-2-3
TEL 03-1234-5678
2026/09/29 19:24
枝豆 ￥３８０
から揚げ ¥680
生ビール 2杯 1,200円
小計 ¥2,260
外税 ¥226
合計 ¥2,486
現金 ¥3,000
お釣り ¥514
ポイント 24
登録番号 T1234567890123`;
  const receipt = parseReceipt(text);
  assert.deepEqual(
    receipt.items.map(({ name, amount }) => ({ name, amount })),
    [
      { name: '枝豆', amount: 380 },
      { name: 'から揚げ', amount: 680 },
      { name: '生ビール', amount: 1200 },
    ],
  );
  assert.equal(receipt.total, 2486);
  assert.equal(receipt.title, '居酒屋 はなび');
  assert.equal(receipt.rawText, text);
  assert.equal(new Set(receipt.items.map((item) => item.id)).size, 3);
});

test('fullwidth characters, tax markers and split item/price lines are recognized', () => {
  const receipt = parseReceipt(
    'カフェ 喫茶室\nコーヒー\n×２\n￥１，１００\nチーズケーキ ５５０円※\n合 計\n￥１，６５０',
  );
  assert.deepEqual(
    receipt.items.map(({ name, amount }) => ({ name, amount })),
    [
      { name: 'コーヒー', amount: 1100 },
      { name: 'チーズケーキ', amount: 550 },
    ],
  );
  assert.equal(receipt.total, 1650);
});

test('discounts reduce fallback total and do not become selectable items', () => {
  const receipt = parseReceipt('ランチ 1,000\nドリンク 200\n値引 -100\nクーポン 50\n割引\n-20');
  assert.deepEqual(
    receipt.items.map((item) => item.amount),
    [1000, 200],
  );
  assert.equal(receipt.total, 1030);
});

test('explicit total already includes discounts and wins over the item sum', () => {
  const receipt = parseReceipt(
    'パスタ 1,000\nセット 500\n値引 ▲200\n税込合計 ￥1,430\n内消費税 130',
  );
  assert.equal(receipt.total, 1430);
  assert.equal(receipt.items.length, 2);
});

test('unit-price/quantity columns use the last amount, without multiplying twice', () => {
  assert.deepEqual(entries('ビール 600 × 2 1,200\nサラダ 2皿 900'), [
    { name: 'ビール', amount: 1200 },
    { name: 'サラダ', amount: 900 },
  ]);
});

test('English totals, taxes, payment details and receipt numbers are filtered', () => {
  const receipt = parseReceipt(
    'CAFE TOKYO\nReceipt 145\nCoffee 450\nCake 550\nSubtotal 1000\nTax 100\nTOTAL 1100\nVISA 1100\nCHANGE 0\nTHANK YOU',
  );
  assert.deepEqual(
    receipt.items.map(({ name, amount }) => ({ name, amount })),
    [
      { name: 'Coffee', amount: 450 },
      { name: 'Cake', amount: 550 },
    ],
  );
  assert.equal(receipt.total, 1100);
});

test('subtotal is never used as final total and included tax is not duplicated', () => {
  const receipt = parseReceipt(
    'おにぎり 180 *\nお茶 120\n小計 300\n8%対象 180\n10%対象 120\n内消費税 24',
  );
  assert.equal(receipt.total, 300);
  assert.equal(receipt.items.length, 2);
});

test('dates, tax percentages and arbitrary numeric metadata do not create items', () => {
  assert.deepEqual(
    entries(
      '2026年9月29日\n19:32\nTEL 090-1234-5678\n登録番号 T1234567890123\n1234567890123\n税率 10%\n(8%対象) 200\nレジ 3\n担当 42\n人数 3\n伝票 No.32\n会員番号 12345',
    ),
    [],
  );
});

test('empty and unreadable text return an editable empty result', () => {
  assert.deepEqual(parseReceipt(''), { items: [], total: 0, title: 'レシートの精算', rawText: '' });
  assert.deepEqual(entries('***\n1234567890123\n¥900'), []);
});

test('an initial total does not hide the subsequent item table', () => {
  const receipt = parseReceipt('食堂\nご請求金額 800\nうどん 500\n天ぷら 300');
  assert.equal(receipt.total, 800);
  assert.equal(receipt.items.length, 2);
});

test('common variants of Japanese payable totals are recognized', () => {
  for (const label of ['合計金額', 'お支払い金額', 'お買上合計', '現計', '税込み合計']) {
    const receipt = parseReceipt(`お弁当 500\nレジ袋 3\n${label} 550`);
    assert.equal(receipt.total, 550, label);
    assert.deepEqual(
      receipt.items.map((item) => item.amount),
      [500, 3],
      label,
    );
  }
});

test('negative currency amounts work regardless of sign position', () => {
  const receipt = parseReceipt('定食 ¥800\n値引 -¥100\nクーポン ¥-50');
  assert.equal(receipt.total, 650);
  assert.equal(receipt.items.length, 1);
});

test('OCR yen backslashes belong to the price column, not to Japanese item names', () => {
  const receipt = parseReceipt(
    String.raw`食品館
ほうれん草              \158
国産豚こま切れ           \498
A\Bセット               \1,100
値引 -\50
合計\1,876
現金\2,000`,
  );
  assert.deepEqual(
    receipt.items.map(({ name, amount }) => ({ name, amount })),
    [
      { name: 'ほうれん草', amount: 158 },
      { name: '国産豚こま切れ', amount: 498 },
      { name: String.raw`A\Bセット`, amount: 1100 },
    ],
  );
  assert.equal(receipt.total, 1876, 'explicit total, including tax and discount, wins');
  assert.deepEqual(entries(String.raw`\500`), []);
});
