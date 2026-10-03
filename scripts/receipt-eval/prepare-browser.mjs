import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { readManifest } from './io.mjs';
import {
  readImageDimensions,
  RECEIPT_IMAGE_MAX_EDGE,
  RECEIPT_IMAGE_MAX_PIXELS,
} from '../../shared/image-dimensions.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string' },
    port: { type: 'string', default: '4319' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'node --import tsx scripts/receipt-eval/prepare-browser.mjs MANIFEST --output DIR [--port 4319]\nOpen the printed loopback URL and press 評価画像を準備. Images and ground truth are never sent to a model.',
  );
  process.exit(0);
}
const port = Number(values.port);
if (
  positionals.length !== 1 ||
  !values.output ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
) {
  throw new Error('Provide MANIFEST, --output DIR and an optional valid --port.');
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const { manifest, manifestPath, manifestSha256, imageRoot } = await readManifest(positionals[0]);
const output = resolve(values.output);
const origin = `http://127.0.0.1:${port}`;
const session = randomUUID();
const prefix = '/__receipt_prepare/';
const maxImageBytes = 8 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sources = ['src/prepare-image.ts', 'shared/receipt-region.ts', 'shared/image-dimensions.ts'];
const require = createRequire(import.meta.url);
const viteEnvironment = join(dirname(require.resolve('vite/package.json')), 'dist/client/env.mjs');
const allowedModules = new Set([
  ...sources.map((path) => `/${path}`),
  '/@vite/client',
  `/${relative(root, viteEnvironment).split('\\').join('/')}`,
]);
async function codeHashes() {
  return Object.fromEntries(
    await Promise.all(
      sources.map(async (name) => [name, sha256(await readFile(join(root, name)))]),
    ),
  );
}
const processorSources = await codeHashes();
const processorSha256 = sha256(JSON.stringify(processorSources));
const authorized = new Map();
for (const [index, fixture] of manifest.fixtures.entries()) {
  const path = await realpath(resolve(imageRoot, fixture.image));
  if (!(await stat(path)).isFile()) throw new Error(`Fixture ${fixture.id} is not a regular file.`);
  authorized.set(fixture.id, {
    path,
    target: `images/${String(index + 1).padStart(5, '0')}.png`,
    sourceSha256: sha256(await readFile(path)),
  });
}
// Refuse even a partially prepared directory. Use a new output to start another preparation.
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
await mkdir(join(output, 'images'));
const prepared = new Map();
const failures = new Map();
const inProgress = new Set();
const userAgents = new Set();
let completed = false;
let finalizing;
let stateWrite = Promise.resolve();
const startedAt = new Date().toISOString();

function state() {
  return {
    total: authorized.size,
    prepared: prepared.size,
    completed,
    completedIds: [...prepared.keys()],
    errors: [...failures].map(([id, error]) => ({ id, error })),
    outputManifest: join(output, 'manifest.json'),
  };
}
function saveState() {
  stateWrite = stateWrite.then(async () => {
    const temporary = join(output, 'preparation-state.json.tmp');
    await writeFile(
      temporary,
      `${JSON.stringify({ ...state(), manifestSha256, processorSha256, startedAt }, null, 2)}\n`,
    );
    await rename(temporary, join(output, 'preparation-state.json'));
  });
  return stateWrite;
}
async function verifyCode() {
  if (sha256(JSON.stringify(await codeHashes())) !== processorSha256) {
    throw new Error('画像準備のソースが変更されました。別の出力先で最初から実行してください。');
  }
}
async function finishIfReady() {
  if (completed || prepared.size !== authorized.size) return;
  finalizing ??= (async () => {
    await verifyCode();
    const result = {
      ...manifest,
      fixtures: manifest.fixtures.map((fixture) => {
        const source = authorized.get(fixture.id);
        const image = prepared.get(fixture.id);
        return {
          ...fixture,
          sourceImage: source.path,
          sourceImageSha256: source.sourceSha256,
          image: source.target,
          imageSha256: image.sha256,
          preparedDimensions: image.dimensions,
        };
      }),
      preparation: {
        engine: 'browser prepareReceiptImage',
        sourceManifest: manifestPath,
        sourceManifestSha256: manifestSha256,
        processorSha256,
        processorSources,
        serverSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
        pageSha256: sha256(await readFile(new URL('./prepare-browser.html', import.meta.url))),
        maxEdge: RECEIPT_IMAGE_MAX_EDGE,
        maxPixels: RECEIPT_IMAGE_MAX_PIXELS,
        outputFormat: 'image/png',
        crop: 'production paper detection and polygon mask when a paper region is found',
        userAgents: [...userAgents],
        startedAt,
        completedAt: new Date().toISOString(),
      },
    };
    // No partial subset is ever published as the final benchmark manifest.
    await writeFile(join(output, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, {
      flag: 'wx',
    });
    completed = true;
    await saveState();
  })();
  await finalizing;
}
function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  response.end(JSON.stringify(value));
}
async function body(request, limit) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw Object.assign(new Error('送信サイズの上限を超えています。'), { status: 413 });
  }
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > limit)
      throw Object.assign(new Error('送信サイズの上限を超えています。'), { status: 413 });
    parts.push(part);
  }
  return Buffer.concat(parts);
}
function mime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  throw new Error('画像形式を確認できませんでした。');
}
async function route(request, response, next, vite) {
  if (
    request.headers.host !== `127.0.0.1:${port}` ||
    request.headers['sec-fetch-site'] === 'cross-site'
  ) {
    json(response, 403, { error: 'このローカルページから操作してください。' });
    return;
  }
  const url = new URL(request.url ?? '/', origin);
  if (request.method === 'GET' && url.pathname === '/') {
    const html = await vite.transformIndexHtml(
      '/',
      await readFile(new URL('./prepare-browser.html', import.meta.url), 'utf8'),
    );
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(html);
    return;
  }
  if (!url.pathname.startsWith(prefix)) {
    if (request.method === 'GET' && allowedModules.has(url.pathname)) return next();
    json(response, 404, { error: 'このファイルは配信していません。' });
    return;
  }
  if (request.method === 'GET' && url.pathname === `${prefix}session`) {
    json(response, 200, {
      ...state(),
      session,
      fixtures: [...authorized.keys()].map((id) => ({
        id,
        url: `${prefix}source?id=${encodeURIComponent(id)}`,
      })),
    });
    return;
  }
  const id = url.searchParams.get('id');
  const source = authorized.get(id);
  if (!source) {
    json(response, 404, { error: '評価対象にない画像です。' });
    return;
  }
  if (request.method === 'GET' && url.pathname === `${prefix}source`) {
    await verifyCode();
    const bytes = await readFile(source.path);
    if (sha256(bytes) !== source.sourceSha256) throw new Error('元画像が変更されました。');
    response.writeHead(200, {
      'Content-Type': mime(bytes),
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(bytes);
    return;
  }
  if (request.method !== 'POST') {
    json(response, 405, { error: 'この操作は利用できません。' });
    return;
  }
  if (request.headers.origin !== origin || request.headers['x-preparation-session'] !== session) {
    json(response, 403, { error: '準備ページを開き直してください。' });
    return;
  }
  if (completed || prepared.has(id) || inProgress.has(id)) {
    json(response, 409, { error: '準備済み、または処理中の画像は上書きできません。' });
    return;
  }
  if (url.pathname === `${prefix}failure`) {
    const report = JSON.parse((await body(request, 8192)).toString());
    if (typeof report.error !== 'string') throw new Error('エラー内容を確認できませんでした。');
    failures.set(id, report.error.slice(0, 1000));
    await saveState();
    json(response, 200, state());
    return;
  }
  if (url.pathname !== `${prefix}image`) {
    json(response, 404, { error: 'この操作は利用できません。' });
    return;
  }
  if (request.headers['content-type'] !== 'image/png') {
    json(response, 415, { error: '準備したPNG画像を送信してください。' });
    return;
  }
  inProgress.add(id);
  try {
    const bytes = await body(request, maxImageBytes);
    if (mime(bytes) !== 'image/png') throw new Error('PNG画像ではありません。');
    const dimensions = readImageDimensions(bytes);
    if (
      !dimensions ||
      dimensions.width > RECEIPT_IMAGE_MAX_EDGE ||
      dimensions.height > RECEIPT_IMAGE_MAX_EDGE ||
      dimensions.width * dimensions.height > RECEIPT_IMAGE_MAX_PIXELS
    ) {
      throw new Error('準備した画像の大きさが本番の制限と一致しません。');
    }
    await verifyCode();
    await writeFile(join(output, source.target), bytes, { flag: 'wx' });
    prepared.set(id, { sha256: sha256(bytes), dimensions });
    failures.delete(id);
    userAgents.add(request.headers['user-agent'] ?? 'unknown');
    await saveState();
    await finishIfReady();
    json(response, 200, state());
  } finally {
    inProgress.delete(id);
  }
}
const vite = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  clearScreen: false,
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    cors: false,
    allowedHosts: ['127.0.0.1'],
    fs: { strict: true, allow: [root] },
  },
  plugins: [
    {
      name: 'receipt-browser-preparation',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          void route(request, response, next, server).catch((error) => {
            if (!response.headersSent)
              json(response, error.status ?? 500, {
                error: error instanceof Error ? error.message : '画像を保存できませんでした。',
              });
            else response.end();
          });
        });
      },
    },
  ],
});
await saveState();
await vite.listen();
console.log(
  JSON.stringify({
    url: origin,
    fixtures: authorized.size,
    outputManifest: join(output, 'manifest.json'),
    processorSha256,
  }),
);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await stateWrite.catch(() => {});
    await vite.close();
    process.exit(0);
  });
}
