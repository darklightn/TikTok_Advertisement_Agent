"""Official values win over deliberately different base-quantity ratios."""
import importlib
import sys
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from common import CleaningContext, LocatedSources

DAY = date(2026, 8, 26)
MAPPING = {
    'advertiser_diagnosis': [('GMV Max平均下单成本','Cost per order (Current shop)',1), ('实际ROI','ROI (Current shop)',1)],
    'campaign_diagnosis': [('广告CTR','ctr',.01), ('GMV Max平均下单成本','cost_per_onsite_roi2_shopping_sku',1), ('实际ROI','onsite_roi2_shopping',1)],
    'campaign_hourly': [('GMV Max平均下单成本','cost_per_order_official',1), ('实际ROI','roi_official',1)],
    'creative_diagnosis': [('GMV Max平均下单成本','平均下单成本',1), ('商品广告点击率','Product ad click rate',1)],
    'product_diagnosis': [('AOV','全部.平均订单金额（SKU 订单）',1), ('商品点击率','全部.商品点击率',.01), ('加购率','全部.加购率',.01), ('CTOR','全部.CTOR（SKU 订单）',.01)],
    'shop_diagnosis': [('实际ROI','ROI (Current shop)',1)],
    'promotions': [('营销活动ROI','ROI',1)],
}

def build_sample(monkeypatch, name, value):
    module = importlib.import_module('builders.'+name)
    raw = {
        '按天':'-', '成本':10, 'SKU orders (Current shop)':3, 'Gross revenue (Current shop)':70, '币种':'USD',
        'campaign_id':'1', 'campaign_name':'plan', 'cost':10, 'show_cnt':1000, 'click_cnt':30,
        'onsite_roi2_shopping_sku':3, 'onsite_roi2_shopping_value':70, 'currency':'USD',
        'metric_date':str(DAY), 'metric_hour':0, 'impressions':1000, 'clicks':30, 'sku_orders':3, 'gross_revenue':70,
        'configuration_json':'{}', 'captured_date':str(DAY), 'items_json':'[]',
        'Product ID':'p', '商品名称':'prod', 'product_id':'p', 'Creative type':'Product card',
        'SKU 订单数':3, '总收入':70, 'Product ad impressions':1000, 'Product ad clicks':30,
        '商品 ID':'p', '商品名':'prod', '全部.GMV':100, '全部.SKU 订单数':3,
        '全部.商品点击量':30, '全部.商品曝光次数':1000, '全部.加购次数':4,
        '商品id':'promo', '活动名称':'promo', 'GMV (₱)':100, '折扣金额 (₱)':30,
    }
    for _, field, scale in MAPPING[name]:
        raw[field] = str(value)+'%' if name=='product_diagnosis' and scale==.01 and isinstance(value,(int,float)) else value
    files = {key:[Path(key+'.xlsx')] for key in [
        'advertiser_account_status','advertiser_overview','campaign_hourly','shop_creative_hub_video',
        'product_analytics','product_status_products','product_status_skus','inventory_snapshot','cost_table',
        'order_detail','rating_detail','shop_health_snapshot','fulfillment_snapshot','promotion_performance']}
    files.update({
        'campaign_performance':[Path('plan__2026-08-26.xlsx')],
        'campaign_current_config':[Path('plan__2026-08-26.xlsx')],
        'campaign_recommendation_items':[Path('plan__items__2026-08-26.xlsx')],
        'campaign_product_performance':[Path('plan__2026-08-26.xlsx'),Path('second__2026-08-26.xlsx')] if name=='product_diagnosis' else [Path('plan__2026-08-26.xlsx')],
        'campaign_product_creative_performance':[Path('plan__prod__2026-08-26_至_2026-08-26.xlsx')],
    })
    def rows(path):
        if path.stem in {'order_detail','rating_detail','shop_health_snapshot','fulfillment_snapshot','shop_creative_hub_video'}:
            return []
        if path.stem.startswith('second__'):
            return [{**raw, '成本':20, 'SKU 订单数':2, '总收入':40, 'ROI':999, '平均下单成本':999}]
        return [dict(raw)]
    if hasattr(module,'read_rows'): monkeypatch.setattr(module,'read_rows',rows)
    if hasattr(module,'read_account_identity'): monkeypatch.setattr(module,'read_account_identity',lambda p:{'shop_id':'s','advertiser_id':'a','advertiser_name':'ad','timezone':'Asia/Manila'})
    if hasattr(module,'read_product_analytics_rows'): monkeypatch.setattr(module,'read_product_analytics_rows',lambda p:[dict(raw)])
    for fn in ['load_products','load_skus','load_inventory','load_effective_costs']:
        if hasattr(module,fn): monkeypatch.setattr(module,fn,lambda *args:{})
    if name=='promotions':
        monkeypatch.setattr(module,'read_xlsx_custom_properties',lambda p:{'Currency':'PHP'})
        monkeypatch.setattr(module,'read_xlsx_rows_with_header',lambda *args:[dict(raw)])
    meta={'performance_period_suffix':'2026-08-26','creative_period_suffix':'2026-08-26_至_2026-08-26','plan_names':['plan'],
          **{k:DAY for k in ['commercial_snapshot_date','inventory_snapshot_date','health_snapshot_date','fulfillment_snapshot_date']}}
    return module.build(CleaningContext(Path('shop'),name,DAY,DAY,Path('output'),'s'),LocatedSources(files,meta)).iloc[0]

@pytest.mark.parametrize('name',list(MAPPING))
@pytest.mark.parametrize('value',[8.27,0,None,'-','N/A',''])
def test_official_value_zero_and_null_never_recalculate(monkeypatch,name,value):
    row=build_sample(monkeypatch,name,value)
    for field,_,scale in MAPPING[name]:
        if isinstance(value,(int,float)):
            assert row[field]==pytest.approx(value*scale)
        else:
            assert pd.isna(row[field])

def test_product_ad_ratios_use_cross_campaign_base_totals(monkeypatch):
    row=build_sample(monkeypatch,'product_diagnosis',8.27)
    assert row['GMV Max广告成本']==30
    assert row['GMV Max SKU订单数']==5
    assert row['GMV Max总收入']==110
    assert row['GMV Max平均下单成本']==6
    assert row['实际ROI']==pytest.approx(110/30)

@pytest.mark.parametrize('name',['shop_diagnosis','campaign_hourly','advertiser_diagnosis','creative_diagnosis'])
def test_unrelated_derived_ratios_remain(monkeypatch,name):
    row=build_sample(monkeypatch,name,8.27)
    if name=='shop_diagnosis':
        assert row['AOV']==pytest.approx(100/3)
        assert row['商品点击率']==.03
    elif name=='creative_diagnosis':
        assert row['实际ROI']==7
    else:
        assert row['广告CTR']==.03
