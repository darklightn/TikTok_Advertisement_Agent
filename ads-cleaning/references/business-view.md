# Refresh the shop business directory

The shop directory is an append-only browsing layer under `D:\广告数据部`. Immutable Export Manifests and `cleaning_manifest.json` outputs remain authoritative.

Run an explicit refresh for one known shop:

```powershell
python scripts\refresh_business_directory.py --shop-id "<shop_id>"
```

The command reads every authoritative export and passed cleaning batch for that shop, verifies source SHA-256 values, reuses identical content, and appends `_v2`, `_v3`, and later versions when content changes for the same business date. Ordinary refreshes never delete, replace, or rebuild a shop directory.

Dashboard workbooks are additional cleaning outputs under `20_清洗标准\投手看板` and `20_清洗标准\老板看板`. Each logical table is one single-sheet XLSX at `<table>\<date-or-range>.xlsx`; internal QA and deduplication keys remain in manifests and are not visible columns.

Read a shop in this order:

1. `00_店铺档案\数据目录索引.json`
2. the target table under `20_清洗标准`
3. `10_导出原始` when source verification is required

Do not use the browsing directory as an export or cleaning input. Feishu ingestion reads `cleaning_manifest.outputs` directly.
