'use strict';
// Native scheduled maintenance only. No models/credentials/SDK are loaded on import.
const { createHash }=require('node:crypto');
const C=require('../lib/searchConsoleAnalyticsContract');
const Operator=require('../scripts/search_console_analytics.operator');
const TYPE='search_console_retention';
const FLAGS=['SC_ANALYTICS_RETENTION_WORKER_ENABLED','SC_ANALYTICS_READ_ENABLED','SC_ANALYTICS_WRITE_ENABLED','SC_ANALYTICS_ARCHIVE_ENABLED','SC_ANALYTICS_PURGE_ENABLED','SC_ANALYTICS_LEGACY_DETAIL_CUT_ENABLED'];
const CHUNK_SIZE=1000,MAX_CHUNKS=25,CONTINUATION_MS=5000,MAX_RUNTIME_MS=180000;
const canonical=x=>JSON.stringify(x,(_k,v)=>v&&Object.getPrototypeOf(v)===Object.prototype?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=x=>createHash('sha256').update(canonical(x)).digest('hex');
const fail=c=>{throw Object.assign(Error(c),{code:c});};
const need=(v,c)=>{if(!v)fail(c);};
const enabled=env=>FLAGS.every(k=>env?.[k]==='true');
const safe=e=>/^[a-zA-Z0-9_]{1,100}$/.test(e?.code||'')?e.code:'sc_retention_failed';
const integer=v=>{need(/^(0|[1-9][0-9]{0,19})$/.test(String(v)),'sc_retention_invalid_count');return BigInt(v);};
const clone=x=>JSON.parse(JSON.stringify(x));
function scopesFrom(mappings){need(Array.isArray(mappings)&&mappings.length<=1000,'sc_retention_inventory_bound');const groups=new Map(),seen=new Set();for(const m of mappings){need(m&&Number.isSafeInteger(Number(m.id))&&Number(m.id)>0&&Number.isSafeInteger(Number(m.clinicaId))&&Number(m.clinicaId)>0&&Number.isSafeInteger(Number(m.googleConnectionId))&&Number(m.googleConnectionId)>0&&[true,1,'1'].includes(m.isActive)&&!seen.has(Number(m.id)),'sc_retention_mapping');seen.add(Number(m.id));const site=C.property(m.siteUrl).siteUrl;need(site===m.siteUrl,'sc_retention_mapping');const list=groups.get(site)||[];list.push({id:Number(m.id),clinicaId:Number(m.clinicaId),googleConnectionId:Number(m.googleConnectionId),siteUrl:site,isActive:true});groups.set(site,list);}need(groups.size<=100,'sc_retention_inventory_bound');return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([siteUrl,mappings])=>({siteUrl,mappings:mappings.sort((a,b)=>a.id-b.id)}));}
function assertMonthState(s,siteUrl,month){need(s&&s.siteUrl===siteUrl&&s.month===month,'sc_retention_month_binding');const count=integer(s.rows);if(!s.archive)return count;const a=s.archive;need(['published','purged'].includes(a.state)&&/^[a-f0-9-]{36}$/i.test(a.batchId||'')&&/^[a-f0-9]{64}$/.test(a.sourceDigest||''),'sc_retention_archive_state');const original=integer(a.sourceRows),purged=integer(a.purgedRows);need(purged<=original&&count===original-purged&&(a.state!=='purged'||count===0n),'sc_retention_counter_mismatch');return count;}
const madrid=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function maintenanceWindow(at){const parts=Object.fromEntries(madrid.formatToParts(at).map(x=>[x.type,x.value]));return Number(parts.hour)>=3&&Number(parts.hour)<6;}
function nextWindow(at){let value=Math.floor(+at/60000)*60000+60000;for(let i=0;i<2880;i++,value+=60000){const parts=Object.fromEntries(madrid.formatToParts(new Date(value)).map(x=>[x.type,x.value]));if(parts.hour==='03'&&parts.minute==='10')return new Date(value);}fail('sc_retention_clock');}

