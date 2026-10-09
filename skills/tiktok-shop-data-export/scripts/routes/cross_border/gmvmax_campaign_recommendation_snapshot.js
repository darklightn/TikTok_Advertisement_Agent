'use strict';

const crypto = require('crypto');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { aggregate, getPath, writeArtifact } = require('../../common/shop-api-v3');
const { captureDate, itemsRow, summaryRow } = require('../common/gmvmax_campaign_recommendation_snapshot_v3');

const REPORT_ID='gmvmax_campaign_recommendation_snapshot';
function fail(code, diagnostics){throw Object.assign(new Error(code),{code,...(diagnostics?{diagnostics}:{})});}
function comparison(field, expected, actual, extra = {}) {
  const digest = (value) => value == null ? null : crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
  return { field_path: field, expected_digest: digest(expected), actual_digest: digest(actual),
    actual_present: actual !== undefined && actual !== null, actual_type: actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual, ...extra };
}
function checkQuery(final, key, expected, code, failureKind) {
  const actual = final.searchParams.get(key);
  if (actual !== String(expected)) fail(code, comparison('query.' + key, expected, actual, { stage: 'recommendation_request', failure_kind: actual === null ? 'missing_parameter' : failureKind }));
}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function text(value){return typeof value==='string'&&Boolean(value.trim());}
function digits(value){return /^\d+$/u.test(String(value||''));}
function endpoint(value){const candidate=String(value||'');return /^\/[a-z0-9_/-]+$/u.test(candidate)&&!candidate.includes('//')&&!candidate.includes('..');}
function fieldPath(value){return Array.isArray(value)&&value.length>0&&value.every((part)=>text(part)||Number.isInteger(part));}
function pathList(value){return Array.isArray(value)&&value.length>0&&value.every(fieldPath);}
function httpsOrigin(value){try{const url=new URL(value);return url.protocol==='https:'&&url.origin===value;}catch{return false;}}
function activePage(page,origin){try{const url=new URL(page.url());return url.origin===origin&&!/(?:login|signin|passport)(?:\/|$)/iu.test(url.pathname);}catch{return false;}}
function fields(value,names){return object(value)&&names.every((name)=>text(value[name]))&&new Set(names.map((name)=>value[name])).size===names.length;}
function table(spec,name){return spec.logical_tables.find((item)=>item.logical_table===name);}

function validateSpec(spec,providerSpec,options={}){try{validateReportSpec(spec,options);}catch{fail('campaign_recommendation_spec_invalid');}const contract=providerSpec?.api_contract;const response=contract?.campaign_response;const recommendation=contract?.recommendation_response;const query=contract?.request_query;
  if(spec?.report_id!==REPORT_ID||spec.campaign_selection!=='all_or_explicit'||!Array.isArray(spec.logical_tables)||!['items','summary'].every((name)=>table(spec,name)?.headers?.at(-1)==='currency')||spec.no_data_rule!=='official_api_zero_total'||spec.providers?.cross_border!==providerSpec||providerSpec?.transport!=='seller_page_post_campaign_get_recommendation'||!httpsOrigin(providerSpec?.response_origin)||!fields(providerSpec.campaign_request_fields,['start','end','page'])
    ||!object(contract)||!endpoint(contract.campaign_endpoint)||!endpoint(contract.recommendation_endpoint)||contract.campaign_endpoint===contract.recommendation_endpoint||!object(contract.campaign_request)||!text(contract.placements)||!fields(contract.recommendation_request_fields,['placements','campaign'])||!object(recommendation)||!fieldPath(recommendation.items)||!fieldPath(recommendation.summary)||!pathList(contract.item_campaign_id_paths)
    ||(contract.optional_item_campaign_id_paths!==undefined&&!pathList(contract.optional_item_campaign_id_paths))
    ||(contract.item_entity_type_paths!==undefined&&(!pathList(contract.item_entity_type_paths)||!Number.isInteger(contract.campaign_entity_type)))
    ||!object(query)||!text(query.seller)||!text(query.advertiser)||query.seller===query.advertiser||!Number.isInteger(query.timeout_ms)||query.timeout_ms<1||Object.entries(query).some(([key,value])=>!['seller','advertiser','timeout_ms'].includes(key)&&!['string','number','boolean'].includes(typeof value))
    ||!object(response)||!fieldPath(response.records)||!fieldPath(response.pagination)||!['total','page_count','page','id','name'].every((key)=>text(response[key])))fail('campaign_recommendation_spec_invalid');return spec;}
