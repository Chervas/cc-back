'use strict';
// Synthetic phases only. Import/default CLI never opens a socket, AWS client or DB.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const H=require('./dms_pilot_b_harness.cjs'),F=require('./dms_pilot_b_fixture.cjs');
const {execFile}=require('node:child_process');
const BASE='/home/ubuntu/qa-evidence/architecture-diagnostic-20261018-c3CWBj';
const L=2048*1024,TEMPLATE_SHA='3a55e86d3f0405ec3a5bba1a0e6784b2d1307b0e20c56743e10b3363070fc4d5';
const TABLES=Object.keys(F.TABLES).sort(),CONTROLS=['awsdms_apply_exceptions','awsdms_validation_failures_v1'];
const fail=code=>{throw Object.assign(Error(code),{code});},need=(v,c)=>{if(!v)fail(c);};
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const digest=x=>sha(JSON.stringify(canonical(x)));
const q=(c,sql,values=[])=>c.query({sql,timeout:5000},values);
function cases(){const out=[];for(const operation of ['INSERT','UPDATE'])for(const encoding of ['ASCII','UTF8_multibyte'])
 for(const column of ['b_lob.document','b_lob.payload'])for(const sourceBytes of [L-1,L,L+1])out.push({operation,encoding,column,sourceBytes,rowId:1000+out.length});return out;}
async function sourceScope(source,harness=H){await harness.verifySource(source);const [rows]=await q(source.c,"SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA='cc_dms_pilot'");
 need(JSON.stringify(rows.map(x=>x.name).sort())===JSON.stringify(TABLES),'v3_source_table_scope');}
async function prepareBoundaryRows(source,{harness=H}={}){await sourceScope(source,harness);const ids=cases().map(x=>x.rowId),updates=cases().filter(x=>x.operation==='UPDATE');
 const [[existing]]=await q(source.c,'SELECT COUNT(*) n FROM `cc_dms_pilot`.`b_lob` WHERE id BETWEEN 1000 AND 1023');need(Number(existing.n)===0,'v3_boundary_preparation_not_fresh');
 await q(source.c,'START TRANSACTION');let commitRequested=false;
 try{for(const c of updates)await q(source.c,'INSERT INTO `cc_dms_pilot`.`b_lob`(id,payload,document,nullable_document,revision) VALUES(?,CAST(? AS JSON),?,NULL,0)',
  [c.rowId,JSON.stringify({synthetic:true,pilot:'V3',rowId:c.rowId}),'V3_BASELINE_'+c.rowId]);
  await sourceScope(source,harness);commitRequested=true;await q(source.c,'COMMIT');
 }catch(e){if(!commitRequested)await q(source.c,'ROLLBACK').catch(()=>{});fail(commitRequested?'v3_preparation_commit_unknown_no_retry':'v3_preparation_failed_no_retry');}
 const [rows]=await q(source.c,'SELECT id,payload,document,nullable_document,revision FROM `cc_dms_pilot`.`b_lob` WHERE id BETWEEN 1000 AND 1023 ORDER BY id');
 need(rows.length===12&&rows.every((r,i)=>Number(r.id)===updates[i].rowId&&Number(r.revision)===0),'v3_preparation_after_commit_mismatch');
 return {schema:'clinicaclick-dms-v3-boundary-preparation/1',prepared:true,baselineRows:12,insertIdsAbsent:true,syntheticOnly:true,
  sourceRunId:source.run.runId,updateRowIds:updates.map(c=>c.rowId),insertRowIds:ids.filter(x=>x<1012),baselineSha256:digest(rows),applicationTablesChanged:false};}
function textBytes(bytes,encoding,prefix=''){
 need(Number.isSafeInteger(bytes)&&bytes>=Buffer.byteLength(prefix)&&bytes<=L+1,'v3_payload_size_invalid');let remain=bytes-Buffer.byteLength(prefix);
 return prefix+(encoding==='ASCII'?'x'.repeat(remain):'🦷'.repeat(Math.floor(remain/4))+'x'.repeat(remain%4));}
