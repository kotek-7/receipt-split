export type ImageDimensions = { width: number; height: number };

// Tall receipts need vertical detail; the pixel budget still bounds decoded memory.
export const RECEIPT_IMAGE_MAX_EDGE = 3200;
export const RECEIPT_IMAGE_MAX_PIXELS = 1_920_000;

/** Keep the aspect ratio and never enlarge a source image. */
export function resizeDimensions(width: number, height: number): ImageDimensions {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('画像の大きさを確認できませんでした。');
  }
  const scale = Math.min(
    1,
    RECEIPT_IMAGE_MAX_EDGE / Math.max(width, height),
    Math.sqrt(RECEIPT_IMAGE_MAX_PIXELS / width / height),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/** Read only metadata; never decode pixels or allocate according to dimensions. */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const matches = (offset: number, values: number[]) =>
    offset + values.length <= bytes.length &&
    values.every((value, i) => bytes[offset + i] === value);
  const dimensions = (width: number, height: number): ImageDimensions | undefined =>
    width > 0 && height > 0 ? { width, height } : undefined;

  // PNG dimensions are in the first IHDR chunk. Require its complete body and CRC.
  if (matches(0, [137, 80, 78, 71, 13, 10, 26, 10])) {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || !matches(12, [73, 72, 68, 82])) {
      return undefined;
    }
    return dimensions(view.getUint32(16), view.getUint32(20));
  }

  if (matches(0, [82, 73, 70, 70]) && matches(8, [87, 69, 66, 80])) {
    if (bytes.length < 20) return undefined;
    const containerEnd = view.getUint32(4, true) + 8;
    const chunkSize = view.getUint32(16, true);
    if (containerEnd < 20 + chunkSize) return undefined;
    if (matches(12, [86, 80, 56, 88])) {
      // VP8X carries 24-bit canvas dimensions minus one.
      if (chunkSize !== 10 || bytes.length < 30) return undefined;
      const uint24 = (offset: number) =>
        bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
      return dimensions(uint24(24) + 1, uint24(27) + 1);
    }
    if (matches(12, [86, 80, 56, 32])) {
      // Lossy VP8 keyframe header includes a sync code and 14-bit dimensions.
      if (chunkSize < 10 || bytes.length < 30 || !matches(23, [157, 1, 42])) return undefined;
      return dimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    if (matches(12, [86, 80, 56, 76])) {
      if (chunkSize < 5 || bytes.length < 25 || bytes[20] !== 0x2f) return undefined;
      const bits = view.getUint32(21, true);
      if (bits >>> 29 !== 0) return undefined;
      return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return undefined;
  }

  if (!matches(0, [255, 216])) return undefined;
  let result: ImageDimensions | undefined;
  let orientation = 1;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return undefined;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset++];
    if (marker === 0xd9) break;
    if (marker === 0 || marker === 0xd8) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = view.getUint16(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) return undefined;
    // All image metadata precedes compressed scan data.
    if (marker === 0xda) break;
    if (marker === 0xe1 && matches(offset + 2, [69, 120, 105, 102, 0, 0])) {
      const value = readExifOrientation(view, offset + 8, end);
      if (value === undefined) return undefined;
      orientation = value;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) return undefined;
      const components = bytes[offset + 7];
      if (components < 1 || length < 8 + 3 * components) return undefined;
      result = dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      if (!result) return undefined;
    }
    offset = end;
  }
  return result && orientation >= 5 ? { width: result.height, height: result.width } : result;
}

function readExifOrientation(view: DataView, start: number, end: number): number | undefined {
  if (start + 8 > end) return undefined;
  const byteOrder = view.getUint16(start);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return undefined;
  const littleEndian = byteOrder === 0x4949;
  if (view.getUint16(start + 2, littleEndian) !== 42) return undefined;
  const directory = start + view.getUint32(start + 4, littleEndian);
  if (directory < start + 8 || directory + 2 > end) return undefined;
  const entries = view.getUint16(directory, littleEndian);
  if (directory + 2 + entries * 12 + 4 > end) return undefined;
  for (let i = 0; i < entries; i++) {
    const entry = directory + 2 + i * 12;
    if (view.getUint16(entry, littleEndian) !== 0x0112) continue;
    if (
      view.getUint16(entry + 2, littleEndian) !== 3 ||
      view.getUint32(entry + 4, littleEndian) !== 1
    ) {
      return undefined;
    }
    const orientation = view.getUint16(entry + 8, littleEndian);
    return orientation >= 1 && orientation <= 8 ? orientation : undefined;
  }
  return 1;
}
