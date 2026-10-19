import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.js';
import { createService } from '../src/service.js';
import { calculateTotals } from '../src/money.js';

function setup(t, options = {}) {
  const db = openDatabase(options);
  t.after(() => db.close());
  return { db, service: createService(db) };
}
function populated(service, productId = 'sticker', quantity = 1) {
  const cart = service.createCart();
  service.addItem(cart.id, { productId, quantity });
  return cart;
}
const code = expected => error => error.code === expected;

test('cart lifecycle rejects invalid input and does not reserve stock', t => {
  const { service: s } = setup(t);
  assert.equal(s.listProducts().length, 5);
  const cart = s.createCart();
  for (const quantity of [0, -1, 1.5, '2', null, true, 1001]) {
    assert.throws(() => s.addItem(cart.id, { productId: 'coffee', quantity }), code('INVALID_INPUT'));
  }
  assert.throws(() => s.addItem(cart.id, { productId: 'missing', quantity: 1 }), code('PRODUCT_NOT_FOUND'));
  assert.throws(() => s.addItem(cart.id, { productId: 'lamp', quantity: 2 }), code('INSUFFICIENT_STOCK'));
  assert.equal(s.getCart(cart.id).items.length, 0);
  s.addItem(cart.id, { productId: 'coffee', quantity: 2 });
  s.addItem(cart.id, { productId: 'notebook', quantity: 1 });
  assert.equal(s.getCart(cart.id).subtotalMinor, '112700');
  assert.equal(s.listProducts().find(p => p.id === 'coffee').availableInventory, 50);
  assert.throws(() => s.addItem(cart.id, { productId: 'coffee', quantity: 1 }), code('ITEM_ALREADY_IN_CART'));
  s.updateItem(cart.id, 'coffee', { quantity: 3 });
  assert.equal(s.getCart(cart.id).subtotalMinor, '162600');
  s.removeItem(cart.id, 'notebook');
  assert.equal(s.getCart(cart.id).items.length, 1);
  assert.throws(() => s.updateItem(cart.id, 'notebook', { quantity: 1 }), code('CART_ITEM_NOT_FOUND'));
  assert.throws(() => s.removeItem(cart.id, 'notebook'), code('CART_ITEM_NOT_FOUND'));
});

test('checkout replays success, rejects conflicting keys, and closes the cart', t => {
  const { service: s } = setup(t);
  const cart = populated(s, 'coffee', 2);
  const first = s.checkout(cart.id, 'attempt-1');
  assert.equal(first.replayed, false);
  assert.deepEqual(s.checkout(cart.id, 'attempt-1'), { order: first.order, replayed: true });
  assert.equal(s.listProducts().find(p => p.id === 'coffee').availableInventory, 48);
  assert.equal(s.report().totalSuccessfullyPlacedOrders, 1);
  assert.throws(() => s.checkout(cart.id, 'different-key'), code('CART_ALREADY_CHECKED_OUT'));
  assert.throws(() => s.checkout(cart.id, 'attempt-1', { couponCode: 'other' }), code('IDEMPOTENCY_KEY_CONFLICT'));
  const another = populated(s);
  assert.throws(() => s.checkout(another.id, 'attempt-1'), code('IDEMPOTENCY_KEY_CONFLICT'));
  for (const action of [() => s.addItem(cart.id, { productId: 'mug', quantity: 1 }),
    () => s.updateItem(cart.id, 'coffee', { quantity: 1 }), () => s.removeItem(cart.id, 'coffee')]) {
    assert.throws(action, code('CART_ALREADY_CHECKED_OUT'));
  }
});

test('checkout uses current prices and availability but keeps immutable order snapshots', t => {
  const { service: s } = setup(t);
  const cart = populated(s, 'mug', 2);
  s.updateProduct('mug', { unitPriceMinor: '40000', name: 'Renamed mug', availableInventory: 1 });
  assert.equal(s.getCart(cart.id).subtotalMinor, '80000');
  assert.equal(s.getCart(cart.id).canCheckout, false);
  assert.throws(() => s.checkout(cart.id, 'price-attempt'), code('INSUFFICIENT_STOCK'));
  s.updateProduct('mug', { availableInventory: 2 });
  const { order } = s.checkout(cart.id, 'price-attempt');
  assert.equal(order.subtotalMinor, '80000');
  assert.equal(order.items[0].name, 'Renamed mug');
  s.updateProduct('mug', { unitPriceMinor: '1', name: 'New name' });
  assert.deepEqual(s.getOrder(order.id), order);
  assert.equal(s.getCart(cart.id).subtotalMinor, '80000');
  assert.equal(s.report().grossRevenueMinor, '80000');
});

