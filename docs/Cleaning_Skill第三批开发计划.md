# TikTok Shop 数据清洗 Skill 第三批开发计划

## 一、开发目标

在现有 Cleaning Skill 基础上完成第三批 6 张清洗表：

1. `订单经营明细.xlsx`
2. `退货退款明细.xlsx`
3. `商品评价明细.xlsx`
4. `营销活动明细.xlsx`
5. `店铺健康明细.xlsx`
6. `履约表现明细.xlsx`

当前已完成的 7 张表必须保持兼容并继续通过全部回归测试。

本阶段不得实现剩余 3 张复杂表：

```text
SKU状态库存明细.xlsx
商品经营诊断.xlsx
店铺诊断.xlsx
```

第三批完成并通过全部独立验收测试后停止开发，更新开发报告，等待第四批计划。

---

## 二、目录与修改边界

### 1. 唯一允许修改的目录

```text
D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning\
```

实现代码、配置、SKILL.md 和开发报告只能在该目录修改。

### 2. 冻结规范，只读

```text
D:\TikTok-Agent\数据清洗\清洗目录结构.txt
D:\TikTok-Agent\数据清洗\清洗表与原始导出表依赖关系.txt
D:\TikTok-Agent\数据清洗\清洗字段来源关联与处理规则.txt
D:\TikTok-Agent\数据清洗\清洗表Upsert唯一键与写入规则.txt
```

不得修改四份冻结规范；不得在运行时解析这些自然语言文档。规则必须固化到 `cleaning.yaml` 和 Python 代码。

### 3. 外部测试目录，只读

```text
D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_v3\
D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch2\
D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch3\
```

禁止修改、覆盖、重新生成其中任何测试、fixture、`verify_lock.py` 或 `LOCKED_TESTS.sha256`。

### 4. 原始数据与数据导出项目，只读

原始导出目录和数据导出 Skill 只允许读取、核对，不得修改；清洗阶段不得调用导出 Skill 补数据。

---

## 三、第三批新增 CLI 运行上下文

第三批中除`订单经营明细`外，其余 5 张表的 `店铺ID`按照冻结规范由运行上下文提供，不新增广告账户状态等隐藏依赖。`订单经营明细`本身不包含店铺ID字段。

在现有 CLI 中增加可选参数：

```text
--shop-id <TikTok Shop sellerId>
```

完整调用形式：

```powershell
python scripts\run_cleaning.py `
  --shop-root "<店铺根目录>" `
  --shop-id "<sellerId>" `
  --target "<清洗表名>" `
  [--start-date YYYY-MM-DD] `
  [--end-date YYYY-MM-DD]
```

要求：

1. `CleaningContext`新增：

```python
shop_id: str | None
```

2. 以下第三批目标必须提供 `--shop-id`：

```text
退货退款明细
商品评价明细
营销活动明细
店铺健康明细
履约表现明细
```

`订单经营明细`不包含店铺ID字段，因此不强制要求`--shop-id`；传入时可以保留在运行上下文中，但不得新增到输出表头。

3. 未提供时，在源文件定位之前返回：

```json
{"status":"error","code":"MISSING_SHOP_ID","message":"该目标表必须提供 --shop-id"}
```

并且不得生成正式清洗文件。

4. 第一阶段和第二批原命令不传 `--shop-id` 时仍必须保持兼容。

5. `shop_id`必须按文本保存，不能转数值、不能丢精度。

6. 更新 `SKILL.md`，明确 Hermes 调用第三批目标时必须传入当前绑定店铺的 sellerId。

---

## 四、第三批项目增量结构

在现有项目中新增：

```text
tiktok-shop-data-cleaning/
├─ config/
│  └─ cleaning.yaml                    # 注册新增6张表
├─ scripts/
│  ├─ run_cleaning.py                  # 增加--shop-id
│  ├─ common.py                        # 增加本批通用解析能力
│  ├─ source_locator.py                # 增加本批文件定位
│  ├─ upsert.py                        # 增加最新状态时间保护
│  └─ builders/
│     ├─ orders.py
│     ├─ refunds.py
│     ├─ ratings.py
│     ├─ promotions.py
│     ├─ shop_health.py
│     └─ fulfillment.py
└─ DEVELOPMENT_REPORT.md
```

可以增加少量真正需要的共享模块，但不得为了尚未开发的 3 张表建立大量空抽象。

---

## 五、cleaning.yaml 增量配置

配置字段名称可以与现有结构保持一致，但必须表达以下内容。

### 1. 订单经营明细

```yaml
订单经营明细:
  output: 订单经营明细.xlsx
  builder: orders
  requires_period: true
  requires_shop_id: false
  sources:
    - order_detail
    - sku_commercial_status
  upsert:
    key: [订单ID, SKU ID]
