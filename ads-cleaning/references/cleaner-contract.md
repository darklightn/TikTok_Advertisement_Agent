# Deterministic cleaner contract

Use one of the two explicit input modes below. Never discover a logical result from business-directory timestamps or “last successful” files.

## Invocation

For a matched immutable Artifact batch (`export_batch_manifest_v3`):

```text
python scripts/clean_exports.py --manifest <absolute-manifest-path> --report-id <model-ready-report-id> [--report-id ...]
```

For a complete or partial logical export job, consume the exact logical job ID and its versioned authority chain:

```text
python scripts/clean_exports.py --logical-export-job-id <uuid> --report-id <model-ready-report-id> [--report-id ...]
```

Logical mode reads `_system/logical-export-jobs/<logical_export_job_id>/vNNNNNNNN.json` and child `batches/<export_batch_id>/manifest.json` files. It validates the contiguous append-only authority chain, exact request/compatibility identity, exact child batch membership, authoritative attempt IDs, Artifact hashes, shared-Artifact bindings and cross-batch record conflicts. A partial source remains partial.

Manifest mode accepts only `export_batch_manifest_v3`. Locator and logical-job entrypoints read only the current immutable `batches/` and `_system/logical-export-jobs/` authority stores; older Manifest schemas and stores are rejected rather than discovered or adapted.

An exact unknown report header (`report_schema_version_unsupported`) is isolated at `report_id`. Any file failure suppresses that report's entire output partition, while unrelated reports continue. All identity, authority-chain, Manifest, Artifact hash, source mutation, row-semantic, and QA failures remain batch-fatal. A partial batch records `successful_report_ids`, factual `failed_reports`, and `qa_scope=published_outputs_only`; QA passed applies only to published outputs. If every requested report is isolated, no empty cleaning batch is published.

Do not pass reports whose dataset capability is not `model_ready`. The cleaner never scans directories and never modifies a source workbook.

All production entrypoints read `export_data_root` and `cleaning_data_root` from `%LOCALAPPDATA%/tiktok-shop-data-pipeline/config.json`, or from the `TIKTOK_SHOP_DATA_PIPELINE_CONFIG` environment override. Explicit CLI roots are test or maintenance overrides only and must never be supplied by Hermes. The cleaning root must already contain the deployed storage-contract snapshot and the model-matched Dataset Catalog pointer under `_system`; cleaning fails closed when either is missing or hash-mismatched. Do not write derived files into the read-only official export root.

## Outputs

The deterministic cleaning batch ID is derived from cleaning version, source Manifest hash and sorted report IDs. A new batch returns `created`; an exact rerun returns `reused`. Both point to the same immutable directory containing:

- `tables/<formal_dataset_name>.csv`: UTF-8, LF, English `snake_case`, full machine keys and export-root-relative source Artifact lineage.
- `field_dictionary.json`: the current [v3 dictionary](field-dictionary-v3.md), preserving exact CSV field order plus aggregation, formula, zero-denominator, currency, semantic, time and nullability metadata.
- `quality_report.json`: four runtime gates, per-file row accounting and summary reconciliation.
- `cleaning_manifest.json`: storage/model/Catalog bindings, source Manifest and Artifact hashes, authoritative work units, output-to-Artifact lineage, and optional embedded `logical_cleaning_package_manifest_v2` input evidence. It never binds the capability ledger.

The batch is first written to `_staging/<cleaning_batch_id>` and atomically published to `batches/<cleaning_batch_id>`. Directory identity never depends on a plan, product, advertiser name or diagnostic domain.

Existing output bytes or file sets must match exactly. Otherwise stop with `immutable_output_conflict`.

## Runtime gates

1. Input qualification: successful Manifest/report, exact report ownership, required identity, file existence and recomputed SHA-256.
2. Schema and parsing: independent header baseline, one worksheet, strict field types, formula rejection and complete row classification.
3. Identity and conservation: versioned canonical keys, uniqueness, source-row traceability and row conservation.
4. Semantic reconciliation: one final overview summary for non-empty overview files, additive totals within an approved report/currency profile and preservation of official ratios.

The independent golden fixtures and mutation tests are test assurance, not a production runtime gate.

Input qualification also requires the current Seller's ISO region, IANA business timezone, official Seller API evidence source and UTC observation time. Cleaned rows carry `shop_region` and `business_timezone`; `cleaning_manifest.json` preserves the complete Seller-bound time context and declares whether each time family is a shop calendar value, local wall time or UTC instant.

## Capability boundary

Hermes cleans only reports whose dataset capability status is `model_ready`. `config/capability-matrix-v1.json` records every enabled export report as supported, supported candidate, or explicitly blocked. A report becomes fully supported only after an authoritative Manifest, deterministic cleaning, and the relevant real runtime gate pass.
