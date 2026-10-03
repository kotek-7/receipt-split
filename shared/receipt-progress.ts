import type { ParsedReceipt } from './types';

/** Stages report real work boundaries; percentages are only supplied by local OCR. */
export type ReceiptScanProgress = {
  stage: 'preparing' | 'uploading' | 'loading' | 'reading' | 'checking';
  percent?: number;
  attempt?: number;
};

/** One JSON object per line when /api/receipt-scan receives Accept: application/x-ndjson. */
export type ReceiptScanEvent =
  | { type: 'progress'; stage: 'reading' | 'checking'; attempt?: number }
  | { type: 'result'; receipt: ParsedReceipt }
  | { type: 'error'; error: string; status: number };
