# Hermes v3 entry

Hermes submits the same v3 request accepted by `scripts/export.js`:

```json
{
  "shop": "exact shop reference",
  "report_scopes": ["report alias or narrow scope"],
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "advertiser": "optional exact advertiser",
  "campaign": "optional exact campaign",
  "product": "optional exact product"
}
```

Invoke the thin adapter with:

```text
node scripts/i_hermes_tool_export.js --request-json '<v3 JSON>'
```

For a syntactically valid JSON request it emits one `ack` event, passes the request unchanged to `scripts/export.js`, and then emits exactly one `final` event. The final event preserves the complete `export_result_v1`: overall `success`, `no_data`, `partial`, or `failed`; ordered report IDs; each report's status, files, row count, hash or reason; and every multi-artifact terminal result.

If request validation fails before a run context exists, the failed final keeps the validation `reason_code` (for example, `date_range_required`) even though `request_id`, `shop_id`, and the report terminal list are not yet available.

Invalid JSON emits one failed final event without an acknowledgment. Scope and report capabilities come only from [report-router.md](report-router.md) and its report specifications; this adapter does not maintain a second capability list.

The adapter passes the v3 request through unchanged and persists no task state.

For the same shop, wait for the current adapter process to emit its final event and exit before starting another request, including a failed-report retry. Never run separate export commands concurrently against the same shop browser: Seller navigation and the browser-wide download directory are shared state. Prefer one request containing the requested report scopes; the exporter runs reports in order.

Build the user reply from every report in the final event, not from a hand-picked list of downloaded files. Account for each requested report exactly once as success, trusted no_data, failed, or aborted. Count reports separately from files (one report may produce multiple files), and do not label a partial run as a completed full export. For retries, retain earlier verified successes and replace only the retried report's terminal status. The sum of report status counts must equal the number of requested reports; file-delivery caveats are not failed reports.
