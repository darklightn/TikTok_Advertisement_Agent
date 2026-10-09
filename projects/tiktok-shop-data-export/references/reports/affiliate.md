# Affiliate 报表

## affiliate_center_performance

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "affiliate_center_performance",
  "enabled": true,
  "currency_contract": {
    "schema_version": "currency_contract_v1",
    "source_kind": "official_report_page_symbol",
    "output_kind": "embedded_table_metadata",
    "amount_scope": "all_monetary_fields",
    "currency_symbol": "₱",
    "currency_code": "PHP"
  },
  "explicit_only": false,
  "owner_scope": "shop",
  "required_variables": [
    "shop",
    "start_date",
    "end_date"
  ],
  "source_type": "official_download",
  "success_output_type": "official_xlsx",
  "no_data_output_type": null,
  "time_semantics": "requested_range",
  "output_granularity": "request_range",
  "providers": {
    "cross_border": {
      "origin": "https://affiliate.tiktokshopglobalselling.com",
      "runner": "scripts/routes/cross_border/affiliate_center_performance.js",
      "transport": "official_ui_download",
      "official_validation": {
        "blocking_overlay": {"dialog_selector": "[role=\"dialog\"]:visible", "button_pattern": "^(?:Got it|知道了|好的)$", "max_attempts": 2, "timeout_ms": 10000},
        "seller_origin": "https://seller.tiktokshopglobalselling.com",
        "navigation_steps": [
          "^(?:联盟|Affiliate)$",
          "^(?:数据分析|Data analytics)$",
          "^(?:表现|Performance)$"
        ],
        "shop_region": "PH",
        "entry_query_fields": {
          "shop_id": "shop_id",
          "shop_region": "shop_region"
        },
        "details_card_title_pattern": "^(?:详细信息|Details)$",
        "date_value_pattern": "^\\d{4}/\\d{1,2}/\\d{1,2}\\s*-\\s*\\d{4}/\\d{1,2}/\\d{1,2}$",
        "export_button_pattern": "^(?:导出数据|Export Data)$",
        "empty_state_pattern": "(?:暂无搜索结果|No (?:search )?results)",
        "calendar": {
          "dropdown_selector": ".core-trigger.core-dropdown:visible",
          "option_selector": "span.block.w-full.whitespace-nowrap",
          "option_count": 4,
          "custom_option_index": 3,
          "panel_selector": ".core-panel-date:visible",
          "panel_count": 2,
          "max_month_moves": 24,
          "header_selector": ".core-picker-header-value",
          "left_control_selector": "svg.arco-icon-left",
          "right_control_selector": "svg.arco-icon-right",
          "cell_any_selector": ".core-picker-cell-in-view .core-picker-date-value",
          "cell_selector": ".core-picker-cell-in-view:not(.core-picker-cell-disabled) .core-picker-date-value"
        },
        "create_endpoint": "/api/v1/oec/affiliate/compass/export_task/create",
        "export_endpoint": "/api/v1/oec/affiliate/compass/export_task/export",
        "seller_query": "oec_seller_id",
        "task_query": "task_id",
        "response_paths": {
          "create_task_id": [
            "data",
            "task_id"
          ]
        },
        "task_id_pattern": "^[A-Za-z0-9]+$",
        "data_start_row": 3,
        "request_timeout_ms": 90000,
        "page_stability_poll_ms": 100,
        "calendar_ready_timeout_ms": 10000,
        "download_timeout_ms": 180000
      },
      "retry_policy": {
        "max_total_attempts": 1,
        "retryable": [],
        "non_retryable": [
          "identity_error",
          "contract_error",
          "task_binding_error",
          "download_result_unknown"
        ]
      }
    },
    "local": {
      "origin": "https://affiliate.tiktok.com",
      "runner": "scripts/routes/local/affiliate_center_performance.js",
      "transport": "official_ui_download",
      "official_validation": {
        "blocking_overlay": {"dialog_selector": "[role=\"dialog\"]:visible", "button_pattern": "^(?:Got it|知道了|好的)$", "max_attempts": 2, "timeout_ms": 10000},
        "seller_origin": "https://seller-ph.tiktok.com",
        "seller_landing_path": "/affiliate/landing",
        "seller_landing_button": "前往联盟中心首页",
        "navigation_steps": [
          "^(?:联盟|Affiliate)$",
          "^(?:数据分析|Data analytics)$",
          "^(?:表现|Performance)$"
        ],
        "shop_region": "PH",
        "entry_query_fields": {
          "shop_id": "shop_id",
          "shop_region": "shop_region"
        },
        "details_card_title_pattern": "^(?:详细信息|Details)$",
        "date_value_pattern": "^\\d{4}/\\d{1,2}/\\d{1,2}\\s*-\\s*\\d{4}/\\d{1,2}/\\d{1,2}$",
        "export_button_pattern": "^(?:导出数据|Export Data)$",
        "export_locator": "button[data-testid=\"export-button\"]",
        "empty_state_pattern": "(?:暂无搜索结果|No (?:search )?results)",
        "calendar": {
          "dropdown_selector": ".core-trigger.core-dropdown:visible",
          "option_selector": "span.block.w-full.whitespace-nowrap",
          "option_count": 4,
          "custom_option_index": 3,
          "panel_selector": ".core-panel-date:visible",
          "panel_count": 2,
          "max_month_moves": 24,
          "header_selector": ".core-picker-header-value",
          "left_control_selector": "svg.arco-icon-left",
          "right_control_selector": "svg.arco-icon-right",
          "cell_any_selector": ".core-picker-cell-in-view .core-picker-date-value",
          "cell_selector": ".core-picker-cell-in-view:not(.core-picker-cell-disabled) .core-picker-date-value"
        },
        "create_endpoint": "/api/v1/oec/affiliate/compass/export_task/create",
        "export_endpoint": "/api/v1/oec/affiliate/compass/export_task/export",
        "seller_query": "oec_seller_id",
        "task_query": "task_id",
        "response_paths": {
          "create_task_id": [
            "data",
            "task_id"
          ]
        },
        "task_id_pattern": "^[A-Za-z0-9]+$",
        "data_start_row": 3,
        "request_timeout_ms": 90000,
        "page_stability_poll_ms": 100,
        "calendar_ready_timeout_ms": 10000,
        "download_timeout_ms": 180000
      },
      "retry_policy": {
        "max_total_attempts": 1,
        "retryable": [],
        "non_retryable": [
          "identity_error",
          "contract_error",
          "task_binding_error",
          "download_result_unknown"
        ]
      }
    }
  },
  "output_path_template": "店铺数据/联盟达人明细/{{time_file}}",
  "no_data_rule": "not_applicable"
}
```
<!-- report-spec:end -->

两侧必须从各自已识别的 Seller 页面通过左侧导航依次点击 `联盟/ Affiliate`、`数据分析/Data analytics`、`表现/Performance` 进入，不得直接拼接或跳转联盟入口 URL。导航后仍只接受各自 Provider 的联盟 origin、请求店铺 ID 与 `shop_region`。两侧只使用各自 Provider 节点声明的唯一导出控件及其同一区域日期范围；跨境仍绑定唯一 `详细信息/Details` 卡片，本土绑定 `button[data-testid="export-button"]`。请求日期必须原样应用并回显，不可选即失败，不得替换日期。每个 work unit 只点击一次：create 返回的字母数字 `task_id` 必须与随后官方 export request 的 `task_id`、冻结 seller query 及 `shop_region` 精确一致，随后只接受该点击触发的唯一下载事件。

官方文件在币种元数据嵌入前必须保持原字节；不校验官方原文件名、Sheet 名称/数量、表头文本、指标说明或业务键。工作簿必须可读，从第 3 行起至少存在一条非空数据行才成功。当前明细卡片没有可绑定的官方整数 `total=0` 信号，因此页面空态只允许失败，不生成 no-data 文件；页面未加载或日期不可选同样失败。同一明细卡片必须显示 `₱`；导出器把 `currency_code=PHP` 写入正式工作簿自定义元数据，不生成旁路 JSON。

## affiliate_performance_overview

本报表是候选能力，当前状态固定为 `enabled: false`，并保持在 v3 router 外。它不参与 `loadReportMd()` 或新 `export.js` 的执行。

已确认边界：

- 报表对象是 Affiliate Transaction Analysis 顶部 `Key metrics` 概览，不是 `affiliate_center_performance` 的达人明细。
- 页面控制区域是 `.pcm-smc-action-bar-actions`；不得复用达人明细的 `#details-list`。
- 来源属于 TikTok 官方下载，正式文件必须保持官方字节不变。
禁用原因：现有静态合同不能固定官方下载文件名及格式、Sheet/表头/data-start、稳定业务键、业务行规则、可信零数据规则，也不能证明点击与唯一官方文件的确定绑定。在这些事实由已提交的静态合同或用户明确接受的缩减能力补齐前，不得添加 report spec、router alias/scope 或 v3 runner，不得将本报表与达人明细合并。
