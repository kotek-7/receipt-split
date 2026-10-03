import { parseArgs } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { createWorker, PSM } from 'tesseract.js';
import { parseReceipt } from '../../shared/parse-receipt.ts';
import { evaluateManifest } from './evaluate.ts';
import { parserIdentity, predictionOf, readManifest, saveJson } from './io.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string' },
    split: { type: 'string', default: 'all' },
    cache: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'node --import tsx scripts/receipt-eval/run.mjs MANIFEST --output DIR [--split dev|holdout|all] [--cache DIR]',
  );
  process.exit(0);
}
if (
  positionals.length !== 1 ||
  !values.output ||
  !['dev', 'holdout', 'all'].includes(values.split)
) {
  throw new Error('Provide MANIFEST, --output DIR and optionally --split dev|holdout|all.');
}
const { manifest, manifestPath, manifestSha256, imageRoot } = await readManifest(positionals[0]);
const output = resolve(values.output);
const cachePath = resolve(values.cache ?? join(output, 'language-cache'));
await mkdir(cachePath, { recursive: true });
const fixtures = manifest.fixtures.filter(
  ({ split }) => values.split === 'all' || split === values.split,
);
if (!fixtures.length) throw new Error(`No fixtures in split ${values.split}.`);
const results = {
  formatVersion: 1,
  dataset: manifest.dataset,
  revision: manifest.revision,
  license: manifest.license,
  manifestPath,
  manifestSha256,
  split: values.split,
  createdAt: new Date().toISOString(),
  parser: await parserIdentity(),
  engine: {
    name: 'tesseract.js',
    version: createRequire(import.meta.url)('tesseract.js/package.json').version,
    languages: ['jpn', 'eng'],
    oem: 1,
    psm: 6,
    preserveInterwordSpaces: true,
    dpi: 300,
    imagePreparation: 'manifest inputs; browser crop is not applied by this runner',
  },
  fixtures: [],
};
const started = performance.now();
const worker = await createWorker(['jpn', 'eng'], 1, { cachePath });
results.initializationMs = Math.round(performance.now() - started);
try {
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });
  for (const fixture of fixtures) {
    const image = resolve(imageRoot, fixture.image);
    const recognitionStarted = performance.now();
    let record;
    try {
      const bytes = await readFile(image);
      const { data } = await worker.recognize(bytes, {}, { text: true, blocks: true });
      const latencyMs = Math.round(performance.now() - recognitionStarted);
      record = {
        id: fixture.id,
        image: fixture.image,
        imageSha256: createHash('sha256').update(bytes).digest('hex'),
        rawText: data.text,
        confidence: data.confidence,
        blocks: data.blocks,
        latencyMs,
        prediction: predictionOf(parseReceipt(data.text)),
      };
    } catch (error) {
      record = {
        id: fixture.id,
        image: fixture.image,
        rawText: '',
        confidence: null,
        blocks: null,
        latencyMs: Math.round(performance.now() - recognitionStarted),
        prediction: { total: null, items: [] },
        error: error instanceof Error ? error.message : String(error),
      };
    }
    results.fixtures.push(record);
    // Keep expensive OCR evidence even if a later image fails or the run is interrupted.
    await saveJson(join(output, 'results.json'), results);
    console.log(
      JSON.stringify({ id: record.id, latencyMs: record.latencyMs, error: record.error }),
    );
  }
} finally {
  await worker.terminate();
}
results.elapsedMs = Math.round(performance.now() - started);
await saveJson(join(output, 'results.json'), results);
const report = evaluateManifest(manifest, results.fixtures, values.split);
await saveJson(join(output, 'report.json'), report);
console.log(JSON.stringify(report.summary, null, 2));
if (report.summary.errors) process.exitCode = 1;