function assertSession(live){if(!live.browser?.isConnected?.())fail('browser_disconnected');if(!live.context||!live.browser.contexts?.().includes(live.context))fail('browser_context_missing');if(!live.context.pages().includes(live.page))fail('seller_page_missing');if(!activePage(live.page,live.origin))fail('seller_origin_mismatch');}
function assertFailureSession(input,dependencies){if(!dependencies.browser?.isConnected?.())fail('browser_disconnected');if(!dependencies.browserContext||!dependencies.browser.contexts?.().includes(dependencies.browserContext))fail('browser_context_missing');let origin;try{origin=new URL(input?.b?.seller_page_url).origin;}catch{return;}const pages=dependencies.browserContext.pages?.()||[];if(pages.some((page)=>activePage(page,origin)))return;if(pages.some((page)=>{try{const url=new URL(page.url());return url.origin===origin&&/(?:login|signin|passport)(?:\/|$)/iu.test(url.pathname);}catch{return false;}}))fail('seller_login_page');fail('seller_origin_mismatch');}
function requestQuery(live){const{seller,advertiser,timeout_ms:_timeout,...constants}=live.contract.request_query;return{...constants,[seller]:live.sellerId,[advertiser]:live.advertiserId};}
async function request(live,endpointPath,method,body,recommendationQuery){assertSession(live);const target=new URL(endpointPath,live.providerSpec.response_origin);for(const[key,value]of Object.entries(requestQuery(live)))target.searchParams.set(key,String(value));if(recommendationQuery)for(const[key,value]of Object.entries(recommendationQuery))target.searchParams.set(key,String(value));let response;
  try{response=await live.page.request.fetch(target.href,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{data:body}),timeout:live.contract.request_query.timeout_ms,failOnStatusCode:false});}catch{assertSession(live);fail('campaign_recommendation_transport_error');}assertSession(live);if([401,403].includes(response.status()))fail('transport_login_required');if(response.status()!==200)fail('campaign_recommendation_api_error');let final;try{final=new URL(response.url());}catch{fail('campaign_recommendation_api_error');}
  if(final.origin!==live.providerSpec.response_origin||final.pathname!==endpointPath)fail('seller_origin_mismatch');
  checkQuery(final,live.contract.request_query.seller,live.sellerId,'provider_binding_invalid','seller_drift');
  checkQuery(final,live.contract.request_query.advertiser,live.advertiserId,'provider_binding_invalid','advertiser_drift');
  if(recommendationQuery)for(const[key,value]of Object.entries(recommendationQuery))checkQuery(final,key,value,'campaign_recommendation_request_scope_invalid','parameter_conflict');
  let parsed;try{parsed=JSON.parse((await response.body()).toString('utf8'));}catch{fail('campaign_recommendation_shape_invalid',{stage:'recommendation_response',field_path:'body',failure_kind:'invalid_json'});}if(!object(parsed)||parsed.code!==0)fail('campaign_recommendation_api_error');return parsed;}
