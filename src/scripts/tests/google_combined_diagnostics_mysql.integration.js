'use strict';
// Full combined diagnostics job with actual SQL and signed HTTPS broker; provider-only fixtures.
// Own MySQL/SQLite, fake Google/Secrets Manager/S3. Never public authentication.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {randomUUID,randomBytes,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {DataTypes:D}=require('sequelize'),{withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async({sql,models,report,registerOwnedLoopbackServer})=>{
  const cleanups=[],{adsFixture,MANAGER,ACCESS}=require('../../../services/integrations-broker/test/google-ads-fixture.cjs');
  const CUSTOMER='5992356722',ASSET='ads:'+CUSTOMER; // allowlisted number, exclusively fictitious provider/data
  const f=adsFixture({after:fn=>cleanups.push(fn)}),C=require('../../../services/integrations-broker/src/google-data-manager-contract');
  const A=require('../../../services/integrations-broker/src/google-action-management-contract'),T=require('../../../services/integrations-broker/src/google-destination-contract');
  const runtime=require('../../../services/integrations-broker/src/google-main');
  f.binding.connectionRef='qa-combined-diagnostics';
  f.binding.googleAdsAccounts=[{assetRef:ASSET,customerId:CUSTOMER,loginCustomerId:MANAGER}];
  f.binding.googleDataManager={quotaProjectId:'fictitious-project',destinations:[]};
  f.binding.googleAdsActionManagement={accounts:[{assetRef:ASSET,events:A.EVENTS,currencies:['EUR'],allowCreate:true,allowNormalize:true}]};
  f.binding.googleDataManagerEnrollment={accounts:[{assetRef:ASSET,events:A.EVENTS,sources:['WEB','OTHER']}]};
  f.policy.grants.forEach(g=>{g.tenantRef='clinic:59';g.connectionRef=f.binding.connectionRef;g.assetRef=ASSET;});
  f.policy.grants[0].operations=[...f.policy.grants[0].operations,...Object.values(A.OPERATIONS),...Object.values(T.OPERATIONS),...Object.values(C.OPERATIONS)];
  const rows=[],providerReceipts=new Map(),technicalEvents=[],commands=[];
  let ingests=0,actionWrites=0,statusReads=0,providerState='PROCESSING',providerHook=null,lostReadAck=false,tokenReads=0;
  let validations=0,validationHook=null,settingsFail=false,transactionsActive=0;
  const dependencies={http:async request=>{
    assert.equal(transactionsActive,0,'provider I/O must never hold a local SQL transaction');
    if(request.hostname==='oauth2.googleapis.com'){const result=await f.http(request);result.scope+=' '+C.SCOPES[0];return result;}
    assert.equal(request.token.toString(),ACCESS);
    if(request.hostname==='googleads.googleapis.com'){
      assert.equal(request.loginCustomerId,MANAGER);
      if(request.path.endsWith('/googleAds:search')) {
        if(request.json.query.includes('FROM conversion_action '))return {results:structuredClone(rows)};
        assert.match(request.json.query,/FROM customer LIMIT 2$/);await providerHook?.();
        if(settingsFail)throw Error('FICTITIOUS_PROVIDER_SECRET');
        return {results:[{customer:{id:CUSTOMER,conversionTrackingSetting:{acceptedCustomerDataTerms:true,
          enhancedConversionsForLeadsEnabled:true,googleAdsConversionCustomer:'customers/'+MANAGER}}}]};
      }
      assert(request.path.endsWith('/conversionActions:mutate'));if(request.json.validateOnly)return {};
      actionWrites++;return {results:request.json.operations.map(op=>{assert(op.create);const id=String(456+rows.length);
        const action={...op.create,id,resourceName:`customers/${CUSTOMER}/conversionActions/${id}`,ownerCustomer:'customers/'+CUSTOMER,includeInConversionsMetric:false};
        rows.push({customer:{id:CUSTOMER},conversionAction:action});return {resourceName:action.resourceName};})};
    }
    assert.equal(request.hostname,'datamanager.googleapis.com');
    if(request.path==='/v1/events:ingest'){
      if(request.json.validateOnly){validations++;await validationHook?.();return {};}
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
    models.Sequelize=require('sequelize');
    await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    for(const [name,file] of [['Usuario','usuario'],['GrupoClinica','grupoclinica'],['Clinica','clinica'],
      ['IntakeConfig','intakeconfig'],['WebPublication','webpublication'],['CampaignRequest','campaignrequest'],['MetaConnection','MetaConecction'],
      ['MetaConnectionAssignment','metaconnectionassignment'],['MetaScopeBlock','metascopeblock'],['ClinicMetaAsset','ClinicMetaAsset'],
      ['ClinicWebAsset','clinicwebasset'],['ClinicAnalyticsProperty','clinicanalyticsproperty'],['ClinicBusinessLocation','clinicbusinesslocation'],
      ['GoogleConnection','googleconnection'],['ClinicGoogleAdsAccount','clinicgoogleadsaccount'],
      ['GoogleAdsBrokerBinding','googleadsbrokerbinding'],['GoogleAdsBrokerRevocation','googleadsbrokerrevocation'],
      ['GoogleConnectionAssignment','googleconnectionassignment'],['GroupAssetClinicAssignment','groupassetclinicassignment'],
      ['CampaignWorkspaceSetting','campaignworkspacesetting'],['SyncLog','synclog'],['PlatformAuditEvent','platformauditevent']]) {
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
    // The real job imports other job families. Define their real models against
    // this isolated SQL instance; do not create tables or run those jobs.
    for(const file of fs.readdirSync(path.resolve(__dirname,'../../../models')).filter(v=>v.endsWith('.js')&&v!=='index.js')){
      const define=require('../../../models/'+file);
      if(typeof define!=='function')continue;
      const model=define(sql,D);if(!models[model.name])models[model.name]=model;
    }
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


    const signer=path.join(report.root,'caller.pem');fs.writeFileSync(signer,f.keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    Object.assign(process.env,{GOOGLE_ADS_BROKER_ENABLED:'true',GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED:'true',
      GOOGLE_ADS_BROKER_ORIGIN:'https://127.0.0.1:'+port,GOOGLE_ADS_BROKER_CA_FILE:cert,GOOGLE_ADS_BROKER_KEY_FILE:signer,
      GOOGLE_ADS_BROKER_AUDIENCE:f.policy.audience,GOOGLE_ADS_BROKER_KEY_ID:'qa-key',GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE:new Date(Date.now()-60000).toISOString(),
      GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED:'false',GOOGLE_DATA_MANAGER_QUOTA_PROJECT:'',GOOGLE_CLOUD_PROJECT:'',
      INTAKE_VERIFICATION_ATTESTATION_SECRET:'FICTITIOUS_COMBINED_JOB_ATTESTATION_SECRET'});
    Object.assign(require('../../services/googleAdsBroker.service'),broker);
    Object.assign(require('../../services/accessSession.service'),sessions);
    const credentialSql=[];
    let credentialQueries=0,queries=0;sql.addHook('afterQuery',(_options,query)=>{queries++;
      const text=query.sql||'';if(/SELECT /i.test(text)&&/`(?:GoogleConnections|MetaConnections)`/.test(text)&&/`(?:accessToken|refreshToken|access_token)`/.test(text)){credentialQueries++;credentialSql.push(text);}
    });
    const record=await models.IntakeConfig.findByPk(1),events=['lead','contact','qualified_lead','schedule'];
    const categories=['SUBMIT_LEAD_FORM','CONTACT','QUALIFIED_LEAD','BOOK_APPOINTMENT'];
    const names=['Lead - ClinicaClick','Contact - ClinicaClick','Qualified Lead - ClinicaClick','Schedule - ClinicaClick'];
    rows.push(...events.map((event,i)=>({customer:{id:CUSTOMER},conversionAction:{id:String(456+i),resourceName:`customers/${CUSTOMER}/conversionActions/${456+i}`,
      ownerCustomer:'customers/'+CUSTOMER,name:names[i],category:categories[i],type:'UPLOAD_CLICKS',status:'ENABLED',countingType:'MANY_PER_CLICK',primaryForGoal:false,includeInConversionsMetric:false}})));
    // Explicit policy is a fictitious static fixture; the real cut must review
    // its original provider/evidence/authorization before copying no settings.
    f.binding.googleDataManager.destinations=events.map((event,i)=>({assetRef:ASSET,conversionActionId:String(456+i),events:[event],sources:['WEB','OTHER'],enhancedPolicy:null}));
    await brokerApp.close();brokerApp=null;fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});await startBroker();
    const now=new Date(),domain='fictitious.example',hmac='FICTITIOUS_SNIPPET_SECRET';
    const intake={features:{consent_mode_enabled:true,consent_provider:'clinicaclick'},
      texts:{legal_url:'/legal/',cookies_url:'/cookies/',privacy_url:'/privacy/'},locations:[{id:59},{id:71}],
      google_ads:{enabled:true,customer_id:CUSTOMER,events:Object.fromEntries(events.map((event,i)=>[event,{enabled:true,destinations:[{customer_id:CUSTOMER,conversion_action_id:String(456+i)}]}]))}};
    const attestation=require('../../lib/intake-verification-attestation');
    const hash=attestation.buildVerificationConfigHash({scopeType:'group',scopeId:5,domains:[domain],config:intake,hmacKey:hmac});
    const issued=attestation.issueVerificationAttestation({scopeType:'group',scopeId:5,domain,configHash:hash,nowMs:now.getTime(),signals:{
      installed:true,runtime_compatible:true,runtime_version:'3.3.2',consent_mode_detected:true,google_consent_mode_detected:true,
      cookie_notice_detected:false,cookie_notice_provider:null,legal_urls_detected:true,
      legal_pages:{legal:{configured:true,reachable:true},cookies:{configured:true,reachable:true},privacy:{configured:true,reachable:true}},checked_url:'https://'+domain+'/'}});
    assert(issued.token);intake.snippet_verification={attestations_by_domain:{[domain]:issued.token}};
    await record.update({domains:[domain],hmac_key:hmac,config:intake});
    const strategy=await models.CampaignRequest.create({clinica_id:59,estado:'activa',solicitud:{kind:'marketing_strategy',objective_id:'new_patients',status:'active',mode_snapshot:'connect_only',
      scope:{assignment_scope:'clinic',clinic_id:59,group_id:5,clinic_ids:[59]},channels:[{channel:'google_ads',enabled:true}],destination:{type:'website',url:'https://'+domain+'/'},
      external_targets:[{campaigns:[{provider:'google_ads',customer_id:CUSTOMER,campaign_id:'fictitious-campaign-1'}]}],activation_readiness:{ready:false,validated:false,reason:'conversion_readiness_not_verified'}}});
    const controller=require('../../controllers/campaignOnboarding.controller');
    const state=await require('../../services/effectiveMarketingAssets.service').resolveEffectiveMarketingAssetInventory({groupIdRaw:5,assignmentScopeRaw:'group'});
    assert.equal(require('../../services/campaignMeasurementReadiness.service').assessConsentMeasurementReadiness(state).ready,true);
    const {MetaSyncJobs}=require('../../jobs/sync.jobs');const job=new MetaSyncJobs();assert.equal(job.isInitialized,false);
    let beforeTransaction=null;const transaction=sql.transaction.bind(sql);
    sql.transaction=async(...args)=>{const hook=beforeTransaction;beforeTransaction=null;await hook?.();transactionsActive++;
      try{return await transaction(...args);}finally{transactionsActive--;}};
    const initialQueries=queries,started=Date.now();
    const result=await job.executeGoogleDataManagerDiagnostics({now});
    report.firstJob={statements:queries-initialQueries,milliseconds:Date.now()-started};
    fs.writeFileSync(path.join(report.root,'first-job.json'),JSON.stringify(result,null,2),{mode:0o600});
    assert.equal(result.status,'completed',JSON.stringify(result.report));
    assert.equal(result.report.visitor_choice_personalization_reconciliation.activated,1);
    assert.equal(result.report.internal_enhanced_conversion_activation.status,'activated',JSON.stringify(result.report.internal_enhanced_conversion_activation));
    assert.equal(result.report.connect_only_strategy_readiness_reconciliation.reconciled,1,JSON.stringify(result.report.connect_only_strategy_readiness_reconciliation));
    await record.reload();await strategy.reload();
    assert.equal(record.config.google_ads.enhanced_conversions.enabled,true);assert.equal(strategy.solicitud.activation_readiness.validated,true);
    assert.equal(validations,4);assert.equal(ingests,0);assert.equal(actionWrites,0);assert.equal(credentialQueries,0);assert.equal(tokenReads,0);
    report.checks.push('actual combined job reconciles visitor-choice capability, Enhanced authorization and locked strategy readiness using signed settings/list/validate-only without local provider credentials, creating actions or sending conversions');
    const acceptedConfig=structuredClone(record.config),acceptedStrategy=structuredClone(strategy.solicitud);
    const scopeRuntime=await require('../../services/googleAdsScopedRuntime.service').resolveScopedGoogleAdsRuntime({userId:null,customerId:CUSTOMER,groupId:5,assignmentScope:'group',broker});
    const repository=require('../../services/googleConversionSubmission.repository').createGoogleConversionSubmissionRepository({models,assertContext:broker.assert,
      deliveryIdentity:{audience:f.policy.audience,keyId:'qa-key'},activeSince:process.env.GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE});
    const delivery=require('../../services/googleConversionDelivery.service').createGoogleConversionDelivery({repository,broker,enabled:()=>true});
    const seedReceipt=async()=>{
      const timestamp=new Date(),dedupeKey=createHash('sha256').update(randomUUID()).digest('hex'),eventId=randomUUID();
      const attempt=await models.GoogleAdsConversionUploadAttempt.create({dedupeKey,clinicaId:59,grupoClinicaId:5,assignmentScope:'group',intakeConfigId:1,
        googleConnectionId:2,googleConnectionAssignmentId:100,connectionSource:'mapping_group',customerId:CUSTOMER,loginCustomerId:MANAGER,
        conversionAction:`customers/${CUSTOMER}/conversionActions/456`,destinationKey:'destination_'+CUSTOMER,eventName:'lead',eventId,clickIdType:'gclid',
        clickIdHash:createHash('sha256').update('FICTITIOUS_CLICK').digest('hex'),consentStatus:'GRANTED',status:'pending',attemptCount:1,attemptedAt:timestamp,
        requestMetadata:{broker_delivery_version:1,currency:'EUR',value_amount:1,user_identifier_count:0,explicit_ad_user_data_consent_status:'GRANTED',visitor_ad_personalization_consent_status:'DENIED'}});
      const sent=await delivery.submit({account:scopeRuntime.account,context:scopeRuntime.brokerContext,attemptId:attempt.id,dedupeKey,beforeExecute:async()=>true,
        payload:{conversionActionId:'456',eventName:'lead',eventSource:'WEB',event:{timestamp:timestamp.toISOString(),transactionId:eventId,value:1,currency:'EUR',
          advertisingConsent:'GRANTED',adUserData:'GRANTED',adPersonalization:'DENIED',clickId:{type:'gclid',value:'FICTITIOUS_CLICK'},userIdentifiers:[],enhancedPolicyDigest:null}}});
      assert.equal(sent.state,'accepted');
      await sql.query('UPDATE GoogleAdsConversionUploadAttempts SET updated_at = ? WHERE id = ?',{replacements:[new Date(+now-3600000),attempt.id]});
      return attempt;
    };
    // Load the real receipt consumer explicitly so a fixture/import failure
    // cannot be confused with an expected per-receipt provider error.
    require('../../services/googleConversionDiagnosticsBroker.service');
    const receipt=await seedReceipt(),before=commands.length,beforeQueries=queries,secondStart=Date.now();
    const second=await job.executeGoogleDataManagerDiagnostics({now:new Date(now.getTime()+1000)});
    report.pollJob={statements:queries-beforeQueries,milliseconds:Date.now()-secondStart};
    await receipt.reload();fs.writeFileSync(path.join(report.root,'receipt-diagnostics.json'),JSON.stringify(receipt.responseMetadata,null,2),{mode:0o600});
    assert.equal(second.report.cadence.control_plane_executed,false);assert.equal(commands.length,before);
    assert.equal(second.report.checked,1);assert.equal(second.report.processing,1,JSON.stringify(second.report));assert.equal(ingests,1);
    report.checks.push('second actual job skips control-plane by six-hour cadence but polls one owned receipt through configured signed TLS broker; no replay or local token hydration');

    // Failure of the control-plane must not starve receipt reconciliation.
    settingsFail=true;providerState='SUCCESS';
    await sql.query('UPDATE GoogleAdsConversionUploadAttempts SET updated_at = ? WHERE id = ?',{replacements:[new Date(+now-3600000),receipt.id]});
    const failedControl=await job.executeGoogleDataManagerDiagnostics({now,force_control_plane:true});
    assert.equal(failedControl.report.internal_enhanced_conversion_activation.ready,false);
    assert.equal(failedControl.report.checked,1);assert.equal(failedControl.report.succeeded,1);assert.equal(statusReads,2);assert.equal(ingests,1);
    assert.doesNotMatch(JSON.stringify(failedControl),/FICTITIOUS_PROVIDER_SECRET/);
    report.checks.push('failed Google settings block new readiness while the same full job still checks owned conversion receipts and never resends');
    providerState='PROCESSING';settingsFail=false;

    // Simulate a separately committed writer exactly after provider checks and
    // before the local transaction starts; production guards/SQL are unchanged.
    const resetStrategy=async()=>strategy.update({solicitud:{...structuredClone(acceptedStrategy),activation_readiness:{ready:false,validated:false}}});
    const resetConfig=async()=>{await record.reload();await record.update({hmac_key:hmac,config:structuredClone(acceptedConfig)});};
    try{
      await resetStrategy();
      providerHook=async()=>{providerHook=null;beforeTransaction=()=>models.GoogleConnectionAssignment.update({status:'disconnected'},{where:{id:100}});};
      const enhancedRevoked=await job.executeGoogleDataManagerDiagnostics({now,force_control_plane:true});
      assert.equal(enhancedRevoked.status,'failed');assert.equal(enhancedRevoked.report.internal_enhanced_conversion_activation.ready,false);
      assert.equal(enhancedRevoked.report.internal_enhanced_conversion_activation.error.code,'scope_denied');
      await record.reload();assert.deepEqual(record.config,acceptedConfig);await strategy.reload();assert.equal(strategy.solicitud.activation_readiness.validated,false);
      await models.GoogleConnectionAssignment.update({status:'active'},{where:{id:100}});
      report.checks.push('Enhanced already-active fast path rechecks current assignment under transaction; revocation after settings yields failed/ready=false without changing the persisted configuration');

      await resetStrategy();
      const validationStart=validations;
      validationHook=async()=>{if(validations===validationStart+4)beforeTransaction=()=>models.GoogleConnectionAssignment.update({status:'disconnected'},{where:{id:100}});};
      await assert.rejects(job.executeGoogleDataManagerDiagnostics({now,force_control_plane:true}),{code:'scope_denied'});
      await strategy.reload();assert.equal(strategy.solicitud.activation_readiness.validated,false);
      const failedLog=await models.SyncLog.findOne({order:[['id','DESC']]});
      assert.equal(failedLog.status,'failed');assert.equal(failedLog.status_report.connect_only_strategy_readiness_reconciliation.status,'error');
      await models.GoogleConnectionAssignment.update({status:'active'},{where:{id:100}});validationHook=null;
      report.checks.push('assignment revoked after all four remote validations is rejected inside the persistence transaction; no strategy readiness is saved and the real job records failure');

      await resetStrategy();const pausedValidationStart=validations;
      validationHook=async()=>{if(validations===pausedValidationStart+4)beforeTransaction=()=>models.Clinica.update({estado_clinica:false},{where:{id_clinica:71}});};
      await assert.rejects(job.executeGoogleDataManagerDiagnostics({now,force_control_plane:true}),{code:'conversion_paused'});
      await strategy.reload();assert.equal(strategy.solicitud.activation_readiness.validated,false);
      await models.Clinica.update({estado_clinica:true},{where:{id_clinica:71}});validationHook=null;
      report.checks.push('sibling clinic paused after Google validation blocks readiness at commit; network calls never hold the SQL transaction');

      await resetStrategy();const gateValidationStart=validations;
      validationHook=async()=>{if(validations===gateValidationStart+4)beforeTransaction=async()=>{process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED='false';};};
      await assert.rejects(job.executeGoogleDataManagerDiagnostics({now,force_control_plane:true}),{code:'broker_cohort_disabled'});
      await strategy.reload();assert.equal(strategy.solicitud.activation_readiness.validated,false);
      process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED='true';validationHook=null;
      report.checks.push('delivery gate closed after validation prevents persisting ready state, without changing the separate read-only bootstrap contract');

      // Same SQL timestamp: neither config nor snippet-key changes may pass as
      // the configuration that Google/consent checks just validated.
      for(const changed of ['config','hmac_key']){
        await resetConfig();await resetStrategy();
        providerHook=async()=>{providerHook=null;beforeTransaction=async()=>{
          if(changed==='hmac_key')await sql.query('UPDATE IntakeConfigs SET hmac_key = ? WHERE id = 1',{replacements:['FICTITIOUS_CHANGED_KEY']});
          else await sql.query("UPDATE IntakeConfigs SET config = JSON_SET(config, '$.concurrent_edit', true) WHERE id = 1");
        };};
        const stale=await job.executeGoogleDataManagerDiagnostics({now,force_control_plane:true});
        assert.equal(stale.report.internal_enhanced_conversion_activation.status,'stale_retry');
        assert.equal(stale.report.internal_enhanced_conversion_activation.ready,false);
        assert.equal(stale.report.connect_only_strategy_readiness_reconciliation.reason,'enhanced_activation_not_ready');
        await strategy.reload();assert.equal(strategy.solicitud.activation_readiness.validated,false);
      }
      report.checks.push('same-timestamp config and HMAC-key races both return stale_retry with ready=false and skip strategy readiness; concurrent settings are retained');
      await resetConfig();await resetStrategy();const keyValidationStart=validations;
      validationHook=async()=>{if(validations===keyValidationStart+4)beforeTransaction=()=>sql.query('UPDATE IntakeConfigs SET hmac_key = ? WHERE id = 1',{replacements:['FICTITIOUS_CHANGED_KEY']});};
      const keyRace=await job.executeGoogleDataManagerDiagnostics({now,force_control_plane:true});
      assert.equal(keyRace.report.connect_only_strategy_readiness_reconciliation.status,'blocked');
      assert.equal(keyRace.report.connect_only_strategy_readiness_reconciliation.blocked[0].reason,'measurement_scope_changed_during_validation');
      await strategy.reload();assert.equal(strategy.solicitud.activation_readiness.validated,false);validationHook=null;
      report.checks.push('snippet-key rotation after remote validate-only invalidates the strategy source fingerprint even when the SQL timestamp is unchanged');

      await resetConfig();await resetStrategy();
      const secondStrategy=await models.CampaignRequest.create({clinica_id:59,estado:'activa',solicitud:structuredClone(strategy.solicitud)});
      models.CampaignRequest.addHook('beforeUpdate','qa_atomic_readiness',value=>{if(value.id===secondStrategy.id)throw Object.assign(Error('FICTITIOUS_WRITE_FAILURE'),{code:'fictitious_write_failure'});});
      try{await assert.rejects(job.executeGoogleDataManagerDiagnostics({now,force_control_plane:true}),{code:'fictitious_write_failure'});}
      finally{models.CampaignRequest.removeHook('beforeUpdate','qa_atomic_readiness');}
      await strategy.reload();await secondStrategy.reload();assert.equal(strategy.solicitud.activation_readiness.validated,false);assert.equal(secondStrategy.solicitud.activation_readiness.validated,false);
      await secondStrategy.destroy();
      report.checks.push('SQL failure while persisting the second strategy rolls back the first in the same real transaction; job records failed and no campaign/provider mutation occurs');

      await resetConfig();await resetStrategy();
      const resume=await job.executeGoogleDataManagerDiagnostics({now,force_control_plane:true});
      assert.equal(resume.report.connect_only_strategy_readiness_reconciliation.reconciled,1);
      const resumedValidations=validations,idempotent=await job.executeGoogleDataManagerDiagnostics({now,force_control_plane:true});
      assert.equal(idempotent.report.connect_only_strategy_readiness_reconciliation.status,'already_reconciled');assert.equal(validations,resumedValidations);
      report.checks.push('explicit safe retry after restoring the current scope succeeds; another forced job keeps the same strategy proof without repeat validation');
    }finally{sql.transaction=transaction;providerHook=null;validationHook=null;}
    // The combined job must not select Google or Meta credential columns. The
    // shared bootstrap still has an independent legacy Meta consumer; report
    // those UI queries separately, never call them a migrated Meta boundary.
    assert.equal(credentialQueries,0);assert.equal(tokenReads,0);
    report.jobCredentialQueries=credentialQueries;
    if(process.env.GOOGLE_COMBINED_E2E_VISUAL==='1'){
      const express=require('express'),app=express();app.use(express.json({limit:'32kb'}));
      const authenticate=async(req,res,next)=>{try{req.userData=await sessions.verify(sessions.bearer(req.headers.authorization));next();}catch(error){next(error);}};
      app.get('/api/marketing/campaign-onboarding/bootstrap',authenticate,controller.getCampaignOnboardingBootstrap);
      app.get('/api/marketing/google-ads/conversion-actions',authenticate,controller.listGoogleAdsConversionActions);
      app.post('/api/marketing/google-ads/conversions/data-manager/validate',authenticate,controller.validateGoogleDataManagerConversion);
      app.use((error,_req,res,_next)=>res.status(error.status||error.httpStatus||500).json({success:false,error:error.code||'internal_error'}));
      apiServer=http.createServer(app);await new Promise(resolve=>apiServer.listen(0,'127.0.0.1',resolve));registerOwnedLoopbackServer(apiServer);
      await require('./fixtures/google_bootstrap_e2e_visual.fixture')({app,apiServer,report,token:()=>token,reads:()=>commands.length,deliveryEnabled:true});
    }
    fs.writeFileSync(path.join(report.root,'credential-queries.json'),JSON.stringify(credentialSql,null,2),{mode:0o600});
    const googleCredentialQueries=credentialSql.filter(text=>/`GoogleConnections`/.test(text)).length;
    assert.equal(ingests,1,'only the explicit fictional seed was ingested');assert.equal(actionWrites,0);assert.equal(googleCredentialQueries,0);assert.equal(tokenReads,0);
    report.uiLegacyMetaCredentialQueries=credentialQueries;report.googleCredentialQueries=googleCredentialQueries;
    report.signedCommands=commands.length+statusReads;report.signedControlAndSeedCommands=commands.length;report.signedReceiptReads=statusReads;
    report.validations=validations;report.ingests=ingests;report.actionWrites=actionWrites;report.credentialQueries=credentialQueries;report.tokenReads=tokenReads;
    report.pool={using:sql.connectionManager.pool.using,waiting:sql.connectionManager.pool.waiting};
    assert.deepEqual(report.pool,{using:0,waiting:0});assert.equal(job.isInitialized,false);
    report.realProvider=false;report.publicMfaAcceptance=false;
  }finally{
    if(apiServer?.listening)await new Promise(resolve=>{apiServer.close(resolve);apiServer.closeAllConnections();});
    if(brokerApp)await brokerApp.close();for(const close of cleanups.reverse())await close();
  }
}).catch(error=>{console.error(error.stack);process.exitCode=1;});
