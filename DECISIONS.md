# Design decisions

The assignment prioritizes correctness under retries and overlapping requests.
This solution concentrates on transactions, explicit semantics, durable checkout
replay, and tests of competing operations. The original brief is preserved in
`docs/ASSIGNMENT.md`.

## Invariants and enforcement

| Invariant | Enforcement | Evidence |
| --- | --- | --- |
| Inventory never becomes negative | `BEGIN IMMEDIATE`, conditional decrement, database CHECK | Twelve buyers compete for the final unit |
| A cart produces at most one committed order | Open-cart check and `UNIQUE(orders.cart_id)` | Same cart, different keys, two workers |
| A successful key identifies one request and one order | Canonical cart/coupon fingerprint and `UNIQUE(orders.idempotency_key)` | Simultaneous retries, conflicting payloads, restart |
| A coupon belongs to at most one committed order | Redemption check and `UNIQUE(orders.coupon_code)` | Competing coupon redemptions |
| Failed checkout leaves no partial purchase effects | One transaction covering stock, order, lines and key | Injected failures after writes, including automatic rollback |
| A milestone generates at most one coupon | Serialized eligibility check and `UNIQUE(coupons.milestone)` | Competing generation, delayed backlog |
| Historical purchases do not follow catalog changes | Snapshot names, prices, quantities, discounts and totals | Price/name changes after checkout |
| Amounts are exact and total is nonnegative | Integer minor units, BigInt arithmetic, bounded percentage, SQL CHECKs | Half-paise and 100% discount cases |
| Reports reconcile and do not mutate domain state | Read transaction over orders/lines/coupons | Independent reconciliation and repeat reads |

Constraints are backstops, not a claim that arbitrary manual SQL cannot corrupt
all business relationships. Milestone eligibility, for example, is enforced by
the service transaction rather than a simple row CHECK.

## Decision 1: Persistent SQLite and a small Node.js stack

**Context:** Persistence, concurrency and repeatable setup matter more than
framework breadth within a 4–6 hour timebox.

**Options considered:** In-memory maps plus a mutex; PostgreSQL with a pool;
SQLite with a third-party driver; Node.js 24's built-in SQLite. Express or
Fastify could replace the small HTTP adapter.

**Choice:** Plain JavaScript ES modules, Node.js 24, built-in SQLite/HTTP/test
runner, and a local SQLite file. No ORM or runtime packages.

**Why:** A real database provides durable transactions and constraints without
another service or native dependency installation. The route table is small
enough to keep readable and test protocol handling directly.

**Consequences:** The synchronous SQLite interface blocks a worker while it
executes or waits for a lock. Node 24.0 documents this API as active development;
the supported major is bounded and the tested version recorded. This is a
deliberate assignment trade-off, not a high-throughput server architecture.
Initialization seeds once; restart does not replenish stock.

## Decision 2: Acquire the write transaction before reading mutable state

**Context:** Reading stock/coupon availability and later writing without a shared
transaction permits two buyers to act on the same stale information.

**Options considered:** Check-then-write without a transaction; a process-local
JavaScript mutex; deferred SQLite transactions; `BEGIN IMMEDIATE`.

**Choice:** Every mutation runs synchronously inside `BEGIN IMMEDIATE`. Checkout
checks the replay key, cart, inventory and coupon, writes all purchase effects,
then commits. No external call or `await` occurs inside the callback.

**Why:** SQLite coordinates writers across connections. Once the write
transaction begins, another writer cannot change facts between our checks and
commit. Conditional stock updates and uniqueness constraints add defense.

**Consequences:** Unrelated writes serialize, limiting throughput. The default
busy timeout is two seconds; lock exhaustion returns 503 and `Retry-After: 1`.
Multi-query reads use explicit read transactions so their results share a
snapshot. WAL lets readers see committed snapshots while a writer is active;
it does not create multiple simultaneous writers. `synchronous=FULL` requests
SQLite's stronger commit durability behavior. Durability still depends on the
filesystem/storage honoring flushes.

