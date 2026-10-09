---
name: tiktok-shop-data-feishu-sync
description: 将本地广告数据部的 XLSX/CSV 按固定报表 Schema 和受控类型同步到飞书多维表格；动态选择店铺、文件夹、报表族、文件周期和具体文件，支持本地预览、新增、跳过及稳定ID覆盖。
---

# 本地报表导入飞书多维表格

## 职责与前提

只将已导出、清洗完成的本地文件上传为飞书存储副本。不执行业务清洗、计算、选品、看板设计或源表改造。

正式源目录来自 `config/sync.yaml`，当前为 `D:\广告数据部`。店铺为该目录的直接子目录。仅支持 XLSX、CSV；店铺内允许根文件、一级目录文件和二级目录文件。源文件在本次运行期间不改动；受管飞书对象不同时由其他程序或人工修改。

采用 Python 直接调用官方 OpenAPI，不使用 lark-cli、官方 Excel/CSV 文件 import、浏览器自动化或私有接口。

## 使用入口

把已明确的店铺范围交给唯一入口。以本 Skill 目录为当前目录时：

```powershell
python scripts/run_sync.py --shop "TK蚊帐1店"
python scripts/run_sync.py --shop "TK蚊帐1店" --shop "美妆001"
python scripts/run_sync.py --all
```

`--shop` 可重复；`--all` 与 `--shop` 互斥。不提供范围不执行。相同店铺参数只执行一次。任一明确指定店铺不存在时，整个输入失败，不先上传其他店铺。

不提供 `--root`、`--config`、`--force`、`--delete`、`--retry`、`--credentials-file` 等生产CLI参数。不擅自换源目录、清空state或换店铺。

