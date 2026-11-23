'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const R=require('../../services/googleOAuthAdmissionRecovery.contract');
const {createGoogleOAuthAdmissionRecoveryCoordinator}=require('../../services/googleOAuthAdmissionRecoveryCoordinator.service');
// Reuse the real repository/SQLite harness, excluding its test declarations.
const filename=path.join(__dirname,'google_oauth_admission_recovery.test.js'),source=fs.readFileSync(filename,'utf8');
const prefix=source.slice(0,source.indexOf("test('durable exact"));assert(prefix.length>0);
const helpers=new Module(filename,module);helpers.filename=filename;helpers.paths=Module._nodeModulePaths(__dirname);helpers._compile(prefix+'\nmodule.exports={setup};',filename);
function fixture(t){
 const f=helpers.exports.setup(t),state={promotions:0,previews:0,observes:0,acks:0,quarantines:0,aborts:0,native:0,commits:0,ownerReceipt:null,ownerPublished:false,ownerClosed:false};
 const current=()=>{const row=f.rows()[0];return R.record(Object.fromEntries(Object.entries(row).map(([key,value])=>[key,R.DATES.includes(key)&&value!==null?new Date(value):value])));};
 const outside=()=>assert.equal(f.active(),false,'Owner/provider await must be outside SQL');
 const reply=(row,kind,withBody=false)=>{const receipt=state.ownerReceipt;return{attemptId:row.attempt_id,scopeKey:row.scope_key,service:'analytics',crmIntentId:row.crm_intent_id,
  clinicId:row.clinic_id,assetRef:row.asset_ref,secretVersion:row.attempt_id,state:kind,receiptId:['published','confirmed_current'].includes(kind)&&receipt?receipt.receiptId:null,
  receiptDigest:['published','confirmed_current'].includes(kind)&&receipt?R.digest(receipt):null,receipt:withBody?receipt:null};};
 const owner={
  async previewIdentity(request){outside();state.previews++;const row=current();assert.equal(row.state,'prepared');assert.equal(row.crm_intent_id,request.crmIntentId);await state.beforePreview?.();return{attemptId:row.attempt_id,scopeKey:row.scope_key,service:'analytics',googleUserId:f.identity.googleUserId,subjectDigest:f.identity.subjectDigest};},
  async verifyPublication(request){outside();const row=current();assert.equal(row.state,'dispatch_pending');assert.equal(row.dispatch_request_id,request.dispatchRequestId);assert.equal(row.subject_digest,request.expectedSubjectDigest);
   if(!state.ownerReceipt){state.promotions++;state.ownerReceipt=f.reply(row).receipt;}
   await state.afterPromotion?.();if(state.losePromotionAck){state.losePromotionAck=false;throw Error('PRIVATE_NETWORK_DETAIL');}return state.ownerReceipt;},
  async observeRecovery(){outside();state.observes++;const row=current();if(state.ownerClosed)return reply(row,'quarantined');if(state.forceUnknown||!state.ownerReceipt)return reply(row,'unknown');return reply(row,state.ownerPublished?'published':'confirmed_current',true);},
  async ackRecovery(request){outside();state.acks++;const row=current();assert.equal(row.state,'sql_committed');assert(f.publications.has(row.attempt_id));assert.equal(request.receiptDigest,R.digest(state.ownerReceipt));state.ownerPublished=true;
   if(state.loseFinalAck){state.loseFinalAck=false;throw Error('PRIVATE_ACK_DETAIL');}return reply(row,'published');},
  async quarantineRecovery(){outside();state.quarantines++;assert(!f.publications.has(f.context.attemptId));state.ownerClosed=true;return reply(current(),'quarantined');},
  async abortUnused(){outside();state.aborts++;assert.equal(state.promotions,0);const row=current();return{attemptId:row.attempt_id,bindingDigest:row.binding_digest,service:'analytics',expiresAt:+row.attempt_expires_at,state:'aborted',authorizationConfirmed:false,connected:false};},
 };
 const coordinator=createGoogleOAuthAdmissionRecoveryCoordinator({capture:async()=>({context:f.context,authorize:async()=>f.state.allow}),repository:()=>f.repo,owner,now:()=>new Date(f.state.now),
  claim:async()=>{if(!f.state.allow)throw Object.assign(Error(),{status:403});return f.identity.claimDigest;},
  validateOriginal:async()=>{if(!f.state.allow)throw Object.assign(Error(),{status:403});if(state.claimChanged)throw Object.assign(Error(),{status:409});},
  verifyNative:async()=>{outside();state.native++;assert.equal(state.ownerPublished,false);if(state.failNative)throw Error('PRIVATE_PROVIDER_DETAIL');return{name:'properties/333',displayName:'Fictitious GA',propertyType:'PROPERTY_TYPE_ORDINARY',parent:'accounts/9',account:'accounts/9'};},
  commit:async({intent,repository})=>{state.commits++;const committed=await f.sequelize.transaction(async tx=>{
    await repository.assertForCommit(intent.fence,{transaction:tx});const receipt=R.json(intent.row.owner_receipt);
    f.publications.set(f.context.attemptId,{attempt_id:f.context.attemptId,receipt_id:receipt.receiptId,receipt_digest:intent.row.owner_receipt_digest,google_connection_id:61,
     scope_key:f.context.scopeKey,service:'analytics',clinic_id:66,asset_ref:'ga4:333',published_at:new Date(f.state.now)});
    return repository.markSqlCommitted(intent.fence,{transaction:tx});
   });await state.afterCommit?.();if(state.loseSqlAck)throw Error('PRIVATE_COMMIT_ACK');return{intent:committed,replayed:false};},
  verifyCommitted:async()=>{if(state.committedError)throw state.committedError;return f.state.committed;},
  mayContinue:async row=>+row.attempt_expires_at>f.state.now&&f.state.allow,
 });
 const command={attemptId:f.context.attemptId,scopeKey:f.context.scopeKey,service:'analytics',...f.selection};
 return{...f,state: {...f.state},control:f.state,ownerState:state,coordinator,command,current};
}
test('coordinator persists before every I/O and returns connected only after durable exact ACK',async t=>{
 const f=fixture(t),r=await f.coordinator.publish({},f.command);assert.equal(r.connected,true);assert.equal(f.current().state,'published');assert.equal(f.ownerState.promotions,1);assert.equal(f.ownerState.acks,1);
 const calls=f.ownerState.previews+f.ownerState.observes+f.ownerState.acks;assert.equal((await f.coordinator.publish({},f.command)).replayed,true);assert.equal(f.ownerState.previews+f.ownerState.observes+f.ownerState.acks,calls);
});
test('lost promotion ACK recovers current receipt without a second promotion',async t=>{
 const f=fixture(t);f.ownerState.losePromotionAck=true;assert.equal((await f.coordinator.publish({},f.command)).connected,true);assert.equal(f.ownerState.promotions,1);assert.equal(f.current().state,'published');
});
test('lost post-SQL ACK stays pending and can acknowledge after original deadline without provider or SQL replay',async t=>{
 const f=fixture(t);f.ownerState.loseFinalAck=true;await assert.rejects(f.coordinator.publish({},f.command),{status:503});assert.equal(f.current().state,'sql_committed');
 f.control.now+=600001;const before={promotions:f.ownerState.promotions,native:f.ownerState.native,commits:f.ownerState.commits};
 const result=await f.coordinator.reconcile(f.context.attemptId);assert.equal(result.connected,true);assert.deepEqual({promotions:f.ownerState.promotions,native:f.ownerState.native,commits:f.ownerState.commits},before);
});
test('parallel same-user confirm has one preview/dispatcher; contender cannot park or close the live creator',async t=>{
 const f=fixture(t);let entered,release;const seen=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>release=resolve);f.ownerState.beforePreview=async()=>{entered();await wait;};
 const first=f.coordinator.publish({},f.command);await seen;await assert.rejects(f.coordinator.publish({},f.command),{status:503});assert.equal(f.ownerState.aborts,0);assert.equal(f.current().state,'prepared');release();assert.equal((await first).connected,true);assert.equal(f.ownerState.previews,1);assert.equal(f.ownerState.promotions,1);
});
test('authority/claim loss after Owner effect closes exactly the new grant and creates no SQL publication',async t=>{
 const f=fixture(t);f.ownerState.afterPromotion=()=>{f.control.allow=false;};await assert.rejects(f.coordinator.publish({},f.command),{status:403});
 assert.equal(f.publications.size,0);assert.equal(f.ownerState.quarantines,1);assert.equal(f.current().state,'quarantined');assert.equal(f.ownerState.acks,0);
});
test('a newer unknown readback never reuses archived receipt to call native verifier or SQL',async t=>{
 const f=fixture(t);f.ownerState.failNative=true;await assert.rejects(f.coordinator.publish({},f.command),{status:503});assert.equal(f.ownerState.native,1);
 f.ownerState.failNative=false;f.ownerState.forceUnknown=true;await assert.rejects(f.coordinator.publish({},f.command),{status:503});assert.equal(f.ownerState.native,1);assert.equal(f.ownerState.commits,0);
 await f.coordinator.reconcile(f.context.attemptId);assert.equal(f.current().state,'quarantined');
});
test('unknown SQL commit ACK cannot be compensated and later reconciliation does not rewrite publication',async t=>{
 const f=fixture(t);f.ownerState.loseSqlAck=true;await assert.rejects(f.coordinator.publish({},f.command),{status:503});assert.equal(f.current().state,'sql_committed');assert.equal(f.ownerState.quarantines,0);
 f.control.now+=R.LEASE_MS+1;const result=await f.coordinator.reconcile(f.context.attemptId);assert.equal(result.connected,true);assert.equal(f.ownerState.promotions,1);assert.equal(f.ownerState.commits,1);
});
test('expired receipt closes the new effect even with a live original attempt',async t=>{
 const f=fixture(t);f.ownerState.afterPromotion=()=>{f.control.now+=60001;};await assert.rejects(f.coordinator.publish({},f.command),{status:409});assert.equal(f.current().state,'quarantined');assert.equal(f.publications.size,0);assert.equal(f.ownerState.native,0);
});
test('prepared unused recovery waits for real original Owner abort before terminal local closure',async t=>{
 const f=fixture(t);await f.repo.prepare(f.context,f.selection);f.control.now+=R.LEASE_MS+1;
 const result=await f.coordinator.reconcile(f.context.attemptId);assert.equal(result.state,'closed_unused');assert.equal(f.ownerState.aborts,1);assert.equal(f.ownerState.promotions,0);assert.equal(f.current().scope_lock,null);
});
test('assignment removal after SQL commit prevents ACK and active UI projection without compensating committed history',async t=>{
 const f=fixture(t);f.ownerState.afterCommit=()=>{f.control.committed=false;};await assert.rejects(f.coordinator.publish({},f.command),{status:409});
 assert.equal(f.ownerState.acks,0);assert.equal(f.ownerState.quarantines,0);assert.equal(f.current().state,'sql_committed');assert.equal(f.current().last_error,'authority_changed');assert.equal(f.publications.size,1);
});

test('canonical native httpStatus conflict preserves safe409 and parks post-SQL history for manual review',async t=>{
 const f=fixture(t);f.ownerState.afterCommit=()=>{f.ownerState.committedError=Object.assign(Error('PRIVATE_NATIVE_ROW'),{httpStatus:409});};
 await assert.rejects(f.coordinator.publish({},f.command),{status:409});assert.equal(f.ownerState.acks,0);assert.equal(f.current().state,'sql_committed');assert.equal(f.current().last_error,'authority_changed');assert.equal(f.publications.size,1);
});
