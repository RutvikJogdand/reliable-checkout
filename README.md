# Reliable Checkout and Rewards

A Node.js backend for carts, transactional checkout, single-use coupons and
reconciled reporting. It uses plain JavaScript, SQLite and Node's built-in HTTP
server and test runner. There are no third-party runtime dependencies, private
services or credentials.

## Run it

Use **Node.js 24.x**. Development and verification used **v24.19.0**. The supported
major is deliberately bounded in `package.json`; Node 18/20 will not run this
project. The built-in SQLite API was marked active development in Node 24.0 and
some Node 24 versions may print an experimental warning.

From the extracted `reliable-checkout` directory:

```sh
node --version
npm ci
npm test
npm run demo
npm start
```

`npm ci` needs no dependency downloads because this project has none. The service
listens at `http://127.0.0.1:3000`. Open `http://127.0.0.1:3000/products` to inspect
the catalog. `npm run demo` starts and stops its own server and fresh in-memory
database; it does not require `npm start` and does not change saved service data.

The first service start automatically creates `data/checkout.sqlite`, schema
version 1, and five products. Later starts preserve existing stock, carts,
orders, coupons and checkout keys. Stop with Ctrl+C.

Optional configuration: copy `.env.example` to `.env`, then edit it. On Windows
PowerShell use `Copy-Item .env.example .env`; on macOS/Linux use
`cp .env.example .env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address; local-only by default |
| `PORT` | `3000` | Integer from 1 to 65535 |
| `DB_PATH` | `./data/checkout.sqlite` | SQLite file relative to the working directory |
| `REWARD_EVERY` | `5` | Positive whole number `n`, up to 1,000,000 |
| `DISCOUNT_PERCENT` | `10` | Whole-number percentage `x`, from 1 to 100 |

Reward settings are persisted. Restarting an existing database with different
reward settings fails clearly instead of reinterpreting old milestones. To try
a different configuration, use a new database filename. This also gives a fresh
seeded dataset without deleting the existing one.

## What to inspect

| File | Purpose |
| --- | --- |
| [docs/API.md](docs/API.md) | Every endpoint, body, response, status and important error |
| [DECISIONS.md](DECISIONS.md) | Invariants, ambiguities, alternatives, trade-offs and AI disclosure |
| [docs/LEARNING_GUIDE.md](docs/LEARNING_GUIDE.md) | Guided reading, checkout walkthrough and interview exercises |
| [docs/SUBMISSION_CHECKLIST.md](docs/SUBMISSION_CHECKLIST.md) | Remaining candidate review and repository publication steps |
| [src/service.js](src/service.js) | Business rules; start at `checkout()` |
| [src/database.js](src/database.js) | Transaction boundary, initialization and seed |
| [src/schema.sql](src/schema.sql) | Database constraints and relationships |
| [src/http.js](src/http.js) | Routing, JSON and error responses |
| [src/money.js](src/money.js) | Exact calculations and rounding |
| [test/concurrency.test.js](test/concurrency.test.js) | Real HTTP requests to two independent server workers sharing one database |

## API overview

All routes use JSON. All money fields are **decimal strings containing integer
paise**, e.g. `"34900"` means INR 349.00. Quantities and percentages are JSON
numbers. For checkout, send a client-generated `Idempotency-Key`; use the same
key and body on a retry.

| Method and path | Success | Purpose |
| --- | --- | --- |
| `GET /health` | 200 | Process liveness |
| `GET /products` | 200 | Catalog and current available stock |
| `POST /carts` | 201 | Create an empty cart |
| `GET /carts/:cartId` | 200 | Cart, prices and totals |
| `POST /carts/:cartId/items` | 201 | Add a distinct product |
| `PATCH /carts/:cartId/items/:productId` | 200 | Set an item's absolute quantity |
| `DELETE /carts/:cartId/items/:productId` | 200 | Remove an item |
| `POST /carts/:cartId/checkout` | 201; 200 on replay | Place or recover an order |
| `GET /orders/:orderId` | 200 | Historical order snapshot |
| `PATCH /admin/products/:productId` | 200 | **Admin:** change price, name or available stock |
| `POST /admin/coupons` | 201 | **Admin:** generate one eligible coupon |
| `GET /admin/coupons` | 200 | **Admin:** list generated coupons and redemption state |
| `GET /admin/orders` | 200 | **Admin:** list orders for reconciliation |
| `GET /admin/report` | 200 | **Admin:** read-only summary |

Authentication is intentionally omitted as allowed by the assignment. `/admin/*`
routes are administrative by contract, not access-controlled in this exercise.

## Behavior worth testing

- Carts do not reserve inventory. Checkout uses current prices and revalidates
  stock inside a write transaction.
- An order saves purchased product names, prices, quantities and totals.
- A successful key replays the same order after a restart. A different key
  cannot check out the same cart again. Reusing a successful key for another
  cart or coupon returns a conflict.
- Every fifth successful order makes a milestone eligible by default; an admin
  explicitly generates the oldest eligible, unrewarded coupon. A milestone
  does not disappear when the total order count moves past it.
- Coupon redemption, stock changes, order lines and the successful retry key
  commit together. Failures roll back together.
- A coupon is valid for any one later checkout. It does not expire, does not
  stack, and applies to the entire subtotal. Successful discounted and zero-net
  orders count toward future milestones.
- Discounts round once at order level, half up to the nearest paise.
- Reports use a single read snapshot and never generate coupons.

The suite has 20 focused tests. It includes twelve buyers competing for the last
unit, sixteen simultaneous retries, competing coupon generation/redemption,
same-cart and same-key conflicts, lock timeout/retry, restart persistence,
historical pricing, exact money, report reconciliation, and database failures
after partial checkout writes. The concurrency tests use separate event loops
and SQLite connections; they do not rely only on one Node.js event loop.

## Scope and submission status

The required backend behavior, tests, API documentation, design decisions and
incremental local Git history are implemented. Real payments, authentication,
customer-specific rewards, distributed deployment, pagination and a frontend
are intentionally deferred; see `DECISIONS.md`.

This is an AI-assisted first implementation. Candidate code review, learning,
personal explanation of the decisions, and publication to a candidate-owned
Git repository remain. No remote repository has been created or pushed.

Approximate initial AI-assisted implementation, testing and documentation time:
**30 minutes** in the 19 October 2026 working session. Candidate study and
independent review have not been measured or completed; add that time before
submission. See `docs/SUBMISSION_CHECKLIST.md`.

## Primary references

- [Node.js 24 SQLite API](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html)
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite isolation](https://www.sqlite.org/isolation.html)
