# 直写版同步规则｜阶段13

## 范围与配置

读取本Skill目录下的 `config/sync.yaml`，不依赖启动时当前目录。该文件继续采用现有JSON兼容YAML写法，使用标准库读取，不新增YAML依赖或配置文件。

生产源根目录保持 `D:\广告数据部`，飞书父目录保持 `/广告数据部`。state根路径展开 `${LOCALAPPDATA}`；变量缺失报错，不把占位符原样当目录创建。state必须位于源根之外。测试只能在外部工作区的配置副本或函数参数中替换源、state、目标父目录和容量，不能修改提交Skill的冻结配置/Schema。

复用现有scanner和state_store，不新增恢复数据库、运行标记、队列系统或临时表机制。店铺执行锁及原子state写入沿用现成实现，不重新实现另一套锁。

## 源文件与目标名称

| 源相对路径 | Base内目录 | 正常表名 |
|---|---|---|
| `A.xlsx` | 根目录 | `A` |
| `20_清洗数据/订单经营明细.xlsx` | `20_清洗数据` | `订单经营明细` |
| `店铺数据/商品分析表现/2026-08-26.xlsx` | `店铺数据/商品分析表现` | `2026-08-26_商品分析表现` |

正常表名不超过100字符时不改变。超过时：先生成完整正常表名，取其UTF-8 SHA-256前8位小写十六进制。Hash不取文件内容、不取截断结果，也不取随机值。

选择最右侧完整 `YYYY-MM-DD_至_YYYY-MM-DD` 日期范围；没有范围时选择最右侧 `YYYY-MM-DD`。从完整名称中移除这一次选中的日期片段，并仅去掉剩余字符串最外侧下划线，得到首尾取样主体。

有日期：`首_完整日期或范围_尾_8位hash`。可用首尾预算为 `100－日期长度－8－3`；首取预算向上半数，尾取向下半数。没有日期：`首_尾_8位hash`，首尾预算为 `100－8－2`。保留原大小写、内部空格和业务字符，不把字符数当UTF-8字节数。同一名称的缩名结果永远稳定。

缩名后仍执行完整的同Base冲突检查。Hash降低冲突概率但不构成无冲突保证。发生冲突报 `TARGET_TABLE_NAME_CONFLICT`，不追加 `(1)` 或第二轮随机后缀。

## 分卷与轻量观测

每卷最多290条正式业务映射；历史孤儿也占名额。已有路径始终保留原卷。新路径按相对路径稳定顺序加入当前最高卷，名额满才进下一卷；不回填早期卷，不因本轮单文件失败重新装箱。

planner纯本地先给出需要观测的卷，run_sync取得对应完整Base/表清单，再调用正式规划。`file_volumes`只表明扫描文件的既定卷归属，用于错误和未执行计数，不表示远程写入已成功。

新建数据表前检查实际物理表数；沿用当前项目300张边界。其他程序的表、保留初始表和失败遗留表都占物理位置。满位时不删除别人的表、不让已有文件换卷。REPLACE不新建表，不需要临时空位。本阶段不设置“10个临时占位”。

## Base定位

有state token时先get_base检查可访问性和完整名称。token明确不存在，或返回名称与期望不符时，才按配置父目录及完整名称精确定位；名字多解失败。权限、网络、不完整响应不等于不存在，不据此另建Base。

历史卷找不到正确Base时失败，不自动重建整卷。新卷只有确实需要上传且首个文件本地读取成功后才创建。纯空目录、全SKIP、全解析失败不会创建新目录或新Base。

新/刷新Base token由state_store保存；token保存失败不得上传该卷。已正确保存的token不为SKIP重复写。Base内实际使用的目录交给已验收writer/client按需处理，不在run_sync重写目录API。

## 文件动作

| 情况 | 动作 |
|---|---|
| 新路径，最终名称未被占用 | CREATE |
| Hash相同，完整清单确认原table_id存在 | UNCHANGED，不调用reader或writer |
| Hash变化，原table_id存在 | REPLACE，以existing_table_id调用writer |
| 有映射，但原table_id确认不存在 | 原卷CREATE；成功后更新原映射，不追加重复路径 |
| 本地明确ABSENT，远程表仍存在 | REMOTE_ORPHAN；飞书和state都保留 |
| 文件读取/Hash/存在性未知 | 文件错误，不认定本地删除 |

