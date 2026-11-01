'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),S=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const policy=require('../../lib/marketing-quality-policy'),{createService}=require('../../services/whatsappQueueQuality.service');
withIsolatedCampaignMysql(async({sql,models,report})=>{
 const Settings=require('../../../models/marketingbulksendsetting')(sql,S.DataTypes);
 const Audit=require('../../../models/whatsappdeliveryevent')(sql,S.DataTypes);
 const List=sql.define('MarketingPatientList',{id:{type:S.INTEGER,primaryKey:true},clinica_id:S.INTEGER,status:S.STRING,criteria:S.JSON},{tableName:'MarketingPatientLists',timestamps:false});
 const Contact=sql.define('MarketingPatientContactEvent',{id:{type:S.INTEGER,primaryKey:true,autoIncrement:true},list_id:S.INTEGER,event_type:S.STRING,channel:S.STRING,payload:S.JSON,occurred_at:S.DATE},{tableName:'MarketingPatientContactEvents',timestamps:false});
 await sql.sync();await sql.getQueryInterface().addIndex('MarketingBulkSendSettings',['scope_key'],{unique:true,name:'qa_unique_global_scope'});
 let auditFail=false;
 const db={sequelize:sql,MarketingBulkSendSetting:Settings,WhatsappDeliveryEvent:{create:(...args)=>auditFail?Promise.reject(Error('TESTONLY_AUDIT_FAILURE')):Audit.create(...args)}};
 const service=createService({db});
 let initial=await service.read();assert.equal(await Settings.count(),0,'reading defaults creates no global setting');
 const first=await service.update({rate:.05,revision:initial.revision,actorId:91});assert.equal(first.max_opt_out_rate,.05);assert.equal(await Settings.count(),1);assert.equal(await Audit.count(),1);
 const row=await Settings.findOne();await row.update({settings:{...row.settings,batch_size:7,unrelated:{keep:true}},blocked_users:[{reason:'TESTONLY preserve'}]});
 const current=await service.read();await service.update({rate:.04,revision:current.revision,actorId:92});await row.reload();assert.equal(row.settings.batch_size,7);assert.deepEqual(row.settings.unrelated,{keep:true});assert.equal(row.blocked_users[0].reason,'TESTONLY preserve');
 await assert.rejects(service.update({rate:.03,revision:first.revision,actorId:91}),{status:409});
 for(const rate of [NaN,Infinity,0,-1,1.01,'0.03'])await assert.rejects(service.update({rate,revision:(await service.read()).revision,actorId:91}),{status:400});
 await assert.rejects(service.update({rate:.03,revision:(await service.read()).revision,actorId:0}),{status:403});
 const same=await service.read(),results=await Promise.allSettled([service.update({rate:.06,revision:same.revision,actorId:91}),service.update({rate:.07,revision:same.revision,actorId:92})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);assert.equal(await Audit.count(),3);
 const before=await service.read();auditFail=true;await assert.rejects(service.update({rate:.08,revision:before.revision,actorId:91}),/TESTONLY_AUDIT_FAILURE/);auditFail=false;assert.deepEqual(await service.read(),before);
 // ABA is a new revision even when the resulting numeric policy is the same.
 const next=await service.update({rate:.09,revision:before.revision,actorId:91});const back=await service.update({rate:before.max_opt_out_rate,revision:next.revision,actorId:91});assert.notEqual(back.revision,before.revision);
 report.checks.push('global quality is read-only until Save; one source, valid range, actor, audit rollback, field preservation, concurrency and ABA CAS');
 const dispatch={status:'paused_quality',job_id:4,whatsapp_template_id:3,sender_snapshot:{asset_id:8,phone_number_id:'TESTONLY_SENDER'},paused_reason:'opt_out_rate_high',requires_admin_review:true,quality_snapshot:{sent:77,opt_out_rate:3/77}};
 await List.bulkCreate([1,2,3].map(id=>({id,clinica_id:31,status:'paused',criteria:{dispatch}})));
 const source=fs.readFileSync(require.resolve('../../services/whatsappDeliveryGovernance.service'),'utf8'),from=source.indexOf('async function resolvePausedQueue('),to=source.indexOf('\nmodule.exports =',from),module={exports:{}};let notices=0;
 vm.runInNewContext(source.slice(from,to)+'\nmodule.exports=resolvePausedQueue;',{module,Date,db:{sequelize:sql},MarketingPatientList:List,MarketingPatientContactEvent:Contact,
 clean:v=>String(v??'').trim(),safeObject:v=>v&&typeof v==='object'?v:{},require:name=>{assert.equal(name,'../lib/marketing-quality-policy');return policy;},notifyQueueResolution:async()=>{assert((await Contact.count())>0);notices++;return true;}});
 const resolve=module.exports;await assert.rejects(resolve({listId:1,decision:'authorized',adminUserId:0}),{status:403});await List.create({id:4,clinica_id:31,status:'sending',criteria:{dispatch:{...dispatch,status:'sending'}}});await assert.rejects(resolve({listId:4,decision:'authorized',adminUserId:91}),{status:409});assert.equal((await List.findByPk(4)).status,'sending');await resolve({listId:1,decision:'authorized',adminUserId:91});const a=(await List.findByPk(1)).criteria.dispatch;
 assert(a.quality_exception);assert.equal(a.quality_exception.authorized_by,91);assert.equal(a.status,'paused');assert.equal(a.resume_automatically,false);assert.equal((await List.findByPk(2)).criteria.dispatch.admin_resolution,undefined);
 assert(!policy.evaluate({list:{id:1,clinica_id:31},dispatch:a,sent:77,optOut:3,batchSize:1,maxOptOutRate:.03}).paused);
 assert(policy.evaluate({list:{id:1,clinica_id:31},dispatch:a,sent:78,optOut:4,batchSize:1,maxOptOutRate:.03}).paused);
 await assert.rejects(resolve({listId:1,decision:'authorized',adminUserId:91}),{status:409});
 const competing=await Promise.allSettled([resolve({listId:3,decision:'authorized',adminUserId:91}),resolve({listId:3,decision:'authorized',adminUserId:92})]);assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);assert.equal(await Contact.count(),2);assert.equal(notices,2);
 report.checks.push('native individual authorization locks one queue, audits one resolution, acknowledges only the reviewed baseline and never resumes or waives new opt-outs');
 // Exercise the actual native resume body: it allocates a new job and still runs
 // sender-health and Meta gates before scheduling, including with an exception.
 const bulkSource=fs.readFileSync(require.resolve('../../services/marketingBulkSends.service'),'utf8'),begin=bulkSource.indexOf('async function resumeCampaignDispatch('),end=bulkSource.indexOf('\nasync function enqueueAutoDispatchForApprovedTemplate',begin),resumed={exports:{}};
 let blockedPayment=false,heldMeta=false,enqueued=0;
 const sandbox={module:resumed,Date,DISPATCH_BATCH_SIZE:100,DISPATCH_BATCH_DELAY_MS:600000,MarketingPatientList:List,MarketingPatientContactEvent:Contact,
  getActorUserId:()=>91,ensureScopeAccess:(l,scope)=>{assert(l&&scope.clinicIds.includes(l.clinica_id));},ensureDispatchableCampaignRecord:()=>{},
  normalizeChannels:()=>['whatsapp'],getDispatchConfig:l=>l.criteria.dispatch,normalizeDispatchContext:()=>null,getDispatchItemFilter:()=>null,
  isBlockingQualityPause:()=>false,isActorGlobalAdmin:()=>true,countDispatchRemainingItems:async()=>10,
  resolveWhatsappTemplate:async()=>({id:3,status:'APPROVED'}),getClinicIdForList:()=>31,resolveWhatsappClinicConfigForList:async()=>({phoneNumberId:'TESTONLY_SENDER',wabaId:'TESTONLY_WABA'}),isWhatsappRoutingConfigAvailable:()=>true,
  whatsappAccountHealthService:{assertCanSend:async()=>{if(blockedPayment)throw Object.assign(Error('TESTONLY_PAYMENT_BLOCKED'),{status:409});}},
  resolveWhatsappTemplateForClinic:async t=>t,whatsappDeliveryGovernanceService:{getDispatchGate:async()=>({allowed:!heldMeta,reason:'template_quality_assessment'})},
  getDeliveryGateBlockedMessage:()=> 'TESTONLY_META_HOLD',resolveDispatchBusinessHoursForList:async()=>({}),getNextBusinessAllowedAt:()=>new Date(),
  mergeCriteria:(l,p)=>({...l.criteria,...p}),enqueueDispatchJob:async()=>({id:100+(++enqueued)}),triggerDispatchJobIfReady:async()=>{},
  refreshListCounters:async()=>({sent:77}),serializeCampaign:l=>l.toJSON(),getDispatchProgress:l=>l.criteria.dispatch,getWhatsappAccountQualityForList:async()=>({})};
 vm.runInNewContext(bulkSource.slice(begin,end)+'\nmodule.exports=resumeCampaignDispatch;',sandbox);const resume=resumed.exports;
 await resume({clinicIds:[31]},1,{},91);const afterResume=await List.findByPk(1);assert.equal(afterResume.criteria.dispatch.job_id,101);assert(afterResume.criteria.dispatch.quality_exception);
 assert(!policy.evaluate({list:afterResume,dispatch:afterResume.criteria.dispatch,sent:77,optOut:3,batchSize:1,maxOptOutRate:.03}).paused);
 blockedPayment=true;await assert.rejects(resume({clinicIds:[31]},3,{},91),/TESTONLY_PAYMENT_BLOCKED/);assert.equal(enqueued,1);assert.equal((await List.findByPk(3)).status,'paused');
 blockedPayment=false;heldMeta=true;await assert.rejects(resume({clinicIds:[31]},3,{},91),/TESTONLY_META_HOLD/);assert.equal(enqueued,1);
 report.checks.push('the actual native resume replaces its job while retaining the reviewed baseline; payment and Meta hold still reject before enqueue');
 report.coverage={providerRequests:0,realPatients:0,dataWrittenOnlyToOwnedFixture:true};
}).catch(e=>{console.error(e.stack);process.exitCode=1;});
