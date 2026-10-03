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
import type { ReceiptScanEvent } from '../shared/receipt-progress';

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
  onAttempt?: (attempt: number) => void,
): Promise<unknown> {
  signal.throwIfAborted();
  onAttempt?.(1);
  try {
    return await run(input, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof RetryableReceiptAiError)) throw error;
    onAttempt?.(2);
    return run(input, signal);
  }
}

async function untilAborted<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([job, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
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

function failure(error: unknown): Extract<ReceiptScanEvent, { type: 'error' }> {
  if (error instanceof ScanError)
    return { type: 'error', error: error.message, status: error.status };
  if (error instanceof ReceiptExtractionError)
    return { type: 'error', error: error.message, status: 422 };
  return {
    type: 'error',
    error: '画像を読み取れませんでした。もう一度試すか、手入力で続けてください。',
    status: 502,
  };
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
  const timedOut = new ScanError(504, '読み取りに時間がかかっています。もう一度お試しください。');
  const onAbort = () => controller.abort(cancelled);
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  const timer = setTimeout(
    () => controller.abort(timedOut),
    options.timeoutMs ?? RECEIPT_SCAN_TIMEOUT_MS,
  );
  const cleanup = () => {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
  };
  let streaming = false;
  try {
    checkOrigin(request);
    if (!options.run)
      throw new ScanError(
        503,
        '画像を読み取れません。時間をおいて試すか、手入力で続けてください。',
      );
    controller.signal.throwIfAborted();
    if (options.allow && !(await untilAborted(options.allow(), controller.signal)))
      throw new ScanError(429, '続けて読み取る場合は、1分ほど待ってください。');
    const { bytes, mime } = await imageBytes(request, controller.signal);
    const input = buildReceiptAiInput(dataUrl(bytes, mime));
    const run = options.run;
    const readReceipt = async (emit?: (event: ReceiptScanEvent) => void) => {
      const response = await untilAborted(
        runWithOneRetry(run, input, controller.signal, (attempt) =>
          emit?.({ type: 'progress', stage: 'reading', attempt }),
        ),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      emit?.({ type: 'progress', stage: 'checking' });
      return parseReceiptAiResponse(response);
    };
    const acceptsProgress = request.headers
      .get('Accept')
      ?.split(',')
      .some((value) => value.split(';')[0].trim().toLowerCase() === 'application/x-ndjson');
    if (acceptsProgress) {
      let open = true;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          const emit = (event: ReceiptScanEvent) => {
            if (open) stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };
          void (async () => {
            try {
              emit({ type: 'result', receipt: await readReceipt(emit) });
            } catch (error) {
              emit(failure(error));
            } finally {
              if (open) {
                open = false;
                stream.close();
              }
              cleanup();
            }
          })();
        },
        cancel() {
          open = false;
          controller.abort(cancelled);
          cleanup();
        },
      });
      const response = new Response(body, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
      streaming = true;
      return response;
    }
    return json({ receipt: await readReceipt() });
  } catch (error) {
    const result = failure(error);
    return json({ error: result.error }, result.status);
  } finally {
    // The response body owns cleanup after it starts; its work outlives this function.
    if (!streaming) cleanup();
  }
}
