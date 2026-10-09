# Shop promotion performance

Read this reference only for `shop_promotion_performance`. Accept only a successful shop-owned Manifest with a byte-preserved official XLSX whose two banner rows and exact 14-column header match the versioned contract.

The fact grain is one official product detail source row for the exact requested interval. The export exposes no promotion ID, and product ID or activity name cannot safely identify a row. Preserve every official row and use immutable source-row identity for `record_key`; do not merge or deduplicate rows.

Validate that the date banner starts on the requested start date and ends at midnight on the day after the requested inclusive end date. Record both banner values and the promotion-tool filter in QA. The activity-time column describes the promotion lifecycle, not the metric interval. Split it into local start and end wall times and pair them with the Manifest business timezone; do not invent UTC timestamps.

The current official headers explicitly identify PHP with `₱`; output `currency=PHP`. Preserve blank promotion type, AOV, ROI, and average GMV per customer as null. Preserve the official AOV, ROI, average discount rate, and average GMV per customer as non-additive metrics instead of recomputing them.

This is a shop-owned fact, so cleaned rows leave advertiser identity empty. Product ID may support a governed shop-product join for later diagnosis, but the report does not prove advertising attribution. Do not add campaign, creative, or ad conclusions in the cleaning layer.
