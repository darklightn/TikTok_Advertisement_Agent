# 店铺运营报表

## fulfillment_performance_snapshot

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "fulfillment_performance_snapshot",
  "enabled": true,
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/fulfillment_performance_snapshot.js",
      "api_contract": {
        "entry_path": "/compass/fulfillment",
        "response_paths": {
          "timeliness": "/api/v1/governance_fulfillment/seller_performance/timeliness/overview",
          "metrics": "/api/v1/governance_fulfillment/seller_performance/metrics/overview",
          "suggestions": "/api/v1/governance_fulfillment/seller_performance/suggestions/overview"
        },
        "seller_query": "oec_seller_id",
        "response_fields": {
          "success_code": "code",
          "alternate_success_code": [
            "BaseResp",
            "StatusCode"
          ],
          "timeliness_sum": "timeliness_data_sum",
          "timeliness_list": "timeliness_data_list",
          "timeliness_type": "metric_type",
          "timeliness_value": "value",
          "timeliness_diff": "timeliness_diff",
          "timeliness_previous": "last_cycle_value",
          "timeliness_industry_average": "industry_average",
          "timeliness_industry_name": "industry_name",
          "timeliness_period": "timeliness_period",
          "timeliness_metric_date": [
            "metric_date_info",
            "metric_date"
          ],
          "metrics_list": "metrics_data_list",
          "metric_type": "metric_type",
          "metric_value": "current_value",
          "metric_date_info": "metric_date_info",
          "metric_start": "metric_assessment_period_start",
          "metric_end": "metric_assessment_period_end",
          "metric_date": "metric_date",
          "metric_numerator": "current_numerator",
          "metric_denominator": "current_denominator",
          "metric_status": "current_label",
          "metric_assessment_by": "metric_assessment_by",
          "suggestions": "dispatch_suggestion"
        },
        "row_contract": {
          "timeliness_unit": "小时",
          "performance_unit": "%",
          "suggestion_unit": "订单数",
          "status_labels": {
            "1": "良好",
            "2": "有待提升"
          }
        },
        "sheet_name": "履约表现诊断快照",
        "timeliness_metric_labels": {
          "Stocking2Delivery": "待发货–已签收时间",
          "Stocking2RTS": "待发货–待揽收时间",
          "RTS2TTS": "待揽收–运输中时间",
          "TTS2Delivery": "运输中–已签收时间"
        },
        "performance_metric_labels": {
          "LDR": "延迟发货率",
          "SFCR": "商责取消率",
          "FDR": "快速发货率"
        },
        "suggestion_metric_labels": {
          "ship_within_twenty_four_hours": "24小时内发货",
          "auto_cancel_within_twenty_four_hours": "24小时内自动取消",
          "shipping_overdue": "备货超时"
        },
        "navigation_timeout_ms": 30000,
        "capture_timeout_ms": 45000,
        "poll_interval_ms": 100,
        "response_origin": "https://api16-normal-sg.tiktokshopglobalselling.com",
        "methods": {
          "timeliness": "POST",
          "metrics": "POST",
          "suggestions": "POST"
        }
      }
    },
    "local": {
      "runner": "scripts/routes/local/fulfillment_performance_snapshot.js",
      "api_contract": {
        "entry_path": "/compass/fulfillment",
        "response_paths": {
          "timeliness": "/api/v1/governance_fulfillment/seller_performance/timeliness/overview",
          "metrics": "/api/v1/governance_fulfillment/seller_performance/metrics/overview",
          "suggestions": "/api/v1/governance_fulfillment/seller_performance/suggestions/overview"
        },
        "seller_query": "oec_seller_id",
        "response_fields": {
          "success_code": "code",
          "alternate_success_code": [
            "BaseResp",
            "StatusCode"
          ],
          "timeliness_sum": "timeliness_data_sum",
          "timeliness_list": "timeliness_data_list",
          "timeliness_type": "metric_type",
          "timeliness_value": "value",
          "timeliness_diff": "timeliness_diff",
          "timeliness_previous": "last_cycle_value",
          "timeliness_industry_average": "industry_average",
          "timeliness_industry_name": "industry_name",
          "timeliness_period": "timeliness_period",
          "timeliness_metric_date": [
            "metric_date_info",
            "metric_date"
          ],
          "metrics_list": "metrics_data_list",
          "metric_type": "metric_type",
          "metric_value": "current_value",
          "metric_date_info": "metric_date_info",
          "metric_start": "metric_assessment_period_start",
          "metric_end": "metric_assessment_period_end",
          "metric_date": "metric_date",
          "metric_numerator": "current_numerator",
          "metric_denominator": "current_denominator",
          "metric_status": "current_label",
          "metric_assessment_by": "metric_assessment_by",
          "suggestions": "dispatch_suggestion"
        },
        "row_contract": {
          "timeliness_unit": "小时",
          "performance_unit": "%",
          "suggestion_unit": "订单数",
          "status_labels": {
            "1": "良好",
            "2": "有待提升"
          }
        },
        "sheet_name": "履约表现诊断快照",
        "timeliness_metric_labels": {
          "Stocking2Delivery": "待发货–已签收时间",
          "Stocking2RTS": "待发货–待揽收时间",
          "RTS2TTS": "待揽收–运输中时间",
          "TTS2Delivery": "运输中–已签收时间"
        },
        "performance_metric_labels": {
          "LDR": "延迟发货率",
          "SFCR": "商责取消率",
          "FDR": "快速发货率"
        },
        "suggestion_metric_labels": {
          "ship_within_twenty_four_hours": "24小时内发货",
          "auto_cancel_within_twenty_four_hours": "24小时内自动取消",
          "shipping_overdue": "备货超时"
        },
        "navigation_timeout_ms": 30000,
        "capture_timeout_ms": 45000,
        "poll_interval_ms": 100,
        "response_origin": "https://seller-ph.tiktok.com",
        "methods": {
          "timeliness": "POST",
          "metrics": "POST",
          "suggestions": "POST"
        }
      }
    }
  },
  "explicit_only": false,
  "owner_scope": "shop",
  "required_variables": [
    "shop"
  ],
  "source_type": "official_api",
  "success_output_type": "generated_xlsx",
  "no_data_output_type": null,
  "time_semantics": "current_snapshot",
  "output_granularity": "snapshot",
  "output_path_template": "店铺数据/履约表现快照/{{time_file}}",
  "headers": [
    "采集时间",
    "类别",
    "指标",
    "当前值",
    "单位",
    "较上期变化",
    "上期值",
    "行业均值",
    "行业分类",
    "评估开始",
    "评估结束",
    "指标日期",
    "分子",
    "分母",
    "官方状态",
    "统计口径"
  ],
  "required_key_columns": [
    "类别",
    "指标"
  ],
  "no_data_rule": "not_applicable",
  "sheet_count": 1,
  "header_rows": 1,
  "data_start_row": 2
}
```
<!-- report-spec:end -->

生成表的 `币种` 列使用 ISO 代码；当前退款金额页面证据 `₱` 固定映射为 `PHP`，不把符号写入金额单元格。禁用期间请求返回 failed/report_disabled，不创建或覆盖输出；重新启用需先补 provider 证据和独立 runner。

## inventory_snapshot

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "inventory_snapshot",
  "enabled": true,
  "explicit_only": false,
  "owner_scope": "shop",
  "required_variables": [
    "shop"
  ],
  "source_type": "official_api",
  "success_output_type": "generated_xlsx",
  "no_data_output_type": "generated_xlsx",
  "time_semantics": "current_snapshot",
  "output_granularity": "snapshot",
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/inventory_snapshot.js",
      "entry_path": "/product/stock",
      "response_origin": "https://api16-normal-sg.tiktokshopglobalselling.com",
      "endpoint_path": "/api/v1/product/stock/sku/list",
      "seller_query": "oec_seller_id",
      "response_fields": {
        "success_code": "code",
        "total": "total_sku_count",
        "records": "skus",
        "product_id": "product_id",
        "sku_id": "sku_id",
        "open_quantity": "open_quantity",
        "stock_days_left": "sku_stock_days_left",
        "replenishment_quantity": "sku_replenishment_quantity",
        "product_title": "product_title",
        "seller_sku": "seller_sku",
        "properties": "properties",
        "property_name": "name",
        "property_value": "value_name",
        "status": "status",
        "warehouse_total": "warehouse_total_quantity",
        "withholding": "withholding_quantity",
        "sales": "sku_sales",
        "forecast_sales": "sku_forecast_sales",
        "warehouse_list": "warehouse_stock_list",
        "warehouse_name": "warehouse_name"
      },
      "sheet_name": "库存诊断快照",
      "next_page_selector": "li.core-pagination-item-next",
      "disabled_class_marker": "disabled",
      "navigation_timeout_ms": 30000,
      "capture_timeout_ms": 20000,
      "poll_interval_ms": 100,
      "page_timeout_ms": 30000,
      "retry_policy": {
        "operation_class": "idempotent_read",
        "max_total_attempts": 2,
        "identity_and_contract_failures_retryable": false
      }
    },
    "local": {
      "runner": "scripts/routes/local/inventory_snapshot.js",
      "entry_path": "/product/stock",
      "response_origin": "https://seller-ph.tiktok.com",
      "endpoint_path": "/api/v1/product/stock/sku/list",
      "seller_query": "oec_seller_id",
      "response_fields": {
        "success_code": "code",
        "total": "total_sku_count",
        "records": "skus",
        "product_id": "product_id",
        "sku_id": "sku_id",
        "open_quantity": "open_quantity",
        "stock_days_left": "sku_stock_days_left",
        "replenishment_quantity": "sku_replenishment_quantity",
        "product_title": "product_title",
        "seller_sku": "seller_sku",
        "properties": "properties",
        "property_name": "name",
        "property_value": "value_name",
        "status": "status",
        "warehouse_total": "warehouse_total_quantity",
        "withholding": "withholding_quantity",
        "sales": "sku_sales",
        "forecast_sales": "sku_forecast_sales",
        "warehouse_list": "warehouse_stock_list",
        "warehouse_name": "warehouse_name"
      },
      "sheet_name": "库存诊断快照",
      "next_page_selector": "li.core-pagination-item-next",
      "disabled_class_marker": "disabled",
      "navigation_timeout_ms": 30000,
      "capture_timeout_ms": 20000,
      "poll_interval_ms": 100,
      "page_timeout_ms": 30000,
      "retry_policy": {
        "operation_class": "idempotent_read",
        "max_total_attempts": 2,
        "identity_and_contract_failures_retryable": false
      }
    }
  },
  "output_path_template": "店铺数据/库存快照/{{time_file}}",
  "headers": [
    "采集时间",
    "商品ID",
    "SKU ID",
    "商品名称",
    "商家SKU",
    "规格",
    "SKU状态原始值",
    "库存状态（计算）",
    "总库存",
    "可用库存",
    "锁定库存",
    "近30天销量",
    "未来30天销量预测",
    "建议补货数量",
    "官方可供应天数",
    "仓库名称（观察值）"
  ],
  "required_key_columns": [
    "商品ID",
    "SKU ID"
  ],
  "no_data_rule": "trusted_zero",
  "sheet_count": 1,
  "header_rows": 1,
  "data_start_row": 2
}
```
<!-- report-spec:end -->

