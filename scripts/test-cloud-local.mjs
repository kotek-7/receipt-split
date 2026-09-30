import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'receipt-split-cloud-'));
const logPath = join(temporary, 'worker.log');
const log = openSync(logPath, 'w');
const controller = new AbortController();
const children = [];
const environment = {
  ...process.env,
  CI: 'true',
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_LOG_PATH: join(temporary, 'wrangler.log'),
};
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    process.exitCode = code;
    controller.abort(new Error(`Local Cloudflare smoke interrupted by ${signal}`));
  });
}
const timeout = setTimeout(() => {
  process.exitCode = 124;
  controller.abort(new Error('Local Cloudflare smoke exceeded 120 seconds'));
}, 120_000);

function launch(arguments_, stdio) {
  const child = spawn(process.execPath, arguments_, {
    cwd: root,
    env: environment,
    stdio,
    detached: process.platform !== 'win32',
    signal: controller.signal,
  });
  const completion = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const process_ = { child, completion, result: undefined };
  completion.then((result) => {
    process_.result = result;
  });
  children.push(process_);
  return process_;
}

function stopGroup(child, signal) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') console.error(error.message);
  }
}

try {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  environment.BASE_URL = `http://127.0.0.1:${port}`;
  const worker = launch(
    [
      join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      '0',
      '--persist-to',
      join(temporary, 'state'),
    ],
    ['ignore', log, log],
  );
  const deadline = Date.now() + 45_000;
  for (;;) {
    controller.signal.throwIfAborted();
    if (worker.result) {
      process.exitCode = worker.result.code || 1;
      throw (
        worker.result.error ??
        new Error(
          `Wrangler exited before becoming ready (${worker.result.code ?? worker.result.signal})`,
        )
      );
    }
    if (Date.now() >= deadline) throw new Error('Wrangler did not become ready within 45 seconds');
    try {
      const response = await fetch(`${environment.BASE_URL}/api/health`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1_500)]),
      });
      if (response.ok && (await response.json()).ok === true) break;
    } catch {
      controller.signal.throwIfAborted();
    }
    await delay(200, undefined, { signal: controller.signal });
  }
  console.log(`Running Cloudflare smoke against ${environment.BASE_URL}`);
  const smoke = launch(['--import', 'tsx', 'tests/cloudflare.smoke.mjs'], 'inherit');
  const result = await Promise.race([
    smoke.completion,
    worker.completion.then(() => ({
      code: 1,
      error: new Error('Wrangler stopped during smoke tests'),
    })),
  ]);
  controller.signal.throwIfAborted();
  process.exitCode = result.code ?? 1;
  if (process.exitCode)
    throw result.error ?? new Error(`Cloudflare smoke failed (${result.code ?? result.signal})`);
} catch (error) {
  process.exitCode ||= 1;
  console.error(error.message);
} finally {
  clearTimeout(timeout);
  for (const { child } of children) stopGroup(child, 'SIGTERM');
  await delay(500);
  for (const { child } of children) stopGroup(child, 'SIGKILL');
  await Promise.all(children.map(({ completion }) => completion));
  closeSync(log);
  if (process.exitCode) console.error(readFileSync(logPath, 'utf8'));
  rmSync(temporary, { recursive: true, force: true });
}
