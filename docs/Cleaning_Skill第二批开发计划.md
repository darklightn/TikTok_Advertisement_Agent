# TikTok Shop 数据清洗 Skill 第二批开发计划

## 一、开发目标

在现有第一阶段 Cleaning Skill 基础上，新增并跑通以下 4 张清洗表：

1. `广告户诊断.xlsx`
2. `素材诊断.xlsx`
3. `计划配置历史.xlsx`
4. `计划变更记录.xlsx`

第一阶段已经完成的 3 张表必须保持兼容：

- `广告户状态快照.xlsx`
- `计划小时表现.xlsx`
- `计划诊断.xlsx`

本轮结束后共实现 7 张表。剩余 9 张表不得提前开发。

---

## 二、目录权限

### 1. 唯一允许修改的目录

```text
D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning\
```

### 2. 四份冻结规范只读

```text
D:\TikTok-Agent\数据清洗\清洗目录结构.txt
D:\TikTok-Agent\数据清洗\清洗表与原始导出表依赖关系.txt
D:\TikTok-Agent\数据清洗\清洗字段来源关联与处理规则.txt
D:\TikTok-Agent\数据清洗\清洗表Upsert唯一键与写入规则.txt
```

禁止修改四份规范，禁止在 Skill 运行时动态解析这些自然语言文档。

### 3. 第一阶段验收测试只读

以下路径以本机实际第一阶段测试目录为准，例如：

```text
D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_v3\
```

### 4. 第二批验收测试只读

```text
D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch2\
```

两个测试目录均禁止修改、覆盖、重新生成。不得修改：

```text
LOCKED_TESTS.sha256
verify_lock.py
pytest.ini
requirements-test.txt
tests\*.py
fixtures\**
```

---

## 三、开始开发前的基线检查

### 1. 清理运行垃圾

从 Skill 目录删除：

```text
__pycache__/
*.pyc
.pytest_cache/
```

不得在 Skill 目录内创建 `.venv`。如需虚拟环境，放在 Skill 目录外。

### 2. 验证第一阶段没有回归

```powershell
$env:CLEANING_SKILL_ROOT = 'D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning'

cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_v3
python verify_lock.py
python -m pytest -q tests
```

预期：

```text
13 passed
```

如果本机第一阶段测试目录名不同，只替换路径，不修改测试内容。

### 3. 验证第二批测试包完整

```powershell
cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch2
python verify_lock.py
python -m pytest --collect-only -q tests
```

预期：

```text
OK: 25 locked files unchanged
24 tests collected
```

此时第二批功能尚未实现，不能通过全部测试属于正常现象；不得因此修改测试。

---

## 四、继续沿用的公开 CLI

不得新增另一套入口。继续使用：

```powershell
python scripts\run_cleaning.py `
  --shop-root "<店铺根目录>" `
  --target "<清洗表名>" `
  [--start-date YYYY-MM-DD] `
  [--end-date YYYY-MM-DD]
```

目标名允许带或不带 `.xlsx`。

第二批调用形式：

```powershell
python scripts\run_cleaning.py --shop-root "..." --target "广告户诊断" --start-date 2026-08-26 --end-date 2026-08-26
python scripts\run_cleaning.py --shop-root "..." --target "素材诊断" --start-date 2026-08-26 --end-date 2026-08-26
python scripts\run_cleaning.py --shop-root "..." --target "计划配置历史"
python scripts\run_cleaning.py --shop-root "..." --target "计划变更记录" --start-date 2026-08-26 --end-date 2026-08-26
```

成功退出码为 `0`；失败退出码非 `0`。缺源或处理失败时不得留下新的错误正式文件，也不得破坏已有正式文件。

---

## 五、本轮新增代码

建议新增：

```text
scripts/builders/
├─ advertiser_diagnosis.py
├─ creative_diagnosis.py
├─ campaign_config_history.py
└─ campaign_changes.py
```

同时允许修改：

```text
config/cleaning.yaml
scripts/source_locator.py
scripts/common.py
scripts/upsert.py
scripts/run_cleaning.py
SKILL.md
DEVELOPMENT_REPORT.md
```

公共模块只能进行第二批确实需要的通用扩展，不得推倒第一阶段结构。

---

## 六、cleaning.yaml 注册要求

### 1. 广告户诊断

```yaml
output: 广告户诊断.xlsx
builder: advertiser_diagnosis
requires_period: true
sources:
  - advertiser_overview
  - campaign_performance
  - advertiser_account_status
upsert:
  key: [广告户ID, 统计开始日期, 统计结束日期]
```

