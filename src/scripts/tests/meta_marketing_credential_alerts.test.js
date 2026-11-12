'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),cp=require('node:child_process');
const {createRequire}=require('node:module');
require('node:net').Socket.prototype.connect=()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
global.fetch=()=>{throw Error('OFFLINE_PROVIDER_FORBIDDEN');};
const P=require('../../lib/metaMarketingCredentialAlerts'),N=require('../../services/metaMarketingCredentialNotifications.service');
const {createIncidentNotifier}=require('../../lib/operationalNotificationIncidents');
const at=Date.parse('2030-01-01T12:00:00.000Z'),id='11111111-1111-4111-8111-111111111111',version='22222222-2222-4222-8222-222222222222',next='33333333-3333-4333-8333-333333333333';
function status({days=60,expiresAt=at+days*P.DAY,dataAccessExpiresAt=null,health='healthy',lastError=null,epoch=0,versionId=version,tokenType='SYSTEM_USER',issuerKind=tokenType==='SYSTEM_USER'?'BISU':'USER'}={}){
 return {enrollmentId:id,scopeKey:'group:29',clinicIds:[66,72],connectionId:172,appId:'101',subjectId:'201',actorUserId:1,epoch,versionId,
  expiresAt,dataAccessExpiresAt,expired:health==='expired',requiresRenewal:['expired','permission_lost'].includes(health),lastError,healthKind:health,
  tokenType,issuerKind,issuerBusinessId:issuerKind==='AGENCY_SYSTEM_USER'?'501':issuerKind==='BISU'?'301':null,clientBusinessId:issuerKind==='BISU'?'301':null,configId:issuerKind==='BISU'?'401':null,unknownSince:null,lastHealthyAt:at-1000,
  observedAt:new Date(at-1000).toISOString(),currentMetadata:{expiresAt,dataAccessExpiresAt,health,lastError,observedAt:new Date(at-1000).toISOString()}};
}
function maintenance(value,extra={}){return {enrollmentId:value.enrollmentId,epoch:value.epoch,versionId:value.versionId,mechanism:value.issuerKind==='AGENCY_SYSTEM_USER'?'agency_system_user':value.tokenType==='SYSTEM_USER'?'business_api':'user_legacy',automaticSupported:value.tokenType==='SYSTEM_USER',
 attemptState:'failed',humanReason:null,lastAttemptAt:at-1000,nextAttemptAt:null,unknownSince:null,lastHealthyAt:at-1000,...extra};}
