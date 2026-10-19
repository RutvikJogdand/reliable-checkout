import test from 'node:test';
import assert from 'node:assert/strict';
import { request, makeCart, startLocal } from './helpers.js';

test('HTTP endpoints expose a complete cart, order, coupon and report workflow', async t => {
  const { base } = await startLocal(t, { rewardEvery: 1 });
  assert.equal((await request(base, '/health')).status, 200);
  assert.equal((await request(base, '/products')).body.products.length, 5);
  const created = await request(base, '/carts', { method: 'POST' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.headers.get('Location'), `/carts/${id}`);
  assert.equal((await request(base, `/carts/${id}/items`, { method: 'POST', body: { productId: 'mug', quantity: 1 } })).status, 201);
  assert.equal((await request(base, `/carts/${id}/items/mug`, { method: 'PATCH', body: { quantity: 2 } })).body.totalMinor, '69800');
  assert.equal((await request(base, `/carts/${id}/items/mug`, { method: 'DELETE' })).body.items.length, 0);
  await request(base, `/carts/${id}/items`, { method: 'POST', body: { productId: 'sticker', quantity: 1 } });
  const placed = await request(base, `/carts/${id}/checkout`, { method: 'POST', body: {}, key: 'http-key' });
  assert.equal(placed.status, 201);
  assert.equal(placed.headers.get('Idempotency-Replayed'), 'false');
  assert.deepEqual((await request(base, `/orders/${placed.body.id}`)).body, placed.body);
  const replayed = await request(base, `/carts/${id}/checkout`, { method: 'POST', body: {}, key: 'http-key' });
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.body, placed.body);
  assert.equal((await request(base, '/admin/orders')).body.orders.length, 1);
  const coupon = await request(base, '/admin/coupons', { method: 'POST', body: {} });
  assert.equal(coupon.status, 201);
  assert.equal((await request(base, '/admin/coupons')).body.coupons[0].code, coupon.body.code);
  assert.equal((await request(base, '/admin/products/sticker',
    { method: 'PATCH', body: { unitPriceMinor: '205', availableInventory: 20 } })).body.unitPriceMinor, '205');
  assert.equal((await request(base, '/admin/report')).body.grossRevenueMinor, '105');
});

test('HTTP validation returns useful distinct errors without mutation', async t => {
  const { base, service } = await startLocal(t);
  const cart = service.createCart();
  const cases = [
    ['/carts', { method: 'POST', body: [] }, 400, 'INVALID_INPUT'],
    ['/carts', { method: 'POST', body: { unexpected: true } }, 400, 'INVALID_INPUT'],
    [`/carts/${cart.id}/items`, { method: 'POST', body: { productId: 'coffee', quantity: '1' } }, 400, 'INVALID_INPUT'],
    [`/carts/${cart.id}/items`, { method: 'POST', body: { productId: 'missing', quantity: 1 } }, 404, 'PRODUCT_NOT_FOUND'],
    [`/carts/${cart.id}/checkout`, { method: 'POST', body: {} }, 400, 'INVALID_IDEMPOTENCY_KEY'],
    [`/carts/${cart.id}/checkout`, { method: 'POST', body: { couponCode: null }, key: 'null-coupon' }, 400, 'INVALID_INPUT'],
    [`/carts/${cart.id}/checkout`, { method: 'POST', body: {}, key: 'empty' }, 422, 'EMPTY_CART'],
    ['/carts/missing', {}, 404, 'CART_NOT_FOUND'],
    ['/orders/missing', {}, 404, 'ORDER_NOT_FOUND'],
    ['/carts/%E0%A4%A', {}, 400, 'INVALID_INPUT'],
    ['/unknown', {}, 404, 'ROUTE_NOT_FOUND'],
    ['/carts', { method: 'PUT', body: {} }, 405, 'METHOD_NOT_ALLOWED'],
    ['/admin/coupons', { method: 'POST', body: {} }, 409, 'NO_ELIGIBLE_MILESTONE'],
    ['/admin/products/coffee', { method: 'PATCH', body: { unitPriceMinor: 100 } }, 400, 'INVALID_INPUT'],
    ['/admin/products/coffee', { method: 'PATCH', body: { availableInventory: -1 } }, 400, 'INVALID_INPUT'],
  ];
  for (const [path, options, status, errorCode] of cases) {
    const result = await request(base, path, options);
    assert.equal(result.status, status, path);
    assert.equal(result.body.error.code, errorCode, path);
  }
  assert.equal(service.getCart(cart.id).items.length, 0);
  assert.equal(service.report().totalSuccessfullyPlacedOrders, 0);
});

test('invalid JSON, wrong content type and oversized bodies have protocol errors', async t => {
  const { base } = await startLocal(t);
  for (const [body, contentType, status, errorCode] of [
    ['{', 'application/json', 400, 'INVALID_JSON'],
    ['{}', 'text/plain', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [JSON.stringify({ big: 'x'.repeat(17000) }), 'application/json', 413, 'BODY_TOO_LARGE'],
  ]) {
    const response = await fetch(`${base}/carts`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, errorCode);
  }
});

test('HTTP hides internal failures and leaves a checkout safe to retry', async t => {
  const { base, db, errors, service } = await startLocal(t);
  const id = await makeCart(base, 'coffee');
  db.exec(`CREATE TRIGGER fail_order_line BEFORE INSERT ON order_items
    BEGIN SELECT RAISE(ABORT, 'private internal failure'); END;`);
  const result = await request(base, `/carts/${id}/checkout`, { method: 'POST', body: {}, key: 'failed-http' });
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(result.body).includes('private internal'), false);
  assert.equal(errors.length, 1);
  assert.equal(service.report().totalSuccessfullyPlacedOrders, 0);
  db.exec('DROP TRIGGER fail_order_line');
  assert.equal((await request(base, `/carts/${id}/checkout`, { method: 'POST', body: {}, key: 'failed-http' })).status, 201);
});
