import {
  readImageDimensions,
  resizeDimensions,
  RECEIPT_IMAGE_MAX_PIXELS,
} from '../shared/image-dimensions.ts';
import { findReceiptRegion } from '../shared/receipt-region.ts';

type Crop = {
  x: number;
  y: number;
  width: number;
  height: number;
  polygon: { x: number; y: number }[];
};

const MAX_HEADER_BYTES = 512 * 1024;
const UNREADABLE_IMAGE =
  'この写真を開けませんでした。アプリ内のカメラで撮るか、別の JPEG・PNG・WebP 画像を選んでください。';

/** Inspect a small thumbnail, then release it before decoding the receipt itself. */
async function locatePaper(
  file: File,
  source: { width: number; height: number },
  signal?: AbortSignal,
): Promise<Crop | undefined> {
  const scale = Math.min(1, 512 / Math.max(source.width, source.height));
  const width = Math.max(1, Math.floor(source.width * scale));
  const height = Math.max(1, Math.floor(source.height * scale));
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
    signal?.throwIfAborted();
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) throw new Error('写真を準備できませんでした。もう一度お試しください。');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    bitmap = undefined;
    const region = findReceiptRegion(context.getImageData(0, 0, width, height).data, width, height);
    signal?.throwIfAborted();
    if (!region) return undefined;
    const scaleX = source.width / width;
    const scaleY = source.height / height;
    const x = Math.max(0, Math.floor(region.x * scaleX));
    const y = Math.max(0, Math.floor(region.y * scaleY));
    const right = Math.min(source.width, Math.ceil((region.x + region.width) * scaleX));
    const bottom = Math.min(source.height, Math.ceil((region.y + region.height) * scaleY));
    return {
      x,
      y,
      width: right - x,
      height: bottom - y,
      polygon: region.polygon.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY })),
    };
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

/** Resize before keeping a decoded image, and reuse the small result for OCR and preview. */
export async function prepareReceiptImage(file: File, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const header = new Uint8Array(await file.slice(0, MAX_HEADER_BYTES).arrayBuffer());
  signal?.throwIfAborted();
  const source = readImageDimensions(header);
  if (!source) throw new Error(UNREADABLE_IMAGE);
  let size = resizeDimensions(source.width, source.height);
  let crop: Crop | undefined;
  let bitmap: ImageBitmap | undefined;
  let element: HTMLImageElement | undefined;
  let objectUrl: string | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    if (typeof createImageBitmap === 'function') {
      // Do not retry a failed decode at full resolution: that increases memory pressure.
      try {
        crop = await locatePaper(file, source, signal);
        signal?.throwIfAborted();
        if (crop) size = resizeDimensions(crop.width, crop.height);
        const options: ImageBitmapOptions = {
          imageOrientation: 'from-image',
          resizeWidth: size.width,
          resizeHeight: size.height,
          resizeQuality: 'high',
        };
        bitmap = crop
          ? await createImageBitmap(file, crop.x, crop.y, crop.width, crop.height, options)
          : await createImageBitmap(file, options);
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(UNREADABLE_IMAGE, { cause: error });
      }
      signal?.throwIfAborted();
    } else {
      if (source.width * source.height > RECEIPT_IMAGE_MAX_PIXELS) {
        throw new Error(
          'このブラウザーでは大きい写真を読み取れません。アプリ内のカメラで撮るか、小さい画像を選んでください。',
        );
      }
      objectUrl = URL.createObjectURL(file);
      element = new Image();
      const imageElement = element;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          imageElement.onload = null;
          imageElement.onerror = null;
          signal?.removeEventListener('abort', abort);
        };
        const abort = () => {
          cleanup();
          reject(signal?.reason ?? new DOMException('読み取りを中止しました。', 'AbortError'));
        };
        imageElement.onload = () => {
          cleanup();
          resolve();
        };
        imageElement.onerror = () => {
          cleanup();
          reject(new Error(UNREADABLE_IMAGE));
        };
        signal?.addEventListener('abort', abort, { once: true });
        imageElement.src = objectUrl!;
      });
      signal?.throwIfAborted();
    }
    canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('写真を準備できませんでした。もう一度お試しください。');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, size.width, size.height);
    if (crop) {
      // Keep print inside the paper, including dark letters/holes in its bright region.
      // A rectangle alone would leave textured background beside a tilted receipt.
      context.save();
      context.beginPath();
      crop.polygon.forEach((point, index) => {
        const x = ((point.x - crop!.x) / crop!.width) * size.width;
        const y = ((point.y - crop!.y) / crop!.height) * size.height;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
      context.clip();
    }
    context.drawImage(bitmap ?? element!, 0, 0, size.width, size.height);
    if (crop) context.restore();
    bitmap?.close();
    bitmap = undefined;
    if (element) element.src = '';
    const result = await new Promise<Blob>((resolve, reject) => {
      canvas!.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('写真を準備できませんでした。もう一度お試しください。'));
        },
        // Preserve fine Japanese strokes without another lossy JPEG encoding.
        'image/png',
      );
    });
    signal?.throwIfAborted();
    return result;
  } finally {
    bitmap?.close();
    if (element) {
      element.onload = null;
      element.onerror = null;
      element.src = '';
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
