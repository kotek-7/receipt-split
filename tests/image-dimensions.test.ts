import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readImageDimensions, resizeDimensions } from '../shared/image-dimensions.ts';
import { prepareReceiptImage } from '../src/prepare-image.ts';

function jpeg(width: number, height: number, orientation?: number, littleEndian = true) {
  const exif = new Uint8Array(36);
  exif.set([0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0]);
  const view = new DataView(exif.buffer);
  view.setUint16(10, littleEndian ? 0x4949 : 0x4d4d);
  view.setUint16(12, 42, littleEndian);
  view.setUint32(14, 8, littleEndian);
  view.setUint16(18, 1, littleEndian);
  view.setUint16(20, 0x0112, littleEndian);
  view.setUint16(22, 3, littleEndian);
  view.setUint32(24, 1, littleEndian);
  view.setUint16(28, orientation ?? 1, littleEndian);
  const frame = new Uint8Array([
    255,
    192,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
  ]);
  return new Uint8Array([255, 216, ...(orientation ? exif : []), ...frame, 255, 217]);
}

function png(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number) {
  const size = kind === 'VP8L' ? 5 : 10;
  const bytes = new Uint8Array(20 + size + (size % 2));
  bytes.set(new TextEncoder().encode('RIFF'));
  bytes.set(new TextEncoder().encode('WEBP' + kind), 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, size, true);
  if (kind === 'VP8 ') {
    bytes.set([157, 1, 42], 23);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  } else if (kind === 'VP8L') {
    bytes[20] = 0x2f;
    view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  } else {
    for (let i = 0; i < 3; i++) {
      bytes[24 + i] = ((width - 1) >>> (8 * i)) & 255;
      bytes[27 + i] = ((height - 1) >>> (8 * i)) & 255;
    }
  }
  return bytes;
}

test('reads JPEG camera dimensions and both TIFF byte orders without decoding pixels', () => {
  assert.deepEqual(readImageDimensions(jpeg(4032, 3024)), { width: 4032, height: 3024 });
  for (const littleEndian of [true, false]) {
    for (let orientation = 1; orientation <= 8; orientation++) {
      assert.deepEqual(
        readImageDimensions(jpeg(4032, 3024, orientation, littleEndian)),
        orientation < 5 ? { width: 4032, height: 3024 } : { width: 3024, height: 4032 },
      );
    }
  }
});

test('reads PNG and each WebP encoding, including a byte view with an offset', () => {
  for (const bytes of [
    png(1200, 1600),
    ...(['VP8 ', 'VP8L', 'VP8X'] as const).map((kind) => webp(kind, 1200, 1600)),
  ]) {
    assert.deepEqual(readImageDimensions(bytes), { width: 1200, height: 1600 });
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 4);
    assert.deepEqual(readImageDimensions(padded.subarray(4, -4)), { width: 1200, height: 1600 });
  }
});

test('truncated and malformed metadata are rejected without out-of-bounds reads', () => {
  for (const bytes of [jpeg(4032, 3024, 6), png(1200, 1600), webp('VP8X', 1200, 1600)]) {
    for (let size = 0; size < bytes.length; size++) {
      assert.doesNotThrow(() => readImageDimensions(bytes.subarray(0, size)));
    }
  }
  assert.equal(readImageDimensions(new Uint8Array()), undefined);
  assert.equal(readImageDimensions(png(0, 1600)), undefined);
  assert.equal(readImageDimensions(jpeg(4032, 3024, 9)), undefined);
  const badOffset = jpeg(4032, 3024, 6);
  new DataView(badOffset.buffer).setUint32(16, 0xfffffff0, true);
  assert.equal(readImageDimensions(badOffset), undefined);
  const badChunk = webp('VP8X', 1200, 1600);
  new DataView(badChunk.buffer).setUint32(16, 0xffffffff, true);
  assert.equal(readImageDimensions(badChunk), undefined);
  assert.equal(readImageDimensions(jpeg(4032, 3024).subarray(0, 7)), undefined);
});

