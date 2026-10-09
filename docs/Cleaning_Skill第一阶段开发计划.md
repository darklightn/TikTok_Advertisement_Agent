# TikTok Shop 数据清洗 Skill 第一阶段开发计划

## 一、开发目标

在以下工作目录中完成 Cleaning Skill 的第一阶段实现：

```text
D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning\
```

第一阶段只实现并跑通 3 张代表性清洗表：

1. `广告户状态快照.xlsx`
2. `计划小时表现.xlsx`
3. `计划诊断.xlsx`

本阶段不实现剩余 13 张表。三张表通过独立验收测试后立即停止，提交开发报告，等待下一批测试。

---

## 二、可读取与禁止修改的目录

### 1. Codex 唯一允许修改的目录

```text
D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning\
```

所有实现代码、运行配置、依赖文件和内部开发文档只能写入该目录。

### 2. 冻结规范：只读，不得修改

```text
D:\TikTok-Agent\数据清洗\清洗目录结构.txt
D:\TikTok-Agent\数据清洗\清洗表与原始导出表依赖关系.txt
D:\TikTok-Agent\数据清洗\清洗字段来源关联与处理规则.txt
D:\TikTok-Agent\数据清洗\清洗表Upsert唯一键与写入规则.txt
```

四份文件是实现依据。运行中的 Skill 不得动态解析这些自然语言文档；规则必须固化到配置和 Python 代码中。

### 3. 独立验收测试：只读，不得修改

```text
D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests\
```

禁止修改、复制覆盖或重新生成其中任何文件，特别是：

```text
LOCKED_TESTS.sha256
verify_lock.py
pytest.ini
requirements-test.txt
tests\*.py
```

Codex 可以读取测试以理解公开契约，但不得通过修改测试获得“通过”。

### 4. 数据导出项目：只读

```text
D:\TikTok-Agent\数据导出\
```

仅在需要核对真实目录名、文件命名方式或原始字段时读取，不得修改导出 Skill。

---

## 三、唯一公开 CLI 契约

必须提供：

```text
D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning\scripts\run_cleaning.py
```

调用方式固定为：

```powershell
python scripts\run_cleaning.py `
  --shop-root "<店铺根目录>" `
  --target "<清洗表名>" `
  [--start-date YYYY-MM-DD] `
  [--end-date YYYY-MM-DD]
```

目标表名使用中文，不带编号，不强制带 `.xlsx`：

```text
广告户状态快照
计划小时表现
计划诊断
```

CLI 必须同时接受带 `.xlsx` 的等价写法，但内部统一标准化为不带扩展名的目标名称。

### 成功与失败

- 成功：退出码 `0`。
- 失败：退出码非 `0`。
- 缺少原始依赖：报错退出，不创建错误正式文件。
- 已有正式文件时执行失败：原正式文件内容不得改变。
- 输出目录固定：

```text
<shop-root>\20_清洗数据\<目标表>.xlsx
```

建议最终 stdout 输出一个 UTF-8 JSON 结果，便于未来 Agent 读取：

```json
{"status":"success","target":"计划诊断","output":"...\\计划诊断.xlsx","rows":1}
```

失败示例：

```json
{"status":"error","code":"MISSING_SOURCE","target":"计划诊断","message":"缺少 GMV Max 建议快照 items 文件"}
```

测试只强制退出码和文件结果，但实现应保留上述机器可读输出。

---

## 四、第一阶段项目结构

```text
tiktok-shop-data-cleaning/
├─ SKILL.md
├─ requirements.txt
├─ config/
│  └─ cleaning.yaml
├─ scripts/
│  ├─ run_cleaning.py
│  ├─ source_locator.py
│  ├─ common.py
│  ├─ upsert.py
│  └─ builders/
│     ├─ __init__.py
│     ├─ advertiser_status.py
│     ├─ campaign_hourly.py
│     └─ campaign_diagnosis.py
└─ DEVELOPMENT_REPORT.md
```

可以增加必要的 `__init__.py`、类型定义或内部模块，但不得为了第一阶段拆出大量空模块。

### requirements.txt

建议保持最小依赖：

```text
pandas>=2.2
openpyxl>=3.1
PyYAML>=6.0
```

不得把 pytest 作为运行时依赖；pytest 使用外部测试包中的 `requirements-test.txt` 安装。

---

## 五、公共接口必须先固定

### 1. CleaningContext

建议使用不可变 dataclass：