执行从已验证 Seller 页面所属 origin 打开 `/product/stock`，只读取 `/api/v1/product/stock/sku/list`。请求开始时冻结一次 `shop.seller_id`；首响应及后续分页响应 URL 的 `oec_seller_id` 必须全部与该身份一致，不主动调用身份识别接口，也不从响应内容或店铺别名推断身份。

非空库存必须保持所有分页的 `code=0`、`total_sku_count` 一致、SKU ID 唯一，并最终严格收齐官方总数。只有同一冻结身份下首个有效响应同时满足 `code=0`、`total_sku_count=0`、`skus=[]` 才是可信零数据；runner 此时生成仅含本节表头的 XLSX。总数、分页、身份或结构矛盾均为 `failed`。

生成文件必须为单 Sheet、单行表头，数据从第二行开始；`商品ID`、`SKU ID` 均非空的行才计为业务记录。最终 `time_file` 使用一次导出会话开始时冻结的 `Asia/Manila` 采集业务日期，格式为 `YYYY-MM-DD.xlsx`；同日重采原子替换同日文件，不同日期文件互不覆盖。runner 不增加内部重试；调用层只允许同一逻辑请求的幂等读取最多两次，身份和契约错误不可重试。

## shop_health_snapshot

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "shop_health_snapshot",
  "enabled": true,
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/shop_health_snapshot.js",
      "api_contract": {
        "entry_path": "/health-center",
        "response_paths": {
          "score": "/api/v1/account/ahr/score",
          "overview": "/api/v1/seller/growth_center/violation/overview/get",
          "metrics": "/api/v1/seller/growth_center/shop/metrics_module/query"
        },
        "seller_query": "oec_seller_id",
        "response_fields": {
          "success_code": "code",
          "score": [
            "data",
            "score"
          ],
          "overview": [
            "data"
          ],
          "metrics_groups": [
            "data",
            "metric_groups"
          ],
          "overview_score": "violation_score",
          "overview_start": "start_time",
          "overview_end": "end_time",
          "overview_unread": "unread_violation_number",
          "metrics": "metrics",
          "group_key": "violation_type",
          "metric_key": "title",
          "metric_value": "value",
          "metric_unit": "unit",
          "metric_target": "target_value",
          "metric_operator": "operator",
          "metric_start": "start_time",
          "metric_end": "end_time",
          "metric_violation_count": "violation_count",
          "metric_tooltip": "tooltip"
        },
        "display_contract": {
          "operator_labels": {
            "3": ">=",
            "4": "<",
            "5": "<="
          },
          "percentage_unit": 101,
          "missing_metric_value": "blank"
        },
        "sheet_name": "店铺健康诊断快照",
        "navigation_timeout_ms": 30000,
        "capture_timeout_ms": 20000,
        "poll_interval_ms": 100,
        "response_origin": "https://api16-normal-sg.tiktokshopglobalselling.com",
        "methods": {
          "score": "GET",
          "overview": "GET",
          "metrics": "POST"
        }
      }
    },
    "local": {
      "runner": "scripts/routes/local/shop_health_snapshot.js",
      "api_contract": {
        "entry_path": "/health-center",
        "response_paths": {
          "score": "/api/v1/account/ahr/score",
          "overview": "/api/v1/seller/growth_center/violation/overview/get",
          "metrics": "/api/v1/seller/growth_center/shop/metrics_module/query"
        },
        "seller_query": "oec_seller_id",
        "response_fields": {
          "success_code": "code",
          "score": [
            "data",
            "score"
          ],
          "overview": [
            "data"
          ],
          "metrics_groups": [
            "data",
            "metric_groups"
          ],
          "overview_score": "violation_score",
          "overview_start": "start_time",
          "overview_end": "end_time",
          "overview_unread": "unread_violation_number",
          "metrics": "metrics",
          "group_key": "violation_type",
          "metric_key": "title",
          "metric_value": "value",
          "metric_unit": "unit",
          "metric_target": "target_value",
          "metric_operator": "operator",
          "metric_start": "start_time",
          "metric_end": "end_time",
          "metric_violation_count": "violation_count",
          "metric_tooltip": "tooltip"
        },
        "display_contract": {
          "operator_labels": {
            "3": ">=",
            "4": "<",
            "5": "<="
          },
          "percentage_unit": 101,
          "missing_metric_value": "blank"
        },
        "sheet_name": "店铺健康诊断快照",
        "navigation_timeout_ms": 30000,
        "capture_timeout_ms": 20000,
        "poll_interval_ms": 100,
        "response_origin": "https://seller-ph.tiktok.com",
        "methods": {
          "score": "GET",
          "overview": "GET",
          "metrics": "POST"
        }
      }
    }
  },
  "explicit_only": false,
  "owner_scope": "shop",
  "required_variables": [
    "shop"
  ],
  "source_type": "official_api",
  "success_output_type": "generated_xlsx",
  "no_data_output_type": null,
  "time_semantics": "current_snapshot",
  "output_granularity": "snapshot",
  "output_path_template": "店铺数据/店铺健康快照/{{time_file}}",
  "headers": [
    "采集时间",
    "类别",
    "指标",
    "当前值",
    "目标条件",
    "评估开始",
    "评估结束",
    "违规次数",
    "说明"
  ],
  "required_key_columns": [
    "类别",
    "指标"
  ],
  "no_data_rule": "not_applicable",
  "sheet_count": 1,
  "header_rows": 1,
  "data_start_row": 2
}
```
<!-- report-spec:end -->

local 于 2026-09-11 在 TK蚊帐1店验证首页与后续页真实 POST 请求体：固定 `search_condition`（tab=100、更新时间倒序）、`pagination_type=0`、`count=20`、`component_version=hit_ui_opt`，仅 `offset` 从 0 按 20 递增。响应虽然包含 cursor，但官方本次页码请求未使用它，禁止猜测 cursor 分页。runner 使用冻结店铺会话直接读取该已验证 API，不再依赖页码按钮。每页验证 Seller 绑定、可信总数不变、预期行数及非空唯一售后 ID；多页结束后复核首页总数和 ID 顺序。重复、总数或首页漂移均拒绝完整成功，不自动重试，不覆盖旧正式文件。cross_border 保留其原有独立 UI 分页合同，本次没有跨境店 live 证据，不套用本土店新分页请求。

## returns_refunds_snapshot

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "returns_refunds_snapshot",
  "enabled": true,
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/returns_refunds_snapshot.js",
      "api_contract": {
        "entry_path": "/order/return",
        "entry_query": {
          "order_sort_comp": "OrderSort_UPADTE_TIME_DESC",
          "tab": "100"
        },
        "endpoint_path": "/api/v1/reverse/component/orders/list",
        "seller_query": "oec_seller_id",
        "zero_records_policy": "missing_or_empty",
        "response_fields": {
          "success_code": "code",
          "total": [
            "data",
            "total_count"
          ],
          "records": [
            "data",
            "cards"
          ],
          "record_key": [
            "biz_data",
            "reverse_main_order_id"
          ]
        },
        "card_contract": {
          "named_nodes_field": "message_content",
          "timestamp_field": "target_timestamp",
          "currency_symbol": "₱",
          "refund_amount_nodes": [
            "amount_refund",
            "reason_evidence"
          ],
          "sheet_name": "退货退款诊断快照",
          "biz_data": "biz_data",
          "card": "card",
          "main_order_id": "main_order_id",
          "reverse_order_id": "reverse_main_order_id",
          "return_price": "return_price",
          "nodes": {
            "application_time": "header_right_time",
            "reverse_type": "reason_reverse_type",
            "reason": "reason_name",
            "note": "reason_note",
            "product": "product_title",
            "paid": "product_paid",
            "status": "status_description",
            "logistics_status": "fulfillment_return_button",
            "logistics_time": "fulfillment_return_time",
            "tags": "tag_strategy",
            "evidence": "reason_evidence"
          },
          "reason_labels": [
            "售后原因",
            "After-sales reason"
          ],
          "note_labels": [
            "客户备注",
            "Customer note"
          ],
          "tag_exclusion_pattern": "调查后|如需|仔细检查|解决方案",
          "evidence_media_path": [
            "media",
            "data"
          ]
        },
        "page_control_template": "li[aria-label=\"第 {{page_number}} 页\"]",
        "empty_state_patterns": {
          "page_title": "退货退款管理",
          "empty_marker": "暂无工单",
          "order_marker": "(?:订单 ID|Order ID)\\s*[:：]",
          "summary_zero": [
            "24 小时内回复|Respond within 24 hours",
            "自动批准（过去 7 天）|Auto-approved \\(last 7d\\)",
            "可申诉|Can be appealed",
            "等待回复的争议|Disputes awaiting response"
          ],
          "pending_zero": [
            "等待商家处理",
            "等待 TikTok Shop/客户处理"
          ]
        },
        "navigation_timeout_ms": 30000,
        "current_page_timeout_ms": 60000,
        "list_timeout_ms": 60000,
        "poll_interval_ms": 500,
        "page_control_timeout_ms": 5000,
        "page_response_timeout_ms": 15000,
        "response_origin": "https://api16-normal-sg.tiktokshopglobalselling.com",
        "method": "POST"
      }
    },
    "local": {
      "runner": "scripts/routes/local/returns_refunds_snapshot.js",
      "api_contract": {
        "endpoint_path": "/api/v1/reverse/component/orders/list",
        "seller_query": "oec_seller_id",
        "zero_records_policy": "missing_or_empty",
        "response_fields": {
          "success_code": "code",
          "total": [
            "data",
            "total_count"
          ],
          "records": [
            "data",
            "cards"
          ],
          "record_key": [
            "biz_data",
            "reverse_main_order_id"
          ]
        },
        "card_contract": {
          "named_nodes_field": "message_content",
          "timestamp_field": "target_timestamp",
          "currency_symbol": "₱",
          "refund_amount_nodes": [
            "amount_refund",
            "reason_evidence"
          ],
          "sheet_name": "退货退款诊断快照",
          "biz_data": "biz_data",
          "card": "card",
          "main_order_id": "main_order_id",
          "reverse_order_id": "reverse_main_order_id",
          "return_price": "return_price",
          "nodes": {
            "application_time": "header_right_time",
            "reverse_type": "reason_reverse_type",
            "reason": "reason_name",
            "note": "reason_note",
            "product": "product_title",
            "paid": "product_paid",
            "status": "status_description",
            "logistics_status": "fulfillment_return_button",
            "logistics_time": "fulfillment_return_time",
            "tags": "tag_strategy",
            "evidence": "reason_evidence"
          },
          "reason_labels": [
            "售后原因",
            "After-sales reason"
          ],
          "note_labels": [
            "客户备注",
            "Customer note"
          ],
          "tag_exclusion_pattern": "调查后|如需|仔细检查|解决方案",
          "evidence_media_path": [
            "media",
            "data"
          ]
        },
        "page_response_timeout_ms": 15000,
        "response_origin": "https://seller-ph.tiktok.com",
        "method": "POST",
        "seller_queries": [
          "oec_seller_id",
          "seller_id"
        ],
        "request_query": {
          "locale": "zh-CN",
          "language": "zh-CN"
        },
        "request_body": {
          "search_condition": {
            "tab": {
              "str_value_list": [
                "100"
              ]
            },
            "order_sort_comp": {
              "str_value_list": [
                "OrderSort_UPADTE_TIME_DESC"
              ]
            }
          },
          "pagination_type": 0,
          "offset": 0,
          "count": 20,
          "component_version": "hit_ui_opt"
        }
      }
    }
  },
  "explicit_only": false,
  "owner_scope": "shop",
  "required_variables": [
    "shop"
  ],
  "source_type": "official_api",
  "success_output_type": "generated_xlsx",
  "no_data_output_type": "generated_xlsx",
  "time_semantics": "current_snapshot",
  "output_granularity": "snapshot",
  "output_path_template": "店铺数据/退货退款快照/{{time_file}}",
  "headers": [
    "采集时间",
    "订单ID",
    "售后单号",
    "售后申请时间",
    "售后类型",
    "售后原因",
    "客户说明",
    "商品摘要",
    "订单实付",
    "退款金额",
    "币种",
    "处理状态",
    "退货物流状态",
    "退货物流时间",
    "平台标签",
    "客户凭证数量"
  ],
  "required_key_columns": [
    "售后单号"
  ],
  "no_data_rule": "trusted_zero",
  "sheet_count": 1,
  "header_rows": 1,
  "data_start_row": 2
}
```
<!-- report-spec:end -->

