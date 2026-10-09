# Returns and refunds snapshot

Read this reference only for `returns_refunds_snapshot` after the locator returns a successful authoritative Manifest.

- Output dataset: `returns_refunds_snapshot_fact`.
- Grain: one shop x after-sales case x capture time.
- `after_sale_id` is the stable case identity; `order_id` is retained for joining to order operations.
- `captured_at` must exactly equal the report Manifest value.
- Currency is parsed from the official refund-amount symbol in each row and must be internally consistent.
- The official source column `订单实付` currently contains payment-state text, so it maps to `order_payment_status`; do not reinterpret it as an amount.
- Empty logistics state and time are valid before a return enters logistics.
