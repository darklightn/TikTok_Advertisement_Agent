# TikTok Shop 数据清洗 Skill 开发报告

## 1. 完成范围

第一阶段仅实现以下三张清洗表：

1. `广告户状态快照.xlsx`
2. `计划小时表现.xlsx`
3. `计划诊断.xlsx`

第二批在此基础上新增 `广告户诊断.xlsx`、`素材诊断.xlsx`、`计划配置历史.xlsx`、`计划变更记录.xlsx`。第三批新增 `订单经营明细.xlsx`、`退货退款明细.xlsx`、`商品评价明细.xlsx`、`营销活动明细.xlsx`、`店铺健康明细.xlsx`、`履约表现明细.xlsx`。最终批新增 `SKU状态库存明细.xlsx`、`商品经营诊断.xlsx`、`店铺诊断.xlsx`。当前共实现全部16张表；未调用数据导出 Skill，也未修改冻结业务规范或外部验收测试。

## 2. 新增文件

```text
SKILL.md
requirements.txt
config/cleaning.yaml
scripts/__init__.py
scripts/common.py
scripts/run_cleaning.py
scripts/source_locator.py
scripts/upsert.py
scripts/builders/__init__.py
scripts/builders/advertiser_status.py
scripts/builders/campaign_hourly.py
scripts/builders/campaign_diagnosis.py
scripts/builders/advertiser_diagnosis.py
scripts/builders/creative_diagnosis.py
scripts/builders/campaign_config_history.py
scripts/builders/campaign_changes.py
scripts/builders/orders.py
scripts/builders/refunds.py
scripts/builders/ratings.py
scripts/builders/promotions.py
scripts/builders/shop_health.py
scripts/builders/fulfillment.py
scripts/builders/product_common.py
scripts/builders/sku_inventory.py
scripts/builders/product_diagnosis.py
scripts/builders/shop_diagnosis.py
DEVELOPMENT_REPORT.md
```

Skill 项目目录不包含虚拟环境；本轮已确认 `.venv/`、所有 `__pycache__/` 和 `*.pyc` 均已移除。验收使用项目目录外的 `D:\TikTok-Agent\数据清洗\.cleaning-test-venv\`。

## 3. 项目结构

```text
tiktok-shop-data-cleaning/
├─ SKILL.md
├─ requirements.txt
├─ config/
│  └─ cleaning.yaml
├─ scripts/
│  ├─ __init__.py
│  ├─ common.py
│  ├─ run_cleaning.py
│  ├─ source_locator.py
│  ├─ upsert.py
│  └─ builders/
│     ├─ __init__.py
│     ├─ advertiser_status.py
│     ├─ advertiser_diagnosis.py
│     ├─ campaign_hourly.py
│     ├─ campaign_diagnosis.py
│     ├─ creative_diagnosis.py
│     ├─ campaign_config_history.py
│     ├─ campaign_changes.py
│     ├─ orders.py
│     ├─ refunds.py
│     ├─ ratings.py
│     ├─ promotions.py
│     ├─ shop_health.py
│     ├─ fulfillment.py
│     ├─ product_common.py
│     ├─ sku_inventory.py
│     ├─ product_diagnosis.py
│     └─ shop_diagnosis.py
└─ DEVELOPMENT_REPORT.md
```

## 4. 实现说明

### 公共 CLI

唯一入口：

```powershell
python scripts\run_cleaning.py `
  --shop-root "<店铺根目录>" `
  [--shop-id "<sellerId>"] `
  --target "<清洗表名>" `
  [--start-date YYYY-MM-DD] `
  [--end-date YYYY-MM-DD]
```

- 目标名接受带或不带 `.xlsx` 的形式。
- 区间表强制校验完整日期范围。
- 成功和失败均输出 UTF-8 JSON；成功退出码为 0，失败为非 0。
- 当前16张表之外的目标明确返回尚未实现，不生成空表。
- 退款、评价、营销活动、健康和履约必须传入`--shop-id`；订单经营明细不强制该参数。Hermes必须使用当前绑定店铺的sellerId，不按店铺名猜测。

### 公共组件