禁用期间请求返回 failed/report_disabled，不创建或覆盖输出；重新启用需先补 provider 证据和独立 runner。

## shop_promotion_performance

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "shop_promotion_performance",
  "enabled": true,
  "currency_contract": {
    "schema_version": "currency_contract_v1",
    "source_kind": "official_report_page_symbol",
    "output_kind": "embedded_table_metadata",
    "amount_scope": "all_monetary_fields",
    "currency_symbol": "₱",
    "currency_code": "PHP"
  },
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/shop_promotion_performance.js",
      "official_validation": {
        "date_application": "picker",
        "business_timezone": "Asia/Manila",
        "entry_path": "/compass/promotion-analytics",
        "entry_query": {
          "range": "timeRange",
          "shortcut": "shortcut",
          "shortcut_value": "custom",
          "end_semantics": "exclusive_next_day"
        },
        "date_picker_selector": "[data-tid=\"m4b_date_picker_range_picker\"]",
        "date_input_selector": "input",
        "panel_selector": ".theme-arco-panel-date",
        "panel_visible_selector": ".theme-arco-panel-date:visible",
        "header_label_selector": ".theme-arco-picker-header-label",
        "header_control_selector": ".theme-arco-picker-header-icon:not(.theme-arco-picker-header-icon-hidden)",
        "date_cell_selector": ".theme-arco-picker-cell-in-view:not(.theme-arco-picker-cell-disabled)",
        "date_cell_disabled_selector": ".theme-arco-picker-cell-in-view.theme-arco-picker-cell-disabled",
        "suffix_icon_selector": ".theme-arco-picker-suffix-icon",
        "date_refresh_path": "/api/v1/insights/seller/shop/promotion/period/stats",
        "date_response_origin": "https://api16-normal-sg.tiktokshopglobalselling.com",
        "export_selector": "[data-testid=\"export-button\"]",
        "navigation_timeout_ms": 90000,
        "picker_timeout_ms": 90000,
        "picker_open_timeout_ms": 3000,
        "date_apply_timeout_ms": 30000,
        "download_timeout_ms": 90000,
        "max_month_moves": 120,
        "max_picker_attempts": 3,
        "data_start_row": 3,
        "response_origin": "https://seller.tiktokshopglobalselling.com"
      }
    },
    "local": {
      "runner": "scripts/routes/local/shop_promotion_performance.js",
      "official_validation": {
        "date_application": "local_picker",
        "business_timezone": "Asia/Manila",
        "entry_path": "/compass/promotion-analytics",
        "entry_query": {
          "range": "timeRange",
          "shortcut": "shortcut",
          "shortcut_value": "custom",
          "end_semantics": "exclusive_next_day"
        },
        "date_picker_selector": "[data-tid=\"m4b_date_picker_range_picker\"]",
        "date_picker_disabled_class": "theme-arco-picker-disabled",
        "date_picker_input_selector": "input",
        "panel_visible_selector": ".theme-arco-panel-date:visible",
        "header_label_selector": ".theme-arco-picker-header-label",
        "header_control_selector": ".theme-arco-picker-header-icon:not(.theme-arco-picker-header-icon-hidden)",
        "date_cell_selector": ".theme-arco-picker-cell-in-view:not(.theme-arco-picker-cell-disabled)",
        "date_cell_disabled_selector": ".theme-arco-picker-cell-in-view.theme-arco-picker-cell-disabled",
        "export_selector": "[data-testid=\"export-button\"]",
        "navigation_timeout_ms": 90000,
        "picker_timeout_ms": 90000,
        "picker_open_timeout_ms": 3000,
        "date_apply_timeout_ms": 30000,
        "download_timeout_ms": 90000,
        "max_month_moves": 120,
        "data_start_row": 3,
        "response_origin": "https://seller-ph.tiktok.com"
      }
    }
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
  "output_path_template": "店铺数据/营销活动表现/{{time_file}}",
  "no_data_rule": "not_applicable"
}
```
<!-- report-spec:end -->

两侧 runner 只绑定冻结 Seller、官方日期应用证据与唯一官方导出控件：跨境使用目标统计刷新响应，本土使用 picker 的两个最终输入值（本土页面不要求把日期写入 URL）。日期预检以 `Asia/Manila` 业务日为准，只拒绝未来日期；请求包含当天时继续进入官方 picker，若当天日期格明确禁用则返回 `current_date_not_exportable`，其他 picker/刷新故障保留各自具体错误码。下载文件不校验原文件名、Sheet、表头、日期 banner 或业务键；工作簿必须可读，第 3 行起至少一条非空数据行才成功。当前没有下载前官方整数 `total=0` 信号，因此下载后零数据行必须失败并保留旧文件，不产生 no-data。同一营销活动报告页必须显示 `₱`，导出器据此把 `currency_code=PHP` 写入正式工作簿自定义元数据，不生成旁路 JSON。

## shop_creative_hub_video

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "shop_creative_hub_video",
  "enabled": true,
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/shop_creative_hub_video.js",
      "official_validation": {
        "response_origin": "https://seller.tiktokshopglobalselling.com",
        "probe_endpoint": "/oec_ads/shopping/v1/oec/stat/post_video_list",
        "create_endpoint": "/oec_ads/shopping/v1/oec/stat/post_video_list",
        "task_query_endpoint": "/oec_ads/shopping/v1/oec/stat/download_task/query",
        "scene": "creative_hub_video_export",
        "task_scene_response_policy": "optional_match",
        "query_parameters": {
          "seller_id": "oec_seller_id",
          "advertiser_id": "aadvid",
          "business_center_id": "bc_id",
          "locale": "locale",
          "language": "language"
        },
        "query_constants": {
          "locale": "zh",
          "language": "zh"
        },
        "request_fields": {
          "common_request": "common_req",
          "task_scene": "download_scene",
          "task_id": "download_id"
        },
        "common_request": {
          "page": 1,
          "probe_page_size": 20,
          "create_page_size": -1,
          "sort_stat": "onsite_roi2_shopping_value",
          "sort_order": 1,
          "filters": [
            {
              "field": "ads_video_scenario",
              "filter_type": 10,
              "in_field_values": [
                "2"
              ]
            }
          ],
          "dimensions": [
            "item_id",
            "spu_id",
            "pre_item_id"
          ],
          "metrics": [
            "material_name",
            "creator_user_name",
            "product_name",
            "user_item_authorization_type",
            "user_item_authorization_status",
            "onsite_roi2_shopping_value",
            "item_post_time",
            "onsite_roi2_shopping_sku",
            "mixed_real_cost",
            "mixed_real_cost_per_onsite_roi2_shopping_sku",
            "onsite_mixed_real_roi2_shopping_usd",
            "roi2_show_cnt",
            "roi2_click_cnt",
            "roi2_ctr",
            "onsite_shopping_sku_cvr",
            "play_2s_rate",
            "play_6s_rate",
            "high_performance_tag",
            "pre_review_status",
            "ads_video_scenario",
            "currency"
          ],
          "start_date_field": "st",
          "end_date_field": "et"
        },
        "create_action": {
          "field": "action",
          "value": "download"
        },
        "response_paths": {
          "probe_total": [
            "data",
            "pagination",
            "total_count"
          ],
          "create_task_id": [
            "extra",
            "task_id"
          ],
          "task_list": [
            "offline_tasks"
          ],
          "task_id": [
            "download_id"
          ],
          "task_scene": [
            "download_scene"
          ],
          "task_status": [
            "task_status"
          ],
          "task_url": [
            "url"
          ]
        },
        "task_statuses": {
          "pending": [
            "PENDING"
          ],
          "success": [
            "SUCCESS"
          ],
          "failed": [
            "FAILED",
            "CANCELLED"
          ]
        },
        "poll_interval_ms": 500,
        "max_polls": 360,
        "request_timeout_ms": 30000,
        "download_timeout_ms": 90000,
        "data_start_row": 2
      }
    },
    "local": {
      "runner": "scripts/routes/local/shop_creative_hub_video.js",
      "official_validation": {
        "response_origin": "https://seller-ph.tiktok.com",
        "probe_endpoint": "/oec_ads/shopping/v1/oec/stat/post_video_list",
        "create_endpoint": "/oec_ads/shopping/v1/oec/stat/post_video_list",
        "task_query_endpoint": "/oec_ads/shopping/v1/oec/stat/download_task/query",
        "scene": "creative_hub_video_export",
        "task_scene_response_policy": "optional_match",
        "query_parameters": {
          "seller_id": "oec_seller_id",
          "advertiser_id": "aadvid",
          "business_center_id": "bc_id",
          "locale": "locale",
          "language": "language"
        },
        "query_constants": {
          "locale": "zh",
          "language": "zh"
        },
        "request_fields": {
          "common_request": "common_req",
          "task_scene": "download_scene",
          "task_id": "download_id"
        },
        "common_request": {
          "page": 1,
          "probe_page_size": 20,
          "create_page_size": -1,
          "sort_stat": "onsite_roi2_shopping_value",
          "sort_order": 1,
          "filters": [
            {
              "field": "ads_video_scenario",
              "filter_type": 10,
              "in_field_values": [
                "2"
              ]
            }
          ],
          "dimensions": [
            "item_id",
            "spu_id",
            "pre_item_id"
          ],
          "metrics": [
            "material_name",
            "creator_user_name",
            "product_name",
            "user_item_authorization_type",
            "user_item_authorization_status",
            "onsite_roi2_shopping_value",
            "item_post_time",
            "onsite_roi2_shopping_sku",
            "mixed_real_cost",
            "mixed_real_cost_per_onsite_roi2_shopping_sku",
            "onsite_mixed_real_roi2_shopping_usd",
            "roi2_show_cnt",
            "roi2_click_cnt",
            "roi2_ctr",
            "onsite_shopping_sku_cvr",
            "play_2s_rate",
            "play_6s_rate",
            "high_performance_tag",
            "pre_review_status",
            "ads_video_scenario",
            "currency"
          ],
          "start_date_field": "st",
          "end_date_field": "et"
        },
        "create_action": {
          "field": "action",
          "value": "download"
        },
        "response_paths": {
          "probe_total": [
            "data",
            "pagination",
            "total_count"
          ],
          "create_task_id": [
            "extra",
            "task_id"
          ],
          "task_list": [
            "offline_tasks"
          ],
          "task_id": [
            "download_id"
          ],
          "task_scene": [
            "download_scene"
          ],
          "task_status": [
            "task_status"
          ],
          "task_url": [
            "url"
          ]
        },
        "task_statuses": {
          "pending": [
            "PENDING"
          ],
          "success": [
            "SUCCESS"
          ],
          "failed": [
            "FAILED",
            "CANCELLED"
          ]
        },
        "poll_interval_ms": 500,
        "max_polls": 360,
        "request_timeout_ms": 30000,
        "download_timeout_ms": 90000,
        "data_start_row": 2
      }
    }
  },
  "explicit_only": false,
  "owner_scope": "shop",
  "required_variables": [
    "shop",
    "advertiser",
    "start_date",
    "end_date"
  ],
  "source_type": "official_download",
  "success_output_type": "official_xlsx",
  "no_data_output_type": "generated_xlsx",
  "time_semantics": "requested_range",
  "output_granularity": "request_range",
  "output_path_template": "店铺数据/店铺素材中心视频/{{time_file}}",
  "headers": [
    "Video ID",
    "Product ID",
    "视频标题",
    "Username",
    "Product name",
    "Authorization type",
    "Authorization status",
    "Gross revenue",
    "Time posted",
    "SKU orders",
    "成本",
    "平均下单成本",
    "ROI",
    "Product ad impressions",
    "Product ad clicks",
    "Product ad click rate",
    "Ad conversion rate",
    "2-second ad video view rate",
    "6-second ad video view rate",
    "Tag",
    "Pre-review status",
    "Video source",
    "币种"
  ],
  "required_key_columns": [
    "Video ID",
    "Product ID"
  ],
  "no_data_rule": "official_api_total_zero"
}
```
<!-- report-spec:end -->

