# TikTok Shop 数据管道

TikTok Shop 店铺数据处理仓库。管道只有四段：导出 → 清洗 → 飞书同步 → 老板看板同步。`skills/` 下保留 **4** 个 Skill，分别对应这四段。

先前误放入的第三方 [Claude Ads](https://github.com/AgriciDaniel/claude-ads)（MIT，AgriciDaniel/claude-ads）以及不属于本管道的 `ad-group-optimizer` 已从本仓库删除。

## 四段管道

| 阶段 | 目录名 | 作用 |
|---|---|---|
| 1. 导出 | `tiktok-shop-data-export` | 按报表路由导出指定店铺的 TikTok Shop 数据 |
| 2. 清洗 | `tiktok-shop-data-cleaning`，完整工程在 `ads-cleaning/` | 定位已导出报表并做确定性清洗 |
| 3. 飞书同步 | `tiktok-shop-data-feishu-sync` | 把本地 XLSX/CSV 按固定 Schema 同步到飞书多维表格 |
| 4. 看板同步 | `tiktok-shop-dashboard-sync` | 读取已登记的清洗表，维护飞书老板看板 |

## 目录与规范副本

| 目录 | 内容 | 规范副本 |
|---|---|---|
| `projects/` | 四段管道的项目源码 | **四段 Skill 包的规范源码**。清洗、飞书同步、看板同步与 `skills/` 中同名目录内容一致。导出项目比 Skill 副本多 `config/`、`tests/`，以及 `scripts/validation/` 下的 `validate_a.js`、`validate_b.js`、`validate_shop_identification.js` |
| `skills/` | 同上四段的可安装 Skill 副本 | 与 `projects/` 同名目录对应。内容有分歧时以 `projects/` 为准 |
| `ads-cleaning/` | 清洗阶段的完整工程（agents、integrations、清单与字段契约） | **清洗工程的规范副本**。它是自有管道代码，不是 Claude Ads。`projects/tiktok-shop-data-cleaning/` 与 `skills/tiktok-shop-data-cleaning/` 是另一套内容相同的清洗 Skill 包，两者都保留 |
| `docs/` | 清洗开发计划（4 份 `.md`）和清洗规则（4 份 `.txt`） | 文档本身 |
| `archives/` | 四段项目的 zip 副本 | 仅作归档；不含第三方广告 Skill |

`projects/tiktok-shop-data-export/agents/`、`skills/tiktok-shop-data-export/agents/` 和 `ads-cleaning/agents/` 属于上述管道，保留。

## 已排除（不入库）

- 飞书看板 `v2_stage*` 等运行 / 提交 / 测试产物
- Python 虚拟环境 `.venv` / `.cleaning-test-venv`
- 店铺业务数据（xlsx / csv）
- 备份清单 `EXPORT_MANIFEST.json` 与各类中间样本数据

## 使用

各子项目自带 `SKILL.md`。Python 阶段按各自的 `requirements.txt`（清洗完整工程另见 `ads-cleaning/requirements-dashboard.lock`）安装依赖。导出阶段在对应目录用 Node 运行 `node scripts/export.js`。
