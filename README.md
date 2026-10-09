# gogo-ads-agent

TikTok 店铺广告数据处理相关代码与 Skills 仓库（由本地完整备份 `广告Agent_完整备份_20260914_091139` 整理而来）。

## 目录结构

| 目录 | 内容 |
|---|---|
| `skills/` | 已安装的 45 个 Agent Skill（含 ads 系列与 4 个 tiktok 系列），**已剔除 `ads/.venv`** |
| `projects/` | TikTok-Agent 下 4 个项目源码（export / cleaning / feishu-sync / dashboard-sync），已移除嵌套 `.git` |
| `ads-cleaning/` | `广告/tiktok-shop-data-cleaning` 完整版清洗工程（含 agents / integrations） |
| `docs/` | 数据清洗开发过程文档：4 份开发计划（`.md`）+ 4 份清洗规则（`.txt`） |
| `archives/` | 4~5 个项目 `.zip` 打包（原始工程副本） |

> 注：同一套四个 tiktok 项目在 `skills/`、`projects/`、`archives/` 三处均有留存（即"三份都保留"），后续如需精简可只留 `projects/` 一份。

## 已排除（不入库）

- 飞书看板 `v2_stage*` 等运行 / 提交 / 测试产物（约 478M）
- Python 虚拟环境 `.venv` / `.cleaning-test-venv`（约 444M）
- `广告数据部` 店铺业务数据（约 22M，328 xlsx + 10 csv）
- 备份清单 `EXPORT_MANIFEST.json` 与各类中间样本数据

## 使用

各子项目自带 `SKILL.md` 与 `requirements*.txt`，按各自说明安装依赖即可。
