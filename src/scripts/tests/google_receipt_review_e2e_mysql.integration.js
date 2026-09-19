'use strict';
// Full human route + managed SQL session + scoped runtime + signed HTTPS broker.
// Own MySQL/SQLite, fake Google/Secrets Manager/S3. Never public authentication.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {randomUUID,randomBytes,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {DataTypes:D}=require('sequelize'),{withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async({sql,models,report,registerOwnedLoopbackServer})=>{
  const cleanups=[],{adsFixture,CUSTOMER,MANAGER,ASSET,ACCESS}=require('../../../services/integrations-broker/test/google-ads-fixture.cjs');
  const f=adsFixture({after:fn=>cleanups.push(fn)}),C=require('../../../services/integrations-broker/src/google-data-manager-contract');
  const A=require('../../../services/integrations-broker/src/google-action-management-contract'),T=require('../../../services/integrations-broker/src/google-destination-contract');
  const runtime=require('../../../services/integrations-broker/src/google-main');
  f.binding.connectionRef='qa-audit-v19-receipt';
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
      if(request.path.endsWith('/googleAds:search'))return {results:structuredClone(rows)};
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
    for(const [table,key] of [['GruposClinicas','id_grupo'],['IntakeConfigs','id']])await sql.getQueryInterface().createTable(table,{[key]:{type:D.INTEGER,primaryKey:true}});
    for(const [name,file] of [['Usuario','usuario'],['GoogleConnection','googleconnection'],['ClinicGoogleAdsAccount','clinicgoogleadsaccount'],
      ['GoogleAdsBrokerBinding','googleadsbrokerbinding'],['GoogleAdsBrokerRevocation','googleadsbrokerrevocation'],['GoogleConnectionAssignment','googleconnectionassignment'],
      ['GroupAssetClinicAssignment','groupassetclinicassignment'],['PlatformAuditEvent','platformauditevent']]){models[name]=require('../../../models/'+file)(sql,D);await models[name].sync();}
    models.Clinica=sql.define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},grupoClinicaId:D.INTEGER,estado_clinica:{type:D.BOOLEAN,defaultValue:true}},{tableName:'Clinicas',timestamps:false});await models.Clinica.sync();
    models.UsuarioClinica=sql.define('UsuarioClinica',{id_usuario:D.INTEGER,id_clinica:D.INTEGER,rol_clinica:D.STRING,estado_invitacion:D.STRING},{timestamps:false});await models.UsuarioClinica.sync();
    for(const name of ['20260711003000-create-google-ads-conversion-upload-attempts','20260711012000-add-google-ads-conversion-destination-key','20260712090000-add-data-manager-conversion-statuses',
      '20260918110000-create-google-conversion-submissions','20260918235000-index-google-receipt-review','20260918190000-create-google-ads-action-journal',
      '20260918203000-google-action-recovery-ownership','20260918220000-create-google-destination-journal','20260918224500-index-google-destination-recovery',
      '20260912220000-create-auth-sessions','20260913130000-create-auth-email-challenges','20260914220000-create-auth-trusted-devices'])await require('../../../migrations/'+name).up(sql.getQueryInterface(),require('sequelize'));
    for(const [name,file] of [['GoogleAdsConversionUploadAttempt','googleadsconversionuploadattempt'],['GoogleConversionSubmission','googleconversionsubmission'],
      ['GoogleAdsActionPlan','googleadsactionplan'],['GoogleAdsActionCommand','googleadsactioncommand'],['GoogleDestinationAuthorization','googledestinationauthorization'],
      ['GoogleDestinationCommand','googledestinationcommand'],['AuthSession','authsession'],['AuthTrustedDevice','authtrusteddevice']])models[name]=require('../../../models/'+file)(sql,D);
    await models.Clinica.bulkCreate([{id_clinica:59,grupoClinicaId:5},{id_clinica:71,grupoClinicaId:5}]);await sql.query('INSERT INTO GruposClinicas (id_grupo) VALUES (5)');
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
    const env={GOOGLE_ADS_BROKER_ENABLED:'true',GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED:'true',GOOGLE_ADS_RECEIPT_RECONCILIATION_BROKER_ENABLED:'true',
      GOOGLE_ADS_BROKER_AUDIENCE:f.policy.audience,GOOGLE_ADS_BROKER_KEY_ID:'qa-key',GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE:new Date(Date.now()-60000).toISOString()};
    const review=require('../../services/googleConversionReceiptReview.service').createGoogleConversionReceiptReview({models,sessions,audit,env});
    const resolveRuntime=options=>require('../../services/googleAdsScopedRuntime.service').resolveScopedGoogleAdsRuntime({...options,broker});
    const express=require('express'),app=express();app.use(express.json({limit:'32kb'}));
    app.use('/api/marketing/google-ads/conversion-action-plans',require('../../routes/googleAdsActionPlans.routes').createRouter({models,sessions,resolveRuntime,
      journal:require('../../services/googleAdsActionJournal.service').createGoogleAdsActionJournal({models,sessions,enabled:()=>true})}));
    app.use('/api/marketing/google-ads/conversion-destinations',require('../../routes/googleDestinations.routes').createRouter({models,sessions,resolveRuntime,
      journal:require('../../services/googleDestinationJournal.service').createGoogleDestinationJournal({models,sessions,enabled:()=>true})}));
    app.use('/api/marketing/google-ads/conversion-receipts',require('../../routes/googleConversionReceipts.routes').createRouter({models,sessions,resolveRuntime,review}));
    apiServer=http.createServer(app);await new Promise(resolve=>apiServer.listen(0,'127.0.0.1',resolve));registerOwnedLoopbackServer(apiServer);
    const request=(suffix,body,bearer=token)=>new Promise((resolve,reject)=>{
      const bytes=Buffer.from(JSON.stringify(body));const req=http.request({host:'127.0.0.1',port:apiServer.address().port,path:'/api/marketing/google-ads/'+suffix,method:'POST',agent:false,
        headers:{'content-type':'application/json','content-length':bytes.length,...(bearer?{authorization:'Bearer '+bearer}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,cache:res.headers['cache-control'],body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end(bytes);
    });
    const scope={group_id:5,customer_id:CUSTOMER};const call=async(suffix,extra={})=>{const result=await request(suffix,{...scope,request_id:randomUUID(),...extra});assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
    const p=await call('conversion-action-plans',{mode:'create',currency:'EUR',targets:[{event:'lead',actionId:null}]});
    await call('conversion-action-plans/'+p.planId+'/apply',{confirm_external_mutation:true});
    const destination=await call('conversion-destinations',{plan_id:p.planId,targets:[{event:'lead',sources:['WEB']}],confirm_authorization:true});
    assert.equal(destination.authorization.state,'active');assert.equal(actionWrites,1);
    const runtimeContext=await resolveRuntime({userId:91002,customerId:CUSTOMER,groupId:5,clinicId:null,assignmentScope:'group',requireBroker:true});
    const repository=require('../../services/googleConversionSubmission.repository').createGoogleConversionSubmissionRepository({models,assertContext:broker.assert,
      deliveryIdentity:{audience:env.GOOGLE_ADS_BROKER_AUDIENCE,keyId:env.GOOGLE_ADS_BROKER_KEY_ID},activeSince:env.GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE});
    const delivery=require('../../services/googleConversionDelivery.service').createGoogleConversionDelivery({repository,broker,enabled:()=>true});
    const submissions=[];
    for(let i=0;i<4;i++){
      const now=new Date(),dedupeKey=createHash('sha256').update(randomUUID()).digest('hex'),eventId=randomUUID();
      const attempt=await models.GoogleAdsConversionUploadAttempt.create({dedupeKey,clinicaId:59,grupoClinicaId:5,assignmentScope:'group',googleConnectionId:2,googleConnectionAssignmentId:100,
        customerId:CUSTOMER,loginCustomerId:MANAGER,conversionAction:`customers/${CUSTOMER}/conversionActions/456`,eventName:'lead',eventId,clickIdType:'gclid',
        clickIdHash:createHash('sha256').update('FICTITIOUS_CLICK').digest('hex'),consentStatus:'GRANTED',status:'pending',attemptCount:1,attemptedAt:now,created_at:now,updated_at:now,
        requestMetadata:{currency:'EUR',value_amount:1,user_identifier_count:0,explicit_ad_user_data_consent_status:'GRANTED',visitor_ad_personalization_consent_status:'DENIED'}});
      submissions.push(await delivery.submit({account:runtimeContext.account,context:runtimeContext.brokerContext,attemptId:attempt.id,dedupeKey,beforeExecute:async()=>true,
        payload:{conversionActionId:'456',eventName:'lead',eventSource:'WEB',event:{timestamp:now.toISOString(),transactionId:eventId,value:1,currency:'EUR',advertisingConsent:'GRANTED',
          adUserData:'GRANTED',adPersonalization:'DENIED',clickId:{type:'gclid',value:'FICTITIOUS_CLICK'},userIdentifiers:[],enhancedPolicyDigest:null}}}));
    }
    assert.equal(ingests,4);assert(submissions.every(v=>v.state==='accepted'));
    const revoked=await call('conversion-destinations/'+destination.authorizationId+'/revoke',{input:{planId:p.planId,targets:[{event:'lead',sources:['WEB']}]}});assert.equal(revoked.authorization.state,'revoked');
    const revokeId=revoked.commandId;
    await brokerApp.close();brokerApp=null;await startBroker();
    await sessions.revoke(token);token=(await sessions.authenticated(user)).body.token;
    const beforeRead=statusReads,listId=randomUUID(),checkId=randomUUID();
    const listed=await request('conversion-receipts/list',{...scope,request_id:listId,cursor:null});assert.equal(listed.status,200);assert.equal(listed.cache,'private, no-store');assert.equal(listed.body.items.length,4);assert.equal(statusReads,beforeRead);
    const checked=await request('conversion-receipts/'+submissions[0].submissionId+'/check',{...scope,request_id:checkId});assert.equal(checked.status,200,JSON.stringify(checked.body));assert.equal(checked.body.item.state,'accepted');assert.equal(statusReads,beforeRead+1);
    assert.equal((await request('conversion-receipts/'+submissions[0].submissionId+'/check',{...scope,request_id:checkId})).status,409);assert.equal(statusReads,beforeRead+1);
    report.checks.push('actual HTTP managed-session routes prepare/apply/authorize, journal four fictitious ingests, withdraw, restart TLS runtime/SQLite and recover receipts from a renewed session without reingestion');
    await assert.rejects(broker.conversion(runtimeContext.account,runtimeContext.brokerContext,'status',{submissionId:submissions[0].submissionId},{requestId:randomUUID(),expectedActionId:'456',beforeExecute:async()=>true}),{code:'scope_denied'});
    assert.equal((await request('conversion-receipts/list',{...scope,request_id:randomUUID(),cursor:null},oldToken)).status,401);
    assert.equal((await request('conversion-receipts/list',{...scope,request_id:randomUUID(),cursor:null},null)).status,401);
    assert.equal((await request('conversion-receipts/'+randomUUID()+'/check',{...scope,request_id:randomUUID()})).status,404);
    await models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_usuario:91002,id_clinica:71}});
    assert.equal((await request('conversion-receipts/list',{...scope,request_id:randomUUID(),cursor:null})).status,403);
    await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_usuario:91002,id_clinica:71}});
    report.checks.push('normal status stays denied after withdrawal; anonymous/old signed session, foreign receipt and missing sibling permission are rejected through actual HTTP');
    const beforeLost=statusReads;lostReadAck=true;
    const lost=await request('conversion-receipts/'+submissions[1].submissionId+'/check',{...scope,request_id:randomUUID()});assert.equal(lost.status,503);assert.equal(lost.body.error,'broker_timeout');
    assert.equal((await call('conversion-receipts/'+submissions[1].submissionId+'/check')).item.state,'accepted');assert.equal(statusReads,beforeLost+2);assert.equal(ingests,4);
    const beforeRevoked=await models.GoogleConversionSubmission.findByPk(submissions[2].submissionId,{raw:true}),revokedReadId=randomUUID();
    providerState='SUCCESS';providerHook=async()=>{providerHook=null;await sessions.revoke(token);};
    const denied=await request('conversion-receipts/'+submissions[2].submissionId+'/check',{...scope,request_id:revokedReadId});assert.equal(denied.status,401);assert.equal(denied.body.success,false);
    const afterRevoked=await models.GoogleConversionSubmission.findByPk(submissions[2].submissionId,{raw:true});
    assert.deepEqual(afterRevoked,beforeRevoked);assert.equal(afterRevoked.state,'accepted');
    assert.equal(await models.PlatformAuditEvent.count({where:{correlation_id:revokedReadId,stage:'completed'}}),0);providerState='PROCESSING';
    token=(await sessions.authenticated(user)).body.token;
    report.checks.push('a lost signed read ACK recovers only by a fresh explicit read; SQL session revocation during provider latency releases no result and leaves no partial receipt update');
    // Browser adapter is added below; all app/API/broker state remains the same.
    if(process.env.GOOGLE_RECEIPT_E2E_VISUAL==='1')await require('./fixtures/google_receipt_e2e_visual.fixture')({app,apiServer,report,submissions,
      token:()=>token,setProviderState:value=>{providerState=value;},revoke:()=>sessions.revoke(token),renew:async()=>{token=(await sessions.authenticated(user)).body.token;},
      reads:()=>statusReads,ingests:()=>ingests});
    assert.equal(ingests,4);assert.equal(actionWrites,1);assert.equal(tokenReads,0);
    assert.equal(brokerApp.store.db.prepare('SELECT state FROM google_destination_authorizations WHERE id=?').get(destination.authorizationId).state,'revoked');
    for(const sent of submissions)assert.equal(brokerApp.store.db.prepare('SELECT authorization_id FROM google_data_manager_receipt_authorizations WHERE submission_id=?').get(sent.submissionId).authorization_id,destination.authorizationId);
    const auditRows=await models.PlatformAuditEvent.findAll({raw:true});for(const row of auditRows)require('../../../services/platform-audit/src/event').unpack(row);
    const serialized=JSON.stringify(auditRows);for(const sentinel of [ACCESS,'FICTITIOUS_CLICK','FICTITIOUS_REFRESH','fictitious-human-receipt-'])assert(!serialized.includes(sentinel));
    const canary=auditRows.filter(v=>[listId,checkId,revokeId].includes(v.correlation_id)).map(({body,digest})=>({body,digest}));assert.equal(canary.length,6);
    assert.equal(canary.filter(v=>JSON.parse(v.body).version===19).length,4);assert.equal(canary.filter(v=>JSON.parse(v.body).version===18).length,2);
    fs.writeFileSync(path.join(report.root,'canary-input.json'),JSON.stringify({synthetic:true,purpose:'Actual isolated SQL managed sessions, HTTP routes, signed TLS broker and fictitious Google; not public MFA acceptance',
      includesWorkingChanges:true,sourceBaseHead:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:path.resolve(__dirname,'../../..'),encoding:'utf8'}).trim(),sourceFiles:Object.fromEntries(['src/services/googleConversionReceiptReview.service.js','src/scripts/tests/google_receipt_review_e2e_mysql.integration.js','src/scripts/tests/fixtures/google_receipt_e2e_visual.fixture.js'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../../..',file))).digest('hex')])),records:canary},null,2),{mode:0o600,flag:'wx'});
    report.checks.push('original withdrawn authorization stays unchanged, no local OAuth token hydration, no raw contact/provider IDs in platform audit, and six exact SQL v18/v19 canary records preserved');
    report.ingests=ingests;report.actionWrites=actionWrites;report.statusReads=statusReads;report.signedCommands=commands.length;report.publicMfaAcceptance=false;report.realProvider=false;
  }finally{
    if(apiServer?.listening)await new Promise(resolve=>{apiServer.close(resolve);apiServer.closeAllConnections();});
    if(brokerApp)await brokerApp.close();for(const close of cleanups.reverse())await close();
  }
}).catch(error=>{console.error(error.stack);process.exitCode=1;});
