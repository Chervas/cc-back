'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {createCredentialNotifications}=require('../../services/metaMarketingCredentialNotifications.service');
const start=Date.parse('2030-01-01T12:00:00Z');
function fixture(){
 const ids=[randomUUID(),randomUUID()],versions=ids.map(()=>randomUUID()),rows=new Map(),deliveries=[],failed=new Set(),reads=new Map(),failAt=new Map();
 let clock=start,queueFailed=null,tail=Promise.resolve();
 const statuses=new Map(ids.map((id,index)=>{const observedAt=new Date(clock-1000).toISOString(),expiresAt=clock+60*86400000;return[id,{
  enrollmentId:id,scopeKey:'clinic:'+(index+1),clinicIds:[index+1],connectionId:172+index,appId:'101',subjectId:'201',actorUserId:1,
  epoch:1,versionId:versions[index],expiresAt,dataAccessExpiresAt:null,expired:false,requiresRenewal:true,
  lastError:'credential_revoked',healthKind:'permission_lost',observedAt,tokenType:'USER',issuerKind:'USER',issuerBusinessId:null,
  clientBusinessId:null,configId:null,unknownSince:null,lastHealthyAt:clock-1000,
  currentMetadata:{expiresAt,dataAccessExpiresAt:null,health:'permission_lost',lastError:'credential_revoked',observedAt}}];}));
 const incident=key=>{const row=rows.get(key);return row&&{...row,update:async patch=>rows.set(key,{...rows.get(key),...structuredClone(patch)})};};
 const sequelize={transaction:async(_,work)=>{const previous=tail;let done;tail=new Promise(resolve=>{done=resolve;});await previous;
  const backup=structuredClone(rows),count=deliveries.length;try{return await work({LOCK:{UPDATE:'UPDATE'}});}catch(error){rows.clear();for(const[k,v]of backup)rows.set(k,v);deliveries.length=count;throw error;}finally{done();}},
  query:async(_,{replacements:p})=>{if(!rows.has(p.key))rows.set(p.key,{incident_key:p.key,namespace:p.namespace,event_key:p.eventKey,scope_key:p.scope,state:'new',severity:p.severity,opened_at:p.opened,observed_at:p.observed,snapshot:JSON.parse(p.snapshot),channel_state:{}});}};
 const enrollments=new Map(ids.map(id=>[id,{enrollment_id:id,state:'active'}]));
 const models={sequelize,MetaMarketingEnrollmentRequest:{findAll:async()=>[...enrollments.keys()].map(id=>({enrollment_id:id})),findByPk:async id=>enrollments.get(id)},
  SystemNotificationIncident:{findByPk:async key=>incident(key),findAll:async({where})=>[...rows.keys()].map(incident).filter(r=>r.namespace===where.namespace&&r.state===where.state)}};
 const create=()=>createCredentialNotifications({models,namespace:'staging',now:()=>clock,enabled:()=>true,confirmedHandover:async()=>null,
  ordering:{prepareEnrollment:async enrollmentId=>({enrollmentId}),lockPrepared:async()=>{}},channels:()=>['panel','email'],
  credentialStatus:async row=>{const count=(reads.get(row.enrollment_id)||0)+1;reads.set(row.enrollment_id,count);
   if(failed.has(row.enrollment_id)||failAt.get(row.enrollment_id)===count)throw Error('FICTITIOUS_CREDENTIAL_READ_FAILURE');return structuredClone(statuses.get(row.enrollment_id));},
  maintenanceStatus:async row=>{const s=statuses.get(row.enrollment_id);return{enrollmentId:s.enrollmentId,epoch:s.epoch,versionId:s.versionId,mechanism:'user_legacy',automaticSupported:false,attemptState:'human_required',humanReason:'permissions_lost',lastAttemptAt:null,nextAttemptAt:null,unknownSince:null,lastHealthyAt:clock-1000};},
  queue:async value=>{if(value.metadata.credential.enrollmentId===queueFailed)throw Error('FICTITIOUS_QUEUE_FAILURE');
   const created=Object.entries(value.channelsOverride).filter(([,v])=>v).map(([channel])=>({channel}));deliveries.push(...created.map(x=>({...x,enrollmentId:value.metadata.credential.enrollmentId})));return{created,skipped:[]};}});
 return{ids,rows,deliveries,statuses,reads,failed,failAt,create,advance:()=>{clock+=1000;reads.clear();},failQueue:id=>{queueFailed=id;}};
}
test('one unavailable USER credential cannot suppress another connection alert',async()=>{
 const f=fixture();f.failed.add(f.ids[0]);const r=await f.create().run();
 assert.equal(r.incomplete,true);assert.equal(r.failed,1);assert.equal(r.checked,1);assert.equal(r.alerts,1);
 assert.equal(f.deliveries.length,2);assert(f.deliveries.every(d=>d.enrollmentId===f.ids[1]));
});
test('failure to revalidate one connection rolls back only its incident and permits the next',async()=>{
 const f=fixture();f.failAt.set(f.ids[0],2);const r=await f.create().run();
 assert.equal(r.failed,1);assert.equal(r.checked,2);assert.equal(f.rows.size,1);assert.equal(f.deliveries.length,2);
 assert(f.deliveries.every(d=>d.enrollmentId===f.ids[1]));
});
test('one queue failure is retried in a later sweep without repeating another connection',async()=>{
 const f=fixture();f.failQueue(f.ids[0]);const first=await f.create().run();assert.equal(first.failed,1);assert.equal(f.rows.size,1);
 f.failQueue(null);f.advance();const second=await f.create().run();assert.equal(second.failed,0);assert.equal(f.rows.size,2);assert.equal(f.deliveries.length,4);
});
test('an unavailable previously alerted connection remains open while independent healthy recovery closes',async()=>{
 const f=fixture();await f.create().run();f.advance();f.failed.add(f.ids[0]);
 const s=f.statuses.get(f.ids[1]);s.healthKind='healthy';s.lastError=null;s.requiresRenewal=false;s.observedAt=new Date(start+1000).toISOString();s.lastHealthyAt=start+1000;
 s.currentMetadata.health='healthy';s.currentMetadata.lastError=null;s.currentMetadata.observedAt=s.observedAt;
 // This case uses a proven replacement; unavailable scope has no recovery proof.
 s.epoch=2;s.versionId=randomUUID();
 const r=await f.create().run();assert.equal(r.failed,1);
 assert.equal([...f.rows.values()].find(x=>x.snapshot.metadata.credential.enrollmentId===f.ids[0]).state,'open');
 assert.equal([...f.rows.values()].find(x=>x.snapshot.metadata.credential.enrollmentId===f.ids[1]).state,'closed');
 assert.equal(f.deliveries.length,4);
});