两侧 runner 只绑定各自 Seller origin、冻结身份、probe、create 与精确 task。probe total 为零时生成既有空表；正值下载保持原字节，不校验原文件名、Sheet、表头或业务键，工作簿必须可读，第 2 行起至少一条非空数据行才成功。异步任务失败必须保留脱敏诊断：创建 `task_id`、轮询次数与耗时、候选数、精确匹配数、最近状态、状态计数及 URL 是否存在；不得记录完整响应或 signed URL。`official_task_timeout` 必须区分 `task_not_observed` 与 `still_processing`。

## shop_product_daily_performance

<!-- report-spec:start -->
```json
{
  "schema_version":"report_spec_v1","report_id":"shop_product_daily_performance","enabled":true,"explicit_only":false,
  "owner_scope":"shop","required_variables":["shop","start_date","end_date"],"source_type":"official_api","success_output_type":"generated_xlsx","no_data_output_type":"generated_xlsx",
  "time_semantics":"requested_range","output_granularity":"request_range","single_day_time_file":true,
  "providers":{"cross_border":{"runner":"scripts/routes/cross_border/shop_product_daily_performance.js","transport":"page_context_fetch","response_origin":"https://api16-normal-sg.tiktokshopglobalselling.com","entry_path":"/compass/product-analysis","endpoint_path":"/api/v3/insights/seller/ttp/product/list","request_timeout_ms":30000,"api_contract":{"page_size":100,"channels":[{"type":0,"logical_table":"total"},{"type":1,"logical_table":"self_live"},{"type":2,"logical_table":"self_video"},{"type":3,"logical_table":"affiliate_content"},{"type":4,"logical_table":"product_card"}],"rules":[{"field":"gmv","direction":2}],"date_end":"requested_end_plus_one_day","request_fields":{"root":"request","time":"time_descriptor","start":"start","end":"end","search":"search","channel":"channel_type","list_control":"list_control","pagination":"pagination","page":"page","size":"size","rules":"rules"},"pagination_fields":{"total":"total","has_more":"has_more"},"pagination":"zero_based_page_with_total_and_has_more","record_path":["data","items"],"record_key_path":["meta","product_id"],"pagination_path":["data","list_control","next_pagination"],"max_pages":100},"retry_policy":{"operation_class":"idempotent_read","max_total_attempts":1,"identity_and_contract_failures_retryable":false}},"local":{"runner":"scripts/routes/local/shop_product_daily_performance.js","transport":"page_context_fetch","response_origin":"https://seller-ph.tiktok.com","entry_path":"/compass/product-analysis","endpoint_path":"/api/v3/insights/seller/ttp/product/list","seller_query_names":["oec_seller_id","seller_id"],"pagination_next_page_field":"next_page","request_timeout_ms":30000,"api_contract":{"page_size":100,"channels":[{"type":0,"logical_table":"total"},{"type":1,"logical_table":"self_live"},{"type":2,"logical_table":"self_video"},{"type":3,"logical_table":"affiliate_content"},{"type":4,"logical_table":"product_card"}],"rules":[{"field":"gmv","direction":2}],"date_end":"requested_end_plus_one_day","request_fields":{"root":"request","time":"time_descriptor","start":"start","end":"end","search":"search","channel":"channel_type","list_control":"list_control","pagination":"pagination","page":"page","size":"size","rules":"rules"},"pagination_fields":{"total":"total","has_more":"has_more"},"pagination":"zero_based_page_with_total_and_has_more","record_path":["data","items"],"record_key_path":["meta","product_id"],"pagination_path":["data","list_control","next_pagination"],"max_pages":100},"retry_policy":{"operation_class":"idempotent_read","max_total_attempts":1,"identity_and_contract_failures_retryable":false}}},
  "output_path_template":"店铺数据/商品表现/{{time_file}}",
  "logical_tables":[
    {"logical_table":"total","output_directory":"整体","headers":["start_date","end_date","product_id","product_meta_json","channel_record_json"],"required_key_columns":["product_id"]},
    {"logical_table":"self_live","output_directory":"商家直播","headers":["start_date","end_date","product_id","product_meta_json","channel_record_json"],"required_key_columns":["product_id"]},
    {"logical_table":"self_video","output_directory":"商家短视频","headers":["start_date","end_date","product_id","product_meta_json","channel_record_json"],"required_key_columns":["product_id"]},
    {"logical_table":"affiliate_content","output_directory":"联盟","headers":["start_date","end_date","product_id","product_meta_json","channel_record_json"],"required_key_columns":["product_id"]},
    {"logical_table":"product_card","output_directory":"商品卡","headers":["start_date","end_date","product_id","product_meta_json","channel_record_json"],"required_key_columns":["product_id"]}
  ],
  "no_data_rule":"official_api_zero_total"
}
```
<!-- report-spec:end -->

