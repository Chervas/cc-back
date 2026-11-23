'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
require('./fixtures/campaign_offline_runtime.cjs');
const C=require('../../services/googleOAuthAdmissionAttempt.contract'),R=require('../../services/googleOAuthAdmissionRecovery.contract');
const {createGoogleOAuthAdmissionRecovery}=require('../../services/googleOAuthAdmissionRecovery.repository');
const {firstAnalyticsSubjectDigest}=require('../../../services/integrations-broker/src/google-property-discovery-contract');
const {fixture}=require('./fixtures/google_admission_recovery_sqlite.fixture.cjs');
function setup(t,{scope='group:29',ids=[66,72]}={}){
 const f=fixture(t),state={now:Date.parse('2026-11-23T05:00:00Z'),allow:true,recovery:true,committed:true,checks:0};
 const context={attemptId:randomUUID(),actorId:501,sessionRef:randomUUID(),sessionExpiresAt:state.now+3600000,scopeKey:scope,clinicIds:ids,service:'analytics'};
 f.attempts.set(context.attemptId,C.prepare(context,new Date(state.now)).row||C.prepare(context,new Date(state.now)));
 const repo=createGoogleOAuthAdmissionRecovery({...f,authorize:async()=>{state.checks++;return state.allow;},authorizeRecovery:async()=>state.recovery,verifyCommitted:async()=>state.committed,now:()=>new Date(state.now)});
 const selection={clinicId:ids[0],assetRef:'ga4:333'},identity={googleUserId:'fictitious-subject',subjectDigest:firstAnalyticsSubjectDigest('fictitious-subject'),claimDigest:'a'.repeat(64)};
 const prepare=()=>repo.prepare(context,selection);
 const reply=(row,kind='confirmed_current',withReceipt=true)=>{const receipt={attemptId:row.attempt_id,scopeKey:row.scope_key,service:'analytics',clinicId:row.clinic_id,assetRef:row.asset_ref,
  bindingDigest:row.binding_digest,clinicSetDigest:row.clinic_digest,receiptId:randomUUID(),googleUserId:row.google_user_id,connectionRef:'google-first:analytics:'+row.scope_key,secretVersion:row.attempt_id,mode:'provisioned',observedAt:state.now,validUntil:state.now+60000,status:'confirmed_resource_access'};
  return {attemptId:row.attempt_id,scopeKey:row.scope_key,service:'analytics',crmIntentId:row.crm_intent_id,clinicId:row.clinic_id,assetRef:row.asset_ref,secretVersion:row.attempt_id,state:kind,
   receiptId:withReceipt?receipt.receiptId:null,receiptDigest:withReceipt?R.digest(receipt):null,receipt:withReceipt?receipt:null};};
 const dispatched=async()=>{const p=await prepare();return repo.dispatch(context,p.fence,identity);};
 const remote=async()=>{const d=await dispatched();return repo.observe(d.fence,reply(d.row));};
 const native=async()=>{const r=await remote();return repo.nativeResource(r.fence,{name:'properties/333',displayName:'Fictitious GA',propertyType:'PROPERTY_TYPE_ORDINARY',parent:'accounts/9',account:'accounts/9'});};
 return{...f,repo,state,context,selection,identity,prepare,reply,dispatched,remote,native};
}
test('durable exact original actor/session/scope/selection is stored before I/O without raw session material',async t=>{
 const f=setup(t),p=await f.prepare();assert.equal(f.active(),false);assert.equal(p.row.state,'prepared');assert.equal(p.row.generation,1);
 assert.equal(p.row.session_ref_hash,C.sessionHash(f.context.sessionRef));assert(!JSON.stringify(f.rows()).includes(f.context.sessionRef));
 assert.equal(R.dto(p.row).connected,false);assert.equal((await f.prepare()).row.crm_intent_id,p.row.crm_intent_id);
 await assert.rejects(f.repo.prepare(f.context,{...f.selection,assetRef:'ga4:334'}),{status:409});
 for(const changed of [{actorId:502},{sessionRef:randomUUID()},{scopeKey:'clinic:66',clinicIds:[66]},{service:'ads'}])await assert.rejects(f.repo.prepare({...f.context,...changed},f.selection),error=>[400,409].includes(error.status));
 assert.equal(f.rows().length,1);
});
test('scope reservation and global subject reservation deny another first command without overwriting it',async t=>{
 const f=setup(t),first=await f.prepare(),other={...f.context,attemptId:randomUUID()};f.attempts.set(other.attemptId,C.prepare(other,new Date(f.state.now)));
 await assert.rejects(f.repo.prepare(other,f.selection),{status:409});assert.equal(f.rows().length,1);
 const g={...other,scopeKey:'clinic:72',clinicIds:[72]};f.attempts.set(g.attemptId,C.prepare(g,new Date(f.state.now)));
 const second=await f.repo.prepare(g,{clinicId:72,assetRef:'ga4:444'});await f.repo.dispatch(f.context,first.fence,f.identity);
 await assert.rejects(f.repo.dispatch(g,second.fence,f.identity),{status:409});assert.equal(f.rows().length,2);
});
test('dispatch CAS is one-use and cannot bypass a rejected original authority or deadline',async t=>{
 const f=setup(t),p=await f.prepare();f.state.allow=false;await assert.rejects(f.repo.dispatch(f.context,p.fence,f.identity),{status:403});
 assert.equal(f.rows()[0].state,'prepared');f.state.allow=true;const d=await f.repo.dispatch(f.context,p.fence,f.identity);
 await assert.rejects(f.repo.dispatch(f.context,p.fence,f.identity),{status:409});assert.equal(d.row.dispatch_request_id,p.row.dispatch_request_id);
 const expired=setup(t),e=await expired.prepare();expired.state.now+=C.TTL_MS;await assert.rejects(expired.repo.dispatch(expired.context,e.fence,expired.identity),{status:409});
});
test('historical confirmed receipt may be observed after TTL but can never authorize a new SQL commit',async t=>{
 const f=setup(t),d=await f.dispatched(),r=f.reply(d.row);f.state.now+=C.TTL_MS+1;const observed=await f.repo.observe(d.fence,r);
 assert.equal(observed.row.state,'remote_confirmed');assert.equal(R.json(observed.row.owner_receipt).validUntil,r.receipt.validUntil);
 await assert.rejects(f.sequelize.transaction(tx=>f.repo.assertForCommit(observed.fence,{transaction:tx})),{status:409});
 assert.equal(f.publications.size,0);
});
test('receipt mismatch, another tuple and permissive observation fields never enter the ledger',async t=>{
 const f=setup(t),d=await f.dispatched(),r=f.reply(d.row);
 for(const value of [{...r,crmIntentId:randomUUID()},{...r,assetRef:'ga4:334'},{...r,token:'PRIVATE_PROVIDER_DETAIL'},
  {...r,receiptDigest:'b'.repeat(64)},{...r,receipt:{...r.receipt,googleUserId:'different'}}])await assert.rejects(f.repo.observe(d.fence,value),{status:409});
 const extended={...r.receipt,validUntil:r.receipt.observedAt+60001};
 await assert.rejects(f.repo.observe(d.fence,{...r,receipt:extended,receiptDigest:R.digest(extended)}),{status:409});
 assert.equal(f.rows()[0].owner_receipt,null);
});
test('expired execution generation is fenced before quarantine; late observer cannot revive it',async t=>{
 const f=setup(t),d=await f.dispatched();await assert.rejects(f.repo.claimRecovery(f.context.attemptId),{status:409});
 f.state.now+=R.LEASE_MS+1;const worker=await f.repo.claimRecovery(f.context.attemptId);assert.equal(worker.row.generation,2);
 await assert.rejects(f.repo.observe(d.fence,f.reply(d.row)),{status:409});
 const closing=await f.repo.quarantine(worker.fence);assert.equal(closing.row.state,'quarantine_pending');assert.equal(f.active(),false);
 const closed=await f.repo.completeQuarantine(closing.fence,f.reply(closing.row,'quarantined',false));assert.equal(closed.row.state,'quarantined');
 assert.equal(closed.row.scope_lock,R.scopeLock(f.context.scopeKey));assert.equal(closed.row.subject_lock,null);
 await assert.rejects(f.repo.dispatch(f.context,worker.fence,f.identity),{status:409});
});
test('unused prepared command can close locally; failed primary publication read is never absence',async t=>{
 const f=setup(t),p=await f.prepare();f.state.now+=R.LEASE_MS+1;const w=await f.repo.claimRecovery(f.context.attemptId);
 const pending=await f.repo.quarantine(w.fence);assert.equal(pending.row.state,'quarantine_pending');
 const closed=await f.repo.completeUnused(pending.fence,{attemptId:f.context.attemptId,bindingDigest:pending.row.binding_digest,service:'analytics',expiresAt:+pending.row.attempt_expires_at,state:'aborted',authorizationConfirmed:false,connected:false});assert.equal(closed.row.state,'closed_unused');assert.equal(closed.row.scope_lock,null);
 const d=setup(t),r=await d.dispatched();d.publicationModel.findByPk=async()=>{throw Error('PRIVATE_SQL_DETAIL');};
 await assert.rejects(d.repo.quarantine(r.fence),error=>error.status===503&&!error.message.includes('PRIVATE'));assert.equal(d.rows()[0].state,'dispatch_pending');
});
test('SQL publication and sql_committed share one transaction; rollback leaves no acknowledged command',async t=>{
 const f=setup(t),n=await f.native(),receipt=R.json(n.row.owner_receipt);let committed;
 await assert.rejects(f.sequelize.transaction(async tx=>{
  f.publications.set(f.context.attemptId,{attempt_id:f.context.attemptId,receipt_id:receipt.receiptId,receipt_digest:n.row.owner_receipt_digest,google_connection_id:61,
   scope_key:f.context.scopeKey,service:'analytics',clinic_id:66,asset_ref:'ga4:333',published_at:new Date(f.state.now)});
  committed=await f.repo.markSqlCommitted(n.fence,{transaction:tx});throw Error('FICTITIOUS_AUDIT_FAILED');
 }));assert.equal(f.publications.size,0);assert.equal(f.rows()[0].state,'remote_confirmed');
 await f.sequelize.transaction(async tx=>{
  await f.repo.assertForCommit(n.fence,{transaction:tx});f.publications.set(f.context.attemptId,{attempt_id:f.context.attemptId,receipt_id:receipt.receiptId,receipt_digest:n.row.owner_receipt_digest,google_connection_id:61,
   scope_key:f.context.scopeKey,service:'analytics',clinic_id:66,asset_ref:'ga4:333',published_at:new Date(f.state.now)});
  committed=await f.repo.markSqlCommitted(n.fence,{transaction:tx});
 });assert.equal(committed.row.state,'sql_committed');assert.equal(R.dto(committed.row).connected,false);
 await assert.rejects(f.repo.quarantine(committed.fence),{status:409});
 const ack=f.reply(committed.row,'published',false);ack.receiptId=receipt.receiptId;ack.receiptDigest=committed.row.owner_receipt_digest;
 f.state.committed=false;await assert.rejects(f.repo.completePublished(committed.fence,ack),{status:409});assert.equal(f.rows()[0].state,'sql_committed');
 f.state.committed=true;const done=await f.repo.completePublished(committed.fence,ack);assert.equal(R.dto(done.row).connected,true);assert.equal(done.row.state,'published');
 assert.equal(done.row.scope_lock,null);assert.equal(done.row.subject_lock,null);
});
test('worker authority is explicit, never synthesized from an expired bearer or a missing callback',async t=>{
 const f=setup(t);await f.dispatched();f.state.now+=R.LEASE_MS+1;f.state.recovery=false;
 await assert.rejects(f.repo.claimRecovery(f.context.attemptId),{status:403});assert.equal(f.rows()[0].generation,1);
});