function createSearchConsoleRetention({env={},namespace,database,isGateway=false,sequelize,admission,listMappings,authorizeMapping,listMonths,inspectMonth,repositoryFactory,archiveStoreFactory,readClaim,saveProgress,now=()=>new Date(),allowWindow=maintenanceWindow}={}){
 return{async run({jobRequestId}={}){
  if(!enabled(env))return{status:'completed',skipped:true,reason:'sc_retention_disabled',processed:0};
  need(namespace==='staging'&&database==='clinicaclick'&&!isGateway,'sc_retention_runtime_forbidden');
  need([listMappings,authorizeMapping,listMonths,inspectMonth,repositoryFactory,archiveStoreFactory,readClaim,saveProgress].every(f=>typeof f==='function')&&admission?.run&&admission?.assertHeld,'sc_retention_dependencies');
  need(/^[1-9][0-9]*$/.test(String(jobRequestId)),'sc_retention_job_required');
  const claim=await readClaim(jobRequestId);need(claim?.type===TYPE&&claim.status==='running'&&claim.namespace==='staging'&&Number.isSafeInteger(claim.attempt)&&claim.attempt>0&&claim.maxAttempts===1,'sc_retention_claim');
  const started=now();need(started instanceof Date&&Number.isFinite(+started),'sc_retention_clock');
  if(!allowWindow(started))return{status:'waiting',nextAllowedAt:nextWindow(started),processed:0,reason:'sc_retention_outside_window'};
  let progress=claim.progress?clone(claim.progress):null,store;
  const remember=async value=>{progress={...value,jobRequestId:String(jobRequestId),attempt:claim.attempt,atUtc:now().toISOString()};await saveProgress(claim,progress);};
  try{const outcome=await admission.run(sequelize,async()=>{
   const at=now(),cutoff=C.cutoff(at),scopes=scopesFrom(await listMappings()),inventoryDigest=digest(scopes),bySite=new Map(scopes.map(s=>[s.siteUrl,s]));
   const fast=()=>{need(enabled(env),'sc_retention_disabled');const elapsed=+now()-+started;need(elapsed>=0&&elapsed<MAX_RUNTIME_MS,'sc_retention_deadline');};
   let current=null;
   const validate=async()=>{fast();await admission.assertHeld();const fresh=scopesFrom(await listMappings());need(digest(fresh)===inventoryDigest,'sc_retention_inventory_changed');for(const mapping of current?.mappings||[]){need(await authorizeMapping(mapping),'sc_retention_scope_forbidden');}fast();return true;};
   const units=await listMonths(scopes,cutoff);need(Array.isArray(units)&&units.length<=3600&&new Set(units.map(x=>x.siteUrl+'|'+x.month)).size===units.length,'sc_retention_month_inventory');
   const blocked=[];let selected,state;
   for(const unit of [...units].sort((a,b)=>a.month.localeCompare(b.month)||a.siteUrl.localeCompare(b.siteUrl))){need(bySite.has(unit.siteUrl),'sc_retention_scope_forbidden');const bounds=C.monthRange(unit.month);need(bounds.endDate<cutoff,'sc_retention_not_old');current=bySite.get(unit.siteUrl);await validate();const observed=await inspectMonth(unit.siteUrl,unit.month);const rows=assertMonthState(observed,unit.siteUrl,unit.month);if(observed.archive?.state==='purged'){need(rows===0n,'sc_retention_counter_mismatch');continue;}if(!observed.archive&&Number(observed.coverageDays)!==Number(bounds.endDate.slice(-2))){blocked.push({siteHash:C.property(unit.siteUrl).siteHash,month:unit.month,reason:'incomplete_recorded_calendar_coverage',retained:true});continue;}selected=unit;state=observed;break;}
   if(!selected)return{status:'completed',processed:0,eligibleWorkRemaining:false,retainedPartialMonths:blocked,googleHistoryInvented:false,progress};
   current=bySite.get(selected.siteUrl);await validate();
   await remember({schema:'clinicaclick-sc-retention-progress/1',siteHash:C.property(selected.siteUrl).siteHash,siteUrl:selected.siteUrl,month:selected.month,phase:'SQL_STATE_OBSERVED',sourceRows:state.archive?.sourceRows??null,purgedRows:state.archive?.purgedRows??null,currentRows:String(state.rows),previousArchiveKey:progress?.archiveKey||null});
   store=await archiveStoreFactory({validate,onObservation:async observation=>{await remember({...progress,lastObject:observation});}});
   const archiveStore={independent:true,read:r=>store.read(r),put:async args=>{
    await validate();await remember({...progress,phase:'ARCHIVE_PUT_INTENT',archiveKey:args.key});let receipt;
    try{receipt=await store.put(args);progress={...progress,phase:'ARCHIVE_PUT_ACK',archiveReceipt:receipt};await remember(progress);return receipt;}
    catch(e){progress={...progress,phase:receipt?'ARCHIVE_PUT_ACK_LOCAL_FAILURE':'ARCHIVE_PUT_UNCERTAIN',archiveReceipt:receipt||null};throw e;}
   }};
   const repository=await repositoryFactory(validate);
   const wrapped={archiveMonth:async args=>{await validate();const result=await repository.archiveMonth(args);const observed=await inspectMonth(selected.siteUrl,selected.month);assertMonthState(observed,selected.siteUrl,selected.month);need(observed.archive&&result.published===true&&(!result.batchId||result.batchId===observed.archive.batchId),'sc_retention_publication_unproven');state=observed;await remember({...progress,phase:'ARCHIVE_PUBLISHED_SQL_OBSERVED',batchId:state.archive.batchId,archiveReceipt:state.archive.receipt,sourceRows:String(state.archive.sourceRows),purgedRows:String(state.archive.purgedRows),currentRows:String(state.rows)});return result;},
    purgeArchivedMonth:async args=>{await validate();const before=await inspectMonth(selected.siteUrl,selected.month);const beforeRows=assertMonthState(before,selected.siteUrl,selected.month);need(before.archive,'sc_retention_archive_missing');await remember({...progress,phase:'PURGE_INTENT',batchId:before.archive.batchId,currentRows:String(before.rows),purgedRows:String(before.archive.purgedRows)});const result=await repository.purgeArchivedMonth(args);await validate();const after=await inspectMonth(selected.siteUrl,selected.month),afterRows=assertMonthState(after,selected.siteUrl,selected.month);need(after.archive?.batchId===before.archive.batchId&&Number.isSafeInteger(result.removed)&&result.removed>=0&&result.removed<=CHUNK_SIZE*MAX_CHUNKS&&beforeRows-afterRows===BigInt(result.removed)&&integer(after.archive.purgedRows)-integer(before.archive.purgedRows)===BigInt(result.removed)&&result.done===(afterRows===0n),'sc_retention_purge_ack_mismatch');need(result.done||result.removed>0,'sc_retention_no_progress');state=after;await remember({...progress,phase:'PURGE_ACK_SQL_OBSERVED',removed:result.removed,currentRows:String(after.rows),purgedRows:String(after.archive.purgedRows),done:result.done});return result;}};
   const result=await Operator.rollupAndPurge({repository:wrapped,siteUrl:selected.siteUrl,month:selected.month,archiveStore,validate,purge:true,chunkSize:CHUNK_SIZE,maxChunks:MAX_CHUNKS});
   await validate();return{status:'waiting',backoffMs:CONTINUATION_MS,processed:result.purge.removed,continuationKnownAck:true,progress,retainedPartialMonths:blocked,eligibleWorkRemaining:true};
  });return outcome?.status==='waiting'&&progress&&!outcome.progress?{...outcome,progress}:outcome;}catch(error){const code=safe(error);if(progress){progress={...progress,phase:progress.phase==='PURGE_INTENT'?'PURGE_RECONCILIATION_REQUIRED':progress.phase,errorCode:code,retry:false};try{await remember(progress);}catch{}}return{status:'failed',retryable:false,error:Object.assign(Error(code),{code}),error_message:code,processed:0,progress};}
  finally{try{store?.close?.();}catch{}}
 }};
}