正式名字被其他table_id占用时失败，不按名称接管。REPLACE的旧ID占用本文件正式名是允许情况。表结构和位置是否仍相符由writer在清records前检查。

## 简单覆盖与state

reader一次生成typed baseline；run_sync只传递，不重开源文件、不重算Hash、不改Decimal/百分比/日期/隐藏字段。所有单文件建表、字段、视图、清记录和新增记录由table_writer完成；run_sync不直接操作记录或字段。

writer返回明确WRITTEN并与本次Base、路径、Hash、名称、动作一致后才提交。新路径用 `commit_new_mapping`，已有映射用 `commit_existing_mapping`，expected参数取本轮加载的原映射。即使旧远程表不存在后重新CREATE，也仍更新原映射。

state保留 `Vxxx.json → {base_token, tables:[{local_path, table_id, file_hash}]}`。没有成功提交不更新file_hash、不增加成功计数。不保存field_map、record_id、row_key、Schema副本、过程日志或恢复标记。

覆盖可能先清空旧记录再写入失败，允许留下空表/部分新记录；不恢复旧数据。失败只报告事实，不自动删除整个业务表或再次提交。最后成功的state不等于失败后远程仍保有旧内容；人工重跑前须确认失败结果，不允许用清空state来掩盖问题。

## 新Base初始表

只处理本次成功create_base后、任何业务建表之前完整读取的初始表ID。若有明确default_table_id，必须与这份清单吻合；没有明确ID但清单恰好一张时，记录它为本轮初始表。零张无需处理；多张不猜测，报告问题。

首个业务文件写入且state成功提交后，按已记录ID删除初始表并确认。删除失败仅警告、保留占位，不撤销业务成功，不重复删除。后续运行不凭 `__sync_bootstrap__` 或“初始数据表”名称清理旧对象。

## 错误与汇总

一条源路径只有一个最终结果：CREATED、REPLACED、UNCHANGED、REMOTE_ORPHAN、FAILED、NOT_STARTED。数量来自最终结果集，不因一条路径产生多个诊断而重复计数。未开始而受阻计NOT_STARTED；已经进入读取/写入/提交后失败计FAILED。未枚举店铺的文件数保持未知，不虚构数量。

普通读取、Schema、明确单文件写入失败：该文件失败，其他文件继续。卷基础设施/清单错误：该卷待处理文件不执行。写入结果unknown：本文件失败并停止当前Base后续写入。店铺state预检失败：该店铺不开始；提交失败：保留写入表，停止该店铺后续上传，其他店铺可继续。AUTH_ERROR或明确401认证失败（包括writer包装的原因）停止整个运行。

所有原始错误与已确认写入事实保留，尤其 `completed_batches`、`confirmed_record_ids`、`submitted_batch_size`、`result_state`；未知不能改写为“写入0条”。不自动重试、回滚、清理失败业务表或重建state。

无错误/警告为SUCCESS；存在成功、未变化或保留历史内容且有其他错误/警告为PARTIAL_SUCCESS；没有成功内容的失败或全局认证中断为FAILED。已确认created/replaced计数不因后续其他文件失败抹掉。新Base初始表清理警告可使整轮PARTIAL_SUCCESS，但不把已完成文件改成FAILED。

每店输出计数、errors、warnings和最小逐文件files定位信息；顶层errors只保存整体输入/配置等问题。真实执行退出码0对应SUCCESS，其余1；纯本地PREVIEW退出码0。

## 动态选择契约

`resolve_scope(config, *, shops=None, all_shops=False, folders=None, reports=None, dates=None, date_ranges=None, files=None)` 只枚举目录元信息并匹配配置，不打开业务文件、不算Hash、不访问state或飞书。返回full_shop/filtered模式、规范化selectors、按店铺和relative_path排序去重的selected_paths、selected_count、empty_shops和warnings，不修改输入。

