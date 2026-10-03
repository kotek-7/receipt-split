import { z } from 'zod';
import type { ReceiptScanEvent, ReceiptScanProgress } from '../shared/receipt-progress';
import type { ParsedReceipt } from '../shared/types';

const FAILURE = '読み取れませんでした。もう一度お試しください。';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const receiptSchema = z.object({
  title: z.string(),
  total: z.number().finite(),
  rawText: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      amount: z.number().finite(),
      quantity: z.number().finite().optional(),
      splitMode: z.enum(['equal', 'quantity']).optional(),
    }),
  ),
  warnings: z.array(z.string()).optional(),
});
const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    stage: z.enum(['reading', 'checking']),
    attempt: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('result'), receipt: receiptSchema }),
  z.object({ type: z.literal('error'), error: z.string(), status: z.number().int() }),
]);

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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(FAILURE);
  }
}

/** Upload the image and consume real server progress until its terminal event. */
export async function scanReceiptImage(
  image: Blob,
  onProgress: (progress: ReceiptScanProgress) => void,
  signal: AbortSignal,
): Promise<ParsedReceipt> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException('Receipt scan timed out', 'TimeoutError')),
    50_000,
  );
  const active = AbortSignal.any([signal, deadline.signal]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await untilAborted(
      fetch('/api/receipt-scan', {
        method: 'POST',
        headers: { 'Content-Type': image.type, Accept: 'application/x-ndjson' },
        body: image,
        signal: active,
      }),
      active,
    );
    active.throwIfAborted();
    if (!response.body) throw new Error(FAILURE);
    reader = response.body.getReader();
    const streamed =
      response.ok &&
      response.headers.get('Content-Type')?.split(';')[0].trim() === 'application/x-ndjson';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    let size = 0;
    const consumeEvent = (line: string): ParsedReceipt | undefined => {
      active.throwIfAborted();
      const parsed = eventSchema.safeParse(parseJson(line));
      if (!parsed.success) throw new Error(FAILURE);
      const event: ReceiptScanEvent = parsed.data;
      if (event.type === 'error') throw new Error(event.error || FAILURE);
      if (event.type === 'result') return event.receipt;
      onProgress({
        stage: event.stage,
        ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
      });
      active.throwIfAborted();
    };
    while (true) {
      const chunk = await untilAborted(reader.read(), active);
      active.throwIfAborted();
      if (chunk.value) {
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error(FAILURE);
        pending += decoder.decode(chunk.value, { stream: true });
      }
      if (chunk.done) pending += decoder.decode();
      if (streamed) {
        let end: number;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end).trim();
          pending = pending.slice(end + 1);
          if (!line) continue;
          const receipt = consumeEvent(line);
          if (receipt) return receipt;
        }
      }
      if (!chunk.done) continue;
      if (streamed) {
        // A complete final object is valid even when the server omitted its newline.
        if (pending.trim()) {
          const receipt = consumeEvent(pending.trim());
          if (receipt) return receipt;
        }
        throw new Error(FAILURE);
      }
      // Older servers and pre-stream validation failures still return JSON.
      const result = z
        .object({ receipt: receiptSchema.optional(), error: z.string().optional() })
        .safeParse(parseJson(pending));
      if (!result.success) throw new Error(FAILURE);
      if (!response.ok || !result.data.receipt) throw new Error(result.data.error || FAILURE);
      active.throwIfAborted();
      return result.data.receipt;
    }
  } finally {
    clearTimeout(timer);
    // Terminal events may arrive before the server closes its stream. Cancel unread
    // data without waiting on a broken transport, then release the reader's lock.
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
