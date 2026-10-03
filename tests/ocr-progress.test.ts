import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { Worker } from 'tesseract.js';
import type { ReceiptScanProgress } from '../shared/receipt-progress';
import { recognizeReceipt } from '../src/ocr';

test('local OCR reports its actual stages and recognizing-text progress, then stops on cancellation', async (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  const header = new Uint8Array(33);
  header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(header.buffer).setUint32(16, 2);
  new DataView(header.buffer).setUint32(20, 2);
  const file = new File([header], 'receipt.png', { type: 'image/png' });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          fillRect() {},
          drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray(16) }),
        }),
        toBlob: (callback: (blob: Blob) => void) =>
          callback(new Blob([header], { type: 'image/png' })),
      }),
    },
  });
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({ width: 2, height: 2, close() {} }),
  });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalBitmap);
    else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  });

  const tesseract = createRequire(import.meta.url)('tesseract.js') as typeof import('tesseract.js');
  let abort = new AbortController();
  let cancelDuringLoading = false;
  let terminated = 0;
  t.mock.method(
    tesseract,
    'createWorker',
    async (...[_languages, _oem, options]: Parameters<typeof tesseract.createWorker>) => {
      const log = (status: string, progress: number) =>
        options?.logger?.({
          status,
          progress,
          jobId: 'job',
          userJobId: 'user-job',
          workerId: 'worker',
        });
      log('loading language traineddata', 0.1);
      log('loading language traineddata', 0.95);
      log('initializing api', 1);
      if (cancelDuringLoading) {
        abort.abort();
        log('recognizing text', 0.75);
      }
      return {
        setParameters: async () => {},
        recognize: async () => {
          for (const progress of [0, 0.6, 0.3, Number.NaN, -1, 0.9, 1, 1.2])
            log('recognizing text', progress);
          return { data: { text: 'ビール 600\n合計 600' } };
        },
        terminate: async () => {
          terminated += 1;
        },
      } as unknown as Worker;
    },
  );

  const notifications: ReceiptScanProgress[] = [];
  await recognizeReceipt(file, (value) => notifications.push(value), abort.signal, 'local');
  assert.deepEqual(notifications, [
    { stage: 'preparing' },
    { stage: 'loading' },
    { stage: 'reading' },
    { stage: 'reading', percent: 0 },
    { stage: 'reading', percent: 60 },
    { stage: 'reading', percent: 90 },
    { stage: 'reading', percent: 100 },
    { stage: 'checking' },
  ]);
  assert.equal(terminated, 1);

  abort = new AbortController();
  cancelDuringLoading = true;
  notifications.length = 0;
  await assert.rejects(
    recognizeReceipt(file, (value) => notifications.push(value), abort.signal, 'local'),
    { name: 'AbortError' },
  );
  assert.deepEqual(notifications, [{ stage: 'preparing' }, { stage: 'loading' }]);
  assert.equal(terminated, 2, 'the worker created after cancellation must still be terminated');
});
