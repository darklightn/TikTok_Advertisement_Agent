# TikTok Shop 数据清洗 Skill 最终批开发计划

## 一、开发目标

在现有 13 张清洗表已经实现的基础上，完成最后 3 张清洗表：

1. `SKU状态库存明细.xlsx`
2. `商品经营诊断.xlsx`
3. `店铺诊断.xlsx`

完成后，Cleaning Skill 必须能够生成全部 16 张固定清洗表。

本批同时完成：

- 最后 3 个 Builder；
- 对应原始文件定位；
- 商品分析多级表头解析；
- 成本生效、币种和毛利计算；
- 全部 16 张表真实数据运行；
- 最终 Skill 瘦身与交付检查。

---

## 二、目录与修改边界

### 1. 唯一允许修改的项目目录

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

不得修改、重命名或复制覆盖这四份文件。

### 3. 最终批外部验收测试只读

```text
D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_final\
```

禁止修改：

```text
LOCKED_TESTS.sha256
verify_lock.py
pytest.ini
requirements-test.txt
tests\*.py
```

### 4. 真实导出数据只读

使用用户当前重新导出的：

```text
D:\广告数据部\<店铺名>\
```

原始导出文件不得修改。清洗结果只写入该店铺的：

```text
20_清洗数据\
```

若需要调试原始数据，使用副本，不允许改写原文件。

---

## 三、现有代码保护要求

当前 13 张表已经实现，本批不得重写或改变其既有业务行为：

```text
广告户诊断
计划诊断
素材诊断
广告户状态快照
计划小时表现
计划配置历史
计划变更记录
订单经营明细
退货退款明细
商品评价明细
营销活动明细
店铺健康明细
履约表现明细
```

本批可以增量修改以下公共文件，但必须兼容已有 13 张表：

```text
config/cleaning.yaml
scripts/common.py
scripts/source_locator.py
scripts/upsert.py
scripts/run_cleaning.py
SKILL.md
DEVELOPMENT_REPORT.md
```

新增 Builder：

```text
scripts/builders/sku_inventory.py
scripts/builders/product_diagnosis.py
scripts/builders/shop_diagnosis.py
```

允许增加一个面向最后 3 张表的公共辅助模块，例如：

```text
scripts/builders/product_common.py
```

不得让任一清洗表读取其他清洗表作为数据源。

---

## 四、最终批公开 CLI

继续沿用当前唯一入口：

```powershell
python scripts\run_cleaning.py `
  --shop-root "<店铺根目录>" `
  [--shop-id "<sellerId>"] `
  --target "<清洗表名>" `
  [--start-date YYYY-MM-DD] `
  [--end-date YYYY-MM-DD]
```

调用示例：

```powershell
python scripts\run_cleaning.py `
  --shop-root "D:\广告数据部\TK蚊帐1店" `
  --target "SKU状态库存明细"

python scripts\run_cleaning.py `
  --shop-root "D:\广告数据部\TK蚊帐1店" `
  --target "商品经营诊断" `
  --start-date 2026-08-26 `
  --end-date 2026-08-26

python scripts\run_cleaning.py `
  --shop-root "D:\广告数据部\TK蚊帐1店" `
  --target "店铺诊断" `
  --start-date 2026-08-26 `
  --end-date 2026-08-26
```

要求：

- `SKU状态库存明细`不要求统计区间；
- `商品经营诊断`和`店铺诊断`必须同时提供开始日期和结束日期；
- 目标名继续兼容带或不带`.xlsx`；
- 成功退出码为`0`，失败退出码非`0`；
- 失败不得留下错误正式文件，也不得破坏已有正式文件；
- 不调用数据导出 Skill 自动补数据。

---

## 五、cleaning.yaml 最终配置

最终 `cleaning.yaml` 必须注册全部 16 张表，不能只保留本批 3 张。

### 1. SKU状态库存明细

```yaml
SKU状态库存明细:
  output: SKU状态库存明细.xlsx
  builder: sku_inventory
  requires_period: false
  sources:
    - product_status_products
    - product_status_skus
    - inventory_snapshot
    - cost_table
  upsert:
    key: [SKU ID, 快照日期]