五个 `channel_type=0..4` 是五张独立逻辑表，不相加也不合并。单日直接传单日范围，区间直接传请求范围，官方结束日使用请求结束日的次日（exclusive）；不在 runner 内拆成逐日请求。分页总数必须稳定，`meta.product_id` 必须为唯一数字 ID，其他嵌套属性按确定性 JSON 写入固定 JSON 文本列。总表官方总数为零时，五张表均发布同表头空表；非零时其他渠道的商品 ID 必须属于总表商品集合。每个文件单 Sheet、首行为对应 `logical_tables` 表头，数据从第二行开始。

## shop_video_performance

<!-- report-spec:start -->
```json
{
  "schema_version":"report_spec_v1","report_id":"shop_video_performance","enabled":true,"explicit_only":false,
  "owner_scope":"shop","required_variables":["shop","start_date","end_date"],"source_type":"official_api","success_output_type":"generated_xlsx","no_data_output_type":"generated_xlsx","time_semantics":"requested_range","output_granularity":"request_range",
  "output_path_template":"店铺数据/店铺短视频表现/{{time_file}}","headers":["video_id","video_meta_json","stats_json"],"required_key_columns":["video_id"],"no_data_rule":"official_api_zero_total",
  "providers":{"cross_border":{"runner":"scripts/routes/cross_border/shop_video_performance.js","transport":"seller_page_post","response_origin":"https://seller.tiktokshopglobalselling.com","api_contract":{"endpoint_path":"/api/v2/insights/seller/shop/video/analytics/video/list","page_size":10,"timezone_offset_seconds":28800,"filter":{"author_type":[1,2],"creator_ids":[],"only_boost_video":false,"get_only_accessible_videos":true,"enable_violation_diagnosis":false},"rules":[{"direction":2,"field":"SHOP_VIDEO_ANALYTICS_VIDEO_LIST_REVENUE"}],"stats_types":[2,6,3,5,8,100,80,63,65,203,20,60,61],"date_end":"requested_end_plus_one_day","request_shape":{"root":"request","params":"params","time":"time_descriptor","start":"start","end":"end","timezone":"timezone_offset","granularity_field":"granularity","granularity":"1D","scenario_field":"scenario","scenario":7,"filter":"filter","list_control":"list_control","rules":"rules","pagination":"pagination","size":"size","page":"page","stats_types":"stats_types","version_field":"version","version":2},"timed_fields":{"start":"start","end":"end"},"pagination_fields":{"total":"total","page_count":"total_page"},"identity_field":"shop_id","record_meta_field":"video_meta","record_path":["data","segments",0,"timed_lists",0,"stats"],"record_key_path":["video_meta","id"],"pagination_path":["data","segments",0,"list_control","next_pagination"],"search_params":{"locale":"en","language":"en","seller_query_names":["oec_seller_id","seller_id"]},"request_timeout_ms":30000,"max_pages":100}},"local":{"runner":"scripts/routes/local/shop_video_performance.js","transport":"seller_page_post","response_origin":"https://seller-ph.tiktok.com","api_contract":{"endpoint_path":"/api/v2/insights/seller/shop/video/analytics/video/list","page_size":10,"timezone_offset_seconds":28800,"filter":{"author_type":[1,2],"creator_ids":[],"only_boost_video":false,"get_only_accessible_videos":true,"enable_violation_diagnosis":false},"rules":[{"direction":2,"field":"SHOP_VIDEO_ANALYTICS_VIDEO_LIST_REVENUE"}],"stats_types":[2,6,3,5,8,100,80,63,65,203,20,60,61],"date_end":"requested_end_plus_one_day","request_shape":{"root":"request","params":"params","time":"time_descriptor","start":"start","end":"end","timezone":"timezone_offset","granularity_field":"granularity","granularity":"1D","scenario_field":"scenario","scenario":7,"filter":"filter","list_control":"list_control","rules":"rules","pagination":"pagination","size":"size","page":"page","stats_types":"stats_types","version_field":"version","version":2},"timed_fields":{"start":"start","end":"end"},"pagination_fields":{"total":"total","page_count":"total_page"},"identity_field":"shop_id","record_meta_field":"video_meta","record_path":["data","segments",0,"timed_lists",0,"stats"],"record_key_path":["video_meta","id"],"pagination_path":["data","segments",0,"list_control","next_pagination"],"search_params":{"locale":"en","language":"en","seller_query_names":["oec_seller_id","seller_id"]},"request_timeout_ms":30000,"max_pages":100}}}
}
```
<!-- report-spec:end -->

请求闭区间结束日转换为官方 exclusive 次日。所有页的 `total/total_page`、日期与冻结 seller 身份必须一致，`video_meta.id` 唯一；`video_meta` 与其余指标分别确定性序列化为固定 JSON 文本列。显式 `total=0,total_page=0` 是可信空表。

## shop_product_growth_opportunity_snapshot

