# Toolchain

Load this file only when the v3 entry interacts with its environment or changes tool discovery.

| Tool | Purpose |
|---|---|
| Node.js | Run `scripts/export.js`, the Hermes adapter, and offline tests |
| ZhanFu WebDriver HTTP API | Resolve and open the exact requested shop once |
| Playwright `connectOverCDP` | Borrow the exact shop's existing browser context once |
| Windows filesystem | Stage, validate, and atomically replace report files |
| Hermes/Feishu | Submit a v3 request and receive acknowledgment/final events |

## V3 execution boundary

`scripts/export.js` loads the Markdown router, validates the full request and runner ABI, and then creates one RunContext. That session performs the bounded open, attach, shop identification, one CDP connection, and the authoritative identity reads required by the selected reports. All runners borrow the same browser/context. The exporter closes the borrowed connection once after every report reaches a terminal result.

See [execution-context.md](execution-context.md) for the frozen RunContext and fatal-session boundary.

## Publication boundary

Each runner writes only to its isolated system-temporary staging directory. Generated tables and byte-unchanged official downloads are validated before their destination directory is created, copied to a sibling temporary file, revalidated, and atomically renamed over the stable target. Failed validation or publication preserves the previous formal file. Trusted zero data publishes the report's fixed empty table. Snapshot outputs are keyed by the RunContext's frozen `Asia/Manila` collection date (`YYYY-MM-DD`), so replacement is scoped to one collection day and older dated snapshots remain untouched. Official source segments remain independent files.

When an official download has a `currency_contract_v1`, publication embeds the verified ISO code in the delivered table: CSV gains a `currency` column and XLSX stores `Currency`/`CurrencySymbol` as custom workbook metadata. No adjacent currency JSON is published. The official download is validated before this deterministic metadata transformation, and the export result records the transformed file's SHA-256.

Keep credentials, cookies, browser profiles, downloads, and mutable evidence outside the Skill directory. Machine-specific installation paths and observed CDP ports are never runtime authority.