```

### 2. 商品经营诊断

```yaml
商品经营诊断:
  output: 商品经营诊断.xlsx
  builder: product_diagnosis
  requires_period: true
  sources:
    - product_analytics
    - product_status_products
    - product_status_skus
    - inventory_snapshot
    - campaign_product_performance
    - campaign_product_creative_performance
    - order_detail
    - rating_detail
    - cost_table
  upsert:
    key: [商品ID, 统计开始日期, 统计结束日期]
```

### 3. 店铺诊断

```yaml
店铺诊断:
  output: 店铺诊断.xlsx
  builder: shop_diagnosis
  requires_period: true
  sources:
    - product_analytics
    - order_detail
    - advertiser_overview
    - campaign_performance
    - product_status_products
    - inventory_snapshot
    - shop_health_snapshot
    - fulfillment_snapshot
  upsert:
    key: [统计开始日期, 统计结束日期]
```

三张表的 `columns` 必须逐字、逐顺序匹配冻结表头和外部 `expected_schemas.py`，不得增加内部键、调试列或说明列。

---

## 六、source_locator.py 开发要求

## 1. SKU状态库存明细

读取：

```text
店铺数据/商品与SKU商业状态快照/products__YYYY-MM-DD.xlsx
店铺数据/商品与SKU商业状态快照/skus__YYYY-MM-DD.xlsx
店铺数据/库存快照/YYYY-MM-DD.xlsx
15_人工录入/成本表.xlsx
```

选择规则：

1. 分别扫描 products、skus、库存快照的文件名日期；
2. 计算三类文件都存在的日期交集；
3. 选择交集中最新日期；
4. 不允许把三个不同日期的文件拼在一起；
5. 没有共同日期时返回缺少可组合快照；
6. `成本表.xlsx`文件必须存在；只有表头、没有成本数据行仍属于合法输入。

向 Builder 返回：

```text
snapshot_date
products文件
skus文件
库存文件
成本表
```

## 2. 商品经营诊断

区间源只读取与命令中的 `start_date + end_date` 完全匹配的文件：

```text
店铺数据/商品分析表现/start_至_end.xlsx
店铺数据/订单明细/start_至_end.csv
店铺数据/商品评价明细/start_至_end.csv
计划数据/GMV Max 计划商品表现/<计划名称>__精确区间.xlsx
计划数据/GMV Max 计划商品素材表现/<计划名称>__<商品上下文>__start_至_end.xlsx
```

快照源：

- products与skus：选择二者最新共同日期；
- 库存：独立选择最新库存快照，不要求与商业状态同一天；
- 成本：固定读取`15_人工录入/成本表.xlsx`。

单日命名规则：

- 计划商品表现单日文件：`计划名称__YYYY-MM-DD.xlsx`；
- 计划商品素材表现单日文件仍为：`计划名称__商品上下文__YYYY-MM-DD_至_YYYY-MM-DD.xlsx`。

不得读取包含目标区间的月文件或其他重叠区间文件。

向 Builder 返回：

```text
commercial_snapshot_date
inventory_snapshot_date
performance_period_suffix
creative_period_suffix
```

## 3. 店铺诊断

精确区间源：

```text
商品分析表现/start_至_end.xlsx
订单明细/start_至_end.csv
GMV Max 计划总览/精确区间文件
GMV Max 计划表现/各计划精确区间文件
```

快照源分别独立选择最新文件：

```text
products快照
库存快照
店铺健康快照
履约表现快照
```

店铺诊断只读取`products`，不要求`skus`。

向 Builder返回实际采用的：

```text
products_snapshot_date
inventory_snapshot_date
health_snapshot_date
fulfillment_snapshot_date
```

---

## 七、公共读取与转换能力

### 1. 商品分析多级表头

`商品分析表现`不是普通单行表头。程序必须：

1. 在前部行中通过`商品名`、`商品 ID`、`GMV`等锚点定位真实字段行；
2. 使用真实字段行上一行作为上层分组；
3. 生成唯一字段名，例如：

```text
全部.GMV
全部.商品点击量
全部.商家视频 GMV
商家视频.GMV
```

4. 不得因为多个分组中都出现`GMV`就读取错误列；
5. 不依赖固定“第4行就是表头”的假设；
6. 继续调用 `worksheet.reset_dimensions()`，兼容TikTok导出工作表范围元数据错误。

### 2. 通用JSON解析

为 products/skus 快照提供确定性解析：

```text
product_record_json
sku_record_json
```

JSON缺失或非法时返回明确错误，不静默忽略。

### 3. 数值与格式

继续遵守：

- 所有ID为文本；
- 金额为纯数值；
- 比例底层为0—1；
- ROI为倍率；
- 空值与0严格区分；
- 自计算除法分母为0或空时留空；
- 百分比列设置Excel百分比格式。

本批至少补齐以下百分比列格式：

```text
平台费率
按当前售价估算毛利率
商品点击率
加购率
CTOR
退款金额率
退款件数率
成本覆盖率
估算商品毛利率
商责取消率
延迟发货率
商责差评率
商家责任退货退款率
快速发货率
```

---

## 八、Builder A：SKU状态库存明细

文件：

```text
scripts/builders/sku_inventory.py
```

输出粒度：

```text
一个SKU × 一个共同快照日期
```

Upsert唯一键：

```text
SKU ID + 快照日期
```

### 1. 关联关系

```text
skus.sku_id
↔ 库存快照.SKU ID

