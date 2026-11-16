'use strict';
const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');const {DataTypes:D}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async({sql,models,report})=>{
  const qi=sql.getQueryInterface();
  async function table(name,tableName,fields){models[name]=sql.define(name,fields,{tableName,timestamps:false});await models[name].sync();}
  await table('Clinica','Clinicas',{id_clinica:{type:D.INTEGER,primaryKey:true},grupoClinicaId:D.INTEGER});
  await table('GrupoClinica','GruposClinicas',{id_grupo:{type:D.INTEGER,primaryKey:true}});
  await table('MetaConnection','MetaConnections',{id:{type:D.INTEGER,primaryKey:true}});
  await table('UsuarioClinica','UsuariosClinicas',{id:{type:D.INTEGER,primaryKey:true,autoIncrement:true},id_usuario:D.INTEGER,id_clinica:D.INTEGER,rol_clinica:D.STRING,estado_invitacion:D.STRING});
  models.ClinicMetaAsset=require('../../../models/ClinicMetaAsset')(sql,D);
  models.ClinicMetaAsset.removeAttribute('whatsappAuthorizationId');models.ClinicMetaAsset.rawAttributes.metaConnectionId.allowNull=false;models.ClinicMetaAsset.refreshAttributes();await models.ClinicMetaAsset.sync();
  for(const file of ['20260912210000-create-platform-audit-events','20260913003000-add-platform-audit-result-part'])await require('../../../migrations/'+file).up(qi,D);
  const migration=require('../../../migrations/20260922153000-create-whatsapp-phone-activations');
  await migration.up(qi,D);await migration.up(qi,D);await migration.down(qi);await migration.up(qi,D);
  const historyMigration=require('../../../migrations/20260925113000-whatsapp-activation-history');
  await historyMigration.up(qi,D);await historyMigration.up(qi,D);await historyMigration.down(qi);await historyMigration.up(qi,D);
  models.ClinicMetaAsset=require('../../../models/ClinicMetaAsset')(sql,D);
  models.WhatsappPhoneActivation=require('../../../models/whatsappphoneactivation')(sql,D);
  await table('ActivationTestJob','ActivationTestJobs',{authorization_id:{type:D.STRING(36),primaryKey:true},waba_id:D.STRING(30)});
  if(process.env.WHATSAPP_ACTIVATION_SCHEMA_OUTPUT){
    const snapshot=await require('../../lib/securitySchemaContract').snapshot(async(q,p)=>(await sql.query(q,{replacements:p}))[0]);
    const table=name=>{const metadata=snapshot.tables.find(t=>t.TABLE_NAME===name);return {
      ENGINE:metadata.ENGINE,TABLE_COLLATION:metadata.TABLE_COLLATION,columns:snapshot.columns.filter(c=>c.TABLE_NAME===name).map(({TABLE_NAME,...c})=>c),
      indexes:[...new Set(snapshot.indexes.filter(i=>i.TABLE_NAME===name).map(i=>i.INDEX_NAME))].map(nameIndex=>({name:nameIndex,columns:snapshot.indexes.filter(i=>i.TABLE_NAME===name&&i.INDEX_NAME===nameIndex).map(({TABLE_NAME,...i})=>i)})),
      foreignKeys:snapshot.foreignKeys.filter(i=>i.TABLE_NAME===name).map(({TABLE_NAME,...i})=>i)};};
    require('node:fs').writeFileSync(process.env.WHATSAPP_ACTIVATION_SCHEMA_OUTPUT,JSON.stringify({WhatsappPhoneActivations:table('WhatsappPhoneActivations'),ClinicMetaAssets:table('ClinicMetaAssets')},null,2),{mode:0o600});
  }
  models.WhatsappChannelBinding=require('../../../models/whatsappchannelbinding')(sql,D);await models.WhatsappChannelBinding.sync();
  await qi.addIndex('WhatsappChannelBindings',['clinic_id','role'],{unique:true});await qi.addIndex('WhatsappChannelBindings',['clinic_id','asset_id'],{unique:true});
  models.PlatformAuditEvent=require('../../../models/platformauditevent')(sql,D);
  await models.GrupoClinica.create({id_grupo:9});await models.MetaConnection.create({id:1});
  await models.Clinica.bulkCreate([{id_clinica:71,grupoClinicaId:9},{id_clinica:72,grupoClinicaId:9},{id_clinica:73,grupoClinicaId:null}]);
  await models.UsuarioClinica.bulkCreate([71,72].map(id_clinica=>({id_usuario:501,id_clinica,rol_clinica:'propietario',estado_invitacion:'aceptada'})));
  const actor={userId:501,sessionRef:randomUUID(),sessionExpiresAt:Math.floor(Date.now()/1000)+3600};
  const context={requestId:randomUUID(),scope:{type:'group',id:9},clinicIds:[71,72]};
  const A=require('../../../services/integrations-broker/src/whatsapp-activation-contract');
  const remote={flowId:context.requestId,connectionRef:A.connectionRef(context.requestId),scopeKey:'group:9',clinicIds:[71,72],phoneId:'401',wabaId:'301',
    channelRole:'primary',assetId:null,state:'prepared',observedAt:Date.now(),activatedAt:null,profile:{phoneId:'401',displayPhoneNumber:'+34000000000',verifiedName:'QA',status:'PENDING',codeVerificationStatus:'VERIFIED',qualityRating:'UNKNOWN',platformType:'NOT_APPLICABLE',isOnBizApp:false}};
  let activations=0,published=null,denyAudit=false,denyTemplateJob=false;
  const audit=require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const injectedAudit={health:(...a)=>audit.health(...a),append:(...a)=>{if(denyAudit)throw Error('AUDIT_OFFLINE');return audit.append(...a)}};
  const make=()=>require('../../services/whatsappPhoneActivation.service').createService({models,audit:injectedAudit,guard:()=>{},enabled:()=>true,
    states:{resume:async()=>context},publish:value=>{published=value},enqueueTemplates:async({activation,transaction})=>{if(denyTemplateJob)throw Error('TEMPLATE_JOB_UNAVAILABLE');await models.ActivationTestJob.findOrCreate({where:{authorization_id:activation.authorization_id},defaults:{waba_id:activation.waba_id},transaction});},broker:{profile:async()=>({...remote}),activate:async(c,assetId)=>{
      activations++;remote.assetId=assetId;remote.state='active';remote.activatedAt=Date.now();remote.profile={...remote.profile,status:'CONNECTED',platformType:'CLOUD_API'};return {...remote};}}});
  let asset;
  if(process.env.WHATSAPP_ROUTING_ONLY_TEST==='true'){
    asset=await models.ClinicMetaAsset.create({metaConnectionId:1,assetType:'whatsapp_phone_number',metaAssetId:'401',phoneNumberId:'401',wabaId:'301',assignmentScope:'group',grupoClinicaId:9,isActive:true,additionalData:{requireClinicSelection:true}});
    report.checks.push('Routing-only cohort: gateway activation acceptance is not exercised');
  }else{
  denyTemplateJob=true;await assert.rejects(make().complete({...actor,requestId:context.requestId}),/TEMPLATE_JOB_UNAVAILABLE/);
  assert.equal((await models.WhatsappPhoneActivation.findByPk(context.requestId)).state,'prepared');assert.equal(await models.ActivationTestJob.count(),0);denyTemplateJob=false;
  const result=await make().complete({...actor,requestId:context.requestId});assert.equal(result.connected,true);assert.equal(activations,1);
  asset=await models.ClinicMetaAsset.findByPk(result.assetId);assert.equal(asset.metaConnectionId,null);assert.equal(asset.waAccessToken,null);assert.equal(asset.additionalData.requireClinicSelection,true);
  const cutoff=published.connections[0].messageNotBefore;
  await asset.update({additionalData:{...asset.additionalData,whatsappManualDisconnect:{state:'disconnected'}}});
  await make().complete({...actor,requestId:context.requestId});assert.equal(activations,1);assert.equal(await models.WhatsappPhoneActivation.count(),1);assert.equal(published.connections[0].messageNotBefore,cutoff);
  assert.equal((await models.ClinicMetaAsset.findByPk(asset.id)).additionalData.whatsappManualDisconnect.state,'disconnected');
  assert.equal(await models.PlatformAuditEvent.count(),2);assert.equal(await models.ActivationTestJob.count(),1);
  const previousAuthorization=context.requestId;context.requestId=randomUUID();remote.flowId=context.requestId;
  remote.connectionRef=A.connectionRef(context.requestId);remote.assetId=null;remote.state='prepared';remote.activatedAt=null;
  const renewed=await make().complete({...actor,requestId:context.requestId});assert.equal(renewed.assetId,asset.id);assert.equal(renewed.connected,true);assert.equal(activations,2);
  assert.equal((await models.ClinicMetaAsset.findByPk(asset.id)).whatsappAuthorizationId,context.requestId);
  assert.equal((await models.ClinicMetaAsset.findByPk(asset.id)).additionalData.whatsappManualDisconnect,undefined);
  assert.equal((await models.WhatsappPhoneActivation.findByPk(previousAuthorization)).state,'superseded');
  assert.equal((await models.WhatsappPhoneActivation.findByPk(context.requestId)).state,'active');
  assert.equal(await models.WhatsappPhoneActivation.count(),2);assert.equal(published.connections.length,1);
  assert.equal(published.connections[0].authorizationId,context.requestId);assert.equal(published.connections[0].assetId,asset.id);
  assert.equal(published.connections[0].messageNotBefore,cutoff);assert.equal(await models.ActivationTestJob.count(),1);
  const renewedAuthorization=context.requestId;
  const renewedActivation=await models.WhatsappPhoneActivation.findByPk(renewedAuthorization);
  await renewedActivation.update({profile:{...renewedActivation.profile,isOnBizApp:true,platformType:'CLOUD_API',status:'CONNECTED'}});
  context.requestId=randomUUID();context.replacement={assetId:asset.id,authorizationId:renewedAuthorization,phoneDigest:'0'.repeat(64)};
  remote.flowId=context.requestId;remote.connectionRef=A.connectionRef(context.requestId);remote.assetId=null;remote.state='prepared';remote.activatedAt=null;
  remote.phoneId='501';remote.wabaId='601';remote.profile={...remote.profile,phoneId:'501',displayPhoneNumber:'+34999999999',
    status:'CONNECTED',platformType:'CLOUD_API',isOnBizApp:true};
  await assert.rejects(make().complete({...actor,requestId:context.requestId}),/whatsapp_reconnection_identity_mismatch/);
  assert.equal((await models.ClinicMetaAsset.findByPk(asset.id)).phoneNumberId,'401');
  assert.equal((await models.WhatsappPhoneActivation.findByPk(renewedAuthorization)).state,'active');
  context.requestId=randomUUID();remote.flowId=context.requestId;remote.connectionRef=A.connectionRef(context.requestId);
  remote.profile={...remote.profile,displayPhoneNumber:'+34000000000'};
  const rotated=await make().complete({...actor,requestId:context.requestId});assert.equal(rotated.assetId,asset.id);assert.equal(rotated.connected,true);
  asset=await models.ClinicMetaAsset.findByPk(asset.id);assert.equal(asset.phoneNumberId,'501');assert.equal(asset.wabaId,'601');
  assert.equal(asset.whatsappAuthorizationId,context.requestId);assert.equal(await models.ActivationTestJob.count(),2);
  assert.equal((await models.WhatsappPhoneActivation.findByPk(renewedAuthorization)).state,'superseded');
  assert.equal(published.connections[0].phoneId,'501');assert.equal(published.connections[0].wabaId,'601');
  assert.equal(published.connections[0].messageNotBefore,cutoff);
  const groupAsset=asset;
  const legacyAsset=await models.ClinicMetaAsset.create({metaConnectionId:1,assetType:'whatsapp_phone_number',metaAssetId:'701',
    metaAssetName:'+34 682 14 52 82',phoneNumberId:'701',wabaId:'801',assignmentScope:'clinic',clinicaId:73,isActive:true,
    additionalData:{whatsappConnectionMode:'coexistence',platformType:'CLOUD_API',isOnBizApp:true,whatsapp_channel_role:'primary'}});
  context.scope={type:'clinic',id:73};context.clinicIds=[73];context.replacement={assetId:legacyAsset.id,authorizationId:null,phoneDigest:'0'.repeat(64)};
  context.requestId=randomUUID();remote.flowId=context.requestId;remote.connectionRef=A.connectionRef(context.requestId);remote.scopeKey='clinic:73';remote.clinicIds=[73];
  remote.phoneId='702';remote.wabaId='802';remote.assetId=null;remote.state='prepared';remote.activatedAt=null;
  remote.profile={...remote.profile,phoneId:'702',displayPhoneNumber:'+34600000000',status:'CONNECTED',platformType:'CLOUD_API',isOnBizApp:true};
  await assert.rejects(make().complete({...actor,requestId:context.requestId}),/whatsapp_reconnection_identity_mismatch/);
  assert.equal((await legacyAsset.reload()).phoneNumberId,'701');assert.equal(await models.WhatsappPhoneActivation.count({where:{asset_id:legacyAsset.id}}),0);
  context.requestId=randomUUID();remote.flowId=context.requestId;remote.connectionRef=A.connectionRef(context.requestId);
  remote.profile={...remote.profile,displayPhoneNumber:'+34 682 14 52 82'};
  const adopted=await make().complete({...actor,requestId:context.requestId});assert.equal(adopted.assetId,legacyAsset.id);assert.equal(adopted.connected,true);
  await legacyAsset.reload();assert.equal(legacyAsset.phoneNumberId,'702');assert.equal(legacyAsset.wabaId,'802');
  assert.equal(legacyAsset.whatsappAuthorizationId,context.requestId);assert.equal((await models.WhatsappPhoneActivation.findByPk(context.requestId)).state,'active');
  asset=groupAsset;context.scope={type:'group',id:9};context.clinicIds=[71,72];delete context.replacement;
  await assert.rejects(historyMigration.down(qi),/Preserve WhatsApp activation history/);
  await assert.rejects(models.ClinicMetaAsset.create({assetType:'ad_account',metaAssetId:'701',metaConnectionId:null}));
  await assert.rejects(migration.down(qi),/Preserve WhatsApp/);
  report.checks.push('Migration up/up/down/up, exact renewal, native ID rotation and legacy coexistence adoption; another visible phone is rejected without mutating the active asset, routing cutoff remains immutable');
  }
  if(process.env.WHATSAPP_ROUTING_ONLY_TEST!=='true'){
    const inactiveLegacy=await models.ClinicMetaAsset.create({metaConnectionId:1,assetType:'whatsapp_phone_number',metaAssetId:'901',
      metaAssetName:'+34 600 000 901',phoneNumberId:'901',wabaId:'902',assignmentScope:'clinic',clinicaId:73,isActive:false,
      additionalData:{whatsappConnectionMode:'coexistence',platformType:'CLOUD_API',isOnBizApp:true,whatsapp_channel_role:'primary',
        requireClinicSelection:true,routing:{purposes:['review_requests'],unavailableAction:'pause'},customLegacyMetadata:{preserved:true}}});
    const receipt={requestId:randomUUID(),scope:{type:'clinic',id:73},clinicIds:[73],channelRole:'primary',mode:'coexistence'};
    const candidate={...remote,flowId:receipt.requestId,connectionRef:A.connectionRef(receipt.requestId),scopeKey:'clinic:73',clinicIds:[73],
      phoneId:'901',wabaId:'902',assetId:null,state:'prepared',activatedAt:null,
      profile:{...remote.profile,phoneId:'901',displayPhoneNumber:'+34600000901',status:'CONNECTED',platformType:'CLOUD_API',isOnBizApp:true}};
    await inactiveLegacy.reload();
    const receiptBefore=JSON.stringify(receipt),legacyBefore=JSON.stringify(inactiveLegacy.toJSON()),legacyFields=inactiveLegacy.toJSON();
    const otherPhones=async()=>JSON.stringify((await models.ClinicMetaAsset.findAll({order:[['id','ASC']],raw:true})).filter(row=>row.id!==inactiveLegacy.id));
    const otherPhonesBefore=await otherPhones(),activatedAt=Date.now()-1234;let proof,legacyActivations=0;
    const adopt=require('../../services/whatsappPhoneActivation.service').createService({models,audit:injectedAudit,guard:()=>{},enabled:()=>true,
      states:{resume:async()=>receipt},publish:value=>{published=value},enqueueTemplates:async({activation,transaction})=>{
        if(denyTemplateJob)throw Error('TEMPLATE_JOB_UNAVAILABLE');
        await models.ActivationTestJob.findOrCreate({where:{authorization_id:activation.authorization_id},defaults:{waba_id:activation.waba_id},transaction});},
      broker:{profile:async()=>({...candidate}),activate:async(c,assetId,legacyPhoneDigest)=>{
        legacyActivations++;proof=legacyPhoneDigest;candidate.assetId=assetId;candidate.state='active';candidate.activatedAt=activatedAt;return {...candidate};}}});
    const candidateFields=structuredClone(candidate),receiptFields=structuredClone(receipt);
    const rejectLegacy=async label=>{
      const before=JSON.stringify((await inactiveLegacy.reload()).toJSON());
      await assert.rejects(adopt.persist(receipt,candidate,actor),{code:'whatsapp_authorization_conflict'},label);
      assert.equal(JSON.stringify((await inactiveLegacy.reload()).toJSON()),before,label+' preserves legacy row');
      assert.equal(await models.ActivationTestJob.count({where:{authorization_id:receipt.requestId}}),0,label+' creates no template job');
    };
    for(const [label,patch] of [
      ['already active',{isActive:true}],['authorization exists',{whatsappAuthorizationId:randomUUID()}],
      ['different displayed number',{metaAssetName:'+34600000999'}],['missing displayed number',{metaAssetName:null}],
      ['wrong local role',{additionalData:{...legacyFields.additionalData,whatsapp_channel_role:'secondary'}}],
      ['wrong local coexistence',{additionalData:{...legacyFields.additionalData,isOnBizApp:false}}],
      ...['brokerManaged','activationState','whatsappManualDisconnect','whatsappArchive','routing_disabled']
        .flatMap(key=>[true,null,false].map(value=>[key+'='+value,{additionalData:{...legacyFields.additionalData,[key]:value}}])),
    ]){
      await inactiveLegacy.update(patch,{silent:true});await rejectLegacy(label);
      await inactiveLegacy.update({isActive:false,whatsappAuthorizationId:null,metaAssetName:legacyFields.metaAssetName,
        additionalData:legacyFields.additionalData},{silent:true});
    }
    for(const [label,patch] of [['different broker asset',{assetId:inactiveLegacy.id+10000}],
      ['wrong remote role',{channelRole:'secondary'}],['wrong remote coexistence',{profile:{...candidateFields.profile,isOnBizApp:false}}],
      ['unknown remote platform',{profile:{...candidateFields.profile,platformType:null}}],['missing activation time',{state:'active',assetId:inactiveLegacy.id,activatedAt:null}],
      ['active broker missing asset',{state:'active',assetId:null,activatedAt:Date.now()}]]){
      Object.assign(candidate,patch);await rejectLegacy(label);Object.assign(candidate,structuredClone(candidateFields));
    }
    for(const mode of [undefined,'cloud_api']){
      receipt.mode=mode;await rejectLegacy('non-coexistence receipt');Object.assign(receipt,receiptFields);
    }
    receipt.channelRole='secondary';await rejectLegacy('changed signed role');Object.assign(receipt,receiptFields);
    for(const state of ['prepared','active','archived','superseded']){
      const historyId=randomUUID();await models.WhatsappPhoneActivation.create({authorization_id:historyId,asset_id:inactiveLegacy.id,
        scope_type:'clinic',scope_id:73,clinic_ids:[73],connection_ref:A.connectionRef(historyId),phone_id:'901',waba_id:'902',state,
        profile:candidate.profile,message_not_before:new Date(),updated_by:actor.userId});
      await rejectLegacy(state+' activation history');await models.WhatsappPhoneActivation.destroy({where:{authorization_id:historyId}});
    }
    for(const route of [{clinic_id:71,role:'primary'},{clinic_id:73,role:'secondary'}]){
      const binding=await models.WhatsappChannelBinding.create({asset_id:inactiveLegacy.id,...route});
      await rejectLegacy('incompatible active binding');await binding.destroy();
    }
    const prepared=await adopt.persist(receipt,candidate,actor);
    assert.equal(prepared.assetId,inactiveLegacy.id);assert.equal(prepared.state,'prepared');
    assert.equal(JSON.stringify((await inactiveLegacy.reload()).toJSON()),legacyBefore);
    assert.equal(await models.WhatsappPhoneActivation.count({where:{asset_id:inactiveLegacy.id}}),0);
    const auditsBefore=await models.PlatformAuditEvent.count(),catalogBefore=JSON.stringify(published);
    denyAudit=true;await assert.rejects(adopt.complete({...actor,requestId:receipt.requestId}),/AUDIT_OFFLINE/);denyAudit=false;
    assert.equal(JSON.stringify((await inactiveLegacy.reload()).toJSON()),legacyBefore);
    assert.equal(await models.WhatsappPhoneActivation.count({where:{asset_id:inactiveLegacy.id}}),0);
    assert.equal(await models.PlatformAuditEvent.count(),auditsBefore);
    assert.equal(JSON.stringify(published),catalogBefore);
    denyTemplateJob=true;await assert.rejects(adopt.complete({...actor,requestId:receipt.requestId}),/TEMPLATE_JOB_UNAVAILABLE/);denyTemplateJob=false;
    assert.equal(JSON.stringify((await inactiveLegacy.reload()).toJSON()),legacyBefore);
    assert.equal(await models.WhatsappPhoneActivation.count({where:{asset_id:inactiveLegacy.id}}),0);
    assert.equal(await models.PlatformAuditEvent.count(),auditsBefore);
    assert.equal(await models.ActivationTestJob.count({where:{authorization_id:receipt.requestId}}),0);
    assert.equal(JSON.stringify(published),catalogBefore);
    const adopted=await adopt.complete({...actor,requestId:receipt.requestId});
    assert.equal(adopted.connected,true);assert.equal(adopted.assetId,inactiveLegacy.id);assert.equal(legacyActivations,1);
    assert.equal(proof,require('node:crypto').createHash('sha256').update('34600000901').digest('hex'));
    assert.equal(JSON.stringify(receipt),receiptBefore);
    await inactiveLegacy.reload();assert.equal(inactiveLegacy.metaConnectionId,1);assert.equal(inactiveLegacy.whatsappAuthorizationId,receipt.requestId);
    assert.equal(inactiveLegacy.additionalData.requireClinicSelection,true);
    assert.deepEqual(inactiveLegacy.additionalData.routing,{purposes:['review_requests'],unavailableAction:'pause'});
    assert.deepEqual(inactiveLegacy.additionalData.customLegacyMetadata,{preserved:true});
    await adopt.complete({...actor,requestId:receipt.requestId});assert.equal(legacyActivations,1);
    assert.equal(await models.WhatsappPhoneActivation.count({where:{asset_id:inactiveLegacy.id}}),1);
    assert.equal((await models.WhatsappPhoneActivation.findByPk(receipt.requestId)).message_not_before.getTime(),activatedAt);
    assert.equal(await models.ActivationTestJob.count({where:{authorization_id:receipt.requestId}}),1);
    assert.equal(await models.PlatformAuditEvent.count(),auditsBefore+1);assert.equal(await otherPhones(),otherPhonesBefore);
    report.checks.push('Exact inactive legacy clinic coexistence adopts its saved receipt and asset without changing signed context, routing, metadata or other phones; rejects history, explicit blocks, foreign roles/targets and bindings; audit/template rollback, broker cutoff and replay are verified');
  }
  const own=await models.ClinicMetaAsset.create({metaConnectionId:1,assetType:'whatsapp_phone_number',metaAssetId:'402',phoneNumberId:'402',wabaId:'302',assignmentScope:'clinic',clinicaId:71,isActive:true,additionalData:{whatsapp_channel_role:'primary'}});
  const bindings=id=>[{assetId:asset.id,phoneId:asset.phoneNumberId,wabaId:asset.wabaId,sendEnabled:true},...(id===71?[{assetId:own.id,phoneId:'402',wabaId:'302',sendEnabled:true}]:[])];
  let blocked=false,sessionValid=true;
  const routing=require('../../services/whatsappRouting.service').createService({models,audit:injectedAudit,sessions:{verifyReference:async()=>{if(!sessionValid)throw Error('SESSION_REVOKED')}},broker:{bindingsForClinic:bindings},scopeBlocks:{blocked:async()=>blocked}});
  const input={scope:{type:'clinic',id:71},primaryAssetId:asset.id,secondaryAssetId:own.id,purposes:['review_requests'],unavailableAction:'pause'};
  await routing.save(input,actor);
  const helpers=require('../../services/whatsappChannelBindings.service');
  const selected=await helpers.applyClinicBindings(71,[own,asset]);const {selectWhatsappPhoneAsset}=require('../../lib/whatsapp-channel-role');
  assert.equal(selectWhatsappPhoneAsset({clinicAssets:[selected[0]],groupAssets:[selected[1]]}).id,asset.id);
  assert.equal((await own.reload()).assignmentScope,'clinic');assert.equal(own.isActive,true);
  await routing.save({...input,primaryAssetId:own.id,secondaryAssetId:null,purposes:[]},actor);
  const after=await helpers.applyClinicBindings(71,[own,asset]);assert.equal(selectWhatsappPhoneAsset({clinicAssets:[after[0]],groupAssets:[after[1]]}).id,own.id);
  const unselected=selectWhatsappPhoneAsset({groupAssets:[asset.get({plain:true})]});assert.equal(unselected,null);
  const before=JSON.stringify(await models.WhatsappChannelBinding.findAll({raw:true}));
  denyAudit=true;await assert.rejects(routing.save(input,actor),/AUDIT_OFFLINE/);denyAudit=false;
  assert.equal(JSON.stringify(await models.WhatsappChannelBinding.findAll({raw:true})),before);
  blocked=true;await assert.rejects(routing.save(input,actor),/forbidden/);blocked=false;
  sessionValid=false;await assert.rejects(routing.save(input,actor),/SESSION_REVOKED/);sessionValid=true;
  await assert.rejects(routing.save({...input,scope:{type:'clinic',id:73}},actor),/forbidden/);
  await assert.rejects(routing.save({...input,secondaryAssetId:asset.id},actor),/invalid/);
  const secondaryInput={scope:{type:'group',id:9},secondaryAssetId:asset.id,purposes:['lead_first_contact','review_requests','bulk_campaigns'],unavailableAction:'pause'};
  const primaryBefore=(await models.WhatsappChannelBinding.findOne({where:{clinic_id:71,role:'primary'},raw:true}));
  const secondaryResult=await routing.saveSecondary(secondaryInput,actor);
  assert.deepEqual(secondaryResult.clinicIds,[71,72]);assert.equal(secondaryResult.preservesPrimaries,true);
  assert.deepEqual(await models.WhatsappChannelBinding.findOne({where:{clinic_id:71,role:'primary'},raw:true}),primaryBefore);
  assert.equal(await models.WhatsappChannelBinding.count({where:{clinic_id:72,role:'primary'}}),0);
  const secondaryRows=await models.WhatsappChannelBinding.findAll({where:{role:'secondary'},order:[['clinic_id','ASC']],raw:true});
  assert.deepEqual(secondaryRows.map(b=>[b.clinic_id,b.asset_id]),[[71,asset.id],[72,asset.id]]);
  assert.equal((await asset.reload()).additionalData.whatsapp_channel_role,'secondary');
  const actual=await helpers.applyClinicBindings(72,[asset]);actual[0].whatsappAuthorizedBinding=bindings(72)[0];
  assert.equal(selectWhatsappPhoneAsset({groupAssets:actual}),null);
  assert.equal(selectWhatsappPhoneAsset({groupAssets:actual,purpose:'lead_first_contact'}).id,asset.id);
  await routing.saveSecondary(secondaryInput,actor);assert.equal(await models.WhatsappChannelBinding.count({where:{role:'secondary'}}),2);
  const beforeFailure=JSON.stringify(await models.WhatsappChannelBinding.findAll({raw:true}));
  denyAudit=true;await assert.rejects(routing.saveSecondary({...secondaryInput,purposes:[]},actor),/AUDIT_OFFLINE/);denyAudit=false;
  assert.equal(JSON.stringify(await models.WhatsappChannelBinding.findAll({raw:true})),beforeFailure);
  await assert.rejects(routing.saveSecondary({...secondaryInput,secondaryAssetId:own.id},actor),/forbidden/);
  await models.UsuarioClinica.destroy({where:{id_usuario:501,id_clinica:72}});
  await assert.rejects(routing.saveSecondary(secondaryInput,actor),/forbidden/);
  await models.UsuarioClinica.create({id_usuario:501,id_clinica:72,rol_clinica:'propietario',estado_invitacion:'aceptada'});
  await models.WhatsappChannelBinding.destroy({where:{clinic_id:72,role:'secondary'}});
  await models.WhatsappChannelBinding.create({clinic_id:72,asset_id:asset.id,role:'primary'});
  await assert.rejects(routing.saveSecondary(secondaryInput,actor),/conflict/);
  await models.WhatsappChannelBinding.destroy({where:{clinic_id:72}});
  await asset.update({additionalData:{whatsapp_channel_role:'primary'}});
  await assert.rejects(routing.saveSecondary(secondaryInput,actor),/conflict/);
  assert.equal((await asset.reload()).additionalData.whatsapp_channel_role,'primary','an inherited primary cannot be silently demoted');
  report.checks.push('Group secondary is atomic and idempotent, preserves existing and absent primaries, routes only selected purposes, rejects primary conflict and missing member permission, audit failure rolls back');
  report.checks.push('Atomic clinic route selects group over own, keeps own asset available, explicit secondary removal, unselected new group does not send; rollback on audit failure, scope/session/duplicate rejection');
  if(process.env.WHATSAPP_ROUTING_ONLY_TEST!=='true'){
    models.WhatsappAccountHealthEvent=require('../../../models/whatsappaccounthealthevent')(sql,D);await models.WhatsappAccountHealthEvent.sync();
    const old=await models.WhatsappPhoneActivation.findByPk(asset.whatsappAuthorizationId);
    context.requestId=old.authorization_id;context.scope={type:'group',id:9};context.clinicIds=[71,72];delete context.replacement;
    Object.assign(remote,{flowId:old.authorization_id,connectionRef:old.connection_ref,scopeKey:'group:9',clinicIds:[71,72],
      phoneId:old.phone_id,wabaId:old.waba_id,assetId:asset.id,state:'active',profile:old.profile});
    const disconnect=require('../../services/whatsappPhoneDisconnect.service').createService({models,audit:injectedAudit,
      sessions:{verifyReference:async()=>{}},broker:{binding:async clinicId=>({clinicId,assetId:asset.id,authorizationId:old.authorization_id,
        connectionRef:old.connection_ref,phoneId:old.phone_id,wabaId:old.waba_id,sendEnabled:true})},
      control:{available:()=>true,execute:async command=>({requestId:command.requestId,data:{revoked:true}})}});
    const preview=await disconnect.preview({assetId:asset.id,clinicId:71},actor);
    await disconnect.disconnect({assetId:asset.id,clinicId:71,scopeToken:preview.scopeToken},actor);
    await disconnect.archive({assetId:asset.id,clinicId:71,scopeToken:preview.scopeToken},actor);
    assert.equal((await old.reload()).state,'archived');assert.equal((await asset.reload()).isActive,false);
    assert.equal(await models.WhatsappAccountHealthEvent.count({where:{event_type:'connection_archived'}}),1);
    assert.equal(await models.WhatsappChannelBinding.count({where:{asset_id:asset.id,is_active:true}}),0);
    const before=activations;await assert.rejects(make().complete({...actor,requestId:context.requestId}),/cancelled/);assert.equal(activations,before);
    context.requestId=randomUUID();Object.assign(remote,{flowId:context.requestId,connectionRef:A.connectionRef(context.requestId),assetId:null,state:'prepared'});
    const connected=await make().complete({...actor,requestId:context.requestId});assert.equal(connected.assetId,asset.id);
    await asset.reload();assert.equal(asset.additionalData.whatsappArchive,undefined);assert.equal(asset.additionalData.whatsappManualDisconnect,undefined);
    assert.equal((await old.reload()).state,'superseded');assert.equal(published.connections.filter(row=>row.assetId===asset.id).length,1);
    assert.equal(published.connections.find(row=>row.assetId===asset.id).messageNotBefore,new Date(old.message_not_before).toISOString());
    report.checks.push('Archive uses native permission/session scope, routing audit and health history; retires all scoped bindings without deleting history; old authorization cannot revive it, fresh authorization preserves asset and cutoff without duplicate catalog entries');
  }
}).catch(error=>{console.error(error.stack||error.message);process.exitCode=1});
