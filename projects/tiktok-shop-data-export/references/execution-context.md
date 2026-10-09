# Execution context

Each export request creates one RunContext after all requested aliases, report specifications, dates, variables, and runner ABIs pass validation.

The session opens the exact shop, attaches to its existing Seller page, identifies the provider, establishes one CDP connection, and performs the authoritative shop identity read once. Advertiser identity is read once only when a selected report requires it. The resulting shop, seller, advertiser, business-center, selector, date, and output-root values are deep-frozen; runners borrow the browser and browser context separately.

When an advertising report does not specify `advertiser`, the session selects Seller onboarding's `primary_adv_id`, verifies that account is eligible, and freezes its advertiser ID, name, and business-center ID once for the request.

All selected runners use this same frozen context and borrowed connection; they do not create a replacement browser or browser context, reconnect, recover a session, rediscover identity, or switch shop or advertiser. A runner may navigate an existing page or create and close one temporary route page within the borrowed browser context; browser/context loss, a missing or login Seller page, origin drift, provider binding mismatch, or returned frozen shop/advertiser identity mismatch is fatal for the request.

For GMV Max recommendation snapshots, malformed items, missing required campaign evidence and unsupported entity types are report-local `campaign_recommendation_shape_invalid`. A changed/missing placements or campaign query is report-local `campaign_recommendation_request_scope_invalid`. An explicit contradictory campaign claim is report-local `campaign_recommendation_plan_conflict`: reject the entire recommendation report before publication, then continue independent reports in the same verified session. These do not establish shop/advertiser drift. Seller/advertiser request binding changes remain fatal `provider_binding_invalid`; existing fatal rules for other reports are unchanged. Failure diagnostics carry the failing field, presence/type, reason and ID digests, never raw IDs, URLs with query strings, cookies or response records.

The session close operation is idempotent and is called once by the exporter after the request reaches its terminal result.
