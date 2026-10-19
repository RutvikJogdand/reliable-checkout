import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase } from '../src/database.js';
import { createService } from '../src/service.js';
import { createHttpServer } from '../src/http.js';

// This demonstration uses a fresh, isolated database every run.
const db = openDatabase({ rewardEvery: 2, discountPercent: 10 });
const server = createHttpServer(createService(db));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, { method = 'GET', body, key } = {}) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function cartWith(productId, quantity = 1) {
  const created = await request('/carts', { method: 'POST', body: {} });
  assert.equal(created.status, 201);
  const cartId = created.body.id;
  const added = await request(`/carts/${cartId}/items`, { method: 'POST', body: { productId, quantity } });
  assert.equal(added.status, 201);
  return cartId;
}
const checkout = (cartId, key, body = {}) => request(`/carts/${cartId}/checkout`, { method: 'POST', key, body });

try {
  console.log('Demo configuration: every 2 orders makes a 10% coupon eligible.');
  assert.equal((await request('/admin/coupons', { method: 'POST', body: {} })).status, 409);
  console.log('1. Coupon generation before the first milestone is rejected.');

  assert.equal((await checkout(await cartWith('coffee', 2), 'demo-first')).status, 201);
  assert.equal((await checkout(await cartWith('mug'), 'demo-second')).status, 201);
  const generated = await request('/admin/coupons', { method: 'POST', body: {} });
  assert.equal(generated.status, 201);
  console.log('2. Two orders qualify for one coupon; the administrator generates it.');

  const cartId = await cartWith('sticker');
  const attempts = await Promise.all(Array.from({ length: 8 }, () =>
    checkout(cartId, 'demo-retry', { couponCode: generated.body.code })));
  assert.equal(attempts.filter(r => r.status === 201).length, 1);
  assert.equal(attempts.filter(r => r.status === 200).length, 7);
  assert.equal(new Set(attempts.map(r => r.body.id)).size, 1);
  assert.equal(attempts[0].body.discountMinor, '11');
  assert.equal(attempts[0].body.totalMinor, '94');
  console.log('3. Eight overlapping checkout attempts create one order.');
  console.log('   Sticker: 105 paise; 10% discount rounds to 11 paise; payable: 94 paise.');

  const carts = await Promise.all([cartWith('lamp'), cartWith('lamp')]);
  const race = await Promise.all(carts.map((id, i) => checkout(id, `demo-last-lamp-${i}`)));
  assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
  assert.equal(race.find(r => r.status === 409).body.error.code, 'INSUFFICIENT_STOCK');
  console.log('4. Two buyers compete for the last lamp; exactly one succeeds.');

  const report = await request('/admin/report');
  assert.equal(report.body.totalSuccessfullyPlacedOrders, 4);
  assert.equal(report.body.grossRevenueMinor, '284705');
  assert.equal(report.body.totalDiscountsMinor, '11');
  assert.equal(report.body.netRevenueMinor, '284694');
  console.log('5. The report reconciles with four successful orders:');
  console.log(JSON.stringify(report.body, null, 2));
  console.log('Demo passed. The normal service database was not used.');
} finally {
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
  db.close();
}
