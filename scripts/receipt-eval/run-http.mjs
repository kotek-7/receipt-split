import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import {
  RECEIPT_AI_MODEL,
  RECEIPT_AI_PROMPT,
  RECEIPT_AI_PROMPT_VERSION,
} from '../../shared/receipt-ai.ts';
import { evaluateManifest } from './evaluate.ts';
import { predictionOf, readManifest, saveJson } from './io.mjs';

const START_INTERVAL_MS = 11_000;
const DEADLINE_SECONDS = 60;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    endpoint: { type: 'string' },
    output: { type: 'string' },
    split: { type: 'string', default: 'dev' },
    'expected-deployment-sha': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'node --import tsx scripts/receipt-eval/run-http.mjs MANIFEST --endpoint URL --output DIR [--split dev|holdout|all] [--expected-deployment-sha SHA]\nSends selected receipt images to the specified /api/receipt-scan endpoint. No credentials or ground truth are sent.',
  );
  process.exit(0);
}
if (
  positionals.length !== 1 ||
  !values.endpoint ||
  !values.output ||
  !['dev', 'holdout', 'all'].includes(values.split)
) {
  throw new Error(
    'Provide MANIFEST, --endpoint URL, --output DIR and optionally --split dev|holdout|all.',
  );
}
const endpoint = new URL(values.endpoint);
if (
  !['http:', 'https:'].includes(endpoint.protocol) ||
  endpoint.username ||
  endpoint.password ||
  endpoint.hash ||
  endpoint.pathname !== '/api/receipt-scan'
) {
  throw new Error('Use an HTTP(S) /api/receipt-scan URL without credentials or a fragment.');
}
const expectedDeploymentSha = values['expected-deployment-sha'] ?? null;
if (expectedDeploymentSha !== null && !/^[a-f0-9]{40}$/i.test(expectedDeploymentSha)) {
  throw new Error('--expected-deployment-sha must be a full 40-character Git commit SHA.');
}

const receiptResponseSchema = z.object({
  receipt: z.object({
    total: z.number().int().min(0).max(10_000_000),
    items: z
      .array(
        z.object({
          name: z.string().min(1).max(100),
          amount: z.number().int().min(0).max(1_000_000),
          // The production response uses zero for a quantity that needs human correction.
          quantity: z.number().int().min(0).max(999).optional(),
        }),
      )
      .min(1)
      .max(100),
    warnings: z.array(z.string()).optional(),
  }),
});

function mimeType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') {
    return 'image/webp';
  }
  throw new Error('Expected a prepared PNG, JPEG or WebP receipt.');
}

