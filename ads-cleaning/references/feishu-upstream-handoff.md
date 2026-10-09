# Feishu upstream handoff

This contract freezes the upstream boundary for the separate Feishu import project. It does not perform a Feishu write.

## Authoritative input

Consume only published cleaning batches under:

```text
D:\广告数据部\99_全局生成记录_不用看\清洗运行\batches\<cleaning_batch_id>
```

The authority is `cleaning_manifest.json`. Import only entries declared in `outputs` after validating:

- `schema_version=cleaning_batch_manifest_v3`;
- `cleaning_batch_status=success` and `qa_status=passed`;
- the bound storage contract, model and Dataset Catalog;
- each output path, SHA-256 and field dictionary.

Do not scan `_staging`, the export raw root, business display directories or deleted legacy roots. Do not infer authority from mtime, filename or directory order.

## Table and record semantics

- Use formal `dataset_name` as table identity.
- Use `record_key` as the upsert identity. If one key has a different `record_content_hash` without explicit authority, fail closed.
- Preserve null values. Do not fill absent facts.
- Do not add `advertiser_id` to shop-owned datasets.
- Follow the field dictionary for daily, hourly, interval, event and snapshot semantics. `captured_at_*` is data collection time, not the platform object's update time.
- `cleaning_version` identifies processing code; it is not business-row authority.

Resolve facts directly from `cleaning_manifest.outputs`, verify every path and SHA-256, and preserve `official_no_data` or authoritative zero-row output as absence evidence. The machine-readable contract is `config/feishu-upstream-handoff-contract-v1.json`.