function validateBinding(n,c){need(n&&c&&n.awsProfile==='clinicaclick-prov-temp'&&/^cc-mysql-v3-[0-9a-f]{8}$/.test(n.replicationInstanceIdentifier||'')
 &&n.replicationInstanceArn==='arn:aws:dms:eu-west-3:137819318729:rep:'+n.replicationInstanceIdentifier
 &&c.taskArn==='arn:aws:dms:eu-west-3:137819318729:task:'+n.replicationInstanceIdentifier+'-cdc'
 &&n.seed&&/^[a-f0-9]{32}$/.test(n.seed.runId||'')&&/^[a-f0-9]{64}$/.test(n.seed.sha256||'')
 &&n.boundaryPreparation?.prepared===true&&n.boundaryPreparation.sourceRunId===n.seed.runId
 &&n.boundaryPreparation.baselineRows===12&&n.boundaryPreparation.insertIdsAbsent===true,'v3_runner_binding_invalid');}
async function targetScope(c,n){const [[r]]=await q(c,"SELECT DATABASE() db,@@version version,@@require_secure_transport tlsRequired,@@SESSION.foreign_key_checks fk,(SELECT VARIABLE_VALUE FROM performance_schema.session_status WHERE VARIABLE_NAME='Ssl_version') tls,(SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='clinicaclick') clinical");
 need(r.db==='cc_dms_pilot'&&r.version==='8.4.11'&&Number(r.tlsRequired)===1&&Number(r.fk)===1&&/^TLSv1\.[23]$/.test(r.tls||'')&&Number(r.clinical)===0,'v3_target_metadata_invalid');
 const [[marker]]=await q(c,'SELECT run_id FROM `cc_dms_pilot`.`pilot_identity` WHERE id=1');need(marker?.run_id===n.seed.runId,'v3_target_run_mismatch');
 const [tables]=await q(c,"SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA='cc_dms_pilot'");
 need(TABLES.every(t=>tables.some(r=>r.name===t))&&tables.every(r=>TABLES.includes(r.name)||CONTROLS.includes(r.name)),'v3_target_table_scope');
 const [triggers]=await q(c,"SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='cc_dms_pilot'");
 need(JSON.stringify(triggers.map(x=>x.name).sort())===JSON.stringify(['b_guard_catalog_insert','b_guard_catalog_update']),'v3_target_trigger_scope');
 const [lob]=await q(c,"SELECT COLUMN_NAME name,IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='cc_dms_pilot' AND TABLE_NAME='b_lob' AND COLUMN_NAME IN ('payload','document')");
 need(lob.length===2&&lob.every(x=>x.nullable==='NO'),'v3_native_notnull_changed');}
async function snapshot(c){const tables=[];await q(c,'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');await q(c,'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');try{for(const table of F.EXPORT_ORDER){const cols=[...F.TABLES[table],...F.GENERATED.filter(x=>x[0]===table).map(x=>x[1])];
 const dates=new Set(['created_at','due_at','acked_at']);const select=cols.map(x=>dates.has(x)?"DATE_FORMAT(`"+x+"`,'%Y-%m-%d %H:%i:%s.%f') AS `"+x+'`':'`'+x+'`').join(',');
 const [rows]=await q(c,'SELECT '+select+' FROM `cc_dms_pilot`.`'+table+'` ORDER BY id');const text=JSON.stringify(canonical(rows));need(Buffer.byteLength(text)<=64*1024*1024,'v3_fixture_table_limit');
 tables.push({table,rows:rows.length,sha256:sha(text)});}return {tables,sha256:digest(tables)};}finally{await q(c,'ROLLBACK');}}
const same=(a,b)=>a?.sha256===b?.sha256&&a?.tables?.length===12&&b?.tables?.length===12;
function validSnapshot(s){return /^[a-f0-9]{64}$/.test(s?.sha256||'')&&Array.isArray(s.tables)&&s.tables.length===12&&s.tables.every((x,i)=>x.table===F.EXPORT_ORDER[i]&&Number.isSafeInteger(x.rows)&&x.rows>=0&&/^[a-f0-9]{64}$/.test(x.sha256||''))&&s.sha256===digest(s.tables);}
async function field(c,case_){const col=case_.column.split('.')[1];const expr=col==='payload'?'CAST(payload AS CHAR CHARACTER SET utf8mb4)':'document';
 const [rows]=await q(c,'SELECT id,revision,'+expr+' value,OCTET_LENGTH('+expr+') bytes FROM `cc_dms_pilot`.`b_lob` WHERE id=?',[case_.rowId]);
 return rows.length?{exists:true,id:Number(rows[0].id),revision:Number(rows[0].revision),bytes:Number(rows[0].bytes),sha256:sha(rows[0].value)}:{exists:false};}
