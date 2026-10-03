import type { Worker } from 'tesseract.js';
import { parseReceipt } from '../shared/parse-receipt.ts';
import type { ParsedReceipt } from '../shared/types.ts';
import type { ReceiptScanProgress } from '../shared/receipt-progress';
import { prepareReceiptImage } from './prepare-image';
import { scanReceiptImage } from './receipt-scan';

const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Let the caller terminate a worker even if its current job never resolves. */
async function untilAborted<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([job, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export type ReceiptReader = 'ai' | 'local';

/** AI uploads only the prepared image; local mode never sends the photo. */
export async function recognizeReceipt(
  file: File,
  onProgress: (progress: ReceiptScanProgress) => void,
  signal: AbortSignal,
  reader: ReceiptReader = 'local',
): Promise<{ receipt: ParsedReceipt; preview: Blob }> {
  signal.throwIfAborted();
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
  const report = (progress: ReceiptScanProgress) => {
    if (!signal.aborted) onProgress(progress);
  };
  report({ stage: 'preparing' });
  try {
    const image = await prepareReceiptImage(file, signal);
    signal.throwIfAborted();
    if (reader === 'ai') {
      if (image.size > 8 * 1024 * 1024)
        throw new Error('画像が大きすぎます。小さい画像を選ぶか、撮り直してください。');
      report({ stage: 'uploading' });
      const receipt = await scanReceiptImage(image, report, signal);
      signal.throwIfAborted();
      return { receipt, preview: image };
    }
    report({ stage: 'loading' });
    const { createWorker, PSM } = await import('tesseract.js');
    signal.throwIfAborted();
    let progress = -1;
    // Keep initialization awaited even after cancellation, so its eventual worker
    // is terminated before the UI allows another memory-heavy recognition job.
    worker = await createWorker(['jpn', 'eng'], 1, {
      logger: ({ status, progress: stageProgress }) => {
        if (status !== 'recognizing text' || !Number.isFinite(stageProgress)) return;
        const next = Math.max(
          progress,
          Math.min(100, Math.max(0, Math.round(stageProgress * 100))),
        );
        if (next !== progress) {
          progress = next;
          report({ stage: 'reading', percent: next });
        }
      },
    });
    signal.throwIfAborted();
    await untilAborted(
      worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      }),
      signal,
    );
    signal.throwIfAborted();
    report({ stage: 'reading' });
    signal.throwIfAborted();
    const { data } = await untilAborted(worker.recognize(image), signal);
    signal.throwIfAborted();
    if (!data.text.trim())
      throw new Error(
        '文字が見つかりませんでした。レシートを明るい場所で、正面から撮ってください。',
      );
    report({ stage: 'checking' });
    signal.throwIfAborted();
    const parsed = parseReceipt(data.text);
    return { receipt: parsed, preview: image };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && /[\u3040-\u30ff\u3400-\u9fff]/.test(error.message)) throw error;
    if (reader === 'ai')
      throw new Error('読み取れませんでした。もう一度試すか、手入力で続けてください。', {
        cause: error,
      });
    throw new Error(
      '読み取りに失敗しました。初回は読み取りデータのダウンロードが必要です。通信を確認して再試行するか、手入力で続けてください。',
      { cause: error },
    );
  } finally {
    await worker?.terminate().catch(() => undefined);
  }
}
