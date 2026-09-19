'use strict';
// Read-only bootstrap + actual inventory/ACL/SQL session + signed HTTPS broker.
// Own MySQL/SQLite, fake Google/Secrets Manager/S3. Never public authentication.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {randomUUID,randomBytes,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {DataTypes:D}=require('sequelize'),{withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async({sql,models,report,registerOwnedLoopbackServer})=>{
  const cleanups=[],{adsFixture,CUSTOMER,MANAGER,ASSET,ACCESS}=require('../../../services/integrations-broker/test/google-ads-fixture.cjs');
  const f=adsFixture({after:fn=>cleanups.push(fn)}),C=require('../../../services/integrations-broker/src/google-data-manager-contract');
  const A=require('../../../services/integrations-broker/src/google-action-management-contract'),T=require('../../../services/integrations-broker/src/google-destination-contract');
  const runtime=require('../../../services/integrations-broker/src/google-main');
  f.binding.connectionRef='qa-bootstrap-settings';
  f.binding.googleDataManager={quotaProjectId:'fictitious-project',destinations:[]};
  f.binding.googleAdsActionManagement={accounts:[{assetRef:ASSET,events:A.EVENTS,currencies:['EUR'],allowCreate:true,allowNormalize:true}]};
  f.binding.googleDataManagerEnrollment={accounts:[{assetRef:ASSET,events:A.EVENTS,sources:['WEB','OTHER']}]};
  f.policy.grants.forEach(g=>{g.tenantRef='clinic:59';g.connectionRef=f.binding.connectionRef;});
  f.policy.grants[0].operations=[...f.policy.grants[0].operations,...Object.values(A.OPERATIONS),...Object.values(T.OPERATIONS),...Object.values(C.OPERATIONS)];
  const rows=[],providerReceipts=new Map(),technicalEvents=[],commands=[];
  let ingests=0,actionWrites=0,statusReads=0,providerState='PROCESSING',providerHook=null,lostReadAck=false,tokenReads=0;
  const dependencies={http:async request=>{
    if(request.hostname==='oauth2.googleapis.com'){const result=await f.http(request);result.scope+=' '+C.SCOPES[0];return result;}
    assert.equal(request.token.toString(),ACCESS);
    if(request.hostname==='googleads.googleapis.com'){
      assert.equal(request.loginCustomerId,MANAGER);
      if(request.path.endsWith('/googleAds:search')) {
        if(request.json.query.includes('FROM conversion_action '))return {results:[]};
        assert.match(request.json.query,/FROM customer LIMIT 2$/);await providerHook?.();
        if(providerState==='FAIL')throw Error('FICTITIOUS_PROVIDER_SECRET');
        return {results:[{customer:{id:CUSTOMER,conversionTrackingSetting:{acceptedCustomerDataTerms:true,
          enhancedConversionsForLeadsEnabled:false,googleAdsConversionCustomer:'customers/'+MANAGER}}}]};
      }
      assert(request.path.endsWith('/conversionActions:mutate'));if(request.json.validateOnly)return {};
      actionWrites++;return {results:request.json.operations.map(op=>{assert(op.create);const id=String(456+rows.length);
        const action={...op.create,id,resourceName:`customers/${CUSTOMER}/conversionActions/${id}`,ownerCustomer:'customers/'+CUSTOMER,includeInConversionsMetric:false};
        rows.push({customer:{id:CUSTOMER},conversionAction:action});return {resourceName:action.resourceName};})};
    }
    assert.equal(request.hostname,'datamanager.googleapis.com');
    if(request.path==='/v1/events:ingest'){
      assert(!request.json.validateOnly);ingests++;const id='fictitious-human-receipt-'+ingests;providerReceipts.set(id,request.json.destinations[0]);return {requestId:id};
    }
    assert(request.path.startsWith('/v1/requestStatus:retrieve?requestId='));statusReads++;await providerHook?.();
    const destination=providerReceipts.get(decodeURIComponent(request.path.split('requestId=')[1]));assert(destination);
    return {requestStatusPerDestination:[{destination,requestStatus:providerState,eventsIngestionStatus:{recordCount:'1'}}]};
  },awsFactory:async()=>({secrets:{send:async command=>{const result=await f.sdk.send(command);
    if(command.input.SecretId===f.binding.secretArn&&result.SecretString){const v=JSON.parse(result.SecretString);v.scopes.push(...C.SCOPES);result.SecretString=JSON.stringify(v);}return result;}},
    sink:{write:async row=>{technicalEvents.push(JSON.parse(row.event));return {versionId:'fictitious-audit',digest:row.digest};}},close(){}})};
  let brokerApp,apiServer;
  try{
    await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    for(const [name,file] of [['Usuario','usuario'],['GrupoClinica','grupoclinica'],['Clinica','clinica'],
      ['IntakeConfig','intakeconfig'],['CampaignRequest','campaignrequest'],['MetaConnection','MetaConecction'],
      ['MetaConnectionAssignment','metaconnectionassignment'],['MetaScopeBlock','metascopeblock'],['ClinicMetaAsset','ClinicMetaAsset'],
      ['ClinicWebAsset','clinicwebasset'],['ClinicAnalyticsProperty','clinicanalyticsproperty'],['ClinicBusinessLocation','clinicbusinesslocation'],
      ['GoogleConnection','googleconnection'],['ClinicGoogleAdsAccount','clinicgoogleadsaccount'],
      ['GoogleAdsBrokerBinding','googleadsbrokerbinding'],['GoogleAdsBrokerRevocation','googleadsbrokerrevocation'],
      ['GoogleConnectionAssignment','googleconnectionassignment'],['GroupAssetClinicAssignment','groupassetclinicassignment'],
      ['PlatformAuditEvent','platformauditevent']]) {
      models[name]=require('../../../models/'+file)(sql,D);
      for(const attr of Object.values(models[name].rawAttributes))delete attr.references;
      models[name].refreshAttributes();await models[name].sync();
    }
    models.GoogleConnectionAssignment.belongsTo(models.GoogleConnection,{as:'googleConnection',foreignKey:'googleConnectionId'});
    models.MetaConnectionAssignment.belongsTo(models.MetaConnection,{as:'metaConnection',foreignKey:'metaConnectionId'});
    models.UsuarioClinica=sql.define('UsuarioClinica',{id_usuario:D.INTEGER,id_clinica:D.INTEGER,rol_clinica:D.STRING,estado_invitacion:D.STRING},{timestamps:false});await models.UsuarioClinica.sync();
    for(const name of ['20260711003000-create-google-ads-conversion-upload-attempts','20260711012000-add-google-ads-conversion-destination-key','20260712090000-add-data-manager-conversion-statuses',
      '20260918110000-create-google-conversion-submissions','20260918235000-index-google-receipt-review','20260918190000-create-google-ads-action-journal',
      '20260918203000-google-action-recovery-ownership','20260918220000-create-google-destination-journal','20260918224500-index-google-destination-recovery',
      '20260912220000-create-auth-sessions','20260913130000-create-auth-email-challenges','20260914220000-create-auth-trusted-devices'])await require('../../../migrations/'+name).up(sql.getQueryInterface(),require('sequelize'));
    for(const [name,file] of [['GoogleAdsConversionUploadAttempt','googleadsconversionuploadattempt'],['GoogleConversionSubmission','googleconversionsubmission'],
      ['GoogleAdsActionPlan','googleadsactionplan'],['GoogleAdsActionCommand','googleadsactioncommand'],['GoogleDestinationAuthorization','googledestinationauthorization'],
      ['GoogleDestinationCommand','googledestinationcommand'],['AuthSession','authsession'],['AuthTrustedDevice','authtrusteddevice']])models[name]=require('../../../models/'+file)(sql,D);
    await models.GrupoClinica.create({id_grupo:5,nombre_grupo:'Grupo ficticio'});
    await models.Clinica.bulkCreate([{id_clinica:59,nombre_clinica:'Clínica ficticia A',grupoClinicaId:5,estado_clinica:true},{id_clinica:71,nombre_clinica:'Clínica ficticia B',grupoClinicaId:5,estado_clinica:true}]);
    await models.IntakeConfig.create({id:1,assignment_scope:'group',group_id:5,config:{campaigns:{active_mode:'measure'}},domains:[]});
    const user=await models.Usuario.create({id_usuario:91002,nombre:'Fictitious receipt reviewer',email_usuario:'receipt-fixture@example.invalid',password_usuario:'FICTITIOUS_HASH'});
    const role=require('../../lib/role-helpers').MARKETING_WRITE_ROLES[0];await models.UsuarioClinica.bulkCreate([59,71].map(id_clinica=>({id_usuario:91002,id_clinica,rol_clinica:role,estado_invitacion:'aceptada'})));
    await models.GoogleConnection.create({id:2,googleUserId:f.binding.googleSubject,accessToken:null,refreshToken:null,scopes:'https://www.googleapis.com/auth/adwords '+C.SCOPES[0]});
    models.GoogleConnection.addHook('beforeFind',opts=>{if(!opts.attributes||['accessToken','refreshToken'].some(v=>opts.attributes.includes(v)))tokenReads++;});
    await models.GoogleConnectionAssignment.create({id:100,scopeKey:'group:5',googleConnectionId:2,assignmentScope:'group',grupoClinicaId:5,status:'active'});
    const mapping=(await models.ClinicGoogleAdsAccount.create({id:11,clinicaId:59,grupoClinicaId:5,assignmentScope:'group',googleConnectionId:2,customerId:CUSTOMER,loginCustomerId:MANAGER,
      isActive:true,broker_read_connection_ref:f.binding.connectionRef,broker_read_asset_ref:ASSET})).get({plain:true});
    await models.GoogleAdsBrokerBinding.create({customer_id:CUSTOMER,mapping_id:11,google_connection_id:2,google_user_id:f.binding.googleSubject,
      connection_ref:f.binding.connectionRef,asset_ref:ASSET,scope_key:'group:5',tenant_clinic_id:59,login_customer_id:MANAGER,state:'active'});
    await models.GroupAssetClinicAssignment.create({assetType:'google.ads_account',assetId:11,clinicaId:71,grupoClinicaId:5});
    const cert=path.join(report.root,'tls.crt'),key=path.join(report.root,'tls.key'),cursor=path.join(report.root,'cursor');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    [cert,key].forEach(v=>fs.chmodSync(v,0o600));fs.writeFileSync(cursor,randomBytes(32),{mode:0o600});
    const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
    const config={enabled:true,cohort:C.COHORT,policy:f.policy,listenAddress:'127.0.0.1',port,stateFile:path.join(report.root,'broker.sqlite'),cursorKeyFile:cursor,tlsKeyFile:key,tlsCertFile:cert};
    const configFile=path.join(report.root,'broker-config.json');fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
    const startBroker=async()=>{brokerApp=await runtime.main(configFile,dependencies);registerOwnedLoopbackServer(brokerApp.server);};await startBroker();
    const wire=require('../../lib/integrationsBrokerClient').createIntegrationsBrokerClient({origin:'https://127.0.0.1:'+port,audience:f.policy.audience,keyId:'qa-key',
      privateKey:f.keys.privateKey.export({type:'pkcs8',format:'pem'}),ca:fs.readFileSync(cert)});
    const client={execute:async(command,options)=>{
      commands.push({operation:command.operation,requestId:command.requestId});
      if(command.operation===C.OPERATIONS.reconcile)assert(await models.PlatformAuditEvent.findOne({where:{correlation_id:command.requestId,stage:'attempted'},raw:true}));
      const result=await wire.execute(command,options);if(lostReadAck&&command.operation===C.OPERATIONS.reconcile){lostReadAck=false;throw Object.assign(Error('fictitious lost read ACK'),{code:'broker_timeout'});}return result;
    }};
    const broker=require('../../services/googleAdsBroker.service').createGoogleAdsBroker({...require('../../services/googleAdsBrokerScope.service').createGoogleAdsScopeRepository(()=>models),
      client,enabled:()=>true,actionManagementEnabled:()=>true,destinationsEnabled:()=>true,conversionsEnabled:()=>true,receiptReconciliationEnabled:()=>true});
    const audit=require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
    const access=require('../../services/accessSession.service');const sessions={...access,...access.createService({models,audit,config:()=>({mode:'enforce',ttl:3600,secret:'FICTITIOUS_E2E_SESSION_SECRET'})})};
    let token=(await sessions.authenticated(user)).body.token;const oldToken=token;

    Object.assign(process.env,{GOOGLE_ADS_BROKER_ENABLED:'true',GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED:'false',
      GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED:'false',GOOGLE_DATA_MANAGER_QUOTA_PROJECT:'wrong-local-project'});
    const B=require('../../services/googleAdsBroker.service');Object.assign(B,broker);
    Object.assign(require('../../services/accessSession.service'),sessions);
    // Inspect actual SQL, including eager-loaded connection associations.
    const metaFixture=process.env.META_BOOTSTRAP_METADATA_TEST==='1';let metaCredentialQueries=0;
    if(metaFixture){
      await models.MetaConnection.create({id:80,userId:91002,metaUserId:'fictitious-meta-subject',accessToken:'NEVER_HYDRATE_META_OAUTH',expiresAt:new Date(Date.now()+86400000)});
      await models.MetaConnectionAssignment.create({id:200,scopeKey:'group:5',assignmentScope:'group',grupoClinicaId:5,metaConnectionId:80,status:'active'});
      await models.ClinicMetaAsset.bulkCreate([{id:501,clinicaId:59,grupoClinicaId:5,assignmentScope:'group',metaConnectionId:80,isActive:true,assetType:'ad_account',metaAssetId:'act_1234567890',metaAssetName:'Cuenta Meta ficticia',additionalData:{access_token:'NEVER_HYDRATE_EXTRA_SECRET'}},
        {id:502,clinicaId:59,grupoClinicaId:5,assignmentScope:'group',metaConnectionId:80,isActive:true,assetType:'facebook_page',metaAssetId:'1234567891',metaAssetName:'Página Meta ficticia',pageAccessToken:'NEVER_HYDRATE_META_PAGE'}]);
      const config=await models.IntakeConfig.findByPk(1);await config.update({config:{...config.config,meta_ads:{enabled:true,ad_account_id:'act_1234567890',pixel_id:'1234567892'}}});
    }
    sql.addHook('afterQuery',(_options,q)=>{if(/SELECT /i.test(q.sql||'')&&/`(?:MetaConnections|ClinicMetaAssets)`/.test(q.sql)&&/`(?:accessToken|pageAccessToken|additionalData)`/.test(q.sql))metaCredentialQueries++;});
    let queries=0;sql.addHook('afterQuery',(_options,query)=>{queries++;const text=query.sql||'';
      if(/SELECT /i.test(text)&&/`GoogleConnections`/.test(text)&&/`(?:accessToken|refreshToken)`/.test(text))tokenReads++;});
    const controller=require('../../controllers/campaignOnboarding.controller');
    const express=require('express'),app=express();app.use(express.json({limit:'32kb'}));
    const authenticate=async(req,res,next)=>{try{
      req.userData=await sessions.verify(sessions.bearer(req.headers.authorization));next();
    }catch(e){next(e);}};
    app.get('/api/marketing/campaign-onboarding/bootstrap',authenticate,controller.getCampaignOnboardingBootstrap);
    app.post('/api/marketing/campaign-onboarding/start',authenticate,controller.startCampaignOnboarding);
    app.get('/api/marketing/google-ads/conversion-actions',authenticate,controller.listGoogleAdsConversionActions);
    app.use((error,_req,res,_next)=>res.status(error.status||error.httpStatus||500).json({success:false,error:error.code||'internal_error'}));
    apiServer=http.createServer(app);await new Promise(resolve=>apiServer.listen(0,'127.0.0.1',resolve));registerOwnedLoopbackServer(apiServer);
    const request=(query='group_id=5',bearer=token)=>new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:apiServer.address().port,path:'/api/marketing/campaign-onboarding/bootstrap?'+query,method:'GET',agent:false,
        headers:bearer?{authorization:'Bearer '+bearer}:{}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,cache:res.headers['cache-control'],body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end();
    });
    const call=async()=>{const r=await request();assert.equal(r.status,200,JSON.stringify(r.body));return r;};
    const started=performance.now(),beforeQueries=queries;
    const initial=await call();report.initialBootstrap={milliseconds:Math.round(performance.now()-started),statements:queries-beforeQueries,accounts:1};
    assert.equal(initial.cache,'private, no-store');
    assert.equal(initial.body.google_ads.connected,true);assert.equal(initial.body.google_ads.manager_id,'987-654-3210');
    assert.equal(initial.body.google_ads.accounts[0].google_ads_conversion_customer,'customers/'+MANAGER);
    assert.equal(initial.body.google_ads.accounts[0].delivery_mode,'broker');
    assert.equal(initial.body.google_ads.capabilities.data_manager_quota_project_configured,true);
    assert.deepEqual(initial.body.google_ads.capabilities.data_manager_missing,['delivery_disabled']);
    assert.equal(initial.body.google_ads.capabilities.can_create_conversion_actions,false);
    assert.equal(initial.body.google_ads.capabilities.conversion_validation_status,'not_validated');
    assert.equal(commands.length,1);assert.equal(tokenReads,0);
    // Bound request-level query work independently of provider latency. This is
    // an isolated burst check, not production load or throughput acceptance.
    assert(report.initialBootstrap.statements<150,'settings must not repeat the old 198-statement snapshot chain');
    let providerActive=0,providerPeak=0;
    providerHook=async()=>{providerActive++;providerPeak=Math.max(providerPeak,providerActive);
      await new Promise(resolve=>setTimeout(resolve,100));providerActive--;};
    const batchQueries=queries,batchCommands=commands.length;
    const latencies=await Promise.all(Array.from({length:8},async()=>{const at=performance.now();
      const result=await call();assert.equal(result.body.google_ads.connected,true);
      assert.equal(result.body.google_ads.capabilities.data_manager_ready,false);return Math.round(performance.now()-at);}));
    providerHook=null;latencies.sort((a,b)=>a-b);assert.equal(commands.length-batchCommands,8);
    assert.equal(providerActive,0);assert.equal(sql.connectionManager.pool.using,0);assert.equal(sql.connectionManager.pool.waiting,0);
    report.bootstrapBurst={requests:8,providerDelayMilliseconds:100,statements:queries-batchQueries,p50Milliseconds:latencies[3],maxMilliseconds:latencies[7],
      providerPeak,poolUsingAfter:sql.connectionManager.pool.using,poolWaitingAfter:sql.connectionManager.pool.waiting};
    report.checks.push('eight concurrent HTTP bootstrap reads with provider latency all finish, one signed read each, delivery disabled, SQL pool drained; isolated burst only');
    report.checks.push('actual inventory, metadata-only association, SQL ACL/session and signed HTTPS settings query return inherited owner and broker quota without local OAuth hydration or conversion activation');
    process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED='true';
    const enabled=await call();assert.equal(enabled.body.google_ads.capabilities.data_manager_ready,true);
    assert.equal(enabled.body.google_ads.capabilities.conversion_validation_status,'not_validated');
    assert.equal(enabled.body.google_ads.capabilities.can_create_conversion_actions,false);
    process.env.GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED='true';assert.equal((await call()).body.google_ads.capabilities.can_create_conversion_actions,true);
    process.env.RUNTIME_ROLE='gateway';const gateway=await call();assert.equal(gateway.body.google_ads.capabilities.data_manager_ready,false);assert.equal(gateway.body.google_ads.capabilities.can_create_conversion_actions,false);
    delete process.env.RUNTIME_ROLE;process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED='false';process.env.GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED='false';
    const before=commands.length;assert.equal((await request('group_id=5',null)).status,401);assert.equal(commands.length,before);
    await models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_usuario:91002,id_clinica:71}});
    assert.equal((await request()).status,403);assert.equal(commands.length,before);
    await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_usuario:91002,id_clinica:71}});
    report.checks.push('delivery/action gates and gateway role remain closed, configuration never claims validation, and anonymous or incomplete group permission is denied before broker calls');
    providerHook=async()=>{providerHook=null;await sessions.revoke(token);};
    assert.equal((await request()).status,401);token=(await sessions.authenticated(user)).body.token;
    providerHook=async()=>{providerHook=null;await models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_usuario:91002,id_clinica:71}});};
    assert.equal((await request()).status,403);
    await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_usuario:91002,id_clinica:71}});
    providerHook=async()=>{providerHook=null;await models.Clinica.create({id_clinica:99,nombre_clinica:'Nueva clínica ficticia',grupoClinicaId:5,estado_clinica:true});};
    assert.equal((await request()).status,403);await models.Clinica.destroy({where:{id_clinica:99}});
    report.checks.push('SQL session revocation, sibling ACL withdrawal and group membership expansion during provider latency discard the bootstrap response');
    providerState='FAIL';const unavailable=await call();assert.equal(unavailable.body.google_ads.connected,false);assert.equal(unavailable.body.google_ads.capabilities.data_manager_ready,false);
    assert(!JSON.stringify(unavailable).includes('FICTITIOUS_PROVIDER_SECRET'));providerState='PROCESSING';
    assert.equal((await call()).body.google_ads.connected,true);
    const summary=controller.__test.summarizeGoogleMappedAccountAccess(initial.body.google_ads.accounts,[CUSTOMER,'1111111111']);
    assert.equal(summary.all_connected,false);assert.equal(summary.has_data_manager_configuration,false);
    report.checks.push('provider failure is sanitized and recoverable by explicit read; an unmapped requested account cannot be counted as fully connected');
    // Live broker rebinding proves that stale local quota configuration cannot authorize managed readiness.
    await brokerApp.close();brokerApp=null;config.cohort='google-ads-read-v1';
    delete f.binding.googleDataManager;delete f.binding.googleDataManagerEnrollment;delete f.binding.googleAdsActionManagement;
    f.policy.grants[0].operations=require('../../../services/integrations-broker/src/google-ads-contract').OPERATIONS;
    fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});await startBroker();
    process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED='true';const noQuota=await call();
    assert.equal(noQuota.body.google_ads.connected,true);assert.equal(noQuota.body.google_ads.capabilities.data_manager_quota_project_configured,false);
    assert.equal(noQuota.body.google_ads.capabilities.data_manager_ready,false);assert(noQuota.body.google_ads.capabilities.data_manager_missing.includes('quota_project'));
    process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED='false';
    report.checks.push('after real broker restart into Ads read-only cohort, local quota env cannot override absence of remote Data Manager configuration');
    if(metaFixture){
      const stored=await call();assert.equal(stored.body.meta_ads.connected,true);assert.equal(stored.body.meta_ads.availability.available,false);
      assert.equal(stored.body.meta_ads.capi_readiness.ready,false);assert(stored.body.meta_ads.capi_readiness.missing.includes('meta_security_quarantine'));
      assert.equal(stored.body.meta_ads.effective_assets.pixel_id,'1234567892');assert.doesNotMatch(JSON.stringify(stored.body),/NEVER_HYDRATE/);
      await models.MetaConnectionAssignment.update({status:'disconnected'},{where:{id:200}});
      const disconnected=await call();assert.equal(disconnected.body.meta_ads.connected,false);assert.equal(disconnected.body.meta_ads.reason,'security_scope_blocked');
      await models.MetaConnectionAssignment.update({status:'active'},{where:{id:200}});
      providerHook=async()=>{providerHook=null;await models.MetaScopeBlock.create({scope_key:'meta:clinic:71',reason:'scope_disconnected',connection_id:80,actor_user_id:91002,created_at:new Date()});};
      const blocked=await call();assert.equal(blocked.body.meta_ads.connected,false);assert.equal(blocked.body.meta_ads.reason,'security_scope_blocked');
      await models.MetaScopeBlock.destroy({where:{scope_key:'meta:clinic:71'}});
      const resolver=require('../../services/scopeConnectionResolver.service');
      await models.MetaConnectionAssignment.destroy({where:{id:200}});
      const fallback=await resolver.resolveMetaConnectionForScope({groupIdRaw:5,assignmentScopeRaw:'group',metadataOnly:true});
      assert.equal(fallback.source,'legacy_mapping_group');assert.equal(fallback.connection.id,80);assert.equal(fallback.connection.accessToken,undefined);
      await models.ClinicMetaAsset.update({isActive:false},{where:{metaConnectionId:80}});
      const personal=await resolver.resolveMetaConnectionForScope({userId:91002,groupIdRaw:5,assignmentScopeRaw:'group',metadataOnly:true});
      assert.equal(personal.source,'legacy_user');assert.equal(personal.connection.accessToken,undefined);
      await models.MetaConnection.create({id:81,userId:91002,metaUserId:'fictitious-other-meta',accessToken:'NEVER_HYDRATE_OTHER',expiresAt:new Date(Date.now()+86400000)});
      const ambiguous=await resolver.resolveMetaConnectionForScope({userId:91002,groupIdRaw:5,assignmentScopeRaw:'group',metadataOnly:true});
      assert.equal(ambiguous.source,'legacy_user_ambiguous');assert.equal(ambiguous.connection,null);
      await models.MetaConnection.destroy({where:{id:81}});await models.ClinicMetaAsset.update({isActive:true},{where:{metaConnectionId:80}});
      await models.MetaConnectionAssignment.create({id:200,scopeKey:'group:5',assignmentScope:'group',grupoClinicaId:5,metaConnectionId:80,status:'active'});
      const beforePixels=metaCredentialQueries;
      await assert.rejects(require('../../services/effectiveMarketingAssets.service').listMetaPixelsForScopeAdAccount({scope:{assignment_scope:'group',group_id:5},adAccountId:'act_1234567890'}),{code:'meta_security_quarantine'});
      assert.equal(metaCredentialQueries,beforePixels);
      const requestCount=await models.CampaignRequest.count(),configBefore=JSON.stringify((await models.IntakeConfig.findByPk(1)).config);
      const startResult=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:apiServer.address().port,path:'/api/marketing/campaign-onboarding/start',method:'POST',agent:false,
        headers:{authorization:'Bearer '+token,'content-type':'application/json'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(JSON.stringify({group_id:5,assignment_scope:'group',mode:'connect_only',providers:['google_ads','meta_ads']}));});
      assert.equal(startResult.status,503);assert.equal(startResult.body.error,'meta_security_quarantine');
      assert.equal(await models.CampaignRequest.count(),requestCount);assert.equal(JSON.stringify((await models.IntakeConfig.findByPk(1)).config),configBefore);
      report.checks.push('mixed onboarding POST is refused under current Meta containment before CampaignRequest/config writes or credentials; stored setup remains intact');
      report.checks.push('stored Meta connection/assets/pixel survive metadata-only bootstrap while availability/CAPI remain paused; disconnected assignment and sibling tombstone during Google I/O override stale inventory');
      report.checks.push('actual SQL metadata scope, mapping fallback, unique user fallback and ambiguous user preserve resolution without OAuth/page token/additionalData selection; direct pixel request denies before secrets');
    }

    if(process.env.GOOGLE_BOOTSTRAP_E2E_VISUAL==='1')await require('./fixtures/google_bootstrap_e2e_visual.fixture')({app,apiServer,report,token:()=>token,
      fixture:initial.body,request,metaPaused:metaFixture,reads:()=>commands.length});
    assert.equal(tokenReads,0);assert.equal(ingests,0);assert.equal(actionWrites,0);
    assert(commands.every(c=>['google.ads.conversion_settings.read.v1','google.ads.conversion_actions.read.v1'].includes(c.operation)));
    assert.equal(await models.GoogleConversionSubmission.count(),0);assert.equal(await models.GoogleAdsActionPlan.count(),0);
    report.queries=queries;report.signedCommands=commands.length;report.tokenReads=tokenReads;report.ingests=ingests;report.actionWrites=actionWrites;
    if(metaFixture)assert.equal(metaCredentialQueries,0);report.metaCredentialQueries=metaCredentialQueries;
    report.realProvider=false;report.publicMfaAcceptance=false;
  }finally{
    if(apiServer?.listening)await new Promise(resolve=>{apiServer.close(resolve);apiServer.closeAllConnections();});
    if(brokerApp)await brokerApp.close();for(const close of cleanups.reverse())await close();
  }
}).catch(error=>{console.error(error.stack);process.exitCode=1;});
