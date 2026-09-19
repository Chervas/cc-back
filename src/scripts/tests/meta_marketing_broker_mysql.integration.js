'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {execFileSync}=require('node:child_process');
const {DataTypes:D}=require('sequelize'),{withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async({sql,models,report,registerOwnedLoopbackServer})=>{
  const cleanup=[],{fixture,TOKEN,APP}=require('../../../services/integrations-broker/test/meta-marketing-fixture.cjs'),f=fixture({after:fn=>cleanup.push(fn)});
  const C=require('../../../services/integrations-broker/src/meta-marketing-contract'),runtime=require('../../../services/integrations-broker/src/meta-marketing-main');
  let app;
  try {
    for(const [name,file] of [['Usuario','usuario'],['Clinica','clinica'],['GrupoClinica','grupoclinica'],['MetaConnection','MetaConecction'],
      ['MetaConnectionAssignment','metaconnectionassignment'],['MetaScopeBlock','metascopeblock'],['ClinicMetaAsset','ClinicMetaAsset'],['GroupAssetClinicAssignment','groupassetclinicassignment'],
      ['AuthSession','authsession'],['PlatformAuditEvent','platformauditevent']]) {
      models[name]=require('../../../models/'+file)(sql,D);
      for(const attribute of Object.values(models[name].rawAttributes))delete attribute.references;
      if(name==='MetaConnection'){models[name].removeAttribute('credentials_external');models[name].removeAttribute('broker_app_id');models[name].rawAttributes.accessToken.allowNull=false;}
      if(name==='ClinicMetaAsset'){models[name].options.indexes=models[name].options.indexes.filter(index=>index.name!=='cc_meta_asset_identity');models[name]._indexes=models[name]._indexes.filter(index=>index.name!=='cc_meta_asset_identity');}
      models[name].refreshAttributes();await models[name].sync();
    }
    const migration=require('../../../migrations/20260919040000-meta-marketing-broker-registry'),qi=sql.getQueryInterface();
    await models.MetaConnection.create({id:90,metaUserId:'999',accessToken:'LEGACY_SENTINEL_UNTOUCHED'});
    await migration.up(qi);await migration.down(qi);await migration.up(qi);
    await require('../../../migrations/20260919090000-meta-marketing-enrollment-binding-owner').up(qi);
    models.MetaConnection=require('../../../models/MetaConecction')(sql,D);
    models.MetaMarketingBrokerBinding=require('../../../models/metamarketingbrokerbinding')(sql,D);
    await require('../../../migrations/20260919050000-meta-marketing-broker-revocations').up(qi);
    models.MetaMarketingBrokerRevocation=require('../../../models/metamarketingbrokerrevocation')(sql,D);
    await models.MetaConnection.create({id:2,metaUserId:'201',accessToken:null,credentials_external:true,broker_app_id:'101'});
    await assert.rejects(models.MetaConnection.update({accessToken:'FICTITIOUS_RESTORED_SECRET'},{where:{id:2}}));
    await assert.rejects(models.MetaConnection.create({id:3,metaUserId:'202',accessToken:null}));
    await assert.rejects(models.MetaConnection.update({credentials_external:false},{where:{id:2}}));
    assert.equal((await models.MetaConnection.findByPk(90)).accessToken,'LEGACY_SENTINEL_UNTOUCHED');
    await assert.rejects(migration.down(qi),/Preserve Meta vault exclusions/);
    report.checks.push('Actual DDL preserves legacy rows, allows null credential only with vault/app marker, rejects secret restoration and refuses destructive rollback');
    await models.GrupoClinica.bulkCreate([{id_grupo:5,nombre_grupo:'Grupo ficticio'},{id_grupo:6,nombre_grupo:'Grupo ajeno'}]);
    await models.Clinica.bulkCreate([59,71,88].map(id=>({id_clinica:id,nombre_clinica:'Clínica ficticia '+id,grupoClinicaId:id===88?6:5,estado_clinica:true})));
    const user=await models.Usuario.create({id_usuario:91002,nombre:'Fictitious broker reader',email_usuario:'meta-broker@example.invalid',password_usuario:'FICTITIOUS_HASH'});
    models.UsuarioClinica=sql.define('UsuarioClinica',{id_usuario:D.INTEGER,id_clinica:D.INTEGER,rol_clinica:D.STRING,estado_invitacion:D.STRING},{timestamps:false});await models.UsuarioClinica.sync();
    const role=require('../../lib/role-helpers').MARKETING_WRITE_ROLES[0];await models.UsuarioClinica.bulkCreate([59,71].map(id_clinica=>({id_usuario:91002,id_clinica,rol_clinica:role,estado_invitacion:'aceptada'})));
    await models.MetaConnectionAssignment.create({scopeKey:'group:5',assignmentScope:'group',grupoClinicaId:5,metaConnectionId:2,status:'active'});
    for(const [i,asset] of f.binding.metaMarketing.assets.entries()) {
      await models.ClinicMetaAsset.create({id:i+1,metaConnectionId:2,clinicaId:59,grupoClinicaId:5,assignmentScope:'group',assetType:asset.kind,metaAssetId:asset.kind==='ad_account'?'act_'+asset.id:asset.id});
      await models.MetaMarketingBrokerBinding.create({mapping_id:i+1,asset_ref:asset.assetRef,meta_connection_id:2,meta_user_id:'201',app_id:'101',connection_ref:f.binding.connectionRef,
        scope_key:'group:5',tenant_clinic_id:59,parent_page_id:asset.parentPageId,state:'active'});
    }
    await models.ClinicMetaAsset.create({id:11,metaConnectionId:2,clinicaId:71,grupoClinicaId:5,assignmentScope:'clinic',assetType:'ad_account',metaAssetId:'301'});
    await models.MetaMarketingBrokerBinding.create({...((await models.MetaMarketingBrokerBinding.findByPk(1)).get({plain:true})),mapping_id:11});
    await models.GroupAssetClinicAssignment.create({id:1,assetId:1,assetType:'meta.ad_account',grupoClinicaId:5,clinicaId:71});
    await models.GrupoClinica.update({facebook_primary_asset_id:2,instagram_primary_asset_id:3},{where:{id_grupo:5}});
    models.MetaConnection.addHook('beforeFind',opts=>{if(!opts.attributes||opts.attributes.includes('accessToken'))throw Error('CREDENTIAL_SELECT_FORBIDDEN');});
    models.ClinicMetaAsset.addHook('beforeFind',opts=>{if(!opts.attributes||opts.attributes.some(k=>['pageAccessToken','waAccessToken','additionalData'].includes(k)))throw Error('CREDENTIAL_SELECT_FORBIDDEN');});
    const {config}=f;execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',config.tlsKeyFile,'-out',config.tlsCertFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    [config.tlsKeyFile,config.tlsCertFile].forEach(file=>fs.chmodSync(file,0o600));
    const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));config.port=reservation.address().port;await new Promise(r=>reservation.close(r));
    const filename=path.join(f.dir,'config.json');fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
    const events=[],awsFactory=async()=>({secrets:f.aws,sink:{write:async row=>{events.push(JSON.parse(row.event));return {versionId:require('node:crypto').randomUUID(),digest:row.digest};}},close(){}});
    const start=async()=>{app=await runtime.main(filename,{awsFactory,http:f.http});registerOwnedLoopbackServer(app.server);};await start();
    const create=require('../../lib/integrationsBrokerClient').createIntegrationsBrokerClient;
    const readerKey=path.join(f.dir,'reader.pem');fs.writeFileSync(readerKey,f.keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    const wire=require('../../services/metaMarketingBrokerReader.service').createConfiguredMetaMarketingClient({env:{META_MARKETING_BROKER_ORIGIN:'https://127.0.0.1:'+config.port,META_MARKETING_BROKER_AUDIENCE:f.policy.audience,META_MARKETING_BROKER_KEY_ID:'qa-read',META_MARKETING_BROKER_KEY_FILE:readerKey,META_MARKETING_BROKER_CA_FILE:config.tlsCertFile}});
    const controlKey=path.join(f.dir,'control.pem');fs.writeFileSync(controlKey,f.controlKeys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    const control=require('../../services/metaMarketingRevocationClient.service').createClient({env:{META_MARKETING_BROKER_ORIGIN:'https://127.0.0.1:'+config.port,META_MARKETING_BROKER_AUDIENCE:f.policy.audience,META_MARKETING_BROKER_CONTROL_KEY_ID:'qa-control',META_MARKETING_BROKER_CONTROL_KEY_FILE:controlKey,META_MARKETING_BROKER_CA_FILE:config.tlsCertFile}});
    let enabled=true,alterResponse=null,commands=0,queryCount=0;
    sql.addHook('beforeQuery',()=>queryCount++);
    const client={execute:async(...args)=>{commands++;const value=await wire.execute(...args);return alterResponse?alterResponse(value):value;}};
    const service=require('../../services/metaMarketingBrokerReader.service').createMetaMarketingBroker({client,enabled:()=>enabled,...require('../../services/metaMarketingBrokerScope.service').createMetaMarketingScopeRepository(()=>models)});
    const sessions=require('../../services/accessSession.service').createService({models,config:()=>({mode:'enforce',ttl:3600,secret:'FICTITIOUS_META_BROKER_SESSION'})});
    let token=(await sessions.authenticated(user)).body.token;
    const authorize=async captured=>{
      try{const claims=await sessions.verify(token);assert.equal(claims.userId,91002);}catch{throw Object.assign(Error('meta_broker_session_required'),{code:'meta_broker_session_required'});}
      if(!await require('../../lib/marketingScopeAccess').hasMarketingClinicScopeAccess({userId:91002,clinicIds:captured.clinicIds,access:'read'}))throw Object.assign(Error('meta_broker_scope_forbidden'),{code:'meta_broker_scope_forbidden'});
    };
    const read=async(id=1,operation=C.ASSET)=>service.read(await service.prepare(id),operation,{authorize});
    const startQueries=queryCount,startTime=Date.now();
    const status=await read(1,C.STATUS);assert.equal(status.credentialValid,true);assert.equal(status.assetAccessVerified,false);
    const data=await read();assert.equal(data.id,'act_301');assert.equal(data.currency,'EUR');assert.equal((await read(2)).id,'401');assert.equal((await read(3)).username,'fictitious_instagram');
    assert(!JSON.stringify([status,data]).includes(TOKEN));report.firstReads={queries:queryCount-startQueries,elapsedMs:Date.now()-startTime};
    assert.deepEqual((await service.assertContext(await service.prepare(1))).clinicIds,[59,71]);
    report.checks.push('CRM metadata registry through signed HTTPS/SQLite/Secrets fake to status/account/page/Instagram; group aliases and primary references checked without selecting SQL credentials');
    const rejectBefore=async(fn,code)=>{const n=commands,a=f.state.aws.length;await assert.rejects(fn,code?{code}:undefined);assert.equal(commands,n);assert.equal(f.state.aws.length,a);};
    await rejectBefore(()=>service.read({},C.ASSET,{authorize}),'meta_broker_binding_invalid');
    const context=await service.prepare(1);await rejectBefore(()=>service.read(context,C.REVOKE,{authorize}),'invalid_request');await rejectBefore(()=>service.read(context,C.ASSET),'invalid_request');
    enabled=false;await rejectBefore(()=>read(),'broker_cohort_disabled');enabled=true;
    await models.MetaMarketingBrokerBinding.update({state:'staged'},{where:{mapping_id:1}});await rejectBefore(()=>read(),'meta_broker_not_active');await models.MetaMarketingBrokerBinding.update({state:'active'},{where:{mapping_id:1}});
    report.checks.push('Opaque contexts, mandatory actor authorization, fixed read operations and closed cohort/staged bindings reject before external I/O');
    await models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_clinica:71}});await rejectBefore(()=>read(),'meta_broker_scope_forbidden');await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_clinica:71}});
    for(const patch of [{pageAccessToken:'FICTITIOUS_PAGE_SECRET'},{waAccessToken:'FICTITIOUS_WA_SECRET'},{additionalData:{value:'FICTITIOUS_UNKNOWN_SECRET'}}]){
      await models.ClinicMetaAsset.update(patch,{where:{id:1}});await rejectBefore(()=>read(),'meta_broker_binding_invalid');await models.ClinicMetaAsset.update({pageAccessToken:null,waAccessToken:null,additionalData:null},{where:{id:1}});
    }
    report.checks.push('Missing access to a non-representative clinic and residual page/WA/JSON credentials prohibit broker execution');
    await models.GroupAssetClinicAssignment.create({id:2,assetId:1,assetType:'meta.ad_account',grupoClinicaId:6,clinicaId:88});await rejectBefore(()=>read(),'scope_denied');await models.GroupAssetClinicAssignment.destroy({where:{id:2}});
    await models.GrupoClinica.update({facebook_primary_asset_id:2},{where:{id_grupo:6}});await rejectBefore(()=>read(2),'scope_denied');await models.GrupoClinica.update({facebook_primary_asset_id:null},{where:{id_grupo:6}});
    report.checks.push('Explicit sharing and dormant group primary references outside the registered scope prohibit reads');
    const during=async(fn,code,id=1)=>{let once=true;f.state.httpHook=async request=>{if(request.action==='inspect'&&once){once=false;await fn();}};try{await assert.rejects(()=>read(id),{code});}finally{f.state.httpHook=null;}};
    await during(()=>models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_clinica:71}}),'meta_broker_scope_forbidden');await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_clinica:71}});
    await during(()=>models.AuthSession.update({state:'revoked'},{where:{user_id:91002}}),'meta_broker_session_required');token=(await sessions.authenticated(user)).body.token;
    await during(()=>models.MetaScopeBlock.create({scope_key:'meta:clinic:71',reason:'scope_disconnected',connection_id:2,created_at:new Date()}),'asset_revoked');await models.MetaScopeBlock.destroy({where:{}});
    await during(()=>models.MetaConnectionAssignment.update({status:'revoked'},{where:{scopeKey:'group:5'}}),'scope_denied');await models.MetaConnectionAssignment.update({status:'active'},{where:{scopeKey:'group:5'}});
    report.checks.push('Actual SQL membership/session/scope-block/assignment revocation during provider inspection discards successful provider data');
    alterResponse=value=>({...value,data:{...value.data,accessToken:TOKEN}});await assert.rejects(()=>read(),{code:'broker_response_invalid'});alterResponse=null;
    report.checks.push('Unexpected broker response fields are rejected instead of passed through');
    if(process.env.META_ACCESS_E2E_TEST==='1')await require('./fixtures/meta_marketing_access_e2e.fixture')({models,report,registerOwnedLoopbackServer,broker:service,sessions,token:()=>token,f,queries:()=>queryCount,
      technicalEvents:()=>app.store.db.prepare('SELECT event FROM audit_outbox').all().map(row=>JSON.parse(row.event))});
    if(process.env.META_REVOCATION_TEST==='1'){
      await require('./fixtures/meta_marketing_revocation_e2e.fixture')({models,report,registerOwnedLoopbackServer,broker:service,sessions,token:()=>token,f,control,
        restart:async()=>{await app.close();app=null;await start();},queries:()=>queryCount});
    }else{
    await models.MetaMarketingBrokerBinding.update({state:'blocked'},{where:{mapping_id:11}});await models.ClinicMetaAsset.destroy({where:{id:11}});
    await rejectBefore(()=>read(),'asset_revoked');await rejectBefore(()=>service.prepare(11),'asset_revoked');
    report.checks.push('A blocked independent alias survives deletion and denies the surviving account mapping');
    let once=true;f.state.httpHook=async request=>{if(request.action==='inspect'&&once){once=false;assert.equal((await control.execute(f.command({assetRef:'meta-facebook_page:401',operation:C.REVOKE}))).data.revoked,true);}};
    await assert.rejects(()=>read(2),{code:'connection_blocked'});f.state.httpHook=null;await app.close();app=null;await start();await assert.rejects(()=>read(2),{code:'asset_revoked'});
    assert.equal((await read(3)).id,'501');report.checks.push('Independent broker control revokes during I/O, survives restart and preserves another asset');
    }
    report.commands=commands;report.secretCalls=f.state.aws.length;report.providerCalls=f.state.http.length;report.queryCount=queryCount;report.pool={inUse:sql.connectionManager.pool.using,waiting:sql.connectionManager.pool.waiting};
    assert.equal(report.pool.inUse,0);assert.equal(report.pool.waiting,0);report.tokenSelects=0;
    for(const secret of [TOKEN,APP])assert(!JSON.stringify(events).includes(secret));
  } finally {if(app)await app.close();for(const fn of cleanup.reverse())await fn();}
}).catch(()=>{process.exitCode=1;});