```python
@dataclass(frozen=True)
class CleaningContext:
    shop_root: Path
    target: str
    start_date: date | None
    end_date: date | None
    output_dir: Path
```

### 2. LocatedSources

```python
@dataclass(frozen=True)
class LocatedSources:
    files: dict[str, list[Path]]
    metadata: dict[str, object]
```

### 3. Builder 统一接口

```python
def build(context: CleaningContext, sources: LocatedSources) -> pandas.DataFrame:
    ...
```

Builder 只负责：

```text
已定位原始文件
→ 读取
→ 字段清洗
→ 关联与计算
→ 返回严格表头顺序的 DataFrame
```

Builder 不负责：

- 查找目录或选择文件；
- Upsert；
- 写正式 Excel；
- 临时备份、原子替换和失败回滚；
- 调用数据导出 Skill。

### 4. Source Locator 接口

```python
def locate_sources(context: CleaningContext, table_config: dict) -> LocatedSources:
    ...
```

### 5. Upsert 接口

```python
def upsert_and_write(
    new_rows: pandas.DataFrame,
    output_path: Path,
    table_config: dict,
) -> dict:
    ...
```

---

## 六、cleaning.yaml 第一阶段要求

`cleaning.yaml`至少注册三张已实现表，并锁定输出名、是否需要日期、Builder、原始依赖和 Upsert 键。

示意结构：

```yaml
tables:
  广告户状态快照:
    output: 广告户状态快照.xlsx
    builder: advertiser_status
    requires_period: false
    sources:
      - advertiser_account_status
    upsert:
      key: [广告户ID, 采集日期]

  计划小时表现:
    output: 计划小时表现.xlsx
    builder: campaign_hourly
    requires_period: true
    sources:
      - campaign_hourly
      - advertiser_account_status
    upsert:
      primary_key: [计划ID, 日期, 小时]
      plan_name_fallback: [计划名称, 日期, 小时]

  计划诊断:
    output: 计划诊断.xlsx
    builder: campaign_diagnosis
    requires_period: true
    sources:
      - campaign_performance
      - campaign_current_config
      - campaign_recommendation_items
      - campaign_product_performance
      - campaign_product_creative_performance
      - advertiser_account_status
    upsert:
      primary_key: [计划ID, 统计开始日期, 统计结束日期]
      plan_name_fallback: [计划名称, 统计开始日期, 统计结束日期]
```

配置中的字段名可以优化，但含义不得偏离冻结规范。

剩余 13 张表可以暂不注册；或注册为 `implemented: false`。若被调用，必须明确报“尚未实现”，不能生成空表冒充成功。

---

## 七、公共组件开发要求

### 1. common.py

至少实现：

```text
normalize_id
normalize_text
normalize_date
normalize_datetime
normalize_hour
normalize_money
normalize_placeholder
safe_divide
parse_json_object
read_xlsx_rows / read_csv_rows
write_formatted_xlsx
```

固定规则：

- ID 始终保存为文本；
- `-`、`N/A`、`NaN`文本、空字符串按字段语义转空；
- 金额不保留货币符号；
- 比例底层使用 0—1；
- ROI 保持倍率；
- `safe_divide`：分母为 0 或空返回空；分母大于 0 且分子为 0 返回 0；
- 不能依赖 Excel 固定行号定位多级表头，应使用字段锚点。

### 2. source_locator.py

第一阶段必须实现：

#### 广告账户状态

```text
<shop-root>\广告户数据\广告账户状态\
```

选择文件名中采集日期最新的有效 `.xlsx`。

#### 计划小时表现

```text
<shop-root>\计划数据\GMV Max 计划小时表现\
```

读取目标日期范围内所有已经存在的：

```text
<计划名称>__YYYY-MM-DD.xlsx
```

要求：

- 读取范围内所有计划、所有日文件；
- 忽略范围外文件；
- 不反查某个计划是否理论上少一天；
- 范围内一个匹配文件都没有时，报缺少原始数据。

#### 计划诊断——精确区间文件

必须只读取与目标开始日、结束日完全匹配的文件，不能读取重叠月文件。

计划表现和计划商品表现：

```text
单日：<计划名称>__YYYY-MM-DD.xlsx
区间：<计划名称>__YYYY-MM-DD_至_YYYY-MM-DD.xlsx
```

计划商品素材表现：

```text
<计划名称>__<商品上下文>__YYYY-MM-DD_至_YYYY-MM-DD.xlsx
```

当前配置：同一计划选择文件名日期最新的一份。

