# Product and SKU commercial-status model

Read this reference for `shop_product_commercial_status_snapshot` after an authoritative Manifest locates a successful source snapshot.

One immutable Seller Center source file produces two datasets:

- `shop_product_commercial_status_snapshot`: one shop × product × UTC capture instant.
- `shop_sku_commercial_status_snapshot`: one shop × SKU × UTC capture instant.

The parser requires the complete observed lifecycle-tab set (`all`, `delisted`, `draft`, `deleted`), exact product totals, complete SKU expansion, and unique product/SKU identity. Raw status enums are preserved; `listing_status_observed` is the official UI tab observed during collection and is not an inferred enum label.

Prices are nullable for lifecycle states such as drafts. Any row carrying a list, sale, or promotion price must also carry currency. `effective_price_calculated` uses promotion price when present and otherwise sale price. Multiple promotions remain canonical JSON arrays with official IDs, observed names, and SKU-level official schedules.

The model does not create current seller discount, platform discount, or coupon fields because this source does not expose them. Realized discounts remain in order-line facts. Product-management stock quantities are intentionally absent from both cleaned datasets; `inventory_snapshot_fact` remains the sole inventory owner.
