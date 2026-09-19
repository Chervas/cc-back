'use strict';
const {Op}=require('sequelize'),C=require('./metaMarketingOAuth.contract');
const {hasMarketingClinicScopeAccess}=require('../lib/marketingScopeAccess');
function createScope({models,sessions,now=()=>new Date()}){
  async function authorize({scopeKey,actorId,sessionRef,sessionExpiresAt},transaction){
    if(!transaction||typeof scopeKey!=='string'||!/^(clinic|group):[1-9][0-9]{0,9}$/.test(scopeKey)||!C.positive(actorId))C.fail('meta_oauth_scope_invalid',400);
    try{await sessions.verifyReference({userId:actorId,sessionRef,expiresAt:sessionExpiresAt},{transaction,requireEmail:true});}
    catch(e){C.fail(e.code==='auth_email_verification_required'?e.code:'meta_oauth_session_required',e.code==='auth_email_verification_required'?403:401);}
    const [type,value]=scopeKey.split(':'),id=Number(value);if(!C.positive(id))C.fail('meta_oauth_scope_invalid',400);
    const options={transaction,lock:transaction.LOCK.UPDATE,raw:true,logging:false};
    const clinics=await models.Clinica.findAll({...options,attributes:['id_clinica'],where:type==='group'?{grupoClinicaId:id}:{id_clinica:id},order:[['id_clinica','ASC']],limit:1001});
    if(!clinics.length||clinics.length>1000)C.fail('meta_oauth_scope_changed',409);const clinicIds=clinics.map(r=>Number(r.id_clinica));
    if(!await hasMarketingClinicScopeAccess({userId:actorId,clinicIds,access:'write',membershipModel:{findAll:opts=>models.UsuarioClinica.findAll({...opts,...options})}}))C.fail('meta_oauth_scope_forbidden',403);
    return {scopeKey,clinicIds,options};
  }
  async function capture(actor,transaction){
    const authorized=await authorize(actor,transaction),{scopeKey,clinicIds,options}=authorized;
    const raw=await models.MetaMarketingOAuthSlot.findByPk(scopeKey,options);if(!raw)return {...authorized,slot:null};
    const slot=C.slot(raw);if(slot.state!=='active'||+slot.expires_at<=+now()||JSON.stringify(clinicIds)!==slot.clinic_ids)C.fail('meta_oauth_scope_changed',409);
    const refs=['meta:'+scopeKey,...clinicIds.map(id=>'meta:clinic:'+id)];
    const blocks=await models.MetaScopeBlock.findAll({...options,attributes:['scope_key'],where:{scope_key:{[Op.in]:refs}},limit:1});
    if(blocks.length)C.fail('meta_oauth_scope_blocked',409);
    const revocations=await models.MetaMarketingBrokerRevocation.findAll({...options,attributes:['tuple_hash'],where:{scope_key:scopeKey},order:[['tuple_hash','ASC']],limit:1001});
    if(revocations.length>1000)C.fail();
    return {...authorized,slot,slotDigest:C.slotDigest(slot),scopeDigest:C.hash(JSON.stringify([C.slotDigest(slot),clinicIds,revocations.map(r=>r.tuple_hash)]))};
  }
  async function revalidate(row,transaction){
    const fresh=await capture({scopeKey:row.scope_key,actorId:Number(row.actor_user_id),sessionRef:row.session_ref,sessionExpiresAt:row.session_expires_at},transaction);
    if(!fresh.slot||fresh.slotDigest!==row.slot_digest||fresh.scopeDigest!==row.scope_digest||JSON.stringify(fresh.clinicIds)!==row.clinic_ids
      ||['scope_key','connection_ref','asset_ref','app_id','clinic_ids','scopes','redirect_uri'].some(k=>row[k]!==fresh.slot[k]))C.fail('meta_oauth_scope_changed',409);
    return fresh;
  }
  return {authorize,capture,revalidate};
}
module.exports={createScope};
