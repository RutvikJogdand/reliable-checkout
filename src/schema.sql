CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  reward_every INTEGER NOT NULL CHECK (reward_every BETWEEN 1 AND 1000000),
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 100)
) STRICT;

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor BETWEEN 0 AND 1000000000),
  inventory INTEGER NOT NULL CHECK (inventory BETWEEN 0 AND 1000000)
) STRICT;

CREATE TABLE carts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE cart_items (
  cart_id TEXT NOT NULL REFERENCES carts(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  PRIMARY KEY (cart_id, product_id)
) STRICT;

CREATE TABLE coupons (
  code TEXT PRIMARY KEY,
  milestone INTEGER NOT NULL UNIQUE CHECK (milestone > 0),
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL UNIQUE REFERENCES carts(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  coupon_code TEXT UNIQUE REFERENCES coupons(code),
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
  currency TEXT NOT NULL CHECK (currency = 'INR'),
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor BETWEEN 0 AND 100000000000000),
  discount_minor INTEGER NOT NULL CHECK (discount_minor BETWEEN 0 AND subtotal_minor),
  total_minor INTEGER NOT NULL CHECK (total_minor = subtotal_minor - discount_minor),
  created_at TEXT NOT NULL,
  CHECK ((coupon_code IS NULL AND discount_percent = 0 AND discount_minor = 0)
    OR (coupon_code IS NOT NULL AND discount_percent BETWEEN 1 AND 100))
) STRICT;

CREATE TABLE order_items (
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor BETWEEN 0 AND 1000000000),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor = unit_price_minor * quantity),
  PRIMARY KEY (order_id, product_id)
) STRICT;

PRAGMA user_version = 1;
