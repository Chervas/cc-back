'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),S=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const policy=require('../../lib/review-queue-schedule');
const {reviewRecencySql}=require('../../lib/review-recency-order');

withIsolatedCampaignMysql(async({sql,models,report})=>{
 const define=(name,fields)=>sql.define(name,fields,{tableName:name,timestamps:true,underscored:true});
 const List=define('MarketingPatientLists',{id:{type:S.INTEGER,primaryKey:true},objective_id:S.STRING,clinica_id:S.INTEGER,clinic_ids:S.JSON,status:S.STRING,criteria:S.JSON,counters:S.JSON});
 const Job=define('JobRequests',{id:{type:S.INTEGER,primaryKey:true},type:S.STRING,status:S.STRING,payload:S.JSON,next_run_at:S.DATE});
 const Item=define('MarketingPatientListItems',{id:{type:S.INTEGER,primaryKey:true},list_id:S.INTEGER,status:S.STRING,selected:S.BOOLEAN,dispatch_status:S.STRING,last_visit_at:S.DATE,appointment_at:S.DATE,custom_fields:S.JSON});
 const Event=define('MarketingPatientContactEvents',{id:{type:S.INTEGER,primaryKey:true,autoIncrement:true},list_id:S.INTEGER,event_type:S.STRING,channel:S.STRING,payload:S.JSON,occurred_at:S.DATE});
 await sql.sync();
 const scope={scope:'clinic',clinicIds:[59]}, namespace='isolated-review-schedule';
 const source=fs.readFileSync(path.resolve(__dirname,'../../services/marketingBulkSends.service.js'),'utf8');
 const from=source.indexOf('async function updateReviewQueueSchedule('),to=source.indexOf('\nasync function reconcileBulkSendTemplateCategory',from);
 assert(from>0&&to>from);const module={exports:{}};let auditFailure=false;
 const sandbox={module,process:{env:{JOB_RUNTIME_NAMESPACE:namespace}},MarketingPatientList:List,JobRequest:Job,MarketingPatientListItem:Item,
  MarketingPatientContactEvent:{create:(...args)=>auditFailure?Promise.reject(Error('FICTITIOUS_AUDIT_FAILURE')):Event.create(...args)},
  DISPATCH_JOB_TYPE:'marketing_bulk_send_dispatch',Op:S.Op,db:{sequelize:sql},
  ensureScopeAccess:(list,scope)=>{if(!list||list.objective_id!=='mass_sends'||!scope.clinicIds.includes(list.clinica_id))throw Object.assign(Error('foreign'),{status:404});},
  isReviewRequestList:list=>list.criteria.review_request===true,getDispatchConfig:list=>list.criteria.dispatch,
  resolveDispatchBusinessHoursForList:async()=>({timezone:'Europe/Madrid',start_time:'09:00',end_time:'18:00'}),
  getNextBusinessAllowedAt:date=>date,parseDate:value=>value?new Date(value):null,
  serializeCampaign:list=>list.toJSON(),getDispatchProgress:list=>list.criteria.dispatch,getReviewQueueSchedule:async()=>({success:true}),
  require:name=>{assert.equal(name,'../lib/review-queue-schedule');return policy;},
 };
 vm.runInNewContext(source.slice(from,to)+'\nmodule.exports=updateReviewQueueSchedule;',sandbox);
 const update=module.exports,config={mode:'custom',time_mode:'clinic_hours',batch_size:5,delay_ms:3600000};
 const reset=async(status='waiting_next_batch',jobStatus='waiting')=>{
  await Event.destroy({where:{}});await Item.destroy({where:{}});await List.destroy({where:{}});await Job.destroy({where:{}});
  await Job.create({id:10,type:'marketing_bulk_send_dispatch',status:jobStatus,payload:{list_id:1,__runtime_namespace:namespace},next_run_at:new Date(Date.now()+600000)});
  const created=await List.create({id:1,objective_id:'mass_sends',clinica_id:59,clinic_ids:[59],status:status==='paused_config'?'paused':'sending',counters:{sent:7},criteria:{review_request:true,dispatch_config:{batch_size:1},
   dispatch:{status,job_id:10,cancel_requested:status==='paused_config',paused_reason:status==='paused_config'?'billing':'waiting',batch_size:1,delay_ms:600000,context:'review_request',whatsapp_template_id:77,sender_origin_id:88,max_opt_out_rate:0.1,last_batch_index:7,last_batch_completed_at:new Date().toISOString()}}});
  return created.reload();
 };
 const body=list=>({configuration:config,revision:list.updatedAt.toISOString()});
 // Runtime fields use underscored accessors, as the production MarketingPatientList model does.
 Object.defineProperty(List.prototype,'updated_at',{get(){return this.updatedAt;}});
 let list=await reset();const result=await update(scope,1,body(list),91);let after=await List.findByPk(1),job=await Job.findByPk(10);
 assert.equal(after.criteria.dispatch.batch_size,5);assert.equal(after.criteria.dispatch.status,'scheduled');assert.equal(job.status,'waiting');
 assert.equal(await Job.count(),1);assert(job.next_run_at>new Date(Date.now()+3500000));assert.equal(await Event.count(),1);
 for(const key of ['job_id','whatsapp_template_id','sender_origin_id','max_opt_out_rate','last_batch_index'])assert.equal(after.criteria.dispatch[key],list.criteria.dispatch[key]);
 assert.deepEqual(after.counters,{sent:7});assert(result.success);
 report.checks.push('editing an idle native job is atomic, keeps its identity/counters/sender/template/thresholds and records audit; no enqueue or immediate trigger dependency');
 list=await reset('paused_config','cancelled');await update(scope,1,body(list),91);after=await List.findByPk(1);job=await Job.findByPk(10);
 assert.equal(after.status,'paused');assert.equal(after.criteria.dispatch.status,'paused_config');assert.equal(after.criteria.dispatch.cancel_requested,true);assert.equal(job.status,'cancelled');
 report.checks.push('manual/technical pause, cancel request and terminal native job remain unchanged while future pace is edited');
 for(const kind of ['running','stale','inflight','foreign-job','foreign-runtime','completed-job']){
  list=await reset('waiting_next_batch',kind==='running'?'running':kind==='completed-job'?'completed':'waiting');
  if(kind==='inflight')await Item.create({id:1,list_id:1,status:'ready',selected:true,dispatch_status:'accepted'});
  if(kind==='foreign-job')await Job.update({payload:{list_id:2,__runtime_namespace:namespace}},{where:{id:10}});
  if(kind==='foreign-runtime')await Job.update({payload:{list_id:1,__runtime_namespace:'other'}},{where:{id:10}});
  const before=JSON.stringify((await List.findByPk(1)).criteria);
  await assert.rejects(update(scope,1,{...body(list),...(kind==='stale'?{revision:'old'}:{})},91),{status:409});
  assert.equal(JSON.stringify((await List.findByPk(1)).criteria),before);assert.equal(await Event.count(),0);
 }
 report.checks.push('running batch, stale revision, accepted transport and foreign/missing job ownership reject without changes');
 list=await reset();auditFailure=true;const beforeJob=(await Job.findByPk(10)).next_run_at;
 await assert.rejects(update(scope,1,body(list),91),/FICTITIOUS_AUDIT_FAILURE/);auditFailure=false;
 assert.equal((await List.findByPk(1)).criteria.dispatch.batch_size,1);assert.equal(+(await Job.findByPk(10)).next_run_at,+beforeJob);
 report.checks.push('audit failure rolls back both schedule and native job');
 list=await reset();const held=await sql.transaction();await Job.findByPk(10,{transaction:held,lock:held.LOCK.UPDATE});
 const raced=assert.rejects(update(scope,1,body(list),91),{status:409});await new Promise(r=>setTimeout(r,80));await Job.update({status:'running'},{where:{id:10},transaction:held});await held.commit();
 await raced;assert.equal(await Event.count(),0);
 report.checks.push('real concurrent native job claim wins safely; a schedule save never overwrites its running state');
 await Item.bulkCreate([
  {id:1,list_id:1,status:'ready',selected:true,last_visit_at:new Date('2026-08-01')},
  {id:2,list_id:1,status:'ready',selected:true,last_visit_at:new Date('2026-10-10')},
  {id:3,list_id:1,status:'ready',selected:true,custom_fields:{fecha_ultima_cita_asistida:'15/10/2026'}},
  {id:4,list_id:1,status:'ready',selected:true,custom_fields:{fecha_cita:'2026-10-14T09:00:00Z'}},
  {id:5,list_id:1,status:'ready',selected:true,custom_fields:{fecha_cita:'13-10-2026'}},
  {id:6,list_id:1,status:'ready',selected:true},
  {id:7,list_id:1,status:'ready',selected:true,dispatch_status:'sent',last_visit_at:new Date('2026-10-16')},
  {id:8,list_id:1,status:'ready',selected:true,dispatch_status:'accepted',last_visit_at:new Date('2026-10-16')},
  {id:9,list_id:1,status:'ready',selected:false,last_visit_at:new Date('2026-10-16')},
 ]);
 const candidateFrom=source.indexOf('async function findDispatchCandidateBatch('),candidateTo=source.indexOf('\nfunction normalizeBulkSendSettingsPayload',candidateFrom);
 assert(candidateFrom>0&&candidateTo>candidateFrom);
 const candidatesModule={exports:{}};
 vm.runInNewContext(source.slice(candidateFrom,candidateTo)+'\nmodule.exports=findDispatchCandidateBatch;',{
  module:candidatesModule,MarketingPatientListItem:Item,Op:S.Op,Sequelize:S,DISPATCH_BATCH_SIZE:10,
  itemMatchesDispatchFilter:()=>true,require:name=>{assert.equal(name,'../lib/review-recency-order');return{reviewRecencySql};},
 });
 const candidates=candidatesModule.exports;
 const rows=await candidates(1,null,10,true);
 assert.deepEqual(rows.map(r=>r.id),[3,4,5,2,1,6]);
 report.checks.push('actual MySQL recency ordering covers native, ISO/slash/dash imported dates and unknown dates; sent/accepted/unselected are excluded');
 assert.deepEqual((await candidates(1,null,2,true)).map(r=>r.id),[3,4]);
 assert.deepEqual((await candidates(1,null,2,false)).map(r=>r.id),[1,2]);
 const freshSource=source.slice(source.indexOf('  const freshById ='),source.indexOf('\n  const batchIndex =',source.indexOf('  const freshById =')));
 assert(freshSource.includes('batch.map'));
 const preserved=vm.runInNewContext(freshSource+'\nfilteredFreshBatch.map(item=>item.id)',{batch:rows,freshBatch:[...rows].sort((a,b)=>a.id-b.id).filter(r=>r.id!==4),itemMatchesDispatchFilter:()=>true,filter:null});
 assert.deepEqual([...preserved],[3,5,2,1,6]);
 report.checks.push('production candidate reader limits after recency ordering; ordinary campaigns keep ID order; post-revalidation preserves recency while dropping newly excluded items');
}).catch(error=>{console.error(error);process.exitCode=1;});