```

### 2. 退货退款明细

```yaml
退货退款明细:
  output: 退货退款明细.xlsx
  builder: refunds
  requires_period: false
  requires_shop_id: true
  sources:
    - refund_snapshot
    - order_history
  upsert:
    key: [售后单号]
    latest_by: 采集时间
```

### 3. 商品评价明细

```yaml
商品评价明细:
  output: 商品评价明细.xlsx
  builder: ratings
  requires_period: true
  requires_shop_id: true
  sources:
    - rating_detail
  upsert:
    key: [订单ID, 商品ID, SKU ID]
```

### 4. 营销活动明细

```yaml
营销活动明细:
  output: 营销活动明细.xlsx
  builder: promotions
  requires_period: true
  requires_shop_id: true
  sources:
    - promotion_performance
  upsert:
    key: [营销活动ID, 统计开始日期, 统计结束日期]
```

### 5. 店铺健康明细

```yaml
店铺健康明细:
  output: 店铺健康明细.xlsx
  builder: shop_health
  requires_period: false
  requires_shop_id: true
  sources:
    - shop_health_snapshot
  upsert:
    key: [采集日期, 类别, 指标]
    derived_key:
      采集日期: date(采集时间)
    latest_by: 采集时间
```

### 6. 履约表现明细

```yaml
履约表现明细:
  output: 履约表现明细.xlsx
  builder: fulfillment
  requires_period: false
  requires_shop_id: true
  sources:
    - fulfillment_snapshot
  upsert:
    key: [采集日期, 类别, 指标]
    derived_key:
      采集日期: date(采集时间)
    latest_by: 采集时间
