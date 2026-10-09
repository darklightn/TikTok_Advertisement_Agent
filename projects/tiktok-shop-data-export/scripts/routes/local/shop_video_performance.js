'use strict';

const path = require('path');
const fs = require('fs');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { getPath, json, without, writeArtifact } = require('../../common/shop-api-v3');

const REPORT_ID = 'shop_video_performance';
function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function digits(value) { return /^\d+$/u.test(String(value || '')); }
function endpoint(value) { const candidate=String(value||''); return /^\/[a-z0-9_/-]+$/u.test(candidate)&&!candidate.includes('//')&&!candidate.includes('..'); }
function fieldPath(value) { return Array.isArray(value)&&value.length>0&&value.every((part)=>text(part)||Number.isInteger(part)); }
function httpsOrigin(value) { try { const url=new URL(value); return url.protocol==='https:'&&url.origin===value; } catch { return false; } }
function activePage(page,origin) { try { const url=new URL(page.url()); return url.origin===origin&&!/(?:login|signin|passport)(?:\/|$)/iu.test(url.pathname); } catch { return false; } }
function fields(value,names) { return object(value)&&names.every((name)=>text(value[name]))&&new Set(names.map((name)=>value[name])).size===names.length; }
function addDay(value) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); }
function row(record, contract) { return [String(record.video_id), json(record[contract.record_meta_field]), json(without(record, [contract.record_meta_field, 'video_id']))]; }