skus.product_id
↔ products.product_id

SKU ID
↔ 成本表.SKU ID
```

每个用于关联的SKU ID或商品ID维表必须先检查唯一性，不能因维表重复导致事实行扩增。

### 2. 字段优先级

- 商品名称：products JSON优先，库存商品名称回退；
- 商家SKU：skus JSON优先，库存回退；
- SKU规格：skus JSON `properties[]`优先，库存规格回退；
- 仓库名称：库存快照优先；
- 当前售价：有效促销价>0时使用促销价，否则销售价；
- 列表价：只读list_price，无值留空，不用销售价替代；
- SKU状态：保留平台原始状态码；
- 当前预售状态：0→非预售，1→预售，其他保留原值。

### 3. 成本生效规则

对每个SKU：

```text
生效日期 <= 快照日期
```

存在多条时取生效日期最近的一条。未来成本不能提前使用；同一SKU同一生效日期存在冲突记录时失败。

人工成本表规则：

- 成本项空白表示未知；
- 真实没有成本必须明确填写0；
- 六项单位成本全部明确时才计算单位基础成本；
- 平台费率支持如`10`、`10%`、`0.1`的固定规范化；
- 成本表只有表头时，正常输出SKU行，所有成本字段留空。

计算：

```text
单位基础成本
= 单位采购成本
+ 单位头程成本
+ 单位关税及清关成本
+ 单位包装成本
+ 单位本地物流成本
+ 单位仓租分摊
```

```text
按当前售价估算毛利率
= (当前售价 - 单位基础成本 - 当前售价×平台费率) ÷ 当前售价
```

只有满足以下条件才计算毛利率：

- 当前售价>0；
- 单位基础成本完整；
- 平台费率明确；
- 售价币种=成本币种。

```text
按当前售价估算保本ROI = 1 ÷ 毛利率
```

毛利率<=0时保本ROI留空。

---

## 九、Builder B：商品经营诊断

文件：

```text
scripts/builders/product_diagnosis.py
```

输出粒度：

```text
一个商品 × 一个统计区间
```

Upsert唯一键：

```text
商品ID + 统计开始日期 + 统计结束日期
```

### 1. 商品行集合

必须采用并集：

```text
商品分析表现中的商品
∪ GMV Max计划商品表现中的商品
∪ 最新products快照中的当前可售商品
```

要求：

- 当前可售但区间无销售/广告的商品仍保留；
- 历史区间有表现、当前已经删除或下架的商品仍保留；
- 没有区间记录不等于0；无法证明为0的指标留空；
- 若某商品不在products快照中，使用本店唯一seller_id或运行上下文作为店铺ID回退。

### 2. 商品状态、价格与库存

- 商品状态由lifecycle_status和visible_status确定；
- 非可售商品`在售SKU数=0`；
- 可售商品：`max(total_sku_count-inactive_sku_count, 0)`；
- 商品类目优先叶子类目；无叶子类目时取level最大项；
- 当前最低/最高售价优先有效促销价；
- 库存按商品汇总；
- 缺货SKU与低库存SKU按SKU ID去重；
- 低库存不包含已经判定缺货的SKU；
- 最短可供应天数兼容数值和`>60`。

### 3. 商品分析指标

必须读取`全部`分组，不能误取其他分组的同名字段。

计算：

```text
AOV = 商品GMV ÷ SKU订单数
商品点击率 = 商品点击量 ÷ 商品曝光次数
加购率 = 加购次数 ÷ 商品点击量
CTOR = SKU订单数 ÷ 商品点击量
退款金额率 = 退款金额 ÷ 商品GMV
退款件数率 = 已退款商品件数 ÷ 商品成交件数
```

分母为0或空时留空；分母>0且分子为0时输出0。

### 4. 取消/退货商品件数

订单事实保持：

```text
Order ID + SKU ID
```

不得按SKU ID去重。

- 先把SKU维表整理为每个SKU ID唯一的一条商品ID映射；
- 取消订单累计该订单SKU事实行的Quantity；
- 非取消订单累计该事实行的Sku Quantity of return；
- 最后按商品ID汇总。

### 5. GMV Max商品与素材

计划商品表现跨计划按Product ID汇总：

```text
关联计划数
广告成本
SKU订单数
总收入
平均下单成本
实际ROI
```

素材唯一键：

```text
Video：计划 + 商品 + Post ID
Product card：计划 + 商品 + Creative type
```

同一Post ID在不同计划中分别计入。可用素材只统计状态为`已探索`或`探索中`；有消耗素材按同一内部键聚合后判断成本>0。

### 6. 评价

仅使用精确统计区间评价文件：

```text
区间新增评价数
区间新增评价平均分
区间差评数（评分<=2）
```

### 7. 商品成本覆盖与估算毛利

成本生效截止日固定使用：

```text
商业状态快照日期
```

不使用库存快照日期。

成本覆盖SKU：存在当前有效成本记录，且币种、六项单位成本及平台费率均明确。

```text
成本覆盖率 = 成本覆盖SKU数 ÷ SKU总数
```

估算商品毛利率按近30天销量加权：

```text
Σ[(售价-单位基础成本-售价×平台费率)×近30天销量]
÷
Σ(售价×近30天销量)
```

规则：

- 只要某个近30天销量>0的SKU成本不完整，整项商品毛利率留空；
- 只要某个有销量SKU售价币种与成本币种不一致，整项留空；
- 同一商品匹配到多个成本币种且没有汇率，不允许计算，并返回币种冲突；
- 无有效销量或分母<=0时留空；
- `保本ROI=1÷估算商品毛利率`；
- `ROI安全差=实际ROI-保本ROI`。

---

## 十、Builder C：店铺诊断

文件：

```text
scripts/builders/shop_diagnosis.py
```

输出粒度：

```text
一个店铺 × 一个统计区间
```

Upsert唯一键：

```text
统计开始日期 + 统计结束日期
```

### 1. 店铺经营指标

商品分析数据先按全部分组基础量求和，再重算：

```text
AOV
商品点击率
加购率
CTOR
退款金额率
```

订单数按Order ID去重；客户数仅在计算过程中按非空Buyer Username去重，不输出任何买家隐私。

取消/退货商品件数按订单SKU事实行逐行累计，不按SKU去重。

### 2. GMV Max指标

计划总览：

- 优先读取`时间/按天 = -`的总计行；
- 没有总计行时才汇总明细行；
- 不得同时把总计行和明细行相加。

计划表现：

- 计划总数按campaign_id去重；
- 运行计划只统计`delivery_ok + campaign_delivery_ok`；
- 有消耗计划先按计划聚合cost，再统计cost>0。

### 3. 健康与履约

- 店铺健康读取最新快照；
- 履约表现读取最新快照；
- 两者不要求同一天；
- 指标按名称精确匹配；
- 缺少某一个具体指标时对应字段留空，不用其他指标替代；
- 快速发货率的原始98.37在单位为%时转换为0.9837；
- 待发货至签收平均时长保持小时纯数值。

### 4. 商品与库存状态

- 在售商品数只使用最新products快照；
- 排除delisted、draft、deleted，且必须visible=true；
- 缺货SKU和低库存SKU使用最新库存快照，按SKU ID去重；
- 店铺币种优先products快照唯一currency；
- 广告币种优先计划总览，缺失时使用计划表现；
- 一个来源中出现多个币种时不得静默选择。

---

## 十一、开发与测试顺序

## 阶段0：保护外部测试

```powershell
cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_final
python verify_lock.py
```

必须输出：

```text
OK: 8 locked files unchanged
```

失败时停止开发。

## 阶段1：配置、定位器和公共解析

先完成：

```text
cleaning.yaml注册全部16张表
source_locator.py三张表定位
商品分析多级表头解析
products/skus JSON公共解析
最终批百分比格式配置
```

运行：

```powershell
python -m pytest -q -p no:cacheprovider tests\test_00_contract.py
```

通过后进入下一阶段。

## 阶段2：SKU状态库存明细

实现`sku_inventory.py`，然后运行：

```powershell
python -m pytest -q -p no:cacheprovider `
  tests\test_00_contract.py `
  tests\test_01_sku_inventory.py
