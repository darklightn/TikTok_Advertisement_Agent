'use strict';

const fs = require('fs');
const path = require('path');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { getPath } = require('../../common/shop-api-v3');
const { dismissBlockingOverlay, validateBlockingOverlay } = require('../../common/ui-blocking-overlay');
const { inspectWorkbook, sha256, validDate } = require('./gmvmax_campaign_overview_v3');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function digits(value) { return /^\d+$/u.test(String(value || '')); }
function endpoint(value) { return text(value)&&value.startsWith('/')&&!value.includes('//')&&!value.includes('..'); }
function pathValue(value) { return Array.isArray(value)&&value.length>0&&value.every((part)=>text(part)||Number.isInteger(part)); }
function active(page, origin) { try { const url=new URL(page.url());return url.origin===origin&&!/(?:login|signin)(?:\/|$)/iu.test(url.pathname); } catch { return false; } }
async function visible(locator) { const result=[];for(let index=0;index<await locator.count();index+=1)if(await locator.nth(index).isVisible())result.push(locator.nth(index));return result; }
async function poll(check, timeout, code, delay) { const end=Date.now()+timeout;do{const result=await check();if(result)return result;if(Date.now()>=end)break;await delay(50);}while(true);fail(code); }

function validateSpec(spec, providerSpec, providerId, options = {}) {
  try { validateReportSpec(spec, options); } catch { fail('campaign_overview_report_spec_invalid'); }
  const rules=providerSpec?.official_validation;
  const fields=['entry_path','date_root_selector','date_input_selector','export_selector'];const q=rules?.query_parameters,k=rules?.query_constants,r=rules?.response_paths,statuses=rules?.task_statuses;
  if(spec?.report_id!=='gmvmax_campaign_overview'||spec.providers?.[providerId]!==providerSpec||providerSpec?.transport!=='seller_ui_direct_download'
    ||!object(rules)||fields.some((field)=>!text(rules[field]))||!validateBlockingOverlay(rules.blocking_overlay)||!endpoint(rules.create_endpoint)||!endpoint(rules.task_query_endpoint)
    ||!object(q)||!text(q.seller_id)||!text(q.advertiser_id)||q.seller_id===q.advertiser_id||!object(k)||!text(k.locale)||!text(k.language)||!object(r)||!['create_task_id','task_status','task_url'].every((field)=>pathValue(r[field]))
    ||!object(statuses)||!['pending','success','failed'].every((field)=>Array.isArray(statuses[field])&&statuses[field].length>0&&statuses[field].every(text))||!text(rules.task_query_request?.task_id_field)
    ||![rules.navigation_timeout_ms,rules.picker_timeout_ms,rules.request_timeout_ms,rules.download_timeout_ms,rules.poll_interval_ms,rules.max_polls].every((value)=>Number.isInteger(value)&&value>0)
    ||!Number.isInteger(rules.data_start_row)||rules.data_start_row<1)fail('campaign_overview_report_spec_invalid');
  let origin;try{origin=new URL(providerSpec.response_origin);}catch{fail('campaign_overview_report_spec_invalid');}
  if(origin.protocol!=='https:'||origin.origin!==providerSpec.response_origin||!rules.entry_path.startsWith('/'))fail('campaign_overview_report_spec_invalid');
  return spec;
}

function session(context) {
  if(!context.browser?.isConnected?.())fail('browser_disconnected');
  if(!context.browserContext||!context.browser.contexts?.().includes(context.browserContext))fail('browser_context_missing');
  if(!context.browserContext.pages?.().includes(context.page))fail('seller_page_missing');
  if(!active(context.page,context.origin))fail('seller_origin_mismatch');
}
async function dateControl(page, rules, delay) {
  return poll(async()=>{const roots=await visible(page.locator(rules.date_root_selector));if(roots.length!==1)return null;const inputs=await visible(roots[0].locator(rules.date_input_selector));return inputs.length===2?{root:roots[0],inputs}:null;},rules.picker_timeout_ms,'campaign_overview_date_picker_not_ready',delay);
}
async function applyDateRange(page, start, end, rules, delay) {
  let current=await dateControl(page,rules,delay);await current.inputs[0].click();await current.inputs[0].fill(start);await current.inputs[0].press('Tab');current=await dateControl(page,rules,delay);await current.inputs[1].click();await current.inputs[1].fill(end);await current.inputs[1].press('Enter');
  await poll(async()=>{const current=await dateControl(page,rules,delay);const values=await Promise.all(current.inputs.map((input)=>input.inputValue()));return values[0]===start&&values[1]===end?true:null;},rules.picker_timeout_ms,'campaign_overview_date_not_applied',delay);
}
async function setupCapture(context, captureDir) {
  let cdp;try{cdp=await context.browserContext.newCDPSession(context.page);await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:captureDir,eventsEnabled:true});return cdp;}catch{if(cdp?.detach)await cdp.detach().catch(()=>{});fail('official_download_capture_setup_failed');}
}
async function captureDownload(captureDir, timeout, delay) {
  const deadline=Date.now()+timeout;let stable=null;
  while(Date.now()<deadline){
    const names=fs.readdirSync(captureDir);if(names.some((name)=>name.endsWith('.crdownload')))stable=null;
    else{
      const files=names.filter((name)=>name.toLowerCase().endsWith('.xlsx'));
      if(files.length>1)fail('official_download_ambiguous');
      if(files.length===1){const file=path.join(captureDir,files[0]),size=fs.statSync(file).size;if(size>0&&stable?.file===file&&stable.size===size)return fs.readFileSync(file);stable={file,size};}
    }
    await delay(100);
  }
  fail('official_download_timeout');
}