The helper rolls back only when `db.isTransaction` is still true because SQLite
can roll back automatically. Commit occurs before sending success. A process
failure before commit leaves an uncommitted transaction for SQLite to recover;
failure after commit leaves a saved key for replay. Restart replay is tested;
arbitrary power-loss recovery is not fault-tested here.

## Decision 3: Store successful checkout idempotency with the order

**Context:** A timeout does not tell the client whether checkout committed. Cart
uniqueness alone does not define retry responses or detect key reuse elsewhere.

**Options considered:** Cart uniqueness only; an in-memory response cache;
a separate pending/completed attempt table; key/request identity on the order.

**Choice:** Require `Idempotency-Key`. Store it with fixed-order JSON encoding
of `[cartId, couponCodeOrNull]` on the order. Same-request replay returns the
original order with 200; first success returns 201. Changed identity returns
409. A new key for a purchased cart returns 409 with the original order ID.

**Why:** The order is already the durable successful result. Key and purchase
effects share one commit, eliminating a crash gap between them. The fingerprint
is a small canonical equality-comparison string, not a security hash. Replay
lookup precedes used-cart and used-coupon checks.

**Consequences:** Keys are global and kept indefinitely; authenticated scopes
and retention are deferred. Failed attempts are not cached and do not bind the
key. Editing a still-open cart after failure is allowed. Contents and live
prices are not fingerprinted; the first successful checkout freezes them.
Transport retries should preserve the same key/body. The design ensures
at-most-once committed purchase effects, not guaranteed response delivery.

## Decision 4: Derive checked-out and redeemed state from orders

**Context:** Separate cart/coupon status flags and order records duplicate facts
and add opportunities for disagreement.

**Options considered:** Mutable status flags on each resource; derive usage from
the successful order relationship.

**Choice:** A unique `orders.cart_id` closes a cart. A unique non-null
`orders.coupon_code` redeems a coupon. Availability/status views are derived.
Multiple NULL coupon values are permitted, so orders can omit coupons.

**Why:** One authoritative row represents the purchase and coupon use. If order
creation rolls back, redemption also rolls back automatically.

**Consequences:** Some views require joins or existence checks. There is no
cancellation, refund or coupon restoration lifecycle. Those features need new
states/events and accounting decisions instead of deleting orders. There are
no delete-order or delete-coupon APIs.

## Decision 5: Live prices, no reservations, immutable purchase snapshots

**Context:** Price and availability changes between adding an item and checkout
are unspecified in the brief.

**Options considered:** Lock prices at add time; expiring quotes/reservations;
use the catalog at checkout.

**Choice:** Adding/updating validates stock but reserves nothing. Open cart views
show live prices and stock. Checkout reads them again inside its transaction,
uses the current price, and fails the whole purchase if stock is insufficient.
Orders snapshot product ID/name, unit price, quantity, line total, currency,
coupon percentage and aggregate amounts.

**Why:** Reservations and price confirmation are not required. The explicit
policy avoids abandoned-cart expiry machinery within the timebox.

**Consequences:** A price can rise between viewing and checkout. A production
customer flow should usually introduce a quote/version and acceptance of price
changes. Historical orders and checked-out cart views retain the snapshot.
Administrative inventory updates set absolute available stock and serialize
with checkout.

## Decision 6: Global, explicit, oldest-first coupon generation

**Context:** The brief leaves ownership, backlog, expiry and stacking unspecified.

**Options considered:** Per-customer rewards; automatic issuance on each nth
checkout; admin-triggered global milestones; generation only when the current
order count is exactly divisible by n.

**Choice:** Count all committed successful orders globally. Milestones are
`n, 2n, 3n, ...`. Each admin call generates one coupon for the oldest eligible
unrewarded milestone. The next milestone is `MAX(generated milestone) + n`, or n
initially, checked against the committed order count in the same transaction.

**Why:** Passing the nth order must not erase eligibility. With n=5 and 12 orders,
two calls generate milestones 5 and 10. The serialized check/insert prevents
duplicate rewards for the same milestone.