```

必须修完所有失败，才能开发商品经营诊断。

## 阶段3：商品经营诊断

实现`product_diagnosis.py`，然后运行：

```powershell
python -m pytest -q -p no:cacheprovider `
  tests\test_00_contract.py `
  tests\test_01_sku_inventory.py `
  tests\test_02_product_diagnosis.py
```

必须修完所有失败，才能开发店铺诊断。

## 阶段4：店铺诊断

实现`shop_diagnosis.py`，然后运行最终批全部测试：

```powershell
python -m pytest -q -p no:cacheprovider tests
```

预期：

```text
35 passed
```

## 阶段5：测试锁复核

```powershell
python verify_lock.py
```

预期：

```text
OK: 8 locked files unchanged
```

---

## 十二、旧功能回归

最终3张表需要修改公共读取器和定位器，因此必须防止已有13张表回归。

### 1. 第一阶段有效测试

若本地仍保留：

```text
D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_v3\
```

执行：

```powershell
cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests_v3
python verify_lock.py
python -m pytest -q -p no:cacheprovider tests
python verify_lock.py
```

预期仍为：

```text
13 passed
```

### 2. 第二、第三批旧测试

第二、第三批旧测试包曾出现Windows长路径和漏打包fixture问题。允许读取和运行，但不得为解决测试资产问题而修改Skill业务逻辑或修改测试。

