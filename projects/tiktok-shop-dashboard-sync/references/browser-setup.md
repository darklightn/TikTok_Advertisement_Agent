# 网页操作规则

完整流程返回 `BROWSER_REQUIRED / 7` 时，同一个 Agent 读取本轮 `browser_task.json` 并继续网页操作。按任务区分首次页面初始化与 `repair_default_shop` 默认店铺修复；不要将修复任务当作新建页面。

使用已授权官方 CLI 核对资源；使用已登录的正常网页完成页面操作。浏览器不可用或登录失效时报告具体原因，不能用静态图或未执行的检查代替完成。

## 定位任务与页面

使用 `task.target` 的实际 url、base_token、table_id、dashboard_id；cards、texts、field_ids 均取自任务中的真实 ID。重跑复用 task_id，先检查现有组件再补缺失对象，不因组件名称通用而另建一套。

任务中的 defaults 是要保存的组合。临时查看选择与切片器配置中的已保存默认值分别核对，不将两者混用。

## 首次页面初始化

脚本创建或复用 10 张卡、三个模块标题和阅读说明。Agent 在现有对象上完成商品组件、切片器及布局。

### 商品组件

在正常网页使用“添加组件 → 表格/表格视图”，绑定老板底表，组件类型须为 view。逐条展示，不按商品名称分组；六字段顺序为：商品ID、商品名称、商品GMV、商品订单数、商品实际ROI、商品退款金额率。平台要求主字段可见时，另保留记录唯一键。

固定筛选仅设“记录类型=商品结果”，商品 GMV 降序。商品金额标 PHP、保留 2 位小数，订单 0 位，ROI 2 位，退款率按百分比显示 2 位；格式不改变底层比例值。

从网页组件对应的底层视图确认 view_id，再用官方表和视图读取核对归属。若组件 GET 不返回 view_id，须结合网页确认关联，不能仅凭 GET 宣称已确认。可按官方 CLI 的 view-set-filter、sort、group、visible-fields 设置视图，先读现状、设置后读回；回执续跑也会核对并补配视图规则。

### 切片器与默认组合

添加“店铺名称”“统计区间”两个下拉单选切片器，均绑定同一老板底表，关联 10 张卡和商品表共 11 个业务组件。检查固定 filter 没有写死某家店或某个区间。

保存 `task.defaults.shop_name` 与 `task.defaults.period.label`，刷新或重新打开页面，确认该默认组合仍存在。普通 sync 或已完成 init 重跑不重设默认值。区间选项可能包含其他店铺的区间；无匹配时按实际显示处理。

### 布局与可读性

从上到下排列：两个切片器、整体经营（PHP）五卡、广告表现（USD）五卡、商品表现表。模块标题与以下说明须可读：经营及广告币种、AOV采用《店铺诊断》已清洗的SKU订单口径结果、清空筛选后的合计不作为经营结果、空值显示 0 不一定代表真实业务零。

组件创建完成后，可使用官方 `+dashboard-arrange` 整理切片器、全宽商品表及模块内卡片和文本。仅在本机 CLI 帮助明确支持时使用公开 `--position` 参数；更新接口不支持 view 或 slicer 时，通过正常网页操作，不以删除重建代替更新。

布局操作后重新打开页面查看全部模块。文本更新若把换行转义显示，使用正常网页文本编辑器替换，再确认可读；说明组件高度须能显示全部说明。已初始化页面的普通同步不做布局整理。

### 联动检查与续跑

先核对默认组合的十卡和商品数据，再不重跑脚本直接切换另一有效店铺、另一个已有区间，等待页面刷新并核对数值。CLI 全量 chart 数据不能代表浏览器当前筛选下的数值。完成后刷新，确认已保存默认组合及页面仍正确。

按下述回执格式提交，初始化路线的 checks 包括：

`shop_single_select`、`period_single_select`、`defaults_saved`、`all_components_linked`、`product_view_relationship`、`product_formats_visible`、`units_visible`、`aov_note_visible`、`selection_notice_visible`、`shop_switch_confirmed`、`period_switch_confirmed`、`refresh_confirmed`、`layout_readable`。

用原完整 init 参数附加 `--browser-result "<回执路径>"` 续跑；不再同传 `--default-shop`，默认组合沿用任务。

## 默认店铺修复

当browser_task.kind=repair_default_shop时，只修改现有店铺切片器的已保存默认店铺名称；保持默认统计区间、组件ID、关联范围、其他筛选配置和页面布局不变；完成后提交browser_result并继续原sync流程。

1. 定位任务指定的现有店铺切片器，打开配置中的已保存默认值，将旧店名改为任务新店名。复用现有组件，不新建或重建切片器。
2. 刷新页面，核对保存的新店名、原统计区间、数据与组件身份；不要修改其他筛选设置或临时选择来代替保存。
3. 回执设置 `kind: repair_default_shop`；`components` 必须与任务完全一致，`defaults` 使用任务的新店名与原区间。checks 为 `saved_shop_default_updated`、`saved_period_default_unchanged`、`component_ids_unchanged`、`refresh_confirmed`，实际检查后填写。
4. 用原完整 sync 参数附加 `--browser-result "<回执路径>"` 继续。原 default_repair 的 task_id 保持不变；回执无效或组件不符时保留待办。状态更新规则见[执行规则](execution-rules.md)。

## browser_result 格式

将 `browser_result.json` 保存到 Skill 外部运行目录，字段如下：

| 字段 | 要求 |
|---|---|
| result_version | 整数 1 |
| task_id | 本轮任务的实际 task_id |
| target | 仅包含任务中的 base_token、table_id、dashboard_id |
| components.product | 实际 `{block_id, view_id}`，view_id 已核对归属 |
| components.slicers | 以“店铺名称”“统计区间”为键，值为实际组件 ID；与商品 block_id 共三个 ID 互不相同 |
| defaults | 与任务组合完全一致 |
| completed_at | 带时区的实际完成时间 |
| screenshots | 至少两张不同、真实、非空图片的绝对路径，覆盖页面顶部与商品区域；图片存放在外部运行目录 |
| checks | 对应路线的检查项，只有实际完成后才填写 true |
| kind | 默认店铺修复路线必须为 `repair_default_shop` |

图片应显示实际选择条件及相应页面内容，不能用图片存在代替联动或默认值核对。脚本校验回执及组件类型、底表、字段和商品视图配置，通过后返回 `PAGE_READY` 或 `PAGE_PARTIAL`。

向用户返回真实页面链接、已完成模块、数据范围和具体限制。新页面的布局、单位、可读性及切换体验可请用户反馈，但不要将未收到的反馈记为已确认，也不要要求用户手工创建组件。