function validateSpec(spec,providerSpec,options={}) {
  try { validateReportSpec(spec,options); } catch { fail('shop_video_spec_invalid'); }
  const contract=providerSpec?.api_contract;const shape=contract?.request_shape;const search=contract?.search_params;
  if(spec?.report_id!==REPORT_ID||!Array.isArray(spec.headers)||spec.headers.length!==3||!Array.isArray(spec.required_key_columns)||spec.required_key_columns.length!==1||!spec.headers.includes(spec.required_key_columns[0])
    ||spec.no_data_rule!=='official_api_zero_total'||spec.providers?.local!==providerSpec||providerSpec?.transport!=='seller_page_post'||!httpsOrigin(providerSpec?.response_origin)
    ||!object(contract)||!endpoint(contract.endpoint_path)||!Number.isInteger(contract.page_size)||contract.page_size<1||!Number.isInteger(contract.timezone_offset_seconds)
    ||!object(contract.filter)||!Array.isArray(contract.rules)||!Array.isArray(contract.stats_types)||!contract.stats_types.length||contract.date_end!=='requested_end_plus_one_day'
    ||!fields(shape,['root','params','time','start','end','timezone','granularity_field','scenario_field','filter','list_control','rules','pagination','size','page','stats_types','version_field'])
    ||!['granularity','scenario','version'].every((key)=>['string','number','boolean'].includes(typeof shape?.[key]))
    ||!fields(contract.timed_fields,['start','end'])||!fields(contract.pagination_fields,['total','page_count'])||!text(contract.identity_field)||!text(contract.record_meta_field)
    ||!fieldPath(contract.record_path)||!fieldPath(contract.record_key_path)||!fieldPath(contract.pagination_path)||!object(search)
    ||!Array.isArray(search.seller_query_names)||!search.seller_query_names.length||search.seller_query_names.some((name)=>!text(name))||new Set(search.seller_query_names).size!==search.seller_query_names.length
    ||Object.entries(search).some(([key,value])=>key!=='seller_query_names'&&!['string','number','boolean'].includes(typeof value))
    ||!Number.isInteger(contract.request_timeout_ms)||contract.request_timeout_ms<1||!Number.isInteger(contract.max_pages)||contract.max_pages<1)fail('shop_video_spec_invalid');
  return spec;
}
function payload(providerSpec,input,pageNumber) {
  const contract=providerSpec.api_contract;const shape=contract.request_shape;
  return { [shape.root]:{ [shape.params]:[{ [shape.time]:{ [shape.start]:input.startDate,[shape.end]:addDay(input.endDate),[shape.timezone]:contract.timezone_offset_seconds,[shape.granularity_field]:shape.granularity,[shape.scenario_field]:shape.scenario },[shape.filter]:structuredClone(contract.filter),[shape.list_control]:{ [shape.rules]:structuredClone(contract.rules),[shape.pagination]:{ [shape.size]:contract.page_size,[shape.page]:pageNumber } },[shape.stats_types]:structuredClone(contract.stats_types) }] },[shape.version_field]:shape.version };
}
function assertSession(live) { if(!live.browser?.isConnected?.())fail('browser_disconnected');if(!live.context||!live.browser.contexts?.().includes(live.context))fail('browser_context_missing');if(!live.context.pages().includes(live.page))fail('seller_page_missing');if(!activePage(live.page,live.origin))fail('seller_origin_mismatch'); }
function assertFailureSession(input,dependencies) { if(!dependencies.browser?.isConnected?.())fail('browser_disconnected');if(!dependencies.browserContext||!dependencies.browser.contexts?.().includes(dependencies.browserContext))fail('browser_context_missing');let origin;try{origin=new URL(input?.b?.seller_page_url).origin;}catch{return;}const pages=dependencies.browserContext.pages?.()||[];if(pages.some((page)=>activePage(page,origin)))return;if(pages.some((page)=>{try{const url=new URL(page.url());return url.origin===origin&&/(?:login|signin|passport)(?:\/|$)/iu.test(url.pathname);}catch{return false;}}))fail('seller_login_page');fail('seller_origin_mismatch'); }
async function post(live,providerSpec,body) {
  assertSession(live);const contract=providerSpec.api_contract;const target=new URL(contract.endpoint_path,providerSpec.response_origin);const{seller_query_names:sellerNames,...constants}=contract.search_params;
  for(const[key,value]of Object.entries(constants))target.searchParams.set(key,String(value));for(const name of sellerNames)target.searchParams.set(name,live.sellerId);
  let response;try{response=await live.page.request.fetch(target.href,{method:'POST',headers:{'content-type':'application/json'},data:body,timeout:contract.request_timeout_ms,failOnStatusCode:false});}catch{assertSession(live);fail('shop_video_transport_error');}
  assertSession(live);if([401,403].includes(response.status()))fail('transport_login_required');if(response.status()!==200)fail('shop_video_api_error');let final;try{final=new URL(response.url());}catch{fail('shop_video_api_error');}
  if(final.origin!==providerSpec.response_origin||final.pathname!==contract.endpoint_path)fail('seller_origin_mismatch');if(sellerNames.some((name)=>final.searchParams.get(name)!==live.sellerId))fail('provider_binding_invalid');
  let bodyValue;try{bodyValue=JSON.parse((await response.body()).toString('utf8'));}catch{fail('shop_video_shape_mismatch');}if(!object(bodyValue)||bodyValue.code!==0)fail('shop_video_api_error');return bodyValue;
}
async function runInner(input,dependencies={}) {
  if(input?.shop?.provider_id!=='local')fail('report_provider_unsupported');validateSpec(input?.reportSpec,input?.providerSpec,{skillRoot:dependencies.skillRoot});
  if(!object(input.b)||!object(input.shop)||!digits(input.shop.seller_id)||!dependencies.browser||!dependencies.browserContext)fail('shop_video_input_invalid');const outputDir=path.resolve(String(input.outputDir||''));const outputStat=fs.statSync(outputDir,{throwIfNoEntry:false});if(outputStat&&(!outputStat.isDirectory()||fs.readdirSync(outputDir).length))fail('output_directory_invalid');
  let origin;try{origin=new URL(input.b.seller_page_url).origin;}catch{fail('provider_binding_invalid');}if(origin!==input.providerSpec.response_origin)fail('provider_binding_invalid');const page=dependencies.browserContext.pages().find((candidate)=>activePage(candidate,origin));if(!page)fail('seller_page_missing');
  const live={browser:dependencies.browser,context:dependencies.browserContext,page,origin,sellerId:String(input.shop.seller_id)};const contract=input.providerSpec.api_contract;const records=[];const ids=new Set();let total=null;let totalPages=null;
  for(let pageNumber=0;pageNumber<contract.max_pages;pageNumber+=1){const body=await post(live,input.providerSpec,payload(input.providerSpec,input,pageNumber));const timed=getPath(body,contract.record_path.slice(0,-1));const pagination=getPath(body,contract.pagination_path);const observedTotal=pagination?.[contract.pagination_fields.total];const observedPages=pagination?.[contract.pagination_fields.page_count];
    if(String(timed?.[contract.timed_fields.start]||'').slice(0,10)!==input.startDate||String(timed?.[contract.timed_fields.end]||'').slice(0,10)!==addDay(input.endDate))fail('shop_video_date_mismatch');if(!Number.isInteger(observedTotal)||observedTotal<0||!Number.isInteger(observedPages)||observedPages<0)fail('shop_video_shape_mismatch');
    const pageRows=getPath(body,contract.record_path)??(observedTotal===0?[]:null);if(!Array.isArray(pageRows))fail('shop_video_shape_mismatch');if(total===null){total=observedTotal;totalPages=observedPages;}if(total!==observedTotal||totalPages!==observedPages||(total===0&&totalPages!==0)||(total>0&&(totalPages<1||totalPages>contract.max_pages)))fail('shop_video_pagination_incomplete');
    for(const record of pageRows){const id=String(getPath(record,contract.record_key_path)||'');if(String(record?.[contract.identity_field]||'')!==live.sellerId)fail('shop_video_identity_mismatch');if(!id||ids.has(id))fail('shop_video_pagination_incomplete');ids.add(id);records.push({...record,video_id:id});}if(pageNumber+1>=Math.max(1,totalPages))break;
  }
  if(records.length!==total)fail('shop_video_pagination_incomplete');const rows=records.map((record)=>row(record,contract));const artifact=writeArtifact(input,{logical_table:'video_records',headers:input.reportSpec.headers},rows,rows.length?'success':'no_data',{no_data_evidence:rows.length?undefined:input.reportSpec.no_data_rule});const{logical_table:_logicalTable,...single}=artifact;return{...single,report_id:REPORT_ID,shop_id:live.sellerId,seller_id:live.sellerId,provider_id:'local'};
}
async function run(input,dependencies={}) { try{return await runInner(input,dependencies);}catch(error){if(dependencies.browser)assertFailureSession(input,dependencies);throw error;} }

module.exports={payload,run,validateSpec};
