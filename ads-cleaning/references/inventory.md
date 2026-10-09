# Inventory snapshot model

Read this reference only for `inventory_snapshot` after the locator returns a successful authoritative Manifest.

- Output dataset: `inventory_snapshot_fact`.
- Grain: one shop, SKU, and capture time. The official source quantities and demand fields are SKU-level aggregates across the observed warehouses; `warehouse_names_observed` is context and is not a warehouse-grain fact.
- `captured_at` is a request-time snapshot identity. It must exactly match `report.captured_at` in the export Manifest.
- `captured_at` must be an offset-aware UTC instant ending in normalized `Z`; the request date remains a shop-business-calendar label and is not the snapshot instant.
- The report is shop-owned. `advertiser_id` and `advertiser_name` are optional context and are not part of its key.
- `days_of_supply_official` remains a string because the official source may contain bounded values such as `>60`.
- `days_of_supply_calculated = available_stock * 30 / sales_30d`, at SKU snapshot grain and six decimal places. It is null when `sales_30d = 0`; it is not substituted for the official value.
- `inventory_status_raw` preserves the official raw status enum. `inventory_status_calculated` is explicitly labeled as the export calculation: out of stock when available stock is zero, attention when official days starts with `<` or recommended replenishment is positive, otherwise sufficient.
- Header-only files are valid empty snapshots. Unknown headers, formulas, duplicate keys, missing SKU identity, hash changes, or capture-time mismatches fail closed.
- Do not reinterpret recent-30-day sales or future-30-day forecast as the user's requested historical range.