### 2. 素材诊断

```yaml
output: 素材诊断.xlsx
builder: creative_diagnosis
requires_period: true
sources:
  - campaign_product_creative_performance
  - shop_creative_hub_video
  - campaign_performance
  - campaign_product_performance
  - advertiser_account_status
```

素材 Upsert 键必须按素材类型区分：

```text
Video：
计划ID + 商品ID + Post ID + 统计开始日期 + 统计结束日期

Product card：
计划ID + 商品ID + 素材类型 + 统计开始日期 + 统计结束日期
```

计划ID缺失时，才按冻结规则使用计划名称回退。不要把内部键写进输出表头。

### 3. 计划配置历史

```yaml
output: 计划配置历史.xlsx
builder: campaign_config_history
requires_period: false
sources:
  - campaign_current_config
  - advertiser_account_status
upsert:
  primary_key: [计划ID, 采集日期]
  plan_name_fallback: [计划名称, 采集日期]
```

### 4. 计划变更记录

```yaml
output: 计划变更记录.xlsx
builder: campaign_changes
requires_period: true
sources:
  - campaign_change_log
  - advertiser_account_status
upsert:
  primary_key: [计划ID, 变更ID]
  plan_name_fallback: [计划名称, 变更ID]
```

四张表的 `columns` 必须逐字、逐序复制冻结表头，不得增加调试列或内部键列。

---

## 七、source_locator.py 扩展要求

## 1. 广告户诊断

读取：

```text
广告户数据/GMV Max 计划总览/
计划数据/GMV Max 计划表现/
广告户数据/广告账户状态/
```

文件选择：

- `GMV Max 计划总览`无论单日还是多日，均精确匹配：

```text
广告户名称__开始日期_至_结束日期.xlsx
```

- `GMV Max 计划表现`：

```text
单日：计划名称__YYYY-MM-DD.xlsx
多日：计划名称__开始日期_至_结束日期.xlsx
```

- 读取目标区间内全部计划表现文件。
- 同目录中的包含区间、被包含区间和部分重叠区间全部忽略。
- 广告账户状态选择最新采集日期文件。
- 精确区间计划总览不存在、精确区间计划表现一个都不存在、账户快照不存在时，按缺少原始数据处理。

## 2. 素材诊断

读取：

```text
计划数据/GMV Max 计划商品素材表现/
店铺数据/店铺素材中心视频/
计划数据/GMV Max 计划表现/
计划数据/GMV Max 计划商品表现/
广告户数据/广告账户状态/
```

文件选择：

- 计划表现、计划商品表现使用第一阶段已经验证的精确区间规则。
- 计划商品素材表现无论单日还是多日，文件尾部都精确匹配：

```text
__开始日期_至_结束日期.xlsx
```

- 店铺素材中心视频精确匹配：

```text
开始日期_至_结束日期.xlsx
```

- 不读取重叠区间文件。
- 素材文件名可能因长度被截断并带哈希，不得要求文件名中的商品名称与完整商品名称逐字符完全一致后才读取文件。
- 素材原始 `product_id` 有值时，以原始值为准。
- 原始 `product_id` 缺失时，才执行“同一计划 + 文件商品上下文 → 计划商品表现商品名称精确唯一匹配”。无法唯一命中时保留空值，最终由唯一键规则阻断写入。

## 3. 计划配置历史

读取：

```text
计划数据/GMV Max 当前配置/
广告户数据/广告账户状态/
```

规则：

- 从全部当前配置文件中按计划分组。
- 每个计划只选择文件名采集日期最新的一份。
- 不允许因为某个计划最新日期与另一个计划不同，就丢弃较早日期的那个计划。
- 账户快照选择最新文件。
- 当前配置目录无有效配置文件或账户快照不存在时失败。

## 4. 计划变更记录

读取：

```text
计划数据/GMV Max 计划变更记录/
广告户数据/广告账户状态/
```

规则：

- 文件名无论单日还是多日均精确匹配：

```text
计划名称__开始日期_至_结束日期.xlsx
```

- 读取该精确区间下所有计划文件。
- 精确区间文件可以只有表头、没有变更行；这是有效空数据，不是缺源。
- 只要至少存在一个精确区间变更文件，就允许生成表头完整、数据行为 0 的清洗表。
- 只有重叠区间文件、没有精确区间文件时，按缺源失败。

---

## 八、Builder 规则

## 1. advertiser_diagnosis.py

输出一行：一个广告户在一个统计区间的表现。

必须实现：

