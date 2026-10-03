import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseReceipt } from '../../shared/parse-receipt.ts';
import { evaluateManifest } from './evaluate.ts';
import { parserIdentity, predictionOf, readManifest, saveJson } from './io.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help) {
  console.log(
    'node --import tsx scripts/receipt-eval/reparse.mjs MANIFEST RESULTS_JSON --output DIR',
  );
  process.exit(0);
}
if (positionals.length !== 2 || !values.output) {
  throw new Error('Provide MANIFEST, RESULTS_JSON and --output DIR.');
}
const { manifest, manifestSha256 } = await readManifest(positionals[0]);
const previous = JSON.parse(await readFile(positionals[1], 'utf8'));
if (previous.dataset !== manifest.dataset || previous.revision !== manifest.revision) {
  throw new Error('The saved OCR and manifest have different dataset/revision values.');
}
if (previous.manifestSha256 !== manifestSha256) {
  throw new Error('The manifest changed since OCR. Use the same frozen manifest.');
}
const output = resolve(values.output);
if (resolve(positionals[1]) === join(output, 'results.json')) {
  throw new Error('Use a separate output directory to preserve the original predictions.');
}
const fixtures = previous.fixtures.map((fixture) => {
  if (typeof fixture.rawText !== 'string') throw new Error(`Missing rawText: ${fixture.id}`);
  return {
    ...fixture,
    prediction: fixture.error
      ? { total: null, items: [] }
      : predictionOf(parseReceipt(fixture.rawText)),
  };
});
const results = {
  ...previous,
  reparsedAt: new Date().toISOString(),
  reparsedFrom: resolve(positionals[1]),
  parser: await parserIdentity(),
  fixtures,
};
const report = evaluateManifest(manifest, fixtures, previous.split);
await saveJson(join(output, 'results.json'), results);
await saveJson(join(output, 'report.json'), report);
console.log(JSON.stringify(report.summary, null, 2));
if (report.summary.errors) process.exitCode = 1;