function campaignBody(providerSpec,date,page){const body=structuredClone(providerSpec.api_contract.campaign_request);const fields=providerSpec.campaign_request_fields;body[fields.start]=date;body[fields.end]=date;body[fields.page]=page;return body;}
async function collectCampaigns(live,date){const response=live.contract.campaign_response;const records=[];const ids=new Set();let total=null;let pageCount=null;for(let page=1;;page+=1){const body=await request(live,live.contract.campaign_endpoint,'POST',campaignBody(live.providerSpec,date,page));const observed=getPath(body,response.records);const pagination=getPath(body,response.pagination);const observedTotal=pagination?.[response.total];const observedPageCount=pagination?.[response.page_count];if(!Array.isArray(observed)||!Number.isInteger(observedTotal)||observedTotal<0||!Number.isInteger(observedPageCount)||observedPageCount<0||pagination?.[response.page]!==page)fail('campaign_universe_shape_invalid');if(total===null){total=observedTotal;pageCount=observedPageCount;}if(total!==observedTotal||pageCount!==observedPageCount)fail('campaign_universe_pagination_changed');for(const item of observed){const campaignId=String(getPath(item,[response.id])||'');const campaignName=String(getPath(item,[response.name])||'').trim();if(!digits(campaignId)||ids.has(campaignId)||!campaignName)fail('campaign_universe_count_mismatch');ids.add(campaignId);records.push({...item,campaign_id:campaignId,campaign_name:campaignName});}if(page>=pageCount)break;}if(records.length!==total)fail('campaign_universe_count_mismatch');return records;}
function normalizedName(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/gu,' ');}
function selectCampaigns(campaigns,ref){if(ref==null)return campaigns;const matches=digits(ref)?campaigns.filter((item)=>item.campaign_id===ref):campaigns.filter((item)=>normalizedName(item.campaign_name)===ref);if(!matches.length)fail('explicit_campaign_not_found_in_report_universe');if(matches.length!==1)fail('explicit_campaign_ambiguous');return matches;}
function recommendationData(body,contract,campaignId){
  const items=getPath(body,contract.recommendation_response.items);
  const summary=getPath(body,contract.recommendation_response.summary);
  for(const [field,value,valid] of [[contract.recommendation_response.items,items,Array.isArray(items)],[contract.recommendation_response.summary,summary,object(summary)]])
    if(!valid)fail('campaign_recommendation_shape_invalid',comparison(field.join('.'),null,value,{stage:'recommendation_response',failure_kind:'invalid_structure'}));
  for(let index=0;index<items.length;index+=1){
    const item=items[index];const details={stage:'recommendation_item',item_index:index};
    if(!object(item))fail('campaign_recommendation_shape_invalid',comparison('items.'+index,null,item,{...details,failure_kind:'invalid_item'}));
    for(const field of contract.item_entity_type_paths||[]){
      const value=getPath(item,field);
      if(value!==contract.campaign_entity_type)fail('campaign_recommendation_shape_invalid',comparison(field.join('.'),contract.campaign_entity_type,value,{...details,failure_kind:value==null?'missing_entity_type':'unsupported_entity_type'}));
    }
    const required=contract.item_campaign_id_paths;
    const optional=contract.optional_item_campaign_id_paths||[];
    // Validate every present campaign claim before reporting a missing claim, so conflicts cannot be hidden by omissions.
    for(const field of [...required,...optional]){
      const value=getPath(item,field);
      if(value===undefined)continue;
      if(!(typeof value==='string'&&/^\d+$/u.test(value))&&!(Number.isSafeInteger(value)&&value>=0))
        fail('campaign_recommendation_shape_invalid',comparison(field.join('.'),campaignId,value,{...details,failure_kind:'invalid_id_type'}));
      if(String(value)!==String(campaignId))fail('campaign_recommendation_plan_conflict',comparison(field.join('.'),campaignId,value,{...details,failure_kind:'plan_conflict'}));
    }
    for(const field of required)if(getPath(item,field)===undefined)
      fail('campaign_recommendation_shape_invalid',comparison(field.join('.'),campaignId,undefined,{...details,failure_kind:'missing_campaign_evidence'}));
  }
  return{items,summary};
}
function artifacts(input,campaign,data,date,currency){const hasItems=data.items.length>0;const extra={campaign_id:campaign.campaign_id,campaign_name:campaign.campaign_name,captured_date:date,no_data_evidence:hasItems?undefined:input.reportSpec.no_data_rule};return[
  writeArtifact(input,table(input.reportSpec,'items'),hasItems?[itemsRow(campaign.campaign_id,data.items,currency)]:[],hasItems?'success':'no_data',extra),
  writeArtifact(input,table(input.reportSpec,'summary'),hasItems?[summaryRow(campaign.campaign_id,data.summary,currency)]:[],hasItems?'success':'no_data',extra),
];}
async function runInner(input,dependencies={}){if(input?.shop?.provider_id!=='cross_border')fail('report_provider_unsupported');validateSpec(input?.reportSpec,input?.providerSpec,{skillRoot:dependencies.skillRoot});const sellerId=String(input?.shop?.seller_id||'');const advertiserId=String(input?.advertiserId||'');if(!digits(sellerId)||!digits(advertiserId)||!text(input?.advertiserName)||!text(input?.advertiserCurrency)||!dependencies.browser||!dependencies.browserContext)fail('advertiser_identity_missing');let origin;try{origin=new URL(input.b.seller_page_url).origin;}catch{fail('provider_binding_invalid');}if(origin!==input.providerSpec.response_origin)fail('provider_binding_invalid');const page=dependencies.browserContext.pages().find((candidate)=>activePage(candidate,origin));if(!page)fail('seller_page_missing');const live={browser:dependencies.browser,context:dependencies.browserContext,page,origin,sellerId,advertiserId,providerSpec:input.providerSpec,contract:input.providerSpec.api_contract};const date=captureDate(dependencies.clock);const campaigns=selectCampaigns(await collectCampaigns(live,date),input.campaignRef);const output=[];for(const campaign of campaigns){const fields=live.contract.recommendation_request_fields;const query={[fields.placements]:live.contract.placements,[fields.campaign]:campaign.campaign_id};const body=await request(live,live.contract.recommendation_endpoint,'GET',undefined,query);output.push(...artifacts(input,campaign,recommendationData(body,live.contract,campaign.campaign_id),date,input.advertiserCurrency));}return{status:aggregate(output),report_id:REPORT_ID,shop_id:sellerId,seller_id:sellerId,provider_id:'cross_border',advertiser_id:advertiserId,business_center_id:String(input.businessCenterId||''),artifacts:output};}
async function run(input,dependencies={}){try{return await runInner(input,dependencies);}catch(error){if(dependencies.browser)assertFailureSession(input,dependencies);throw error;}}

module.exports={campaignBody,recommendationData,run,selectCampaigns,validateSpec};
