# Order cleaning

Read this reference only after `manage_orders_csv` is located from an authoritative Manifest.

- One official CSV row is one order line, keyed by Order ID, SKU ID, Seller SKU and optional Package ID plus the shop/report/currency domain. Local-shop rows may omit Package ID; null remains an explicit key component and is never replaced with a guessed value.
- Emit `order_line_operations.csv` for operational and analytical fields.
- Emit `order_fulfillment_detail.csv` for buyer, recipient, contact, address, message and seller-note fields. It is a normal cleaned dataset; visibility and permissions are downstream presentation concerns, not a separate cleaning contract.
- The local-shop 65-column variant appends eight tax-invoice fields. All eight stay only in `order_fulfillment_detail.csv`; the cross-border 57-column variant remains supported without synthetic columns.
- Both outputs retain the same `source_row_key` so one source row can be traced across the split. Uniqueness is enforced within each logical dataset. The order-line fact preserves every official row; order-level amounts must be deduplicated by order before aggregation.
- Read currency only from the report Manifest. Require `currency_scope=shop_commerce`; never infer it from the shop alias, country or advertiser currency.
- Preserve official CSV bytes and reject header drift, malformed rows, formulas, invalid types, duplicate business keys and Created Time values outside the requested range.
- Treat official order datetimes as local wall times in `shop.business_timezone`. Preserve the wall-clock value, carry the IANA timezone on every cleaned row, and do not convert it to UTC without an authoritative offset-aware source value.
