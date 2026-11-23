'use strict';
const { randomUUID } = require('node:crypto');
const C = require('./googleOAuthAdmissionAttempt.contract');
const R = require('./googleOAuthAdmissionRecovery.contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const plain = value => value?.get ? value.get({ plain:true }) : value;
const closed = error => {
  const status = error?.status ?? error?.httpStatus;
  if ([400,401,403,409].includes(status)) return C.problem(status===401?'google_oauth_admission_session_required':status===403?'google_oauth_admission_forbidden':status===400?'google_oauth_admission_attempt_invalid':'google_oauth_admission_attempt_conflict',status);
  if (error?.name==='SequelizeUniqueConstraintError' || ['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error?.original?.code)) return C.problem('google_oauth_admission_attempt_conflict',409);
  return C.problem('google_oauth_admission_attempt_unavailable',503);
};
function createGoogleOAuthAdmissionRecovery({ model,attemptModel,publicationModel,sequelize,authorize,
  authorizeRecovery = async () => false,verifyCommitted = async () => false,now = () => new Date() } = {}) {
  if (![model,attemptModel,publicationModel].every(value=>typeof value?.findByPk==='function')
    || typeof model.create!=='function' || typeof model.update!=='function' || typeof sequelize?.transaction!=='function'
    || [authorize,authorizeRecovery,verifyCommitted,now].some(value=>typeof value!=='function')) throw closed();
  const options = transaction => ({ transaction,lock:transaction.LOCK.UPDATE,raw:true,logging:false });
  const time = () => new Date(C.clock(now()));
  const validateTx = tx => { if (!tx || !tx.LOCK?.UPDATE || tx.finished || tx.sequelize!==sequelize) throw closed(); };
  async function atomic(work,tx) {
    try { if(tx){validateTx(tx);return await work(tx);}return await sequelize.transaction(async value=>{validateTx(value);return work(value);}); }
    catch(error){throw closed(error);}
  }
  async function get(id,tx) { const value=await model.findByPk(id,options(tx));if(!value)R.fail();return R.record(plain(value)); }
  const result = row => Object.freeze({ row:R.record(row),fence:R.fence(row) });
  async function user(context,tx,{freshAttempt=true}={}) {
    const c=C.assertLive(C.input(context),time());
    if(await authorize(c,{transaction:tx})!==true)throw C.problem('google_oauth_admission_forbidden',403);
    C.assertLive(c,time());
    const value=await attemptModel.findByPk(c.attemptId,options(tx));if(!value)R.fail();const attempt=C.assertBound(plain(value),c);
    if(freshAttempt&&(attempt.state!=='prepared'||+attempt.expires_at<=+time()))R.fail();
    return attempt;
  }
  async function save(row,patch,tx) {
    const next=R.record({...row,...patch,revision:row.revision+1,updated_at:time()});
    const [count]=await model.update({...patch,revision:next.revision,updated_at:next.updated_at},{ ...options(tx),
      where:{attempt_id:row.attempt_id,crm_intent_id:row.crm_intent_id,generation:row.generation,revision:row.revision,lease_token:row.lease_token} });
    if(count!==1)R.fail();const stored=await get(row.attempt_id,tx);
    if(canonical(R.FIELDS.map(key=>stored[key] instanceof Date?stored[key].toISOString():stored[key]))
      !==canonical(R.FIELDS.map(key=>next[key] instanceof Date?next[key].toISOString():next[key])))throw closed();
    return result(stored);
  }
  async function checked(fence,tx,liveLease=true) { return R.assertFence(await get(fence?.attemptId,tx),fence,time(),{liveLease}); }
  async function publication(row,tx) {
    const value=plain(await publicationModel.findByPk(row.attempt_id,options(tx)));
    if(!value||value.receipt_digest!==row.owner_receipt_digest||value.receipt_id!==R.json(row.owner_receipt).receiptId
      ||value.scope_key!==row.scope_key||value.service!=='analytics'||Number(value.clinic_id)!==row.clinic_id||value.asset_ref!==row.asset_ref)R.fail();
    return value;
  }
  async function acquire(row,tx) {
    if(R.TERMINAL.includes(row.state))return result(row);
    if(+row.lease_until>+time())R.fail();
    return save(row,{generation:row.generation+1,lease_token:randomUUID(),lease_until:new Date(+time()+R.LEASE_MS)},tx);
  }
  return Object.freeze({
    prepare(context,input) { return atomic(async tx=>{
      const c=C.input(context),selected=R.selection(c,input);await user(c,tx);
      const previous=plain(await model.findByPk(c.attemptId,options(tx)));
      if(previous){const row=R.bound(previous,c);if(row.selection_digest!==selected.digest)R.fail();return Object.freeze({...result(row),created:false});}
      if(await publicationModel.findByPk(c.attemptId,options(tx)))R.fail();
      const attempt=await user(c,tx),at=time();
      const row=R.record({attempt_id:c.attemptId,crm_intent_id:randomUUID(),dispatch_request_id:randomUUID(),binding_digest:C.bindingDigest(c),
        actor_user_id:c.actorId,session_ref_hash:C.sessionHash(c.sessionRef),session_expires_at:new Date(c.sessionExpiresAt),scope_key:c.scopeKey,
        clinic_ids:canonical(c.clinicIds),clinic_digest:R.digest(c.clinicIds),service:'analytics',clinic_id:selected.clinicId,asset_ref:selected.assetRef,
        selection_digest:selected.digest,attempt_requested_at:attempt.requested_at,attempt_expires_at:attempt.expires_at,
        google_user_id:null,subject_digest:null,claim_digest:null,scope_lock:R.scopeLock(c.scopeKey),subject_lock:null,state:'prepared',revision:0,generation:1,
        lease_token:randomUUID(),lease_until:new Date(+at+R.LEASE_MS),owner_observation:null,owner_observation_digest:null,
        owner_receipt:null,owner_receipt_digest:null,native_resource:null,native_resource_digest:null,sql_publication_digest:null,last_error:null,
        created_at:at,updated_at:at,completed_at:null});
      const saved=R.record(plain(await model.create(row,{transaction:tx,logging:false})));R.bound(saved,c);await user(c,tx);return Object.freeze({...result(saved),created:true});
    });},
    read(context) {return atomic(async tx=>{const c=C.input(context);await user(c,tx,{freshAttempt:false});return result(R.bound(await get(c.attemptId,tx),c));});},
    claimUser(context) {return atomic(async tx=>{const c=C.input(context);await user(c,tx);return acquire(R.bound(await get(c.attemptId,tx),c),tx);});},
    claimRecovery(attemptId) {return atomic(async tx=>{
      const row=await get(attemptId,tx);if(await authorizeRecovery(row,{transaction:tx})!==true)throw C.problem('google_oauth_admission_forbidden',403);
      return acquire(row,tx);
    });},
    dispatch(context,fence,pins) {return atomic(async tx=>{
      const c=C.input(context);await user(c,tx);const row=R.bound(await checked(fence,tx),c);
      if(row.state!=='prepared'||!C.exact(pins,['googleUserId','subjectDigest','claimDigest'])||typeof pins.googleUserId!=='string'
        ||!R.SHA.test(pins.subjectDigest)||!R.SHA.test(pins.claimDigest))R.fail();
      return save(row,{google_user_id:pins.googleUserId,subject_digest:pins.subjectDigest,claim_digest:pins.claimDigest,
        subject_lock:R.subjectLock(pins.subjectDigest),state:'dispatch_pending'},tx);
    });},
    park(fence,error='recovery_pending',{delayMs=0}={}) {return atomic(async tx=>{
      const row=await checked(fence,tx,false);
      if(!['prepared','dispatch_pending','effect_unknown','remote_confirmed','sql_committed','quarantine_pending'].includes(row.state)
        ||!R.SAFE_ERRORS.includes(error)||!Number.isSafeInteger(delayMs)||delayMs<0||delayMs>60000)R.fail();
      return save(row,{lease_until:new Date(+time()+delayMs),last_error:error},tx);
    });},
    unknown(fence) {return atomic(async tx=>{
      const row=await checked(fence,tx,false);if(!['dispatch_pending','effect_unknown','remote_confirmed'].includes(row.state))R.fail();
      return save(row,{state:row.state==='remote_confirmed'?'remote_confirmed':'effect_unknown',last_error:'owner_unknown'},tx);
    });},
    observe(fence,reply) {return atomic(async tx=>{
      const row=await checked(fence,tx,false),observed=R.observation(reply,row);
      if(observed.state==='published'&&row.state!=='sql_committed')R.fail();
      if(!['dispatch_pending','effect_unknown','remote_confirmed','sql_committed','quarantine_pending'].includes(row.state))R.fail();
      const body=canonical(observed),patch={owner_observation:body,owner_observation_digest:R.digest(observed)};
      if(observed.receipt){patch.owner_receipt=canonical(observed.receipt);patch.owner_receipt_digest=observed.receiptDigest;}
      if(observed.state==='confirmed_current'&&['dispatch_pending','effect_unknown'].includes(row.state))patch.state='remote_confirmed';
      if(observed.state==='unknown'&&row.state==='dispatch_pending')patch.state='effect_unknown';
      return save(row,patch,tx);
    });},
    nativeResource(fence,value) {return atomic(async tx=>{
      const row=await checked(fence,tx,false);if(row.state!=='remote_confirmed'||row.owner_receipt===null)R.fail();
      const property=require('../../services/integrations-broker/src/google-property-discovery-contract').projectFirstGA(value,'properties/'+row.asset_ref.slice(4));
      return save(row,{native_resource:canonical(property),native_resource_digest:R.digest(property)},tx);
    });},
    assertForCommit(fence,{transaction}) {return atomic(async tx=>{
      const row=await checked(fence,tx);if(row.state!=='remote_confirmed'||!row.owner_receipt||!row.native_resource||!row.owner_observation
        ||R.json(row.owner_observation).state!=='confirmed_current'||R.json(row.owner_observation).receiptDigest!==row.owner_receipt_digest
        ||+row.attempt_expires_at<=+time()||+row.session_expires_at<=+time()||R.json(row.owner_receipt).validUntil<=+time())R.fail();return row;
    },transaction);},
    markSqlCommitted(fence,{transaction}) {return atomic(async tx=>{
      const row=await checked(fence,tx);if(row.state!=='remote_confirmed'||!row.owner_receipt||!row.native_resource||!row.owner_observation
        ||R.json(row.owner_observation).state!=='confirmed_current'||R.json(row.owner_observation).receiptDigest!==row.owner_receipt_digest
        ||+row.attempt_expires_at<=+time()||+row.session_expires_at<=+time()||R.json(row.owner_receipt).validUntil<=+time())R.fail();
      const saved=await publication(row,tx);return save(row,{state:'sql_committed',sql_publication_digest:R.publicationDigest(saved),last_error:null},tx);
    },transaction);},
    quarantine(fence) {return atomic(async tx=>{
      const row=await checked(fence,tx);if(!['prepared','dispatch_pending','effect_unknown','remote_confirmed','quarantine_pending'].includes(row.state))R.fail();
      // Read the PRIMARY under the same intent lock. A publisher must lock and
      // CAS this intent to commit. SQL unavailable/unknown is never absence.
      if(await publicationModel.findByPk(row.attempt_id,options(tx)))R.fail();
      if(row.state==='prepared')return save(row,{state:'quarantine_pending',last_error:'recovery_pending'},tx);
      return save(row,{state:'quarantine_pending',last_error:'recovery_pending'},tx);
    });},
    completeUnused(fence,reply) {return atomic(async tx=>{
      const row=await checked(fence,tx,false),observed=R.unusedAbort(reply,row);
      if(row.state!=='quarantine_pending'||row.subject_digest!==null||await publicationModel.findByPk(row.attempt_id,options(tx)))R.fail();
      return save(row,{state:'closed_unused',owner_observation:canonical(observed),owner_observation_digest:R.digest(observed),
        completed_at:time(),lease_token:null,lease_until:null,scope_lock:null,subject_lock:null,last_error:'owner_closed'},tx);
    });},
    completeQuarantine(fence,reply) {return atomic(async tx=>{
      const row=await checked(fence,tx,false),observed=R.observation(reply,row);
      if(row.state!=='quarantine_pending'||observed.state!=='quarantined'||await publicationModel.findByPk(row.attempt_id,options(tx)))R.fail();
      return save(row,{state:'quarantined',owner_observation:canonical(observed),owner_observation_digest:R.digest(observed),
        completed_at:time(),lease_token:null,lease_until:null,subject_lock:null,last_error:'owner_closed'},tx);
    });},
    completePublished(fence,reply) {return atomic(async tx=>{
      const row=await checked(fence,tx,false),observed=R.observation(reply,row);
      if(row.state!=='sql_committed'||observed.state!=='published'||!row.owner_receipt
        ||observed.receiptDigest!==row.owner_receipt_digest||R.publicationDigest(await publication(row,tx))!==row.sql_publication_digest
        ||await verifyCommitted(row,{transaction:tx})!==true)R.fail();
      return save(row,{state:'published',owner_observation:canonical(observed),owner_observation_digest:R.digest(observed),completed_at:time(),
        lease_token:null,lease_until:null,scope_lock:null,subject_lock:null,last_error:null},tx);
    });},
  });
}
module.exports={createGoogleOAuthAdmissionRecovery};