function requestUrl(origin, endpointPath, rules, input) { const target=new URL(endpointPath,origin);target.searchParams.set(rules.query_parameters.seller_id,String(input.shop.seller_id));target.searchParams.set(rules.query_parameters.advertiser_id,String(input.advertiserId));for(const[key,value]of Object.entries(rules.query_constants))target.searchParams.set(key,String(value));return target; }
function responseStatus(response){return typeof response?.status==='function'?response.status():response?.status;}
function responseUrl(response){return typeof response?.url==='function'?response.url():response?.url;}
async function responseBuffer(response){if(typeof response?.body==='function')return response.body();if(Buffer.isBuffer(response?.body))return response.body;fail('transport_response_invalid');}
function validateResponseUrl(response,target){let final;try{final=new URL(responseUrl(response));}catch{fail('official_task_response_invalid');}if(final.origin!==target.origin||final.pathname!==target.pathname)fail('seller_origin_mismatch');for(const[key,value]of target.searchParams)if(final.searchParams.get(key)!==value)fail('provider_binding_invalid');}
async function responseJson(response,target,code){if([401,403].includes(responseStatus(response)))fail('transport_login_required');if(responseStatus(response)!==200)fail(code);validateResponseUrl(response,target);let value;try{value=JSON.parse((await responseBuffer(response)).toString('utf8'));}catch{fail(code);}if(!object(value)||value.code!==0)fail(code);return value;}
async function taskDownload(context,input,rules,createdResponse,delay){const createTarget=requestUrl(context.origin,rules.create_endpoint,rules,input),created=await responseJson(createdResponse,createTarget,'official_task_create_result_unknown'),taskId=String(getPath(created,rules.response_paths.create_task_id)||'');if(!digits(taskId))fail('official_task_id_invalid');const queryTarget=requestUrl(context.origin,rules.task_query_endpoint,rules,input),field=rules.task_query_request.task_id_field;let signedUrl=null;for(let attempt=0;attempt<rules.max_polls;attempt+=1){session(context);let response;try{response=await context.page.request.fetch(queryTarget.href,{method:'POST',headers:{'content-type':'application/json'},data:{[field]:taskId},timeout:rules.request_timeout_ms,failOnStatusCode:false});}catch{session(context);fail('official_task_query_failed');}session(context);const queried=await responseJson(response,queryTarget,'official_task_query_failed');if(String(queried[field]||'')!==taskId)fail('official_task_binding_mismatch');const status=String(getPath(queried,rules.response_paths.task_status)||'');if(rules.task_statuses.failed.includes(status))fail('official_task_failed');if(rules.task_statuses.success.includes(status)){signedUrl=getPath(queried,rules.response_paths.task_url);if(!text(signedUrl))fail('official_task_url_missing');break;}if(!rules.task_statuses.pending.includes(status))fail('official_task_status_invalid');if(attempt+1<rules.max_polls)await delay(rules.poll_interval_ms);}if(!signedUrl)fail('official_task_timeout');let target;try{target=new URL(signedUrl);}catch{fail('official_download_url_invalid');}if(target.protocol!=='https:'||!target.hostname||target.username||target.password||/(?:login|signin)(?:\/|$)/iu.test(target.pathname))fail('official_download_url_invalid');let downloaded;try{downloaded=await context.browserContext.request.get(target.href,{timeout:rules.download_timeout_ms,failOnStatusCode:false});}catch{fail('official_download_failed');}if([401,403].includes(responseStatus(downloaded)))fail('transport_login_required');if(responseStatus(downloaded)!==200)fail('official_download_failed');const buffer=await responseBuffer(downloaded),headers=typeof downloaded.headers==='function'?downloaded.headers():downloaded.headers||{},contentType=String(headers['content-type']||headers['Content-Type']||'').toLowerCase();if(contentType.includes('text/html')||buffer[0]!==0x50||buffer[1]!==0x4b)fail('official_download_invalid');return buffer;}