test('a 60-second receipt expires inside the commit lock even while the original ten-minute attempt is live',async t=>{
 const f=setup(t),n=await f.native();f.state.now+=60001;
 assert(f.state.now<+n.row.attempt_expires_at);assert(f.state.now<+n.row.lease_until);
 await assert.rejects(f.sequelize.transaction(tx=>f.repo.assertForCommit(n.fence,{transaction:tx})),{status:409});
 await assert.rejects(f.sequelize.transaction(tx=>f.repo.markSqlCommitted(n.fence,{transaction:tx})),{status:409});
 assert.equal(f.publications.size,0);assert.equal(f.rows()[0].state,'remote_confirmed');
});


test('a newer unknown observation preserves history but fences both native/SQL commit authorization',async t=>{
 const f=setup(t),n=await f.native(),unknown=await f.repo.observe(n.fence,f.reply(n.row,'unknown',false));
 assert.equal(unknown.row.owner_receipt_digest,n.row.owner_receipt_digest);assert.equal(unknown.row.state,'remote_confirmed');
 await assert.rejects(f.sequelize.transaction(tx=>f.repo.assertForCommit(unknown.fence,{transaction:tx})),{status:409});
 await assert.rejects(f.sequelize.transaction(tx=>f.repo.markSqlCommitted(unknown.fence,{transaction:tx})),{status:409});
});
