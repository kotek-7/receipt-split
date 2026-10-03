import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { manifestSchema } from './evaluate.ts';

export async function readManifest(path) {
  const manifestPath = resolve(path);
  const raw = await readFile(manifestPath, 'utf8');
  return {
    manifest: manifestSchema.parse(JSON.parse(raw)),
    manifestPath,
    imageRoot: dirname(manifestPath),
    manifestSha256: createHash('sha256').update(raw).digest('hex'),
  };
}

export async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function parserIdentity() {
  const source = await readFile(new URL('../../shared/parse-receipt.ts', import.meta.url));
  return { name: 'parseReceipt', sourceSha256: createHash('sha256').update(source).digest('hex') };
}

export function predictionOf(receipt) {
  return {
    total: receipt.total,
    items: receipt.items.map(({ name, amount, quantity }) => ({
      name,
      amount,
      quantity: quantity ?? 1,
    })),
  };
}