async function sourceCoordinate(source){const [[r]]=await q(source.c,'SHOW MASTER STATUS');need(/^pilot-bin\.[0-9]{6}$/.test(r?.File||'')&&Number.isSafeInteger(Number(r.Position)),'v3_source_coordinate_invalid');return {file:r.File,position:Number(r.Position)};}
function awsRead(n,service,operation,args=[]){const allowed={dms:['describe-replication-instances','describe-endpoints','describe-replication-tasks','describe-table-statistics'],logs:['filter-log-events']};
 need(allowed[service]?.includes(operation),'v3_non_read_aws_forbidden');return new Promise((resolve,reject)=>execFile('aws',[service,operation,...args,...(service==='logs'?['--no-paginate']:[]),'--profile',n.awsProfile,'--region','eu-west-3','--output','json','--no-cli-pager'],
 {timeout:15000,maxBuffer:16*1024*1024,env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_PAGER:'',AWS_CLI_AUTO_PROMPT:'off'}},(error,stdout)=>{if(error)return reject(Object.assign(Error('v3_aws_read_failed'),{code:'v3_aws_read_failed'}));try{resolve(JSON.parse(stdout));}catch{reject(Object.assign(Error('v3_aws_json_invalid'),{code:'v3_aws_json_invalid'}));}}));}
async function events(read,n,c,start){const group='dms-tasks-'+n.replicationInstanceIdentifier,stream='dms-task-'+c.taskArn.split(':').pop();let token,bytes=0;const out=[];
 for(let page=0;page<20;page++){const args=['--log-group-name',group,'--log-stream-names',stream,'--start-time',String(Math.max(0,start)),'--limit','10000'];if(token)args.push('--next-token',token);
  const r=await read(n,'logs','filter-log-events',args);need(Array.isArray(r.events),'v3_logs_response_invalid');bytes+=Buffer.byteLength(JSON.stringify(r));need(bytes<=16*1024*1024,'v3_logs_total_limit');for(const e of r.events){need(typeof e.eventId==='string'&&typeof e.message==='string'&&Number.isSafeInteger(e.timestamp)&&Number.isSafeInteger(e.ingestionTime)&&e.logStreamName===stream,'v3_logs_event_scope');out.push({...e,logGroup:group});}
  if(!r.nextToken)return out;need(r.nextToken!==token,'v3_logs_pagination_stalled');token=r.nextToken;}fail('v3_logs_pagination_incomplete');}
function classifyLogEvents(rows){return rows.map(e=>({eventId:e.eventId,timestamp:e.timestamp,ingestionTime:e.ingestionTime,logGroup:e.logGroup,logStream:e.logStreamName,rawEventSha256:digest(e),message:e.message,
 kind:/\btruncat(?:ed|ion|ing)\b/i.test(e.message)?'TRUNCATION_FAILURE':/\b(access denied|authentication|secretsmanager|network|timed? ?out|connection.*(?:fail|lost)|manual.*stop)\b/i.test(e.message)?'UNRELATED_FAILURE':/\bLOB\b.*\b(?:exceed|max|limit|size)\b/i.test(e.message)?'UNREVIEWED_LOB_MESSAGE':'OTHER'}));}
async function boundedClose(work){let timer;try{await Promise.race([Promise.resolve().then(work),new Promise(r=>{timer=setTimeout(r,3000);})]);}catch{}finally{clearTimeout(timer);}}
async function closeOwned(c){if(!c)return;const core=c.connection||c,transport=core.stream;await boundedClose(()=>c.end());try{c.destroy();}catch{}try{transport?.destroy();}catch{}}
function validatePositiveReceipt(p,binding){const wanted=cases().filter(x=>x.sourceBytes<=L);need(p?.status==='POSITIVES_EQUAL'&&p.templateSha256===TEMPLATE_SHA&&p.allTwelveFullHashesEqual===true&&Array.isArray(p.cases)&&p.cases.length===16
 &&wanted.every(c=>p.cases.filter(x=>x.case&&x.binding&&digest(x.case)===digest(c)&&digest(x.binding)===digest(binding)&&x.status==='FULL_HASH_EQUAL'&&x.sourceActualBytes===c.sourceBytes&&x.targetActualBytes===c.sourceBytes&&/^[a-f0-9]{64}$/.test(x.sourceFullSha256||'')&&x.sourceFullSha256===x.targetFullSha256&&validSnapshot(x.sourceSnapshot)&&validSnapshot(x.targetSnapshot)&&same(x.sourceSnapshot,x.targetSnapshot)).length===1),'v3_reviewed_positive_receipt_required');}
