import type { Worker } from 'tesseract.js';
import { parseReceipt } from '../shared/parse-receipt.ts';
import type { ParsedReceipt } from '../shared/types.ts';

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2200;

async function imageForRecognition(file: File): Promise<Blob> {
  let drawable: ImageBitmap | HTMLImageElement | undefined;
  let objectUrl: string | undefined;
  try {
    if (typeof createImageBitmap === 'function') {
      try {
        drawable = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        drawable = await loadImage();
      }
    } else {
      drawable = await loadImage();
    }
    const width = drawable instanceof HTMLImageElement ? drawable.naturalWidth : drawable.width;
    const height = drawable instanceof HTMLImageElement ? drawable.naturalHeight : drawable.height;
    if (!width || !height) throw new Error('写真を開けませんでした。別の画像を選んでください。');
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('画像の準備に失敗しました。別のブラウザーでお試しください。');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(drawable, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        canvas.width = 0;
        canvas.height = 0;
        if (blob) resolve(blob);
        else reject(new Error('画像の準備に失敗しました。もう一度お試しください。'));
      }, 'image/png');
    });
  } finally {
    if (drawable && 'close' in drawable) drawable.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  function loadImage(): Promise<HTMLImageElement> {
    objectUrl = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () =>
        reject(new Error('写真を開けませんでした。JPEG・PNG・WebP の画像を選んでください。'));
      element.src = objectUrl!;
    });
  }
}

/** Reads the photo on this device. Only OCR engine/language files are downloaded. */
export async function recognizeReceipt(
  file: File,
  onProgress: (progress: number) => void,
): Promise<ParsedReceipt> {
  if (/heic|heif/i.test(file.type) || /\.(?:heic|heif)$/i.test(file.name)) {
    throw new Error(
      'HEIC 形式はまだ読み取れません。JPEG の写真かスクリーンショットを選んでください。',
    );
  }
  if (
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) &&
    !(file.type === '' && /\.(?:jpe?g|png|webp)$/i.test(file.name))
  ) {
    throw new Error('JPEG・PNG・WebP の写真を選んでください。');
  }
  if (file.size > MAX_FILE_SIZE) throw new Error('写真は 20 MB 以下のものを選んでください。');
  if (file.size === 0) throw new Error('写真が空です。別の写真を選んでください。');
  if (typeof document === 'undefined')
    throw new Error('写真の読み取りはブラウザーでご利用ください。');

  let worker: Worker | undefined;
  let progress = 0;
  const report = (value: number) => {
    const next = Math.max(progress, Math.min(100, Math.round(value)));
    if (next !== progress) {
      progress = next;
      onProgress(next);
    }
  };
  report(1);
  try {
    const image = await imageForRecognition(file);
    report(5);
    const { createWorker, PSM } = await import('tesseract.js');
    worker = await createWorker(['jpn', 'eng'], 1, {
      logger: ({ status, progress: stageProgress }) => {
        if (status === 'recognizing text') report(35 + stageProgress * 63);
        else if (status === 'loading language traineddata') report(12 + stageProgress * 18);
        else if (status === 'initializing api') report(30 + stageProgress * 4);
        else report(6 + stageProgress * 5);
      },
    });
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    const { data } = await worker.recognize(image);
    if (!data.text.trim())
      throw new Error(
        '文字が見つかりませんでした。レシートを明るい場所で、正面から撮ってください。',
      );
    const parsed = parseReceipt(data.text);
    report(100);
    return parsed;
  } catch (error) {
    if (error instanceof Error && /[\u3040-\u30ff\u3400-\u9fff]/.test(error.message)) throw error;
    throw new Error(
      '読み取りに失敗しました。初回は読み取りデータのダウンロードが必要です。通信を確認して再試行するか、手入力で続けてください。',
      { cause: error },
    );
  } finally {
    await worker?.terminate().catch(() => undefined);
  }
}
