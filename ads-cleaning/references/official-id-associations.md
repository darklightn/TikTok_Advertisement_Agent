# Official-ID association scope

`config/official-id-associations-v1.json` is the machine-readable association boundary. This reference describes usage limits.

- `verified` means exact official IDs have a non-empty real-data overlap for both cross-border and local samples.
- `partial` means the official ID path exists, but the current evidence does not close every shop-type or overlap gate.
- `blocked` means no defensible direct official-ID relation exists at the claimed grain.

The verified minimum chain is product `shop_id + product_id` to inventory, then inventory `shop_id + sku_id` to order lines. This supports catalog, stock, and shop-order context. It does not attribute orders to advertising.

Returns/refunds join to order lines through official `shop_id + order_id`.

Advertising product facts join to product performance through official `shop_id + product_id`. Unmatched official IDs remain unmatched; never replace the official join with a product-name fallback.

The independent campaign-product creative fact may join to campaign-product performance through official shop, advertiser, campaign and product identity. This verifies identity only; comparing interval metrics still requires exact date-range and currency compatibility.

Never join advertising facts directly to shop orders. No verified official record contains both order identity and advertiser, campaign, post, or creative identity. The capability is `verified_unavailable` within the frozen source boundary, while the direct association remains `blocked`. A product/SKU/time context path must not be presented as order attribution.

Shop-wide creative-to-campaign linkage also remains `blocked`; no verified official relation supplies campaign identity for those rows.