<!-- report-spec:start -->
```json
{
  "schema_version":"report_spec_v1","report_id":"shop_product_growth_opportunity_snapshot","enabled":true,"explicit_only":false,
  "owner_scope":"shop","required_variables":["shop"],"source_type":"official_api","success_output_type":"generated_xlsx","no_data_output_type":"generated_xlsx","time_semantics":"current_snapshot","output_granularity":"snapshot",
  "output_path_template":"店铺数据/商品成长机会快照/{{time_file}}","headers":["product_id","product_record_json"],"required_key_columns":["product_id"],"no_data_rule":"official_api_zero_total",
  "providers":{"cross_border":{"runner":"scripts/routes/cross_border/shop_product_growth_opportunity_snapshot.js","transport":"seller_page_post","response_origin":"https://seller.tiktokshopglobalselling.com","api_contract":{"method":"POST","endpoint_path":"/api/v1/sea_product/growth/product_list","page_size":10,"stage_id":0,"page_source":1,"request_fields":{"filter":"filter_criteria","stage":"stage_id","page_size":"page_size","page":"page_num","page_source":"page_source"},"pagination":"one_based_page_with_total","record_path":["data","products"],"record_key_path":["product_id"],"total_path":["data","total"],"request_timeout_ms":30000,"max_pages":100}},"local":{"runner":"scripts/routes/local/shop_product_growth_opportunity_snapshot.js","transport":"seller_page_post","response_origin":"https://seller-ph.tiktok.com","api_contract":{"method":"POST","endpoint_path":"/api/v1/sea_product/growth/product_list","page_size":10,"stage_id":0,"page_source":1,"request_fields":{"filter":"filter_criteria","stage":"stage_id","page_size":"page_size","page":"page_num","page_source":"page_source"},"pagination":"one_based_page_with_total","record_path":["data","products"],"record_key_path":["product_id"],"total_path":["data","total"],"request_timeout_ms":30000,"max_pages":100}}}
}
```
<!-- report-spec:end -->

本项只表示请求时快照，不接受历史范围解释。完整分页后的 `product_id` 必须为唯一数字 ID 且收齐 `data.total`；每个 product 对象作为同一记录的确定性 JSON 文本属性。`total=0,products=[]` 是可信空表。

## shop_product_commercial_status_snapshot

<!-- report-spec:start -->
```json
{
  "schema_version":"report_spec_v1","report_id":"shop_product_commercial_status_snapshot","enabled":true,"explicit_only":false,
  "owner_scope":"shop","required_variables":["shop"],"source_type":"official_api","success_output_type":"generated_xlsx","no_data_output_type":"generated_xlsx","time_semantics":"current_snapshot","output_granularity":"snapshot",
  "output_path_template":"店铺数据/商品与SKU商业状态快照/{{time_file}}",
  "logical_tables":[{"logical_table":"products","headers":["lifecycle_tab_id","lifecycle_status","product_id","product_record_json","currency"],"required_key_columns":["product_id"]},{"logical_table":"skus","headers":["lifecycle_tab_id","lifecycle_status","product_id","sku_id","sku_record_json","currency"],"required_key_columns":["sku_id"]}],
  "no_data_rule":"official_api_zero_total",
  "generated_currency":{"source_kind":"official_record_symbol","currency_symbol":"₱","currency_code":"PHP"},
  "providers":{"cross_border":{"runner":"scripts/routes/cross_border/shop_product_commercial_status_snapshot.js","transport":"seller_entry_capture_seed_renderer_get_lifecycle_tabs","response_origin":"https://api16-normal-sg.tiktokshopglobalselling.com","api_contract":{"entry_path":"/product/manage","endpoint_path":"/api/v1/product/local/products/list","page_size":50,"sku_number":100,"lifecycle_tabs":[{"tab_id":1,"status":"all"},{"tab_id":5,"status":"delisted"},{"tab_id":7,"status":"draft"},{"tab_id":10,"status":"deleted"}],"pagination":"one_based_page_per_tab_with_total_product_count","query_fields":{"tab":"tab_id","page":"page_number","page_size":"page_size","sku_number":"sku_number"},"record_path":["data","products"],"product_key_path":["product_id"],"sku_list_path":["skus"],"sku_key_path":["id"],"sku_total_field":"total_sku_count","total_path":["data","total_product_count"],"response_page_path":["data","page_number"],"response_page_size_path":["data","page_size"],"query_constants":{"product_sort_fields":3,"product_sort_types":0,"same_product_page_size":3,"is_need_target_stock":true,"is_need_clearance_tag":true},"seller_query_names":["seller_id","oec_seller_id"],"request_timeout_ms":30000,"max_pages":100}},"local":{"runner":"scripts/routes/local/shop_product_commercial_status_snapshot.js","transport":"seller_entry_capture_seed_renderer_get_lifecycle_tabs","response_origin":"https://seller-ph.tiktok.com","api_contract":{"entry_path":"/product/manage","endpoint_path":"/api/v1/product/local/products/list","method":"GET","page_size":50,"sku_number":100,"lifecycle_tabs":[{"tab_id":1,"status":"all"},{"tab_id":5,"status":"delisted"},{"tab_id":7,"status":"draft"},{"tab_id":10,"status":"deleted"}],"pagination":"one_based_page_per_tab_with_total_product_count","query_fields":{"tab":"tab_id","page":"page_number","page_size":"page_size","sku_number":"sku_number"},"record_path":["data","products"],"product_key_path":["product_id"],"sku_list_path":["skus"],"sku_key_path":["id"],"sku_total_field":"total_sku_count","total_path":["data","total_product_count"],"response_page_path":["data","page_number"],"response_page_size_path":["data","page_size"],"query_constants":{},"seller_query_names":["seller_id","oec_seller_id"],"request_timeout_ms":30000,"max_pages":100}}}
}
```
<!-- report-spec:end -->

四个 lifecycle tab 必须逐项完整分页，状态保留为来源属性，不做 tab union 推断。产品表和 SKU 表独立发布：`product_id`、`sku.id` 分别全局唯一，且每个产品的 `skus.length` 必须等于 `total_sku_count`。产品记录排除 SKU 数组后、SKU 记录本身均以确定性 JSON 固定列保存；其官方金额显示使用 `₱`，生成表据此增加 `currency=PHP`。四 tab 全零时两张表均为可信空表。跨境 transport 失败必须保留脱敏的 lifecycle tab、页码、origin/path、错误类别及错误名；如已获得 HTTP 响应，还要分别保留状态码和业务 code，不得记录 Cookie、令牌或完整 query 值。


