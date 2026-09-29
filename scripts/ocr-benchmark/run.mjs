import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWorker, PSM } from 'tesseract.js';
import { parseReceipt } from '../../shared/parse-receipt.ts';

const directory = resolve(process.argv[2] ?? join(tmpdir(), 'reciwake-ocr-benchmark'));
const fixtures = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const variants = [
  { name: 'baseline', extension: 'jpg', geometry: '533×1600 JPEG 88' },
  { name: 'detail', extension: 'png', geometry: '800×2400 PNG' },
];

function normalize(name) {
  return name.normalize('NFKC').replace(/\s/g, '');
}

function distance(left, right) {
  const a = [...left];
  const b = [...right];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        next[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(a[i - 1] !== b[j - 1]),
      );
    }
    previous = next;
  }
  return previous[b.length];
}

await mkdir(join(directory, 'language-cache'), { recursive: true });
const results = [];
for (const variant of variants) {
  // Each policy gets a fresh worker, reused for its three fixtures only.
  const started = performance.now();
  const worker = await createWorker(['jpn', 'eng'], 1, {
    cachePath: join(directory, 'language-cache'),
  });
  const fixtureResults = [];
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    for (const fixture of fixtures) {
      const recognitionStarted = performance.now();
      const { data } = await worker.recognize(
        join(directory, `${fixture.slug}-${variant.name}.${variant.extension}`),
      );
      const receipt = parseReceipt(data.text);
      // Fixture prices are unique; a missing/mispriced item counts as a deleted name.
      const items = fixture.expected.map((expected) => {
        const recognized = receipt.items.find((item) => item.amount === expected.amount);
        return {
          ...expected,
          recognized: recognized?.name ?? '',
          errors: distance(normalize(expected.name), normalize(recognized?.name ?? '')),
          characters: [...normalize(expected.name)].length,
        };
      });
      fixtureResults.push({
        fixture: fixture.slug,
        elapsedMs: Math.round(performance.now() - recognitionStarted),
        expectedTotal: fixture.total,
        recognizedTotal: receipt.total,
        exactNames: items.filter((item) => item.errors === 0).length,
        errors: items.reduce((sum, item) => sum + item.errors, 0),
        characters: items.reduce((sum, item) => sum + item.characters, 0),
        items,
        rawText: data.text,
      });
    }
  } finally {
    await worker.terminate();
  }
  const exactNames = fixtureResults.reduce((sum, fixture) => sum + fixture.exactNames, 0);
  const totalNames = fixtureResults.reduce((sum, fixture) => sum + fixture.items.length, 0);
  const errors = fixtureResults.reduce((sum, fixture) => sum + fixture.errors, 0);
  const characters = fixtureResults.reduce((sum, fixture) => sum + fixture.characters, 0);
  const summary = {
    variant: variant.name,
    geometry: variant.geometry,
    elapsedMs: Math.round(performance.now() - started),
    exactNames,
    totalNames,
    errors,
    characters,
    characterErrorRate: errors / characters,
    correctTotals: fixtureResults.filter(
      (fixture) => fixture.expectedTotal === fixture.recognizedTotal,
    ).length,
  };
  console.log(JSON.stringify(summary));
  results.push({ ...summary, fixtures: fixtureResults });
}
await writeFile(join(directory, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(`Raw OCR text and comparisons saved to ${join(directory, 'results.json')}`);
