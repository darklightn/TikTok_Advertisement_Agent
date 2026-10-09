# Field dictionary v3

`cleaning_field_dictionary_v3` remains a machine dictionary for cleaned CSVs, not a presentation or Feishu-view contract.

Every dataset entry preserves the exact CSV column order. Every field explicitly records:

- `aggregation`;
- `formula`;
- `zero_denominator_behavior`;
- `currency_behavior`;
- `semantic_role`;
- `time_role`;
- `nullable`.

Properties that do not apply use `not_applicable` or JSON `null`; they are not silently omitted. Nullability is derived from the versioned model type. Currency behavior does not infer a currency: monetary values are accepted only when the qualified source supplies the row currency and its scope.

Production batches write and accept only v3 dictionaries. Consumers read the active cleaning version from `cleaning_manifest.json` and the active model version from `field_dictionary.json`.

For `gmvmax_campaign_hourly_performance`, CSV and dictionary order is: applicable common lineage fields, then `campaign_id`, `campaign_name_observed`, `metric_date`, `metric_hour`, `captured_at_utc`, the five official performance metrics, `raw_hour_json`, and applicable derived metrics. Its record key includes advertiser, campaign, metric hour and currency. It is not interchangeable with `gmvmax_ad_performance_hourly`, whose grain remains advertiser-hour only.
