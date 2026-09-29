import assert from 'node:assert/strict';
import test from 'node:test';
import { findReceiptRegion, type ReceiptPoint } from '../shared/receipt-region.ts';

function scene(width = 160, height = 240, background = 40) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const set = (x: number, y: number, value: number) => {
    const i = (y * width + x) * 4;
    pixels[i] = value;
    pixels[i + 1] = value;
    pixels[i + 2] = value;
    pixels[i + 3] = 255;
  };
  const rectangle = (x: number, y: number, w: number, h: number, value: number) => {
    for (let row = y; row < y + h; row++) {
      for (let column = x; column < x + w; column++) set(column, row, value);
    }
  };
  rectangle(0, 0, width, height, background);
  return { pixels, width, height, set, rectangle };
}

function inside(point: ReceiptPoint, polygon: ReceiptPoint[]) {
  let winding = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      winding = !winding;
  }
  return winding;
}

test('detects an off-center paper on textured dark background and preserves text holes', () => {
  const image = scene();
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) image.set(x, y, 25 + ((x * 7 + y * 11) % 70));
  }
  image.rectangle(15, 20, 70, 200, 235);
  for (let y = 38; y < 205; y += 14) image.rectangle(22, y, 55, 3, 30);
  const result = findReceiptRegion(image.pixels, image.width, image.height);
  assert.ok(result);
  assert.deepEqual(
    { x: result.x, y: result.y, width: result.width, height: result.height },
    { x: 13, y: 18, width: 74, height: 204 },
  );
  assert.ok(inside({ x: 40, y: 39 }, result.polygon), 'dark printed text must remain inside');
  assert.ok(inside({ x: 17, y: 22 }, result.polygon), 'printed interior must survive');
  assert.ok(inside({ x: 80, y: 216 }, result.polygon), 'footer must remain inside');
  assert.equal(
    inside({ x: 15.5, y: 100 }, result.polygon),
    false,
    'mixed edge pixels are excluded',
  );
  assert.equal(inside({ x: 110, y: 140 }, result.polygon), false);
});

test('trapezoid polygon excludes background wedges inside its bounding rectangle', () => {
  const image = scene();
  for (let y = 30; y < 230; y++) {
    const fraction = (y - 30) / 199;
    const left = Math.round(70 - 35 * fraction);
    const right = Math.round(115 + 15 * fraction);
    image.rectangle(left, y, right - left, 1, 220);
  }
  for (let y = 50; y < 220; y += 12) image.rectangle(77, y, 27, 3, 35);
  const result = findReceiptRegion(image.pixels, image.width, image.height);
  assert.ok(result);
  assert.ok(result.x <= 35 && result.x + result.width >= 130);
  assert.ok(inside({ x: 90, y: 51 }, result.polygon), 'letter holes are filled by the hull');
  assert.ok(inside({ x: 90, y: 228 }, result.polygon), 'bottom rows are preserved');
  assert.equal(inside({ x: 42, y: 40 }, result.polygon), false, 'left leather wedge is excluded');
  assert.equal(inside({ x: 128, y: 40 }, result.polygon), false, 'right leather wedge is excluded');
});

test('paper outline stays inside bright leather flecks on the paper boundary', () => {
  const image = scene();
  image.rectangle(45, 20, 75, 200, 230);
  // Small bright flecks touching the sheet must not extend its OCR clipping area outwards.
  for (const y of [25, 70, 125, 200]) image.rectangle(44, y, 1, 2, 230);
  const result = findReceiptRegion(image.pixels, image.width, image.height);
  assert.ok(result);
  assert.equal(inside({ x: 44.5, y: 71 }, result.polygon), false);
  assert.equal(inside({ x: 45.1, y: 125 }, result.polygon), false);
  assert.ok(inside({ x: 48, y: 125 }, result.polygon));
  assert.ok(inside({ x: 80, y: 215 }, result.polygon));
});

