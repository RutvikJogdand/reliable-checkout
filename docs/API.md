# API contract

Base URL: `http://127.0.0.1:3000`. Endpoints have no trailing slash. Responses are
JSON with `Cache-Control: no-store`. All IDs and coupon codes are case-sensitive.
There is no authentication. Every `/admin/*` endpoint is an administrative
operation; the evaluator can call it directly.

## General conventions

- Send `Content-Type: application/json` for nonempty POST/PATCH bodies. Empty
  bodies are treated as `{}`. Unknown object fields are rejected. Arrays, null,
  numeric strings for quantities, fractional quantities and booleans are rejected.
- Maximum request body: 16 KiB. IDs contain 1–80 ASCII letters, digits,
  underscores or hyphens. Generated cart/order IDs are UUIDs.
- Money is a decimal **string of minor units**, always INR paise. `"105"` is
  INR 1.05. A string preserves exact integer values even in large reports.
- Quantities: integer 1–1000; remove with DELETE instead of setting zero.
  Available inventory: integer 0–1,000,000. At most 100 distinct cart lines.
- Client prices, totals and discount percentages are never accepted at checkout.
- Lists are unpaginated in this assignment. No filters or ordering parameters
  are supported. Unrecognized query parameters are currently ignored.

## Shared response shapes

Examples below use illustrative IDs and timestamps; capture actual values from
the service before making the next request.

### Product

```json
{
  "id": "mug",
  "name": "Ceramic mug",
  "unitPriceMinor": "34900",
  "currency": "INR",
  "availableInventory": 20
}
```

### Cart

```json
{
  "id": "cart-example",
  "status": "OPEN",
  "orderId": null,
  "createdAt": "2026-10-19T13:00:00.000Z",
  "currency": "INR",
  "items": [
    {
      "productId": "mug",
      "name": "Ceramic mug",
      "quantity": 2,
      "unitPriceMinor": "34900",
      "lineTotalMinor": "69800",
      "availableInventory": 20
    }
  ],
  "subtotalMinor": "69800",
  "discountMinor": "0",
  "totalMinor": "69800",
  "canCheckout": true
}
```

An empty cart has `items: []`, zero totals and `canCheckout: false`. An open cart's
prices/stock are a current estimate; `canCheckout` is advisory, not a reservation.
A checked-out cart has `status: "CHECKED_OUT"`, its `orderId`, final order items and
totals, and `canCheckout: false`. Its items omit `availableInventory` because they
are historical purchases. Follow `orderId` for coupon details.

### Order

```json
{
  "id": "order-example",
  "cartId": "cart-example",
  "status": "PLACED",
  "currency": "INR",
  "items": [
    {
      "productId": "sticker",
      "name": "Sticker",
      "quantity": 1,
      "unitPriceMinor": "105",
      "lineTotalMinor": "105"
    }
  ],
  "couponCode": "reward_example",
  "discountPercent": 10,
  "subtotalMinor": "105",
  "discountMinor": "11",
  "totalMinor": "94",
  "createdAt": "2026-10-19T13:00:00.000Z"
}
```

Without a coupon: `couponCode: null`, `discountPercent: 0`, `discountMinor: "0"`.
Line totals are before the order-level discount. No shipping or tax is added.

### Coupon

```json
{
  "code": "reward_example",
  "milestoneOrderCount": 5,
  "discountPercent": 10,
  "status": "AVAILABLE",
  "redeemedOrderId": null,
  "createdAt": "2026-10-19T13:00:00.000Z"
}
```

After redemption, `status` is `"REDEEMED"` and `redeemedOrderId` identifies the
order. Codes never expire. No coupon is automatically attached to a cart.