运行环境提供已有授权应用的 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`。密钥不写入 `sync.yaml`、源码、输出或提交包。脚本不依赖CLI登录缓存，不自动搜索凭据文件。缺授权时明确报告，不自行切换身份。

## 动态范围与Hermes指令

每次从源根目录直接子目录发现店铺，从当前Schema的 `report_name` 和 `match` 发现报表族。不维护店铺或报表白名单。先读取真实名称再生成结构化参数；Python不接收整段自然语言。

新增可重复参数 `--folder`、`--report`、`--file`、`--date`，以及每次两个端点的 `--date-range`。同一维度取并集，维度之间取交集；日期和区间属于同一时间维度。一个完整名称是一个参数，保留内部空格，不把“和”、空格或分号机械拆分。

```powershell
python scripts/run_sync.py --shop "TK蚊帐1店" --report "订单明细" --report "商品评价" --preview
python scripts/run_sync.py --all --folder "店铺数据" --preview
python scripts/run_sync.py --all --report "商品表现" --preview
python scripts/run_sync.py --shop "TK蚊帐1店" --file "20_清洗数据/商品评价明细.xlsx" --preview
python scripts/run_sync.py --shop "TK新款浴巾5店" --report "GMV Max 计划小时表现" --date "2026-8-26" --preview
python scripts/run_sync.py --shop "TK新款浴巾5店" --report "GMV Max 计划表现" --date-range "2026-8-1" "2026-8-26" --preview
```

以上店铺、日期仅为示例，执行时使用实际对象与日期。新组合范围先用同样参数加 `--preview` 核对文件，再去掉该标志执行同一范围。预览不算Hash、不访问飞书、不读写state，也不判断未来CREATE/REPLACE/SKIP。明确日常范围不用重复索取确认；歧义或日期含义不明确时说明具体候选并询问。

用户省略店铺但明确文件夹或报表，例如“导入 店铺数据”，按约定转成 `--all --folder "店铺数据"` 并回显实际覆盖店铺；单独“导入”没有有效范围，不能执行全部。用户说“甲店的订单、乙店的评价”，拆成两个任务分别预览和执行，不能生成两店乘两报表的交叉范围。参数使用结构化参数数组或安全引用，不将用户文本拼成shell代码。

文件夹选目录及其子目录，以路径段为边界。文件夹和报表允许完整相对名称或唯一尾名；歧义列候选，不选第一项。报表族包括相同report_name下全部Schema变体，仍遵守目录、固定stem和扩展名；不读业务表头来选范围。“商品表现”不包含“商品分析表现”，“商品评价”不等于“商品评价明细”。精确文件只用店铺相对路径，不按basename到处搜索。

日期筛选文件名末尾周期，不筛表内记录。单日接受单日末尾或同日起止区间，不接受累计区间；范围要求两个端点恰好一致。逐日小时表使用多个明确 `--date`，不能用区间参数替代。“今天”等须先结合真实当前时间转成完整年月日。没有末尾日期的清洗汇总表不能按日期拆行，只能明确选择整份文件。非法末尾日期报错。

回报解析后的店铺、全部条件、命中文件数和真实结果。某店本轮为空应明确列出，不计UNCHANGED。局部2个文件的结果不能回报为全店143个SKIP。范围校验失败不执行其他有效条件；详细规则及错误见 `references/sync-rules.md`。

## 同步流程

```text
读取配置并校验全部店铺范围
→ 取得现有店铺执行锁、检查state
→ 扫描与源文件Hash、核实历史路径是否确实不存在
→ 定位Base并完整读取相关表清单
→ planner确定新增/跳过/覆盖、原卷/新卷、目录和表名
→ 仅对需要上传的文件调用typed reader
→ 按需建立父目录/Base，先保存Base token
→ 调用table_writer创建或覆盖记录
→ writer明确WRITTEN后提交该文件成功映射
→ 汇总结果
```

全程按店铺、卷号、相对路径确定性串行执行。不新增并发、临时表切换、技术行键、回滚、自动重试、恢复日志或自动接管。

## 数据、命名与更新

固定注册表唯一来源是 `config/sync.yaml` 中的 `schema_registry`。同类报表使用固定Schema，不逐文件猜类型。注册表与具体转换规则见 `references/data-mapping.md`。

ID及原文使用Text，数量/金额/比例使用Number，日期时间使用DateTime，布尔使用Boolean。Number从reader到client保持Decimal；不经过float、二次缩放或业务值字符串化。C方案仅限已批准的5个混合字段，保留显示文本并写入隐藏Number伙伴字段。

General采用已接受的服务端默认显示；DateTime界面到分钟，原始UTC毫秒保持。不得为了显示再修改源值。

一个本地文件对应一张表。Base名称为 `广告数据部_<店铺名>_V001` 等；目录、分卷、超长名称规则见 `references/sync-rules.md`。超长表名按“首＋完整日期/日期范围＋尾＋8位hash”处理，不能只留下日期或简单截断尾部。

未变化且映射表仍存在时跳过，不重新解析全表。覆盖通过原table_id保留表、受管field_id及额外公式字段，只替换records；原record_id、旧行手工字段值和逐行关联不承诺保留。本地删除不传播到飞书，不删除历史映射。

## 成功与失败

`WRITTEN`仅表示单文件远程写入完成；该文件的state提交成功后，才计为created/replaced。state只保存 `base_token` 和 `local_path/table_id/file_hash`。

标准输出为一份JSON：`status`、`shops`、必要错误、逐文件结果；局部任务增加 `scope`。真实执行状态为 `SUCCESS`、`PARTIAL_SUCCESS`、`FAILED`，退出码0只对应SUCCESS；本地预览单独返回 `PREVIEW`、`scope`、`errors=[]`，退出码0。

普通文件错误停止该文件，其他可执行文件继续。Base不可可靠定位、完整清单读取失败或写入结果未知时，停止该Base后续写入。state提交失败保留已写入的表，停止该店铺后续上传。认证整体失败停止运行。任何情况都不自动回滚、重传、不按名字猜测删除。

用户需人工处理时，说明具体路径、Base/table ID、阶段及已知写入事实，不仅输出“失败”。结果未知时先核对再重新执行；遗留同名表不自动接管。不得把没有执行或没有提交成功状态的文件算作成功。

阶段13的离线与受保护真实SKIP通过后，先提交独立验收，再更新Hermes部署并实发组合范围指令。自动化结果不代表机器人自然语言映射已经通过；必须核对实际参数、文件集合和局部计数。