function createRunner(providerId) {
  async function run(input, dependencies = {}) {
    if(input?.shop?.provider_id!==providerId)fail('report_provider_unsupported');
    validateSpec(input?.reportSpec,input?.providerSpec,providerId,{skillRoot:dependencies.skillRoot});
    if(!object(input.a)||!object(input.b)||!object(input.shop)||!digits(input.shop.seller_id)||!digits(input.advertiserId)||!digits(input.businessCenterId)
      ||!dependencies.browser||!dependencies.browserContext||!validDate(input.startDate)||!validDate(input.endDate)||input.startDate>input.endDate)fail('campaign_overview_input_invalid');
    if(input.campaignId||input.campaignName||input.campaignRef)fail('campaign_selector_not_supported');
    const outputDir=path.resolve(String(input.outputDir||''));if(!fs.statSync(outputDir,{throwIfNoEntry:false})?.isDirectory()||fs.readdirSync(outputDir).length)fail('output_directory_invalid');
    const origin=input.providerSpec.response_origin;let sellerOrigin;try{sellerOrigin=new URL(input.b.seller_page_url).origin;}catch{fail('provider_binding_invalid');}if(sellerOrigin!==origin)fail('provider_binding_invalid');
    const page=dependencies.browserContext.pages().find((candidate)=>active(candidate,origin));if(!page)fail('seller_page_missing');const context={browser:dependencies.browser,browserContext:dependencies.browserContext,page,origin};session(context);
    const rules=input.providerSpec.official_validation;const delay=dependencies.delay||((ms)=>new Promise((resolve)=>setTimeout(resolve,ms)));const dismiss=dependencies.dismissBlockingOverlay||dismissBlockingOverlay;
    await page.goto(new URL(rules.entry_path,origin).href,{waitUntil:'domcontentloaded',timeout:rules.navigation_timeout_ms});session(context);
    await dismiss(page,rules.blocking_overlay);
    await (dependencies.applyDateRange||applyDateRange)(page,input.startDate,input.endDate,rules,delay);
    await dismiss(page,rules.blocking_overlay);
    const buttons=await visible(page.locator(rules.export_selector));if(buttons.length!==1||!await buttons[0].isEnabled())fail('campaign_overview_export_control_not_ready');
    let buffer;if(dependencies.captureDownload){const captureDir=path.join(outputDir,'capture');fs.mkdirSync(captureDir);try{await buttons[0].click();buffer=await dependencies.captureDownload(captureDir,rules.download_timeout_ms,delay);}finally{for(const name of fs.readdirSync(captureDir))fs.unlinkSync(path.join(captureDir,name));fs.rmdirSync(captureDir);}}else{const createTarget=requestUrl(origin,rules.create_endpoint,rules,input),created=page.waitForResponse((response)=>{try{const url=new URL(response.url()),request=response.request(),body=request.postDataJSON();return url.origin===createTarget.origin&&url.pathname===createTarget.pathname&&request.method()==='POST'&&body?.action===rules.create_request.action;}catch{return false;}},{timeout:rules.request_timeout_ms});await buttons[0].click();let response;try{response=await created;}catch{fail('official_task_create_result_unknown');}buffer=await taskDownload(context,input,rules,response,delay);}
    const dataRowCount=inspectWorkbook(buffer,input.reportSpec,rules);const outputFile=path.join(outputDir,'overview.xlsx');fs.writeFileSync(outputFile,buffer,{flag:'wx'});const hash=sha256(buffer);if(sha256(fs.readFileSync(outputFile))!==hash)fail('official_file_changed');
    return{schema_version:'gmvmax_campaign_overview_v3',status:'success',shop_id:String(input.shop.seller_id),seller_id:String(input.shop.seller_id),oec_seller_id:String(input.shop.seller_id),advertiser_id:String(input.advertiserId),business_center_id:String(input.businessCenterId),provider_id:providerId,start_date:input.startDate,end_date:input.endDate,output_file:outputFile,byte_length:buffer.length,sha256:hash,official_file_unchanged:true,data_row_count:dataRowCount};
  }
  return { applyDateRange, captureDownload, inspectWorkbook, run, setupCapture, taskDownload, validateSpec:(spec,providerSpec,options)=>validateSpec(spec,providerSpec,providerId,options) };
}

module.exports = { applyDateRange, captureDownload, createRunner, setupCapture, taskDownload, validateSpec };
