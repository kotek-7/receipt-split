import {
  readImageDimensions,
  resizeDimensions,
  RECEIPT_IMAGE_MAX_PIXELS,
} from '../shared/image-dimensions.ts';

const MAX_HEADER_BYTES = 512 * 1024;
const UNREADABLE_IMAGE =
  'この写真を開けませんでした。アプリ内のカメラで撮るか、別の JPEG・PNG・WebP 画像を選んでください。';

/** Resize before keeping a decoded image, and reuse the small result for OCR and preview. */
export async function prepareReceiptImage(file: File, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const header = new Uint8Array(await file.slice(0, MAX_HEADER_BYTES).arrayBuffer());
  signal?.throwIfAborted();
  const source = readImageDimensions(header);
  if (!source) throw new Error(UNREADABLE_IMAGE);
  const size = resizeDimensions(source.width, source.height);
  let bitmap: ImageBitmap | undefined;
  let element: HTMLImageElement | undefined;
  let objectUrl: string | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    if (typeof createImageBitmap === 'function') {
      // Do not retry a failed decode at full resolution: that increases memory pressure.
      try {
        bitmap = await createImageBitmap(file, {
          imageOrientation: 'from-image',
          resizeWidth: size.width,
          resizeHeight: size.height,
          resizeQuality: 'high',
        });
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
    context.drawImage(bitmap ?? element!, 0, 0, size.width, size.height);
    bitmap?.close();
    bitmap = undefined;
    if (element) element.src = '';
    const result = await new Promise<Blob>((resolve, reject) => {
      canvas!.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('写真を準備できませんでした。もう一度お試しください。'));
        },
        'image/jpeg',
        0.88,
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