test('curved paper edges exclude dark wedges that a convex hull would retain', () => {
  const image = scene();
  for (let y = 20; y < 220; y++) {
    const bend = Math.sin(((y - 20) / 199) * Math.PI);
    const left = 40 + Math.round(20 * bend);
    const right = 120 - Math.round(8 * bend);
    image.rectangle(left, y, right - left, 1, 235);
  }
  for (let y = 40; y < 210; y += 14) image.rectangle(72, y, 30, 3, 30);
  const result = findReceiptRegion(image.pixels, image.width, image.height);
  assert.ok(result);
  assert.equal(
    inside({ x: 50, y: 120 }, result.polygon),
    false,
    'left curved background is outside',
  );
  assert.equal(
    inside({ x: 116, y: 120 }, result.polygon),
    false,
    'right curved background is outside',
  );
  assert.ok(inside({ x: 64, y: 120 }, result.polygon), 'paper interior beside its edge survives');
  assert.ok(inside({ x: 80, y: 97 }, result.polygon), 'black item-name strokes stay inside');
  assert.ok(inside({ x: 55, y: 217 }, result.polygon), 'footer retains its full paper width');
});

test('paper touching the bottom stays within the source bounds without dropping its footer', () => {
  const image = scene();
  image.rectangle(45, 30, 75, 210, 225);
  for (let y = 45; y < 240; y += 14) image.rectangle(52, y, 60, 2, 30);
  const result = findReceiptRegion(image.pixels, image.width, image.height);
  assert.ok(result);
  assert.equal(result.y + result.height, image.height);
  assert.ok(inside({ x: 80, y: 239.5 }, result.polygon));
  for (const point of result.polygon) {
    assert.ok(point.x >= 0 && point.x <= image.width);
    assert.ok(point.y >= 0 && point.y <= image.height);
  }
});

test('full white pages, white-background scans, and low contrast scenes are left unchanged', () => {
  const white = scene(160, 240, 255);
  assert.equal(findReceiptRegion(white.pixels, white.width, white.height), undefined);
  for (let y = 20; y < 220; y += 12) white.rectangle(20, y, 120, 3, 20);
  assert.equal(findReceiptRegion(white.pixels, white.width, white.height), undefined);
  const lowContrast = scene(160, 240, 200);
  lowContrast.rectangle(45, 20, 75, 200, 230);
  assert.equal(
    findReceiptRegion(lowContrast.pixels, lowContrast.width, lowContrast.height),
    undefined,
  );
});

test('multiple comparable sheets are ambiguous and are not cropped to just one receipt', () => {
  const image = scene();
  image.rectangle(10, 30, 55, 185, 235);
  image.rectangle(90, 40, 50, 160, 230);
  assert.equal(findReceiptRegion(image.pixels, image.width, image.height), undefined);
});

test('small highlights and disconnected bright texture are not mistaken for paper', () => {
  const image = scene();
  image.rectangle(70, 100, 8, 8, 250);
  assert.equal(findReceiptRegion(image.pixels, image.width, image.height), undefined);
  for (let y = 0; y < image.height; y += 4) {
    for (let x = 0; x < image.width; x += 4) image.rectangle(x, y, 2, 2, 225);
  }
  assert.equal(findReceiptRegion(image.pixels, image.width, image.height), undefined);
});

test('a sparse connected light texture fails the paper fill check', () => {
  const image = scene();
  for (let x = 10; x < 150; x += 8) image.rectangle(x, 20, 1, 200, 230);
  for (let y = 20; y < 220; y += 8) image.rectangle(10, y, 140, 1, 230);
  assert.equal(findReceiptRegion(image.pixels, image.width, image.height), undefined);
});

test('invalid dimensions, oversized analysis buffers, and transparency safely skip detection', () => {
  const empty = new Uint8ClampedArray();
  for (const [width, height] of [
    [0, 10],
    [10, 0],
    [16.5, 20],
    [NaN, 20],
    [Infinity, 20],
    [513, 100],
  ]) {
    assert.equal(findReceiptRegion(empty, width, height), undefined);
  }
  assert.equal(findReceiptRegion(new Uint8ClampedArray(20 * 20 * 4 - 1), 20, 20), undefined);
  const image = scene();
  image.rectangle(40, 20, 80, 200, 235);
  image.pixels[3] = 0;
  assert.equal(findReceiptRegion(image.pixels, image.width, image.height), undefined);
});
