# Affiliate creator performance

Read this reference only for `affiliate_center_performance`. Accept only a successful authoritative Manifest whose file is marked `generated_file: false` and `file_kind: official_export`.

The fact grain is one shop x creator name observed x exact requested interval x currency. The official workbook exposes creator name but no stable creator ID, so `creator_name_observed` is the only available within-report identity and must not be presented as a durable cross-system creator ID.

The first physical row after the header is an official field-definition row with an empty creator cell. Retain its canonical hash in QA and exclude it from facts. Require exactly one such row at source row 2. Every other row must have a creator name, one consistent money currency, and the current 22-column authoritative Schema.

Preserve official GMV components, refunds, attributed orders and units, official average order value, conversion and click rates, content counts, impressions, views, and estimated commission. Identify the complete 22-column header exactly, independently of request dates. `affiliate_daily_average_v1` writes `商品橱窗日均添加商品数`, `日均客户数`, and `日均商品成交件数` only to the three daily-average fields. `affiliate_interval_total_v2` writes `已添加到商品橱窗的商品数`, `客户数`, and `商品销量` only to the three interval-total fields. The other field group remains empty; no conversion between the two meanings is allowed. Unknown complete headers are isolated and reported, never inferred from date shape. Do not add creator rankings, diagnoses, or action recommendations in the cleaning layer.
