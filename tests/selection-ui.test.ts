import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import test, { type TestContext } from 'node:test';
import {
  Window,
  type HTMLButtonElement as HappyButton,
  type HTMLInputElement as HappyInput,
  type HTMLElement as HappyElement,
} from 'happy-dom';
import { act, createElement } from 'react';
import type { ReceiptItem, Room } from '../shared/types';

// The application imports camera styles; Vite loads those in the browser.
if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    },
  });
} else {
  nodeModule.register(
    `data:text/javascript,${encodeURIComponent(`
      export async function load(url, context, nextLoad) {
        if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
        return nextLoad(url, context);
      }
    `)}`,
    import.meta.url,
  );
}

function mixedRoom(): Room {
  return {
    id: 'test-room',
    title: '飲み物とシェア料理',
    payerId: 'a',
    items: [
      { id: 'drink', name: 'ドリンク', amount: 900, quantity: 3, splitMode: 'quantity' },
      { id: 'pizza', name: 'ピザ', amount: 600, quantity: 2, splitMode: 'equal' },
    ],
    total: 1500,
    members: [
      { id: 'a', name: 'あき', done: false },
      { id: 'b', name: 'はる', done: true },
    ],
    selections: { a: ['pizza'], b: ['drink', 'pizza'] },
    selectionQuantities: { a: {}, b: { drink: 1 } },
    paidMemberIds: [],
    closed: false,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    version: 1,
  };
}

function fixedRoom(): Room {
  return {
    ...mixedRoom(),
    title: '4人の飲み会',
    payerId: 'b',
    calculationMode: 'fixed-participants',
    participantCount: 4,
    items: [
      { id: 'beer', name: 'ビール', amount: 1800, quantity: 3, splitMode: 'quantity' },
      { id: 'food', name: '唐揚げ', amount: 1200, quantity: 1, splitMode: 'equal' },
    ],
    total: 3000,
    members: [
      { id: 'b', name: 'はる', done: false },
      { id: 'a', name: 'あき', done: false },
    ],
    selections: { a: [], b: [] },
    selectionQuantities: { a: {}, b: {} },
  };
}

type SelectionBody = { itemIds: string[]; quantities: Record<string, number>; done: boolean };
type CreationBody = {
  title: string;
  payerName: string;
  participantCount: number;
  calculationMode: 'fixed-participants';
  items: ReceiptItem[];
  total: number;
};