## product_analytics_performance

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "product_analytics_performance",
  "enabled": true,
  "currency_contract": {
    "schema_version": "currency_contract_v1",
    "source_kind": "product_list_api_currency_code",
    "fallback_source_kind": "official_report_page_symbol",
    "output_kind": "embedded_table_metadata",
    "amount_scope": "all_monetary_fields",
    "currency_symbol": "₱",
    "currency_code": "PHP",
    "api_items_path": ["data", "items"],
    "api_metric_container_path": ["stats_v3", "total"],
    "api_currency_field": "currency_code",
    "api_amount_sibling_fields": ["amount", "amount_delimited", "amount_formatted"]
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
  "no_data_output_type": "generated_xlsx",
  "time_semantics": "requested_range",
  "output_granularity": "request_range",
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/product_analytics_performance.js",
      "transport": "official_ui_download",
      "response_origin": "https://api16-normal-sg.tiktokshopglobalselling.com",
      "official_validation": {
        "entry_path": "/compass/product-analysis",
        "list_endpoint": "/api/v3/insights/seller/ttp/product/list",
        "seller_query": "oec_seller_id",
        "request_end": "exclusive_next_day",
        "export_locator": "button[data-uid^=\"exportbutton:button_handleexport\"]",
        "data_start_row": 5,
        "entry_query": {
          "range": "timeRange",
          "shortcut": "shortcut",
          "shortcut_value": "custom"
        },
        "list_total_path": [
          "data",
          "list_control",
          "next_pagination",
          "total"
        ],
        "list_pagination_path": [
          "data",
          "list_control",
          "next_pagination"
        ],
        "request_timeout_ms": 90000,
        "download_timeout_ms": 90000
      },
      "retry_policy": {
        "operation_class": "official_export_action",
        "max_total_attempts": 1,
        "identity_and_contract_failures_retryable": false
      }
    },
    "local": {
      "runner": "scripts/routes/local/product_analytics_performance.js",
      "transport": "official_ui_download",
      "response_origin": "https://seller-ph.tiktok.com",
      "official_validation": {
        "entry_path": "/compass/product-analysis",
        "list_method": "POST",
        "list_endpoint": "/api/v3/insights/seller/ttp/product/list",
        "seller_queries": [
          "oec_seller_id",
          "seller_id"
        ],
        "request_end": "exclusive_next_day",
        "export_locator": "button[data-uid^=\"exportbutton:button_handleexport\"]",
        "data_start_row": 5,
        "entry_query": {
          "range": "timeRange",
          "shortcut": "shortcut",
          "shortcut_value": "custom"
        },
        "list_total_path": [
          "data",
          "list_control",
          "next_pagination",
          "total"
        ],
        "list_pagination_path": [
          "data",
          "list_control",
          "next_pagination"
        ],
        "request_timeout_ms": 90000,
        "download_timeout_ms": 90000
      },
      "retry_policy": {
        "operation_class": "official_export_action",
        "max_total_attempts": 1,
        "identity_and_contract_failures_retryable": false
      }
    }
  },
  "output_path_template": "店铺数据/商品分析表现/{{time_file}}",
  "headers": [
    "商品名",
    "商品 ID",
    "GMV 区间",
    "发品状态",
    "GMV",
    "商家直播归因 GMV",
    "商家直播 GMV",
    "商家直播间接 GMV",
    "商家视频归因 GMV",
    "商家视频 GMV",
    "商家视频间接 GMV",
    "达人归因 GMV",
    "达人直播归因 GMV",
    "联盟直播商品交易总额",
    "达人直播间接 GMV",
    "联盟视频归因 GMV",
    "联盟视频商品交易总额",
    "达人视频间接 GMV",
    "商家商品卡 GMV",
    "订单数",
    "SKU 订单数",
    "商品成交件数",
    "预计客户数",
    "平均订单金额（SKU 订单）",
    "商品曝光次数",
    "商品点击量",
    "商品点击率",
    "加购次数",
    "加购率",
    "CTOR（SKU 订单）",
    "去重商品曝光次数",
    "去重点击次数",
    "去重点击率",
    "已加购的用户数",
    "去重加购率",
    "去重点击成交转化率（SKU 订单）",
    "含税 GMV",
    "税费",
    "GMV（TikTok 合资）",
    "运费",
    "退款金额",
    "已退款的商品件数",
    "退款客户数",
    "商城页商品曝光次数",
    "商城页商品点击量",
    "商城页去重商品点击量",
    "预计商城页客户数",
    "商城页点击率",
    "商城页点击成交转化率（SKU 订单）",
    "商城页 GMV",
    "商城页商品成交件数",
    "归因 GMV",
    "GMV",
    "间接 GMV",
    "归因订单数",
    "归因 SKU 订单数",
    "SKU 订单数",
    "间接 SKU 订单数",
    "归因成交件数",
    "商品成交件数",
    "间接成交件数",
    "预计客户数",
    "AOV（归因 SKU 订单）",
    "新直播场次",
    "商品曝光次数",
    "商品点击量",
    "商品点击率",
    "加购次数",
    "加购率",
    "CTOR（SKU 订单）",
    "去重商品曝光次数",
    "去重点击次数",
    "去重点击率",
    "已加购的用户数",
    "去重加购率",
    "去重点击成交转化率（SKU 订单）",
    "归因 GMV",
    "GMV",
    "间接 GMV",
    "归因订单数",
    "归因 SKU 订单数",
    "SKU 订单数",
    "间接 SKU 订单数",
    "归因成交件数",
    "商品成交件数",
    "间接成交件数",
    "预计客户数",
    "AOV（归因 SKU 订单）",
    "新视频数",
    "商品曝光次数",
    "商品点击量",
    "商品点击率",
    "加购次数",
    "加购率",
    "CTOR（SKU 订单）",
    "去重商品曝光次数",
    "去重点击次数",
    "去重点击率",
    "已加购的用户数",
    "去重加购率",
    "去重点击成交转化率（SKU 订单）",
    "归因 GMV",
    "直播归因 GMV",
    "联盟直播商品交易总额",
    "达人直播间接 GMV",
    "视频归因 GMV",
    "联盟视频商品交易总额",
    "达人视频间接 GMV",
    "归因订单数",
    "归因 SKU 订单数",
    "归因成交件数",
    "预计客户数",
    "AOV（归因 SKU 订单）",
    "已发布内容的日均达人数",
    "新直播场次",
    "新视频数",
    "商品曝光次数",
    "商品点击量",
    "商品点击率",
    "加购次数",
    "加购率",
    "CTOR（SKU 订单）",
    "去重商品曝光次数",
    "去重点击次数",
    "去重点击率",
    "已加购的用户数",
    "去重加购率",
    "去重点击成交转化率（SKU 订单）",
    "商品曝光次数（直播）",
    "商品点击量（直播）",
    "CTR（直播）",
    "加购次数（直播）",
    "加购率（直播）",
    "CTOR（SKU 订单）（直播）",
    "去重商品曝光次数（直播）",
    "去重点击次数（直播）",
    "去重点击率（直播）",
    "ATC 用户数（直播）",
    "去重加购率（直播）",
    "去重点击成交转化率（SKU 订单）（直播）",
    "商品曝光次数（视频）",
    "商品点击量（视频）",
    "CTR（视频）",
    "加购次数（视频）",
    "加购率（视频）",
    "CTOR（SKU 订单）（视频）",
    "去重商品曝光次数（视频）",
    "去重点击次数（视频）",
    "去重点击率（视频）",
    "ATC 用户数（视频）",
    "去重加购率（视频）",
    "去重点击成交转化率（SKU 订单）（视频）",
    "归因 GMV",
    "GMV",
    "间接 GMV",
    "归因订单数",
    "归因 SKU 订单数",
    "SKU 订单数",
    "间接 SKU 订单数",
    "归因成交件数",
    "商品成交件数",
    "间接成交件数",
    "预计客户数",
    "AOV（归因 SKU 订单）",
    "商品曝光次数",
    "商品点击量",
    "商品点击率",
    "加购次数",
    "加购率",
    "CTOR（SKU 订单）",
    "去重商品曝光次数",
    "去重点击次数",
    "去重点击率",
    "已加购的用户数",
    "去重加购率",
    "去重点击成交转化率（SKU 订单）"
  ],
  "required_key_columns": [
    "商品 ID"
  ],
  "no_data_rule": "official_product_list_total_zero"
}
```
<!-- report-spec:end -->

官方文件在币种元数据嵌入前保持原始字节；下载前先以官方 product-list total 判定零数据。非零文件不校验原文件名、Sheet、表头、日期 banner、业务键或与 API total 的行数相等性；工作簿必须可读，数据自第 5 行开始，至少一条非空数据行才成功。零 total 继续生成同 176 列的 header-only XLSX。币种优先取 product-list API 同金额对象中一致的 `currency_code`；API 未提供币种时，才以当前已绑定店铺和日期的商品分析报告页 `₱` 作为 `PHP` 后备证据。导出器把币种写入正式工作簿自定义元数据，不生成旁路 JSON。

## manage_orders_csv

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "manage_orders_csv",
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
  "success_output_type": "official_csv",
  "no_data_output_type": "generated_csv",
  "time_semantics": "requested_range",
  "output_granularity": "request_range",
  "output_path_template": "店铺数据/订单明细/{{time_file}}",
  "headers": [
    "Order ID",
    "Order Status",
    "Order Substatus",
    "Cancelation/Return Type",
    "Normal or Pre-order",
    "SKU ID",
    "Seller SKU",
    "Product Name",
    "Variation",
    "Quantity",
    "Sku Quantity of return",
    "SKU Unit Original Price",
    "SKU Subtotal Before Discount",
    "SKU Platform Discount",
    "SKU Seller Discount",
    "SKU Subtotal After Discount",
    "Shipping Fee After Discount",
    "Original Shipping Fee",
    "Shipping Fee Seller Discount",
    "Shipping Fee Platform Discount",
    "Payment platform discount",
    "Taxes",
    "Order Amount",
    "Order Refund Amount",
    "Created Time",
    "Paid Time",
    "RTS Time",
    "Shipped Time",
    "Delivered Time",
    "Cancelled Time",
    "Cancel By",
    "Cancel Reason",
    "Fulfillment Type",
    "Warehouse Name",
    "Tracking ID",
    "Delivery Option",
    "Shipping Provider Name",
    "Buyer Message",
    "Buyer Username",
    "Recipient",
    "Phone #",
    "Country",
    "Region",
    "Province",
    "Municipality",
    "Barangay",
    "Detail Address",
    "Additional address information",
    "Payment Method",
    "Weight(kg)",
    "Product Category",
    "Package ID",
    "Seller Note",
    "Checked Status",
    "Checked Marked by",
    "Order Channel",
    "Creator Handle"
  ],
  "required_key_columns": [
    "Order ID"
  ],
  "no_data_rule": "official_order_list_total_zero",
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/manage_orders_csv.js",
      "transport": "official_ui_download",
      "list_response_origin": "https://seller.tiktokshopglobalselling.com",
      "task_response_origin": "https://api16-normal-sg.tiktokshopglobalselling.com",
      "official_validation": {
    "entry_path": "/order",
    "business_timezone": "Asia/Manila",
    "list_endpoint": "/api/fulfillment/order/list",
    "create_endpoint": "/api/fulfillment/order/export",
    "record_endpoint": "/api/fulfillment/order/export_record/get",
    "data_start_row": 2,
    "ui_contract": {
      "dialog_selector": "[role=dialog]:visible",
      "radio_selector": "input[type=radio]",
      "radio_count": 5,
      "required_checked_indices": [0, 3],
      "export_button_name": "导出",
      "download_button_name": "下载",
      "blocking_modal_pattern": "^(?:Got it|知道了|好的)$",
      "download_record_ancestor": "xpath=ancestor::*[.//button[normalize-space()=\"下载\"]][1]",
      "dialog_attempts": 3,
      "modal_timeout_ms": 10000,
      "record_poll_slice_ms": 15000,
      "record_poll_min_ms": 1000,
      "list_method": "POST",
      "create_method": "POST",
      "task_id_pattern": "^[A-Za-z0-9_-]+$",
      "task_id_candidate_keys": ["task_id", "export_task_id"],
      "create_fallback_grace_ms": 500,
      "seller_query": "oec_seller_id",
      "response_paths": {
        "list_total": ["data", "total_count"],
        "create_task_id": ["data", "export_task_id"],
        "record_items": ["data", "export_records"],
        "record_task_id": ["export_task_id"],
        "record_file_key": ["file_key"],
        "record_file_name": ["file_name"]
      },
      "entry_query": {
        "selected_sort": {"name": "selected_sort", "value": "6"},
        "tab": {"name": "tab", "value": "all"},
        "created_time": "time_order_created[]"
      }
    },
    "request_timeout_ms": 90000,
    "task_timeout_ms": 120000,
    "download_timeout_ms": 90000
      },
      "retry_policy": {
        "operation_class": "official_export_action",
        "max_total_attempts": 1,
        "identity_and_contract_failures_retryable": false
      }
    },
    "local": {
    "runner": "scripts/routes/local/manage_orders_csv.js",
      "transport": "official_ui_download",
      "list_response_origin": "https://seller-ph.tiktok.com",
      "task_response_origin": "https://seller-ph.tiktok.com",
      "official_validation": {
        "entry_path": "/order",
        "business_timezone": "Asia/Manila",
        "list_endpoint": "/api/fulfillment/order/list",
        "create_endpoint": "/api/fulfillment/order/export",
        "record_endpoint": "/api/fulfillment/order/export_record/get",
        "data_start_row": 2,
        "ui_contract": {
          "dialog_selector": "[role=dialog]:visible",
          "radio_selector": "input[type=radio]",
          "radio_count": 5,
          "required_checked_indices": [0, 3],
          "export_button_name": "导出",
          "download_button_name": "下载",
          "blocking_modal_pattern": "^(?:Got it|知道了|好的)$",
          "download_record_ancestor": "xpath=ancestor::*[.//button[normalize-space()=\"下载\"]][1]",
          "dialog_attempts": 3,
          "modal_timeout_ms": 10000,
          "record_poll_slice_ms": 15000,
          "record_poll_min_ms": 1000,
          "list_method": "POST",
          "create_method": "POST",
          "record_method": "POST",
          "task_id_pattern": "^[A-Za-z0-9_-]+$",
          "task_id_candidate_keys": ["task_id", "export_task_id"],
          "create_fallback_grace_ms": 500,
          "seller_query": "oec_seller_id",
          "response_paths": {
            "list_total": ["data", "total_count"],
            "create_task_id": ["data", "export_task_id"],
            "record_items": ["data", "export_records"],
            "record_task_id": ["export_task_id"],
            "record_file_key": ["file_key"],
            "record_file_name": ["file_name"]
          },
          "entry_query": {
            "selected_sort": {"name": "selected_sort", "value": "6"},
            "tab": {"name": "tab", "value": "all"},
            "created_time": "time_order_created[]"
          }
        },
        "request_timeout_ms": 90000,
        "task_timeout_ms": 240000,
        "download_timeout_ms": 90000
      },
      "retry_policy": {
        "operation_class": "official_export_action",
        "max_total_attempts": 1,
        "identity_and_contract_failures_retryable": false
      }
    }
  },
  "generated_csv_validation": {
    "bom": "required",
    "delimiter": ","
  }
}
```
<!-- report-spec:end -->