### Error

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Requested quantity is not available.",
    "details": { "productId": "lamp", "requested": 1, "available": 0 }
  }
}
```

Use `error.code` for program logic. `details` is present only when useful.
Messages are explanatory; clients should not parse them.

## Endpoints

| Method and path | Request | Success response | Important errors |
| --- | --- | --- | --- |
| `GET /health` | No body | 200, `{"status":"ok"}`; process liveness only | Generic server errors |
| `GET /products` | No body | 200, `{"products":[Product]}`, sorted by ID | Generic server errors |
| `POST /carts` | `{}` or empty | 201, Cart; `Location: /carts/:id` | 400 invalid/unknown fields |
| `GET /carts/:cartId` | No body | 200, Cart with current prices or final purchased snapshot | 404 `CART_NOT_FOUND` |
| `POST /carts/:cartId/items` | `{"productId":"mug","quantity":2}` | 201, updated Cart | 404 cart/product missing; 409 duplicate item, closed cart, insufficient stock or item limit |
| `PATCH /carts/:cartId/items/:productId` | `{"quantity":3}` | 200, updated Cart; quantity is replaced, not incremented | 404 cart/product/item missing; 409 closed cart or insufficient stock |
| `DELETE /carts/:cartId/items/:productId` | No body | 200, updated Cart | 404 cart/item missing; 409 closed cart |
| `POST /carts/:cartId/checkout` | `{}` or `{"couponCode":"reward_example"}`; required `Idempotency-Key` header | 201 new Order; 200 identical Order on replay; see below | 400 key/body invalid; 404 cart/coupon missing; 409 stock/cart/coupon/key conflict; 422 empty cart or excessive total; 503 busy |
| `GET /orders/:orderId` | No body | 200, Order with immutable purchase values | 404 `ORDER_NOT_FOUND` |
| `PATCH /admin/products/:productId` | Any nonempty subset of `{"name":"New mug","unitPriceMinor":"40000","availableInventory":10}` | 200, Product | 400 invalid fields; 404 `PRODUCT_NOT_FOUND` |
| `POST /admin/coupons` | `{}` or empty | 201, Coupon for the oldest eligible unrewarded milestone | 409 `NO_ELIGIBLE_MILESTONE` |
| `GET /admin/coupons` | No body | 200, `{"coupons":[Coupon]}`, sorted by milestone | Generic server errors |
| `GET /admin/orders` | No body | 200, `{"orders":[Order]}`, sorted by creation time then ID | Generic server errors |
| `GET /admin/report` | No body | 200, report described below | Generic server errors |

All POST/PATCH endpoints can return 400 `INVALID_INPUT` or `INVALID_JSON`, 413
`BODY_TOO_LARGE`, or 415 `UNSUPPORTED_MEDIA_TYPE`. A known path with the wrong
method returns 405 `METHOD_NOT_ALLOWED` with an `Allow` header; an unknown path
returns 404 `ROUTE_NOT_FOUND`. Database contention can return 503 on any operation;
unexpected failures return a sanitized 500 `INTERNAL_ERROR`.

Product price input must be an integer string from `"0"` to `"1000000000"`, without
leading zeros except `"0"`. Product names must be 1–100 characters, contain a
non-whitespace character and contain no NUL. Inventory updates set **absolute
currently available inventory**, not a restock increment. They participate in the
same write serialization as checkout.

POST adds a new distinct line. Adding an existing product returns
`ITEM_ALREADY_IN_CART` rather than silently increasing it. PATCH sets absolute
quantity, making repeated identical PATCH requests harmless while the cart is
open and stock suffices. Repeated DELETE returns 404 after the first removal.
Cart creation and coupon generation have no idempotency-key mechanism.

## Checkout retries and errors

`Idempotency-Key` accepts 1–128 ASCII letters, digits, dots, underscores, colons
and hyphens. Generate a fresh UUID for a new checkout attempt; preserve it across
network retries. Keys are globally scoped to this service and retained with
successful orders. They should not contain personal information.

The request identity is the cart ID and optional coupon code. Missing coupon is
valid; `null` or an empty string is invalid. Cart contents are mutable before
success and are not fingerprinted. The order freezes the contents after success.

| Situation | Response and effect |
| --- | --- |
| First successful checkout | 201; `Idempotency-Replayed: false`; `Location: /orders/:id` |
| Same successful key, same cart/coupon | 200; `Idempotency-Replayed: true`; original order body and Location; no new writes to domain state |
| Same successful key, different cart/coupon | 409 `IDEMPOTENCY_KEY_CONFLICT` |
| Same purchased cart, new key | 409 `CART_ALREADY_CHECKED_OUT`, including original `orderId` |
| Insufficient stock | 409 `INSUFFICIENT_STOCK`; all checkout changes roll back |
| Coupon already used by a different order | 409 `COUPON_ALREADY_REDEEMED` |
| No cart items | 422 `EMPTY_CART` |
| Write lock cannot be obtained within timeout | 503 `DATABASE_BUSY`, `Retry-After: 1`; retry checkout with the same key |
| Response was lost or server returned 500 | Retry the same key/body; recover a committed order or make a fresh attempt if none committed |

Failures are not cached and do not reserve keys. After a failed attempt, fixing
the cart/stock/coupon and retrying is allowed. A failed key can also be used with
another request; only a successful request binds it. Once bound, even later
catalog changes cannot change the replayed order. A replay is looked up before
the already-used cart/coupon checks.

There is no real payment gateway. Committing the order is the exercise's payment
success. Nothing outside the database is charged.

## Coupon generation

With `n=5`, successful order totals 5, 10, 15, etc. earn milestones. If there are
12 successful orders and no coupons yet, successive admin calls generate the
milestone-5 coupon and milestone-10 coupon. A third call returns 409. Redeeming a
coupon does not allow its milestone to generate another coupon.

Each call generates at most one coupon. Concurrent calls can each succeed when
**different** backlog milestones are eligible; they cannot both reward the same
milestone. Retrying admin generation can issue the next eligible milestone,
so use `GET /admin/coupons` to inspect issuance after a lost response.

## Report

Example on a fresh database:

```json
{
  "currency": "INR",
  "totalSuccessfullyPlacedOrders": 0,
  "purchasedQuantityByProduct": [
    { "productId": "coffee", "quantity": 0 },
    { "productId": "lamp", "quantity": 0 },
    { "productId": "mug", "quantity": 0 },
    { "productId": "notebook", "quantity": 0 },
    { "productId": "sticker", "quantity": 0 }
  ],
  "grossRevenueMinor": "0",
  "totalDiscountsMinor": "0",
  "netRevenueMinor": "0",
  "coupons": { "generated": 0, "available": 0, "redeemed": 0 },
  "rewards": { "every": 5, "discountPercent": 10, "unrewardedMilestones": 0 }
}
```

Gross revenue is the sum of order subtotals. Discounts are the sum of stored
order discounts. Net revenue is the sum of order totals and equals gross minus
discounts. Purchased quantities sum immutable order lines, including products
with zero purchases. Available coupons = generated minus redeemed. The report
reads one consistent database snapshot. Repeated reads do not change data, but
naturally can differ if another client commits an operation between them.

## Manual example

These commands use POSIX shell quoting; on Windows use a Bash terminal or run the
platform-independent `npm run demo` instead. Replace `CART_ID` with the ID from
the first response. Use an unused key if repeating this example with a new cart.

```sh
curl -i -X POST http://127.0.0.1:3000/carts \
  -H 'Content-Type: application/json' -d '{}'

curl -i -X POST http://127.0.0.1:3000/carts/CART_ID/items \
  -H 'Content-Type: application/json' \
  -d '{"productId":"mug","quantity":2}'

curl -i -X POST http://127.0.0.1:3000/carts/CART_ID/checkout \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: manual-checkout-1' -d '{}'
```

Run the last command again unchanged: status becomes 200 and the order body is
identical. Then inspect `GET /admin/report` and `GET /products` to verify that
only two mugs were purchased and deducted.
