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
  models.ClinicMetaAsset=require('../../../models/ClinicMetaAsset')(sql,D);
  models.WhatsappPhoneActivation=require('../../../models/whatsappphoneactivation')(sql,D);
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
  let activations=0,published=null,denyAudit=false;
  const audit=require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const injectedAudit={health:(...a)=>audit.health(...a),append:(...a)=>{if(denyAudit)throw Error('AUDIT_OFFLINE');return audit.append(...a)}};
  const make=()=>require('../../services/whatsappPhoneActivation.service').createService({models,audit:injectedAudit,guard:()=>{},enabled:()=>true,
    states:{resume:async()=>context},publish:value=>{published=value},broker:{profile:async()=>({...remote}),activate:async(c,assetId)=>{
      activations++;remote.assetId=assetId;remote.state='active';remote.activatedAt=Date.now();remote.profile={...remote.profile,status:'CONNECTED',platformType:'CLOUD_API'};return {...remote};}}});
  const result=await make().complete({...actor,requestId:context.requestId});assert.equal(result.connected,true);assert.equal(activations,1);
  let asset=await models.ClinicMetaAsset.findByPk(result.assetId);assert.equal(asset.metaConnectionId,null);assert.equal(asset.waAccessToken,null);assert.equal(asset.additionalData.requireClinicSelection,true);
  const cutoff=published.connections[0].messageNotBefore;
  await make().complete({...actor,requestId:context.requestId});assert.equal(activations,1);assert.equal(await models.WhatsappPhoneActivation.count(),1);assert.equal(published.connections[0].messageNotBefore,cutoff);
  assert.equal(await models.PlatformAuditEvent.count(),2);
  await assert.rejects(models.ClinicMetaAsset.create({assetType:'ad_account',metaAssetId:'701',metaConnectionId:null}));
  await assert.rejects(migration.down(qi),/Preserve WhatsApp/);
  report.checks.push('Migration up/up/down/up, independent catalog identity, restart recovery without provider reactivation, immutable cutoff, no secrets, audit and rollback guard');
  const own=await models.ClinicMetaAsset.create({metaConnectionId:1,assetType:'whatsapp_phone_number',metaAssetId:'402',phoneNumberId:'402',wabaId:'302',assignmentScope:'clinic',clinicaId:71,isActive:true,additionalData:{whatsapp_channel_role:'primary'}});
  const bindings=id=>[{assetId:asset.id,phoneId:'401',wabaId:'301',sendEnabled:true},...(id===71?[{assetId:own.id,phoneId:'402',wabaId:'302',sendEnabled:true}]:[])];
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
  report.checks.push('Atomic clinic route selects group over own, keeps own asset available, explicit secondary removal, unselected new group does not send; rollback on audit failure, scope/session/duplicate rejection');
}).catch(error=>{console.error(error.message);process.exitCode=1});