建议快照：同一计划只读取最新的：

```text
<计划名称>__items__YYYY-MM-DD.xlsx
```

必须忽略 `summary`，即使 summary 文件损坏也不能影响计划诊断。

任一计划缺少正式依赖的 items 文件时，计划诊断失败，不生成不完整正式表。

### 3. upsert.py

必须按照冻结的 Upsert 规范实现：

- 复合键用有序 tuple，不做裸字符串拼接；
- 新键追加，旧键整行替换；
- 计划ID优先，缺失时计划名称兜底；
- 空计划ID不得覆盖旧行中的非空计划ID；
- 本次候选重复键且内容冲突时失败；
- 现有清洗表已经存在重复键时失败；
- 失败不得破坏已有正式文件。

安全写入流程：

```text
生成完整新结果
→ 写同目录临时文件
→ 校验临时文件
→ 备份旧正式文件（若存在）
→ 原子替换
→ 校验新正式文件
→ 成功后删除备份
→ 失败则恢复旧文件；首次创建则删除错误新文件
```

同一店铺、同一目标表不允许并发写入；第一阶段不建设复杂文件锁。

### 4. Excel 输出

- 工作表名统一使用 `数据`；
- 第一行必须是冻结表头，顺序完全一致；
- ID列写入文本并设置文本格式；
- 百分比列按百分比显示；
- 日期、日期时间使用统一显示格式；
- 冻结首行、开启筛选；
- 不新增说明列、内部键列或调试列。

---

## 八、三个 Builder 的开发顺序

## 阶段 A：广告户状态快照

### 输入

```text
广告户数据/广告账户状态/最新快照
```

### 必须实现

- 精确输出冻结表头；
- 解析 `account_snapshot_json`；
- 在 `authorization.autho_info_list[]` 中按 advertiser_id 选择对应项；
- 解析广告账户状态、GMV Max授权、CPS授权；
- 支付账户ID、状态、支付方式、币种、时区；
- Upsert 键：`广告户ID + 采集日期`；
- 相同键重新运行时替换，不追加；
- 本次源中相同键出现冲突行时失败，旧输出保持字节不变。

### 阶段验收命令

```powershell
$env:CLEANING_SKILL_ROOT = 'D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning'
python -m pytest -q `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests\tests\test_01_advertiser_status.py `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests\tests\test_04_contract_and_missing_source.py
```

该阶段测试全部通过后，才能进入阶段 B。

---

## 阶段 B：计划小时表现

### 输入

```text
计划数据/GMV Max 计划小时表现/目标日期范围内全部日文件
广告户数据/广告账户状态/最新快照
```

### 必须实现

- 读取目标范围内全部计划的日文件；
- 不读取范围外日期；
- 计算并重新生成：CTR、CPC、CPM、平均下单成本、实际ROI；
- 不信任 `cost_per_order_official`、`roi_official` 等测试中故意放入的错误值；
- 分母为0时输出空；
- Upsert 键：`计划ID + 日期 + 小时`，计划ID缺失时才使用计划名称；
- 相同键重跑时替换，不增加重复行。

### 阶段验收命令

```powershell
python -m pytest -q `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests\tests\test_02_campaign_hourly.py
```

该阶段测试通过后，再运行阶段 A+B 的累计测试；全部通过后进入阶段 C。

---

## 阶段 C：计划诊断

### 输入

```text
计划数据/GMV Max 计划表现/精确区间文件
计划数据/GMV Max 当前配置/每计划最新快照
计划数据/GMV Max 建议快照/每计划最新items
计划数据/GMV Max 计划商品表现/精确区间文件
计划数据/GMV Max 计划商品素材表现/精确区间文件
广告户数据/广告账户状态/最新快照
```

### 必须实现

- 精确区间文件优先，不能读取重叠月文件；
- 当前配置按计划选择最新日期；
- ROI建议只读取最新items，完全忽略summary；
- items文件缺失时失败，不创建计划诊断正式文件；
- items存在但没有ROI建议时：
  - ROI建议快照日期仍写入items日期；
  - 平台建议ROI、ROI竞争力百分位、平台建议摘要留空；
- ROI竞争力百分位原始75转换为底层0.75；
- 广告CTR、CPC、CPM、平均下单成本、实际ROI重新计算；
- 推广商品数按 Product ID 去重；
- 可用素材数：状态为`已探索`或`探索中`；
- Video内部键：`计划ID + 商品ID + Post ID`；
- Product card内部键：`计划ID + 商品ID + Creative type`；
- 有消耗素材数按相同素材键聚合后判断成本>0；
- Upsert键：`计划ID + 统计开始日期 + 统计结束日期`，ID缺失时名称兜底。

### 阶段验收命令

```powershell
python -m pytest -q `
  D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests\tests\test_03_campaign_diagnosis.py
```

