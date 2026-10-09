# 正式运行规则

## 环境与入口

使用 Python 3.10+ 和 `requirements.txt` 中的依赖。涉及飞书时使用已授权官方 CLI 的用户身份；网页操作使用已登录浏览器。依赖与授权应预先可用，业务运行不自动安装或登录。`--help` 无需环境就绪。

统一入口为 `python <Skill>/scripts/run_sync.py --mode <init|sync> --config "<sync.yaml>"`。

| 参数 | 执行范围 |
|---|---|
| 无 only 标志 | 来源核对、候选构建、底表同步和页面处理 |
| `--check-only` | 只检查配置、路径和范围形式，不扫描店铺或读取来源正文 |
| `--build-only` | 读取来源与上传映射，离线构建候选，不连接飞书 |
| `--data-only` | 构建候选并同步底表，不完成网页操作 |
| `--recover-state "<确认文件>"` | 仅完整 sync 可用，只读核对远端后恢复本地登记 |

三个 only 标志互斥。`init`、`sync` 在预检和离线构建分支的能力相同。恢复不能与 only、`--default-shop` 或 `--browser-result` 组合。

## 范围与路径

支持重复 `--shop`、`--all` 和成对的 `--start-date`、`--end-date`。店铺目录名去首尾空白，按首次顺序去重，保留内部空格。`--all` 与指定店铺冲突；未指定店铺表示全部。日期接受 `YYYY-M-D`，按真实日历规范化为 `YYYY-MM-DD`；不指定日期则范围为 null，不生成缺失日期。

`--config` 相对调用目录解析，默认配置固定为 Skill 的 `config/sync.yaml`。定义文件及来源、上游状态、运行路径相对实际主配置目录解析。支持 `--data-root`、`--upstream-state-root`、`--runtime-root` 覆盖；覆盖先于环境变量展开。`${变量名}` 未定义时报错。

来源与上游目录须已存在；恢复分支不要求其存在，也不读取其内容。构建动态发现含 `20_清洗数据` 的直接子目录；指定店铺不允许绝对路径、跨层或路径跳转。缺失店铺报 `SHOP_NOT_FOUND`，其他有效店铺可继续。

运行目录可创建，但不得与 Skill、来源或上游目录相互包含。默认运行根为 `${LOCALAPPDATA}/tiktok-shop-dashboard-sync`。

## 初始化与同步

完整 `init` 先按[底表同步规则](feishu-sync.md)确认底表，再创建或复用仪表盘和汇总卡。首次默认店来自本轮实际确认范围；该店默认区间按结束日期降序、同结束日期开始日期升序选择。

`--default-shop` 仅完整 init 可用，不与 `--browser-result` 同传。已有默认值或网页待办时，不接受不同 default-shop 静默覆盖；init 重跑复用页面、默认值和已有待办。

完整 sync 必须已有已确认页面，未初始化返回 `TARGET_NOT_INITIALIZED`，不创建替代页面。普通 sync 不重排页面或重设默认组合。

返回 `BROWSER_REQUIRED` 时，由同一个 Agent 按[网页操作规则](browser-setup.md)处理任务并续跑。`--browser-result` 可用于完整 init，或存在 `default_repair` 待办的完整 sync；无待办的普通 sync 拒绝回执。回执相对路径按主配置目录解析。

默认店改名时，在首个数据写入前保存 `default_repair` 待办。待办期间保留原 `state.defaults` 和 `last_successful_sync`，重跑复用同一 task_id；待办与来源不一致时报 `DEFAULT_REPAIR_CONFIRMATION_REQUIRED`。只有网页回执通过后才更新默认店名、清除待办，默认区间保持不变。

## 状态与运行产物

运行根下 `state/state.json` 保存登记，`logs` 和 `runs/<run_id>` 保存每轮日志、结果与产物。stdout 只输出一个 UTF-8 JSON 对象，与该轮保存的 `result.json` 一致；每轮 run_id 唯一。

预检只更新 `last_preflight`。离线构建仅在 `DATA_READY`、`PARTIAL_READY`、`NO_DATA` 时更新 `last_build`，记录 run_id、status、record_count、candidates_json、generated_at；`SOURCE_BLOCKED` 保留旧 state。预检和离线构建不改 initialized、resources、defaults、records、last_successful_sync 等已有字段；新 state 的 initialized 为 false，resources 为空。

底表同步取得真实资源 ID 后及时保存 resources，仅按回读业务键登记 records；只有 `DATA_SYNCED` 更新 `last_data_sync`。仅底表同步不设置 initialized=true，不改默认值或完整页面成功记录；默认店改名可保存网页修复待办，交由完整流程继续。底表分支不更新离线 last_build。

完整流程另存 `page_report.json`、`browser_task.json` 和实际回执副本。state.resources 保存 dashboard_id；state.dashboard 保存 cards、texts、product_block_id、product_view_id、slicers、pending_task_id 和 browser_confirmed；defaults 保存 shop_id、shop_name 及完整 period。只有页面回读和网页检查确认后才设置 initialized=true。`PAGE_READY` 更新 last_successful_sync；待网页、失败或 PAGE_PARTIAL 保留原整体成功记录。

候选文件 `candidates.json` 包含 schema_version=1、skill、run_id、generated_at、status、records、source_files、issues。source_files 只列已匹配 Hash 的来源路径、Hash、分卷路径与 table_id，不输出整份上游 JSON。底表运行报告见[底表同步规则](feishu-sync.md)。