- `common.py`：上下文与源文件类型、ID/文本/日期/时间/小时/金额标准化、空值处理、安全除法、JSON/Excel/CSV 读取、格式化 Excel 写入。
- `source_locator.py`：最新广告账户快照、小时表现日期范围文件、计划诊断精确区间文件、最新配置与最新 `items` 定位；`summary` 不进入候选文件。
- `upsert.py`：有序复合键、计划 ID 优先与计划名称兜底、候选和历史重复键检查、整行替换、安全临时写入、旧文件备份、原子替换、最终校验与失败回滚。
- 第二批为素材诊断增加配置驱动的 `key_variants`：Product card 使用素材类型分支键，Video 使用 Post ID 分支键；两种分支均继续支持计划名称回退，未在 Upsert 中硬编码表名。

### 广告户状态快照

- 解析最新 `广告账户状态` 的 `account_snapshot_json`。
- 按 `advertiser_id` 精确选择 `authorization.autho_info_list[]` 项。
- 输出账户、授权、支付、币种和时区字段。
- Upsert 键为 `广告户ID + 采集日期`。
- 冲突重复键在正式写入前失败，已有正式文件保持字节不变。

### 计划小时表现

- 读取指定日期范围内所有已存在的逐日文件，忽略范围外文件。
- 重新计算 CTR、CPC、CPM、平均下单成本和实际 ROI。
- 分母为 0 或空时衍生指标留空。
- Upsert 键为 `计划ID + 日期 + 小时`；计划 ID 缺失时使用计划名称兜底。

### 计划诊断

- 只读取与清洗日期完全匹配的计划表现、计划商品表现和计划商品素材表现。
- 计划表现、计划商品表现的单日文件使用 `YYYY-MM-DD` 后缀；计划商品素材表现无论单日或多日均使用 `start_至_end` 后缀。
- 每计划选择最新当前配置和最新 `items`；完全忽略 `summary`。
- 缺少 `items` 文件时失败且不创建错误正式文件；文件存在但仅有表头或没有 ROI 建议时，保留文件名中的快照日期并将建议字段留空。
- ROI 竞争力百分位按来源固定规则从 75 转换为底层 0.75。
- 重新计算 CTR、CPC、CPM、平均下单成本和实际 ROI。
- 商品按 Product ID 去重；素材按 Video/Product card 各自内部键聚合后统计可用与有消耗数量。
- Upsert 键为 `计划ID + 统计开始日期 + 统计结束日期`；计划 ID 缺失时使用计划名称兜底。

## 5. 第一阶段修复与验收（2026-09-04）

本轮只修复两项：

1. 将计划表现/计划商品表现与计划商品素材表现的日期后缀分开定位和解析，修复单日素材文件必须使用 `start_至_end` 的规则。
2. 将“items 文件存在但无数据行”与“items 文件缺失”分开处理；仅表头文件不再阻断计划诊断，快照日期照常保留，建议字段留空。