test('bounds 12 MP, square, and tall receipt images without enlarging small ones', () => {
  assert.deepEqual(resizeDimensions(4032, 3024), { width: 1600, height: 1200 });
  assert.deepEqual(resizeDimensions(3024, 4032), { width: 1200, height: 1600 });
  assert.deepEqual(resizeDimensions(800, 12000), { width: 213, height: 3200 });
  assert.deepEqual(resizeDimensions(640, 2560), { width: 640, height: 2560 });
  assert.deepEqual(resizeDimensions(900, 2700), { width: 800, height: 2400 });
  assert.deepEqual(resizeDimensions(640, 480), { width: 640, height: 480 });
  const square = resizeDimensions(8000, 8000);
  assert.ok(square.width * square.height <= 1_920_000);
  assert.ok(square.width <= 3200 && square.height <= 3200);
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.throws(() => resizeDimensions(invalid, 100));
  }
});

function replaceGlobal(t: TestContext, name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}

test('preparation requests a resized oriented bitmap and releases it and the canvas', async (t) => {
  let closed = 0;
  const result = new Blob(['small preview'], { type: 'image/png' });
  const bitmap = { close: () => closed++ };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillRect() {},
      drawImage(image: unknown, x: number, y: number, width: number, height: number) {
        assert.equal(image, bitmap);
        assert.deepEqual([x, y, width, height], [0, 0, 1200, 1600]);
      },
    }),
    toBlob(callback: (blob: Blob) => void, type: string) {
      assert.equal(type, 'image/png');
      assert.equal(closed, 1);
      callback(result);
    },
  };
  replaceGlobal(t, 'createImageBitmap', async (_file: File, options: ImageBitmapOptions) => {
    assert.equal(options.imageOrientation, 'from-image');
    assert.deepEqual([options.resizeWidth, options.resizeHeight], [1200, 1600]);
    return bitmap;
  });
  replaceGlobal(t, 'document', { createElement: () => canvas });
  const photo = new File([jpeg(4032, 3024, 6)], 'photo.jpg', { type: 'image/jpeg' });
  assert.equal(await prepareReceiptImage(photo), result);
  assert.equal(closed, 1);
  assert.deepEqual([canvas.width, canvas.height], [0, 0]);
});

test('a failed bitmap decode is not retried at full resolution', async (t) => {
  let attempts = 0;
  replaceGlobal(t, 'createImageBitmap', async () => {
    attempts++;
    throw new Error('allocation failed');
  });
  const photo = new File([jpeg(4032, 3024)], 'photo.jpg', { type: 'image/jpeg' });
  await assert.rejects(prepareReceiptImage(photo), /アプリ内のカメラ/);
  assert.equal(attempts, 1);
});

test('cancellation during bitmap decoding closes the returned bitmap before drawing', async (t) => {
  const controller = new AbortController();
  let closed = 0;
  replaceGlobal(t, 'createImageBitmap', async () => {
    controller.abort();
    return { close: () => closed++ };
  });
  replaceGlobal(t, 'document', {
    createElement() {
      assert.fail('cancelled preparation must not allocate a canvas');
    },
  });
  const photo = new File([jpeg(4032, 3024)], 'photo.jpg', { type: 'image/jpeg' });
  await assert.rejects(prepareReceiptImage(photo, controller.signal), { name: 'AbortError' });
  assert.equal(closed, 1);
});

test('a failed canvas draw releases both bitmap and allocated canvas', async (t) => {
  let closed = 0;
  replaceGlobal(t, 'createImageBitmap', async () => ({ close: () => closed++ }));
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillRect() {},
      drawImage() {
        throw new Error('drawing failed');
      },
    }),
  };
  replaceGlobal(t, 'document', { createElement: () => canvas });
  const photo = new File([jpeg(4032, 3024)], 'photo.jpg', { type: 'image/jpeg' });
  await assert.rejects(prepareReceiptImage(photo), /drawing failed/);
  assert.equal(closed, 1);
  assert.deepEqual([canvas.width, canvas.height], [0, 0]);
});