```

`采集日期`只作为内部 Upsert 键，不得新增到店铺健康明细或履约表现明细的输出表头。

---

## 六、source_locator.py 开发要求

### 1. 订单经营明细

目录：

```text
<shop-root>\店铺数据\订单明细\
```

文件命名：

```text
YYYY-MM-DD_至_YYYY-MM-DD.csv
```

规则：

- 单日和多日都使用 `_至_`。
- 只读取与目标 `start_date + end_date` 完全匹配的 CSV。
- 不拼接包含目标日期的月文件或其他重叠区间文件。
- 精确文件不存在时返回 `MISSING_SOURCE`。

同时定位最新：

```text
<shop-root>\店铺数据\商品与SKU商业状态快照\skus__YYYY-MM-DD.xlsx
```

用于 `SKU ID → Product ID` 关联。

### 2. 退货退款明细

退款快照目录：

```text
<shop-root>\店铺数据\退货退款快照\
```

选择文件名日期最新的：

```text
YYYY-MM-DD.xlsx
```

订单历史：

```text
<shop-root>\店铺数据\订单明细\*.csv
```

读取该目录下全部已经存在的订单历史 CSV，不受某个统计区间限制。

不得把同一个订单在重叠区间文件中的重复出现直接视为金额冲突；是否冲突由 Builder 按标准化 Order ID 和非空 Order Amount 判断。

### 3. 商品评价明细

目录：

```text
<shop-root>\店铺数据\商品评价明细\
```

只读取精确文件：

```text
YYYY-MM-DD_至_YYYY-MM-DD.csv
```

精确文件不存在时失败，不读取重叠月文件。

### 4. 营销活动明细

目录：

```text
<shop-root>\店铺数据\营销活动表现\
```

只读取精确文件：

```text
YYYY-MM-DD_至_YYYY-MM-DD.xlsx
```

单日也使用 `_至_`。

### 5. 店铺健康明细

目录：

```text
<shop-root>\店铺数据\店铺健康快照\
```

选择文件名日期最新的有效 `.xlsx`。

### 6. 履约表现明细

目录：

```text
<shop-root>\店铺数据\履约表现快照\
```

选择文件名日期最新的有效 `.xlsx`。

---

## 七、common.py 增量要求

在现有公共能力基础上补充以下确定性处理。

### 1. CSV读取

- 支持 UTF-8 BOM。
- 保持原始表头文本。
- ID字段去除尾随制表符并按文本保存。
- 不读取或输出买家姓名、电话、地址等隐私字段。

### 2. ISO UTC时间

退款、健康、履约源中可能出现：

```text
2026-09-04T01:23:45.000Z
```

统一规则：

1. 按 UTC 解析。
2. 转为时间对象。
3. 写 Excel 前移除 timezone 对象，保留其 UTC 时刻值，避免 openpyxl 无法写入带时区 datetime。
4. 不擅自转换为本地时区。

### 3. 订单时间

订单 CSV 可能是：

```text
08/26/2026 01:20:30 PM
```

并带尾随制表符。必须清理后按月/日/年格式解析。

### 4. Excel自定义属性

实现读取工作簿自定义属性：

```text
Currency
CurrencySymbol
```

营销活动明细的`店铺币种`必须读取原工作簿 `Currency`，不得从列名中的货币符号硬编码 PHP。

### 5. 比例转换

- 营销活动`平均折扣率`：例如 `58.00%` → 底层 `0.58`。
- 健康表中带 `%` 的当前值：例如 `1.25%` → `0.0125`。
- 履约表中单位=`%`且源值为 `98.37` → `0.9837`。
- 履约`分子/分母`是基础计数，不因单位=`%`而除以100。
- `NaN`文本、空字符串和明确不适用值转为空值。

### 6. 动态 Excel 百分比格式

本批部分表的同一列可能同时包含普通数值和百分比：

- 店铺健康明细：`当前值`
- 履约表现明细：`当前值、较上期变化、上期值、行业均值`

不能只按整列名统一套百分比格式。必须根据当前行的指标/单位，对具体单元格设置百分比格式。

固定百分比列仍应设置百分比格式：

```text
平均折扣率
```

---

## 八、upsert.py 增量要求

现有普通 Upsert、计划名称回退、临时文件、原子替换和失败回滚不得退化。

### 1. 支持 latest_by

对配置含：

```yaml
latest_by: 采集时间
```

的表执行：

- 新时间 > 旧时间 → 替换。
- 新时间 < 旧时间 → 跳过。
- 时间相同且整行相同 → 不重复写入。
- 时间相同但整行不同 → `DATA_CONFLICT`，停止该目标表写入，旧正式文件保持不变。

### 2. 退货退款明细

唯一键：

```text
售后单号
```

`采集时间`只用于新旧状态比较，不进入唯一键。

### 3. 店铺健康/履约

内部唯一键：

```text
采集日期 + 类别 + 指标
```

其中：

```text
采集日期 = date(采集时间)
```

执行顺序：

1. 本次 Builder 结果先按 `采集日期 + 类别 + 指标` 分组。
2. 每组选择`采集时间`最大的候选行。
3. 最大采集时间仍有多行且内容不同 → 冲突失败。
4. 再与现有清洗表执行时间保护。

不得把内部派生的`采集日期`写进最终清洗表表头。

### 4. 安全写入

任何重复键、时间冲突或写后校验失败：

- 不得破坏旧正式文件。
- 首次创建失败不得留下错误正式文件。
- 保留现有临时文件预校验、备份、原子替换和失败回滚流程。

---

## 九、六个 Builder 规则

## A. 商品评价明细

文件：

```text
scripts/builders/ratings.py
```

输出粒度：

```text
一条评价事实
```

字段规则：

- `评价日期` ← `review_date`
- `店铺ID` ← `context.shop_id`
- `商品ID` ← `product_id`
- `SKU ID` ← `sku_id`
- `订单ID` ← `order_id`
- `评分` ← `rating`
- `是否差评` ← `rating <= 2`
- `评价内容` ← `review_text`

`是否差评`输出布尔值；评分为空时留空。

唯一键：

```text
订单ID + 商品ID + SKU ID
```

精确区间文件只有表头时，正常生成仅表头的空清洗表。

---

## B. 营销活动明细

文件：

```text
scripts/builders/promotions.py
```

真实源文件可能先有说明行，必须通过表头锚点定位包含以下字段的真实表头：

```text
商品id
活动名称
状态
活动时间
```

字段规则：

- 原始首列`商品id`按`营销活动ID`输出，不作为商品ID使用。
- `活动时间`拆成活动开始时间和结束时间。
- 金额去除货币符号和千分位后转数值。
- 平均折扣率按源百分比字符串转0—1。
- 营销活动ROI重新计算：

```text
营销活动GMV ÷ 折扣金额
```

折扣金额为0或空时留空，不直接使用或平均源ROI。

- `店铺币种`读取工作簿自定义属性 `Currency`。

唯一键：

```text
营销活动ID + 统计开始日期 + 统计结束日期
```

---

## C. 订单经营明细

文件：

```text
scripts/builders/orders.py
```

输出粒度：

```text
订单 × SKU行
```

要求：

1. 只输出冻结表头中的字段；不得输出：

```text
Buyer Username
Recipient
Phone
详细地址
```

2. `商品ID`通过最新 skus 快照：

```text
订单.SKU ID = skus.sku_id
→ skus.product_id
```

SKU无法匹配时，商品ID留空，不模糊猜配，也不阻断其他行。

3. 所有 ID 去除制表符后按文本保存。

4. 金额字段全部转纯数值，空值保持空。

5. 时间字段按冻结规则标准化。

6. 履约时长统一输出小时数：

```text
支付至发货时长 = Shipped Time - Paid Time
发货至签收时长 = Delivered Time - Shipped Time
订单总履约时长 = Delivered Time - Paid Time
```

任一必要时间缺失时对应时长留空。

7. 唯一键：

```text
订单ID + SKU ID
```

同一键重跑时整行替换，不重复追加。

本次精确订单文件中出现同键冲突行时失败，旧正式文件保持不变。

---

## D. 退货退款明细

文件：

```text
scripts/builders/refunds.py
```

输出粒度：

```text
一条售后单
```

字段规则：

- 退款源的`订单实付`如果是“已付款”等状态文本，不作为金额。
- `订单实付`必须从全部历史订单 CSV 的 `Order Amount`补充。
- 订单历史先按标准化 `Order ID`建立索引。

同一 Order ID：

- 所有非空 Order Amount一致 → 使用该金额。
- 出现多个不同非空金额 → 订单实付留空，并记录金额冲突；不阻断该退款行其他字段。
- 完全找不到 → 订单实付留空。

退款金额转纯数值；UTC时间按公共规则解析。

唯一键：

```text
售后单号
```

使用`采集时间`执行最新状态保护。

退款快照只有表头时，正常生成仅表头的空清洗表。

---

## E. 店铺健康明细

文件：

```text
scripts/builders/shop_health.py
```

每一原始指标行对应一条清洗行。

要求：

- `店铺ID` ← `context.shop_id`
- `店铺名称` ← `shop_root`末级目录名
- UTC `Z`采集时间按公共规则解析
- 带`%`的当前值转0—1
- 普通分数、次数转数值
- 无法数值化的合法文本保留文本
- `NaN`、空字符串转空
- 目标条件和说明保留文本

Upsert按：

```text
采集日期 + 类别 + 指标
```

同日同指标只保留采集时间最新的一条。

---

## F. 履约表现明细

文件：

```text
scripts/builders/fulfillment.py
```

每一原始指标行对应一条清洗行。

要求：

- 单位=`%`时，当前值、较上期变化、上期值、行业均值按源值除以100。
- 单位为小时、订单数等时，数值直接保留。
- 分子、分母始终作为基础计数直接保存，不因单位=`%`而除以100。
- `NaN`文本和空字符串统一为空值。
- 日期和UTC时间按公共规则标准化。

Upsert规则与店铺健康明细相同：

```text
采集日期 + 类别 + 指标
```

同日同指标保留采集时间最新的一条。

---

## 十、开发顺序与分段验收

必须按以下顺序开发，不一次写完再统一测试。

### 阶段 A：商品评价明细 + 营销活动明细

实现：

```text
ratings.py
promotions.py
对应source locator、config、格式化能力
```

运行：

```powershell
$env:CLEANING_SKILL_ROOT='D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning'

