import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import test, { type TestContext } from 'node:test';
import { Window, type HTMLButtonElement as HappyButton } from 'happy-dom';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Node tests exercise the React lifecycle; Vite owns stylesheet loading in the app.
if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    },
  });
} else {
  // Node 22.13/22.14 predate synchronous module hooks.
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
const { default: CameraCapture } = await import('../src/CameraCapture.tsx');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeStream(events: string[], name = 'camera') {
  return {
    getTracks: () => [
      { stop: () => events.push(`${name}:video stopped`) },
      { stop: () => events.push(`${name}:second track stopped`) },
    ],
  } as unknown as MediaStream;
}

async function mountCamera(
  t: TestContext,
  options: {
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    encode?: (callback: BlobCallback) => void;
    strict?: boolean;
    events?: string[];
  } = {},
) {
  const window = new Window({ url: 'https://reciwake.example/' });
  const document = window.document;
  const events = options.events ?? [];
  const constraints: MediaStreamConstraints[] = [];
  const encoded: {
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    type: string;
    quality: number;
  }[] = [];
  const captures: File[] = [];
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: {
      getUserMedia: (requested: MediaStreamConstraints) => {
        constraints.push(requested);
        return options.getUserMedia?.(requested) ?? Promise.resolve(fakeStream(events));
      },
    },
  });
  Object.assign(window.HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.open = true;
    },
    close(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  Object.assign(window.HTMLVideoElement.prototype, {
    async play() {},
    pause() {},
  });
  Object.defineProperty(window.HTMLVideoElement.prototype, 'srcObject', {
    value: null,
    writable: true,
    configurable: true,
  });
  Object.assign(window.HTMLCanvasElement.prototype, {
    getContext() {
      return {
        drawImage() {
          events.push('frame drawn');
        },
      };
    },
    toBlob(this: HTMLCanvasElement, callback: BlobCallback, type: string, quality: number) {
      encoded.push({ canvas: this, width: this.width, height: this.height, type, quality });
      if (options.encode) options.encode(callback);
      else callback(new Blob(['receipt'], { type }));
    },
  });
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
  const component = createElement(CameraCapture, {
    onCapture(file: File) {
      events.push('capture');
      const video = host.querySelector('video');
      assert.equal(video?.srcObject, null, 'camera must be detached before OCR starts');
      assert.equal(encoded.at(-1)?.canvas.width, 0, 'canvas must be released before OCR starts');
      captures.push(file);
      root.render(null);
    },
    onClose() {
      events.push('close');
      root.render(null);
    },
    onPickPhoto() {
      events.push('pick photo');
      root.render(null);
    },
  });
  await act(async () =>
    root.render(options.strict ? createElement(StrictMode, {}, component) : component),
  );
  return {
    window,
    host,
    events,
    captures,
    encoded,
    constraints,
    shutter: () => host.querySelector<HappyButton>('.button.primary')!,
    async ready(width = 4032, height = 3024) {
      const video = host.querySelector('video')!;
      Object.defineProperties(video, {
        videoWidth: { value: width, configurable: true },
        videoHeight: { value: height, configurable: true },
        readyState: { value: 2, configurable: true },
      });
      await act(async () => video.dispatchEvent(new window.Event('loadeddata')));
    },
    async click(selector: string) {
      const button = host.querySelector<HappyButton>(selector)!;
      assert.ok(button, `missing button ${selector}`);
      await act(async () => button.click());
    },
  };
}

test('camera waits for a decoded frame, bounds JPEG size, and releases resources before capture', async (t) => {
  const camera = await mountCamera(t);
  assert.equal(camera.host.querySelector('dialog')?.open, true);
  assert.equal(camera.shutter().disabled, true);
  await camera.click('.button.primary');
  assert.equal(camera.encoded.length, 0);
  assert.deepEqual(camera.constraints[0], {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1600 },
      height: { ideal: 1200 },
      frameRate: { ideal: 15, max: 24 },
    },
    audio: false,
  });
  await camera.ready();
  assert.equal(camera.shutter().disabled, false);
  await camera.click('.button.primary');
  assert.equal(camera.captures.length, 1);
  assert.equal(camera.captures[0].type, 'image/jpeg');
  const { width, height, type, quality, canvas } = camera.encoded[0];
  assert.deepEqual(
    { width, height, type, quality },
    {
      width: 1600,
      height: 1200,
      type: 'image/jpeg',
      quality: 0.88,
    },
  );
  assert.deepEqual([canvas.width, canvas.height], [0, 0]);
  assert.deepEqual(camera.events, [
    'frame drawn',
    'camera:video stopped',
    'camera:second track stopped',
    'capture',
  ]);
});