test('milestones survive delayed generation; reports never generate coupons', t => {
  const { service: s } = setup(t, { rewardEvery: 2 });
  assert.throws(() => s.generateCoupon(), code('NO_ELIGIBLE_MILESTONE'));
  const empty = s.createCart();
  assert.throws(() => s.checkout(empty.id, 'empty'), code('EMPTY_CART'));
  for (let i = 0; i < 5; i++) s.checkout(populated(s).id, `milestone-${i}`);
  const before = s.report();
  assert.equal(before.rewards.unrewardedMilestones, 2);
  assert.equal(before.coupons.generated, 0);
  assert.deepEqual(s.report(), before);
  assert.equal(s.generateCoupon().milestoneOrderCount, 2);
  assert.equal(s.generateCoupon().milestoneOrderCount, 4);
  assert.throws(() => s.generateCoupon(), code('NO_ELIGIBLE_MILESTONE'));
});

test('failed checkouts leave coupon available; rounding is half-up once per order', t => {
  const { service: s } = setup(t, { rewardEvery: 1 });
  s.checkout(populated(s).id, 'qualify');
  const coupon = s.generateCoupon();
  const cart = populated(s);
  assert.throws(() => s.checkout(cart.id, 'redeem', { couponCode: 'unknown' }), code('COUPON_NOT_FOUND'));
  s.updateProduct('sticker', { availableInventory: 0 });
  assert.throws(() => s.checkout(cart.id, 'redeem', { couponCode: coupon.code }), code('INSUFFICIENT_STOCK'));
  assert.equal(s.listCoupons()[0].status, 'AVAILABLE');
  s.updateProduct('sticker', { availableInventory: 10 });
  const { order } = s.checkout(cart.id, 'redeem', { couponCode: coupon.code });
  assert.equal(order.subtotalMinor, '105');
  assert.equal(order.discountMinor, '11');
  assert.equal(order.totalMinor, '94');
  assert.deepEqual(s.checkout(cart.id, 'redeem', { couponCode: coupon.code }).order, order);
  assert.throws(() => s.checkout(populated(s).id, 'reuse', { couponCode: coupon.code }), code('COUPON_ALREADY_REDEEMED'));
});