function createSqlRetentionInspector(sequelize){
 const query=async(sql,replacements={})=>(await sequelize.query(sql,{replacements,logging:false}))[0];
 async function property(siteUrl){const parsed=C.property(siteUrl),rows=await query('SELECT id,site_url FROM ScAnalyticsProperties WHERE site_hash=UNHEX(:hash)',{hash:parsed.siteHash});need(rows.length<=1&&(!rows.length||rows[0].site_url===parsed.siteUrl),'sc_retention_property');return rows[0]||null;}
 return{async listMonths(scopes,cutoff){const out=[];for(const scope of scopes){const p=await property(scope.siteUrl);if(!p)continue;const rows=await query("SELECT month FROM (SELECT DATE_FORMAT(c.date,'%Y-%m') AS month FROM ScAnalyticsCoverageDaily c WHERE c.property_id=:id AND c.date< :cutoff AND NOT EXISTS(SELECT 1 FROM ScAnalyticsArchiveBatches a WHERE a.property_id=c.property_id AND a.month=DATE_FORMAT(c.date,'%Y-%m-01') AND a.state='purged') GROUP BY DATE_FORMAT(c.date,'%Y-%m') UNION SELECT DATE_FORMAT(d.date,'%Y-%m') AS month FROM ScAnalyticsDaily d WHERE d.property_id=:id AND d.date< :cutoff GROUP BY DATE_FORMAT(d.date,'%Y-%m') UNION SELECT DATE_FORMAT(month,'%Y-%m') AS month FROM ScAnalyticsArchiveBatches WHERE property_id=:id AND month< :cutoff AND state<>'purged') x ORDER BY month LIMIT 37",{id:p.id,cutoff});need(rows.length<=36,'sc_retention_month_inventory');out.push(...rows.map(r=>({siteUrl:scope.siteUrl,month:r.month})));}return out;},
 async inspectMonth(siteUrl,month){const p=await property(siteUrl);need(p,'sc_retention_property');const bounds=C.monthRange(month),params={id:p.id,start:bounds.startDate,end:bounds.endDate,month:bounds.startDate},rows=await query('SELECT CAST(COUNT(*) AS CHAR) AS n FROM ScAnalyticsDaily WHERE property_id=:id AND date BETWEEN :start AND :end',params),coverage=await query('SELECT COUNT(*) AS n FROM ScAnalyticsCoverageDaily WHERE property_id=:id AND date BETWEEN :start AND :end AND detail_complete=1',params),archive=await query('SELECT batch_id,state,CAST(source_rows AS CHAR) AS source_rows,CAST(purged_rows AS CHAR) AS purged_rows,HEX(source_digest) AS source_digest,archive_receipt FROM ScAnalyticsArchiveBatches WHERE property_id=:id AND month=:month',params);need(rows.length===1&&coverage.length===1&&archive.length<=1,'sc_retention_inspection');const a=archive[0];return{siteUrl,month,propertyId:String(p.id),rows:String(rows[0].n),coverageDays:Number(coverage[0].n),archive:a?{batchId:a.batch_id,state:a.state,sourceRows:String(a.source_rows),purgedRows:String(a.purged_rows),sourceDigest:String(a.source_digest).toLowerCase(),receipt:typeof a.archive_receipt==='string'?JSON.parse(a.archive_receipt):a.archive_receipt}:null};}};
}
function guardedSql(sequelize,validate){return{query:sequelize.query.bind(sequelize),transaction:work=>sequelize.transaction(async transaction=>{const result=await work(transaction);await validate();return result;})};}
async function runJob(payload={}){
 const env=process.env;if(!enabled(env))return{status:'completed',skipped:true,reason:'sc_retention_disabled',processed:0};
 const models=require('../../models'),sequelize=models.sequelize,requests=require('./jobRequests.service'),namespace=requests.getCurrentRuntimeNamespace();
 const inspector=createSqlRetentionInspector(sequelize),admission=require('../lib/searchConsoleIngestionAdmission').application,broker=require('./searchConsoleBroker.service');
 let claim;
 const service=createSearchConsoleRetention({env,namespace,database:sequelize.config.database,isGateway:require('../lib/gatewayJobOwnership').isGatewayRuntime(env),sequelize,admission,
  listMappings:()=>models.ClinicWebAsset.findAll({attributes:['id','clinicaId','googleConnectionId','siteUrl','isActive'],where:{isActive:true},limit:1001,raw:true,logging:false}),authorizeMapping:m=>broker.prepare(m),...inspector,
  repositoryFactory:validate=>require('./searchConsoleAnalytics.service').createSearchConsoleAnalytics({sequelize:guardedSql(sequelize,validate),env}),
  archiveStoreFactory:options=>require('../lib/searchConsoleArchiveRuntime').createRuntimeArchiveStore({...options,expectedWrapperSha256:env.SC_ANALYTICS_ARCHIVE_CREDENTIALS_SHA256}),
  readClaim:async id=>{const row=await models.JobRequest.findByPk(id,{attributes:['id','type','status','attempts','max_attempts','payload','result_summary'],raw:true,logging:false});need(row,'sc_retention_claim');claim={id:row.id,type:row.type,status:row.status,attempt:Number(row.attempts),maxAttempts:Number(row.max_attempts),namespace:row.payload?.__runtime_namespace,progress:row.result_summary?.progress||null};return claim;},
  saveProgress:async(c,progress)=>{need(c===claim&&progress.jobRequestId===String(c.id),'sc_retention_claim');const [changed]=await models.JobRequest.update({result_summary:{progress}},{where:{id:c.id,type:TYPE,status:'running',attempts:c.attempt},logging:false});need(changed===1,'sc_retention_claim_changed');},
 });return service.run({jobRequestId:payload.jobRequestId});
}
module.exports={TYPE,FLAGS,CHUNK_SIZE,MAX_CHUNKS,CONTINUATION_MS,MAX_RUNTIME_MS,enabled,scopesFrom,assertMonthState,maintenanceWindow,nextWindow,createSearchConsoleRetention,createSqlRetentionInspector,guardedSql,runJob};
