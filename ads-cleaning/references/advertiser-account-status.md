# Advertiser account status model

Read this reference for `advertiser_account_status_snapshot` after an authoritative Manifest locates a successful API snapshot.

The dataset grain is one shop × advertiser × UTC capture instant. The parser requires the selected advertiser to equal the current primary advertiser recorded by the source, preserves raw account, relation, payment, billing, and authorization enums, and rejects incomplete identity or capture evidence.

Account currency and billing currency are independent fields. The Manifest currency gate applies to account currency; billing currency remains source content and is never substituted for the account scope. Payment portfolio currency lists and billing options remain canonical JSON rather than being collapsed to one guessed value.

Capability fields describe collection state only. They are not account metrics: unavailable balance, spend-limit, delivery-status, or restriction-reason values remain unavailable rather than being inferred from another account scope. Campaign delivery or learning statuses remain campaign-grain data.