test('a database failure AFTER inventory and order writes rolls back stock, coupon and key', t => {
  const { db, service: s } = setup(t, { rewardEvery: 1 });
  s.checkout(populated(s).id, 'qualify');
  const coupon = s.generateCoupon();
  const cart = populated(s, 'coffee', 2);
  s.addItem(cart.id, { productId: 'mug', quantity: 1 });
  const before = { products: s.listProducts(), report: s.report(), coupons: s.listCoupons() };
  // This fails after the order row (which represents redemption) and one line are written.
  db.exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON order_items
    WHEN NEW.product_id = 'mug' BEGIN SELECT RAISE(ABORT, 'injected line write failure'); END;`);
  assert.throws(() => s.checkout(cart.id, 'rollback-key', { couponCode: coupon.code }), /injected line write failure/);
  assert.deepEqual({ products: s.listProducts(), report: s.report(), coupons: s.listCoupons() }, before);
  assert.equal(s.getCart(cart.id).status, 'OPEN');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders WHERE idempotency_key = ?').get('rollback-key').count, 0);
  db.exec('DROP TRIGGER injected_failure');
  assert.equal(s.checkout(cart.id, 'rollback-key', { couponCode: coupon.code }).replayed, false);
});

test('automatic SQLite rollback preserves the original failure and leaves the connection reusable', t => {
  const { db, service: s } = setup(t);
  const cart = populated(s);
  db.exec(`CREATE TRIGGER automatic_rollback BEFORE INSERT ON order_items
    BEGIN SELECT RAISE(ROLLBACK, 'original automatic rollback failure'); END;`);
  assert.throws(() => s.checkout(cart.id, 'automatic-rollback-key'), /original automatic rollback failure/);
  assert.equal(db.isTransaction, false);
  assert.equal(s.report().totalSuccessfullyPlacedOrders, 0);
  assert.equal(s.listProducts().find(p => p.id === 'sticker').availableInventory, 200);
  db.exec('DROP TRIGGER automatic_rollback');
  assert.equal(s.checkout(cart.id, 'automatic-rollback-key').replayed, false);
});

test('reports reconcile with returned orders and coupons', t => {
  const { service: s } = setup(t, { rewardEvery: 1 });
  s.checkout(populated(s, 'coffee', 2).id, 'first');
  const coupon = s.generateCoupon();
  s.checkout(populated(s, 'mug', 3).id, 'second', { couponCode: coupon.code });
  s.generateCoupon();
  const orders = s.listOrders();
  const report = s.report();
  const sum = field => orders.reduce((total, order) => total + BigInt(order[field]), 0n).toString();
  assert.equal(report.grossRevenueMinor, sum('subtotalMinor'));
  assert.equal(report.totalDiscountsMinor, sum('discountMinor'));
  assert.equal(report.netRevenueMinor, sum('totalMinor'));
  assert.equal(BigInt(report.grossRevenueMinor) - BigInt(report.totalDiscountsMinor), BigInt(report.netRevenueMinor));
  for (const product of report.purchasedQuantityByProduct) {
    assert.equal(product.quantity, orders.flatMap(o => o.items).filter(i => i.productId === product.productId)
      .reduce((sum, item) => sum + item.quantity, 0));
  }
  const coupons = s.listCoupons();
  assert.equal(report.coupons.generated, coupons.length);
  assert.equal(report.coupons.redeemed, coupons.filter(c => c.status === 'REDEEMED').length);
  assert.equal(report.coupons.available, coupons.filter(c => c.status === 'AVAILABLE').length);
  assert.deepEqual(s.report(), report);
});

test('successful keys, inventory and snapshots survive restart; seed does not restock', t => {
  const directory = mkdtempSync(join(tmpdir(), 'checkout-persistence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { path: join(directory, 'db.sqlite'), rewardEvery: 1 };
  let db = openDatabase(options);
  let s = createService(db);
  const cart = populated(s, 'lamp');
  const first = s.checkout(cart.id, 'durable-key');
  const coupon = s.generateCoupon();
  db.close();
  db = openDatabase(options);
  t.after(() => db.close());
  s = createService(db);
  assert.deepEqual(s.checkout(cart.id, 'durable-key'), { ...first, replayed: true });
  assert.equal(s.listProducts().find(p => p.id === 'lamp').availableInventory, 0);
  assert.equal(s.listCoupons()[0].code, coupon.code);
  assert.throws(() => openDatabase({ ...options, rewardEvery: 2 }), /configuration differs/);
});

test('money handles half-paise boundaries, full discounts and large integer products', t => {
  assert.deepEqual(calculateTotals([{ unitPriceMinor: '105', quantity: 1 }], 10),
    { subtotalMinor: '105', discountMinor: '11', totalMinor: '94' });
  assert.equal(calculateTotals([{ unitPriceMinor: '104', quantity: 1 }], 10).discountMinor, '10');
  assert.equal(calculateTotals([{ unitPriceMinor: '105', quantity: 2 }], 10).discountMinor, '21');
  assert.equal(calculateTotals([{ unitPriceMinor: '105', quantity: 1 }], 100).totalMinor, '0');
  assert.equal(calculateTotals([{ unitPriceMinor: '1000000000', quantity: 100000 }], 99).totalMinor, '1000000000000');
  const { service: s } = setup(t, { rewardEvery: 1, discountPercent: 100 });
  s.checkout(populated(s).id, 'qualify-free');
  const coupon = s.generateCoupon();
  const order = s.checkout(populated(s).id, 'full-discount', { couponCode: coupon.code }).order;
  assert.equal(order.totalMinor, '0');
  assert.equal(s.report().totalSuccessfullyPlacedOrders, 2);
});