python -m pytest -q -p no:cacheprovider `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch3\tests\test_03_ratings.py `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch3\tests\test_04_promotions.py
```

全部通过后进入阶段 B。

### 阶段 B：订单经营明细

实现：

```text
orders.py
精确区间CSV定位
最新skus快照定位
```

运行：

```powershell
python -m pytest -q -p no:cacheprovider `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch3\tests\test_01_orders.py
```

全部通过后进入阶段 C。

### 阶段 C：退货退款明细

实现：

```text
refunds.py
最新退款快照
全部订单历史索引
latest_by时间保护
```

运行：

```powershell
python -m pytest -q -p no:cacheprovider `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch3\tests\test_02_refunds.py
```

全部通过后进入阶段 D。

### 阶段 D：店铺健康明细 + 履约表现明细

实现：

```text
shop_health.py
fulfillment.py
同日最新Upsert
动态百分比格式
```

运行：

```powershell
python -m pytest -q -p no:cacheprovider `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch3\tests\test_05_shop_health.py `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch3\tests\test_06_fulfillment.py
```

全部通过后执行第三批契约和真实结构测试：

```powershell
python -m pytest -q -p no:cacheprovider `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch3\tests\test_07_contract.py `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch3\tests\test_08_real_export_smoke.py
```

---

## 十一、完整回归验收

设置：

```powershell
$env:CLEANING_SKILL_ROOT='D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning'
$env:PYTHONDONTWRITEBYTECODE='1'
```

### 1. 第一阶段回归

```powershell
cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_v3
python verify_lock.py
python -m pytest -q -p no:cacheprovider tests
python verify_lock.py
```

预期：

```text
13 passed
```

### 2. 第二批回归

```powershell
cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch2
python verify_lock.py
python -m pytest -q -p no:cacheprovider tests
python verify_lock.py
```

预期：

```text
24 passed
```

### 3. 第三批验收

```powershell
cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_batch3
python verify_lock.py
python -m pytest -q -p no:cacheprovider tests
python verify_lock.py
```

预期：

```text
44 passed
OK: 20 locked test files unchanged
```

不得使用 `skip`、`xfail`或删除测试来替代通过。

---

## 十二、真实数据验证

外部测试全部通过后，再使用本次重新导出的干净数据进行真实调用。

至少验证一个实际店铺，运行：

```powershell
python scripts\run_cleaning.py --shop-root "<真实店铺目录>" --shop-id "<真实sellerId>" --target "订单经营明细" --start-date 2026-08-26 --end-date 2026-08-26
python scripts\run_cleaning.py --shop-root "<真实店铺目录>" --shop-id "<真实sellerId>" --target "商品评价明细" --start-date 2026-08-26 --end-date 2026-08-26
python scripts\run_cleaning.py --shop-root "<真实店铺目录>" --shop-id "<真实sellerId>" --target "营销活动明细" --start-date 2026-08-26 --end-date 2026-08-26
python scripts\run_cleaning.py --shop-root "<真实店铺目录>" --shop-id "<真实sellerId>" --target "退货退款明细"
python scripts\run_cleaning.py --shop-root "<真实店铺目录>" --shop-id "<真实sellerId>" --target "店铺健康明细"
python scripts\run_cleaning.py --shop-root "<真实店铺目录>" --shop-id "<真实sellerId>" --target "履约表现明细"
```

检查：

- 文件能够打开；
- 表头与冻结表头一致；
- ID不转科学计数法；
- 不输出买家隐私字段；
- 比例、时间、金额格式正确；
- 相同命令重复运行不增加重复行；
- 旧退款/健康/履约快照不覆盖更新状态；
- `20_清洗数据`中不残留 `.tmp.xlsx`、`.backup.xlsx`。

真实数据发现问题时，应先定位通用根因并增加回归测试，不得针对某个店铺名、订单ID、日期或文件名硬编码。

---

## 十三、禁止事项

Codex不得：

- 修改四份冻结规范；
- 修改任何外部验收测试及哈希清单；
- 使用测试中的ID、日期、金额、店铺名称写特例；
- 增加未声明的广告账户状态等依赖来取得第三批店铺ID；
- 自动调用导出 Skill；
- 把重叠区间文件自动拼接后冒充精确区间；
- 把退款源中的“已付款”写入订单实付金额；
- 把订单买家姓名、用户名、电话、地址写入清洗表；
- 把健康/履约整列无条件格式化为百分比；
- 把内部`采集日期`字段写入固定表头；
- 直接覆盖正式Excel而跳过临时写入与回滚；
- 开发 `SKU状态库存明细`、`商品经营诊断`、`店铺诊断`；
- 在 Skill 中创建或打包 `.venv`。

---

## 十四、代码质量要求

- 保持现有 Builder 统一接口；
- 使用 `pathlib.Path` 和类型标注；
- 公共逻辑放到公共模块，避免六个Builder重复实现；
- 不使用静默 `except Exception: pass`；
- 错误返回结构化错误码和可定位信息；
- ID、金额、日期、比例转换使用确定性函数；
- 不为未来三张表提前建立无实际用途的复杂框架；
- 不改变现有 7 张表的字段和行为；
- 打包前清理 `__pycache__`、`*.pyc`、`.pytest_cache`；
- `.git`可在开发仓库保留，但最终分发ZIP中不必包含。

---

## 十五、完成报告

第三批全部完成后更新：

```text
DEVELOPMENT_REPORT.md
```

至少写明：

1. 新增和修改的文件；
2. 新增CLI参数及Hermes调用方式；
3. 六张表各自的输入、输出和Upsert键；
4. source locator新增规则；
5. 时间保护和动态百分比格式实现；
6. 第一阶段、第二批、第三批实际测试命令和结果；
7. 三个测试锁校验结果；
8. 真实数据测试结果；
9. 尚未实现的最后3张表；
10. 未修改冻结规范和外部测试的声明。

---

## 十六、第三批完成标准

以下条件全部满足，第三批才算完成：

1. 六张表全部注册并可通过CLI调用；
2. 需要店铺ID的5张第三批目标缺少`--shop-id`时明确失败；订单经营明细不强制该参数；
3. 六张表输出表头与冻结规范完全一致；
4. 第一阶段 `13 passed`；
5. 第二批 `24 passed`；
6. 第三批 `44 passed`；
7. 三个测试目录锁校验全部通过；
8. 真实数据调用成功；
9. Upsert、时间保护、原子写入和失败回滚正常；
10. 不存在 `.venv`、`__pycache__`、`*.pyc`等打包杂项；
11. 未开发最后3张复杂表；
12. 更新开发报告后停止，等待第四批任务。