function createRunner({bindings,openTargetOperator,read=awsRead,now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),emit=()=>{},harness=H}={}){
 return {async run({phase,caseId,positiveReceipt,deadlineMs=300000}={}){
  need(['snapshot','base-cdc','positives','case'].includes(phase),'v3_phase_invalid');need(Number.isInteger(deadlineMs)&&deadlineMs>=1000&&deadlineMs<=300000,'v3_phase_deadline_invalid');bindings.verifyModules();const {native:n,cdc:c,rawNative}=bindings.readCdc();validateBinding(n,c);const binding={taskArn:c.taskArn,sourceRunId:n.seed.runId,seedSha256:n.seed.sha256};
  need(sha(fs.readFileSync(path.join(__dirname,'dms-pilot-v3.cloudformation.json')))===TEMPLATE_SHA,'v3_template_changed');
  let source,target,op,writeRequested=false;const started=now(),deadline=started+deadlineMs,receipts=[];const alive=()=>need(now()<deadline,'v3_phase_deadline');
  const event=(kind,data={})=>emit({at:new Date(now()).toISOString(),kind,...data});
  async function task(){alive();const r=await read(n,'dms','describe-replication-tasks',['--filters','Name=replication-task-arn,Values='+c.taskArn]);need(r.ReplicationTasks?.length===1,'v3_task_missing');const t=r.ReplicationTasks[0];
   need(t.ReplicationTaskArn===c.taskArn&&t.ReplicationInstanceArn===n.replicationInstanceArn&&t.SourceEndpointArn===n.sourceEndpointArn&&t.TargetEndpointArn===n.targetEndpointArn,'v3_actual_task_binding');bindings.validateTaskSettings(JSON.parse(t.ReplicationTaskSettings),{native:n});return t;}
  async function health(){const t=await task();need(t.Status==='running','v3_task_not_running');const r=await read(n,'dms','describe-table-statistics',['--replication-task-arn',c.taskArn]);
   need(Array.isArray(r.TableStatistics)&&r.TableStatistics.length<=12&&new Set(r.TableStatistics.map(x=>x.TableName)).size===r.TableStatistics.length&&r.TableStatistics.every(x=>x.SchemaName==='cc_dms_pilot'&&TABLES.includes(x.TableName)&&!Number(x.ValidationFailedRecords||0)&&!Number(x.ValidationSuspendedRecords||0)&&!/error|suspend/i.test(x.TableState||'')),'v3_task_table_health');return t;}
  async function scopes(){await sourceScope(source,harness);need(source.run.runId===n.seed.runId,'v3_source_run_mismatch');await targetScope(target,n);}
  try{const rep=await read(n,'dms','describe-replication-instances',['--filters','Name=replication-instance-arn,Values='+n.replicationInstanceArn]);
   const se=await read(n,'dms','describe-endpoints',['--filters','Name=endpoint-arn,Values='+n.sourceEndpointArn]),te=await read(n,'dms','describe-endpoints',['--filters','Name=endpoint-arn,Values='+n.targetEndpointArn]);
   need(rep.ReplicationInstances?.length===1&&se.Endpoints?.length===1&&te.Endpoints?.length===1,'v3_live_resources_missing');bindings.assertActual({rep:rep.ReplicationInstances[0],source:se.Endpoints[0],target:te.Endpoints[0],task:await task()},{native:rawNative,cdc:c});
   source=await harness.openOwnedSource(n.sourceDirectory);need(source.run.runId===n.seed.runId,'v3_source_run_mismatch');
   op=await openTargetOperator({bindings});target=await op.openConnection();await q(target,'USE `cc_dms_pilot`');await scopes();
   const initialA=await snapshot(source.c),initialB=await snapshot(target);need(same(initialA,initialB),'v3_initial_twelve_hashes_differ');
   if(phase==='snapshot')return {status:'SNAPSHOT_EQUAL',syntheticOnly:true,binding:{taskArn:c.taskArn,sourceRunId:n.seed.runId,seedSha256:n.seed.sha256},tables:initialA.tables,awsWrites:false,sqlMutations:false};
   await health();await health();const prior=await events(read,n,c,0);need(prior.some(e=>/\[TASK_MANAGER\s*\]/.test(e.message)),'v3_actual_task_manager_log_required');
   if(phase==='base-cdc'){
    const [parents]=await q(source.c,'SELECT id FROM `cc_dms_pilot`.`b_parent` ORDER BY id');need(JSON.stringify(parents.map(x=>Number(x.id)))==='[1,2]','v3_base_cdc_already_attempted_no_retry');
    const stages=[];for(const name of ['during_seed_delete','after_seed_update','acknowledge_after_commit']){
     await scopes();await health();event('BASE_MUTATION_REQUESTED',{stage:name});writeRequested=true;const receipt=await harness.runMutation(source,name);let matched=false;
     while(now()<deadline){await scopes();await health();const a=await snapshot(source.c),b=await snapshot(target);if(same(a,b)){matched=true;stages.push({stage:name,source:a,target:b});break;}await wait(1000);}
     need(matched,'v3_base_cdc_did_not_converge');event('BASE_STAGE_EQUAL',{stage:name});
    }
    const finalTask=await task();return {status:'BASE_CDC_EQUAL',templateSha256:TEMPLATE_SHA,stages,allTwelveFullHashesEqual:true,recoveryCheckpoint:finalTask.RecoveryCheckpoint||null,
     checkpointProgressionProven:false,controlledResumeProven:false,writerFenceProven:false,seedInterleavingProven:false,syntheticOnly:true,pilotAccepted:false,awsWrites:false,automaticRetry:false};
   }
   let selected;if(phase==='positives')selected=cases().filter(x=>x.sourceBytes<=L);else{need(Number.isInteger(caseId)&&caseId>=0&&caseId<24,'v3_case_id_invalid');selected=[cases()[caseId]];
    if(selected[0].sourceBytes>L)validatePositiveReceipt(positiveReceipt,binding);}
   for(const test of selected){alive();await scopes();await health();const before=await field(source.c,test);need(test.operation==='INSERT'?!before.exists:before.exists&&before.revision===0,'v3_case_already_attempted_no_retry');
    const targetBefore=await snapshot(target),sourceBefore=await sourceCoordinate(source),watermark=await events(read,n,c,0),seen=new Set(watermark.map(x=>x.eventId)),caseStart=now();
    let overhead=0;if(test.column.endsWith('payload')){const [[o]]=await q(source.c,"SELECT OCTET_LENGTH(CAST(JSON_OBJECT('body','') AS CHAR CHARACTER SET utf8mb4)) n");overhead=Number(o.n);need(Number.isSafeInteger(overhead)&&overhead>0&&overhead<1000,'v3_json_overhead_invalid');}
    const prefix='V3_'+test.rowId+'_',body=textBytes(test.sourceBytes-overhead,test.encoding,prefix),value=test.column.endsWith('payload')?JSON.stringify({body}):body;
    event('DML_REQUESTED',{case:test,beforeCoordinate:sourceBefore,watermarkEventIds:watermark.map(x=>x.eventId)});writeRequested=true;
    let commitRequested=false;await q(source.c,'START TRANSACTION');
    try{let result;if(test.operation==='INSERT'){const payload=test.column.endsWith('payload')?value:JSON.stringify({synthetic:true,rowId:test.rowId});const document=test.column.endsWith('document')?value:'V3_CASE_'+test.rowId;
      [result]=await q(source.c,'INSERT INTO `cc_dms_pilot`.`b_lob`(id,payload,document,nullable_document,revision) VALUES(?,CAST(? AS JSON),?,NULL,1)',[test.rowId,payload,document]);}
     else{const col=test.column.endsWith('payload')?'payload=CAST(? AS JSON)':'document=?';[result]=await q(source.c,'UPDATE `cc_dms_pilot`.`b_lob` SET '+col+',revision=1 WHERE id=? AND revision=0',[value,test.rowId]);}
     need(Number(result.affectedRows)===1,'v3_dml_not_exactly_one_row');await sourceScope(source,harness);commitRequested=true;await q(source.c,'COMMIT');
    }catch(e){if(!commitRequested)await q(source.c,'ROLLBACK').catch(()=>{});fail(commitRequested?'v3_case_commit_unknown_no_retry':'v3_case_dml_failed_no_retry');}
    const actual=await field(source.c,test),sourceAfter=await sourceCoordinate(source);need(actual.bytes===test.sourceBytes&&actual.revision===1,'v3_actual_source_boundary_size_mismatch');
    event('DML_COMMITTED',{case:test,sourceFullSha256:actual.sha256,sourceActualBytes:actual.bytes,afterCoordinate:sourceAfter});
    let final,taskState,newEvents=[],classified=[];const observed=[];while(now()<deadline){await scopes();taskState=await task();newEvents=(await events(read,n,c,caseStart)).filter(e=>!seen.has(e.eventId));classified=classifyLogEvents(newEvents);
     for(const e of classified){event('ACTUAL_CLOUDWATCH_EVENT',e);seen.add(e.eventId);observed.push(e);}
     final=await snapshot(target);if(classified.some(e=>e.kind==='TRUNCATION_FAILURE'))fail('v3_actual_lob_truncation_detected');
     if(classified.some(e=>e.kind==='UNRELATED_FAILURE'))fail('v3_unrelated_failure_not_lob_rejection');
     if(test.sourceBytes>L){if(taskState.Status!=='running'||!same(targetBefore,final))break;await wait(1000);continue;}
     need(taskState.Status==='running','v3_positive_task_stopped');const current=await snapshot(source.c);if(same(current,final)){await health();break;}await wait(1000);}
    const receipt={case:test,binding:{taskArn:c.taskArn,sourceRunId:n.seed.runId,seedSha256:n.seed.sha256},sourceActualBytes:actual.bytes,sourceFullSha256:actual.sha256,
     beforeCoordinate:sourceBefore,afterCoordinate:sourceAfter,caseStartedAtMs:caseStart,caseFinishedAtMs:now(),taskStatus:taskState?.Status,cloudWatchEvents:observed,eventWatermark:{eventIds:watermark.map(x=>x.eventId),eventSetSha256:digest(watermark)},
     targetBeforeFullSha256:targetBefore.sha256,targetAfterFullSha256:final?.sha256,oneControlledDmlInThisRunner:true,sourceWritersFenceProven:false,logFieldsDoNotClaimObservedPrimaryKey:true};
    if(test.sourceBytes>L){event('OVERSIZE_STOP_AND_REVIEW',receipt);return {status:same(targetBefore,final)?'INCONCLUSIVE_LOB_REJECTION_FORMAT_UNREVIEWED':'FAIL_OVERSIZE_TARGET_CHANGED',
      templateSha256:TEMPLATE_SHA,case:receipt,stopAndReview:true,rootMustStopTaskViaVnc:taskState.Status==='running',automaticRetry:false,pilotAccepted:false,
      reason:'Real MySQL CDC rejection format has not been reviewed. STOP or a generic LOB message never becomes causal acceptance; raw scoped events are preserved.'};}
    need(final&&same(await snapshot(source.c),final),'v3_positive_did_not_converge');const targetField=await field(target,test);need(targetField.bytes===actual.bytes&&targetField.sha256===actual.sha256,'v3_positive_full_field_mismatch');
    const finalSource=await snapshot(source.c);need(same(finalSource,final),'v3_source_changed_before_receipt');receipts.push({...receipt,targetActualBytes:targetField.bytes,targetFullSha256:targetField.sha256,sourceSnapshot:finalSource,targetSnapshot:final,status:'FULL_HASH_EQUAL'});event('POSITIVE_EQUAL',receipts.at(-1));
   }
   return {status:phase==='positives'?'POSITIVES_EQUAL':'ONE_CASE_EQUAL',templateSha256:TEMPLATE_SHA,cases:receipts,allTwelveFullHashesEqual:true,
    syntheticOnly:true,pilotAccepted:false,checkpointResumeFenceStillRequired:true,awsWrites:false,automaticRetry:false};
  }catch(error){event('FAILURE',{code:error.code||'v3_runner_failed',writeRequested});throw error;}
  finally{if(source)await boundedClose(()=>harness.closeSource(source));await closeOwned(source?.c);await closeOwned(target);if(op)await boundedClose(()=>op.close());
   const closed=[source?.c,target].filter(Boolean).every(x=>(x.connection||x).stream?.destroyed===true);event('CLOSED',{onlyOwnedConnections:true,ownedTransportsDestroyed:closed,sourceEngineStopped:false});need(closed,'v3_owned_transport_still_open');}
 }};}