---

## 九、开发执行顺序

Codex 必须严格按以下顺序进行：

### 0. 保护验收测试

```powershell
cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests
python verify_lock.py
```

预期：

```text
OK: 8 locked test files unchanged
```

如果失败，立即停止，不开始开发。

### 1. 创建虚拟环境与依赖

```powershell
cd D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install -r D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests\requirements-test.txt
```

### 2. 建立骨架和 CLI

完成项目结构、参数解析、目标注册、错误退出码、`--help`。

先确认：

```powershell
python scripts\run_cleaning.py --help
```

### 3. 实现公共组件

顺序：

```text
common.py
→ source_locator.py
→ upsert.py
→ run_cleaning.py调度
```

### 4. 实现广告户状态快照

通过阶段 A 测试后提交一次阶段记录，不进入后续表之前修完所有失败。

### 5. 实现计划小时表现

通过阶段 B 测试，并重新运行阶段 A+B。

### 6. 实现计划诊断

通过阶段 C 测试。

### 7. 全量第一阶段验收

```powershell
cd D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests
python verify_lock.py

$env:CLEANING_SKILL_ROOT = 'D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning'
python -m pytest -q D:\TikTok-Agent\tiktok_shop_cleaning_acceptance_tests\tests
```

必须同时满足：

- `verify_lock.py`成功；
- 外部测试全部通过；
- 不存在 xfail、skip 代替失败；
- 没有修改验收测试；
- 三张目标表重复运行不产生重复行；
- 失败案例不破坏旧正式文件。

### 8. 停止开发并提交报告

第一阶段测试全部通过后，不得自行继续实现剩余13张表。

更新：

```text
D:\TikTok-Agent\数据清洗\tiktok-shop-data-cleaning\DEVELOPMENT_REPORT.md
```

报告至少包含：

1. 新增/修改文件清单；
2. 项目结构；
3. 三张表的实现说明；
4. 实际执行过的测试命令；
5. pytest最终结果；
6. `verify_lock.py`最终结果；
7. 尚未实现的13张表；
8. 已知限制或仍需确认的问题；
9. 明确声明未修改四份冻结规范和外部验收测试。

---

## 十、Codex 禁止事项

- 不得修改外部验收测试及其哈希清单；
- 不得修改四份冻结业务规范；
- 不得为通过测试而硬编码测试店铺名、测试计划名、测试ID或测试日期；
- 不得针对测试样本写 `if Plan A`、`if PLAN-A` 等特例；
- 不得在缺少原始文件时创建空正式表并返回成功；
- 不得让 Builder 自己写正式文件；
- 不得让清洗表互相作为输入；
- 不得调用数据导出 Skill补文件；
- 不得直接覆盖正式文件而没有临时文件、校验及失败回滚；
- 不得在第一阶段自行实现剩余13张表；
- 不得把内部唯一键或调试字段写进固定清洗表头。

---

## 十一、代码质量要求

- Python函数和模块添加类型标注；
- 路径使用 `pathlib.Path`；
- 使用结构化错误码，不用静默 `except Exception: pass`；
- JSON解析失败应返回明确错误；
- 所有读取和写入统一使用UTF-8日志；
- 业务计算函数保持纯函数，便于后续测试；
- 不在多个Builder重复写同一金额、百分比、日期或safe_divide逻辑；
- 不把当前3张表的逻辑写成一个巨大脚本；
- 同时避免为尚未实现的13张表搭建无实际用途的复杂抽象。

---

## 十二、第一阶段完成标准

只有以下条件全部满足，第一阶段才算完成：

1. 项目骨架存在且CLI可执行；
2. 三张表严格生成到固定目录和固定文件名；
3. 三张表表头与外部 `EXPECTED_SCHEMAS` 完全一致；
4. 第一阶段外部测试全部通过；
5. 测试锁校验通过；
6. 相同数据重复运行不重复追加；
7. 缺源、重复键、写入失败不会损坏旧正式文件；
8. 没有测试样本特例和硬编码；
9. 开发报告完整；
10. Codex停止并等待下一批13张表的独立验收测试。
