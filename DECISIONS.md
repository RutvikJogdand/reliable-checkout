# Design decisions

This file is developed alongside the implementation. The original assignment is
in `docs/ASSIGNMENT.md`.

## Invariants to enforce

1. Inventory never becomes negative.
2. One cart produces at most one committed order.
3. A successful checkout key identifies one cart/coupon request and one order.
4. One coupon belongs to at most one committed order.
5. A failed checkout changes neither inventory, orders, nor coupon availability.
6. One eligible global order milestone produces at most one coupon.
7. Historic order amounts and purchased product details do not follow later catalog changes.
8. Money is exact, discounts are bounded, and net equals gross minus discounts.
9. Reports describe committed state and never create or redeem coupons.

## Initial implementation scope

Node.js 24, plain JavaScript ES modules, built-in HTTP server, SQLite, built-in
test runner. No frontend or real payment integration. Complete decisions and
tested evidence will be added as the service develops.