**Consequences and selected semantics:**

- Coupons are globally redeemable bearer codes, not customer-owned.
- One coupon per order, applying to the whole subtotal. No stacking, expiry,
  minimum spend or product restrictions.
- A generated coupon is available for a later checkout. The qualifying order
  has already committed and cannot use its own not-yet-generated coupon.
- Discounted, zero-price and zero-net successful orders count toward milestones.
  A coupon on a zero subtotal is consumed. Rewards-abuse prevention is deferred.
- Failures, reads and replays never increase the successful order count.
- Concurrent admin calls can each succeed for different backlog milestones.
  Admin generation is not idempotent by request key: a lost-response retry can
  generate the next eligible milestone. Inspect `GET /admin/coupons` after an
  uncertain response. A separate issuance key would be an extension.
- `n` is an integer from 1 to 1,000,000; `x` is a whole percent from 1 to 100.
  Settings are persisted and must match on restart. Coupons snapshot their rate.
  Changing the reward program needs a migration or a new database.

## Decision 7: Exact integer money and one order-level rounding operation

**Context:** Floating-point decimal currency arithmetic can produce rounding
errors; cumulative reports can exceed safe numeric JSON ranges.

**Options considered:** Floating-point rupees with `toFixed`; a decimal library;
integer minor units using Number only; integer minor units with BigInt.

**Choice:** INR only; one unit is one paise. Persist integer amounts in SQLite,
calculate with BigInt and return money as decimal integer strings.

**Why:** Exact integer operations and explicit rounding are reproducible and need
no dependency. Strings serialize values that JSON Number could lose precision on.

**Rule:** For nonnegative subtotal S and whole percent P:

```js
const discount = (S * BigInt(P) + 50n) / 100n;
const total = S - discount;
```

BigInt division truncates here. Adding 50 implements half-up rounding for these
nonnegative amounts. Example: 105 paise at 10% gives 11 discount and 94 payable.
Two such units have subtotal 210 and discount 21, not 22: round once for the
complete order, not per line/unit.

**Consequences:** Clients format paise strings for display. Unit prices are capped
at 1,000,000,000 paise, quantity at 1,000, distinct lines at 100, and subtotal at
100,000,000,000,000 paise. Individual stored amounts fit both SQLite INTEGER and
JavaScript's safe integer range. Revenue aggregates use BigInt rather than
SQLite SUM for money. Rates above 100% are rejected, so totals cannot become
negative. Tax, shipping, other currencies and fractional-percent rates are absent.

## Decision 8: Derive reports from committed purchases

**Context:** Reports must reconcile with orders and coupons without generating
rewards or counting failed attempts.

**Options considered:** Increment aggregate counters; compute from orders;
maintain an asynchronous reporting projection.

**Choice:** One read transaction scans committed order totals, sums purchased
quantities from order lines, and counts coupon/order relationships. Products
with no purchases appear with zero quantity; IDs define product aggregation.

**Why:** Every reported amount can be reproduced from returned orders. A single
snapshot prevents mixed-time counts within a report during concurrent commits.

**Consequences:** Report work grows with the data. Order listing is unpaginated
and performs extra item queries. Stable pagination, indexed query plans and
reporting projections are future work after measuring actual volume.

## Decision 9: Explicit errors; commit represents payment success

**Context:** Clients need distinct input, resource, conflict and transient errors.
No real payment integration is required.

**Options considered:** Generic errors; HTTP status alone; stable domain codes.
For payments: real/fake gateway calls or committed order placement as success.

**Choice:** JSON `{error: {code, message, details?}}`; statuses 400, 404, 409, 422,
413, 415, 405, 503 and 500 are documented in `docs/API.md`. Commit means payment
success for this exercise. No gateway or random fake-payment failure is added.

**Why:** Codes distinguish stock, coupon and retry conflicts. Actual database
failure injection exercises rollback without an unnecessary payment abstraction.
Internal errors are logged; responses omit SQL/stack details.

