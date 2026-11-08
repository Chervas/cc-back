'use strict';
const C=require('./metaMarketingOAuth.contract');
const {hasMarketingClinicScopeAccess}=require('../lib/marketingScopeAccess');
function createScope({models,sessions,now=()=>new Date(),recoveryGuard}){
  const recovery=recoveryGuard||require('./metaMarketingLegacyRecovery.service').createRecovery({models,sessions,now});
  async function authorize({scopeKey,actorId,sessionRef,sessionExpiresAt},transaction){
    if(!transaction||typeof scopeKey!=='string'||!/^(clinic|group):[1-9][0-9]{0,9}$/.test(scopeKey)||!C.positive(actorId))C.fail('meta_oauth_scope_invalid',400);
    try{await sessions.verifyReference({userId:actorId,sessionRef,expiresAt:sessionExpiresAt},{transaction,requireEmail:true});}
    catch(e){
      if(e?.code==='auth_email_verification_required')C.fail(e.code,403);
      // Storage/audit failure denies the operation without invalidating login.
      const invalid=['JsonWebTokenError','TokenExpiredError','NotBeforeError'].includes(e?.name)||e?.code==='auth_invalid';
      const denied=e?.status===403||e?.httpStatus===403;
      C.fail(invalid?'meta_oauth_session_required':denied?'meta_oauth_scope_forbidden':'meta_oauth_unavailable',invalid?401:denied?403:503);
    }
    const [type,value]=scopeKey.split(':'),id=Number(value);if(!C.positive(id))C.fail('meta_oauth_scope_invalid',400);
    const options={transaction,lock:transaction.LOCK.UPDATE,raw:true,logging:false};
    const clinics=await models.Clinica.findAll({...options,attributes:['id_clinica'],where:type==='group'?{grupoClinicaId:id}:{id_clinica:id},order:[['id_clinica','ASC']],limit:1001});
    if(!clinics.length||clinics.length>1000)C.fail('meta_oauth_scope_changed',409);const clinicIds=clinics.map(r=>Number(r.id_clinica));
    if(!await hasMarketingClinicScopeAccess({userId:actorId,clinicIds,access:'write',membershipModel:{findAll:opts=>models.UsuarioClinica.findAll({...opts,...options})}}))C.fail('meta_oauth_scope_forbidden',403);
    return {scopeKey,clinicIds,actorId,sessionRef,sessionExpiresAt,options};
  }
  async function captureStructure(authorized,{flow=null,phase='pending',allowExpiredCredential=false}={}){
    const {scopeKey,clinicIds,options}=authorized;
    const raw=await models.MetaMarketingOAuthSlot.findByPk(scopeKey,options);if(!raw)return {...authorized,slot:null};
    const slot=C.slot(raw);if(slot.state!=='active'||+slot.expires_at<=+now()||JSON.stringify(clinicIds)!==slot.clinic_ids)C.fail('meta_oauth_scope_changed',409);
    const proof=flow?await recovery.forFlow(flow,options.transaction,{phase,allowExpiredCredential}):await recovery.inspectPrepared({scopeKey,clinicIds,appId:slot.app_id,
      actorId:authorized.actorId,sessionRef:authorized.sessionRef,sessionExpiresAt:authorized.sessionExpiresAt},options.transaction);
    const [assignmentScope,scopeId]=scopeKey.split(':');
    // A raw tombstone remains universal. Only a fresh, root-prepared generation
    // can authorize its exact non-WhatsApp scope; legacy readers keep the block.
    if(await require('./metaScopeBlock.service').blocked({assignmentScope,clinicId:assignmentScope==='clinic'?Number(scopeId):null,
      groupId:assignmentScope==='group'?Number(scopeId):null},{models,transaction:options.transaction,purpose:'meta'})&&!proof)C.fail('meta_oauth_scope_blocked',409);
    const revocations=await models.MetaMarketingBrokerRevocation.findAll({...options,attributes:['tuple_hash'],where:{scope_key:scopeKey},order:[['tuple_hash','ASC']],limit:1001});
    if(revocations.length>1000)C.fail();
    const pieces=[C.slotDigest(slot),clinicIds,revocations.map(r=>r.tuple_hash)];
    if(proof)pieces.push(proof.immutableDigest);
    return {...authorized,slot,recovery:proof,slotDigest:C.slotDigest(slot),scopeDigest:C.hash(JSON.stringify(pieces))};
  }
  const capture=async(actor,transaction)=>captureStructure(await authorize(actor,transaction));
  function compare(row,fresh){
    if(!fresh.slot||fresh.slotDigest!==row.slot_digest||fresh.scopeDigest!==row.scope_digest||JSON.stringify(fresh.clinicIds)!==row.clinic_ids
      ||['scope_key','connection_ref','asset_ref','app_id','clinic_ids','scopes','redirect_uri'].some(k=>row[k]!==fresh.slot[k]))C.fail('meta_oauth_scope_changed',409);
    return fresh;
  }
  async function revalidate(row,transaction){
    const authorized=await authorize({scopeKey:row.scope_key,actorId:Number(row.actor_user_id),sessionRef:row.session_ref,sessionExpiresAt:row.session_expires_at},transaction);
    return compare(row,await captureStructure(authorized,{flow:row}));
  }
  async function revalidateStructure(row,transaction,{allowExpiredCredential=false}={}){
    // A confirmed clinic connection outlives the user's login. This internal
    // structural guard never authorizes a human request or a pending activation.
    if(!transaction||!/^(clinic|group):[1-9][0-9]{0,9}$/.test(row.scope_key))C.fail();
    const [kind,id]=row.scope_key.split(':'),options={transaction,lock:transaction.LOCK.UPDATE,raw:true,logging:false};
    const clinics=await models.Clinica.findAll({...options,attributes:['id_clinica'],where:kind==='group'?{grupoClinicaId:Number(id)}:{id_clinica:Number(id)},order:[['id_clinica','ASC']],limit:1001});
    if(!clinics.length||clinics.length>1000)C.fail('meta_oauth_scope_changed',409);
    return compare(row,await captureStructure({scopeKey:row.scope_key,clinicIds:clinics.map(v=>Number(v.id_clinica)),options},{flow:row,phase:'active',allowExpiredCredential}));
  }
  return {authorize,capture,revalidate,revalidateStructure};
}
module.exports={createScope};
