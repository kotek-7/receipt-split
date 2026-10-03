import { z } from 'zod';

const itemSchema = z.object({
  name: z.string().min(1),
  amount: z.number().int().safe(),
  quantity: z.number().int().positive().optional(),
});

export const manifestSchema = z
  .object({
    dataset: z.string().min(1),
    revision: z.string().min(1),
    license: z.string().min(1),
    fixtures: z
      .array(
        z
          .object({
            id: z.string().min(1),
            image: z.string().min(1),
            split: z.enum(['dev', 'holdout']),
            expected: z.object({ total: z.number().int().safe(), items: z.array(itemSchema) }),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    manifest.fixtures.forEach(({ id }, index) => {
      if (ids.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['fixtures', index, 'id'],
          message: `Duplicate fixture id: ${id}`,
        });
      }
      ids.add(id);
    });
  });

export type Manifest = z.infer<typeof manifestSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Prediction = { total: number | null; items: Item[] };
export type PredictionRecord = { id: string; prediction: Prediction; error?: string };
export type Counts = { matched: number; expected: number; predicted: number };
export type Split = 'dev' | 'holdout' | 'all';

/** Deliberately preserve case, punctuation and reading errors. */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').replace(/\s/gu, '');
}

/** Multiset intersection: each predicted row can satisfy only one expected row. */
function matchItems(expected: Item[], predicted: Item[], includeName: boolean): Counts {
  const key = (item: Item) =>
    JSON.stringify([
      ...(includeName ? [normalizeName(item.name)] : []),
      item.amount,
      item.quantity ?? 1,
    ]);
  const remaining = new Map<string, number>();
  expected.forEach((item) => remaining.set(key(item), (remaining.get(key(item)) ?? 0) + 1));
  let matched = 0;
  for (const item of predicted) {
    const value = key(item);
    const count = remaining.get(value) ?? 0;
    if (count > 0) {
      matched++;
      remaining.set(value, count - 1);
    }
  }
  return { matched, expected: expected.length, predicted: predicted.length };
}

export function metrics(counts: Counts) {
  const { matched, expected, predicted } = counts;
  const precision = predicted ? matched / predicted : Number(expected === 0);
  const recall = expected ? matched / expected : Number(predicted === 0);
  const f1 = expected + predicted ? (2 * matched) / (expected + predicted) : 1;
  return {
    ...counts,
    falsePositives: predicted - matched,
    falseNegatives: expected - matched,
    precision,
    recall,
    f1,
  };
}

export function evaluateReceipt(expected: Prediction, predicted: Prediction) {
  return {
    exactItems: metrics(matchItems(expected.items, predicted.items, true)),
    amountQuantity: metrics(matchItems(expected.items, predicted.items, false)),
    totalExact: predicted.total !== null && expected.total === predicted.total,
    expectedTotal: expected.total,
    predictedTotal: predicted.total,
  };
}

/** Require complete, unique results; failed OCR must be an explicit empty prediction. */
export function evaluateManifest(
  manifest: Manifest,
  predictions: PredictionRecord[],
  split: Split = 'all',
) {
  const byId = new Map<string, PredictionRecord>();
  const fixtureIds = new Set(manifest.fixtures.map(({ id }) => id));
  for (const prediction of predictions) {
    if (byId.has(prediction.id)) throw new Error(`Duplicate prediction: ${prediction.id}`);
    if (!fixtureIds.has(prediction.id)) throw new Error(`Unknown prediction: ${prediction.id}`);
    byId.set(prediction.id, prediction);
  }
  const fixtures = manifest.fixtures
    .filter((fixture) => split === 'all' || fixture.split === split)
    .map((fixture) => {
      const record = byId.get(fixture.id);
      if (!record) throw new Error(`Missing prediction: ${fixture.id}`);
      return {
        id: fixture.id,
        split: fixture.split,
        ...(record.error ? { error: record.error } : {}),
        ...evaluateReceipt(fixture.expected, record.prediction),
      };
    });
  const aggregate = (rows: typeof fixtures) => {
    const sum = (field: 'exactItems' | 'amountQuantity') =>
      metrics(
        rows.reduce(
          (result, row) => ({
            matched: result.matched + row[field].matched,
            expected: result.expected + row[field].expected,
            predicted: result.predicted + row[field].predicted,
          }),
          { matched: 0, expected: 0, predicted: 0 },
        ),
      );
    const totalCorrect = rows.filter(({ totalExact }) => totalExact).length;
    return {
      fixtures: rows.length,
      errors: rows.filter(({ error }) => error).length,
      exactItems: sum('exactItems'),
      amountQuantity: sum('amountQuantity'),
      totalCorrect,
      totalAccuracy: rows.length ? totalCorrect / rows.length : null,
    };
  };
  return {
    dataset: manifest.dataset,
    revision: manifest.revision,
    split,
    summary: aggregate(fixtures),
    bySplit: {
      dev: aggregate(fixtures.filter((fixture) => fixture.split === 'dev')),
      holdout: aggregate(fixtures.filter((fixture) => fixture.split === 'holdout')),
    },
    fixtures,
  };
}