如果错误发生在测试fixture准备阶段、尚未调用Skill：

- 在报告中标记`TEST_ASSET_BLOCKED`；
- 保留完整错误证据；
- 不把该setup error等同于Skill失败。

已有13张表是否回归，最终必须通过下面的真实全量运行验证。

---

## 十三、真实数据全量验收

最终批合成测试通过后，使用用户最新重新导出的真实数据执行。

### 1. 最后3张逐张运行

对每个真实店铺执行：

```powershell
python scripts\run_cleaning.py --shop-root "<店铺目录>" --target "SKU状态库存明细"
python scripts\run_cleaning.py --shop-root "<店铺目录>" --target "商品经营诊断" --start-date <开始日期> --end-date <结束日期>
python scripts\run_cleaning.py --shop-root "<店铺目录>" --target "店铺诊断" --start-date <开始日期> --end-date <结束日期>
```

如果真实成本表只有表头，SKU和商品表仍应生成；成本、毛利、保本ROI相关字段保持空，不得把空值变成0。

### 2. 16张表完整性

每个店铺的：

```text
20_清洗数据/
```

最终必须正好具有16张固定清洗表，不带01、02等编号，不存在旧的`90_诊断下钻`层级。

### 3. 重复运行

对相同店铺、相同日期、相同目标重新执行一次：