test('square camera frames also obey the pixel budget', async (t) => {
  const camera = await mountCamera(t);
  await camera.ready(4000, 4000);
  await camera.click('.button.primary');
  const { width, height } = camera.encoded[0];
  assert.ok(width <= 1600 && height <= 1600);
  assert.ok(width * height <= 1_920_000);
  assert.equal(width, height);
});

test('closing before camera permission resolves stops every late track', async (t) => {
  const opening = deferred<MediaStream>();
  const camera = await mountCamera(t, { getUserMedia: () => opening.promise });
  await camera.click('.camera-close');
  await act(async () => opening.resolve(fakeStream(camera.events, 'late')));
  assert.deepEqual(camera.events, ['close', 'late:video stopped', 'late:second track stopped']);
  assert.equal(camera.captures.length, 0);
});

test('closing while JPEG encoding is pending discards the photo and releases its canvas', async (t) => {
  let finish!: BlobCallback;
  const camera = await mountCamera(t, {
    encode: (callback) => {
      finish = callback;
    },
  });
  await camera.ready();
  await camera.click('.button.primary');
  assert.equal(camera.shutter().disabled, true);
  await camera.click('.button.primary');
  assert.equal(camera.encoded.length, 1, 'repeated clicks must not start another encoding');
  await camera.click('.camera-close');
  await act(async () => finish(new Blob(['receipt'], { type: 'image/jpeg' })));
  assert.equal(camera.captures.length, 0);
  assert.deepEqual([camera.encoded[0].canvas.width, camera.encoded[0].canvas.height], [0, 0]);
  assert.deepEqual(camera.events, [
    'frame drawn',
    'camera:video stopped',
    'camera:second track stopped',
    'close',
  ]);
});

test('permission denial leaves a useful photo fallback and no capture action', async (t) => {
  const camera = await mountCamera(t, {
    getUserMedia: async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    },
  });
  assert.match(
    camera.host.querySelector('[role="alert"]')?.textContent ?? '',
    /許可されていません/,
  );
  assert.equal(camera.shutter().disabled, true);
  await camera.click('.button.secondary');
  assert.deepEqual(camera.events, ['pick photo']);
  assert.equal(camera.constraints.length, 1, 'fallback must not reopen a camera automatically');
});

test('Escape cancels the dialog and stops all live tracks', async (t) => {
  const camera = await mountCamera(t);
  const cancel = new camera.window.Event('cancel', { cancelable: true });
  await act(async () => camera.host.querySelector('dialog')!.dispatchEvent(cancel));
  assert.equal(cancel.defaultPrevented, true);
  assert.deepEqual(camera.events, ['camera:video stopped', 'camera:second track stopped', 'close']);
});

test('React StrictMode releases the discarded camera request without stopping the live request', async (t) => {
  const requests = [deferred<MediaStream>(), deferred<MediaStream>()];
  const events: string[] = [];
  let index = 0;
  const camera = await mountCamera(t, {
    strict: true,
    events,
    getUserMedia: () => requests[index++].promise,
  });
  assert.equal(index, 2);
  await act(async () => requests[1].resolve(fakeStream(events, 'live')));
  await act(async () => requests[0].resolve(fakeStream(events, 'discarded')));
  assert.deepEqual(events, ['discarded:video stopped', 'discarded:second track stopped']);
  assert.ok(camera.host.querySelector('video')?.srcObject);
  await camera.click('.button.secondary');
  assert.deepEqual(events.slice(-3), [
    'live:video stopped',
    'live:second track stopped',
    'pick photo',
  ]);
});

test('JPEG encoding failure keeps the camera available for another attempt', async (t) => {
  let attempts = 0;
  const camera = await mountCamera(t, {
    encode(callback) {
      callback(attempts++ ? new Blob(['receipt'], { type: 'image/jpeg' }) : null);
    },
  });
  await camera.ready();
  await camera.click('.button.primary');
  assert.match(camera.host.querySelector('[role="alert"]')?.textContent ?? '', /もう一度/);
  assert.equal(camera.shutter().disabled, false);
  assert.equal(camera.captures.length, 0);
  await camera.click('.button.primary');
  assert.equal(camera.captures.length, 1);
});
