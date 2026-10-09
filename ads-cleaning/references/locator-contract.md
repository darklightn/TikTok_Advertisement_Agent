# Locator contract

Pass one JSON object with these fields:

```json
{
  "mode": "date_range | latest_snapshot | all_snapshots | recent_batch",
  "shop_alias": "美妆001",
  "report_ids": ["gmvmax_campaign_overview"],
  "start_date": "2026-07-20",
  "end_date": "2026-07-20",
  "advertiser_id": "7645257137211572244",
  "advertiser_name": "菲律宾-美妆001"
}
```

Rules:

- `report_ids` is required, non-empty, unique, and uses canonical IDs, except that `recent_batch` may omit it to select every successful report in the bound batch.
- `date_range` requires `shop_alias`, `start_date`, and `end_date`; dates use `YYYY-MM-DD` and start must not exceed end.
- `latest_snapshot` and `all_snapshots` require `shop_alias` and accept only reports whose Manifest has `date_semantics: snapshot`.
- `recent_batch` requires `--chat-id`. `shop_alias` may be omitted; when present it must match the bound Manifest.
- Advertiser fields are optional filters for requests containing an advertiser-owned report. If both are present, both must match. Shop-only requests ignore batch-level `selected_advertiser` values. Advertiser fields are not permitted for snapshot modes.
- Multiple date-range candidates for the same resolved shop, report set, interval, ownership, and advertiser scope select the latest successful export by `created_at DESC`, then `export_batch_id ASC`. Historical file hashes and totals do not make an ordinary cleaning request ambiguous.
- Validate the selected latest Manifest and files strictly. If the latest candidate is missing or its hash changed, fail explicitly and never fall back silently to an older batch. Requests containing advertiser-owned reports remain batch-level and keep advertiser disambiguation across different advertiser identities; reports are never selected independently from different batches.
- Unknown fields and invalid combinations fail before Manifest lookup.

The command prints one JSON object. Status values are `matched`, `missing`, `ambiguous`, and `invalid`. A matched result includes validated Manifest identities, report metadata, absolute file paths, and recorded SHA-256 values.

The locator consumes canonical `report_ids`. The Hermes adapter must accept business scopes and expand them from `tiktok-shop-data-export/config/report-set.json`; it must not maintain a second report registry.