function privateFile(file){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);need(s.isFile()&&s.uid===process.getuid()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<=1024*1024,'v3_private_file_invalid');const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);need(s.ino===after.ino&&s.dev===after.dev&&s.size===after.size&&s.mtimeMs===after.mtimeMs&&s.ctimeMs===after.ctimeMs&&bytes.length===s.size,'v3_private_file_changed');return bytes;}finally{fs.closeSync(fd);}}
function loadReviewed(file,expected){const bytes=privateFile(file);need(sha(bytes)===expected,'v3_private_module_changed');const Module=require('node:module'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));require.cache[file]=m;try{m._compile(bytes.toString('utf8'),file);m.loaded=true;return m.exports;}catch(e){delete require.cache[file];throw e;}}
function arguments_(args){const out={},allowed=new Set(['--phase','--bindings-sha','--operator-sha','--case-id','--positive-receipt','--positive-receipt-sha']);need(args[0]==='--run'&&args.length%2===1,'v3_explicit_phase_required');for(let i=1;i<args.length;i+=2){need(allowed.has(args[i])&&out[args[i]]===undefined&&args[i+1]&&!args[i+1].startsWith('--'),'v3_cli_arguments_invalid');out[args[i]]=args[i+1];}
 need(['snapshot','base-cdc','positives','case'].includes(out['--phase'])&&['--bindings-sha','--operator-sha'].every(k=>/^[a-f0-9]{64}$/.test(out[k]||'')),'v3_explicit_phase_required');
 need(out['--phase']==='case'?/^(?:[0-9]|1[0-9]|2[0-3])$/.test(out['--case-id']||''):out['--case-id']===undefined,'v3_case_id_invalid');
 const negative=out['--phase']==='case'&&cases()[Number(out['--case-id'])].sourceBytes>L;need(negative?typeof out['--positive-receipt']==='string'&&/^[a-f0-9]{64}$/.test(out['--positive-receipt-sha']||''):out['--positive-receipt']===undefined&&out['--positive-receipt-sha']===undefined,'v3_positive_receipt_pin_required');return out;}
