---
name: tiktok-shop-dashboard-sync
description: 生成、同步或维护 TikTok Shop 飞书老板看板。读取已登记上传版本的清洗表并同步指标，由 Agent 接续网页完成页面初始化或默认店铺改名修复；支持核对远端后恢复丢失的本地 state，以及仅预检、离线构建和底表同步。
---

# 老板看板同步

将已登记上传版本的本地清洗数据同步到飞书老板底表，维护整体经营、广告表现和商品表现看板。

## 触发与输入

“生成老板看板”使用完整 `--mode init`；“同步老板看板”使用完整 `--mode sync`。从本 Skill 调用：

```bash
python scripts/run_sync.py --mode init --config "<sync.yaml>"
python scripts/run_sync.py --mode sync --config "<sync.yaml>"
```

输入为本次主配置、来源根目录、上游上传状态目录，以及可选店铺与日期范围。来源是各店铺 `20_清洗数据` 下的三张清洗 XLSX，上游状态是对应 `Vxxx.json` 上传映射。首次初始化可用 `--default-shop "<有效完整店名>"` 指定默认店。

将选中的每个完整店铺目录名分别传入 `--shop`，保留内部空格；`--all` 或不指定店铺表示全部。指定日期时同时传 `--start-date`、`--end-date`。参数组合、路径解析与环境要求见[执行规则](references/execution-rules.md)。

仅检查配置和范围用 `--check-only`；仅离线构建用 `--build-only`；仅同步底表用 `--data-only`。三个标志互斥，不代表完整页面操作。

## 正式执行流程

1. 按[执行规则](references/execution-rules.md)确认配置、运行目录和执行范围；构建前读取[数据规则](references/data-rules.md)，核对来源版本、身份、完整区间和币种。
2. 由 `run_sync.py` 调用来源加载与数据构建脚本。只处理有效候选，按 `issues` 报告受阻范围；不通过改写来源或上游状态绕过失败。
3. 完整流程或 `--data-only` 按[底表同步规则](references/feishu-sync.md)核对目标并增改、回读记录。`init` 可创建资源；`sync` 必须使用已登记目标。
4. 完整流程由 `dashboard_manager.py` 管理页面。返回退出码 `7 / BROWSER_REQUIRED` 时，读取本轮 `browser_task.json` 和[网页操作规则](references/browser-setup.md)，由同一个 Agent 完成初始化或 `repair_default_shop` 默认店铺修复，提交 `browser_result` 后继续原流程。
5. 只按本轮 JSON 的 `status`、`completed`、`issues` 和实际增改计数报告结果；页面就绪后返回真实 `dashboard_url`、已完成模块与数据范围。

本地 state 丢失时，先按[执行规则中的状态恢复](references/execution-rules.md#状态恢复)独立核对远端资源和网页已保存默认组合，再运行完整 `sync --recover-state`。返回 `STATE_RECOVERED` 后，下一轮正常同步才更新业务数据。

## 脚本与参考文档

| 文件 | 调用关系与用途 |
|---|---|
| `scripts/run_sync.py` | 统一入口，处理参数、配置、运行锁和各执行分支 |
| `scripts/source_loader.py`、`scripts/boss_data_builder.py` | 构建器调用来源加载器读取上传映射与同一文件快照，按 `config/boss_table.yaml` 构建候选；见[数据规则](references/data-rules.md) |
| `scripts/feishu_sync.py`、`scripts/feishu_client.py` | 同步器通过客户端调用已授权官方 CLI，核对资源、增改及回读底表；见[底表同步规则](references/feishu-sync.md) |
| `scripts/dashboard_manager.py` | 按 `config/boss_dashboard.yaml` 管理页面、网页待办与回执；见[网页操作规则](references/browser-setup.md) |
| `scripts/state_store.py` | 本地状态、运行锁与只读远端恢复；见[执行规则](references/execution-rules.md) |
| `config/sync.yaml` | 来源、上游状态、运行目录、飞书目标与通信设置 |

## 返回与边界

`PAGE_READY` 表示完整页面就绪；`PAGE_PARTIAL` 表示页面已确认但部分来源或店铺受阻。`PREFLIGHT_OK`、`DATA_READY`、`DATA_SYNCED` 分别只表示预检、候选构建、底表同步完成。`STATE_RECOVERED` 只表示本地登记恢复。`NO_DATA` 不证明来源完整。失败与部分结果按[执行规则](references/execution-rules.md)处理。

不自动删除缺席商品或历史记录，不做汇率换算，不改动前置 Skill、来源及上游状态。普通同步不重排页面、不重设默认区间；同 ID 改名与默认店修复遵循数据规则和网页任务。运行状态、日志、回执及图片均存放在 Skill 外部。业务运行不自动安装依赖、登录或切换身份。