## 运行锁

`state/run.lock` 独占创建，记录 pid 和所有权编号；竞争者不覆盖或删除。正常退出或锁内异常均释放本轮持有的锁。遗留锁不自动抢占，Agent 确认持有进程已结束后再处理。损坏 state 保持原样，不自动覆盖。

## 返回与失败处理

| 退出码 | status / error_code | 处理 |
|---|---|---|
| 0 | PREFLIGHT_OK | 仅配置与范围预检完成 |
| 0 | DATA_READY | 有效候选构建完成，尚未同步 |
| 0 | DATA_SYNCED | 底表有效候选全部确认 |
| 0 | PAGE_READY | 完整页面与有效候选均已确认 |
| 0 | STATE_RECOVERED | 本地登记已恢复，业务数据未同步 |
| 0 | NO_DATA | 无候选，不连接飞书 |
| 5 | PARTIAL_READY / SOURCE_PARTIAL | 仅有效区间可用于后续同步，列明 issues |
| 5 | PARTIAL_SYNCED / SYNC_PARTIAL | 有效候选已确认，列明受阻来源或店铺 |
| 5 | PAGE_PARTIAL | 页面已确认，仍有来源或店铺受阻 |
| 7 | BROWSER_REQUIRED | 接续网页任务；DEFAULT_REPAIR_REQUIRED 表示默认店修复 |
| 2 | ERROR / ARGUMENT_ERROR、CONFIG_INVALID、PATH_INVALID、IO_ERROR | 按原因修复参数、配置、路径或文件访问 |
| 4 | BLOCKED / SOURCE_BLOCKED、TARGET_*、RUN_LOCKED、STATE_INVALID 等 | 保留已知状态，先解决具体阻止原因 |
| 6 | ERROR / REMOTE_ERROR、READBACK_MISMATCH、PAGE_READBACK_MISMATCH | 检查调用返回或读回差异，不宣称完成 |

`DEFAULT_SELECTION_INVALID`、`PAGE_CONFIRMATION_REQUIRED`、`BROWSER_RESULT_INVALID` 均返回 4；按错误修正默认选择或真实回执后继续，不代填确认。目标字段、身份和重复键错误见[底表同步规则](feishu-sync.md)。

`issues` 包含 code、message、shop_directory、source 和 period。正常空值不产生阻止问题；来源全受阻和无数据时均不构造远程客户端。部分结果只使用已通过区间。`shop_count` 包含显式指定但缺失的店铺，`ready_period_count` 等于汇总记录数。

`completed.source_version_checked` 仅在存在店铺且所有应核对来源均匹配 Hash 时为 true；data_built 表示候选非空；feishu_written 表示本轮有效候选已回读确认，包含全 skip 的情况；dashboard_ready 仅表示完整页面已确认。实际写入量看 inserted、updated，不能仅看完成标志。预检不证明来源币种、上传版本或远端资源有效。

## 状态恢复

仅在本地 state 缺失时使用：

```bash
python <Skill>/scripts/run_sync.py --mode sync --config "<sync.yaml>" --recover-state "<recovery_confirmation.json>"
```

已有有效 state 返回 `STATE_ALREADY_PRESENT`；损坏 state 返回 `STATE_INVALID` 并保留文件。恢复保留配置、路径隔离和运行锁检查，不扫描来源、不写远程、不创建资源、不自动选择最新区间。

Agent 先从已确认父目录独立查到实际 Base、底表、仪表盘、26 字段、10 卡、商品组件及视图、两个切片器，并完整分页读取受管记录。通过正常网页查看已保存的原店铺与区间默认值，确认页面可读。旧备份只用于帮助定位，不能代替当前远端和网页核对。

确认文件字段如下：

- `recovery_version: 1`，`skill: tiktok-shop-dashboard-sync`。
- `target: {base_token, table_id, dashboard_id}`，使用实际核对的 ID。
- `components.cards` 将 10 个指标字段映射到实际卡 ID；`components.product: {block_id, view_id}`；`components.slicers` 将“店铺名称”“统计区间”映射到实际 ID。13 个组件 ID 均非空且互不相同。
- `defaults: {shop_id, shop_name, period: {start_date, end_date, label}}`，保持网页原已保存组合，日期使用 YYYY-MM-DD。
- `checks` 的 target_confirmed、saved_defaults_confirmed、page_readable 经实际核对后为 true；`completed_at` 为带时区完成时间；`screenshots` 为至少两张不同、真实、非空图片的绝对路径，图片存放在 Skill 外部运行目录。

脚本再次只读核对目标、字段类型、组件绑定与视图规则，按受管业务键登记真实 record_id。无效人工行不登记，受管重复键阻止恢复。不能确认目标、默认组合或结构时报 `RECOVERY_CONFIRMATION_REQUIRED`；确认文件错误为 `RECOVERY_INVALID`，均返回 4；远程查询错误为 `REMOTE_ERROR / 6`。

全部核对通过后一次保存恢复 state，返回 `STATE_RECOVERED / 0`。此结果不填造 last_successful_sync；source_version_checked、data_built、feishu_written、dashboard_ready 均为 false。下一轮正常 sync 才同步业务数据及处理维护。