function exitCodeFor(status){return ['SNAPSHOT_EQUAL','BASE_CDC_EQUAL','POSITIVES_EQUAL','ONE_CASE_EQUAL'].includes(status)?0:2;}
async function main(args=process.argv.slice(2)){
 if(!args.length){console.log('Preparation only by default. Explicit root phases: --run --phase snapshot|base-cdc|positives|case --bindings-sha SHA --operator-sha SHA [--case-id N --positive-receipt FILE --positive-receipt-sha SHA]. Oversize requires reviewed same-run positives. No automatic AWS writes or retries.');return;}
 const options=arguments_(args),value=k=>options[k];let positiveReceipt;if(value('--positive-receipt')){const bytes=privateFile(value('--positive-receipt'));need(sha(bytes)===value('--positive-receipt-sha'),'v3_positive_receipt_changed');positiveReceipt=JSON.parse(bytes);}
 const B=loadReviewed(path.join(BASE,'dms-pilot-v3-bindings.cjs'),value('--bindings-sha'));B.verifyModules();const O=loadReviewed(path.join(BASE,'dms-pilot-v3-operator.cjs'),value('--operator-sha'));const folder=fs.mkdtempSync(path.join(BASE,'dms-v3-cases-'));fs.chmodSync(folder,0o700);
 const fd=fs.openSync(path.join(folder,'events.jsonl'),'wx',0o600);let result;try{const runner=createRunner({bindings:B,openTargetOperator:O.openReviewedTargetOperator,emit:e=>{fs.writeSync(fd,JSON.stringify(e)+'\n');fs.fdatasyncSync(fd);}});
  result=await runner.run({phase:value('--phase'),caseId:value('--case-id')===undefined?undefined:Number(value('--case-id')),positiveReceipt});
 }catch(e){result={status:'FAIL',code:e.code||'v3_runner_failed',pilotAccepted:false,automaticRetry:false};}
 finally{fs.closeSync(fd);fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({status:result.status,result:path.join(folder,'result.json')}));}
 process.exitCode=exitCodeFor(result.status);
}
if(require.main===module)main().catch(e=>{console.error(e.code||'v3_runner_failed');process.exitCode=2;});
module.exports={L,TEMPLATE_SHA,cases,textBytes,prepareBoundaryRows,classifyLogEvents,snapshot,field,createRunner,validateBinding,validatePositiveReceipt,arguments_,privateFile,events,targetScope,exitCodeFor,main};
