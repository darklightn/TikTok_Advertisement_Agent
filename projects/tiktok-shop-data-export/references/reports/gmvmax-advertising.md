# GMV Max 广告报表

## gmvmax_campaign_product_performance

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "gmvmax_campaign_product_performance",
  "enabled": true,
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/gmvmax_campaign_product_performance.js",
      "transport": "seller_page_request_bound_official_task_download",
      "response_origin": "https://seller.tiktokshopglobalselling.com",
      "official_validation": {
        "campaign_endpoint": "/oec_ads/shopping/v1/oec/stat/post_campaign_list",
        "product_endpoint": "/oec_ads/shopping/v1/oec/stat/post_product_list",
        "task_query_endpoint": "/oec_ads/shopping/v1/oec/stat/download_task/query",
        "query_parameters": {
          "seller_id": "oec_seller_id",
          "advertiser_id": "aadvid",
          "locale": "locale",
          "language": "language"
        },
        "identity_response_fields": {
          "seller": [
            "seller_id",
            "oec_seller_id"
          ],
          "advertiser": [
            "advertiser_id",
            "aadvid"
          ]
        },
        "request_fields": {
          "start_date": "start_time",
          "end_date": "end_time",
          "page": "page",
          "page_size": "page_size",
          "campaign_id": "campaign_id",
          "query_list": "query_list",
          "order_field": "order_field",
          "order_type": "order_type",
          "automation_type": "campaign_shop_automation_type",
          "external_type_list": "external_type_list",
          "filters": "filters",
          "action": "action",
          "task_id": "download_id"
        },
        "query_constants": {
          "locale": "zh",
          "language": "zh"
        },
        "campaign_request": {
          "query_list": [
            "campaign_id",
            "campaign_name",
            "campaign_primary_status",
            "campaign_status",
            "cost",
            "onsite_roi2_shopping_sku",
            "onsite_roi2_shopping_value",
            "onsite_roi2_shopping",
            "template_ad_start_time",
            "template_ad_end_time"
          ],
          "order_field": "cost",
          "order_type": 1,
          "page_size": 100,
          "campaign_shop_automation_type": 2,
          "external_type_list": [
            "304",
            "307"
          ],
          "filters": []
        },
        "product_request": {
          "query_list": [
            "campaign_id",
            "product_id",
            "product_name",
            "onsite_roi2_shopping_sku",
            "onsite_roi2_shopping_value",
            "mixed_real_cost",
            "mixed_real_cost_per_onsite_roi2_shopping_sku",
            "onsite_mixed_real_roi2_shopping"
          ],
          "order_field": "onsite_roi2_shopping_value",
          "order_type": 1,
          "page_size": 100
        },
        "create_request": {
          "query_list": [
            "product_name",
            "product_id",
            "active_creative_boost_count",
            "mixed_real_cost",
            "onsite_roi2_shopping_sku",
            "mixed_real_cost_per_onsite_roi2_shopping_sku",
            "onsite_roi2_shopping_value",
            "onsite_mixed_real_roi2_shopping",
            "extra_currency"
          ],
          "order_field": "onsite_roi2_shopping_value",
          "order_type": 1,
          "page_size": -1,
          "action": "download"
        },
        "response_paths": {
          "table": [
            "data",
            "table"
          ],
          "pagination": [
            "data",
            "pagination"
          ],
          "total": "total_count",
          "page_count": "page_count",
          "page": "page",
          "campaign_id": [
            "campaign_id"
          ],
          "campaign_name": [
            "campaign_name"
          ],
          "product_id": [
            "product_id"
          ],
          "create_task_id": [
            "extra",
            "task_id"
          ],
          "task_id": [
            "download_id"
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
        "max_polls": 600,
        "request_timeout_ms": 30000,
        "download_timeout_ms": 120000,
        "data_start_row": 2
      }
    },
    "local": {
      "runner": "scripts/routes/local/gmvmax_campaign_product_performance.js",
      "transport": "seller_page_request_bound_official_task_download",
      "response_origin": "https://seller-ph.tiktok.com",
      "official_validation": {
        "campaign_endpoint": "/oec_ads/shopping/v1/oec/stat/post_campaign_list",
        "product_endpoint": "/oec_ads/shopping/v1/oec/stat/post_product_list",
        "task_query_endpoint": "/oec_ads/shopping/v1/oec/stat/download_task/query",
        "query_parameters": {
          "seller_id": "oec_seller_id",
          "advertiser_id": "aadvid",
          "locale": "locale",
          "language": "language"
        },
        "identity_response_fields": {
          "seller": [
            "seller_id",
            "oec_seller_id"
          ],
          "advertiser": [
            "advertiser_id",
            "aadvid"
          ]
        },
        "request_fields": {
          "start_date": "start_time",
          "end_date": "end_time",
          "page": "page",
          "page_size": "page_size",
          "campaign_id": "campaign_id",
          "query_list": "query_list",
          "order_field": "order_field",
          "order_type": "order_type",
          "automation_type": "campaign_shop_automation_type",
          "external_type_list": "external_type_list",
          "filters": "filters",
          "action": "action",
          "task_id": "download_id"
        },
        "query_constants": {
          "locale": "zh",
          "language": "zh"
        },
        "campaign_request": {
          "query_list": [
            "campaign_id",
            "campaign_name",
            "campaign_primary_status",
            "campaign_status",
            "cost",
            "onsite_roi2_shopping_sku",
            "onsite_roi2_shopping_value",
            "onsite_roi2_shopping",
            "template_ad_start_time",
            "template_ad_end_time"
          ],
          "order_field": "cost",
          "order_type": 1,
          "page_size": 100,
          "campaign_shop_automation_type": 2,
          "external_type_list": [
            "304",
            "307"
          ],
          "filters": []
        },
        "product_request": {
          "query_list": [
            "campaign_id",
            "product_id",
            "product_name",
            "onsite_roi2_shopping_sku",
            "onsite_roi2_shopping_value",
            "mixed_real_cost",
            "mixed_real_cost_per_onsite_roi2_shopping_sku",
            "onsite_mixed_real_roi2_shopping"
          ],
          "order_field": "onsite_roi2_shopping_value",
          "order_type": 1,
          "page_size": 100
        },
        "create_request": {
          "query_list": [
            "product_name",
            "product_id",
            "active_creative_boost_count",
            "mixed_real_cost",
            "onsite_roi2_shopping_sku",
            "mixed_real_cost_per_onsite_roi2_shopping_sku",
            "onsite_roi2_shopping_value",
            "onsite_mixed_real_roi2_shopping",
            "extra_currency"
          ],
          "order_field": "onsite_roi2_shopping_value",
          "order_type": 1,
          "page_size": -1,
          "action": "download"
        },
        "response_paths": {
          "table": [
            "data",
            "table"
          ],
          "pagination": [
            "data",
            "pagination"
          ],
          "total": "total_count",
          "page_count": "page_count",
          "page": "page",
          "campaign_id": [
            "campaign_id"
          ],
          "campaign_name": [
            "campaign_name"
          ],
          "product_id": [
            "product_id"
          ],
          "create_task_id": [
            "extra",
            "task_id"
          ],
          "task_id": [
            "download_id"
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
        "max_polls": 600,
        "request_timeout_ms": 30000,
        "download_timeout_ms": 120000,
        "data_start_row": 2
      }
    }
  },
  "explicit_only": false,
  "owner_scope": "campaign",
  "required_variables": [
    "shop",
    "advertiser",
    "campaign",
    "start_date",
    "end_date"
  ],
  "campaign_selection": "all_or_explicit",
  "source_type": "official_download",
  "success_output_type": "official_xlsx",
  "no_data_output_type": "generated_xlsx",
  "time_semantics": "requested_range",
  "output_granularity": "request_range",
  "single_day_time_file": true,
  "output_path_template": "计划数据/GMV Max 计划商品表现/{{time_file}}",
  "headers": [
    "Product ID",
    "Product name",
    "SKU orders",
    "Gross revenue",
    "Cost",
    "Cost per order",
    "ROI",
    "Currency"
  ],
  "required_key_columns": [
    "Product ID"
  ],
  "no_data_rule": "official_product_total_zero"
}
```
<!-- report-spec:end -->

同一报告同时处理单日和区间请求；单日文件名为 `YYYY-MM-DD.xlsx`，多日文件名为 `YYYY-MM-DD_至_YYYY-MM-DD.xlsx`。成功时保留官方 XLSX 原始字节，不再另建“计划商品每日表现”报告。

## advertiser_account_status_snapshot

<!-- report-spec:start -->
```json
{
  "schema_version":"report_spec_v1","report_id":"advertiser_account_status_snapshot","enabled":true,"explicit_only":false,
  "owner_scope":"advertiser","required_variables":["shop","advertiser"],"source_type":"official_api","success_output_type":"generated_xlsx","no_data_output_type":null,
  "time_semantics":"current_snapshot","output_granularity":"snapshot",
  "output_path_template":"广告户数据/广告账户状态/{{time_file}}",
  "headers":["captured_date","advertiser_id","advertiser_name","account_snapshot_json","currency"],"required_key_columns":["advertiser_id"],"no_data_rule":"not_applicable",
  "providers":{"cross_border":{"runner":"scripts/routes/cross_border/advertiser_account_status_snapshot.js","transport":"seller_page_mixed_account_status_requests","response_origin":"https://seller.tiktokshopglobalselling.com","api_contract":{"sources":{"payment":{"endpoint":"/oec_ads/pa/api/spider/query_payment_account/","method":"POST"},"ownership":{"endpoint":"/oec_ads/bm/account/adv/ownership/","method":"GET"},"billing":{"endpoint":"/oec_ads/bm/account/query/billing_and_own/info/","method":"GET"},"billing_options":{"endpoint":"/oec_ads/pa/api/common/query/payment/query_available_billing_options/","method":"POST"},"authorization":{"endpoint":"/oec_ads/shopping/v1/roi2/exclusive_authorization/query","method":"POST"}},"request_constants":{"platform":5,"payment_modules":[0,3],"shop_asset_type":100},"request_fields":{"context":"Context","platform":"platform","advertiser":"adv_id","business_center":"bc_id","modules":"module_list","risk":"risk_info","query_list":"query_info_list","mutex_asset_id":"mutex_asset_id","mutex_asset_type":"mutex_asset_id_type","shop_id":"shop_id"},"payment_advertiser_path":["data","adv_info_vo","id"],"authorization_list_path":["data","autho_info_list"],"authorization_advertiser_field":"adv_id","request_timeout_ms":30000}},
    "local": {
      "runner": "scripts/routes/local/advertiser_account_status_snapshot.js",
      "transport": "seller_page_mixed_account_status_requests",
      "response_origin": "https://seller-ph.tiktok.com",
      "api_contract": {
        "sources": {
          "payment": {
            "endpoint": "/oec_ads/pa/api/spider/query_payment_account/",
            "method": "POST"
          },
          "ownership": {
            "endpoint": "/oec_ads/bm/account/adv/ownership/",
            "method": "GET"
          },
          "billing": {
            "endpoint": "/oec_ads/bm/account/query/billing_and_own/info/",
            "method": "GET"
          },
          "billing_options": {
            "endpoint": "/oec_ads/pa/api/common/query/payment/query_available_billing_options/",
            "method": "POST"
          },
          "authorization": {
            "endpoint": "/oec_ads/shopping/v1/roi2/exclusive_authorization/query",
            "method": "POST"
          }
        },
        "request_constants": {
          "platform": 5,
          "payment_modules": [
            0,
            3
          ],
          "shop_asset_type": 100
        },
        "request_fields": {
          "context": "Context",
          "platform": "platform",
          "advertiser": "adv_id",
          "business_center": "bc_id",
          "modules": "module_list",
          "risk": "risk_info",
          "query_list": "query_info_list",
          "mutex_asset_id": "mutex_asset_id",
          "mutex_asset_type": "mutex_asset_id_type",
          "shop_id": "shop_id"
        },
        "payment_advertiser_path": [
          "data",
          "adv_info_vo",
          "id"
        ],
        "authorization_list_path": [
          "data",
          "autho_info_list"
        ],
        "authorization_advertiser_field": "adv_id",
        "request_timeout_ms": 30000
      }
    }}
}
```
<!-- report-spec:end -->

只使用 RunContext 已冻结的 seller、eligible linked advertiser 与 business center；不重读 onboard、不切换账户。五个只读来源与冻结身份组成一个 advertiser snapshot，完整对象使用确定性 JSON 文本保存。任何来源失败或回显其他 advertiser 均失败；成功必有一行业务记录，因此没有 no-data。`currency` 使用同一 RunContext 冻结的广告户 ISO 币种；缺失时失败，不借用店铺或订单币种。

## gmvmax_campaign_hourly_performance

<!-- report-spec:start -->
```json
{
  "schema_version":"report_spec_v1","report_id":"gmvmax_campaign_hourly_performance","enabled":true,"explicit_only":false,"owner_scope":"campaign",
  "required_variables":["shop","advertiser","campaign","start_date","end_date"],"campaign_selection":"all_or_explicit","source_type":"official_api","success_output_type":"generated_xlsx","no_data_output_type":"generated_xlsx",
  "time_semantics":"metric_date","output_granularity":"metric_date",
  "output_path_template":"计划数据/GMV Max 计划小时表现/{{time_file}}",
  "headers":["campaign_id","campaign_name","metric_date","metric_hour","cost","impressions","clicks","sku_orders","gross_revenue","cost_per_order_official","roi_official","currency"],"required_key_columns":["campaign_id","metric_date","metric_hour"],"no_data_rule":"official_api_zero_total",
  "providers":{"cross_border":{"runner":"scripts/routes/cross_border/gmvmax_campaign_hourly_performance.js","transport":"seller_page_post","response_origin":"https://seller.tiktokshopglobalselling.com","campaign_request_fields":{"start":"start_time","end":"end_time","page":"page"},"api_contract":{"campaign_endpoint":"/oec_ads/shopping/v1/oec/stat/post_campaign_list","campaign_request":{"query_list":["campaign_id","campaign_name","cost"],"order_field":"cost","order_type":1,"page_size":100,"campaign_shop_automation_type":2,"external_type_list":["307","304","305"]},"hourly_endpoint":"/oec_ads/shopping/v1/oec/stat/post_overview_stat","hourly_request":{"query_list":["cost","onsite_roi2_shopping_sku","cost_per_onsite_roi2_shopping_sku","onsite_roi2_shopping_value","onsite_roi2_shopping","show_cnt","click_cnt"],"campaign_shop_automation_type":2,"external_type_list":["307","304","305"]},"hourly_metric_fields":{"cost":"cost","impressions":"show_cnt","clicks":"click_cnt","orders":"onsite_roi2_shopping_sku","revenue":"onsite_roi2_shopping_value","cost_per_order":"cost_per_onsite_roi2_shopping_sku","roi":"onsite_roi2_shopping"},"hourly_request_fields":{"start":"start_time","end":"end_time","campaign_ids":"campaign_ids"},"hourly_response":{"data":["data"],"categories":["data","chart","categories"],"series":["data","chart","series"],"series_name":"name","series_values":"data","bucket_count":24,"hour_template":"{{HH}}:00"},"request_query":{"locale":"zh","language":"zh","seller":"oec_seller_id","advertiser":"aadvid","timeout_ms":30000},"campaign_response":{"records":["data","table"],"pagination":["data","pagination"],"total":"total_count","page_count":"page_count","page":"page","id":"campaign_id","name":"campaign_name"}}},
    "local": {
      "runner": "scripts/routes/local/gmvmax_campaign_hourly_performance.js",
      "transport": "seller_page_post",
      "response_origin": "https://seller-ph.tiktok.com",
      "campaign_request_fields": {
        "start": "start_time",
        "end": "end_time",
        "page": "page"
      },
      "api_contract": {
        "campaign_endpoint": "/oec_ads/shopping/v1/oec/stat/post_campaign_list",
        "campaign_request": {
          "query_list": [
            "campaign_id",
            "campaign_name",
            "cost"
          ],
          "order_field": "cost",
          "order_type": 1,
          "page_size": 100,
          "campaign_shop_automation_type": 2,
          "external_type_list": [
            "307",
            "304",
            "305"
          ]
        },
        "hourly_endpoint": "/oec_ads/shopping/v1/oec/stat/post_overview_stat",
        "hourly_request": {
          "query_list": [
            "cost",
            "onsite_roi2_shopping_sku",
            "cost_per_onsite_roi2_shopping_sku",
            "onsite_roi2_shopping_value",
            "onsite_roi2_shopping",
            "show_cnt",
            "click_cnt"
          ],
          "campaign_shop_automation_type": 2,
          "external_type_list": [
            "307",
            "304",
            "305"
          ]
        },
        "hourly_metric_fields": {
          "cost": "cost",
          "impressions": "show_cnt",
          "clicks": "click_cnt",
          "orders": "onsite_roi2_shopping_sku",
          "revenue": "onsite_roi2_shopping_value",
          "cost_per_order": "cost_per_onsite_roi2_shopping_sku",
          "roi": "onsite_roi2_shopping"
        },
        "hourly_request_fields": {
          "start": "start_time",
          "end": "end_time",
          "campaign_ids": "campaign_ids"
        },
        "hourly_response": {
          "data": [
            "data"
          ],
          "categories": [
            "data",
            "chart",
            "categories"
          ],
          "series": [
            "data",
            "chart",
            "series"
          ],
          "series_name": "name",
          "series_values": "data",
          "bucket_count": 24,
          "hour_template": "{{HH}}:00"
        },
        "request_query": {
          "locale": "zh",
          "language": "zh",
          "seller": "oec_seller_id",
          "advertiser": "aadvid",
          "timeout_ms": 30000
        },
        "campaign_response": {
          "records": [
            "data",
            "table"
          ],
          "pagination": [
            "data",
            "pagination"
          ],
          "total": "total_count",
          "page_count": "page_count",
          "page": "page",
          "id": "campaign_id",
          "name": "campaign_name"
        }
      }
    }}
}
```
<!-- report-spec:end -->

每个 campaign×自然日只读一次固定小时来源。categories 必须精确为 00:00 至 23:00；七个固定指标 series 名称唯一、全部存在且各有 24 个 string 或 finite-number 值。输出固定 24 行及 12 列，不保留 `series_values_json`；currency 只使用 RunContext 冻结的广告户币种。来源 `data:null` 是可信 no-data，不补造缺失小时。

## gmvmax_campaign_performance

<!-- report-spec:start -->
```json
{
  "schema_version":"report_spec_v1","report_id":"gmvmax_campaign_performance","enabled":true,"explicit_only":false,"owner_scope":"campaign",
  "required_variables":["shop","advertiser","campaign","start_date","end_date"],"campaign_selection":"all_or_explicit","source_type":"official_api","success_output_type":"generated_xlsx","no_data_output_type":"generated_xlsx",
  "time_semantics":"requested_range","output_granularity":"request_range","single_day_time_file":true,
  "output_path_template":"计划数据/GMV Max 计划表现/{{time_file}}",
  "headers":["campaign_id","campaign_name","currency"],"dynamic_headers":"top_level_field_union","required_key_columns":["campaign_id"],"no_data_rule":"official_api_zero_total",
  "providers":{"cross_border":{"runner":"scripts/routes/cross_border/gmvmax_campaign_performance_interval.js","transport":"seller_page_post","response_origin":"https://seller.tiktokshopglobalselling.com","campaign_request_fields":{"start":"start_time","end":"end_time","page":"page"},"api_contract":{"campaign_endpoint":"/oec_ads/shopping/v1/oec/stat/post_campaign_list","campaign_request":{"query_list":["campaign_id","campaign_name","campaign_primary_status","campaign_status","cost","campaign_eligible_roi","campaign_target_roi_budget","campaign_target_roi_budget_mode","campaign_budget_mode","template_ad_start_time","template_ad_end_time","template_ad_roas_bid","onsite_roi2_shopping_sku","cost_per_onsite_roi2_shopping_sku","onsite_roi2_shopping_value","onsite_roi2_shopping","show_cnt","click_cnt","ctr","billed_cost","campaign_opt_status","session_info","extra_currency"],"order_field":"cost","order_type":1,"page_size":100,"campaign_shop_automation_type":2,"external_type_list":["304","307","305"]},"request_query":{"locale":"zh","language":"zh","seller":"oec_seller_id","advertiser":"aadvid","timeout_ms":30000},"campaign_response":{"records":["data","table"],"pagination":["data","pagination"],"total":"total_count","page_count":"page_count","page":"page","id":"campaign_id","name":"campaign_name"}}},
    "local": {
      "runner": "scripts/routes/local/gmvmax_campaign_performance_interval.js",
      "transport": "seller_page_post",
      "response_origin": "https://seller-ph.tiktok.com",
      "campaign_request_fields": {
        "start": "start_time",
        "end": "end_time",
        "page": "page"
      },
      "api_contract": {
        "campaign_endpoint": "/oec_ads/shopping/v1/oec/stat/post_campaign_list",
        "campaign_request": {
          "query_list": [
            "campaign_id",
            "campaign_name",
            "campaign_primary_status",
            "campaign_status",
            "cost",
            "campaign_eligible_roi",
            "campaign_target_roi_budget",
            "campaign_target_roi_budget_mode",
            "campaign_budget_mode",
            "template_ad_start_time",
            "template_ad_end_time",
            "template_ad_roas_bid",
            "onsite_roi2_shopping_sku",
            "cost_per_onsite_roi2_shopping_sku",
            "onsite_roi2_shopping_value",
            "onsite_roi2_shopping",
            "show_cnt",
            "click_cnt",
            "ctr",
            "billed_cost",
            "campaign_opt_status",
            "session_info",
            "extra_currency"
          ],
          "order_field": "cost",
          "order_type": 1,
          "page_size": 100,
          "campaign_shop_automation_type": 2,
          "external_type_list": [
            "304",
            "307",
            "305"
          ]
        },
        "request_query": {
          "locale": "zh",
          "language": "zh",
          "seller": "oec_seller_id",
          "advertiser": "aadvid",
          "timeout_ms": 30000
        },
        "campaign_response": {
          "records": [
            "data",
            "table"
          ],
          "pagination": [
            "data",
            "pagination"
          ],
          "total": "total_count",
          "page_count": "page_count",
          "page": "page",
          "id": "campaign_id",
          "name": "campaign_name"
        }
      }
    }}
}
```
<!-- report-spec:end -->

完整 performance universe 分页后，每个 campaign 的接口 record 以稳定 campaign_id 为 key、确定性 JSON 完整保存。单日与区间共用这一报告：单日文件名为 `YYYY-MM-DD.xlsx`，多日文件名为 `YYYY-MM-DD_至_YYYY-MM-DD.xlsx`。all universe 为零时 report-level no-data 且不创建伪 campaign 目录。每行 `currency` 使用同一 RunContext 冻结的广告户 ISO 币种；缺失时失败。不再另建“计划每日表现”报告。

## gmvmax_campaign_current_configuration_snapshot

<!-- report-spec:start -->
```json
{
  "schema_version":"report_spec_v1","report_id":"gmvmax_campaign_current_configuration_snapshot","enabled":true,"explicit_only":false,"owner_scope":"campaign",
  "required_variables":["shop","advertiser","campaign"],"campaign_selection":"all_or_explicit","source_type":"official_api","success_output_type":"generated_xlsx","no_data_output_type":"generated_xlsx","time_semantics":"current_snapshot","output_granularity":"snapshot",
  "output_path_template":"计划数据/GMV Max 当前配置/{{time_file}}",
  "headers":["captured_date","campaign_id","campaign_name","configuration_json","currency"],"required_key_columns":["campaign_id"],"no_data_rule":"official_api_zero_total",
  "providers":{"cross_border":{"runner":"scripts/routes/cross_border/gmvmax_campaign_current_configuration_snapshot.js","transport":"seller_page_post_campaign_get_detail","response_origin":"https://seller.tiktokshopglobalselling.com","campaign_request_fields":{"start":"start_time","end":"end_time","page":"page"},"api_contract":{"campaign_endpoint":"/oec_ads/shopping/v1/oec/stat/post_campaign_list","campaign_request":{"query_list":["campaign_id","campaign_name","cost"],"order_field":"cost","order_type":1,"page_size":100,"campaign_shop_automation_type":2,"external_type_list":["304","307"],"filters":[{"field":"campaign_status","in_field_values":["no_delete"],"filter_type":0}]},"detail_endpoint":"/oec_ads/shopping/v1/creation/all_ad_data/detail","detail_request_field":"campaign_id","detail_campaign_id_paths":[["data","campaign_info","campaign_id"],["data","ad_info","campaign_id"]],"detail_seller_id_paths":[["data","ad_info","shop_id"]],"detail_data_path":["data"],"request_query":{"locale":"zh","language":"zh","seller":"oec_seller_id","advertiser":"aadvid","timeout_ms":30000},"campaign_response":{"records":["data","table"],"pagination":["data","pagination"],"total":"total_count","page_count":"page_count","page":"page","id":"campaign_id","name":"campaign_name"}}},"local":{"runner":"scripts/routes/local/gmvmax_campaign_current_configuration_snapshot.js","transport":"seller_page_post_campaign_get_detail","response_origin":"https://seller-ph.tiktok.com","campaign_request_fields":{"start":"start_time","end":"end_time","page":"page"},"api_contract":{"campaign_endpoint":"/oec_ads/shopping/v1/oec/stat/post_campaign_list","campaign_request":{"query_list":["campaign_id","campaign_name","cost"],"order_field":"cost","order_type":1,"page_size":100,"campaign_shop_automation_type":2,"external_type_list":["304","307"],"filters":[{"field":"campaign_status","in_field_values":["no_delete"],"filter_type":0}]},"detail_endpoint":"/oec_ads/shopping/v1/creation/all_ad_data/detail","detail_request_field":"campaign_id","detail_campaign_id_paths":[["data","campaign_info","campaign_id"],["data","ad_info","campaign_id"]],"detail_seller_id_paths":[["data","ad_info","shop_id"]],"detail_data_path":["data"],"request_query":{"locale":"zh","language":"zh","seller":"oec_seller_id","advertiser":"aadvid","timeout_ms":30000},"campaign_response":{"records":["data","table"],"pagination":["data","pagination"],"total":"total_count","page_count":"page_count","page":"page","id":"campaign_id","name":"campaign_name"}}}}
}
```
<!-- report-spec:end -->

只读取 current universe；每个 campaign detail 是一个配置快照，以固定身份列和确定性 JSON 保存，不自行拆建配置模型。detail 回显 campaign_id 必须与目标一致。每行 `currency` 使用同一 RunContext 冻结的广告户 ISO 币种；缺失时失败。

## gmvmax_campaign_change_log

<!-- report-spec:start -->
```json
{
  "schema_version":"report_spec_v1","report_id":"gmvmax_campaign_change_log","enabled":true,"explicit_only":false,"owner_scope":"campaign",
  "required_variables":["shop","advertiser","campaign","start_date","end_date"],"campaign_selection":"all_or_explicit","source_type":"official_api","success_output_type":"generated_xlsx","no_data_output_type":"generated_xlsx","time_semantics":"requested_range","output_granularity":"request_range",
  "output_path_template":"计划数据/GMV Max 计划变更记录/{{time_file}}",
  "headers":["campaign_id","change_id","change_record_json","currency"],"required_key_columns":["campaign_id","change_id"],"no_data_rule":"official_api_zero_total",
  "providers":{"cross_border":{"runner":"scripts/routes/cross_border/gmvmax_campaign_change_log.js","transport":"seller_ui_campaign_table_and_change_log","response_origin":"https://seller.tiktokshopglobalselling.com","campaign_ui":{"entry_path":"/ads-creation/dashboard","row_selector":"tr.campaign-table-row-PRiZ","action_selector":"[data-testid=\"actions-index-osAPKg\"][data-btm$=\":viewdata\"]","navigation_timeout_ms":90000},"api_contract":{"methods":{"change":"POST"},"change_endpoint":"/oec_ads/shopping/v1/oec/stat/campaign_opt_log_list","page_size":100,"change_request_fields":{"campaign":"campaign_id","start":"start_time","end":"end_time","limit":"limit","page":"page"},"change_response":{"records":["data","logs"],"pagination":["data","pagination"],"total":"total_count","page_count":"page_count","page":"page","id":"id"},"request_query":{"locale":"zh","language":"zh","seller":"oec_seller_id","advertiser":"aadvid","timeout_ms":30000}}},"local":{"runner":"scripts/routes/local/gmvmax_campaign_change_log.js","transport":"seller_ui_campaign_table_and_change_log","response_origin":"https://seller-ph.tiktok.com","campaign_ui":{"entry_path":"/ads-creation/dashboard","row_selector":"tr.campaign-table-row-PRiZ","action_selector":"[data-testid=\"actions-index-osAPKg\"][data-btm$=\":viewdata\"]","navigation_timeout_ms":90000},"api_contract":{"methods":{"change":"POST"},"change_endpoint":"/oec_ads/shopping/v1/oec/stat/campaign_opt_log_list","page_size":100,"change_request_fields":{"campaign":"campaign_id","start":"start_time","end":"end_time","limit":"limit","page":"page"},"change_response":{"records":["data","logs"],"pagination":["data","pagination"],"total":"total_count","page_count":"page_count","page":"page","id":"id"},"request_query":{"locale":"zh","language":"zh","seller":"oec_seller_id","advertiser":"aadvid","timeout_ms":30000}}}}
}
```
<!-- report-spec:end -->

从广告数据面板当前计划表格逐行读取计划名称及 `data-btm-config.params.campaign_id`，只对页面当前识别到的计划逐个严格分页读取 `data.logs`。页面计划行缺失、ID 无效或重复时 fail closed；仅当精确 `data.pagination.total_count=0` 时允许 `data.logs` 缺席并视为可信空结果。正值 `id` 非空且唯一，其他 zero/shape 异常 fail closed。`change_record_json` 可能包含预算等金额，因此每行 `currency` 使用同一 RunContext 冻结的广告户 ISO 币种。

## gmvmax_campaign_recommendation_snapshot

<!-- report-spec:start -->
```json
{
  "schema_version":"report_spec_v1","report_id":"gmvmax_campaign_recommendation_snapshot","enabled":true,"explicit_only":false,"owner_scope":"campaign",
  "required_variables":["shop","advertiser","campaign"],"campaign_selection":"all_or_explicit","source_type":"official_api","success_output_type":"generated_xlsx","no_data_output_type":"generated_xlsx","time_semantics":"current_snapshot","output_granularity":"snapshot",
  "output_path_template":"计划数据/GMV Max 建议快照/{{time_file}}",
  "logical_tables":[{"logical_table":"items","headers":["campaign_id","items_json","currency"],"required_key_columns":["campaign_id"]},{"logical_table":"summary","headers":["campaign_id","summary_json","currency"],"required_key_columns":["campaign_id"]}],"no_data_rule":"official_api_zero_total",
  "providers":{"cross_border":{"runner":"scripts/routes/cross_border/gmvmax_campaign_recommendation_snapshot.js","transport":"seller_page_post_campaign_get_recommendation","response_origin":"https://seller.tiktokshopglobalselling.com","campaign_request_fields":{"start":"start_time","end":"end_time","page":"page"},"api_contract":{"campaign_endpoint":"/oec_ads/shopping/v1/oec/stat/post_campaign_list","campaign_request":{"query_list":["campaign_id","campaign_name","cost"],"order_field":"cost","order_type":1,"page_size":100,"campaign_shop_automation_type":2,"external_type_list":["304","307"],"filters":[{"field":"campaign_status","in_field_values":["no_delete"],"filter_type":0}]},"recommendation_endpoint":"/oec_ads/shopping/v1/recommendation/query","placements":"104000010","recommendation_request_fields":{"placements":"placements","campaign":"campaign_id"},"recommendation_response":{"items":["data","items"],"summary":["data","summary"]},"item_campaign_id_paths":[["apply_entity","id"],["content","meta","campaign_id"]],"request_query":{"locale":"zh","language":"zh","seller":"oec_seller_id","advertiser":"aadvid","timeout_ms":30000},"campaign_response":{"records":["data","table"],"pagination":["data","pagination"],"total":"total_count","page_count":"page_count","page":"page","id":"campaign_id","name":"campaign_name"}}},"local":{"runner":"scripts/routes/local/gmvmax_campaign_recommendation_snapshot.js","transport":"seller_page_post_campaign_get_recommendation","response_origin":"https://seller-ph.tiktok.com","campaign_request_fields":{"start":"start_time","end":"end_time","page":"page"},"api_contract":{"campaign_endpoint":"/oec_ads/shopping/v1/oec/stat/post_campaign_list","campaign_request":{"query_list":["campaign_id","campaign_name","cost"],"order_field":"cost","order_type":1,"page_size":100,"campaign_shop_automation_type":2,"external_type_list":["304","307"],"filters":[{"field":"campaign_status","in_field_values":["no_delete"],"filter_type":0}]},"recommendation_endpoint":"/oec_ads/shopping/v1/recommendation/query","placements":"104000010","recommendation_request_fields":{"placements":"placements","campaign":"campaign_id"},"recommendation_response":{"items":["data","items"],"summary":["data","summary"]},"item_campaign_id_paths":[["apply_entity","id"]],"request_query":{"locale":"zh","language":"zh","seller":"oec_seller_id","advertiser":"aadvid","timeout_ms":30000},"campaign_response":{"records":["data","table"],"pagination":["data","pagination"],"total":"total_count","page_count":"page_count","page":"page","id":"campaign_id","name":"campaign_name"},"optional_item_campaign_id_paths":[["content","meta","campaign_id"]],"item_entity_type_paths":[["entity_type"],["apply_entity","type"]],"campaign_entity_type":2}}}
}
```
<!-- report-spec:end -->

只按 current universe 读取 recommendation。来源明确分为 items 与 summary 两个逻辑表；items 使用确定性 JSON 数组、summary 使用确定性 JSON 对象。两表的 `currency` 使用同一 RunContext 冻结的广告户 ISO 币种，以覆盖建议中可能出现的 GMV 金额。items 为空时两表均发布可信空表，不把 summary 独立宣称为业务成功。

2026-09-11 TK蚊帐1店 local 非空现场样本：2 个计划共 5 条建议，`entity_type=2`、`apply_entity.type=2`，且 `apply_entity.id` 均精确匹配请求计划及同一广告户的 campaign universe。创建限时促销建议的 `content.meta` 仅有 `spu_list`，其中是独立商品 ID；其余 4 条的 `content.meta.campaign_id` 均匹配计划。因此 local 以类型限定的 `apply_entity.id` 为必需计划归属证据，辅助 `content.meta.campaign_id` 仅允许缺席，存在时仍须有效且一致。未知类型、无必需证据或条目非对象是结构异常；任何明确计划冲突都拒绝该报表整包。cross_border 只同步错误分类与脱敏诊断，保留双字段必需合同，不沿用未经该 provider 现场验证的可选字段规则。故障范围遵循 execution-context：结构、请求范围及计划冲突只使本报表失败；店铺/广告户绑定漂移仍为全任务致命错误。

## gmvmax_campaign_overview

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "gmvmax_campaign_overview",
  "enabled": true,
  "explicit_only": false,
  "owner_scope": "advertiser",
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
  "output_path_template": "广告户数据/GMV Max 计划总览/{{time_file}}",
  "headers": [
    "时间",
    "成本",
    "SKU orders (Current shop)",
    "Cost per order (Current shop)",
    "Gross revenue (Current shop)",
    "ROI (Current shop)",
    "币种"
  ],
  "required_key_columns": [
    "时间"
  ],
  "no_data_rule": "official_campaign_list_total_zero",
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/gmvmax_campaign_overview.js",
      "transport": "seller_ui_direct_download",
      "response_origin": "https://seller.tiktokshopglobalselling.com",
      "official_validation": {
    "blocking_overlay": {"dialog_selector": "[role=\"dialog\"]:visible", "button_pattern": "^(?:Got it|知道了|好的)$", "max_attempts": 2, "timeout_ms": 10000},
    "entry_path": "/ads-creation/dashboard",
    "date_root_selector": "[data-testid=\"dashboard-date-picker-index-rF7379\"]",
    "date_input_selector": "input",
    "date_trigger_selector": ".theme-arco-trigger",
    "date_panel_selector": ".theme-arco-panel-date",
    "date_header_selector": ".theme-arco-picker-header",
    "date_header_control_selector": ".theme-arco-picker-header-icon",
    "date_cell_selector": ".theme-arco-picker-cell.theme-arco-picker-cell-in-view:not(.theme-arco-picker-cell-disabled)",
    "export_selector": "button[data-testid^=\"export-button-index-\"]",
    "date_max_month_moves": 24,
    "navigation_timeout_ms": 90000,
    "picker_timeout_ms": 90000,
    "campaign_endpoint": "/oec_ads/shopping/v1/oec/stat/post_campaign_list",
    "date_fields": {
      "start": "start_time",
      "end": "end_time"
    },
    "campaign_request": {
      "query_list": [
        "campaign_name",
        "campaign_primary_status",
        "campaign_status",
        "cost",
        "onsite_roi2_shopping_sku",
        "onsite_roi2_shopping_value",
        "onsite_roi2_shopping",
        "template_ad_start_time",
        "template_ad_end_time"
      ],
      "order_field": "cost",
      "order_type": 1,
      "page": 1,
      "page_size": 20,
      "campaign_shop_automation_type": 2,
      "external_type_list": [
        "304",
        "307"
      ],
      "filters": [
        {
          "field": "campaign_status",
          "in_field_values": [
            "no_delete"
          ],
          "filter_type": 0
        }
      ]
    },
    "create_endpoint": "/oec_ads/shopping/v1/oec/stat/post_overview_stat",
    "create_request": {
      "query_list": [
        "cost",
        "onsite_roi2_shopping_sku",
        "cost_per_onsite_roi2_shopping_sku",
        "onsite_roi2_shopping_value",
        "onsite_roi2_shopping"
      ],
      "campaign_shop_automation_type": 2,
      "external_type_list": [
        "307",
        "304",
        "305"
      ],
      "action": "download"
    },
    "task_query_endpoint": "/oec_ads/shopping/v1/oec/stat/download_task/query",
    "query_parameters": {
      "seller_id": "oec_seller_id",
      "advertiser_id": "aadvid"
    },
    "query_constants": {
      "locale": "zh",
      "language": "zh"
    },
    "response_paths": {
      "campaign_total": [
        "data",
        "pagination",
        "total_count"
      ],
      "create_task_id": [
        "extra",
        "task_id"
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
    "max_polls": 600,
    "request_timeout_ms": 30000,
    "download_timeout_ms": 120000,
    "data_start_row": 2,
    "task_query_request": {"task_id_field":"download_id"},
    "identity_response_fields": {"seller":["seller_id","oec_seller_id"],"advertiser":["advertiser_id","aadvid"]}
      },
      "retry_policy": {
        "operation_class": "official_export_action",
        "max_total_attempts": 1,
        "identity_and_contract_failures_retryable": false
      }
    },
    "local": {
      "runner": "scripts/routes/local/gmvmax_campaign_overview.js",
      "transport": "seller_ui_direct_download",
      "response_origin": "https://seller-ph.tiktok.com",
      "official_validation": {
        "blocking_overlay": {"dialog_selector": "[role=\"dialog\"]:visible", "button_pattern": "^(?:Got it|知道了|好的)$", "max_attempts": 2, "timeout_ms": 10000},
        "entry_path": "/ads-creation/dashboard",
        "date_root_selector": "[data-testid=\"dashboard-date-picker-index-rF7379\"]",
        "date_input_selector": "input",
        "date_trigger_selector": ".theme-arco-trigger",
        "date_panel_selector": ".theme-arco-panel-date",
        "date_header_selector": ".theme-arco-picker-header",
        "date_header_control_selector": ".theme-arco-picker-header-icon",
        "date_cell_selector": ".theme-arco-picker-cell.theme-arco-picker-cell-in-view:not(.theme-arco-picker-cell-disabled)",
        "export_selector": "button[data-testid^=\"export-button-index-\"]",
        "date_max_month_moves": 24,
        "navigation_timeout_ms": 90000,
        "picker_timeout_ms": 90000,
        "campaign_endpoint": "/oec_ads/shopping/v1/oec/stat/post_campaign_list",
        "date_fields": {
          "start": "start_time",
          "end": "end_time"
        },
        "campaign_request": {
          "query_list": [
            "campaign_name",
            "campaign_primary_status",
            "campaign_status",
            "cost",
            "onsite_roi2_shopping_sku",
            "onsite_roi2_shopping_value",
            "onsite_roi2_shopping",
            "template_ad_start_time",
            "template_ad_end_time"
          ],
          "order_field": "cost",
          "order_type": 1,
          "page": 1,
          "page_size": 20,
          "campaign_shop_automation_type": 2,
          "external_type_list": [
            "304",
            "307"
          ],
          "filters": [
            {
              "field": "campaign_status",
              "in_field_values": [
                "no_delete"
              ],
              "filter_type": 0
            }
          ]
        },
        "create_endpoint": "/oec_ads/shopping/v1/oec/stat/post_overview_stat",
        "create_request": {
          "query_list": [
            "cost",
            "onsite_roi2_shopping_sku",
            "cost_per_onsite_roi2_shopping_sku",
            "onsite_roi2_shopping_value",
            "onsite_roi2_shopping"
          ],
          "campaign_shop_automation_type": 2,
          "external_type_list": [
            "307",
            "304",
            "305"
          ],
          "action": "download"
        },
        "task_query_endpoint": "/oec_ads/shopping/v1/oec/stat/download_task/query",
        "query_parameters": {
          "seller_id": "oec_seller_id",
          "advertiser_id": "aadvid"
        },
        "query_constants": {
          "locale": "zh",
          "language": "zh"
        },
        "response_paths": {
          "campaign_total": [
            "data",
            "pagination",
            "total_count"
          ],
          "create_task_id": [
            "extra",
            "task_id"
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
        "max_polls": 600,
        "request_timeout_ms": 30000,
        "download_timeout_ms": 120000,
        "data_start_row": 2,
        "task_query_request": {
          "task_id_field": "download_id"
        },
        "identity_response_fields": {
          "seller": [
            "seller_id",
            "oec_seller_id"
          ],
          "advertiser": [
            "advertiser_id",
            "aadvid"
          ]
        }
      },
      "retry_policy": {
        "operation_class": "official_export_action",
        "max_total_attempts": 1,
        "identity_and_contract_failures_retryable": false
      }
    }
  }
}
```
<!-- report-spec:end -->

该报表是 advertiser-level 请求范围官方文件，不接受 campaign selector，也不写 campaign 目录。进入 GMV Max 活动页后，在顶部日期选择器原样设置请求范围并确认两个输入值完全一致，只点击日期右侧唯一官方下载按钮一次，等待该点击触发的浏览器下载事件。不得创建或轮询下载任务 API。官方文件保持原字节，不校验原文件名、Sheet、表头、日期或业务键；工作簿必须可读，`data_row_count` 统计第 2 行起的非空行且至少为 1。

## gmvmax_campaign_product_creative_performance

<!-- report-spec:start -->
```json
{
  "schema_version": "report_spec_v1",
  "report_id": "gmvmax_campaign_product_creative_performance",
  "enabled": true,
  "explicit_only": false,
  "owner_scope": "product",
  "required_variables": [
    "shop",
    "advertiser",
    "campaign",
    "product",
    "start_date",
    "end_date"
  ],
  "campaign_selection": "all_or_explicit",
  "product_selection": "all_or_explicit",
  "source_type": "official_download",
  "success_output_type": "official_xlsx",
  "no_data_output_type": "generated_xlsx",
  "published_identity_columns": [
    "product_id"
  ],
  "time_semantics": "requested_range",
  "output_granularity": "request_range",
  "output_path_template": "计划数据/GMV Max 计划商品素材表现/{{time_file}}",
  "headers": [
    "Post ID",
    "Creative",
    "TikTok account",
    "Creative type",
    "Video source",
    "Status",
    "Exploration secondary status",
    "Time posted",
    "成本",
    "SKU 订单数",
    "平均下单成本",
    "总收入",
    "Product ad impressions",
    "Product ad clicks",
    "Product ad click rate",
    "Ad conversion rate",
    "2-second ad video view rate",
    "6-second ad video view rate",
    "25% ad video view rate",
    "50% ad video view rate",
    "75% ad video view rate",
    "100% ad video view rate",
    "Currency",
    "product_id"
  ],
  "required_key_columns": [
    "Post ID"
  ],
  "no_data_rule": "official_creative_total_zero",
  "providers": {
    "cross_border": {
      "runner": "scripts/routes/cross_border/gmvmax_campaign_product_creative_performance.js",
      "transport": "seller_ui_four_step_official_download",
      "response_origin": "https://seller.tiktokshopglobalselling.com",
      "official_validation": {
        "blocking_overlay": {"dialog_selector": "[role=\"dialog\"]:visible", "button_pattern": "^(?:Got it|知道了|好的)$", "max_attempts": 2, "timeout_ms": 10000},
        "entry_path": "/ads-creation/dashboard",
        "campaign_row_selector": "tr.campaign-table-row-PRiZ",
        "campaign_action_selector": "[data-testid=\"actions-index-osAPKg\"][data-btm$=\":viewdata\"]",
        "campaign_url_query": "campaign_id",
        "product_row_selector": "tr:has([data-btm$=\":view_creative\"])",
        "product_action_selector": "[data-testid=\"actions-index-osAPKg\"][data-btm$=\":view_creative\"]",
        "product_url_query": "product_id",
        "product_tab_query": "activated_tab_id",
        "product_tab_value": "1",
        "date_root_selector": ".drawer-nav [data-testid=\"dashboard-date-picker-index-rF7379\"]",
        "date_input_selector": "input",
        "date_trigger_selector": ".theme-arco-trigger",
        "date_panel_selector": ".theme-arco-panel-date",
        "date_header_selector": ".theme-arco-picker-header",
        "date_header_control_selector": ".theme-arco-picker-header-icon",
        "date_cell_selector": ".theme-arco-picker-cell.theme-arco-picker-cell-in-view:not(.theme-arco-picker-cell-disabled)",
        "date_max_month_moves": 24,
        "date_refresh_settle_ms": 500,
        "creative_root_selector": "div[data-uid=\"creative-table:index:container\"].creative-table-x5Yx",
        "creative_table_selector": "table",
        "creative_header_text": "创意素材",
        "creative_row_selector": "tbody tr",
        "export_selector": "button[data-tid=\"m4b_button\"][data-uid^=\"exportbutton:button_handleexport:\"][data-tea-click_for=\"export_button_view_data_creative_0\"]",
        "export_loading_class": "theme-arco-btn-loading",
        "zero_text": "暂无数据",
        "filename_template": "Creative data {{start_date}} - {{end_date}} - Product {{product_id}}.xlsx",
        "navigation_timeout_ms": 90000,
        "picker_timeout_ms": 90000,
        "download_batch_size": 3,
        "download_start_timeout_ms": 30000,
        "download_retry_limit": 1,
        "download_timeout_ms": 1200000,
        "download_capture": {
          "mode": "cdp_forced_staging_poll",
          "poll_interval_ms": 500,
          "stable_polls": 2
        },
        "data_start_row": 2
      }
    },
    "local": {
      "runner": "scripts/routes/local/gmvmax_campaign_product_creative_performance.js",
      "transport": "seller_ui_four_step_official_download",
      "response_origin": "https://seller-ph.tiktok.com",
      "official_validation": {
        "date_previous_month_selector": ".theme-arco-picker-header-icon:has(> svg.theme-arco-icon-left)",
        "date_next_month_selector": ".theme-arco-picker-header-icon:has(> svg.theme-arco-icon-right)",
        "blocking_overlay": {"dialog_selector": "[role=\"dialog\"]:visible", "button_pattern": "^(?:Got it|知道了|好的)$", "max_attempts": 2, "timeout_ms": 10000},
        "entry_path": "/ads-creation/dashboard",
        "campaign_row_selector": "tr.campaign-table-row-PRiZ",
        "campaign_action_selector": "[data-testid=\"actions-index-osAPKg\"][data-btm$=\":viewdata\"]",
        "campaign_url_query": "campaign_id",
        "product_row_selector": "tr:has([data-btm$=\":view_creative\"])",
        "product_action_selector": "[data-testid=\"actions-index-osAPKg\"][data-btm$=\":view_creative\"]",
        "product_url_query": "product_id",
        "product_tab_query": "activated_tab_id",
        "product_tab_value": "1",
        "date_root_selector": ".drawer-nav [data-testid=\"dashboard-date-picker-index-rF7379\"]",
        "date_input_selector": "input",
        "date_trigger_selector": ".theme-arco-trigger",
        "date_panel_selector": ".theme-arco-panel-date",
        "date_header_selector": ".theme-arco-picker-header",
        "date_header_control_selector": ".theme-arco-picker-header-icon",
        "date_cell_selector": ".theme-arco-picker-cell.theme-arco-picker-cell-in-view:not(.theme-arco-picker-cell-disabled)",
        "date_max_month_moves": 24,
        "date_refresh_settle_ms": 500,
        "creative_root_selector": "div[data-uid=\"creative-table:index:container\"].creative-table-x5Yx",
        "creative_table_selector": "table",
        "creative_header_text": "创意素材",
        "creative_row_selector": "tbody tr",
        "export_selector": "button[data-tid=\"m4b_button\"][data-uid^=\"exportbutton:button_handleexport:\"][data-tea-click_for=\"export_button_view_data_creative_0\"]",
        "export_loading_class": "theme-arco-btn-loading",
        "zero_text": "暂无数据",
        "filename_template": "Creative data {{start_date}} - {{end_date}} - Product {{product_id}}.xlsx",
        "navigation_timeout_ms": 90000,
        "picker_timeout_ms": 90000,
        "download_batch_size": 3,
        "download_start_timeout_ms": 30000,
        "download_retry_limit": 1,
        "download_timeout_ms": 1200000,
        "download_capture": {
          "mode": "cdp_forced_staging_poll",
          "poll_interval_ms": 500,
          "stable_polls": 2
        },
        "data_start_row": 2
      }
    }
  }
}
```
<!-- report-spec:end -->

两侧 provider 各自持有完整且独立的冻结 UI 合同，不互相 import 或 fallback。当前页面按可见 action 顺序遍历：计划 action 点击后以 URL `campaign_id` 和该行标题上下文冻结计划身份；商品 action 点击后以 URL `campaign_id`、`product_id`、`activated_tab_id=1` 和该行标题上下文冻结商品身份。动作或作用域缺失必须以 `campaign_discovery_failed` / `product_discovery_failed` 失败关闭，不得把空 `units` 或 `artifacts` 解释为 no-data。

日期只操作商品数据页顶部“概览”的 dashboard 日期控件。打开后按可见 trigger 内月份 header 的精确 `YYYY-MM` 标题选择面板，只点击 in-view、enabled 且日号文本精确唯一的官方日期格；缺月时仅通过 header 官方控件有限移动。动作顺序固定为 dashboard picker → start 日期格 → 重新定位弹层后的 end 日期格；两击之间不检查或写入 input。第二击后仅等待顶部 dashboard 两个显示值精确等于请求范围，并经过最小 refresh settle，再由创意区现有 ready 门禁等待 scoped 官方按钮 visible/enabled。页面 URL 不承担日期合同，最终下载文件名仍须与请求起止日期模板精确一致。创意区只有 root 内唯一可见精确“暂无数据”且 tbody 为 0 行时才是可信 zero。

主页面只遍历一次计划与商品并确认官方页面显示的计划 ID、商品 ID；显式指定 Product ID 时，只在当前商品列表匹配该 ID，不得为了验证目标而逐个进入其他商品页。商品按页面顺序每 3 个组成一批：先创建本批全部 Seller 标签页，使用已确认的 ID 直接进入各自商品素材界面并设置日期，再按页面顺序逐个点击一次官方下载按钮；本批按钮全部点击后把第一个商品页切回前台，并行等待对应文件，按官方文件名中的 Product ID 绑定商品。按钮出现 `theme-arco-btn-loading` 圆圈加载态、收到 CDP 下载开始事件或对应文件出现，任一项都证明官方已接受下载；只有三项证据连续 30 秒均不存在时，才对该缺失商品补点一次，不得直接空等 20 分钟。批次完成后关闭这些标签页并进入下一批；不得让每个工作页重复遍历计划，也不得在同一标签页点击后立即导航离开或无限并发。

每个 campaign×product 在 staging 内创建独立空 capture 目录，点击前通过同页 CDP `Browser.setDownloadBehavior` 强制下载到该目录；设置失败不得点击。scoped 官方按钮只点击一次，最长 20 分钟轮询至 `.crdownload` 消失、唯一 XLSX 文件名与模板精确一致，并且 size/mtime 连续达到合同稳定次数。完成文件作为官方原字节读取、校验并记录 SHA、bytes、rows，不经 `waitForEvent('download')`、`saveAs` 或重写；正式发布时只在发布副本末列追加冻结的 `product_id`，staging 官方原件不变。禁止 creative/task API、Export History 与默认 Downloads 目录。
