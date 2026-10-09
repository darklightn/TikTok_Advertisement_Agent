# Diagnosis-ready cleaning contract

This contract constrains cleaned facts for later advertising analysis. It does not contain good/bad thresholds, cause inference, recommendations, or actions.

## Identity

- `shop_id` is the stable Seller identity from the export Manifest; `shop_alias` is descriptive only.
- Advertiser facts use `advertiser_id`; campaign, product, SKU, video, order and after-sale identities remain separate columns.
- `record_key` is the only composite machine key. Its component columns remain visible in the same row.

## Currency

- Every monetary fact carries `currency` and `currency_scope`.
- Non-monetary facts omit `currency` and `currency_scope`; they are not emitted as permanently empty business columns.
- Advertising money uses `currency_scope=advertiser`; commerce money uses `currency_scope=shop_commerce`.
- Cross-scope or cross-currency arithmetic is forbidden without explicit FX evidence. No exchange rate is inferred.

## Time

- `captured_at` and API epoch timestamps ending in `Z` are UTC instants.
- `metric_date`, `metric_hour`, requested intervals and order CSV datetimes retain the official report's business-time representation.
- Until the export Manifest contains authoritative market timezone evidence, a naive local datetime must not be converted to UTC or joined to UTC timestamps as the same instant.
- Interval reports remain interval facts; they are never expanded into daily facts.

## Materialized objective metrics

Only deterministic, high-frequency advertising metrics are materialized. Division results use decimal arithmetic and six decimal places.

| Metric | Formula | Zero denominator |
|---|---|---|
| `revenue_per_sku_order_calculated` | `gross_revenue / sku_orders` | null |
| `cpc_calculated` | `cost / product_ad_clicks` | null |
| `cpm_calculated` | `cost * 1000 / product_ad_impressions` | null |

Where the official report already provides a ratio with the required scope, the cleaned business table keeps the official value and does not materialize a duplicate calculation, difference, or comparison status. Any later reconciliation belongs in QA and must first prove that the formula and attribution scope are identical before defining a rounding tolerance.

`revenue_per_sku_order_calculated` is revenue per official SKU order. It is not labeled as customer-order AOV because `sku_orders` is not proven to be a distinct customer-order count.

## Aggregation

- Additive facts may be summed only within the same dataset grain, identity, time scope and currency scope.
- Official ratios and derived ratios are not summed or averaged row by row; derived ratios are recomputed from their additive numerator and denominator.
- In `order_line_operations`, `order_amount` is an order-level repeated field. After its within-order consistency check, deduplicate it by `shop_id + order_id + currency` before aggregation.
- `order_refund_amount` is line-additive. Sum it across the preserved official order-line rows; do not deduplicate it as an order-level amount.