店铺必须显式 `--shop` 或 `--all`，互斥，任一显式店铺不存在整体失败。每次动态发现直接子目录，不能使用静态店铺名单或上次店铺。报表目录来自当前冻结Schema，相同report_name下全部变体组成报表族，按match.directory、非空match.stem和match.extensions匹配；不以某一变体排除同族文件，不猜新Schema。文件夹/文件选中的未登记结构照旧交reader报错。

完整相对目录/报表名精确存在时优先；唯一尾名可扩展，不同相对名称共用尾名则SCOPE_AMBIGUOUS，附候选。目录包含合法子目录，路径段边界严格。不同店同一个相对目录不构成歧义。R1原始评价目录保持 `店铺数据/商品评价`，清洗文件保持 `20_清洗数据/商品评价明细.xlsx`。

文件为精确店铺相对路径，允许反斜杠规范为 `/`，不能搜索同basename第一份。拒绝绝对路径、盘符、UNC、空段、`.`、`..`、NUL、通配符、不支持扩展名和超过两级目录的路径。保留名称空格与大小写。显式文件必须至少在一家所选店当前存在，历史state不能代替当前文件。

`parse_file_period(relative_path)` 优先解析去扩展名后末尾完整区间，然后单日；返回start/end规范日期，无末尾周期返回None。完整年份YYYY-M-D或YYYY-MM-DD经日历校验；前缀、父目录和mtime不参与。日期筛选只对满足其他维度的候选检查，非法日历日期/倒置区间报SOURCE_DATE_INVALID，不降级为最后一天。无日期限制的整店行为不受影响。

单日与同日起止区间等价；区间两个端点必须完全匹配，不按包含或相交匹配。无日期清洗表不按记录裁剪。Hermes先用真实当前时间解析相对日期，再传明确日期；无法区分累计区间和逐日批量时询问，逐日批量用多个date。

同维度多个条件OR，维度之间AND；date与date_range合为一个OR维度。所有命名条件先解析，组合后每个显式条件均须至少命中一个最终文件；任何未命中报SCOPE_NO_MATCH并定位条件，不能执行剩余部分。某一家店空而整体有命中时列empty_shops/warnings，该店不建立state、不访问远程、不计UNCHANGED。空的全店预览可返回0文件。

错误码：SCOPE_INVALID（参数/路径）、SHOP_NOT_FOUND、SCOPE_NOT_FOUND（对象不存在）、SCOPE_AMBIGUOUS、SCOPE_NO_MATCH、SCOPE_DATE_INVALID（输入日期）、SOURCE_DATE_INVALID（源末尾周期）、SCOPE_DISCOVERY_FAILED（目录不可可靠读取）。保留条件、候选、路径信息，目录访问失败不能当作空目录。

## 局部执行与完整state

scanner、required_volumes和plan_sync新增关键字selected_paths，None保留整店流程，空列表表示不选文件。局部任务只对所选文件打开和算Hash，目录清单只保留需要的父目录。选中后消失或不可读是所选文件错误，不扩大范围，不记历史孤儿。

局部任务仍读取完整店铺state，用全部历史映射校验唯一性、容量与原卷；未选孤儿仍占名额。只有所选新文件分配新名额，只查询本轮需要的Base，并读取其完整远程表清单判断冲突。不能裁剪state snapshot，不能清空或删除未选映射。

planner只为selected_paths生成结果，范围外文件不查询本地存在性、不报缺失或REMOTE_ORPHAN，不计UNCHANGED/FAILED。整店历史孤儿行为保持。仅提交实际成功的所选文件映射，保留已有锁和原子写入，不新增事务或恢复机制。

Hermes新组合先同范围preview再执行，回报实际店铺/条件/文件数。省略店铺但明确报表或文件夹使用all并回显店铺；空指令不执行。多店对应不同条件拆任务，不扩成交叉范围。自然语言名称不机械分词，完整参数安全传递；歧义列出明确候选。机器人验收在独立代码验收后部署，按生成的两条指令核对实际JSON，不能只用离线结果声称通过。