const alerts=(value,extra={})=>P.alertsFromStatus(value,at,maintenance(value,extra));
function fixture(value=status({days:2})){
 let time=at,tail=Promise.resolve();const state={value,reads:0,fail:false,onRead:null,enabled:true},rows=new Map(),deliveries=[];
 const row=key=>{const r=rows.get(key);return r&&{...r,update:async patch=>rows.set(key,{...rows.get(key),...structuredClone(patch)})};};
 const sequelize={transaction:async(options,work)=>{const prior=tail;let done;tail=new Promise(r=>done=r);await prior;
  const before=structuredClone(rows),length=deliveries.length;try{return await work({LOCK:{UPDATE:'UPDATE'}});}catch(e){rows.clear();for(const[k,v]of before)rows.set(k,v);deliveries.length=length;throw e;}finally{done();}},
  query:async(sql,{replacements:p})=>{assert.match(sql,/ON DUPLICATE KEY UPDATE incident_key=incident_key/);if(!rows.has(p.key))rows.set(p.key,{incident_key:p.key,
   namespace:p.namespace,event_key:p.eventKey,scope_key:p.scope,state:'new',severity:p.severity,opened_at:p.opened,observed_at:p.observed,snapshot:JSON.parse(p.snapshot),channel_state:{}});}};
 const models={sequelize,MetaMarketingEnrollmentRequest:{findAll:async opts=>{assert.equal(opts.where.state,'active');return state.enumerated||[{enrollment_id:id}];},
  findByPk:async(enrollmentId,opts)=>{assert(opts.transaction);state.reads++;state.onRead?.(state.reads);return{enrollment_id:enrollmentId,state:state.superseded?.includes(enrollmentId)?'superseded':'active'};}},
  SystemNotificationIncident:{findByPk:async key=>row(key),findAll:async({where})=>[...rows.keys()].map(row).filter(r=>r.namespace===where.namespace&&r.state===where.state)}};
 const queue=async request=>{assert(request.transaction);if(state.fail)throw Error('FICTITIOUS_OUTBOX_FAILURE');
  assert.equal(request.channelsOverride.whatsapp,false);assert.deepEqual(request.allowedChannels,['panel','email']);
  const created=Object.entries(request.channelsOverride).filter(([,on])=>on).map(([channel])=>({channel}));deliveries.push(...created.map(c=>({...c,metadata:request.metadata,payload:request.payload})));return{created,skipped:[]};};
 const create=()=>N.createCredentialNotifications({models,queue,channels:()=>['panel','email','whatsapp'],namespace:'staging',now:()=>time,
  enabled:()=>state.enabled,ordering:{prepareEnrollment:async enrollmentId=>({enrollmentId}),lockPrepared:async(prepared,transaction)=>{assert(transaction);assert(prepared.enrollmentId);}},credentialStatus:async()=>{if(state.error)throw Error(state.error);return structuredClone(state.value);},
  maintenanceStatus:async()=>structuredClone(state.maintenance||maintenance(state.value)),confirmedHandover:async(previous,options)=>{assert(options.transaction);state.handoverReads=(state.handoverReads||0)+1;state.onHandoverRead?.(state.handoverReads);return structuredClone(state.handoverResult||null);}});
 return {state,rows,deliveries,models,create,advance:ms=>time+=ms};
}
test('automatic success and recovered retries generate no expiry emails; only unconfirmed maintenance inside3days reaches the safety alert',()=>{
 assert.deepEqual(alerts(status()),[]);
 for(const days of[14,7,4])for(const attemptState of['idle','scheduled','running','retry_wait','succeeded','failed'])assert.deepEqual(alerts(status({days}),{attemptState}),[]);
 for(const days of[3,2,1]){
  const result=alerts(status({days}));assert.equal(result.length,1);assert.equal(result[0].metadata.credential.threshold,3);assert.equal(result[0].eventKey,P.EVENTS.soon);
  assert.deepEqual(alerts(status({days}),{attemptState:'succeeded'}),[]);
 }
 assert.equal(alerts(status({days:0}))[0].eventKey,P.EVENTS.expired);
 for(const expiresAt of[null,0])assert.deepEqual(alerts(status({expiresAt,dataAccessExpiresAt:0})),[]);
 const data=alerts(status({expiresAt:null,dataAccessExpiresAt:at+P.DAY}));assert.equal(data[0].metadata.credential.threshold,3);
 assert.equal(alerts(status({days:3,tokenType:'USER'}),{mechanism:'user_legacy',automaticSupported:false,attemptState:'idle'})[0].eventKey,P.EVENTS.human);
 assert.deepEqual(alerts(status({days:14,tokenType:'USER'}),{mechanism:'user_legacy',automaticSupported:false,attemptState:'idle'}),[]);
});
test('current permanent loss is distinct from expiry; transient/provider401/quota/stale version or a rejected candidate never means lost authorization',()=>{
 for(const lastError of P.PERMANENT)assert.equal(alerts(status({health:'permission_lost',lastError}))[0].eventKey,P.EVENTS.lost);
 for(const lastError of ['provider_unauthorized','provider_timeout','provider_failed','broker_timeout','broker_unavailable','rate_limited','outcome_unknown','secret_unavailable','secret_version_changed'])
  assert.deepEqual(alerts(status({health:'temporary',lastError})),[]);
 const expired=alerts(status({days:-1,health:'permission_lost',lastError:'credential_revoked'}));assert.equal(expired[0].eventKey,P.EVENTS.expired);
 assert.throws(()=>alerts({...status(),candidateError:'credential_revoked'}),/metadata_invalid/);
 for(const lastError of [4,17,32,613,'CANDIDATE_REJECTED_CANARY'])assert.throws(()=>alerts(status({health:'temporary',lastError})),/metadata_invalid/);
});
test('explicit human action and sustained unknown supervision have distinct incidents, never inferred from one transient or an old activation date',()=>{
 const s=status({health:'temporary',lastError:'provider_timeout'});
 assert.deepEqual(alerts(s,{unknownSince:at-P.UNKNOWN_MARGIN+1,lastHealthyAt:at-P.UNKNOWN_MARGIN-1000}),[]);
 const unknown=alerts(s,{unknownSince:at-P.UNKNOWN_MARGIN,lastHealthyAt:at-P.UNKNOWN_MARGIN-1000});assert.equal(unknown[0].eventKey,P.EVENTS.unknown);
 assert(!unknown[0].payload.title.includes('retirado'));assert.equal(unknown[0].metadata.credential.episodeAt,at-P.UNKNOWN_MARGIN);
 const human=alerts(status(),{attemptState:'human_required',humanReason:'authorization_required'});assert.equal(human[0].eventKey,P.EVENTS.human);
 assert.deepEqual(alerts(status({days:10}),{attemptState:'human_required',humanReason:'automatic_renewal_failed'}),[]);
 assert.equal(alerts(status({days:3}),{attemptState:'human_required',humanReason:'automatic_renewal_failed'})[0].eventKey,P.EVENTS.soon);
 assert.deepEqual(alerts(s,{attemptState:'human_required',humanReason:'supervision_unavailable',unknownSince:at-P.UNKNOWN_MARGIN+1,lastHealthyAt:null}),[]);
 assert.deepEqual(alerts(s,{unknownSince:null,lastHealthyAt:null}),[]);
 for(const mutate of[m=>m.versionId=next,m=>m.epoch=2,m=>m.unknownSince=-1,m=>m.lastHealthyAt=at+10000,m=>m.humanReason='RAW_PROVIDER_CANARY',m=>m.extra='RAW_PROVIDER_CANARY']){
  const value=maintenance(s);mutate(value);assert.throws(()=>P.alertsFromStatus(s,at,value),/metadata_invalid/);
 }
});
test('Agency system-user maintenance is explicit and cannot use a fabricated BISU client business or an ambiguous SYSTEM_USER type',()=>{
 const value=status({issuerKind:'AGENCY_SYSTEM_USER'});assert.equal(value.clientBusinessId,null);assert.equal(value.issuerBusinessId,'501');assert.deepEqual(alerts(value),[]);
 const near=status({issuerKind:'AGENCY_SYSTEM_USER',days:3});assert.equal(alerts(near)[0].eventKey,P.EVENTS.soon);assert.deepEqual(alerts(near,{attemptState:'succeeded'}),[]);
 for(const mutate of[s=>s.clientBusinessId='301',s=>s.issuerBusinessId=null,s=>s.issuerKind='BISU',s=>delete s.issuerKind,s=>s.tokenType='USER']){
  const invalid=status({issuerKind:'AGENCY_SYSTEM_USER'});mutate(invalid);assert.throws(()=>alerts(invalid),/metadata_invalid/);
 }
 assert.throws(()=>alerts(value,{mechanism:'business_api'}),/metadata_invalid/);
});
test('closed metadata and links never reflect provider messages, identities, tokens or arbitrary URLs',()=>{
 const canary='PRIVATE_TOKEN_CANARY_DO_NOT_REFLECT';
 for(const mutate of [s=>s.token=canary,s=>s.currentMetadata.message=canary,s=>s.currentMetadata.expiresAt=-1,s=>s.clinicIds=[72,66],s=>s.scopeKey='group:29&token='+canary]){
  const s=status({days:1});mutate(s);assert.throws(()=>alerts(s),e=>e.code==='meta_credential_notification_metadata_invalid'&&!e.message.includes(canary));
 }
 const alert=alerts(status({days:1}))[0];assert(!JSON.stringify(alert).includes('subjectId'));assert(!JSON.stringify(alert).includes('appId'));
 assert.match(alert.payload.detail,/Conexión Meta 172, grupo 29; clínicas afectadas: 66, 72/);assert.deepEqual(alert.metadata.affected_clinic_ids,[66,72]);
 assert.equal(P.actionPath('group:29'),'/ajustes?panel=connected-accounts&action=renew_meta&assignment_scope=group&group_id=29');
 assert.throws(()=>P.actionUrl('group:29&token='+canary));
});
test('only a confirmed healthy higher epoch and different version resolves old incidents',()=>{
 const alert=alerts(status({days:1}))[0],healthy=status({epoch:1,versionId:next});assert(P.resolution(alert,healthy,at,maintenance(healthy)));
 for(const value of[status(),status({epoch:1}),status({epoch:1,versionId:next,health:'temporary',lastError:'provider_timeout'}),status({epoch:1,versionId:next,days:-1,health:'expired'})])assert.equal(P.resolution(alert,value,at,maintenance(value)),null);
 assert.equal(P.resolution(alert,null,at),null);
});
test('gateOFF/DEV/Gateway do not query optional models or load credential state',async()=>{
 assert.equal(N.enabled({META_MARKETING_BROKER_ENABLED:'true',META_MARKETING_CREDENTIAL_RENEWAL_ENABLED:'true'},'staging'),true);
 assert.equal(N.enabled({META_MARKETING_BROKER_ENABLED:'true',META_MARKETING_BUSINESS_ENABLED:'true'},'staging'),true);
 assert.equal(N.enabled({META_MARKETING_BROKER_ENABLED:'true',META_MARKETING_BUSINESS_MAINTENANCE_ENABLED:'true'},'staging'),true);
 assert.equal(N.enabled({RUNTIME_ROLE:'gateway',META_MARKETING_BROKER_ENABLED:'true',META_MARKETING_CREDENTIAL_RENEWAL_ENABLED:'true'},'staging'),false);
 assert.equal(N.enabled({META_MARKETING_BROKER_ENABLED:'true',META_MARKETING_CREDENTIAL_RENEWAL_ENABLED:'true'},'dev'),false);
 const models=new Proxy({},{get(){assert.fail('No model access when disabled');}});
 const result=await N.createCredentialNotifications({models,enabled:()=>false}).run();assert.equal(result.skipped,true);
});
test('concurrent sweeps and restarts dedupe each version/kind without daily reminders or threshold chains; noWhatsApp even if configured',async()=>{
 const f=fixture();await Promise.all(Array.from({length:8},()=>f.create().run()));assert.equal(f.deliveries.length,2);assert.equal(f.rows.size,1);
 f.advance(P.DAY);await f.create().run();assert.equal(f.deliveries.length,2);assert.equal(f.rows.size,1);
 assert(f.deliveries.every(d=>['panel','email'].includes(d.channel)));
});
test('outbox failure or effective credential changing at enqueue rolls back instead of notifying an old version',async()=>{
 const f=fixture();f.state.fail=true;assert.equal((await f.create().run()).incomplete,true);assert.equal(f.rows.size,0);assert.equal(f.deliveries.length,0);
 f.state.fail=false;await f.create().run();assert.equal(f.deliveries.length,2);
 const changed=fixture();changed.state.onRead=n=>{if(n===2)changed.state.value=status({epoch:1,versionId:next});};
 assert.equal((await changed.create().run()).incomplete,true);assert.equal(changed.rows.size,0);assert.equal(changed.deliveries.length,0);
});
test('failed/temporary observations never resolve; confirmed renewal closes onlyMeta with no success outbox',async()=>{
 const f=fixture();await f.create().run();f.state.error='FICTITIOUS_TIMEOUT';assert.equal((await f.create().run()).incomplete,true);assert.equal([...f.rows.values()][0].state,'open');
 f.state.error=null;f.state.value=status({epoch:1,versionId:next,health:'temporary',lastError:'rate_limited'});await f.create().run();assert.equal(f.deliveries.length,2);
 f.state.value=status({epoch:1,versionId:next});await f.create().run();await f.create().run();assert.equal(f.deliveries.length,2);assert.equal([...f.rows.values()][0].state,'closed');
});
test('fresh healthy supervision resolves unknown on the same version without email; stale success or a late changed state cannot close it',async()=>{
 const f=fixture(status({health:'temporary',lastError:'provider_timeout'}));
 f.state.maintenance=maintenance(f.state.value,{unknownSince:at-P.UNKNOWN_MARGIN,lastHealthyAt:at-P.UNKNOWN_MARGIN-1000});
 await f.create().run();assert.equal(f.deliveries.length,2);assert.equal([...f.rows.values()][0].snapshot.eventKey,P.EVENTS.unknown);
 f.state.value=status();f.state.maintenance=maintenance(f.state.value,{lastHealthyAt:at-1000});await f.create().run();assert.equal([...f.rows.values()][0].state,'open');
 f.advance(1000);f.state.maintenance.lastHealthyAt=at+1000;await f.create().run();await f.create().run();assert.equal([...f.rows.values()][0].state,'closed');assert.equal(f.deliveries.length,2);
 const changed=fixture(status({health:'temporary',lastError:'provider_timeout'}));changed.state.maintenance=maintenance(changed.state.value,{unknownSince:at-P.UNKNOWN_MARGIN,lastHealthyAt:null});await changed.create().run();
 changed.advance(1000);changed.state.value=status();changed.state.maintenance=maintenance(changed.state.value,{lastHealthyAt:at+1000});
 const prior=changed.state.reads;changed.state.onRead=n=>{if(n===prior+2)changed.state.value=status({health:'temporary',lastError:'provider_timeout'});};
 assert.equal((await changed.create().run()).incomplete,true);assert.equal([...changed.rows.values()][0].state,'open');assert.equal(changed.deliveries.length,2);
});
test('a verified USER→Business handover closes an old enrollment incident audit-only, never by matching the scope alone',async()=>{
 const f=fixture(status({days:1,tokenType:'USER'}));await f.create().run();const original=[...f.rows.values()][0].snapshot,old=original.metadata.credential;
 f.advance(1000);f.state.value={...status({versionId:next}),enrollmentId:next,connectionId:173};f.state.enumerated=[{enrollment_id:next}];f.state.superseded=[id];
 f.state.maintenance=maintenance(f.state.value,{lastHealthyAt:at+1000});
 await f.create().run();assert.equal([...f.rows.values()][0].state,'open');assert.equal(f.deliveries.length,2,'Same scope and healthy replacement without authoritative lineage must not close');
 f.state.handoverResult={currentStatus:f.state.value,maintenanceStatus:f.state.maintenance,proof:{oldEnrollmentId:id,oldEpoch:old.epoch,oldVersionId:old.versionId,newEnrollmentId:next,oldConnectionId:172,newConnectionId:173,scopeKey:'group:29',chainDigest:'c'.repeat(64)}};
 await f.create().run();await f.create().run();assert.equal([...f.rows.values()][0].state,'closed');assert.equal(f.deliveries.length,2);assert.equal(f.state.handoverReads,3,'One absent lookup, then one capture plus same-TX revalidation');
});
test('a changed handover lineage/epoch/identity is rejected before incident close and creates no success email',async()=>{
 const f=fixture(status({days:1,tokenType:'USER'}));await f.create().run();const original=[...f.rows.values()][0].snapshot;
 const value={...status({versionId:next}),enrollmentId:next,connectionId:173},result={currentStatus:value,maintenanceStatus:maintenance(value,{lastHealthyAt:at+1000}),
  proof:{oldEnrollmentId:id,oldEpoch:0,oldVersionId:version,newEnrollmentId:next,oldConnectionId:172,newConnectionId:173,scopeKey:'group:29',chainDigest:'c'.repeat(64)}};
 for(const mutate of[r=>r.proof.oldEpoch=1,r=>r.proof.oldVersionId=next,r=>r.proof.oldConnectionId=173,r=>r.proof.scopeKey='group:28',r=>r.proof.newEnrollmentId=id,r=>r.proof.chainDigest='SECRET_CANARY',r=>r.extra='SECRET_CANARY']){
  const copy=structuredClone(result);mutate(copy);assert.throws(()=>P.handoverResolution(original,copy,at+1000),/metadata_invalid/);
 }
 f.advance(1000);f.state.value=value;f.state.maintenance=result.maintenanceStatus;f.state.enumerated=[{enrollment_id:next}];f.state.superseded=[id];f.state.handoverResult=result;
 f.state.onHandoverRead=n=>{if(n===2)f.state.handoverResult.proof.chainDigest='d'.repeat(64);};assert.equal((await f.create().run()).incomplete,true);
 assert.equal([...f.rows.values()][0].state,'open');assert.equal(f.deliveries.length,2);
});
test('the defaultWhatsApp recovery resolver cannot close aMeta incident',async()=>{
 const f=fixture();await f.create().run();const before=f.deliveries.length;
 await createIncidentNotifier({sequelize:f.models.sequelize,Incident:f.models.SystemNotificationIncident,queue:()=>assert.fail('No cross-consumer notification'),
  channels:()=>['email'],namespace:'staging',now:()=>at}).sync([],{resolution:async()=>assert.fail('No cross-consumer resolution')});
 assert.equal(f.deliveries.length,before);assert.equal([...f.rows.values()][0].state,'open');
});
test('opsMeta mail links only to approved scoped Settings; existingWhatsApp rendered output remains byte-identical',()=>{
 const templates=require('../../services/emailTemplates.service'),canary='PRIVATE_URL_CANARY';
 const rendered=templates.renderTemplate('ops.system_alert',{event_key:P.EVENTS.soon,action_scope:'group:29',title:'Renovar Meta',
  message:'Aviso técnico.',action:'Revisar Ajustes.',url:'https://evil.invalid/?token='+canary});
 assert(rendered.html.includes('https://crm.clinicaclick.com/ajustes?panel=connected-accounts&amp;action=renew_meta&amp;assignment_scope=group&amp;group_id=29'));
 assert(rendered.text.includes(P.actionUrl('group:29')));assert(!JSON.stringify(rendered).includes(canary));
 const filename=path.resolve(__dirname,'../../services/emailTemplates.service.js'),actual=createRequire(filename),loaded={exports:{}};
 const source=cp.execFileSync('git',['show','f0360eb4e5adee23906c9ca24d30a55db1e19b08:src/services/emailTemplates.service.js'],{cwd:path.resolve(__dirname,'../../..'),encoding:'utf8'});
 vm.runInNewContext(source,{require:actual,module:loaded,exports:loaded.exports,process,Buffer},{filename});
 for(const event_key of['whatsapp.reception_attention','whatsapp.template_reconciliation_delayed','whatsapp.account_health_blocked','infrastructure.rds_alarm']){
  const context={event_key,severity:'warning',title:'Fictitious warning',message:'No patient data.',action:'Review.',incident_phase:'open',operational_summary:'Fictitious summary'};
  assert.equal(JSON.stringify(templates.renderTemplate('ops.system_alert',context)),JSON.stringify(loaded.exports.renderTemplate('ops.system_alert',context)));
 }
});
