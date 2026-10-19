import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { check, fields, identifier, integer } from './errors.js';
import { calculateTotals, CURRENCY, parseUnitPrice } from './money.js';

const now = () => new Date().toISOString();

export function createService(db) {
  const read = work => transaction(db, work, { readOnly: true });
  const write = work => transaction(db, work);
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();

  function productView(row) {
    return { id: row.id, name: row.name, unitPriceMinor: String(row.unit_price_minor),
      currency: CURRENCY, availableInventory: row.inventory };
  }

  function product(id) {
    identifier(id, 'productId');
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    check(row, 404, 'PRODUCT_NOT_FOUND', 'Product does not exist.');
    return row;
  }

  function cart(id, requireOpen = false) {
    identifier(id, 'cartId');
    const row = db.prepare('SELECT * FROM carts WHERE id = ?').get(id);
    check(row, 404, 'CART_NOT_FOUND', 'Cart does not exist.');
    if (requireOpen) {
      const order = db.prepare('SELECT id FROM orders WHERE cart_id = ?').get(id);
      check(!order, 409, 'CART_ALREADY_CHECKED_OUT', 'Cart has already been checked out.',
        order ? { orderId: order.id } : undefined);
    }
    return row;
  }

  function currentItems(cartId) {
    return db.prepare(`SELECT p.*, ci.quantity FROM cart_items ci
      JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = ? ORDER BY p.id`)
      .all(cartId).map(row => ({ productId: row.id, name: row.name,
        quantity: row.quantity, unitPriceMinor: String(row.unit_price_minor),
        lineTotalMinor: (BigInt(row.unit_price_minor) * BigInt(row.quantity)).toString(),
        availableInventory: row.inventory }));
  }

  function orderView(row) {
    return { id: row.id, cartId: row.cart_id, status: 'PLACED', currency: row.currency,
      items: db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY product_id')
        .all(row.id).map(item => ({ productId: item.product_id, name: item.product_name,
          quantity: item.quantity, unitPriceMinor: String(item.unit_price_minor),
          lineTotalMinor: String(item.line_total_minor) })),
      couponCode: row.coupon_code, discountPercent: row.discount_percent,
      subtotalMinor: String(row.subtotal_minor), discountMinor: String(row.discount_minor),
      totalMinor: String(row.total_minor), createdAt: row.created_at };
  }

  function cartView(cartId) {
    const row = cart(cartId);
    const placed = db.prepare('SELECT * FROM orders WHERE cart_id = ?').get(cartId);
    if (placed) {
      const order = orderView(placed);
      return { id: row.id, status: 'CHECKED_OUT', orderId: order.id, createdAt: row.created_at,
        currency: CURRENCY, items: order.items, subtotalMinor: order.subtotalMinor,
        discountMinor: order.discountMinor, totalMinor: order.totalMinor, canCheckout: false };
    }
    const items = currentItems(cartId);
    return { id: row.id, status: 'OPEN', orderId: null, createdAt: row.created_at,
      currency: CURRENCY, items, ...calculateTotals(items),
      canCheckout: items.length > 0 && items.every(item => item.quantity <= item.availableInventory) };
  }

  function requireStock(productId, requested, available) {
    check(requested <= available, 409, 'INSUFFICIENT_STOCK', 'Requested quantity is not available.',
      { productId, requested, available });
  }

  function couponView(row) {
    return { code: row.code, milestoneOrderCount: row.milestone,
      discountPercent: row.discount_percent, status: row.order_id ? 'REDEEMED' : 'AVAILABLE',
      redeemedOrderId: row.order_id ?? null, createdAt: row.created_at };
  }

  return {
    listProducts() {
      return db.prepare('SELECT * FROM products ORDER BY id').all().map(productView);
    },

    createCart(body = {}) {
      fields(body, []);
      return write(() => {
        const id = randomUUID();
        db.prepare('INSERT INTO carts VALUES (?, ?)').run(id, now());
        return cartView(id);
      });
    },

    getCart(id) { return read(() => cartView(id)); },

    addItem(cartId, body) {
      fields(body, ['productId', 'quantity'], ['productId', 'quantity']);
      identifier(body.productId, 'productId');
      integer(body.quantity, 'quantity', 1, 1000);
      return write(() => {
        cart(cartId, true);
        const row = product(body.productId);
        check(!db.prepare('SELECT 1 FROM cart_items WHERE cart_id = ? AND product_id = ?')
          .get(cartId, body.productId), 409, 'ITEM_ALREADY_IN_CART', 'Use PATCH to set the quantity of an existing item.');
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM cart_items WHERE cart_id = ?').get(cartId);
        check(count < 100, 409, 'CART_ITEM_LIMIT', 'A cart may contain at most 100 distinct products.');
        requireStock(body.productId, body.quantity, row.inventory);
        db.prepare('INSERT INTO cart_items VALUES (?, ?, ?)').run(cartId, body.productId, body.quantity);
        return cartView(cartId);
      });
    },

    updateItem(cartId, productId, body) {
      fields(body, ['quantity'], ['quantity']);
      integer(body.quantity, 'quantity', 1, 1000);
      return write(() => {
        cart(cartId, true);
        const row = product(productId);
        check(db.prepare('SELECT 1 FROM cart_items WHERE cart_id = ? AND product_id = ?')
          .get(cartId, productId), 404, 'CART_ITEM_NOT_FOUND', 'Product is not in this cart.');
        requireStock(productId, body.quantity, row.inventory);
        db.prepare('UPDATE cart_items SET quantity = ? WHERE cart_id = ? AND product_id = ?')
          .run(body.quantity, cartId, productId);
        return cartView(cartId);
      });
    },

    removeItem(cartId, productId) {
      identifier(productId, 'productId');
      return write(() => {
        cart(cartId, true);
        const result = db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?')
          .run(cartId, productId);
        check(result.changes === 1, 404, 'CART_ITEM_NOT_FOUND', 'Product is not in this cart.');
        return cartView(cartId);
      });
    },

    checkout(cartId, idempotencyKey, body = {}) {
      identifier(cartId, 'cartId');
      fields(body, ['couponCode']);
      check(typeof idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey),
        400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key is required: 1–128 letters, digits, dots, underscores, colons or hyphens.');
      const couponCode = Object.hasOwn(body, 'couponCode') ? identifier(body.couponCode, 'couponCode') : null;
      // Fixed-order fields avoid differences caused by JSON object property order.
      const fingerprint = JSON.stringify([cartId, couponCode]);

      return write(() => {
        // Look up the key BEFORE checking whether this cart/coupon is already used.
        const previous = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(idempotencyKey);
        if (previous) {
          check(previous.request_fingerprint === fingerprint, 409, 'IDEMPOTENCY_KEY_CONFLICT',
            'This key was already used successfully for a different cart or coupon.');
          return { order: orderView(previous), replayed: true };
        }

        cart(cartId, true);
        const items = currentItems(cartId);
        check(items.length > 0, 422, 'EMPTY_CART', 'Add at least one item before checkout.');
        for (const item of items) requireStock(item.productId, item.quantity, item.availableInventory);

        let discountPercent = 0;
        if (couponCode) {
          const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(couponCode);
          check(coupon, 404, 'COUPON_NOT_FOUND', 'Coupon does not exist.');
          check(!db.prepare('SELECT 1 FROM orders WHERE coupon_code = ?').get(couponCode),
            409, 'COUPON_ALREADY_REDEEMED', 'Coupon has already been redeemed.');
          discountPercent = coupon.discount_percent;
        }
        const totals = calculateTotals(items, discountPercent);

        for (const item of items) {
          const result = db.prepare(`UPDATE products SET inventory = inventory - ?
            WHERE id = ? AND inventory >= ?`).run(item.quantity, item.productId, item.quantity);
          check(result.changes === 1, 409, 'INSUFFICIENT_STOCK', 'Inventory changed before checkout completed.');
        }

        const orderId = randomUUID();
        // UNIQUE(cart_id), UNIQUE(coupon_code), and UNIQUE(idempotency_key) are
        // independent database backstops. This row also represents coupon redemption.
        db.prepare(`INSERT INTO orders (id, cart_id, idempotency_key, request_fingerprint,
          coupon_code, discount_percent, currency, subtotal_minor, discount_minor, total_minor, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(orderId, cartId, idempotencyKey,
          fingerprint, couponCode, discountPercent, CURRENCY, BigInt(totals.subtotalMinor),
          BigInt(totals.discountMinor), BigInt(totals.totalMinor), now());
        const insert = db.prepare(`INSERT INTO order_items
          (order_id, product_id, product_name, unit_price_minor, quantity, line_total_minor)
          VALUES (?, ?, ?, ?, ?, ?)`);
        for (const item of items) {
          insert.run(orderId, item.productId, item.name, BigInt(item.unitPriceMinor),
            item.quantity, BigInt(item.lineTotalMinor));
        }
        return { order: orderView(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)), replayed: false };
      });
    },

    getOrder(id) {
      identifier(id, 'orderId');
      return read(() => {
        const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
        check(row, 404, 'ORDER_NOT_FOUND', 'Order does not exist.');
        return orderView(row);
      });
    },

    listOrders() {
      return read(() => db.prepare('SELECT * FROM orders ORDER BY created_at, id').all().map(orderView));
    },

    generateCoupon(body = {}) {
      fields(body, []);
      return write(() => {
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM orders').get();
        const { last } = db.prepare('SELECT COALESCE(MAX(milestone), 0) AS last FROM coupons').get();
        const next = last + settings.reward_every;
        check(next <= count, 409, 'NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone is eligible.',
          { successfulOrders: count, nextMilestoneOrderCount: next });
        const row = { code: `reward_${randomUUID()}`, milestone: next,
          discount_percent: settings.discount_percent, created_at: now() };
        db.prepare('INSERT INTO coupons VALUES (?, ?, ?, ?)')
          .run(row.code, row.milestone, row.discount_percent, row.created_at);
        return couponView(row);
      });
    },

    listCoupons() {
      return db.prepare(`SELECT c.*, o.id AS order_id FROM coupons c
        LEFT JOIN orders o ON o.coupon_code = c.code ORDER BY c.milestone`).all().map(couponView);
    },

    updateProduct(id, body) {
      fields(body, ['name', 'unitPriceMinor', 'availableInventory']);
      check(Object.keys(body).length > 0, 400, 'INVALID_INPUT', 'Provide at least one field to update.');
      if (Object.hasOwn(body, 'name')) {
        check(typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 100
          && !body.name.includes('\0'),
          400, 'INVALID_INPUT', 'name must contain 1–100 characters and must not be blank.');
      }
      if (Object.hasOwn(body, 'unitPriceMinor')) parseUnitPrice(body.unitPriceMinor);
      if (Object.hasOwn(body, 'availableInventory')) integer(body.availableInventory, 'availableInventory', 0, 1_000_000);
      return write(() => {
        const row = product(id);
        db.prepare('UPDATE products SET name = ?, unit_price_minor = ?, inventory = ? WHERE id = ?')
          .run(body.name ?? row.name, body.unitPriceMinor === undefined ? row.unit_price_minor : BigInt(body.unitPriceMinor),
            body.availableInventory ?? row.inventory, id);
        return productView(product(id));
      });
    },

    report() {
      return read(() => {
        let gross = 0n, discounts = 0n, net = 0n, totalOrders = 0;
        // Individual orders are bounded. BigInt aggregation also keeps cumulative
        // revenue exact beyond JavaScript Number and SQLite SUM integer limits.
        for (const row of db.prepare('SELECT subtotal_minor, discount_minor, total_minor FROM orders').iterate()) {
          totalOrders++;
          gross += BigInt(row.subtotal_minor);
          discounts += BigInt(row.discount_minor);
          net += BigInt(row.total_minor);
        }
        const coupons = db.prepare(`SELECT COUNT(*) AS generated, COUNT(o.id) AS redeemed
          FROM coupons c LEFT JOIN orders o ON o.coupon_code = c.code`).get();
        const purchasedQuantityByProduct = db.prepare(`SELECT p.id AS productId,
          COALESCE(SUM(oi.quantity), 0) AS quantity FROM products p
          LEFT JOIN order_items oi ON oi.product_id = p.id GROUP BY p.id ORDER BY p.id`)
          .all().map(row => ({ ...row }));
        return { currency: CURRENCY, totalSuccessfullyPlacedOrders: totalOrders,
          purchasedQuantityByProduct, grossRevenueMinor: gross.toString(),
          totalDiscountsMinor: discounts.toString(), netRevenueMinor: net.toString(),
          coupons: { generated: coupons.generated, available: coupons.generated - coupons.redeemed,
            redeemed: coupons.redeemed },
          rewards: { every: settings.reward_every, discountPercent: settings.discount_percent,
            unrewardedMilestones: Math.floor(totalOrders / settings.reward_every) - coupons.generated } };
      });
    },
  };
}