- `统计天数 = end_date - start_date + 1`。
- 店铺ID、广告户ID、广告户名称来自最新广告账户状态。
- 计划总数按 `campaign_id` 去重。
- 运行计划只计：

```text
campaign_primary_status = delivery_ok
且
campaign_status = campaign_delivery_ok
```

- 有消耗计划：按计划聚合后 `cost > 0`。
- 计划总览优先读取 `时间 = -` 的总计行。
- 存在总计行时不得再把小时明细与总计行一起求和。
- 无总计行时才汇总明细。
- 广告展示量、点击量来自全部精确区间计划表现求和。
- CTR、CPC、CPM、平均下单成本、实际ROI全部按基础分子分母重算。
- 分母为0或空时留空。
- 币种必须得到唯一值，否则报币种冲突。

## 2. creative_diagnosis.py

输出粒度：一个计划中的一个商品下面的一条素材，在一个统计区间的表现。

必须实现：

- 从素材文件名解析计划名称和商品上下文。
- 计划名称与计划表现关联取得计划ID。
- 商品ID优先使用素材行原始 `product_id`。
- 原始商品ID缺失时，只允许按同计划、文件商品上下文精确唯一匹配计划商品表现。
- 商品名称优先从计划商品表现按计划+商品ID取得；无法取得时再使用文件商品上下文。
- 素材中心关联键必须为：

```text
Video ID + Product ID
```

不得只用 Video ID。

字段优先级：

- 素材标题：Creative有效值 → 素材中心视频标题。
- TikTok账号：TikTok account有效值 → 素材中心Username。
- 素材来源：Creative source有效值 → 素材中心Video source。
- 发布时间：素材表现Time posted有效值 → 素材中心Time posted。
- 授权类型、授权状态、预审状态只从素材中心补充；Product card保持空值。

计算规则：

- 成本占计划比 = 素材成本 ÷ 对应计划成本。
- 订单占计划比 = 素材订单数 ÷ 对应计划订单数。
- 收入占计划比 = 素材收入 ÷ 对应计划收入。
- 平均下单成本、实际ROI、商品广告点击率重算。
- Ad conversion rate和各视频播放率原始值已是0—1小数，直接保留，不除以100。
- Product card的Post ID和视频播放率为空；广告转化率可保留原始值。
- `0`必须保留为0，不能当空值。

内部素材键：

- Video：计划ID+商品ID+Post ID+统计区间。
- Product card：计划ID+商品ID+素材类型+统计区间。

输出Excel中以下字段必须按百分比显示：

```text
成本占计划比
订单占计划比
收入占计划比
商品广告点击率
广告转化率
2秒、6秒、25%、50%、75%、100%广告视频播放率
```

## 3. campaign_config_history.py

输出粒度：一个计划在一个采集日期的配置。

必须解析：

```text
configuration_json.ad_info
configuration_json.campaign_info
```

必须实现：

- 采集日期来自文件内容或文件名，二者冲突时报错。
- 计划ID、计划名称来自外层字段；外层缺失时可用JSON同名字段补充，但不得制造ID。
- 目标ROI、预算、预算模式、优化模式、自动预算、有效预算、促销日设置、时间、视频模式、新素材探索、国家按冻结JSON路径读取。
- 布尔值输出为真正的布尔值，不输出字符串 `"true"` / `"false"`。
- 推广商品数按 `spu_id` 去重。
- 推广商品ID列表：转文本、去重、排序，以英文分号 `;` 连接。
- 每次运行只处理每个计划的最新配置文件。
- Upsert后旧采集日期的历史行继续保留，新采集日期新增。

## 4. campaign_changes.py

输出粒度：一条平台变更记录。

必须实现：

- 计划名称从文件名日期后缀之前解析。
- 计划ID读取外层 `campaign_id`。
- 变更ID优先外层 `change_id`，缺失时使用 `change_record_json.id`。
- 两处均为空时不能生成唯一键，整次目标表写入失败并保留旧文件。
- 变更时间、对象类型、对象ID、操作人解析JSON。
- 变更摘要：`activity_details[].value`去空后按原顺序用中文分号连接。
- 变更详情：`activity_details[].hover`去空后按原顺序用中文分号连接；全部为空则留空。
- 精确区间文件全部为空时仍然成功，生成只有冻结表头的Excel。
- 同一计划ID+变更ID再次出现时整行替换，不重复追加。

---

## 九、公共组件扩展要求

### 1. common.py

保留现有：

```text
worksheet.reset_dimensions()
```

不得恢复为会误读TikTok错误dimension元数据的读取方式。

补充或核对：

