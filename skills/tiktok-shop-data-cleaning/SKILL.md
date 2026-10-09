---
name: tiktok-shop-data-cleaning
description: Clean frozen TikTok Shop exports into the currently supported diagnostic and history workbooks.
---

# TikTok Shop Data Cleaning

## Natural-language requests

The fixed data root is:

```text
D:\广告数据部
```

Resolve a requested shop only as `D:\广告数据部\<店铺名>`. Do not search `Downloads`, the user profile, or other directories. If that exact shop directory does not exist, report the missing path and stop instead of guessing another location.

Natural-language requests must name one or more cleaning tables, for example:

```text
清洗 TK蚊帐1店 2026-08-26 的计划诊断
清洗 TK蚊帐1店 2026-08-26 的计划小时表现和计划诊断
清洗 TK蚊帐1店 的广告户状态快照
```

- Run exactly the tables named by the user. If multiple tables are named, run each one sequentially and report each result separately.
- Isolate targets from one another: do not chain multi-target CLI calls with `&&`, because one `DATA_CONFLICT` or other table-level failure would prevent later requested tables from running. Execute each target independently (or use a loop that continues after nonzero exit), capture every result, and report successes and failures separately.
- Never interpret an unspecified table as “all tables”. Ask the user to name the table or tables.
- For a single date, pass the same date as `--start-date` and `--end-date`. For a date range, pass its two endpoints.
- `广告户状态快照`、`计划配置历史`、`退货退款明细`、`店铺健康明细`、`履约表现明细`和`SKU状态库存明细`不使用日期参数，读取最新适用快照。其他目标需要日期或日期范围。
- `退货退款明细`、`商品评价明细`、`营销活动明细`、`店铺健康明细`和`履约表现明细`必须传入当前绑定店铺的 sellerId；`订单经营明细`不强制要求 sellerId。
- sellerId 必须使用当前会话绑定店铺的真实值，不能从店铺名猜测。优先从该店铺最新的 `广告户数据/广告账户状态/*.xlsx` 中读取 `account_snapshot_json` 的 `frozen_identity.seller_id`；如果无法可靠取得，应先询问用户，不要用任意非空字符串绕过 CLI 校验。
- `退货退款明细`、`店铺健康明细`和`履约表现明细`是最新适用快照目标，不使用日期参数；用户同时提供日期时仍按技能规则读取最新快照，并在结果中明确说明这一点。`商品评价明细`和`营销活动明细`则使用用户指定日期范围。
- 完成多表清洗后，除检查 CLI 成功外，还要核验每个输出 `.xlsx` 存在、可正常打开、至少包含预期工作表/表头，并报告工作表中的实际数据行数；CLI 返回的 `rows` 与 Excel 实际数据行数应相互校验。`rows: 0` 是有效结果，表示输出文件当前没有数据行，不应误报失败。核验方法见 `references/output-verification.md`；可直接复用 `references/python-workbook-verification.md` 中的 openpyxl 检查模板。
- 若目标返回 `DATA_CONFLICT`（相同唯一键/采集时间对应不同内容），不要删除、清空或强制覆盖现有清洗表；将该目标标记为未更新，并在写入失败后读取原文件核验其仍存在、表头正常、原有行数保留。其他目标仍须继续执行。
- Do not invent or generate a target outside the 16 supported cleaning tables. Report that it is not implemented.

## Execution and verification checklist

For every requested target, preserve an independent result record containing the target name, CLI status, output path, and reported `rows` value. After the CLI returns success, verify the output workbook exists and is readable, contains the expected `数据` worksheet, has a non-empty header row, and report the actual data-row count (excluding the header). Cross-check the CLI `rows` value against the workbook count; treat `rows: 0` as a valid successful result. For a date-specific target, report the exact inclusive date range used; for snapshot targets, explicitly report that the latest applicable snapshot was used even if the user supplied dates.

When several targets are requested, execute and verify them independently so a failure or conflict in one table does not obscure the others. The final response should use a compact per-target summary (target, range/snapshot semantics, actual rows, status) followed by the output directory and any failed/conflicted targets.

## CLI

Run the public CLI from the project root when the data-cleaning project checkout is available:

```powershell
python scripts\run_cleaning.py --shop-root "<店铺根目录>" [--shop-id "<sellerId>"] --target "<清洗表名>" [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD]
```

If the project root is not discoverable but this skill's bundled runner exists, use the bundled runner directly instead of guessing another checkout or stopping prematurely:

```text
python "C:\Users\Administrator\AppData\Local\hermes\profiles\cleaning\skills\tiktok-shop-data-cleaning\scripts\run_cleaning.py" --shop-root "D:\广告数据部\<店铺名>" [--shop-id "<sellerId>"] --target "<清洗表名>" [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD]
```

The runner location is environment-specific; first inspect the skill directory or resolve the actual bundled script path. Keep each requested target as an independent invocation, even when using the bundled runner.

Hermes 调用上述5张需要店铺ID的第三批目标时，必须把当前会话绑定店铺的 sellerId 作为 `--shop-id` 传入，不能从店铺名猜测。

当前已实现全部16张表：`广告户状态快照`、`计划小时表现`、`计划诊断`、`广告户诊断`、`素材诊断`、`计划配置历史`、`计划变更记录`、`订单经营明细`、`退货退款明细`、`商品评价明细`、`营销活动明细`、`店铺健康明细`、`履约表现明细`、`SKU状态库存明细`、`商品经营诊断`和`店铺诊断`。

## 官方字段与派生指标

同业务语义、同粒度、同统计区间的官方字段直接读取，只做数值和百分比格式转换；官方空值保持为空，不通过公式补值。执行和维护这些字段时读取 [references/official-fields.md](references/official-fields.md)。跨计划商品广告汇总、店铺级商品指标汇总及其他派生指标继续使用各自现有计算规则。
