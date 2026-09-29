'use strict';
const {randomUUID}=require('node:crypto');
const S=require('./whatsappAuthorizationState.contract');
const catalog=require('../lib/whatsappActivationCatalog');
const {configuredClient,assertGateway}=require('../lib/whatsappOnboardingBrokerClient');
const {normalizePhoneDigits}=require('../lib/phone');
const {buildWhatsappRoutingAdditionalData,resolveWhatsappChannelRole}=require('../lib/whatsapp-channel-role');
const profile=value=>typeof value==='string'?JSON.parse(value):value;
const coexistence=value=>value?.isOnBizApp===true&&value?.platformType==='CLOUD_API';
const samePhone=(left,right)=>{const a=normalizePhoneDigits(left),b=normalizePhoneDigits(right);return !!a&&a===b;};
function createService({models,audit,states=require('./whatsappAuthorizationState.service'),broker=configuredClient(),
  guard=assertGateway,enabled=()=>process.env.WHATSAPP_ACTIVATION_ENABLED==='true',publish=catalog.write,now=()=>new Date(),
  enqueueTemplates=require('./whatsappActivationTemplates.service').enqueue}={}){
  const db=()=>typeof models==='function'?models():models||require('../../models');
  async function locked(work){
    const sequelize=db().sequelize,connection=await sequelize.connectionManager.getConnection({type:'WRITE'});
    const query=(sql)=>new Promise((resolve,reject)=>connection.query(sql,(error,result)=>error?reject(error):resolve(result)));
    let held=false;
    try{const rows=await query("SELECT GET_LOCK('cc_whatsapp_activation_catalog',5) AS held");
      if(Number(rows[0]?.held)!==1)S.fail('whatsapp_authorization_busy',409);held=true;
      const result=await work();
      const rowsAll=(await db().WhatsappPhoneActivation.findAll({order:[['authorization_id','ASC']],raw:true}))
        .filter(row=>row.state!=='superseded');
      publish({version:1,connections:rowsAll.map(row=>({authorizationId:row.authorization_id,connectionRef:row.connection_ref,
        assetId:row.asset_id,phoneId:row.phone_id,wabaId:row.waba_id,scopeType:row.scope_type,scopeId:row.scope_id,
        clinicIds:row.clinic_ids,sendEnabled:row.state==='active',messageNotBefore:new Date(row.message_not_before).toISOString()}))});
      return result;
    }finally{if(held)await query("SELECT RELEASE_LOCK('cc_whatsapp_activation_catalog')").catch(()=>{});await sequelize.connectionManager.releaseConnection(connection);}
  }
  function metadata(remote){
    const p=remote.profile;
    return {...buildWhatsappRoutingAdditionalData({}, {role:remote.channelRole}),
      // Connecting a group phone makes it available; it does not silently
      // change the sender of clinics which have not selected it.
      brokerManaged:true,requireClinicSelection:remote.scopeKey.startsWith('group:'),activationState:remote.state,
      platformType:p.platformType,isOnBizApp:p.isOnBizApp,whatsappConnectionMode:p.isOnBizApp?'coexistence':'cloud_api',
      registration:{status:p.status==='CONNECTED'?'registered':'pending',phoneStatus:p.status,
        codeVerificationStatus:p.codeVerificationStatus,requiresPin:remote.state==='registration_required'},
      whatsappHealth:{state:remote.state==='active'?'healthy':'pending',can_send:remote.state==='active',
        provider_status:p.status,observed_at:new Date(remote.observedAt).toISOString()},
    };
  }
  async function channelRoleFor(asset,context,options){
    let role=resolveWhatsappChannelRole(asset);
    if(context.scope.type==='clinic'&&db().WhatsappChannelBinding){
      const bindings=await db().WhatsappChannelBinding.findAll({where:{clinic_id:context.scope.id,asset_id:asset.id,is_active:true},
        attributes:['role'],limit:2,...options});
      if(bindings.length>1)S.fail('whatsapp_authorization_conflict',409);
      if(bindings.length===1)role=bindings[0].role;
    }
    return role||'primary';
  }
  async function persist(context,remote,actor){
    if(!remote.profile||remote.flowId!==context.requestId||remote.scopeKey!==context.scope.type+':'+context.scope.id
      ||JSON.stringify(remote.clinicIds)!==JSON.stringify(context.clinicIds))S.fail('whatsapp_onboarding_binding_invalid',503);
    return locked(()=>db().sequelize.transaction(async transaction=>{
      const options={transaction,lock:transaction.LOCK.UPDATE};
      const existing=await db().WhatsappPhoneActivation.findByPk(context.requestId,options);
      let asset,previous=null,rotated=false,replacing=false,previousWabaId=null;
      if(existing){
        if(existing.phone_id!==remote.phoneId||existing.waba_id!==remote.wabaId||existing.scope_type!==context.scope.type
          ||existing.scope_id!==context.scope.id||JSON.stringify(existing.clinic_ids)!==JSON.stringify(context.clinicIds))S.fail('whatsapp_authorization_conflict',409);
        asset=await db().ClinicMetaAsset.findByPk(existing.asset_id,options);
        if(!asset||asset.whatsappAuthorizationId!==context.requestId||asset.phoneNumberId!==remote.phoneId||asset.wabaId!==remote.wabaId
          ||asset.assignmentScope!==context.scope.type||Number(context.scope.type==='group'?asset.grupoClinicaId:asset.clinicaId)!==context.scope.id)S.fail('whatsapp_authorization_conflict',409);
      }else if(context.replacement){
        asset=await db().ClinicMetaAsset.findByPk(context.replacement.assetId,options);
        if(!asset||asset.assetType!=='whatsapp_phone_number'||(asset.whatsappAuthorizationId||null)!==context.replacement.authorizationId
          ||asset.assignmentScope!==context.scope.type||Number(context.scope.type==='group'?asset.grupoClinicaId:asset.clinicaId)!==context.scope.id
          ||(await channelRoleFor(asset,context,options))!==remote.channelRole)S.fail('whatsapp_authorization_conflict',409);
        const active=await db().WhatsappPhoneActivation.findAll({where:{asset_id:asset.id,state:'active'},limit:2,
          transaction,lock:transaction.LOCK.UPDATE});
        replacing=true;previousWabaId=asset.wabaId;
        let oldProfile;
        if(context.replacement.authorizationId===null){
          const metadata=asset.additionalData&&typeof asset.additionalData==='object'?asset.additionalData:{};
          if(active.length||asset.isActive!==true||metadata.whatsappConnectionMode!=='coexistence'
            ||metadata.platformType!=='CLOUD_API'||metadata.isOnBizApp!==true
            ||!samePhone(asset.metaAssetName,remote.profile.displayPhoneNumber)||!coexistence(remote.profile))
            S.fail('whatsapp_reconnection_identity_mismatch',409);
          oldProfile={displayPhoneNumber:asset.metaAssetName,isOnBizApp:true,platformType:'CLOUD_API'};
        }else{
          if(active.length!==1)S.fail('whatsapp_authorization_conflict',409);previous=active[0];
          if(previous.authorization_id!==context.replacement.authorizationId||previous.phone_id!==asset.phoneNumberId
            ||previous.waba_id!==asset.wabaId||previous.scope_type!==context.scope.type||previous.scope_id!==context.scope.id
            ||JSON.stringify(previous.clinic_ids)!==JSON.stringify(context.clinicIds))S.fail('whatsapp_authorization_conflict',409);
          try{oldProfile=profile(previous.profile);}catch{S.fail('whatsapp_authorization_conflict',409);}
        }
        const exact=asset.phoneNumberId===remote.phoneId&&asset.wabaId===remote.wabaId;
        rotated=!exact;
        if(rotated&&(!samePhone(oldProfile?.displayPhoneNumber,remote.profile.displayPhoneNumber)
          ||!coexistence(oldProfile)||!coexistence(remote.profile)))S.fail('whatsapp_reconnection_identity_mismatch',409);
        const collisions=await db().ClinicMetaAsset.findAll({where:{assetType:'whatsapp_phone_number',phoneNumberId:remote.phoneId},
          limit:2,transaction,lock:transaction.LOCK.UPDATE});
        if(collisions.some(value=>value.id!==asset.id))S.fail('whatsapp_authorization_conflict',409);
        if(remote.state!=='active')return {assetId:asset.id,state:remote.state,replacement:true,rotated};
      }else{
        const assets=await db().ClinicMetaAsset.findAll({where:{assetType:'whatsapp_phone_number',phoneNumberId:remote.phoneId},
          limit:2,transaction,lock:transaction.LOCK.UPDATE});
        if(assets.length>1)S.fail('whatsapp_authorization_conflict',409);
        if(assets.length){
          asset=assets[0];
          if(asset.wabaId!==remote.wabaId||asset.assignmentScope!==context.scope.type
            ||Number(context.scope.type==='group'?asset.grupoClinicaId:asset.clinicaId)!==context.scope.id)S.fail('whatsapp_authorization_conflict',409);
          const active=await db().WhatsappPhoneActivation.findAll({where:{asset_id:asset.id,state:'active'},limit:2,
            transaction,lock:transaction.LOCK.UPDATE});
          if(active.length!==1)S.fail('whatsapp_authorization_conflict',409);
          previous=active[0];
          if(previous.phone_id!==remote.phoneId||previous.waba_id!==remote.wabaId||previous.scope_type!==context.scope.type
            ||previous.scope_id!==context.scope.id||JSON.stringify(previous.clinic_ids)!==JSON.stringify(context.clinicIds)
            ||asset.whatsappAuthorizationId!==previous.authorization_id)S.fail('whatsapp_authorization_conflict',409);
          replacing=true;previousWabaId=asset.wabaId;
          if(remote.state!=='active')return {assetId:asset.id,state:remote.state,replacement:true};
        }else{
          asset=await db().ClinicMetaAsset.create({metaConnectionId:null,whatsappAuthorizationId:context.requestId,
            assetType:'whatsapp_phone_number',metaAssetId:remote.phoneId,phoneNumberId:remote.phoneId,wabaId:remote.wabaId,
            assignmentScope:context.scope.type,clinicaId:context.scope.type==='clinic'?context.scope.id:null,
            grupoClinicaId:context.scope.type==='group'?context.scope.id:null,isActive:false,waAccessToken:null,pageAccessToken:null,
          },{transaction});
        }
      }
      if(remote.assetId!==null&&remote.assetId!==asset.id)S.fail('whatsapp_authorization_conflict',409);
      // The broker reply cannot reassign a previously created local identity.
      const state=existing?.state==='active'?'active':remote.state;
      const additionalData={...(asset.additionalData||{}),...metadata({...remote,state})};
      // Keep user-selected role and policies after the first successful activation.
      if(existing?.state==='active'||replacing)for(const key of ['routing','whatsapp_channel_role'])if(asset.additionalData?.[key])additionalData[key]=asset.additionalData[key];
      await asset.update({metaAssetName:remote.profile.displayPhoneNumber,waVerifiedName:remote.profile.verifiedName,
        quality_rating:remote.profile.qualityRating,isActive:state==='active',additionalData,
        ...(replacing?{whatsappAuthorizationId:context.requestId,metaAssetId:remote.phoneId,
          phoneNumberId:remote.phoneId,wabaId:remote.wabaId}:{})},{transaction});
      const values={authorization_id:context.requestId,asset_id:asset.id,scope_type:context.scope.type,scope_id:context.scope.id,
        clinic_ids:context.clinicIds,connection_ref:remote.connectionRef,phone_id:remote.phoneId,waba_id:remote.wabaId,
        state,profile:remote.profile,message_not_before:previous?.message_not_before||(existing?.state==='active'?existing.message_not_before:
          remote.activatedAt?new Date(remote.activatedAt):existing?.message_not_before||now()),updated_by:actor.userId};
      const newlyActive=state==='active'&&existing?.state!=='active';
      if(previous)await previous.update({state:'superseded',updated_by:actor.userId},{transaction});
      if(!existing||newlyActive)await require('./whatsappConnectionAudit').append({db:db(),audit,actor,scope:context.scope,
        requestId:context.requestId,assetIds:[asset.id],action:'integration.whatsapp.activate',
        reason:rotated?'connection_identity_rotated':replacing?'connection_reauthorized':newlyActive?'connection_activated':'catalog_prepared',transaction,now:now()});
      if(existing)await existing.update(values,{transaction});else await db().WhatsappPhoneActivation.create(values,{transaction});
      if(state==='active'&&(!replacing||previousWabaId!==remote.wabaId||context.replacement?.authorizationId===null))
        await enqueueTemplates({activation:values,actor,transaction,models:db()});
      return {assetId:asset.id,state};
    }));
  }
  async function complete(raw){
    guard();if(!enabled())S.fail('whatsapp_onboarding_preparation_disabled',503);
    const input=S.request(raw,'status');let context=await states.resume(input);
    let remote=await broker.profile(context);context=await states.resume(input);
    let local=await persist(context,remote,input);
    if(remote.state!=='active'){
      remote=await broker.activate(context,local.assetId);context=await states.resume(input);
      local=await persist(context,remote,input);
    }
    guard();return {requestId:input.requestId,assetId:local.assetId,state:local.state,connected:local.state==='active',profile:remote.profile};
  }
  return {complete,persist};
}
module.exports={createService,...createService()};