async function mountApp(t: TestContext, initialRoom?: Room, signedIn = true) {
  const window = new Window({
    url: `https://reciwake.example/${initialRoom ? 'r/test-room' : ''}`,
  });
  const document = window.document;
  let room = initialRoom ? structuredClone(initialRoom) : mixedRoom();
  const identity = { memberId: 'a', token: 'test-session-token' };
  const selections: SelectionBody[] = [];
  const creations: CreationBody[] = [];
  const closures: { closed: boolean; version: number }[] = [];
  const payments: { memberId: string; paid: boolean }[] = [];
  const selectionFailures = new Map<number, string>();
  let selectionWait: Promise<void> | undefined;
  if (initialRoom && signedIn)
    window.localStorage.setItem('receipt-split:session:test-room', JSON.stringify(identity));
  const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/rooms' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as CreationBody;
      creations.push(body);
      room = {
        ...room,
        title: body.title,
        participantCount: body.participantCount,
        calculationMode: body.calculationMode,
        total: body.total,
        items: body.items,
        members: [{ id: 'a', name: body.payerName, done: false }],
        selections: { a: [] },
        selectionQuantities: { a: {} },
      };
      return Response.json({ room, identity });
    }
    if (path === '/api/rooms/test-room/selection' && init?.method === 'PUT') {
      assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${identity.token}`);
      const body = JSON.parse(String(init.body)) as SelectionBody;
      selections.push(body);
      const requestNumber = selections.length;
      if (selectionWait) {
        const waiting = selectionWait;
        selectionWait = undefined;
        await waiting;
      }
      const selectionFailure = selectionFailures.get(requestNumber);
      if (selectionFailure) {
        const error = selectionFailure;
        selectionFailures.delete(requestNumber);
        return Response.json({ error }, { status: 409 });
      }
      room = {
        ...room,
        selections: { ...room.selections, a: body.itemIds },
        selectionQuantities: { ...room.selectionQuantities, a: body.quantities },
        members: room.members.map((member) =>
          member.id === 'a' ? { ...member, done: body.done } : member,
        ),
        version: room.version + 1,
      };
      return Response.json(room);
    }
    if (path === '/api/rooms/test-room/close' && init?.method === 'POST') {
      assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${identity.token}`);
      const body = JSON.parse(String(init.body)) as (typeof closures)[number];
      assert.equal(body.version, room.version);
      closures.push(body);
      room = {
        ...room,
        closed: body.closed,
        paidMemberIds: body.closed ? room.paidMemberIds : [],
        version: room.version + 1,
      };
      return Response.json(room);
    }
    if (path === '/api/rooms/test-room/paid' && init?.method === 'PUT') {
      assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${identity.token}`);
      assert.equal(room.closed, true, 'receipts can only be recorded after closing input');
      const body = JSON.parse(String(init.body)) as (typeof payments)[number];
      payments.push(body);
      room = {
        ...room,
        paidMemberIds: body.paid
          ? [...new Set([...room.paidMemberIds, body.memberId])]
          : room.paidMemberIds.filter((memberId) => memberId !== body.memberId),
        version: room.version + 1,
      };
      return Response.json(room);
    }
    assert.equal(path, '/api/rooms/test-room', `unexpected API request ${path}`);
    assert.equal(init?.method, 'GET');
    return Response.json(room);
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    location: window.location,
    history: window.history,
    localStorage: window.localStorage,
    fetch: mockFetch,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  // Initialize React's browser event handling only after the DOM exists.
  const { createRoot } = await import('react-dom/client');
  const { default: App } = await import('../src/App');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  t.after(async () => {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(createElement(App)));
  const button = (text: string) => {
    const button = Array.from(host.querySelectorAll<HappyButton>('button')).find(
      (element) =>
        element.textContent.trim() === text || element.getAttribute('aria-label') === text,
    );
    assert.ok(button, `missing button ${text}`);
    return button;
  };
  const tile = (itemName: string, number: number) => {
    const element = host.querySelector<HappyButton>(
      `.meal-choice[aria-label="${itemName}"] .meal-unit[data-slot="${number - 1}"]`,
    );
    assert.ok(element, `missing ${itemName} tile ${number}`);
    return element;
  };
  const radio = (text: string) => {
    const radio = Array.from(host.querySelectorAll<HappyInput>('input[type="radio"]')).find(
      (element) => element.getAttribute('aria-label') === text,
    );
    assert.ok(radio, `missing radio ${text}`);
    return radio;
  };
  return {
    host,
    selections,
    creations,
    closures,
    payments,
    button,
    tile,
    radio,
    updateRoom(update: (room: Room) => void) {
      update(room);
      room = { ...room, version: room.version + 1 };
    },
    async refresh() {
      await act(async () => window.dispatchEvent(new window.Event('focus')));
    },
    holdNextSelection() {
      let release!: () => void;
      selectionWait = new Promise<void>((resolve) => {
        release = resolve;
      });
      return async () => {
        await act(async () => release());
      };
    },
    async clickTile(itemName: string, number: number) {
      await act(async () => tile(itemName, number).click());
    },
    failNextSelection(message: string) {
      selectionFailures.set(selections.length + 1, message);
    },
    async click(text: string) {
      await act(async () => button(text).click());
    },
    async choose(text: string) {
      await act(async () => radio(text).click());
    },
    async openQuantityInput(row: number) {
      const input = host.querySelector<HappyInput>(`input[aria-label="${row}行目の数量"]`);
      assert.ok(input, `missing quantity input for row ${row}`);
      const details = input.closest('details');
      assert.ok(details, 'direct quantity entry must be available on demand');
      if (!details.hasAttribute('open')) {
        const summary = details.querySelector<HappyElement>('summary');
        assert.ok(summary);
        await act(async () => summary.click());
      }
      return input;
    },
    async input(selector: string, value: string) {
      const input = host.querySelector(selector);
      assert.ok(input instanceof window.HTMLInputElement, `missing input ${selector}`);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      return input;
    },
    async toggleSharedItem() {
      const shared = Array.from(host.querySelectorAll<HappyButton>('button[aria-pressed]')).find(
        (element) => element.getAttribute('aria-label')?.startsWith('ピザ：'),
      );
      assert.ok(shared, 'shared pizza must be a selectable item');
      await act(async () => shared.click());
    },
  };
}

test('editor submits purchased counts and chosen split modes without multiplying row totals', async (t) => {
  const app = await mountApp(t);
  await app.click('手入力ではじめる');
  assert.equal(app.radio('1行目：各自').checked, true);
  assert.equal(app.radio('1行目：全員で割り勘').checked, false);
  await app.input('input[placeholder="例：金曜の家飲み"]', '夕食');
  await app.input('input[placeholder="例：あおい"]', 'あき');
  const participantCount = await app.input('#participant-count', '');
  assert.equal(participantCount.value, '');
  assert.equal(participantCount.validity.valueMissing, true);
  await app.input('#participant-count', '3');
  await app.input('input[aria-label="1行目の品名"]', 'ドリンク');
  await app.input('input[aria-label="1行目の合計金額"]', '1200');
  await app.openQuantityInput(1);
  const quantity = await app.input('input[aria-label="1行目の数量"]', '');
  assert.equal(quantity.value, '', 'clearing the field must leave an editable blank');
  assert.equal(quantity.validity.valueMissing, true);
  await app.input('input[aria-label="1行目の数量"]', '2');
  assert.equal(app.radio('1行目：各自').checked, true);
  assert.equal(app.host.querySelector<HappyInput>('#receipt-total')?.value, '1200');
  await app.click('料理・飲み物を追加');
  assert.equal(app.radio('2行目：各自').checked, true);
  assert.equal(app.radio('2行目：全員で割り勘').checked, false);
  assert.equal(app.radio('2行目：各自').name, app.radio('2行目：全員で割り勘').name);
  assert.notEqual(app.radio('1行目：各自').name, app.radio('2行目：各自').name);
  await app.input('input[aria-label="2行目の品名"]', 'ピザ');
  await app.input('input[aria-label="2行目の合計金額"]', '900');
  await app.openQuantityInput(2);
  await app.input('input[aria-label="2行目の数量"]', '2');
  await app.choose('2行目：全員で割り勘');
  assert.equal(app.radio('2行目：全員で割り勘').checked, true);
  assert.equal(app.radio('2行目：各自').checked, false);
  assert.equal(app.radio('1行目：各自').checked, true);
  assert.equal(app.radio('1行目：全員で割り勘').checked, false);
  assert.equal(app.host.querySelector<HappyInput>('#receipt-total')?.value, '2100');
  assert.equal(app.creations.length, 0, 'changing the split mode must not submit the form');
  await app.input('input[aria-label="2行目の数量"]', '3');
  assert.equal(app.radio('2行目：全員で割り勘').checked, true);
  assert.equal(app.host.querySelector<HappyInput>('#receipt-total')?.value, '2100');
  await app.input('input[aria-label="2行目の数量"]', '2');
  assert.equal(app.host.querySelector<HappyInput>('#receipt-total')?.value, '2100');
  await app.click('共有リンクを作る');
  assert.equal(app.creations.length, 1);
  assert.deepEqual(
    app.creations[0].items.map(({ name, amount, quantity, splitMode }) => ({
      name,
      amount,
      quantity,
      splitMode,
    })),
    [
      { name: 'ドリンク', amount: 1200, quantity: 2, splitMode: 'quantity' },
      { name: 'ピザ', amount: 900, quantity: 2, splitMode: 'equal' },
    ],
  );
  assert.equal(app.creations[0].total, 2100);
  assert.equal(app.creations[0].participantCount, 3);
  assert.equal(app.creations[0].calculationMode, 'fixed-participants');
  assert.match(app.host.textContent, /1 \/ 3人が参加/);
  assert.match(app.host.textContent, /0 \/ 3人が入力完了/);
  assert.equal(app.tile('ドリンク', 1).disabled, false);
  assert.equal(app.host.querySelector('.meal-choice-toggle'), null);
  assert.match(app.host.querySelector('.included-items')?.textContent ?? '', /ピザ/);
  assert.equal(app.host.querySelector('.included-items .amount-ratio strong')?.textContent, '300');
  assert.equal(
    app.host.querySelector('.included-items .amount-ratio .ratio-total')?.textContent.trim(),
    '/ 900',
  );
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥300');
});

test('creation uses one tile per purchased drink and keeps row totals when adding or removing units', async (t) => {
  const app = await mountApp(t);
  await app.click('手入力ではじめる');
  await app.input('input[placeholder="例：金曜の家飲み"]', '飲み会');
  await app.input('input[placeholder="例：あおい"]', 'あき');
  await app.input('#participant-count', '4');
  await app.input('input[aria-label="1行目の品名"]', 'ビール');
  await app.input('input[aria-label="1行目の合計金額"]', '1800');
  const quantityInput = app.host.querySelector<HappyInput>('input[aria-label="1行目の数量"]');
  assert.ok(quantityInput);
  assert.equal(quantityInput.closest('details')?.hasAttribute('open'), false);
  assert.equal(quantityInput.value, '1');
  assert.equal(app.button('ビールを1つ減らす（1/1）').disabled, true);
  await app.click('ビールを1つ減らす（1/1）');
  assert.equal(quantityInput.value, '1', 'the final purchased unit cannot be removed');
  await app.click('ビールを1つ増やす');
  await app.click('ビールを1つ増やす');
  assert.equal(quantityInput.value, '3');
  const firstTile = app.button('ビールを1つ減らす（1/3）');
  const lastTile = app.button('ビールを1つ減らす（3/3）');
  await app.click('ビールを1つ減らす（2/3）');
  assert.equal(quantityInput.value, '2');
  assert.equal(app.button('ビールを1つ減らす（1/2）'), firstTile);
  assert.equal(app.button('ビールを1つ減らす（2/2）'), lastTile);
  assert.equal(app.host.querySelector<HappyInput>('#receipt-total')?.value, '1800');
  assert.equal(app.creations.length, 0, 'tile controls must not submit the creation form');
  await app.click('共有リンクを作る');
  assert.equal(app.creations.length, 1);
  assert.deepEqual(
    app.creations[0].items.map(({ name, amount, quantity, splitMode }) => ({
      name,
      amount,
      quantity,
      splitMode,
    })),
    [{ name: 'ビール', amount: 1800, quantity: 2, splitMode: 'quantity' }],
  );
  assert.equal(app.creations[0].total, 1800);
});

test('creation permits large purchased counts without rendering every tile and validates direct entry', async (t) => {
  const app = await mountApp(t);
  await app.click('手入力ではじめる');
  await app.input('input[placeholder="例：金曜の家飲み"]', '飲み会');
  await app.input('input[placeholder="例：あおい"]', 'あき');
  await app.input('#participant-count', '4');
  await app.input('input[aria-label="1行目の品名"]', 'ビール');
  await app.input('input[aria-label="1行目の合計金額"]', '99900');
  await app.openQuantityInput(1);
  const selector = 'input[aria-label="1行目の数量"]';
  for (const value of ['', '0', '-1', '1.5', '1000']) {
    const input = await app.input(selector, value);
    assert.equal(input.checkValidity(), false, `invalid purchased count ${value}`);
    await app.click('共有リンクを作る');
    assert.equal(app.creations.length, 0, 'an invalid count must not create a room');
  }
  const bulkSummary = app.host.querySelector<HappyElement>('.quantity-tiles-numeric summary');
  assert.ok(bulkSummary);
  await act(async () => bulkSummary.click());
  assert.equal(bulkSummary.closest('details')?.hasAttribute('open'), false);
  await app.click('共有リンクを作る');
  assert.equal(
    bulkSummary.closest('details')?.hasAttribute('open'),
    true,
    'submitting a collapsed invalid count reveals the field that needs correction',
  );
  assert.equal(app.creations.length, 0);
  const input = await app.input(selector, '999');
  assert.equal(input.checkValidity(), true);
  assert.equal(app.host.querySelectorAll('.quantity-unit:not(.quantity-add)').length, 12);
  assert.equal(app.host.querySelector('.quantity-tiles-extra')?.textContent, '＋987');
  assert.equal(app.button('ビールを1つ増やす').disabled, true);
  await app.click('ビールを1つ増やす');
  assert.equal(input.value, '999');
  await app.click('ビールを1つ減らす（6/999）');
  assert.equal(input.value, '998');
  assert.equal(app.button('ビールを1つ増やす').disabled, false);
  assert.equal(app.host.querySelector<HappyInput>('#receipt-total')?.value, '99900');
  await app.click('共有リンクを作る');
  assert.equal(app.creations.length, 1);
  assert.equal(app.creations[0].items[0].quantity, 998);
  assert.equal(app.creations[0].items[0].amount, 99900);
});

test('fixed participant selects one beer and finishes at 900 yen without choosing shared food or waiting', async (t) => {
  const app = await mountApp(t, fixedRoom());
  assert.equal(app.host.querySelector('[role="tablist"]'), null);
  assert.doesNotMatch(app.host.textContent, /みんなの金額|負担 \/ 全体/);
  assert.equal(
    app.host.querySelector('.selection-heading h2')?.textContent,
    '食べた・飲んだ分をタップ',
  );
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥300');
  assert.equal(app.host.querySelector('.meal-choice-toggle'), null);
  assert.match(app.host.querySelector('.included-items')?.textContent ?? '', /唐揚げ/);
  assert.equal(app.host.querySelector('.included-items .amount-ratio strong')?.textContent, '300');
  assert.equal(
    app.host.querySelector('.included-items .amount-ratio .ratio-total')?.textContent.trim(),
    '/ 1,200',
  );
  await app.clickTile('ビール', 1);
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['beer'],
    quantities: { beer: 1 },
    done: false,
  });
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥900');
  assert.equal(app.host.querySelector('.meal-choice .amount-ratio strong')?.textContent, '600');
  assert.equal(
    app.host.querySelector('.meal-choice .amount-ratio .ratio-total')?.textContent.trim(),
    '/ 1,800',
  );
  assert.equal(app.host.querySelector('.meal-choice-count strong')?.textContent, '1');
  assert.equal(
    app.host.querySelector('.meal-choice-denominator')?.textContent.trim(),
    '/ 3',
    'the denominator stays at the purchased count, not the two remaining beers',
  );
  assert.doesNotMatch(app.host.textContent, /自分の数/);
  await app.click('この金額で完了');
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['beer'],
    quantities: { beer: 1 },
    done: true,
  });
  assert.ok(app.host.querySelector('.personal-summary'));
  assert.equal(app.host.querySelector('.personal-final-amount')?.textContent, '￥900');
  assert.equal(app.host.querySelector('.selection-result h2')?.textContent, 'はるさんに返す金額');
  assert.doesNotMatch(app.host.textContent, /入力を待っています|確定するのを待っています/);
  assert.equal(app.host.querySelector('.owner-management'), null);
  assert.equal(app.host.querySelector('.settlement-list'), null);
  await app.click('選び直す');
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥900');
  assert.equal(app.host.querySelector('.meal-choice-toggle'), null);
});

test('the payer can finish, close input, record a received payment and reopen in the same flow', async (t) => {
  const room = fixedRoom();
  room.payerId = 'a';
  room.participantCount = 2;
  room.members.find((member) => member.id === 'b')!.done = true;
  room.selections.b = ['beer'];
  room.selectionQuantities!.b = { beer: 2 };
  const app = await mountApp(t, room);
  const management = app.host.querySelector<HappyElement>('.owner-management');
  assert.ok(management);
  assert.equal(management.hasAttribute('open'), false);
  const summary = management.querySelector<HappyElement>('summary');
  assert.ok(summary);
  assert.match(summary.textContent, /参加状況/);
  await act(async () => summary.click());
  assert.equal(management.hasAttribute('open'), true);
  assert.equal(app.button('全員の入力を締め切る').disabled, true);
  assert.equal(app.host.querySelectorAll('.paid-button').length, 0);
  await app.clickTile('ビール', 1);
  assert.equal(
    app.button('全員の入力を締め切る').disabled,
    true,
    'selection must be finished first',
  );
  await app.click('この金額で完了');
  assert.equal(app.host.querySelector('.personal-final-amount')?.textContent, '￥1,200');
  assert.equal(app.host.querySelector('.selection-result h2')?.textContent, 'あなたの分');
  assert.equal(management.hasAttribute('open'), true);
  assert.equal(app.button('全員の入力を締め切る').disabled, false);
  await app.click('全員の入力を締め切る');
  assert.equal(app.closures.length, 0, 'opening the confirmation must not close the room');
  await app.click('入力を締め切る');
  assert.equal(app.closures.length, 1);
  assert.equal(app.closures[0].closed, true);
  assert.match(management.querySelector('summary')?.textContent ?? '', /受け取り状況/);
  await app.click('受け取った');
  assert.deepEqual(app.payments, [{ memberId: 'b', paid: true }]);
  assert.equal(app.button('受け取り済み').classList.contains('is-paid'), true);
  assert.match(management.querySelector('summary')?.textContent ?? '', /1 \/ 1人/);
  await app.click('入力を再開する');
  const confirmReopen = app.host.querySelector<HappyButton>('dialog .button.primary');
  assert.ok(confirmReopen);
  assert.equal(confirmReopen.textContent.trim(), '入力を再開する');
  await act(async () => confirmReopen.click());
  assert.deepEqual(
    app.closures.map(({ closed }) => closed),
    [true, false],
  );
  assert.match(management.querySelector('summary')?.textContent ?? '', /参加状況/);
  assert.equal(app.host.querySelectorAll('.paid-button').length, 0);
  await app.click('選び直す');
  assert.equal(app.tile('ビール', 1).disabled, false);
  assert.equal(app.host.querySelector('[role="tablist"]'), null);
});

test('a participant sees their payment and a read-only receipt without the payer management view', async (t) => {
  const room = fixedRoom();
  room.closed = true;
  room.members.find((member) => member.id === 'a')!.done = true;
  room.selections.a = ['beer'];
  room.selectionQuantities!.a = { beer: 1 };
  room.paidMemberIds = ['a'];
  const app = await mountApp(t, room);
  assert.equal(app.host.querySelector('.personal-final-amount')?.textContent, '￥900');
  assert.equal(app.host.querySelector('.personal-payment-state')?.textContent, '受け取り済み');
  assert.equal(app.host.querySelector('.owner-management'), null);
  assert.equal(app.host.querySelector('.settlement-list'), null);
  assert.equal(app.host.querySelector('.paid-button'), null);
  await app.click('明細を見る');
  assert.equal(app.host.querySelector('.selection-heading h2')?.textContent, 'あなたの明細');
  assert.equal(app.tile('ビール', 1).disabled, true);
  await app.clickTile('ビール', 1);
  assert.equal(app.selections.length, 0);
  await app.click('金額に戻る');
  assert.equal(app.host.querySelector('.personal-final-amount')?.textContent, '￥900');
  assert.equal(app.host.querySelector('.meal-choice'), null);
});

test('fixed shared-only receipt completes by confirming the amount without entering order counts', async (t) => {
  const room = fixedRoom();
  room.items = [room.items[1]];
  room.total = 1200;
  const app = await mountApp(t, room);
  assert.equal(app.host.querySelector('.meal-choice'), null);
  assert.equal(app.host.querySelector('.selection-group'), null);
  assert.equal(app.host.querySelector('.selection-heading h2')?.textContent, 'あなたの金額を確認');
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥300');
  assert.doesNotMatch(app.host.textContent, /自分の注文数を入力|自分の分なしで完了/);
  await app.click('この金額で完了');
  assert.deepEqual(app.selections.at(-1), { itemIds: [], quantities: {}, done: true });
  assert.ok(app.host.querySelector('.personal-summary'));
  assert.equal(app.host.querySelector('.personal-final-amount')?.textContent, '￥300');
  assert.doesNotMatch(app.host.textContent, /入力を待っています|確定するのを待っています/);
});

test('unit tiles and shared-item toggles preserve each other and stop at the purchased count', async (t) => {
  const app = await mountApp(t, mixedRoom());
  assert.equal(app.button('ピザ：選択済み').getAttribute('aria-pressed'), 'true');
  assert.equal(app.tile('ドリンク', 1).getAttribute('aria-pressed'), 'false');
  assert.equal(app.tile('ドリンク', 3).disabled, true);
  await app.clickTile('ドリンク', 1);
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['pizza', 'drink'],
    quantities: { drink: 1 },
    done: false,
  });
  await app.clickTile('ドリンク', 2);
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['pizza', 'drink'],
    quantities: { drink: 2 },
    done: false,
  });
  assert.equal(app.tile('ドリンク', 3).disabled, true);
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥900');
  await app.clickTile('ドリンク', 2);
  await app.toggleSharedItem();
  assert.equal(app.button('ピザ：選ぶ').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['drink'],
    quantities: { drink: 1 },
    done: false,
  });
  await app.toggleSharedItem();
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['drink', 'pizza'],
    quantities: { drink: 1 },
    done: false,
  });
  await app.clickTile('ドリンク', 1);
  assert.deepEqual(app.selections.at(-1), { itemIds: ['pizza'], quantities: {}, done: false });
  assert.equal(app.tile('ドリンク', 1).getAttribute('aria-pressed'), 'false');
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥300');
});

test('individual tiles retain the tapped positions when selecting and removing a middle drink', async (t) => {
  const app = await mountApp(t, fixedRoom());
  await app.clickTile('ビール', 3);
  assert.equal(app.tile('ビール', 3).getAttribute('aria-label'), 'ビール 3/3');
  assert.equal(app.tile('ビール', 3).getAttribute('aria-pressed'), 'true');
  assert.equal(app.tile('ビール', 1).getAttribute('aria-pressed'), 'false');
  await app.clickTile('ビール', 1);
  await app.clickTile('ビール', 2);
  assert.deepEqual(app.selections.at(-1)?.quantities, { beer: 3 });
  await app.clickTile('ビール', 2);
  assert.deepEqual(app.selections.at(-1)?.quantities, { beer: 2 });
  assert.equal(app.tile('ビール', 1).getAttribute('aria-pressed'), 'true');
  assert.equal(app.tile('ビール', 2).getAttribute('aria-pressed'), 'false');
  assert.equal(app.tile('ビール', 3).getAttribute('aria-pressed'), 'true');
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥1,500');
});

test('another participant claiming a drink keeps the local tile positions and amount stable', async (t) => {
  const app = await mountApp(t, fixedRoom());
  await app.clickTile('ビール', 3);
  await app.clickTile('ビール', 1);
  app.updateRoom((room) => {
    room.selections.b = ['beer'];
    room.selectionQuantities!.b = { beer: 1 };
  });
  await app.refresh();
  assert.equal(app.tile('ビール', 1).getAttribute('aria-pressed'), 'true');
  assert.equal(app.tile('ビール', 3).getAttribute('aria-pressed'), 'true');
  assert.equal(app.tile('ビール', 2).disabled, true);
  assert.match(app.tile('ビール', 2).getAttribute('aria-label') ?? '', /ほかの人の分/);
  assert.equal(app.tile('ビール', 1).disabled, false, 'a selected tile must remain removable');
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥1,500');
  await app.clickTile('ビール', 3);
  assert.deepEqual(app.selections.at(-1)?.quantities, { beer: 1 });
  assert.equal(app.tile('ビール', 1).getAttribute('aria-pressed'), 'true');
  assert.equal(app.tile('ビール', 3).getAttribute('aria-pressed'), 'false');
  assert.equal(app.tile('ビール', 3).disabled, false, 'the released tile stays available');
  assert.equal(app.tile('ビール', 2).disabled, true, 'the other participant marker stays put');
});

test('a last-drink conflict restores the previous selected tile and refreshes occupied tiles', async (t) => {
  const room = fixedRoom();
  room.selections.b = ['beer'];
  room.selectionQuantities!.b = { beer: 1 };
  const app = await mountApp(t, room);
  await app.clickTile('ビール', 2);
  app.updateRoom((latest) => {
    latest.selectionQuantities!.b = { beer: 2 };
  });
  app.failNextSelection('ほかの人が先に選びました。');
  await app.clickTile('ビール', 1);
  assert.deepEqual(app.selections.at(-1)?.quantities, { beer: 2 }, 'the attempted count is sent');
  assert.equal(app.tile('ビール', 2).getAttribute('aria-pressed'), 'true');
  assert.equal(app.tile('ビール', 2).disabled, false);
  for (const number of [1, 3]) {
    assert.equal(app.tile('ビール', number).getAttribute('aria-pressed'), 'false');
    assert.equal(app.tile('ビール', number).disabled, true);
    assert.match(app.tile('ビール', number).getAttribute('aria-label') ?? '', /ほかの人の分/);
  }
  assert.equal(app.host.querySelector('.meal-choice-count strong')?.textContent, '1');
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥900');
  assert.match(app.host.textContent, /ほかの人が先に選びました/);
  await app.clickTile('ビール', 2);
  assert.deepEqual(app.selections.at(-1), { itemIds: [], quantities: {}, done: false });
});

test('rapid taps queue the latest drink count while other rows and completion wait for saving', async (t) => {
  const room = fixedRoom();
  room.items.push({ id: 'wine', name: 'ワイン', amount: 1000, quantity: 2, splitMode: 'quantity' });
  room.total = 4000;
  const app = await mountApp(t, room);
  const release = app.holdNextSelection();
  await app.clickTile('ビール', 1);
  for (const number of [1, 2, 3]) assert.equal(app.tile('ビール', number).disabled, false);
  assert.equal(app.tile('ワイン', 1).disabled, true);
  assert.equal(app.button('この金額で完了').disabled, true);
  await app.clickTile('ビール', 2);
  assert.equal(app.selections.length, 1, 'the next request must wait for the pending request');
  assert.equal(app.tile('ビール', 1).getAttribute('aria-pressed'), 'true');
  assert.equal(app.tile('ビール', 2).getAttribute('aria-pressed'), 'true');
  assert.equal(app.host.querySelector('.meal-choice-count strong')?.textContent, '2');
  await release();
  assert.deepEqual(
    app.selections.map(({ quantities }) => quantities),
    [{ beer: 1 }, { beer: 2 }],
  );
  assert.equal(app.tile('ビール', 1).getAttribute('aria-pressed'), 'true');
  assert.equal(app.tile('ビール', 2).getAttribute('aria-pressed'), 'true');
  assert.equal(app.tile('ワイン', 1).disabled, false);
  assert.equal(app.button('この金額で完了').disabled, false);
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥1,500');
});

test('tapping a drink again before its save finishes queues an undo and returns to zero', async (t) => {
  const app = await mountApp(t, fixedRoom());
  const release = app.holdNextSelection();
  await app.clickTile('ビール', 3);
  await app.clickTile('ビール', 3);
  assert.equal(app.selections.length, 1);
  assert.equal(app.tile('ビール', 3).getAttribute('aria-pressed'), 'false');
  assert.equal(app.host.querySelector('.meal-choice-count strong')?.textContent, '0');
  assert.equal(app.button('この金額で完了').disabled, true);
  await release();
  assert.deepEqual(app.selections, [
    { itemIds: ['beer'], quantities: { beer: 1 }, done: false },
    { itemIds: [], quantities: {}, done: false },
  ]);
  assert.equal(app.tile('ビール', 3).getAttribute('aria-pressed'), 'false');
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥300');
  assert.equal(app.button('この金額で完了').disabled, false);
});

test('swapping the selected drink while a save is pending preserves the last tapped tile', async (t) => {
  const app = await mountApp(t, fixedRoom());
  const release = app.holdNextSelection();
  await app.clickTile('ビール', 1);
  await app.clickTile('ビール', 2);
  await app.clickTile('ビール', 1);
  await release();
  assert.equal(app.tile('ビール', 1).getAttribute('aria-pressed'), 'false');
  assert.equal(app.tile('ビール', 2).getAttribute('aria-pressed'), 'true');
  assert.equal(app.host.querySelector('.meal-choice-count strong')?.textContent, '1');
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥900');
  await app.clickTile('ビール', 2);
  assert.deepEqual(app.selections.at(-1), { itemIds: [], quantities: {}, done: false });
});

test('a queued save failure keeps the last acknowledged tile and discards later unsaved taps', async (t) => {
  const app = await mountApp(t, fixedRoom());
  const releaseFirst = app.holdNextSelection();
  await app.clickTile('ビール', 3);
  await app.clickTile('ビール', 1);
  const releaseSecond = app.holdNextSelection();
  app.failNextSelection('保存できませんでした。もう一度お試しください。');
  await releaseFirst();
  assert.equal(app.selections.length, 2);
  await app.clickTile('ビール', 2);
  assert.equal(app.host.querySelector('.meal-choice-count strong')?.textContent, '3');
  await releaseSecond();
  assert.equal(app.selections.length, 2, 'a failed save must discard the queued third request');
  assert.equal(app.tile('ビール', 3).getAttribute('aria-pressed'), 'true');
  assert.equal(app.tile('ビール', 1).getAttribute('aria-pressed'), 'false');
  assert.equal(app.tile('ビール', 2).getAttribute('aria-pressed'), 'false');
  assert.equal(app.host.querySelector('.meal-choice-count strong')?.textContent, '1');
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥900');
  assert.match(app.host.textContent, /保存できませんでした/);
  await app.clickTile('ビール', 1);
  assert.deepEqual(app.selections.at(-1)?.quantities, { beer: 2 });
});

test('removing the last tile of one drink preserves the count of another drink', async (t) => {
  const room = fixedRoom();
  room.items.push({ id: 'wine', name: 'ワイン', amount: 1000, quantity: 2, splitMode: 'quantity' });
  room.total = 4000;
  const app = await mountApp(t, room);
  await app.clickTile('ワイン', 2);
  await app.clickTile('ビール', 2);
  await app.clickTile('ビール', 2);
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['wine'],
    quantities: { wine: 1 },
    done: false,
  });
  assert.equal(app.tile('ワイン', 2).getAttribute('aria-pressed'), 'true');
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥800');
});

test('large orders reveal tiles in batches and allow a bounded direct count without rendering every unit', async (t) => {
  const room = fixedRoom();
  room.items[0].quantity = 999;
  room.items[0].amount = 99900;
  room.total = 101100;
  room.selections.b = ['beer'];
  room.selectionQuantities!.b = { beer: 2 };
  const app = await mountApp(t, room);
  assert.equal(app.host.querySelectorAll('.meal-unit').length, 12);
  await app.click('ビールをさらに表示');
  assert.equal(app.host.querySelectorAll('.meal-unit').length, 24);
  const selector = 'input[aria-label="ビールの食べた・飲んだ数"]';
  const summary = app.host.querySelector<HappyElement>('.meal-choice-numeric summary');
  assert.ok(summary);
  await act(async () => summary.click());
  assert.equal(summary.closest('details')?.hasAttribute('open'), true);
  for (const value of ['-1', '1.5', '998', '1000']) {
    const input = await app.input(selector, value);
    assert.equal(input.checkValidity(), false, `invalid consumed count ${value}`);
    assert.equal(app.button('この金額で完了').disabled, true);
    await app.click('この金額で完了');
    assert.equal(app.selections.length, 0);
  }
  const input = await app.input(selector, '997');
  assert.equal(input.max, '997');
  assert.equal(input.checkValidity(), true);
  assert.equal(app.button('この金額で完了').disabled, false);
  assert.deepEqual(app.selections.at(-1)?.quantities, { beer: 997 });
  assert.equal(app.host.querySelector('.meal-choice-count strong')?.textContent, '997');
  assert.equal(app.host.querySelectorAll('.meal-unit').length, 24);
  await app.input(selector, '');
  assert.deepEqual(app.selections.at(-1), { itemIds: [], quantities: {}, done: false });
  assert.equal(app.button('この金額で完了').disabled, false);
});

test('finishing after changing a large-order count saves the new count rather than the previous amount', async (t) => {
  const room = fixedRoom();
  room.items[0].quantity = 20;
  room.items[0].amount = 12000;
  room.total = 13200;
  room.selections.a = ['beer'];
  room.selectionQuantities!.a = { beer: 1 };
  const app = await mountApp(t, room);
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥900');
  const summary = app.host.querySelector<HappyElement>('.meal-choice-numeric summary');
  assert.ok(summary);
  await act(async () => summary.click());
  await app.input('input[aria-label="ビールの食べた・飲んだ数"]', '5');
  assert.deepEqual(app.selections.at(-1)?.quantities, { beer: 5 });
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥3,300');
  await app.click('この金額で完了');
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['beer'],
    quantities: { beer: 5 },
    done: true,
  });
  assert.equal(app.host.querySelector('.personal-final-amount')?.textContent, '￥3,300');
});

for (const completeArea of ['.amount-card', '.mobile-amount-bar']) {
  test(`${completeArea} completes the selection and opens the amounts without losing selected units`, async (t) => {
    const room = mixedRoom();
    room.selections.a = ['drink', 'pizza'];
    room.selectionQuantities!.a = { drink: 2 };
    const app = await mountApp(t, room);
    const complete = app.host.querySelector<HappyButton>(`${completeArea} button`);
    assert.ok(complete);
    assert.equal(complete.textContent.trim(), '選択を終える');
    await act(async () => complete.click());
    assert.deepEqual(app.selections.at(-1), {
      itemIds: ['drink', 'pizza'],
      quantities: { drink: 2 },
      done: true,
    });
    assert.ok(app.host.querySelector('.personal-summary'));
    assert.equal(app.host.querySelector('.meal-choice'), null);
    assert.match(app.host.textContent, /あなたの入力は完了です/);
    assert.equal(app.host.querySelector('.personal-final-amount')?.textContent, '￥900（仮）');
    assert.equal(app.host.querySelector('.unassigned'), null);
    assert.equal(app.button('この金額で確定').disabled, false);
    await app.click('自分の分を選び直す');
    assert.equal(app.tile('ドリンク', 3).disabled, true);
    assert.equal(app.button('ピザ：選択済み').getAttribute('aria-pressed'), 'true');
    await app.clickTile('ドリンク', 2);
    assert.deepEqual(app.selections.at(-1), {
      itemIds: ['drink', 'pizza'],
      quantities: { drink: 1 },
      done: false,
    });
  });
}

test('failed completion keeps the selection screen and selected quantities available for retry', async (t) => {
  const room = mixedRoom();
  room.selections.a = ['drink', 'pizza'];
  room.selectionQuantities!.a = { drink: 2 };
  const app = await mountApp(t, room);
  app.failNextSelection('保存できませんでした。もう一度お試しください。');
  await app.click('選択を終える');
  assert.equal(app.host.querySelector('.personal-summary'), null);
  assert.match(app.host.textContent, /保存できませんでした/);
  assert.equal(app.host.ownerDocument.activeElement, app.host.querySelector('.room-error'));
  assert.equal(app.tile('ドリンク', 3).disabled, true);
  assert.equal(app.button('ピザ：選択済み').getAttribute('aria-pressed'), 'true');
  await app.click('選択を終える');
  assert.ok(app.host.querySelector('.personal-summary'));
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['drink', 'pizza'],
    quantities: { drink: 2 },
    done: true,
  });
});

test('a participant can finish with no food or drinks selected', async (t) => {
  const room = mixedRoom();
  room.selections.a = [];
  const app = await mountApp(t, room);
  await app.click('自分の分なしで完了');
  assert.deepEqual(app.selections.at(-1), { itemIds: [], quantities: {}, done: true });
  assert.ok(app.host.querySelector('.personal-summary'));
  assert.match(app.host.textContent, /あなたの入力は完了です/);
  assert.equal(app.button('この金額で確定').disabled, true);
});

test('returning after completion opens the amounts and permits another edit', async (t) => {
  const room = mixedRoom();
  room.members[0].done = true;
  const app = await mountApp(t, room);
  assert.ok(app.host.querySelector('.personal-summary'));
  assert.match(app.host.textContent, /あなたの入力は完了です/);
  await app.click('自分の分を選び直す');
  await app.clickTile('ドリンク', 1);
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['pizza', 'drink'],
    quantities: { drink: 1 },
    done: false,
  });
});

test('finalized selections keep both quantity and shared controls read-only', async (t) => {
  const room = mixedRoom();
  room.closed = true;
  room.selections.a = ['drink', 'pizza'];
  room.selectionQuantities!.a = { drink: 2 };
  const app = await mountApp(t, room);
  await app.click('明細を見る');
  assert.equal(app.tile('ドリンク', 1).disabled, true);
  assert.equal(app.tile('ドリンク', 2).disabled, true);
  assert.equal(app.tile('ドリンク', 3).disabled, true);
  assert.equal(app.button('ピザ：選択済み').disabled, true);
  await app.clickTile('ドリンク', 1);
  await app.click('ピザ：選択済み');
  assert.equal(app.selections.length, 0);
});

test('summary exposes the remaining units and their unpaid amount before allowing finalization', async (t) => {
  const room = mixedRoom();
  room.selections.a = ['drink', 'pizza'];
  room.selectionQuantities!.a = { drink: 1 };
  room.members[0].done = true;
  const app = await mountApp(t, room);
  const unassigned = app.host.querySelector('.unassigned');
  assert.ok(unassigned);
  assert.match(unassigned.textContent, /まだ選ばれていないものが1件/);
  assert.match(unassigned.textContent, /ドリンク（残り 1）/);
  assert.match(unassigned.textContent, /￥300/);
  assert.equal(app.button('この金額で確定').disabled, true);
});

test('creation requires an integer participant count within the supported range', async (t) => {
  const app = await mountApp(t);
  await app.click('サンプルで試す');
  assert.equal(app.radio('1行目：各自').checked, true);
  await app.input('input[placeholder="例：あおい"]', 'あき');
  for (const value of ['', '0', '1.5', '101']) {
    const input = await app.input('#participant-count', value);
    assert.equal(input.checkValidity(), false, `invalid participant count ${value}`);
    await app.click('共有リンクを作る');
    assert.equal(app.creations.length, 0);
  }
  for (const value of ['1', '100']) {
    const input = await app.input('#participant-count', value);
    assert.equal(input.checkValidity(), true);
  }
});

test('summary waits for missing participants even when current members finish every item', async (t) => {
  const room = mixedRoom();
  room.participantCount = 3;
  room.members[0].done = true;
  room.selections.a = ['drink', 'pizza'];
  room.selectionQuantities!.a = { drink: 2 };
  const app = await mountApp(t, room);
  assert.match(app.host.textContent, /2 \/ 3人が入力完了/);
  assert.match(app.host.textContent, /あと1人の参加を待っています/);
  assert.equal(app.button('この金額で確定').disabled, true);
});

test('a full room explains how to return instead of offering another participant slot', async (t) => {
  const room = mixedRoom();
  room.participantCount = 2;
  const app = await mountApp(t, room, false);
  assert.match(app.host.textContent, /全員が参加しています/);
  assert.match(app.host.textContent, /参加したときのブラウザから/);
  assert.equal(app.host.querySelector('#join-name'), null);
});
