import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt } from '../shared/parse-receipt.ts';

const entries = (text: string) =>
  parseReceipt(text).items.map(({ name, amount }) => ({ name, amount }));

const quantities = (text: string) =>
  parseReceipt(text).items.map(({ name, amount, quantity, splitMode }) => ({
    name,
    amount,
    quantity,
    splitMode,
  }));

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

test('explicit inline quantity columns preserve count and keep the amount as the row total', () => {
  const rows = [
    'ビール 600 × 2 1,200',
    'ビール 2杯 1,200',
    'ビール ×2 1,200',
    'ビール 2杯×単600 1,200',
  ];
  for (const row of rows) {
    assert.deepEqual(
      quantities(row),
      [{ name: 'ビール', amount: 1200, quantity: 2, splitMode: 'quantity' }],
      row,
    );
    assert.equal(parseReceipt(row).total, 1200, row);
  }
});

test('separate quantity lines survive until the following item price', () => {
  for (const quantityLine of ['×２', '2個', '数量:2']) {
    assert.deepEqual(
      quantities(`コーヒー\n${quantityLine}\n単価:550\n￥１，１００\nケーキ ¥500`),
      [
        { name: 'コーヒー', amount: 1100, quantity: 2, splitMode: 'quantity' },
        { name: 'ケーキ', amount: 500, quantity: undefined, splitMode: undefined },
      ],
      quantityLine,
    );
  }
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
  assert.deepEqual(parseReceipt(''), { items: [], total: 0, title: '飲み会の割り勘', rawText: '' });
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

test('quantity and unit-price continuation rows belong to the preceding product', () => {
  assert.deepEqual(entries('おにぎり\n3コX単138 ¥414\nお茶\n2個×単価138 ¥276\nパン ¥148'), [
    { name: 'おにぎり', amount: 414 },
    { name: 'お茶', amount: 276 },
    { name: 'パン', amount: 148 },
  ]);
});

test('quantity continuations tolerate fullwidth spacing and common multiplication OCR errors', () => {
  const rows = [
    '３ コ Ｘ 単 価 ￥１３８ ￥４１４',
    '3個×単価138円 414円',
    '3点x単138 414',
    '3コ X B138 ¥414',
    '3コメX単138 ¥414',
    '3コメ単138 \\414',
  ];
  for (const row of rows) {
    assert.deepEqual(
      entries(`商品\n${row}\n別の商品 ¥100`),
      [
        { name: '商品', amount: 414 },
        { name: '別の商品', amount: 100 },
      ],
      row,
    );
    const item = parseReceipt(`商品\n${row}`).items[0];
    assert.equal(item.quantity, 3, row);
    assert.equal(item.splitMode, 'quantity', row);
  }
});

test('an explicit quantity row total wins over unit multiplication, including on the next line', () => {
  assert.deepEqual(
    entries('セット割商品\n3コX単138 ¥400\nまとめ商品\n2個×単価138\n¥270\n普通の商品 ¥100'),
    [
      { name: 'セット割商品', amount: 400 },
      { name: 'まとめ商品', amount: 270 },
      { name: '普通の商品', amount: 100 },
    ],
  );
});

test('quantity metadata follows explicit and calculated continuation totals', () => {
  assert.deepEqual(
    quantities(
      'セット割商品\n3コX単138 ¥400\nまとめ商品\n2個×単価138\n¥270\n最後の商品\n2個×単価138',
    ),
    [
      { name: 'セット割商品', amount: 400, quantity: 3, splitMode: 'quantity' },
      { name: 'まとめ商品', amount: 270, quantity: 2, splitMode: 'quantity' },
      { name: '最後の商品', amount: 276, quantity: 2, splitMode: 'quantity' },
    ],
  );
});

test('quantity times unit price is used when no row total is printed', () => {
  const receipt = parseReceipt('おにぎり\n3コX単138\nお茶\n2個×単価138\n合計690');
  assert.deepEqual(
    receipt.items.map(({ name, amount }) => ({ name, amount })),
    [
      { name: 'おにぎり', amount: 414 },
      { name: 'お茶', amount: 276 },
    ],
  );
  assert.equal(receipt.total, 690);
  assert.deepEqual(entries('最後の商品\n2点X単1, 200'), [{ name: '最後の商品', amount: 2400 }]);
});

test('quantity details after an already priced product do not duplicate its amount', () => {
  assert.deepEqual(
    entries('お茶 ¥276\n2コX単138 ¥276\nパン ¥148\nおにぎり ¥414\n3コX単138\n¥414\n合計838'),
    [
      { name: 'お茶', amount: 276 },
      { name: 'パン', amount: 148 },
      { name: 'おにぎり', amount: 414 },
    ],
  );
});

test('quantity details immediately after a priced item add its count without replacing its amount', () => {
  assert.deepEqual(
    quantities('お茶 ¥270\n2コX単138 ¥276\nパン ¥148\nおにぎり ¥400\n3コX単138\n¥414'),
    [
      { name: 'お茶', amount: 270, quantity: 2, splitMode: 'quantity' },
      { name: 'パン', amount: 148, quantity: undefined, splitMode: undefined },
      { name: 'おにぎり', amount: 400, quantity: 3, splitMode: 'quantity' },
    ],
  );
});

test('quantity metadata is bounded and does not come from package sizes, models, or unit prices', () => {
  const receipt = parseReceipt(
    '飲料350m ¥236\n食品350 ¥276\n2個入りセット ¥100\n型番X2 ¥200\n単価:200\n単品 1個 ¥100\n誤読 0個 ¥100\n誤読大量 1000個 ¥100\n最大 999個 ¥999',
  );
  assert.deepEqual(
    receipt.items.map(({ quantity, splitMode }) => ({ quantity, splitMode })),
    [
      ...Array.from({ length: 7 }, () => ({ quantity: undefined, splitMode: undefined })),
      { quantity: 999, splitMode: 'quantity' },
    ],
  );
  assert.equal(receipt.total, 2111);
});

test('quantity counts do not leak across unrelated lines or an unpriced product', () => {
  assert.deepEqual(quantities('商品 ¥100\n小計 ¥100\n2コX単50\n未読の商品\n×3\n次の商品 ¥200'), [
    { name: '商品', amount: 100, quantity: undefined, splitMode: undefined },
    { name: '次の商品', amount: 200, quantity: undefined, splitMode: undefined },
  ]);
});

test('an incomplete quantity row does not consume or rename the following product', () => {
  assert.deepEqual(
    entries('読み取れなかった商品\n2コX単\n次の商品 ¥200\n最後の商品\n2コX単\n¥276'),
    [
      { name: '次の商品', amount: 200 },
      { name: '最後の商品', amount: 276 },
    ],
  );
  assert.deepEqual(quantities('まとめ商品\n2個×単100\n小計 ¥200\n4個'), [
    { name: 'まとめ商品', amount: 200, quantity: 2, splitMode: 'quantity' },
  ]);
});

test('category markers are removed while actual names and package numbers are kept', () => {
  assert.deepEqual(
    entries(
      'A 飲料350m\n2コX単118 ¥236\nB# 食品350\n2個×単138 ¥276\n# Aセット ¥100\nBEEF ¥200\n商品 3コX単138 ¥414',
    ),
    [
      { name: '飲料350m', amount: 236 },
      { name: '食品350', amount: 276 },
      { name: 'Aセット', amount: 100 },
      { name: 'BEEF', amount: 200 },
      { name: '商品', amount: 414 },
    ],
  );
});

test('spaced thousands separators remain a single price including payable totals', () => {
  const receipt = parseReceipt('食品 ¥1, 200\n飲料 2, 300円\n合計 ¥3, 500');
  assert.deepEqual(
    receipt.items.map((item) => item.amount),
    [1200, 2300],
  );
  assert.equal(receipt.total, 3500);
});

test('unreadable total and payment amounts do not fabricate leading digits or create products', () => {
  const receipt = parseReceipt('食品 ¥498\nお茶 ¥276\n合計 ギ\\クンク, 973\nクレジット ¥,973');
  assert.deepEqual(
    receipt.items.map((item) => item.amount),
    [498, 276],
  );
  assert.equal(receipt.total, 774, 'only the known item sum is available');
});

test('attached totals require a complete total label, not a numeric tail in OCR noise', () => {
  for (const malformed of ['合計 yl.e00', 'TOTAL yl.e00', '合計1.600', 'TOTAL1.600']) {
    const receipt = parseReceipt(`パン ¥400\n茶 ¥300\n${malformed}`);
    assert.deepEqual(
      receipt.items.map((item) => item.amount),
      [400, 300],
      malformed,
    );
    assert.equal(receipt.total, 700, malformed);
  }
  for (const valid of ['合計1600', 'total1600', '合 計1600', '税込み合計1600']) {
    assert.equal(parseReceipt(`食品 ¥1500\n${valid}`).total, 1600, valid);
  }
});

test('a separate trailing Y currency token can be an OCR yen sign', () => {
  const receipt = parseReceipt('食品 Y98\n茶 y450\n菓子\nY414\n飲料\n2コX単138 y276\n合計 Y1, 600');
  assert.deepEqual(
    receipt.items.map(({ name, amount }) => ({ name, amount })),
    [
      { name: '食品', amount: 98 },
      { name: '茶', amount: 450 },
      { name: '菓子', amount: 414 },
      { name: '飲料', amount: 276 },
    ],
  );
  assert.equal(receipt.total, 1600);
});

test('Y inside a product code is not currency and malformed OCR totals stay unreadable', () => {
  const receipt = parseReceipt('型番Y98\n¥200\n食品350\n¥100\nBEEF ¥300\n合計 yl.e00');
  assert.deepEqual(
    receipt.items.map(({ name, amount }) => ({ name, amount })),
    [
      { name: '型番Y98', amount: 200 },
      { name: '食品350', amount: 100 },
      { name: 'BEEF', amount: 300 },
    ],
  );
  assert.equal(receipt.total, 600);
  assert.deepEqual(entries('型番Y98\n食品350\nY414'), [{ name: '食品350', amount: 414 }]);
});

test('mixed supermarket rows, category markers, discount and tax preserve twelve products', () => {
  const receipt = parseReceipt(`食品店
# 食品い ¥498
# 食品ろ
3コ X B138 ¥414
# 食品は
2コメX単138 ¥276
# 食品に ¥148
# 食品ほ ¥198
# 食品へ
2コメ単138 ¥276
# 食品と ¥198
# 食品ち ¥100
# 食品り ¥108
# 食品ぬ ¥218
A 飲料350m
2コX単118 ¥236
B# 食品る ¥98
A まとめ値引 5% -23
小計 ¥2, 745
8%対象 ¥2, 319
消費税8% ¥185
10%対象 ¥426
消費税10% ¥43
合計 ¥2, 973
現金 ¥3, 000`);
  assert.deepEqual(
    receipt.items.map((item) => item.amount),
    [498, 414, 276, 148, 198, 276, 198, 100, 108, 218, 236, 98],
  );
  assert.equal(receipt.items.length, 12);
  assert.equal(receipt.total, 2973);
  assert.ok(receipt.items.every((item) => !/^\d+(?:コ|個|点)/.test(item.name)));
});

test('at-sign unit prices belong to the preceding drink or purchased package', () => {
  assert.deepEqual(
    quantities(
      '生ビール ¥1,740\n3杯 X @¥580\n豆大福 4個入 ¥1,940\n2箱 X @¥970\n焼きおにぎり ¥460\n2個 x @¥230',
    ),
    [
      { name: '生ビール', amount: 1740, quantity: 3, splitMode: 'quantity' },
      { name: '豆大福 4個入', amount: 1940, quantity: 2, splitMode: 'quantity' },
      { name: '焼きおにぎり', amount: 460, quantity: 2, splitMode: 'quantity' },
    ],
  );
  assert.deepEqual(
    entries('3杯 X @¥580\n2箱 X @¥970'),
    [],
    'orphan quantity rows cannot become products',
  );
});

test('at-sign and unit-price-first quantity rows preserve printed totals', () => {
  for (const row of ['3杯 X @¥580', '@¥580 × 3杯', '単価 580円 × 3杯', '¥580 × 3']) {
    assert.deepEqual(
      quantities(`ビール ¥1700\n${row}\n枝豆 ¥400`),
      [
        { name: 'ビール', amount: 1700, quantity: 3, splitMode: 'quantity' },
        { name: '枝豆', amount: 400, quantity: undefined, splitMode: undefined },
      ],
      row,
    );
    assert.deepEqual(entries(`ビール\n${row}\n¥1700`), [{ name: 'ビール', amount: 1700 }], row);
    assert.deepEqual(entries(`ビール\n${row} ¥1700`), [{ name: 'ビール', amount: 1700 }], row);
    assert.deepEqual(entries(`ビール\n${row}`), [{ name: 'ビール', amount: 1740 }], row);
  }
});

test('inline at-sign quantity columns keep names and avoid multiplying a row total twice', () => {
  for (const row of ['ビール 3杯 X @¥580 ¥1700', 'ビール @¥580 × 3杯 ¥1700']) {
    assert.deepEqual(
      quantities(row),
      [{ name: 'ビール', amount: 1700, quantity: 3, splitMode: 'quantity' }],
      row,
    );
  }
  assert.deepEqual(quantities('紅茶 3袋入 ¥300\nビール350ml 6本パック ¥1200'), [
    { name: '紅茶 3袋入', amount: 300, quantity: undefined, splitMode: undefined },
    { name: 'ビール350ml 6本パック', amount: 1200, quantity: undefined, splitMode: undefined },
  ]);
});

test('tax-qualified payable totals are totals and payment detail lines cannot replace them', () => {
  const parsed = parseReceipt(
    '料理 ¥1000\n飲み物 ¥1000\n小計 ¥2000\n合計(税込) ¥2240\nお支払 コード決済 ¥240',
  );
  assert.equal(parsed.total, 2240);
  assert.equal(parsed.items.length, 2);
  assert.equal(parseReceipt('料理 ¥1000\n合計 (税込み)\n¥1100').total, 1100);
  for (const payment of ['コード決済', 'PayPay', 'GRコード(PayPay等)', 'Suica', 'MIRAI CARD']) {
    const result = parseReceipt(`料理 ¥1000\n${payment} ¥1200\n小計 ¥1000`);
    assert.deepEqual(
      result.items.map(({ name, amount }) => ({ name, amount })),
      [{ name: '料理', amount: 1000 }],
      payment,
    );
    assert.equal(result.total, 1000, payment);
  }
  assert.deepEqual(entries('Cardamom tea ¥500'), [{ name: 'Cardamom tea', amount: 500 }]);
});