cross-border 与 local 各自使用独立 provider runner。非零 CSV 在币种列嵌入前保持官方原字节，不校验原文件名、表头、BOM、编码、固定分隔符、业务键、日期或与 API total 的行数相等性；从第 2 行起至少一条非空记录才成功。下载前官方 order-list total 为零时继续生成既有空 CSV。币种必须在已绑定的 order-list 响应完成后、打开导出任务窗口之前，从同一订单报告页观察 `₱`；导出器在正式 CSV 增加 `currency=PHP` 列，不生成旁路 JSON。清洗不得把广告户币种复制给订单。

## product_ratings_review_list

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "product_ratings_review_list",
  "enabled": true,
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/product_ratings_review_list.js",
      "transport": "official_ui_job_download",
      "retry_policy": {
        "max_total_attempts": 1,
        "identity_and_contract_failures_retryable": false
      },
      "official_validation": {
        "seller_origin": "https://seller.tiktokshopglobalselling.com",
        "response_origin": "https://api16-normal-sg.tiktokshopglobalselling.com",
        "entry_path": "/product/rating",
        "shop_region_query": "shop_region",
        "list_endpoint": "/api/v1/review/biz_backend/list",
        "start_endpoint": "/api/v1/review/biz_backend/export/start",
        "job_endpoint": "/api/v1/review/biz_backend/export/job",
        "list_method": "POST",
        "start_method": "POST",
        "job_method": "GET",
        "date_trigger_placeholder": "自",
        "date_panel_selector": ".core-picker-range-container .core-panel-date",
        "date_header_selector": ".core-picker-header-value",
        "date_control_selector": ".core-picker-header-icon",
        "date_cell_selector": ".core-picker-cell-in-view:not(.core-picker-cell-disabled) .core-picker-date-value",
        "date_panel_count": 2,
        "previous_control_index": 1,
        "next_control_index": 2,
        "max_month_moves": 240,
        "response_paths": {
          "list_total": ["data", "total"],
          "job_id": ["job_id"],
          "job_authorized": ["is_authorized"],
          "job_file_url": ["file_url"]
        },
        "export_button_name": "导出",
        "navigation_timeout_ms": 90000,
        "baseline_timeout_ms": 90000,
        "job_timeout_ms": 120000,
        "download_timeout_ms": 90000,
        "data_start_row": 2
      }
    },
    "local": {
      "runner": "scripts/routes/local/product_ratings_review_list.js",
      "transport": "official_ui_job_download",
      "retry_policy": {
        "max_total_attempts": 1,
        "identity_and_contract_failures_retryable": false
      },
      "official_validation": {
        "seller_origin": "https://seller-ph.tiktok.com",
        "response_origin": "https://seller-ph.tiktok.com",
        "entry_path": "/product/rating",
        "shop_region_query": "shop_region",
        "list_endpoint": "/api/v1/review/biz_backend/list",
        "start_endpoint": "/api/v1/review/biz_backend/export/start",
        "job_endpoint": "/api/v1/review/biz_backend/export/job",
        "list_method": "POST",
        "start_method": "POST",
        "job_method": "GET",
        "date_trigger_placeholder": "自",
        "date_panel_selector": ".core-picker-range-container .core-panel-date",
        "date_header_selector": ".core-picker-header-value",
        "date_control_selector": ".core-picker-header-icon",
        "date_cell_selector": ".core-picker-cell-in-view:not(.core-picker-cell-disabled) .core-picker-date-value",
        "date_panel_count": 2,
        "previous_control_index": 1,
        "next_control_index": 2,
        "max_month_moves": 240,
        "response_paths": {
          "list_total": ["data", "total"],
          "job_id": ["job_id"],
          "job_authorized": ["is_authorized"],
          "job_file_url": ["file_url"]
        },
        "export_button_name": "导出",
        "navigation_timeout_ms": 90000,
        "baseline_timeout_ms": 90000,
        "job_timeout_ms": 120000,
        "download_timeout_ms": 90000,
        "data_start_row": 2
      }
    }
  },
  "explicit_only": false,
  "owner_scope": "shop",
  "required_variables": [
    "shop",
    "start_date",
    "end_date"
  ],
  "source_type": "official_download",
  "success_output_type": "official_csv",
  "no_data_output_type": "generated_csv",
  "time_semantics": "requested_range",
  "output_granularity": "request_range",
  "output_path_template": "店铺数据/商品评价/{{time_file}}",
  "headers": [
    "rating",
    "review_text",
    "review_date",
    "order_id",
    "product_id",
    "sku_id"
  ],
  "required_key_columns": [
    "order_id",
    "product_id",
    "sku_id"
  ],
  "no_data_rule": "official_review_filtered_total_zero",
  "generated_csv_validation": {
    "bom": "required",
    "delimiter": ","
  }
}
```
<!-- report-spec:end -->

两侧均使用一次冻结 Seller 身份、一次日期应用和一次 Export。先记录导航触发的 baseline job；日期列表 `total=0` 才生成可信空 CSV。正值只接受随后唯一且更大的新 job ID，且该 job 必须 authorized 并绑定 HTTPS `file_url`。2026-08-17 现场证据分别闭合 local total 39、job 33→34，以及 cross-border total 7、job 0→1。

官方 CSV 保持原字节，不校验原文件名、表头、列数、业务键、BOM、固定分隔符、日期内容或与列表 total 的行数相等性。文件必须通过严格 CSV 逻辑记录解析；从第 2 条逻辑记录起至少一条非空数据记录才成功。请求范围固定发布为一个 `{{start_date}}_至_{{end_date}}.csv`，不递归拆分。
