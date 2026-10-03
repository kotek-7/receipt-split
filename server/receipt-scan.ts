import {
  buildReceiptAiInput,
  parseReceiptAiResponse,
  ReceiptExtractionError,
} from '../shared/receipt-ai';
import {
  readImageDimensions,
  RECEIPT_IMAGE_MAX_EDGE,
  RECEIPT_IMAGE_MAX_PIXELS,
} from '../shared/image-dimensions';

export const RECEIPT_SCAN_MAX_BYTES = 8 * 1024 * 1024;
export const RECEIPT_SCAN_TIMEOUT_MS = 45_000;
export type ReceiptAiInput = ReturnType<typeof buildReceiptAiInput>;
export type ReceiptAiRunner = (input: ReceiptAiInput, signal: AbortSignal) => Promise<unknown>;
export interface ReceiptScanOptions {
  run?: ReceiptAiRunner;
  allow?: () => Promise<boolean>;
  timeoutMs?: number;
}

/** Only adapters with an explicit transient provider response should raise this. */
export class RetryableReceiptAiError extends Error {
  constructor() {
    super('Receipt reader is temporarily unavailable.');
    this.name = 'RetryableReceiptAiError';
  }
}

async function runWithOneRetry(
  run: ReceiptAiRunner,
  input: ReceiptAiInput,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  try {
    return await run(input, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof RetryableReceiptAiError)) throw error;
    return run(input, signal);
  }
}

class ScanError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(status === 429 ? { 'Retry-After': '60' } : {}),
    },
  });
}

function checkOrigin(request: Request) {
  if (
    request.headers.get('Origin') !== new URL(request.url).origin ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  ) {
    throw new ScanError(403, 'この画面からレシートを選び直してください。');
  }
}

async function imageBytes(
  request: Request,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const mime = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime))
    throw new ScanError(415, 'JPEG・PNG・WebPの画像を選んでください。');
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > RECEIPT_SCAN_MAX_BYTES))
    throw new ScanError(413, '画像が大きすぎます。選び直してください。');
  if (!request.body) throw new ScanError(400, '画像を選んでください。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > RECEIPT_SCAN_MAX_BYTES) {
        await reader.cancel();
        throw new ScanError(413, '画像が大きすぎます。選び直してください。');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const signatureMatches =
    mime === 'image/jpeg'
      ? bytes[0] === 255 && bytes[1] === 216
      : mime === 'image/png'
        ? bytes[0] === 137 && bytes[1] === 80
        : bytes[0] === 82 && bytes[1] === 73;
  const dimensions = signatureMatches ? readImageDimensions(bytes) : undefined;
  if (!dimensions) throw new ScanError(400, '画像を読み込めませんでした。撮り直してください。');
  if (
    Math.max(dimensions.width, dimensions.height) > RECEIPT_IMAGE_MAX_EDGE ||
    dimensions.width * dimensions.height > RECEIPT_IMAGE_MAX_PIXELS
  )
    throw new ScanError(413, '画像が大きすぎます。この画面から選び直してください。');
  return { bytes, mime };
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Platform-independent handler. The adapter owns credentials; image/output are never logged. */
export async function scanReceiptRequest(
  request: Request,
  options: ReceiptScanOptions,
): Promise<Response> {
  const controller = new AbortController();
  const cancelled = new ScanError(499, '読み取りを中止しました。');
  const timedOut = new ScanError(
    504,
    '読み取りに時間がかかっています。もう一度試すか、端末内で読み取ってください。',
  );
  const onAbort = () => controller.abort(cancelled);
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  const timer = setTimeout(
    () => controller.abort(timedOut),
    options.timeoutMs ?? RECEIPT_SCAN_TIMEOUT_MS,
  );
  let abortHandler: (() => void) | undefined;
  try {
    checkOrigin(request);
    if (!options.run)
      throw new ScanError(503, '画像の読み取りを利用できません。端末内で読み取ってください。');
    controller.signal.throwIfAborted();
    if (options.allow && !(await options.allow()))
      throw new ScanError(429, '続けて読み取る場合は、1分ほど待ってください。');
    const { bytes, mime } = await imageBytes(request, controller.signal);
    const aborted = new Promise<never>((_resolve, reject) => {
      abortHandler = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abortHandler, { once: true });
      if (controller.signal.aborted) abortHandler();
    });
    const response = await Promise.race([
      runWithOneRetry(options.run, buildReceiptAiInput(dataUrl(bytes, mime)), controller.signal),
      aborted,
    ]);
    return json({ receipt: parseReceiptAiResponse(response) });
  } catch (error) {
    if (error instanceof ScanError) return json({ error: error.message }, error.status);
    if (error instanceof ReceiptExtractionError) return json({ error: error.message }, 422);
    return json(
      { error: '画像を読み取れませんでした。もう一度試すか、端末内で読み取ってください。' },
      502,
    );
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    if (abortHandler) controller.signal.removeEventListener('abort', abortHandler);
  }
}
