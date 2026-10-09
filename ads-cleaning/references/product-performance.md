# Product analytics model

Read this reference only for `product_analytics_performance` after the locator returns a successful authoritative Manifest.

- Output dataset: `product_performance_interval`.
- Grain: one shop, product, exact requested interval, and currency.
- The official workbook has three logical header rows: requested date, channel group, and metric. The channel group and metric rows must match the independent 176-column baseline exactly.
- The date in the first header row must exactly equal the Manifest request range.
- All 176 official columns are mapped to stable semantic fields. Channel sections use explicit prefixes such as `merchant_live_`, `merchant_video_`, `affiliate_`, `affiliate_live_`, `affiliate_video_`, and `merchant_product_card_`.
- The field dictionary records each semantic field's source position, original channel group, original official header, and type. Repeated metric labels are never merged without the channel-group identity.
- Money symbols are converted only through an explicit allowlist (`₱` to `PHP`, `$` to `USD`). Mixed or unknown currencies fail closed.
- Percentage cells are stored as decimal rates. Official ratio fields remain non-additive.