- SKU同快照日期不得追加重复行；
- 商品同统计区间不得追加重复行；
- 店铺同统计区间始终只保留一行；
- Upsert后各表唯一键不得重复；
- 行数只允许因业务对象变化而变化，不能因重复执行增长。

### 4. 真实结果抽查

至少抽查：

- 一个有库存、有完整成本的SKU；
- 一个无成本记录的SKU；
- 一个当前可售但区间无商品表现的商品；
- 一个当前删除/下架但区间有历史表现的商品；
- 一个存在多个计划和多个素材的商品；
- 店铺总计行是否没有与明细行重复相加；
- 健康、履约是否取最新快照；
- 所有ID是否保持完整文本，无科学计数法；
- 百分比、金额、ROI格式是否正确。

---

## 十四、最终代码与交付清理

全部测试通过后：

1. 更新`SKILL.md`，列出全部16张支持的目标和调用方式；
2. 更新`DEVELOPMENT_REPORT.md`，记录最终3张表、测试结果及真实运行结果；
3. 删除：

```text
.venv/
所有__pycache__/
所有*.pyc
.pytest_cache/
```

4. 开发仓库可以保留`.git/`，但正式分发ZIP不得包含`.git/`；
5. 正式运行版Skill不得包含外部测试包、真实导出数据、四份开发规范或临时调试文件；
6. 正式运行版建议只保留：

```text
tiktok-shop-data-cleaning/
├─ SKILL.md
├─ requirements.txt
├─ config/
├─ scripts/
└─ references/（仅保留运行时确实使用的内容）
```

7. 压缩前递归确认没有`.venv`、缓存、测试fixture和原始店铺数据。

---

## 十五、最终完成标准

以下条件全部满足才算 Cleaning Skill 开发完成：

1. `cleaning.yaml`注册全部16张表；
2. 最后3张表表头与冻结规范完全一致；
3. 最终批外部验收为`35 passed`；
4. 最终批测试锁前后均为`OK: 8 locked files unchanged`；
5. 第一阶段有效回归仍为`13 passed`；
6. 第二、第三批如有测试资产setup error，已明确证明错误发生在调用Skill之前；
7. 最新真实导出数据可生成全部16张表；
8. 相同数据重复运行无重复键和重复行；
9. 失败场景不破坏已有正式文件；
10. 所有ID、金额、比例、ROI和空值口径符合冻结规则；
11. Skill目录无`.venv`、`__pycache__`和`*.pyc`；
12. 完成最终开发报告和正式运行包后停止，不再自行增加表、字段或诊断逻辑。

---

## 十六、Codex禁止事项

- 不得修改四份冻结规范；
- 不得修改外部验收测试或哈希清单；
- 不得根据测试中的P1、S1、SHOP-1、2026-08-26等值写硬编码；
- 不得让商品经营诊断读取SKU状态库存明细；
- 不得让店铺诊断读取商品经营诊断、广告户诊断或其他清洗表；
- 不得把无区间记录的商品指标全部强制写0；
- 不得把成本空白自动当0；
- 不得在币种不一致时直接相减或计算毛利；
- 不得把总计行和明细行同时累计；
- 不得通过模糊匹配商品名、SKU或计划来补关联；
- 不得为了通过测试修改测试；
- 不得在最终Skill中保留`.venv`、测试fixture或真实店铺数据；
- 不得超出本计划新增字段、表或业务规则。

---

## 十七、最终报告内容

`DEVELOPMENT_REPORT.md`至少补充：

1. 最终新增和修改的代码文件；
2. 16张表最终支持清单；
3. 三张最终表的源文件选择规则；
4. 商品分析多级表头处理；
5. 成本生效日、空值、币种和毛利计算规则；
6. 最终批35项测试结果；
7. 测试锁结果；
8. 第一阶段回归结果；
9. 第二、第三批旧测试是否存在测试资产阻塞；
10. 两家真实店铺16张表运行结果和各表行数；
11. 重复运行后的唯一键检查结果；
12. 最终Skill瘦身检查；
13. 明确声明未修改冻结规范和外部测试。