**Consequences:** The design cannot roll back an external charge. Real payments
need a pending/payment/placed lifecycle, provider idempotency, durable event or
webhook handling, compensation and reconciliation. Network calls must not be
awaited inside the current synchronous database transaction.

## Implemented and intentionally deferred

Implemented: all required routes, five seed products (lamp stock is one), input
checks, persistent schema/seed initialization, atomic checkout, durable replay,
historical snapshots, coupon backlog, single-use redemption, reconciled reports,
meaningful commits, API examples and 20 tests. Admin catalog updates make
price/stock changes reproducible through the API.

Deferred: auth/authorization; real payments; accounts; quote acceptance and
reservations; refunds/cancellations; coupon ownership/expiry; idempotency on
non-checkout writes; reward-program changes; pagination; rate limits; OpenAPI;
frontend; backup/restore drills; observability beyond logs; migration tooling
beyond schema v1; distributed deployment and high-volume load testing. Graceful
shutdown and body limits exist; public deployment hardening is outside scope.

## Evolution to multiple instances and production scale

The two-worker tests use independent event loops and SQLite connections sharing
one local file. The database coordinates them. This demonstrates cross-connection
correctness, not safe SQLite WAL sharing over network filesystems or independent
database copies per host.

For multiple machines, move to PostgreSQL with a connection pool. Keep the
uniqueness and nonnegative inventory constraints. Acquire affected product rows
in stable order to reduce deadlocks, lock or conditionally update coupon state,
and perform all checks/writes in one transaction. Handle uniqueness conflicts
and deadlock/serialization failures explicitly with bounded same-key retries.
Add authenticated idempotency scopes and retention policies.

Global milestone counting also needs serialization: an atomic committed-order
counter/reward ledger inside placement can replace a full count. A database
sequence is not a successful-order count; aborted transactions can leave gaps.
If issuance becomes asynchronous, use a transactional outbox and unique milestone
ledger so delivery retries cannot duplicate rewards. The global counter may
itself become a bottleneck; measure before adding complexity.

Use the production database's appropriate read isolation for multi-query reports.
Keep snapshot pricing. Introduce a quote/version if customers must confirm price
changes. Real payments need the separate lifecycle above, not another `await`
inserted into the current checkout transaction.

## AI use and a concrete correction

ChatGPT/Codex helped interpret the brief, choose the architecture, write the
service/tests/docs and execute verification. Validation included HTTP calls,
separate SQLite connections, restart tests and injected SQL failures. No private
transcripts are included.

**Correction during AI-assisted review:** The initial generated transaction
helper unconditionally called `ROLLBACK` in its catch block. Review identified
that SQLite may already have rolled back. A regression test used
`RAISE(ROLLBACK, 'original automatic rollback failure')`. The original code
failed by replacing that error with `cannot rollback - no transaction is active`.
The helper now checks `db.isTransaction` first. The test passed after the fix,
also verifying unchanged stock, no order and a usable connection for retry.
This is a separate Git commit after implementation and concurrency tests.

The correction was made within AI-assisted work; it is not claimed as a
candidate-discovered bug. Candidate independent review and explanation remain
before submission. The learning guide provides an exercise to reproduce it.

## If given another two hours

1. First examine event-loop delay and lock waits under realistic contention;
   test controlled shutdown/termination during writes. Check whether the
   synchronous driver produces unacceptable latency.
2. Review price-change semantics with a quote/version if customer confirmation
   is required, then test the agreed conflict behavior.
3. Add paginated order/coupon listing and a small CI job for the existing suite.
   Inspect query plans/report latency before introducing cached counters.

Before submission, prioritize candidate understanding over optional features:
trace checkout, predict the race outcomes, reproduce the rollback correction,
and make one deliberate business-rule change with an appropriate test.

## Primary references

- [Node.js 24 SQLite API](https://nodejs.org/download/release/v24.0.0/docs/api/sqlite.html)
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite isolation](https://www.sqlite.org/isolation.html)
