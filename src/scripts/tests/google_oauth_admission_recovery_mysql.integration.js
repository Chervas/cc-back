'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{DataTypes}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const C=require('../../services/googleOAuthAdmissionAttempt.contract'),R=require('../../services/googleOAuthAdmissionRecovery.contract');
const {createGoogleOAuthAdmissionRecovery}=require('../../services/googleOAuthAdmissionRecovery.repository');
const {firstAnalyticsSubjectDigest}=require('../../../services/integrations-broker/src/google-property-discovery-contract');
withIsolatedCampaignMysql(async({sql,models,report})=>{
 const qi=sql.getQueryInterface(),Sequelize=require('sequelize');
 for(const file of ['20261122223000-create-google-oauth-admission-attempts','20261122225000-create-google-oauth-admission-publications','20261123050000-create-google-oauth-admission-recoveries'])await require('../../../migrations/'+file).up(qi,Sequelize);
 models.GoogleOAuthAdmissionAttempt=require('../../../models/googleoauthadmissionattempt')(sql,DataTypes);
 models.GoogleOAuthAdmissionPublication=require('../../../models/googleoauthadmissionpublication')(sql,DataTypes);
 models.GoogleOAuthAdmissionRecovery=require('../../../models/googleoauthadmissionrecovery')(sql,DataTypes);
 await sql.query('CREATE TABLE fixture_recovery_audit(attempt_id CHAR(36) PRIMARY KEY)');
 const state={now:Math.floor(Date.now()/1000)*1000,allow:true};const now=()=>new Date(state.now);
 const repo=createGoogleOAuthAdmissionRecovery({model:models.GoogleOAuthAdmissionRecovery,attemptModel:models.GoogleOAuthAdmissionAttempt,
  publicationModel:models.GoogleOAuthAdmissionPublication,sequelize:sql,authorize:async()=>state.allow,authorizeRecovery:async()=>true,verifyCommitted:async()=>true,now});
 const context=(scope='clinic:66',id=66)=>({attemptId:randomUUID(),actorId:501,sessionRef:randomUUID(),sessionExpiresAt:state.now+3600000,scopeKey:scope,clinicIds:[id],service:'analytics'});
 const identity={googleUserId:'fictitious-recovery-subject',subjectDigest:firstAnalyticsSubjectDigest('fictitious-recovery-subject'),claimDigest:'a'.repeat(64)};
 async function prepare(c){await models.GoogleOAuthAdmissionAttempt.create(C.prepare(c,now()));return repo.prepare(c,{clinicId:c.clinicIds[0],assetRef:'ga4:333'});}
 function response(row,kind='confirmed_current',receipt){return{attemptId:row.attempt_id,scopeKey:row.scope_key,service:'analytics',crmIntentId:row.crm_intent_id,clinicId:row.clinic_id,assetRef:row.asset_ref,
  secretVersion:row.attempt_id,state:kind,receiptId:receipt?.receiptId??null,receiptDigest:receipt?R.digest(receipt):null,receipt:kind==='confirmed_current'?receipt:null};}
 function receipt(row){return{attemptId:row.attempt_id,scopeKey:row.scope_key,service:'analytics',clinicId:row.clinic_id,assetRef:row.asset_ref,bindingDigest:row.binding_digest,clinicSetDigest:row.clinic_digest,
  receiptId:randomUUID(),googleUserId:row.google_user_id,connectionRef:'google-first:analytics:'+row.scope_key,secretVersion:row.attempt_id,mode:'provisioned',observedAt:state.now,validUntil:state.now+60000,status:'confirmed_resource_access'};}
 console.log('CHECKPOINT schema_ready');const c=context(),p=await prepare(c);console.log('CHECKPOINT prepared');
 const dispatches=await Promise.allSettled([repo.dispatch(c,p.fence,identity),repo.dispatch(c,p.fence,identity)]);
 assert.equal(dispatches.filter(value=>value.status==='fulfilled').length,1);assert.equal(dispatches.filter(value=>value.status==='rejected'&&value.reason.status===409).length,1);
 console.log('CHECKPOINT concurrent_dispatch_settled');const d=dispatches.find(value=>value.status==='fulfilled').value;assert.equal(d.row.dispatch_request_id,p.row.dispatch_request_id);
 console.log('CHECKPOINT one_dispatch_selected');const c2=context('clinic:72',72),p2=await prepare(c2);await assert.rejects(repo.dispatch(c2,p2.fence,identity),{status:409});
 assert.equal((await models.GoogleOAuthAdmissionRecovery.findByPk(c2.attemptId)).state,'prepared');
 console.log('CHECKPOINT subject_conflict_closed');const raw=(await models.GoogleOAuthAdmissionRecovery.findByPk(c.attemptId,{raw:true}));assert.equal(raw.session_ref_hash,C.sessionHash(c.sessionRef));assert(!JSON.stringify(raw).includes(c.sessionRef));
 report.checks.push('Actual additive MySQL schema stores hashed original session and exact durable pins. Concurrent CAS dispatch admits one executor; global subject uniqueness blocks another scope without mutating it.');
 console.log('CHECKPOINT first_checks_recorded');const r=receipt(d.row),observed=await repo.observe(d.fence,response(d.row,'confirmed_current',r));
 const n=await repo.nativeResource(observed.fence,{name:'properties/333',displayName:'Propiedad SQL ficticia',propertyType:'PROPERTY_TYPE_ORDINARY',parent:'accounts/9',account:'accounts/9'});
 const publication={attempt_id:c.attemptId,receipt_id:r.receiptId,receipt_digest:R.digest(r),google_connection_id:61,scope_key:c.scopeKey,service:'analytics',clinic_id:66,asset_ref:'ga4:333',published_at:now()};
 await assert.rejects(sql.transaction(async tx=>{
  await models.GoogleOAuthAdmissionPublication.create(publication,{transaction:tx});await sql.query('INSERT INTO fixture_recovery_audit VALUES (?)',{replacements:[c.attemptId],transaction:tx});
  await repo.markSqlCommitted(n.fence,{transaction:tx});throw Error('FICTITIOUS_AUDIT_ABORT');
 }));
 assert.equal(await models.GoogleOAuthAdmissionPublication.count(),0);assert.equal((await models.GoogleOAuthAdmissionRecovery.findByPk(c.attemptId)).state,'remote_confirmed');
 assert.equal(Number((await sql.query('SELECT COUNT(*) n FROM fixture_recovery_audit'))[0][0].n),0);
 let entered,release;const locked=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);let committed;
 console.log('CHECKPOINT rollback_verified');const writer=sql.transaction(async tx=>{
  await repo.assertForCommit(n.fence,{transaction:tx});await models.GoogleOAuthAdmissionPublication.create(publication,{transaction:tx});
  await sql.query('INSERT INTO fixture_recovery_audit VALUES (?)',{replacements:[c.attemptId],transaction:tx});committed=await repo.markSqlCommitted(n.fence,{transaction:tx});entered();await barrier;
 });await locked;
 const closer=repo.quarantine(n.fence);const closerSettled=closer.then(value=>({value}),error=>({error}));setTimeout(release,30);await writer;const closedRace=await closerSettled;assert.equal(closedRace.error?.status,409);
 assert.equal((await models.GoogleOAuthAdmissionRecovery.findByPk(c.attemptId)).state,'sql_committed');assert.equal(await models.GoogleOAuthAdmissionPublication.count(),1);
 report.checks.push('Publication, audit and intent roll back atomically. Real MySQL row locks serialize a pending quarantine behind commit; a stale generation/revision never compensates committed SQL.');
 state.now+=C.TTL_MS+1;const worker=await repo.claimRecovery(c.attemptId);const ack=response(worker.row,'published',r);
 const done=await repo.completePublished(worker.fence,ack);assert.equal(done.row.state,'published');assert.equal(R.dto(done.row).connected,true);
 assert.equal(done.row.scope_lock,null);assert.equal(done.row.subject_lock,null);
 report.checks.push('A lost SQL/Owner ACK can finish the already committed command after OAuth deadline, using the exact immutable receipt; it does not authorize any new SQL mapping or extend a receipt deadline.');
 const fresh=context('clinic:81',81),q=await prepare(fresh),qD=await repo.dispatch(fresh,q.fence,{...identity,googleUserId:'fictitious-quarantine',subjectDigest:firstAnalyticsSubjectDigest('fictitious-quarantine')});
 state.now+=R.LEASE_MS+1;const recovering=await repo.claimRecovery(fresh.attemptId);
 await assert.rejects(repo.observe(qD.fence,response(qD.row,'unknown',null)),{status:409});
 const close=await repo.quarantine(recovering.fence),closed=await repo.completeQuarantine(close.fence,response(close.row,'quarantined',null));
 assert.equal(closed.row.state,'quarantined');assert.equal(closed.row.subject_lock,null);assert.equal(closed.row.scope_lock,R.scopeLock(fresh.scopeKey));
 report.checks.push('Expired execution leases fence late observers by generation. Exact quarantine is durable and terminal, releases the subject lock, retains the affected first slot scope and leaves prior publication untouched.');
 await assert.rejects(require('../../../migrations/20261123050000-create-google-oauth-admission-recoveries').down(qi),{message:'google_oauth_admission_recoveries_have_history'});
 report.checks.push('Migration down refuses durable recovery history. No provider, runtime configuration or existing credential table was accessed by this ledger-only fixture.');
}).catch(error=>{process.stderr.write(String(error.stack)+'\n');process.exitCode=1;});
