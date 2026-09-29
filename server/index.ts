import path from 'node:path';
import { createApp } from './app';

const port = Number(process.env.PORT ?? '4317');
const host = process.env.HOST ?? '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer from 1 to 65535');
const dataDirectory = path.resolve(process.env.DATA_DIR ?? 'data');
const application = await createApp({
  dbPath: path.join(dataDirectory, 'receipt-split.sqlite'),
  serveFrontend: true,
});
const server = application.app.listen(port, host, () => {
  console.log(`Receipt Split is ready at http://localhost:${port}`);
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void application
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