修复前、修复后分别在只读目录 `D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_v3\` 执行测试锁校验，结果均为：

```text
OK: 9 locked test files unchanged
```

两个新增边界测试结果：

```text
2 passed in 2.62s
```

第一阶段全部外部验收测试结果：

```text
13 passed in 10.69s
```

没有 `failed`、`xfail` 或 `skip`。测试运行时设置 `PYTHONDONTWRITEBYTECODE=1` 并禁用 pytest 缓存，未向外部测试目录写入缓存或字节码。

修复后递归检查 Skill 项目目录，`.venv/`、`__pycache__/` 和 `*.pyc` 数量均为 0。

## 6. 第二批实现与验收（2026-09-04）

### 新增表

- `广告户诊断.xlsx`：精确区间计划总览与计划表现；总计行优先；计划状态和消耗按计划去重；所有比例按基础量重算。
- `素材诊断.xlsx`：精确区间素材、素材中心、计划与商品关联；素材中心使用 `Video ID + Product ID`；支持商品ID唯一回退和 Video/Product card 分支键。
- `计划配置历史.xlsx`：每计划选择最新配置文件；校验文件名与内容采集日期；展开配置JSON、布尔开关和去重排序后的商品ID。
- `计划变更记录.xlsx`：精确区间变更文件；展开变更JSON；外层或JSON变更ID回退；精确文件全空时生成完整表头零数据行。

### 实际测试结果

- 阶段A契约：`5 passed`
- 广告户诊断专项：`3 passed`；累计契约：`8 passed`
- 素材诊断专项：`4 passed`；累计：`12 passed`
- 计划配置历史专项：`3 passed`；累计：`15 passed`
- 计划变更记录专项：`5 passed`
- 真实结构冒烟：`4 passed`
- 第二批完整验收：`24 passed in 26.03s`
- 每张表完成后的第一阶段回归均为：`13 passed`

### 实际验收命令

所有命令均设置：

```powershell
$env:CLEANING_SKILL_ROOT = 'D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning'
$env:PYTHONUTF8 = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$python = 'D:\TikTok-Agent\数据清洗\.cleaning-test-venv\Scripts\python.exe'
```

第二批依次执行：

```powershell
& $python -m pytest -q -p no:cacheprovider tests\test_05_contract.py
& $python -m pytest -q -p no:cacheprovider tests\test_01_advertiser_diagnosis.py tests\test_05_contract.py
& $python -m pytest -q -p no:cacheprovider tests\test_01_advertiser_diagnosis.py tests\test_02_creative_diagnosis.py tests\test_05_contract.py
& $python -m pytest -q -p no:cacheprovider tests\test_01_advertiser_diagnosis.py tests\test_02_creative_diagnosis.py tests\test_03_campaign_config_history.py tests\test_05_contract.py
& $python -m pytest -q -p no:cacheprovider tests\test_04_campaign_changes.py
& $python -m pytest -q -p no:cacheprovider --basetemp 'T:\p' tests\test_06_real_export_smoke.py
& $python -m pytest -q -p no:cacheprovider --basetemp 'T:\p' tests
& $python '\\?\D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch2\verify_lock.py'
```

每完成一张第二批表后，均在第一阶段验收目录执行：

```powershell
& $python -m pytest -q -p no:cacheprovider tests
& $python verify_lock.py
```

第二批 fixture 中一个素材文件完整路径达到 Windows 传统 260 字符边界。测试锁使用 `\\?\` 扩展路径，真实结构测试使用项目目录外的短盘符临时目录；未修改测试或 fixture。

最终收口复核：第二批完整套件此前已取得 `24 passed in 26.03s`；最后一次代码改动仅将 CLI 中残留的“第一阶段”提示改为阶段无关文案，随后第二批契约复验为 `5 passed in 4.09s`，第一阶段完整回归为 `13 passed in 13.47s`。第一阶段测试锁为 `OK: 9 locked test files unchanged`，第二批测试锁为 `OK: 25 locked files unchanged`。受“唯一允许修改 Skill 目录”执行策略限制，收口时没有再次在 Skill 外创建短路径测试临时目录；被拒绝的重复复跑未产生文件变更，不影响此前已经完成的 24 项完整验收结果。

## 7. 最终批范围

最终批已实现 `SKU状态库存明细.xlsx`、`商品经营诊断.xlsx` 和 `店铺诊断.xlsx`；至此冻结目录中的16张表均已有独立 Builder，清洗表之间不互相作为数据源。

## 8. 已知限制

- 第一阶段回归通过；第二批本轮合成测试通过，但真实结构复跑受Windows长路径限制；第三批真实fixture缺失，完整验收仍被测试资产阻塞。
- 原始文件定位严格依赖冻结规范中的目录和文件命名约定。
- 当前不建设复杂文件锁；执行层必须保证同一店铺、同一目标清洗表不会并发执行。
- 项目当前使用 Git 管理；本报告记录的是工作区内尚未提交的本轮修复。

## 9. 保护声明

- 未修改以下四份冻结规范：
  - `清洗目录结构.txt`
  - `清洗表与原始导出表依赖关系.txt`
  - `清洗字段来源关联与处理规则.txt`
  - `清洗表Upsert唯一键与写入规则.txt`
- 未修改、覆盖或重新生成三个验收目录中的任何测试、fixture、`verify_lock.py`或`LOCKED_TESTS.sha256`。
- 最终批开始前未预建剩余3张表；本轮仅按最终批计划实现这3张表。

## 10. 第三批实现与验收（2026-09-04）

### 实现内容

- CLI新增可选`--shop-id`，五张需要店铺ID的目标在定位源文件前执行`MISSING_SHOP_ID`门禁；旧7张表和订单经营明细保持兼容。
- 区间源严格定位`start_至_end`；退款、健康和履约选择最新快照；退款读取全部订单历史；订单关联最新`skus__`快照。
- 增加UTC时间去时区但不改时刻、订单月/日/年时间、工作簿`Currency`自定义属性、百分比字符串转换和动态单元格百分比格式。
- Upsert新增配置驱动的`latest_by`与内部`采集日期=date(采集时间)`派生键；支持新状态替换、旧状态跳过、同时间异内容冲突回滚。

六张表的唯一键：

```text
订单经营明细：订单ID + SKU ID
退货退款明细：售后单号（latest_by=采集时间）
商品评价明细：订单ID + 商品ID + SKU ID
营销活动明细：营销活动ID + 统计开始日期 + 统计结束日期
店铺健康明细：内部采集日期 + 类别 + 指标（latest_by=采集时间）
履约表现明细：内部采集日期 + 类别 + 指标（latest_by=采集时间）
```

### 分阶段实际结果

```text
阶段A 商品评价+营销活动：7 passed in 8.32s
阶段B 订单经营明细：6 passed in 5.49s
阶段C 退货退款明细：4 passed in 5.04s
阶段D 店铺健康+履约表现：6 passed in 9.42s
第三批CLI契约：15 passed in 9.31s
第三批除真实冒烟外全部测试：38 passed in 38.90s
```

第一阶段最终回归及锁：

```text
OK: 9 locked test files unchanged
13 passed in 10.61s
OK: 9 locked test files unchanged
```

第二批本轮复跑结果：

```text
20 passed, 4 setup errors
OK: 25 locked files unchanged
```

4个setup error均发生在`shutil.copytree`复制超长锁定素材文件时，尚未执行Skill断言；此前第二批完整验收记录仍为`24 passed`，但本轮修改后的完整24项没有在当前路径约束下重新取得。

第三批当前阻塞证据：

```text
38 passed
6 setup errors: fixtures/real_export/TK蚊帐1店 不存在
锁校验缺少8个清单内fixture，无法得到 OK: 20 locked files unchanged
```

因此第三批代码的合成测试与CLI契约已通过，但计划要求的`44 passed`、第三批锁`OK: 20`和后续真实店铺调用尚未完成。按照只读测试边界，没有补造或复制fixture到验收目录；由于外部测试尚未全部通过，也未对真实店铺的`20_清洗数据`执行写入。

第三批到此停止；恢复锁清单中的8个原始fixture后，需要重新运行三批完整测试和第三批真实数据门禁。

## 11. 最终批实现与验收（2026-09-04）

### 实现文件与16张表支持

最终批修改 `config/cleaning.yaml`、`scripts/common.py`、`scripts/source_locator.py`、`SKILL.md` 和本报告，新增：

```text
scripts/builders/product_common.py
scripts/builders/sku_inventory.py
scripts/builders/product_diagnosis.py
scripts/builders/shop_diagnosis.py
```

CLI现已支持全部16张固定清洗表；最后3张分别为 `SKU状态库存明细`、`商品经营诊断` 和 `店铺诊断`。三张表只读取冻结依赖关系规定的原始导出表，不读取任何清洗表，也没有针对测试中的固定ID、店铺名或日期写特例。

### 最终3张表实现口径

- `SKU状态库存明细`：读取最新 `products__`、`skus__`、库存快照和成本表；严格解析商品/SKU JSON，按冻结唯一键 `SKU ID + 采集日期` Upsert。
- `商品经营诊断`：解析商品分析表现的多级表头，并结合商品、SKU、计划商品表现、素材表现和成本原始表；按 Product ID 汇总，成本为空时成本、毛利和保本ROI保持空值。
- `店铺诊断`：直接从计划总览、商品分析表现、订单明细、健康、履约、退款、商品评价和营销活动原始表计算店铺级结果；总计行优先，不与明细重复相加；按 `店铺ID + 统计开始日期 + 统计结束日期` Upsert。
- 公共数值处理增加了原始导出占位值 `--` 的空值语义；没有将ID、金额或普通文本粗暴转换为同一类型。Upsert仍保留同唯一键、同采集时间但业务内容不同的 `DATA_CONFLICT` 保护。

### 最终批合成验收与锁

按计划顺序逐阶段执行：

```text
配置和公共组件：7 passed
SKU状态库存明细累计：16 passed
商品经营诊断累计：28 passed
最终批完整验收：35 passed
最终批测试锁：OK: 8 locked files unchanged
```

第一阶段有效回归：

```text
13 passed
OK: 9 locked test files unchanged
```

第二批本轮结果为 `20 passed, 4 setup errors`；4个错误均发生在测试fixture通过 `shutil.copytree` 复制超长素材路径时，尚未调用Skill。第二批锁目录自身缺少锁清单中的该长路径文件，因此本轮锁校验不能得到OK。

第三批本轮结果为 `38 passed, 6 setup errors`；6个错误均发生在测试fixture准备阶段，因为锁清单声明的 `fixtures/real_export/TK蚊帐1店` 原始fixture不存在，尚未调用Skill。第三批锁校验同样报告缺少8个清单内fixture。遵守只读边界，未补造、复制或修改这些外部测试资产。

### 两家真实店铺全量运行

使用 `2026-08-01` 至 `2026-08-26` 区间运行两家店铺，快照类目标按各自规则读取最新适用快照。两家店铺的 `20_清洗数据` 均正好生成16张固定工作簿：

| 清洗表 | 美妆001行数 | TK蚊帐1店行数 |
|---|---:|---:|
| 广告户状态快照 | 1 | 1 |
| 计划配置历史 | 2 | 2 |
| 退货退款明细 | 0 | 239 |
| 店铺健康明细 | 10 | 13 |
| 履约表现明细 | 10 | 10 |
| SKU状态库存明细 | 50 | 678 |
| 广告户诊断 | 2 | 2 |
| 计划诊断 | 4 | 4 |
| 素材诊断 | 92 | 3130 |
| 计划小时表现 | 1248 | 1248 |
| 计划变更记录 | 0 | 10 |
| 订单经营明细 | 213 | 9314 |
| 商品评价明细 | 17 | 810 |
| 营销活动明细 | 4 | 30 |
| 商品经营诊断 | 10 | 32 |
| 店铺诊断 | 1 | 1 |

相同店铺、相同区间再次运行最后3张表后，行数保持不变：美妆001为 `50 / 10 / 1`，TK蚊帐1店为 `678 / 32 / 1`。随后读取全部32个输出工作簿，16种唯一键均无重复；所有ID列均保持文本；最终3张表中的百分比列使用 `0.00%`；健康和履约均采用最新 `2026-09-04` 快照。

两家真实成本表当前均只有表头，因此“有完整成本的SKU”没有可抽查样本；全部商品的成本、毛利和保本ROI按规则留空。TK蚊帐1店存在6个当前可售但区间无商品表现的商品。两家当前样本均不存在“已删除/下架且区间有历史表现”的商品，也不存在同时关联多个计划且多个素材的商品；这些分支由合成验收覆盖，真实样本状态记为 `NO_SAMPLE`，不伪报真实抽查通过。

### Skill瘦身与保护声明

- 已移除项目内全部 `__pycache__` 和 `*.pyc`；递归检查 `.venv`、`.pytest_cache`、`__pycache__`、`*.pyc` 均为0。
- 项目未包含外部验收测试包、测试fixture、真实店铺原始数据或四份冻结规范。
- 未修改四份冻结业务规范。
- 未修改、覆盖或重新生成任何外部测试、fixture、`verify_lock.py` 或 `LOCKED_TESTS.sha256`。