function postImage(bytes, contentType) {
  return new Promise((accept, reject) => {
    const child = spawn(
      'curl',
      [
        // Ignore .curlrc so local settings cannot introduce retries, headers or redirects.
        '--disable',
        '--http1.1',
        '--silent',
        '--show-error',
        '--max-time',
        String(DEADLINE_SECONDS),
        '--retry',
        '0',
        '--request',
        'POST',
        '--header',
        `Content-Type: ${contentType}`,
        '--header',
        `Origin: ${endpoint.origin}`,
        '--data-binary',
        '@-',
        '--url',
        endpoint.href,
        '--write-out',
        '\n%{http_code}',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout = [];
    const stderr = [];
    let responseBytes = 0;
    let errorBytes = 0;
    let oversized = false;
    child.stdout.on('data', (chunk) => {
      responseBytes += chunk.length;
      if (responseBytes > 2_000_000) {
        oversized = true;
        child.kill();
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes <= 16_384) stderr.push(chunk);
    });
    child.on('error', reject);
    child.stdin.on('error', () => {}); // The exit code and HTTP status report an early close.
    child.on('close', (code) => {
      const raw = Buffer.concat(stdout).toString();
      const boundary = raw.lastIndexOf('\n');
      const statusText = raw.slice(boundary + 1);
      const status =
        /^\d{3}$/.test(statusText) && Number(statusText) > 0 ? Number(statusText) : null;
      if (oversized || code !== 0) {
        const error = new Error(
          oversized
            ? 'API response exceeded the size limit.'
            : `curl exited ${code}: ${Buffer.concat(stderr).toString().trim()}`,
        );
        error.status = status;
        error.curlExitCode = code;
        return reject(error);
      }
      if (status === null) return reject(new Error('curl did not return an HTTP status.'));
      accept({ status, body: raw.slice(0, boundary) });
    });
    // Only the exact bytes whose SHA-256 is recorded are sent; the file is not re-read by curl.
    child.stdin.end(bytes);
  });
}

const { manifest, manifestPath, manifestSha256, imageRoot } = await readManifest(positionals[0]);
const fixtures = manifest.fixtures.filter(
  ({ split }) => values.split === 'all' || split === values.split,
);
if (!fixtures.length) throw new Error(`No fixtures in split ${values.split}.`);
const output = resolve(values.output);
await mkdir(output, { recursive: true });
try {
  await readFile(join(output, 'report.json'));
  throw new Error(`A report already exists in ${output}; choose a separate output directory.`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const engine = {
  name: 'Deployed receipt-scan API',
  endpoint: endpoint.href,
  model: RECEIPT_AI_MODEL,
  promptVersion: RECEIPT_AI_PROMPT_VERSION,
  promptSha256: sha256(RECEIPT_AI_PROMPT),
  extractorSha256: sha256(await readFile(new URL('../../shared/receipt-ai.ts', import.meta.url))),
  runnerSha256: sha256(await readFile(new URL(import.meta.url))),
  expectedDeploymentSha,
  identitySource:
    'Local shared/receipt-ai.ts snapshot; expected deployment SHA is caller supplied and not verified by this runner.',
  transport: 'curl HTTP/1.1; one attempt; no runner retries or redirects',
  deadlineSeconds: DEADLINE_SECONDS,
  minimumStartIntervalMs: START_INTERVAL_MS,
  imagePreparation: 'manifest inputs; no additional crop, resize or conversion',
};
const results = {
  formatVersion: 1,
  dataset: manifest.dataset,
  revision: manifest.revision,
  license: manifest.license,
  manifestPath,
  manifestSha256,
  split: values.split,
  createdAt: new Date().toISOString(),
  completed: false,
  engine,
  fixtures: [],
};
// Exclusive creation also protects against two concurrent runs choosing the same output.
await writeFile(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, {
  flag: 'wx',
});
console.log(
  JSON.stringify({
    endpoint: endpoint.href,
    split: values.split,
    fixtures: fixtures.length,
    output,
  }),
);
const started = performance.now();
let previousRequestStart = -Infinity;
for (const { id, image } of fixtures) {
  const record = {
    id,
    image,
    imageSha256: null,
    promptSha256: engine.promptSha256,
    status: null,
    attempts: 0,
    latencyMs: 0,
    rateWaitMs: 0,
    prediction: { total: null, items: [] },
  };
  let requestStarted = null;
  let stage = 'image';
  try {
    const bytes = await readFile(resolve(imageRoot, image));
    record.imageSha256 = sha256(bytes);
    const contentType = mimeType(bytes);
    const remaining = previousRequestStart + START_INTERVAL_MS - performance.now();
    if (remaining > 0) {
      const waitStarted = performance.now();
      await sleep(Math.ceil(remaining));
      record.rateWaitMs = Math.round(performance.now() - waitStarted);
    }
    // Do not send names, expected items, expected totals or any other annotation to the API.
    stage = 'transport';
    requestStarted = performance.now();
    previousRequestStart = requestStarted;
    record.startedAt = new Date().toISOString();
    record.attempts = 1;
    const response = await postImage(bytes, contentType);
    record.status = response.status;
    record.responseSha256 = sha256(response.body);
    stage = 'http';
    if (response.status < 200 || response.status >= 300) {
      try {
        const failure = JSON.parse(response.body);
        if (typeof failure.error === 'string') record.apiMessage = failure.error.slice(0, 1000);
      } catch {
        /* HTML errors are represented by their status and response hash. */
      }
      throw new Error(`Receipt API HTTP ${response.status}`);
    }
    stage = 'response';
    let envelope;
    try {
      envelope = JSON.parse(response.body);
    } catch {
      throw new Error('Receipt API returned an invalid JSON response.');
    }
    const parsed = receiptResponseSchema.safeParse(envelope);
    if (!parsed.success) throw new Error('Receipt API returned an invalid receipt shape.');
    record.prediction = predictionOf(parsed.data.receipt);
    record.warnings = parsed.data.receipt.warnings ?? [];
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    record.errorType = stage;
    if (error?.status !== undefined) record.status = error.status;
    if (error?.curlExitCode !== undefined) record.curlExitCode = error.curlExitCode;
  }
  if (requestStarted !== null) record.latencyMs = Math.round(performance.now() - requestStarted);
  results.fixtures.push(record);
  await saveJson(join(output, 'results.json'), results);
  console.log(
    JSON.stringify({ id, status: record.status, latencyMs: record.latencyMs, error: record.error }),
  );
}
results.completed = true;
results.elapsedMs = Math.round(performance.now() - started);
await saveJson(join(output, 'results.json'), results);
// 502/504, transport failures and invalid responses remain empty predictions in the denominator.
const report = evaluateManifest(manifest, results.fixtures, values.split);
report.provenance = { manifestPath, manifestSha256, engine };
report.performance = {
  elapsedMs: results.elapsedMs,
  meanLatencyMs: Math.round(
    results.fixtures.reduce((sum, row) => sum + row.latencyMs, 0) / fixtures.length,
  ),
  rateWaitMs: results.fixtures.reduce((sum, row) => sum + row.rateWaitMs, 0),
  requests: results.fixtures.reduce((sum, row) => sum + row.attempts, 0),
  errorTypes: results.fixtures.reduce((counts, row) => {
    if (row.errorType) counts[row.errorType] = (counts[row.errorType] ?? 0) + 1;
    return counts;
  }, {}),
  statuses: results.fixtures.reduce((counts, row) => {
    const key = row.status ?? 'no_response';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {}),
};
report.evidence = results.fixtures;
await saveJson(join(output, 'report.json'), report);
console.log(JSON.stringify({ ...report.summary, ...report.performance }, null, 2));
if (report.summary.errors) process.exitCode = 1;