- `PERCENT_COLUMNS`包含素材三项计划占比。
- `ID_COLUMNS`至少包含本批使用的计划ID、商品ID、Post ID、对象ID、变更ID、广告户ID、店铺ID。
- Excel中的ID列按文本格式写入。
- 零值不转空。
- 不在多个Builder重复实现同一通用格式化函数。

### 2. upsert.py

必须在不破坏第一阶段的情况下支持素材类型分支键。

推荐做成通用配置驱动的键变体，而不是在 `upsert.py` 内硬编码“素材诊断”表名。例如：

```yaml
upsert:
  key_variants:
    - when: {素材类型: Product card}
      primary_key: [计划ID, 商品ID, 素材类型, 统计开始日期, 统计结束日期]
      plan_name_fallback: [计划名称, 商品ID, 素材类型, 统计开始日期, 统计结束日期]
    - default: true
      primary_key: [计划ID, 商品ID, Post ID, 统计开始日期, 统计结束日期]
      plan_name_fallback: [计划名称, 商品ID, Post ID, 统计开始日期, 统计结束日期]
```

具体配置结构可调整，但行为必须与冻结唯一键一致。

原子写入、临时文件校验、备份、替换后校验和失败回滚继续沿用第一阶段，不得降级。

---

## 十、开发及测试顺序

## 阶段 A：注册目标与公共扩展

完成：

- cleaning.yaml增加4张表。
- source_locator增加4类路由。
- common/upsert增加必要通用能力。
- 四个Builder先建立统一接口，但不写假成功空实现。

运行：

```powershell
cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch2
python -m pytest -q tests\test_05_contract.py
```

并立即回归第一阶段13个测试。

## 阶段 B：广告户诊断

```powershell
python -m pytest -q tests\test_01_advertiser_diagnosis.py
```

通过后运行：

```powershell
python -m pytest -q tests\test_01_advertiser_diagnosis.py tests\test_05_contract.py
```

再运行第一阶段13个回归测试。

## 阶段 C：素材诊断

```powershell
python -m pytest -q tests\test_02_creative_diagnosis.py
```

通过后累计运行第二批当前全部已实现测试，并回归第一阶段。

## 阶段 D：计划配置历史

```powershell
python -m pytest -q tests\test_03_campaign_config_history.py
```

通过后累计运行并回归第一阶段。

## 阶段 E：计划变更记录

```powershell
python -m pytest -q tests\test_04_campaign_changes.py
```

通过后运行真实结构冒烟测试：

```powershell
python -m pytest -q tests\test_06_real_export_smoke.py
```

---

## 十一、最终验收

### 1. 第一阶段测试锁与回归

```powershell
cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_v3
python verify_lock.py
python -m pytest -q tests
python verify_lock.py
```

预期：

```text
13 passed
```

### 2. 第二批测试锁与验收

```powershell
cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch2
python verify_lock.py
python -m pytest -q tests
python verify_lock.py
```

预期：

```text
24 passed
OK: 25 locked files unchanged
```

不得有：

```text
failed
error
skip
xfail
```

### 3. 清理项目目录

交付前删除：

```text
__pycache__/
*.pyc
.pytest_cache/
```

Skill目录内不得出现 `.venv`，不得复制外部测试和真实测试fixture。

---

## 十二、禁止事项

- 不得修改两个外部测试目录。
- 不得修改四份冻结业务规范。
- 不得通过读取测试预期文件生成清洗结果。
- 不得硬编码测试店铺、计划、商品、日期、金额或行数。
- 不得为通过真实冒烟测试写 `if 美妆001`、`if 2026-08-26` 等分支。
- 不得读取重叠区间补替精确区间。
- 不得把 Product card 的 N/A Post ID写成字符串主键。
- 不得只用 Post ID 关联素材中心而忽略 Product ID。
- 不得让Builder自行查找文件、Upsert或写正式Excel。
- 不得让清洗表读取其他清洗表。
- 不得调用导出Skill补文件。
- 不得开发剩余9张表。
- 不得移除第一阶段已经加入的 `worksheet.reset_dimensions()` 修复。

---

## 十三、DEVELOPMENT_REPORT.md

完成后更新报告，至少写明：

1. 新增和修改的文件。
2. 4张表的Builder与source locator实现。
3. 素材类型分支唯一键的实现方式。
4. 执行过的全部测试命令。
5. 第一阶段回归结果：13 passed。
6. 第二批结果：24 passed。
7. 两个测试锁结果。
8. 仍未实现的9张表。
9. 已知限制。
10. 明确声明未修改冻结规范、测试、真实fixture。

完成后停止，不自行进入下一批开发。
