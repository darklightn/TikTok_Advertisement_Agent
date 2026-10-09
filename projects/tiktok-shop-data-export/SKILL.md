---
name: tiktok-shop-data-export
description: "Use for exact-shop TikTok Shop data exports through the v3 Markdown router and lightweight exporter."
---

# TikTok Shop Data Export

Run one v3 export request through the Markdown-defined report router and report specifications.

## Request

The executable request is JSON with these fields:

- `shop`: exact shop reference.
- `report_scopes`: one or more direct report aliases or narrow scope aliases from [references/report-router.md](references/report-router.md).
- `start_date` and `end_date`: required only when selected reports require a date range.
- `advertiser`, `campaign`, and `product`: optional exact selectors used only by reports that require them.

Run the direct entry as:

```text
node scripts/export.js --request-json '<v3 JSON>'
```

Unknown, disabled, ambiguous, `all`, and `default` scopes fail before shop identity or browser attachment.

## Lightweight flow

1. Load the router and selected report specifications from Markdown.
2. Validate the complete request and every selected runner before opening the shop.
3. Establish one RunContext: open, attach, connect the borrowed browser once, read and classify authoritative shop identity once, then freeze it; when advertising context is required, read and freeze the advertiser once.
4. Run the selected Markdown-declared runners with that borrowed browser connection.
5. Validate each staged output, then atomically replace its file beneath the stable shop output root. Snapshot reports use the RunContext's frozen `Asia/Manila` collection date as `YYYY-MM-DD.xlsx`; a same-day rerun replaces only that day's file and never removes another date.
6. Return one `export_result_v1` with `success`, `no_data`, `partial`, or `failed` and per-report/per-artifact results.

There is no recovery, reconnect, or identity switching inside a request. A failed output keeps the previous formal file. Trusted `no_data` publishes the report's fixed empty table and replaces stale data. Official segmented exports remain separate files and are never merged.

GMV Max plan performance uses one report and one `GMV Max 计划表现` directory for both single-day and multi-day requests. Every top-level field returned across the selected campaign records becomes a column; primitive values remain directly usable, nested objects and arrays stay as JSON text in their own columns, and `currency` is appended when absent from the response. GMV Max campaign-product performance likewise uses one `GMV Max 计划商品表现` directory and preserves the official XLSX bytes. A single day is named `YYYY-MM-DD.xlsx`; a multi-day range is named `YYYY-MM-DD_至_YYYY-MM-DD.xlsx`. Legacy daily/interval aliases resolve to these unified reports and must not create duplicate requests.

After identity binding determines `shop_root`, each export request checks `15_人工录入/成本表.xlsx` once before any report runner starts. A missing file is created as a header-only workbook; an existing file is never read, changed, or migrated. Creation failure is reported as a warning and does not block report execution.

Formal exports use exactly `data_department_root/店铺名/数据归属/表类型/表格文件`. The data ownership directory is `店铺数据`, `广告户数据`, or `计划数据`; do not add an intermediate raw-export or entity-ID directory. When an advertiser, campaign, product, or logical table must distinguish files within the same report type, put its display name in the filename and never append its raw ID. If two products in one campaign have the same display name, append a stable non-reversible short digest of the frozen product identity so their files cannot overwrite each other.

## Currency closure

Every exported table that contains monetary values must expose an ISO 4217 currency code. Generated tables store that code in their declared `currency`/`币种` column; when their same-report API record exposes only a verified display symbol, the runner—not cleaning—performs the declared mapping. For an official XLSX/CSV whose columns omit an ISO code, the report specification must declare `currency_contract_v1`; the runner must observe the declared symbol on that same report page, and the exporter embeds the code in the CSV column or XLSX custom metadata. Do not publish an adjacent currency JSON file. The current verified mapping is exactly `₱` to `PHP`.

Currency evidence is authoritative only for the exact report, shop/provider identity, and exported file being published. Do not infer shop/order currency from country, shop name, another report, or an advertising account; advertising tables continue to use their own API or frozen advertiser currency.

## Official UI and asynchronous task invariants

For Orders, observe the declared currency evidence on the loaded order report page after the bound list response and before opening the export-task dialog; the downloaded CSV is not expected to contain that display symbol. For Affiliate, always enter from the bound Seller page through the provider-declared left-navigation steps and then verify the resulting Affiliate origin and shop identity; never construct or navigate directly to an Affiliate entry URL.

Promotion date preflight rejects only dates after the provider business day. A requested current business day proceeds to the official picker; if that exact day is visibly disabled, return `current_date_not_exportable` rather than `invalid_date`. For asynchronous official exports, a timeout must preserve sanitized task observations that distinguish an unobserved task, continuing processing, explicit failure, and success without a URL. Increase a provider timeout only after a bounded real run proves the same route succeeds for a smaller data window.

## Hermes

Hermes uses the same request without translation. Never run separate export requests concurrently for the same shop, including retries. Build the reply from every requested report's terminal result; count reports separately from files and retain earlier verified successes when retrying. See [references/hermes.md](references/hermes.md).

## Tool boundaries

Read [references/execution-context.md](references/execution-context.md) before changing identity or fatal-session behavior. Read [references/toolchain.md](references/toolchain.md) before changing environment discovery, CDP attachment, filesystem publication, currency sidecars, or Hermes integration. Keep official downloads byte-unchanged. Keep mutable staging data outside the Skill directory. Never invoke or chain the cleaning Skill from this workflow.
