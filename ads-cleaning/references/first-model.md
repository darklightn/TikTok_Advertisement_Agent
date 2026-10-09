# First cleaning model

Read this reference only for the first three advertising report families. The machine contract is `config/first-model-v1.json`.

## Logical datasets and grain

Use five logical advertising fact datasets, not a fixed count of source Excel files. A GMV Max campaign-product export may contain one workbook per campaign; all eligible campaign workbooks map into the same logical dataset and remain separated by `campaign_id`. `gmvmax_campaign_overview` has two incompatible grains:

1. `gmvmax_ad_performance_daily`: advertiser × date × currency. Select only when the first source header is `按天`.
2. `gmvmax_ad_performance_hourly`: advertiser × hour × currency. Select only when the first source header is `时间` and every detail timestamp is hour-aligned.
3. `gmvmax_campaign_product_interval`: advertiser × campaign × product × exact requested interval × currency. Obtain `campaign_id` from file-level Manifest metadata, never from the published filename or campaign name.
4. `creative_product_interval`: advertiser × video × product × exact requested interval × currency. `Time posted` is the video's publication date. It is not a metric date and must not be used to split interval metrics.
5. `gmvmax_campaign_product_creative_interval`: advertiser × campaign × product × creative record × exact requested interval × currency. Campaign and product identity come only from each file's Manifest. Video rows use official `Post ID`; the official product-card row has `Post ID=N/A`, which is normalized to null and remains uniquely identified by campaign, product and `Creative type`.

Keep IDs as strings. Keep official ratios in `*_official` fields. Do not replace them with recalculated values; later stages may add separately named derived metrics.

Cleaned files are machine interchange artifacts, not human-facing reports. Do not add shortened hashes or display labels for readability. Keep the full `record_key` for deterministic identity; human presentation belongs to later Feishu views.

## Identity and relationships

For cross-report association scope, read `official-id-associations.md` and `config/official-id-associations-v1.json`. Those files define verified, partial, and blocked links without changing fact-table grain.

- Resolve shop, provider, advertiser, requested interval, report, file and campaign identity from the qualified export Manifest.
- Treat names and usernames as observed attributes, not keys.
- Do not attach a shop-wide creative row to a GMV Max campaign. Only the independently exported campaign-product creative dataset carries the official campaign and product task context needed for that relationship.
- Do not combine daily and hourly rows in one table, even with a grain flag. Separate tables prevent silent mixed-grain aggregation in Feishu.
- Include interval boundaries in campaign-product and creative keys because their metrics summarize the requested range rather than one day.

## Source-field disposition

All 7 overview columns, 8 campaign-product columns, 23 shop-wide creative columns and 23 campaign-product creative columns are mapped in the machine contract. Metadata fields come from Manifest or cleaning runtime. The parser fails on missing expected headers and reports any new header as `unknown`; it does not silently discard it.

`Video title` is nullable. Video identity remains `video_id`; an empty title is not an identity failure.

The overview row whose first cell is `-` is an official summary row. Exclude it from facts and retain it in QA evidence. Reconcile `Cost`, order count and gross revenue as additive totals using only the configured report/currency field tolerances; unknown combinations fail closed. Recompute ratios only for QA comparison and retain official ratios separately.

## Record-key canonicalization

Generate the full SHA-256 key from a UTF-8 NFC canonical JSON array containing the domain string, dataset name and ordered component values. Read component order from `record_key_components`. Keep IDs as strings, distinguish `null` from an empty string, use ISO dates/hours and never pass decimals through binary floating point. Do not truncate the stored key.

## QA architecture

Use four runtime gates: input qualification, Schema/parsing, identity/conservation and semantic reconciliation. Keep independent golden fixtures and targeted mutation tests as a test-assurance layer, not a fifth production gate. `config/source-schema-baseline-v1.json` is an independently maintained observation baseline; the sample audit must not derive expected headers from this model contract.

Files without an authoritative Manifest remain ineligible for cleaning even when they informed the source-schema baseline.

## Stop conditions

Stop before cleaning when the exact Manifest is absent, campaign identity is absent for a campaign-product file, a required identity is null, an expected header is absent, a new header is unclassified, the overview time header is unknown, detail keys duplicate, or source hash validation fails.
