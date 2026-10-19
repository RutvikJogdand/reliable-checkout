import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.js';
import { request, makeCart } from './helpers.js';

async function cluster(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'checkout-concurrency-'));
  const options = { path: join(directory, 'shared.sqlite'), rewardEvery: 1, ...overrides };
  // Initialization is separate from the competing business operations under test.
  openDatabase(options).close();
  const workers = [];
  t.after(async () => {
    for (const worker of workers) {
      const exited = once(worker, 'exit');
      worker.postMessage('close');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const bases = [];
  for (let i = 0; i < 2; i++) {
    const worker = new Worker(new URL('./fixtures/server-worker.js', import.meta.url), { workerData: options });
    workers.push(worker);
    bases.push((await once(worker, 'message'))[0].base);
  }
  return { bases, options };
}

test('two independent servers: twelve buyers compete for the final unit', { timeout: 15000 }, async t => {
  const { bases } = await cluster(t);
  const carts = await Promise.all(Array.from({ length: 12 }, (_, i) => makeCart(bases[i % 2], 'lamp')));
  const results = await Promise.all(carts.map((id, i) => request(bases[i % 2], `/carts/${id}/checkout`,
    { method: 'POST', body: {}, key: `last-unit-${i}` })));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.status === 409 && r.body.error.code === 'INSUFFICIENT_STOCK').length, 11);
  const report = (await request(bases[0], '/admin/report')).body;
  assert.equal(report.totalSuccessfullyPlacedOrders, 1);
  assert.equal(report.purchasedQuantityByProduct.find(p => p.productId === 'lamp').quantity, 1);
  const products = (await request(bases[1], '/products')).body.products;
  assert.equal(products.find(p => p.id === 'lamp').availableInventory, 0);
});

test('two independent servers: simultaneous retries create one order and one deduction', { timeout: 15000 }, async t => {
  const { bases } = await cluster(t);
  const cartId = await makeCart(bases[0], 'coffee', 2);
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => request(bases[i % 2], `/carts/${cartId}/checkout`,
    { method: 'POST', body: {}, key: 'same-checkout-key' })));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.status === 200).length, 15);
  assert.equal(new Set(results.map(r => r.body.id)).size, 1);
  assert.equal(results.filter(r => r.headers.get('Idempotency-Replayed') === 'true').length, 15);
  const products = (await request(bases[0], '/products')).body.products;
  assert.equal(products.find(p => p.id === 'coffee').availableInventory, 48);
});

test('two independent servers: different keys cannot check out one cart twice', { timeout: 15000 }, async t => {
  const { bases } = await cluster(t);
  const cartId = await makeCart(bases[0], 'coffee');
  const results = await Promise.all(bases.map((base, i) => request(base, `/carts/${cartId}/checkout`,
    { method: 'POST', body: {}, key: `cart-key-${i}` })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(results.find(r => r.status === 409).body.error.code, 'CART_ALREADY_CHECKED_OUT');
});

test('two independent servers: one key used for two carts has one winner and a clear conflict', { timeout: 15000 }, async t => {
  const { bases } = await cluster(t);
  const carts = await Promise.all(bases.map(base => makeCart(base)));
  const results = await Promise.all(bases.map((base, i) => request(base, `/carts/${carts[i]}/checkout`,
    { method: 'POST', body: {}, key: 'accidentally-shared-key' })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(results.find(r => r.status === 409).body.error.code, 'IDEMPOTENCY_KEY_CONFLICT');
});

test('two independent servers: coupon generation and redemption each have one winner', { timeout: 15000 }, async t => {
  const { bases } = await cluster(t);
  const qualifying = await makeCart(bases[0]);
  await request(bases[0], `/carts/${qualifying}/checkout`, { method: 'POST', body: {}, key: 'qualifying' });
  const generations = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    request(bases[i % 2], '/admin/coupons', { method: 'POST', body: {} })));
  assert.equal(generations.filter(r => r.status === 201).length, 1);
  assert.equal(generations.filter(r => r.status === 409 && r.body.error.code === 'NO_ELIGIBLE_MILESTONE').length, 7);
  const coupon = generations.find(r => r.status === 201).body;
  const carts = await Promise.all(bases.map(base => makeCart(base, 'mug')));
  const results = await Promise.all(bases.map((base, i) => request(base, `/carts/${carts[i]}/checkout`,
    { method: 'POST', body: { couponCode: coupon.code }, key: `redemption-${i}` })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(results.find(r => r.status === 409).body.error.code, 'COUPON_ALREADY_REDEEMED');
  const failedIndex = results.findIndex(r => r.status === 409);
  assert.equal((await request(bases[0], `/carts/${carts[failedIndex]}`)).body.status, 'OPEN');
  assert.equal((await request(bases[1], '/products')).body.products.find(p => p.id === 'mug').availableInventory, 19);
  const report = (await request(bases[0], '/admin/report')).body;
  assert.equal(report.totalSuccessfullyPlacedOrders, 2);
  assert.deepEqual(report.coupons, { generated: 1, available: 0, redeemed: 1 });
});

test('a held database write lock produces retryable 503; retry then succeeds once', { timeout: 15000 }, async t => {
  const { bases, options } = await cluster(t, { timeout: 50 });
  const cartId = await makeCart(bases[0]);
  const blocker = openDatabase(options);
  blocker.exec('BEGIN IMMEDIATE');
  try {
    const result = await request(bases[1], `/carts/${cartId}/checkout`,
      { method: 'POST', body: {}, key: 'locked-checkout' });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'DATABASE_BUSY');
    assert.equal(result.headers.get('Retry-After'), '1');
    // WAL allows readers to see the previous committed snapshot while a writer waits.
    assert.equal((await request(bases[0], '/admin/report')).body.totalSuccessfullyPlacedOrders, 0);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
  const success = await request(bases[1], `/carts/${cartId}/checkout`,
    { method: 'POST', body: {}, key: 'locked-checkout' });
  assert.equal(success.status, 201);
  assert.equal((await request(bases[0], '/admin/report')).body.totalSuccessfullyPlacedOrders, 1);
});
