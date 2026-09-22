'use strict';
const {Op}=require('sequelize');const {randomUUID}=require('node:crypto');
const S=require('./whatsappAuthorizationState.contract');
const {isGlobalAdmin,MARKETING_WRITE_ROLES}=require('../lib/role-helpers');
const roles=require('../lib/whatsapp-channel-role');
function createService({models,sessions,audit,broker=require('../lib/whatsappAuthorizedBrokerClient'),
  scopeBlocks=require('./metaScopeBlock.service'),now=()=>new Date()}={}){
  const db=()=>typeof models==='function'?models():models||require('../../models');
  async function save(raw,actor){
    S.exact(raw,['scope','primaryAssetId','secondaryAssetId','purposes','unavailableAction']);S.exact(raw.scope,['type','id']);
    if(!['clinic','group'].includes(raw.scope.type)||!S.id(raw.scope.id)||!S.id(raw.primaryAssetId)
      ||raw.secondaryAssetId!==null&&!S.id(raw.secondaryAssetId)||raw.primaryAssetId===raw.secondaryAssetId
      ||!Array.isArray(raw.purposes)||raw.purposes.length>3||raw.purposes.some(p=>!roles.WHATSAPP_SECONDARY_PURPOSES.includes(p))
      ||new Set(raw.purposes).size!==raw.purposes.length||!roles.WHATSAPP_SECONDARY_UNAVAILABLE_ACTIONS.includes(raw.unavailableAction)
      ||raw.secondaryAssetId===null&&raw.purposes.length)S.fail();
    S.request({...actor,requestId:randomUUID()},'status');
    return db().sequelize.transaction(async transaction=>{
      const locked={transaction,lock:transaction.LOCK.UPDATE};
      await (sessions||require('./accessSession.service')).verifyReference({userId:actor.userId,sessionRef:actor.sessionRef,
        expiresAt:new Date(actor.sessionExpiresAt*1000)},{transaction});
      const clinics=await db().Clinica.findAll({...locked,where:raw.scope.type==='clinic'?{id_clinica:raw.scope.id}:{grupoClinicaId:raw.scope.id},
        attributes:['id_clinica','grupoClinicaId'],order:[['id_clinica','ASC']],raw:true,limit:1001});
      if(!clinics.length||clinics.length>1000)S.fail('whatsapp_authorization_forbidden',403);
      const ids=clinics.map(c=>c.id_clinica);
      if(!isGlobalAdmin(actor.userId)){
        const memberships=await db().UsuarioClinica.findAll({...locked,where:{id_usuario:actor.userId,id_clinica:{[Op.in]:ids},
          rol_clinica:{[Op.in]:MARKETING_WRITE_ROLES},[Op.or]:[{estado_invitacion:'aceptada'},{estado_invitacion:null}]},attributes:['id_clinica'],raw:true});
        if(ids.some(id=>!memberships.some(m=>m.id_clinica===id)))S.fail('whatsapp_authorization_forbidden',403);
      }
      if(await scopeBlocks.blocked(raw.scope.type==='clinic'?{assignmentScope:'clinic',clinicId:raw.scope.id}:
        {assignmentScope:'group',groupId:raw.scope.id},{models:db(),transaction,purpose:'whatsapp'}))S.fail('whatsapp_authorization_forbidden',403);
      const selected=[raw.primaryAssetId,raw.secondaryAssetId].filter(Boolean);
      const assets=await db().ClinicMetaAsset.findAll({...locked,where:{id:{[Op.in]:selected}},order:[['id','ASC']]});
      for(const id of selected){
        const a=assets.find(a=>a.id===id);
        const own=a&&a.assetType==='whatsapp_phone_number'&&(raw.scope.type==='group'?
          a.assignmentScope==='group'&&Number(a.grupoClinicaId)===raw.scope.id:
          a.assignmentScope==='clinic'&&Number(a.clinicaId)===raw.scope.id||a.assignmentScope==='group'&&Number(a.grupoClinicaId)===Number(clinics[0].grupoClinicaId));
        if(!own||ids.some(clinicId=>!broker.bindingsForClinic(clinicId).some(b=>b.assetId===id&&b.phoneId===a.phoneNumberId&&b.wabaId===a.wabaId&&b.sendEnabled===true)))S.fail('whatsapp_authorization_forbidden',403);
      }
      if(raw.scope.type==='clinic'){
        // Replacing the complete selection is atomic, including disabling the
        // secondary. Assets themselves keep their group/clinic assignment.
        await db().WhatsappChannelBinding.destroy({where:{clinic_id:raw.scope.id},transaction});
        for(const [index,id] of selected.entries())await db().WhatsappChannelBinding.create({clinic_id:raw.scope.id,asset_id:id,
          role:index?'secondary':'primary',purposes:index?raw.purposes:[],unavailable_action:index?raw.unavailableAction:'pause',
          is_active:true,created_by:actor.userId,updated_by:actor.userId},{transaction});
      }else{
        const all=await db().ClinicMetaAsset.findAll({...locked,where:{assetType:'whatsapp_phone_number',assignmentScope:'group',grupoClinicaId:raw.scope.id},order:[['id','ASC']]});
        for(const a of all){
          const index=selected.indexOf(a.id),current=a.additionalData||{};
          const data=index<0?{...current,routing_disabled:true}:{...roles.buildWhatsappRoutingAdditionalData(current,
            {role:index?'secondary':'primary',purposes:index?raw.purposes:[],unavailableAction:raw.unavailableAction}),routing_disabled:false};
          await a.update({additionalData:data},{transaction});
        }
      }
      await require('./whatsappConnectionAudit').append({db:db(),audit,actor,scope:raw.scope,requestId:randomUUID(),assetIds:selected,
        action:'integration.whatsapp.routing',reason:'routing_saved',transaction,now:now()});
      return {success:true,primaryAssetId:raw.primaryAssetId,secondaryAssetId:raw.secondaryAssetId};
    });
  }
  return {save};
}
module.exports={createService,...createService()};
