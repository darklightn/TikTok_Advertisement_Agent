# Product ratings and reviews

Read this reference only for `product_ratings_review_list`. Accept only a successful shop-owned Manifest whose files are byte-preserved official CSV exports and whose segment ranges stay inside the exact requested range.

The fact grain is one official source row. The official six-column export has no `review_id`; therefore even fully identical rows cannot be proven to represent the same review. Preserve every official row. Use the immutable source-row identity for `record_key`, and report exact duplicate signatures in QA without deleting or merging them.

Preserve the official rating, review text, review local wall time, order ID, product ID, and SKU ID. The review timestamp has no explicit UTC offset in the official file; retain it as local wall time and pair it with the Manifest business timezone. Do not invent UTC conversion, sentiment, topics, diagnoses, rankings, or advertising attribution in the cleaning layer.

`order_id`, `product_id`, and `sku_id` are official identifiers and may support later governed joins. A review does not by itself prove that an advertisement caused the order.

This is a shop-owned fact. An export batch may also contain `selected_advertiser` for advertiser-owned reports, but cleaned rating rows must leave `advertiser_id` and `advertiser_name` empty.
