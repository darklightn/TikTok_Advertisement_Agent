# Local UI repairs and Feishu deployment — 2026-09-11

Scope: TK蚊帐1店, local, 2026-08-01 through 2026-08-17. One frozen shop/advertiser browser session. No account changes, Feishu messages, full-package rerun, commit or push. Runtime changes limited to the failing local Orders, Affiliate and Creative routes plus Hermes execution/reply instructions.

## Previous Feishu result — verified

Session 20260911_182335_a4377320 returned five successful reports, not four. GMV Max campaign overview had 18 rows; its existing formal file SHA-256 matched ec757e2495a38ec1500df709185534c7b54a8a06f4b30a836ef403e86284dc60. The bot omitted it in prose. Three reports failed. Creative and Affiliate retries were launched concurrently against the same shop; the updated Hermes instructions prohibit that and require an exhaustive report-status count.

## Root causes and changes

- Orders: a late official promotional dialog in the open shadow root of the message-popup host intercepted the Export click. The original raw Playwright TimeoutError became report_execution_failed. A bounded trial-click loop now revisits known dismissible dialogs before opening Export; unknown dialogs are not bypassed. Uncoded errors retain a stage and distinct timeout/execution code. No duplicate export task is submitted by the trial.
- Affiliate: Seller navigation now enters /affiliate/landing. The verified button 前往联盟中心首页 opens the shop-bound Affiliate site. The route now follows this official bridge, excludes unchanged old tabs, checks shop/region before analytics, and waits for mounted navigation. No direct Affiliate URL was constructed.
- Creative calendar: left/right panels included empty header-icon-hidden placeholders with visible layout boxes. Positional selection clicked those instead of the month arrow. The local contract now selects the observed single-left/single-right SVG parent, checks unique controls and exact one-month progress, then retains the exact range readback.
- Creative discovery: a reused Seller page after drawer transitions showed two campaign rows but empty campaign-name cells and no view-data controls. The same entry on a fresh route page in the same context showed both controls; opening a campaign and returning also worked. The runner now owns and closes a fresh discovery page instead of reusing that stale drawer state. This is not a reconnect or new shop identity.

## Live and artifact validation — PASS, bounded scope

All downloads were isolated in system-temporary staging. Existing formal exports were not replaced. Standard exporter output inspection verified frozen identity, file bytes, row count and SHA-256.

| Report | Live result | SHA-256 of raw official file |
|---|---|---|
| Orders | success, 6434 CSV rows; UI filter 01/08/2026-17/08/2026; official task generated from 5901 selected orders | 5de34531b3de21887376d434048dfc60683681bc60b3e1ac5ca942d4ef6e84104 |
| Affiliate creator detail | success, 6705 rows; Details date readback 2026/8/1 - 2026/8/17 | 93df595dd6b613d3101c3a7bdc3e9e8ad74b84261e5044fad5264b8d08df96af |
| Creative, one product in the previously failing plan | success, 32 rows; exact 2026-08-01 / 2026-08-17 readback, one export click and no retry | 24166d596c9560d12f8c46951ec722f5e0360ce984007b4d6740e13ca20f61b1 |

Creative acceptance is for one explicitly selected live product, not all products or plans. Full Feishu conversation replay and full-package publication are NOT_RUN.

## Offline — PASS

321 tests passed with node --test --test-concurrency=1 --test-reporter=dot tests/*.test.js. An earlier parallel run hit the existing short-wall-clock cross-border details-card stability test; serial full-suite execution passed without changing that unrelated implementation/test. The two outdated local Orders fixtures were aligned to the existing create-task-before-record wait order. New coverage checks late/unknown popup behavior, Seller landing navigation and wrong-shop rejection, fresh discovery-page ownership/cleanup, directional calendar selection and wrong/stationary movement. git diff --check passed.

## Deployment and cleanup

Seven runtime/instruction files were copied to C:/Users/Administrator/.codex/skills/tiktok-shop-data-export with matching source/target hashes, rechecked through the Hermes link after cleanup. Hermes skills/tiktok-shop-data-export is a verified Junction to that directory, so this updates the Feishu export runner too. All 46 installed provider entry contracts passed preflight. Tests, evidence and Git metadata were not deployed. No gateway restart or message was used to claim end-to-end Feishu acceptance. The borrowed session and owned temporary pages were closed. All six precisely resolved temporary validation directories were removed; their validation files can be regenerated.
