# Shop health snapshot

Read this reference only for `shop_health_snapshot`. The source is an explicitly generated snapshot from official Seller Center structured responses, not an official download. Accept it only when the authoritative Manifest declares shop ownership, UTC `captured_at`, `generated_file: true`, `file_kind: generated_snapshot`, and a matching SHA-256.

The fact grain is one shop x official category x metric x UTC capture time. Require the account-health score and violation overview as the first two identities, require every category-plus-metric identity to be unique within the snapshot, and preserve every remaining official metric. The metric set may differ between cross-border and local shops and may change with platform policy; do not force one shop's row set onto another.

Preserve the exact current-value and target-condition text. Parse numeric values separately for machine use, keeping percentages as official percentage points, consistent with fulfillment snapshots. Preserve an explicit `%` unit only when the source text contains it. Do not infer units for scores, response time, or other bare numbers.

Every row capture time must exactly match the Manifest UTC snapshot time. Assessment dates are official metric windows and must not be replaced by request dates. Blank current values remain null, not zero. Preserve violation counts and explanations without calculating diagnoses, severity, rankings, or recommendations in the cleaning layer.

This is a shop-owned fact; cleaned rows leave advertiser identity empty. It can provide operating context for later advertising diagnosis, but it does not prove advertising attribution.
