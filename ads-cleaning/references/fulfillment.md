# Fulfillment performance snapshot

Read this reference only for `fulfillment_performance_snapshot`. The source is an explicitly generated snapshot from official Seller Center structured responses, not an official download. Accept it only when the authoritative Manifest declares `generated_file: true`, `file_kind: generated_snapshot`, shop ownership, UTC `captured_at`, and a matching SHA-256.

The fact grain is one shop x fulfillment category x metric x capture time. Preserve all ten official metric records and their official windows. `metric_date`, `assessment_start`, and `assessment_end` are official evaluation dates; the request dates are routing metadata and must not replace them.

Keep percentage values as official percentage points when `unit` is `%`; do not silently divide by 100. Keep the numerator, denominator, previous value, industry average, official status, and statistic basis separately. Do not calculate diagnoses or recommendations in the cleaning layer.

Stop when the header changes, the ten category/metric identities differ, row capture time differs from the Manifest, or an assessment metric lacks its official window or numerator/denominator.
