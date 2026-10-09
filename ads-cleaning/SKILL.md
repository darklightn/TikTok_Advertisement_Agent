---
name: tiktok-shop-data-cleaning
description: Locate, validate, and deterministically clean already-exported TikTok Shop advertising datasets. Use when a Hermes or Codex request asks to clean a shop's dated reports, advertiser-scoped reports, or data just exported in the current Feishu chat.
---

# TikTok Shop Data Cleaning

Locate inputs before cleaning. Current deterministic cleaner supports every dataset marked `model_ready` in `config/first-model-v1.json`; a located report with any other capability status must remain uncleaned and be reported explicitly.

## Workflow

1. Convert the user's request to the structured intent in [references/locator-contract.md](references/locator-contract.md). Resolve names and aliases through the export registry as described in [references/report-ids.md](references/report-ids.md); pass only canonical `report_id` values to the script.
2. For a single export batch, run `python scripts/locate_exports.py --intent-json '<json>'`. For data just exported in the current Hermes chat, also pass the current `chat_id` with `--chat-id`. For a logical export job, use the exact `logical_export_job_id` returned by the exporter instead of the locator.
3. In Manifest mode, continue only when stdout has `status: matched`. In logical-job mode, consume only the exact versioned job chain and child batches selected by its authority map.
4. For `missing`, explain that no exact exported dataset exists. For `ambiguous`, show `choices` and ask one minimal clarification. For `invalid`, report the failed file or Manifest validation and stop.
5. Read [references/cleaner-contract.md](references/cleaner-contract.md), then run `scripts/clean_exports.py` in exactly one input mode with only requested `model_ready` report IDs.
6. Report `created` or `reused`, the cleaning batch ID and logical dataset row counts. The Hermes/Feishu entry then refreshes the shop directory directly from all authoritative Export and Cleaning Manifests; report `D:\广告数据部\<店铺>` as the user browsing directory without attaching local files. For a stable error code, report the failed gate and stop.

After location succeeds, read only the applicable report reference:

- GMV Max overview, campaign-product, campaign-product creative, or shop-wide creative: [references/first-model.md](references/first-model.md)
- Inventory: [references/inventory.md](references/inventory.md)
- Product analytics: [references/product-performance.md](references/product-performance.md)
- Orders: [references/orders.md](references/orders.md)
- Returns and refunds: [references/returns-refunds.md](references/returns-refunds.md)
- Fulfillment performance: [references/fulfillment.md](references/fulfillment.md)
- Affiliate creator performance: [references/affiliate.md](references/affiliate.md)
- Ratings and reviews: [references/ratings.md](references/ratings.md)
- Promotion performance: [references/promotion.md](references/promotion.md)
- Shop health: [references/shop-health.md](references/shop-health.md)
- Product and SKU commercial status: [references/product-sku-commercial-status.md](references/product-sku-commercial-status.md)
- Advertiser account status: [references/advertiser-account-status.md](references/advertiser-account-status.md)

`config/first-model-v1.json` and its referenced report contracts are the machine-readable Schema, key, field-source and QA authority. A report without a dedicated reference still follows that machine contract; workbook headers never define an ad-hoc output table.

## Boundaries

- Read only immutable `export_batch_manifest_v3` batches or an exact versioned logical export-job chain under the configured export root. Older Manifest schemas and authority stores are unsupported.
- Require exact date-range equality. Never trim overlaps, join ranges, infer historical Manifests, scan business directories, or trigger an export.
- Treat advertiser omission as optional only when the remaining candidates resolve to one advertiser identity.
- Verify every returned path and SHA-256 before reporting a match.
- Treat script JSON as authoritative. Do not replace a failed deterministic result with directory-name or timestamp guesses.
- Never edit official source workbooks. All production entrypoints read `export_data_root` and `cleaning_data_root` from the shared pipeline runtime config; each `<cleaning_batch_id>` directory is immutable.
- Cleaned CSV files are machine interchange artifacts. Do not add display labels, shorten stored hashes, or optimize their layout for human reading.

## Refreshing the Chinese business view

For direct maintenance, when the user explicitly asks to refresh the browsing directory for a known `shop_id`, read [references/business-view.md](references/business-view.md) and run `scripts/refresh_business_directory.py --shop-id <shop_id>`. The Hermes cleaning entry invokes the same deterministic refresh only after cleaning succeeds; a display failure remains separate from cleaning success.

