import { parseArgs } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  buildReceiptAiInput,
  parseReceiptAiResponse,
  RECEIPT_AI_MODEL,
  RECEIPT_AI_PROMPT,
  RECEIPT_AI_PROMPT_VERSION,
} from '../../shared/receipt-ai.ts';
import { evaluateManifest } from './evaluate.ts';
import { predictionOf, readManifest, saveJson } from './io.mjs';

const ACCOUNT_ID = '769b391d51df077598b7d91579605fe2';
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string' },
    split: { type: 'string', default: 'dev' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'node --import tsx scripts/receipt-eval/run-ai.mjs MANIFEST --output DIR [--split dev|holdout|all]\nSends selected receipt images to Cloudflare Workers AI. Ground truth is used only for scoring.',
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

async function readOAuthToken() {
  const config = await readFile(
    join(homedir(), '.config', '.wrangler', 'config', 'default.toml'),
    'utf8',
  );
  const match = /^\s*oauth_token\s*=\s*"([^"\r\n]+)"\s*$/m.exec(config);
  if (!match || /[\r\n]/.test(match[1])) {
    throw new Error('No usable Wrangler OAuth token. Authenticate Wrangler before running.');
  }
  return match[1];
}

function configString(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"`;
}

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

async function requestCloudflare(input, token) {
  const temporary = await mkdtemp(join(tmpdir(), 'receipt-ai-request-'));
  const body = join(temporary, 'body.json');
  // The temporary body contains the public image and prompt only, never credentials or GT.
  await writeFile(body, JSON.stringify(input), { mode: 0o600 });
  try {
    return await new Promise((accept, reject) => {
      const config = [
        `url = ${configString(ENDPOINT)}`,
        `header = ${configString(`Authorization: Bearer ${token}`)}`,
        `header = ${configString('Content-Type: application/json')}`,
        '',
      ].join('\n');
      const child = spawn(
        'curl',
        [
          '--http1.1',
          '--silent',
          '--show-error',
          '--max-time',
          '45',
          '--config',
          '-',
          '--data-binary',
          `@${body}`,
          '--write-out',
          '\n%{http_code}',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const stdout = [];
      const stderr = [];
      let bytesRead = 0;
      let overflow = false;
      child.stdout.on('data', (chunk) => {
        bytesRead += chunk.length;
        if (bytesRead > 2_000_000) {
          overflow = true;
          child.kill();
        } else stdout.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.reduce((sum, entry) => sum + entry.length, 0) < 16_384) stderr.push(chunk);
      });
      child.on('error', reject);
      child.stdin.on('error', () => {});
      child.on('close', (code) => {
        if (overflow) return reject(new Error('Cloudflare response exceeded the size limit.'));
        const redact = (value) => value.replaceAll(token, '[REDACTED]');
        if (code !== 0) {
          const error = new Error(
            `curl exited ${code}: ${redact(Buffer.concat(stderr).toString()).trim()}`,
          );
          error.exitCode = code;
          return reject(error);
        }
        const raw = redact(Buffer.concat(stdout).toString());
        const boundary = raw.lastIndexOf('\n');
        const status = Number(raw.slice(boundary + 1));
        if (!Number.isInteger(status) || status < 200 || status >= 300) {
          const error = new Error(`Cloudflare HTTP ${status || 'unknown'}`);
          error.status = status;
          return reject(error);
        }
        try {
          accept(JSON.parse(raw.slice(0, boundary)));
        } catch {
          reject(new Error('Cloudflare returned an invalid JSON envelope.'));
        }
      });
      child.stdin.end(config);
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function trackedRequest(input, token, record, kind) {
  const started = performance.now();
  try {
    const response = await requestCloudflare(input, token);
    record.attempts.push({ kind, latencyMs: Math.round(performance.now() - started), status: 200 });
    return response;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replaceAll(
      token,
      '[REDACTED]',
    );
    record.attempts.push({
      kind,
      latencyMs: Math.round(performance.now() - started),
      error: message,
      ...(error?.status ? { status: error.status } : {}),
      ...(error?.exitCode ? { curlExitCode: error.exitCode } : {}),
    });
    throw error;
  }
}

const { manifest, manifestPath, manifestSha256, imageRoot } = await readManifest(positionals[0]);
const fixtures = manifest.fixtures.filter(
  ({ split }) => values.split === 'all' || split === values.split,
);
if (!fixtures.length) throw new Error(`No fixtures in split ${values.split}.`);
const output = resolve(values.output);
// Refuse accidental overwrites of an expensive evaluation. Choose a new directory to rerun.
try {
  await readFile(join(output, 'results.json'));
  throw new Error(`Results already exist in ${output}; choose a separate output directory.`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await readOAuthToken();
let refreshedAuthentication = false;
const engine = {
  name: 'Cloudflare Workers AI',
  model: RECEIPT_AI_MODEL,
  promptVersion: RECEIPT_AI_PROMPT_VERSION,
  promptSha256: sha256(RECEIPT_AI_PROMPT),
  inputTemplateSha256: sha256(JSON.stringify(buildReceiptAiInput('IMAGE_BYTES_OMITTED'))),
  extractorSha256: sha256(await readFile(new URL('../../shared/receipt-ai.ts', import.meta.url))),
  runnerSha256: sha256(await readFile(new URL(import.meta.url))),
  transport:
    'curl HTTP/1.1, 45s limit; one DNS/connect/TLS connection retry; one HTTP 401 credential refresh per run',
  imagePreparation: 'manifest inputs; browser crop is not applied by this runner',
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
  engine,
  fixtures: [],
};
const started = performance.now();
for (const { id, image } of fixtures) {
  const recognitionStarted = performance.now();
  const record = {
    id,
    image,
    imageSha256: null,
    promptSha256: engine.promptSha256,
    usage: null,
    attempts: [],
    prediction: { total: null, items: [] },
  };
  let token = '';
  try {
    token = await readOAuthToken();
    const bytes = await readFile(resolve(imageRoot, image));
    record.imageSha256 = sha256(bytes);
    // The model sees only image bytes and the fixed production prompt, never fixture.expected.
    const input = {
      model: RECEIPT_AI_MODEL,
      ...buildReceiptAiInput(`data:${mimeType(bytes)};base64,${bytes.toString('base64')}`),
    };
    record.requestSha256 = sha256(JSON.stringify(input));
    let response;
    try {
      response = await trackedRequest(input, token, record, 'initial');
    } catch (error) {
      if ([6, 7, 35].includes(error?.exitCode)) {
        response = await trackedRequest(input, token, record, 'connection-retry');
      } else {
        if (error?.status !== 401 || refreshedAuthentication) throw error;
        refreshedAuthentication = true;
        record.authenticationRefreshRetry = true;
        await new Promise((accept, reject) => {
          const child = spawn('npx', ['wrangler', 'whoami'], { stdio: 'ignore' });
          const timer = setTimeout(() => child.kill(), 30_000);
          child.on('error', reject);
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) accept();
            else reject(new Error('Wrangler authentication refresh failed.'));
          });
        });
        token = await readOAuthToken();
        response = await trackedRequest(input, token, record, 'authentication-retry');
      }
    }
    record.usage = response.usage ?? null;
    record.providerModel = response.model ?? null;
    record.finishReason = response.choices?.[0]?.finish_reason ?? null;
    record.rawModelContent = response.choices?.[0]?.message?.content ?? null;
    const receipt = parseReceiptAiResponse(response);
    record.prediction = predictionOf(receipt);
    record.warnings = receipt.warnings ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record.error = token ? message.replaceAll(token, '[REDACTED]') : message;
  }
  record.latencyMs = Math.round(performance.now() - recognitionStarted);
  results.fixtures.push(record);
  await saveJson(join(output, 'results.json'), results);
  console.log(JSON.stringify({ id, latencyMs: record.latencyMs, error: record.error }));
}
results.elapsedMs = Math.round(performance.now() - started);
await saveJson(join(output, 'results.json'), results);
// Failed calls remain empty predictions in the same denominator as successful calls.
const report = evaluateManifest(manifest, results.fixtures, values.split);
report.provenance = { manifestPath, manifestSha256, engine };
report.performance = {
  elapsedMs: results.elapsedMs,
  meanLatencyMs: Math.round(
    results.fixtures.reduce((sum, row) => sum + row.latencyMs, 0) / results.fixtures.length,
  ),
  usage: results.fixtures.reduce((sum, { usage }) => {
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      if (typeof usage?.[key] === 'number') sum[key] = (sum[key] ?? 0) + usage[key];
    }
    return sum;
  }, {}),
};
report.evidence = results.fixtures.map(
  ({ id, imageSha256, promptSha256, latencyMs, usage, prediction, error, attempts }) => ({
    id,
    attempts,
    imageSha256,
    promptSha256,
    latencyMs,
    usage,
    prediction,
    ...(error ? { error } : {}),
  }),
);
await saveJson(join(output, 'report.json'), report);
console.log(JSON.stringify({ ...report.summary, ...report.performance }, null, 2));
if (report.summary.errors) process.exitCode = 1;
