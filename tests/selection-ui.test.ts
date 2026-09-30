import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import test, { type TestContext } from 'node:test';
import {
  Window,
  type HTMLButtonElement as HappyButton,
  type HTMLInputElement as HappyInput,
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

type SelectionBody = { itemIds: string[]; quantities: Record<string, number>; done: boolean };
type CreationBody = {
  title: string;
  payerName: string;
  participantCount: number;
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
  let selectionFailure: string | undefined;
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
      if (selectionFailure) {
        const error = selectionFailure;
        selectionFailure = undefined;
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
  return {
    host,
    selections,
    creations,
    button,
    failNextSelection(message: string) {
      selectionFailure = message;
    },
    async click(text: string) {
      await act(async () => button(text).click());
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
  assert.equal(app.button('1行目：各自').getAttribute('aria-pressed'), 'true');
  await app.input('input[placeholder="例：金曜の家飲み"]', '夕食');
  await app.input('input[placeholder="例：あおい"]', 'あき');
  const participantCount = await app.input('#participant-count', '');
  assert.equal(participantCount.value, '');
  assert.equal(participantCount.validity.valueMissing, true);
  await app.input('#participant-count', '3');
  await app.input('input[aria-label="1行目の名前"]', 'ドリンク');
  await app.input('input[aria-label="1行目の金額"]', '1200');
  const quantity = await app.input('input[aria-label="1行目の数量"]', '');
  assert.equal(quantity.value, '', 'clearing the field must leave an editable blank');
  assert.equal(quantity.validity.valueMissing, true);
  await app.input('input[aria-label="1行目の数量"]', '2');
  assert.equal(app.button('1行目：各自').getAttribute('aria-pressed'), 'true');
  await app.click('料理・飲み物を追加');
  assert.equal(app.button('2行目：各自').getAttribute('aria-pressed'), 'true');
  await app.input('input[aria-label="2行目の名前"]', 'ピザ');
  await app.input('input[aria-label="2行目の金額"]', '900');
  await app.input('input[aria-label="2行目の数量"]', '2');
  await app.click('2行目：シェア');
  assert.equal(app.button('2行目：シェア').getAttribute('aria-pressed'), 'true');
  assert.equal(app.button('2行目：各自').getAttribute('aria-pressed'), 'false');
  assert.equal(app.button('1行目：各自').getAttribute('aria-pressed'), 'true');
  assert.equal(app.creations.length, 0, 'changing the split mode must not submit the form');
  await app.input('input[aria-label="2行目の数量"]', '3');
  assert.equal(app.button('2行目：シェア').getAttribute('aria-pressed'), 'true');
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
  assert.match(app.host.textContent, /1 \/ 3人が参加/);
  assert.match(app.host.textContent, /0 \/ 3人が入力完了/);
  assert.equal(app.button('ドリンクの数を増やす').disabled, false);
  assert.equal(app.button('ピザ：選ぶ').getAttribute('aria-pressed'), 'false');
});

test('quantity controls and shared-item toggles preserve each other and stop at the purchased count', async (t) => {
  const app = await mountApp(t, mixedRoom());
  assert.equal(app.button('ピザ：選択済み').getAttribute('aria-pressed'), 'true');
  assert.equal(app.button('ドリンクの数を減らす').disabled, true);
  await app.click('ドリンクの数を増やす');
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['pizza', 'drink'],
    quantities: { drink: 1 },
    done: false,
  });
  await app.click('ドリンクの数を増やす');
  assert.deepEqual(app.selections.at(-1), {
    itemIds: ['pizza', 'drink'],
    quantities: { drink: 2 },
    done: false,
  });
  assert.equal(app.button('ドリンクの数を増やす').disabled, true);
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥900');
  await app.click('ドリンクの数を減らす');
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
  await app.click('ドリンクの数を減らす');
  assert.deepEqual(app.selections.at(-1), { itemIds: ['pizza'], quantities: {}, done: false });
  assert.equal(app.button('ドリンクの数を減らす').disabled, true);
  assert.equal(app.host.querySelector('.large-amount')?.textContent, '￥300');
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
    assert.ok(app.host.querySelector('.settlement-panel'));
    assert.equal(app.host.querySelector('.meal-choice'), null);
    assert.match(app.host.textContent, /あなたの入力は完了です/);
    assert.equal(app.host.querySelector('.unassigned'), null);
    assert.equal(app.button('この金額で確定').disabled, false);
    await app.click('自分の分を選び直す');
    assert.equal(app.button('ドリンクの数を増やす').disabled, true);
    assert.equal(app.button('ピザ：選択済み').getAttribute('aria-pressed'), 'true');
    await app.click('ドリンクの数を減らす');
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
  assert.equal(app.host.querySelector('.settlement-panel'), null);
  assert.match(app.host.textContent, /保存できませんでした/);
  assert.equal(app.host.ownerDocument.activeElement, app.host.querySelector('.room-error'));
  assert.equal(app.button('ドリンクの数を増やす').disabled, true);
  assert.equal(app.button('ピザ：選択済み').getAttribute('aria-pressed'), 'true');
  await app.click('選択を終える');
  assert.ok(app.host.querySelector('.settlement-panel'));
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
  assert.ok(app.host.querySelector('.settlement-panel'));
  assert.match(app.host.textContent, /あなたの入力は完了です/);
  assert.equal(app.button('この金額で確定').disabled, true);
});

test('returning after completion opens the amounts and permits another edit', async (t) => {
  const room = mixedRoom();
  room.members[0].done = true;
  const app = await mountApp(t, room);
  assert.ok(app.host.querySelector('.settlement-panel'));
  assert.match(app.host.textContent, /あなたの入力は完了です/);
  await app.click('自分の分を選び直す');
  await app.click('ドリンクの数を増やす');
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
  const itemsTab = Array.from(app.host.querySelectorAll<HappyButton>('button[role="tab"]')).find(
    (tab) => tab.textContent.startsWith('自分の分'),
  );
  assert.ok(itemsTab);
  await act(async () => itemsTab.click());
  assert.equal(app.button('ドリンクの数を減らす').disabled, true);
  assert.equal(app.button('ドリンクの数を増やす').disabled, true);
  assert.equal(app.button('ピザ：選択済み').disabled, true);
  await app.click('ドリンクの数を減らす');
  await app.click('ピザ：選択済み');
  assert.equal(app.selections.length, 0);
});

test('summary exposes the remaining units and their unpaid amount before allowing finalization', async (t) => {
  const room = mixedRoom();
  room.selections.a = ['drink', 'pizza'];
  room.selectionQuantities!.a = { drink: 1 };
  room.members[0].done = true;
  const app = await mountApp(t, room);
  await app.click('みんなの金額');
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
  assert.equal(app.button('1行目：各自').getAttribute('aria-pressed'), 'true');
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
  await app.click('みんなの金額');
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
