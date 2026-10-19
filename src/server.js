import { openDatabase } from './database.js';
import { createService } from './service.js';
import { createHttpServer } from './http.js';

function envInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer.`);
  return Number(value);
}

const port = envInteger('PORT', 3000);
if (port < 1 || port > 65535) throw new Error('PORT must be from 1 to 65535.');
const host = process.env.HOST ?? '127.0.0.1';
const db = openDatabase({ path: process.env.DB_PATH ?? './data/checkout.sqlite',
  rewardEvery: envInteger('REWARD_EVERY', 5), discountPercent: envInteger('DISCOUNT_PERCENT', 10) });
const server = createHttpServer(createService(db));
server.once('error', error => {
  console.error(error);
  db.close();
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Checkout service listening on http://${host}:${port}`));

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => db.close());
  // An abandoned connection must not prevent local shutdown indefinitely.
  setTimeout(() => server.closeAllConnections(), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
