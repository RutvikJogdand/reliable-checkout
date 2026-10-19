import { once } from 'node:events';
import { openDatabase } from '../src/database.js';
import { createService } from '../src/service.js';
import { createHttpServer } from '../src/http.js';

export async function request(base, path, { method = 'GET', body, key, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(key === undefined ? {} : { 'Idempotency-Key': key }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

export async function startLocal(t, options = {}) {
  const db = openDatabase(options);
  const service = createService(db);
  const errors = [];
  const server = createHttpServer(service, { logger: { error: error => errors.push(error) } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    db.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, db, service, errors };
}

export async function makeCart(base, productId = 'sticker', quantity = 1) {
  const created = await request(base, '/carts', { method: 'POST', body: {} });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const added = await request(base, `/carts/${created.body.id}/items`,
    { method: 'POST', body: { productId, quantity } });
  if (added.status !== 201) throw new Error(JSON.stringify(added.body));
  return created.body.id;
}
