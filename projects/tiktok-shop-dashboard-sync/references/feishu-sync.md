# 底表同步规则

仅建立或同步底表时使用：

```bash
python <Skill>/scripts/run_sync.py --mode init --data-only --config "<sync.yaml>"
python <Skill>/scripts/run_sync.py --mode sync --data-only --config "<sync.yaml>"
```

完整 init 和 sync 也调用此底表流程，并在确认后继续页面处理。范围和路径规则见[执行规则](execution-rules.md)。

## 通信与目标配置

默认 `feishu.cli_command: [lark-cli]`、`identity: user`、`timeout_seconds: 60`。Windows 可将已安装 Node 和官方 CLI 脚本设为命令数组中的两项，不拼接 shell 命令。

同步默认 batch_size=100、page_size=100、readback_attempts=5、readback_interval_seconds=1。批量与分页范围 1—200，回读次数 1—10；等待间隔为非负有限数，超时为正有限数，布尔值不充当数字。完整流程和 data-only 均检查通信设置。

目标由 `target.parent_folder_path/base_name/table_name` 指定；可用 `parent_folder_token` 指定已核对目录。无 token 时按官方云盘目录定位；歧义或查询失败不退回根目录。首次创建使用 Asia/Shanghai 时区。

## 资源核对

每轮先核对来源上传版本、身份、完整区间及 PHP/USD 币种，再生成候选，见[数据规则](data-rules.md)。无候选时不连接飞书；部分有效时只同步有效范围并保留 issues。

init 无 Base 登记时，先检查父目录同名目标；发现同名目标需核对登记，不自动认领或另建同名 Base。有实际 ID 时按 ID 核对；保存资源明确失效时阻止。sync 缺少可确认 Base 或底表时返回 `TARGET_NOT_INITIALIZED`，不创建替代资源。

字段按实际名称、ID 和类型核对，主字段须为文本“记录唯一键”；记录类型须包含“店铺汇总”“商品结果”选项。可补缺少的非主字段；主字段、类型或选项冲突返回 `TARGET_SCHEMA_INVALID`。额外字段不写入。客户端按官方字段定义和实际返回映射，不将内部传输格式直接当作官方参数。

## 写入与回读

完整分页读取目标，按业务键新增、更新或跳过，原记录更新保留 record_id。比较、空值清理、历史保留和同 ID 改名均按[数据规则](data-rules.md)执行。候选键或受管历史键在目标重复时阻止写入。

批量串行写入，非空 ignored_fields 或分页不完整均视为远程错误。请求结果不确定时不盲目重试 create；保留已取得资源与未确认动作，下轮先读目标再比较。不自动回滚已发生的远端操作。

有限回读核对候选键、真实 ID、26 字段及 null；历史改名还核对原业务值、ID 和额外字段保留。创建返回 ID 列表的顺序不作为业务对应关系。仅请求成功不足以宣称同步完成。

## 结果与计数

有效候选全部确认且来源范围有效时返回 `DATA_SYNCED / 0`；部分来源或店铺受阻时返回 `PARTIAL_SYNCED / SYNC_PARTIAL / 5`。目标不存在、失效、歧义、字段冲突、重复键或不同 ID 撞名返回 `BLOCKED / TARGET_* / 4`。通信、权限、分页、忽略字段或返回异常为 `REMOTE_ERROR / 6`；有限回读不一致为 `READBACK_MISMATCH / 6`。

`sync_summary` 包含 candidate_count、inserted、updated、skipped、confirmed_count；失败时只报告实际计数。`feishu_written=true` 表示本轮有效候选已确认，包含全部 skip 的情况；实际增改量看 inserted 和 updated。仅底表同步的 dashboard_ready 为 false。

`maintenance_summary` 包含 renamed_record_count（候选与范围外历史中已确认的改名数）、history_name_update_count（范围外已确认改名数）、default_repair_required。`history_name_actions` 单列历史名称补丁及确认状态，不混入候选 inserted、updated、skipped。

运行目录保存 candidates.json、result.json、日志、sync_report.json，以及 cli_evidence 中的命令、请求和原始返回。sync_report 按业务键列动作、真实 record_id 与确认状态，区分尚未尝试、已请求未确认和已回读确认。状态写入及默认店铺修复待办见[执行规则](execution-rules.md)。
