'use strict';
// Actual MySQL models, native lead consumer and signed TLS broker. Provider,
// Secrets Manager and audit sink are fictional; all non-fixture sockets denied.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {randomBytes}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {DataTypes:D}=require('sequelize'),{withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async({sql,models,report,registerOwnedLoopbackServer})=>{
  const cleanups=[],{adsFixture,CUSTOMER,MANAGER,ASSET}=require('../../../services/integrations-broker/test/google-ads-fixture.cjs');
  const f=adsFixture({after:fn=>cleanups.push(fn)}),runtime=require('../../../services/integrations-broker/src/google-main');
  f.policy.grants.forEach(g=>{g.tenantRef='clinic:59';});
  let brokerApp,apiServer,rows=[],pageResponse=null,providerHook=null,providerReads=0,activeTransactions=0,queries=0,credentialQueries=0,beforeTransaction=null;
  const events=[];const now=new Date(),activeSince=new Date(+now-60000).toISOString();
  const row=(id,patch={})=>({customer:{id:CUSTOMER},leadFormSubmissionData:{id,resourceName:`customers/${CUSTOMER}/leadFormSubmissionData/${id}`,
    campaign:`customers/${CUSTOMER}/campaigns/200`,asset:`customers/${CUSTOMER}/assets/300`,adGroup:`customers/${CUSTOMER}/adGroups/400`,
    submissionDateTime:new Date(+now-10000).toISOString().replace('T',' ').replace(/\.\d+Z$/,'+00:00'),gclid:'FICTITIOUS_CLICK',
    leadFormSubmissionFields:[{fieldType:'FULL_NAME',fieldValue:'Contacto ficticio Google'},{fieldType:'EMAIL',fieldValue:'fictional-lead@example.invalid'},
      {fieldType:'PHONE_NUMBER',fieldValue:'+34600000000'},{fieldType:'CUSTOM_HEALTH',fieldValue:'NEVER_RETAIN_CUSTOM_ANSWER'}],
    customLeadFormSubmissionFields:[{fieldValue:'NEVER_RETAIN_CUSTOM_ANSWER'}],...patch}});
  try{
    models.Sequelize=require('sequelize');
    await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    for(const file of fs.readdirSync(path.resolve(__dirname,'../../../models')).filter(v=>v.endsWith('.js')&&v!=='index.js')){
      const define=require('../../../models/'+file);if(typeof define==='function'){const model=define(sql,D);models[model.name]=model;}
    }
    for(const name of ['GrupoClinica','Clinica','GoogleConnection','GoogleConnectionAssignment','ClinicGoogleAdsAccount','GoogleAdsBrokerBinding',
      'GoogleAdsBrokerRevocation','GroupAssetClinicAssignment','CampaignWorkspaceSetting','ExternalCampaignAssignment','LeadIntake','LeadAttributionAudit',
      'AutomationFlowTemplateV2','FlowExecutionV2','JobRequest','PlatformAuditEvent']){
      const model=models[name];assert(model,name);for(const attr of Object.values(model.rawAttributes))delete attr.references;model.refreshAttributes();await model.sync();
    }
    await sql.getQueryInterface().addIndex('LeadIntakes',['external_source','external_id'],{unique:true,name:'uniq_lead_external'});
    await sql.getQueryInterface().addIndex('FlowExecutionsV2',['idempotency_key'],{unique:true,name:'uniq_flow_key'});
    await models.GrupoClinica.create({id_grupo:5,nombre_grupo:'Grupo ficticio'});
    await models.Clinica.bulkCreate([{id_clinica:59,nombre_clinica:'Clínica ficticia A',grupoClinicaId:5,estado_clinica:true},
      {id_clinica:71,nombre_clinica:'Clínica ficticia B',grupoClinicaId:5,estado_clinica:true}]);
    await models.GoogleConnection.create({id:2,googleUserId:f.binding.googleSubject,accessToken:null,refreshToken:null,scopes:'https://www.googleapis.com/auth/adwords'});
    await models.GoogleConnectionAssignment.create({id:100,scopeKey:'group:5',googleConnectionId:2,assignmentScope:'group',grupoClinicaId:5,status:'active'});
    await models.ClinicGoogleAdsAccount.create({id:11,clinicaId:59,grupoClinicaId:5,assignmentScope:'group',googleConnectionId:2,customerId:CUSTOMER,
      loginCustomerId:MANAGER,isActive:true,broker_read_connection_ref:f.binding.connectionRef,broker_read_asset_ref:ASSET});
    await models.GoogleAdsBrokerBinding.create({customer_id:CUSTOMER,mapping_id:11,google_connection_id:2,google_user_id:f.binding.googleSubject,
      connection_ref:f.binding.connectionRef,asset_ref:ASSET,scope_key:'group:5',tenant_clinic_id:59,login_customer_id:MANAGER,state:'active'});
    await models.GroupAssetClinicAssignment.create({assetType:'google.ads_account',assetId:11,clinicaId:71,grupoClinicaId:5});
    const accounts=[{provider:'google_ads',account_id:CUSTOMER,include_future:true,campaign_ids:[]}];
    const setting=await models.CampaignWorkspaceSetting.create({id:'native-leads-fixture',scope_type:'group',scope_id:5,accounts,updated_by_user_id:91002});
    const assignment=await models.ExternalCampaignAssignment.create({provider:'google_ads',customer_id:CUSTOMER,campaign_id:'200',clinica_id:71,grupo_clinica_id:5,status:'active'});
    const cert=path.join(report.root,'tls.crt'),key=path.join(report.root,'tls.key'),cursor=path.join(report.root,'cursor'),signer=path.join(report.root,'caller.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    [cert,key].forEach(v=>fs.chmodSync(v,0o600));fs.writeFileSync(cursor,randomBytes(32),{mode:0o600});
    fs.writeFileSync(signer,f.keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
    const configFile=path.join(report.root,'broker-config.json');fs.writeFileSync(configFile,JSON.stringify({enabled:true,cohort:'google-ads-read-v1',policy:f.policy,
      listenAddress:'127.0.0.1',port,stateFile:path.join(report.root,'broker.sqlite'),cursorKeyFile:cursor,tlsKeyFile:key,tlsCertFile:cert}),{mode:0o600});
    brokerApp=await runtime.main(configFile,{http:async request=>{
      assert.equal(activeTransactions,0,'no provider I/O under SQL transaction');
      if(request.hostname==='oauth2.googleapis.com')return f.http(request);
      assert.equal(request.hostname,'googleads.googleapis.com');assert.equal(request.loginCustomerId,MANAGER);
      assert.match(request.json.query,/FROM lead_form_submission_data /);assert(!request.json.query.includes('custom_lead_form_submission_fields'));
      providerReads++;await providerHook?.();return pageResponse ? pageResponse(request) : {results:structuredClone(rows)};
    },awsFactory:async()=>({secrets:f.sdk,sink:{write:async event=>{events.push(event);return {versionId:'fictitious',digest:event.digest};}},close(){}})});
    registerOwnedLoopbackServer(brokerApp.server);
    Object.assign(process.env,{GOOGLE_ADS_BROKER_ENABLED:'true',GOOGLE_ADS_LEADS_BROKER_ENABLED:'true',GOOGLE_ADS_LEADS_ACTIVE_SINCE:activeSince,
      CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED:'true',GOOGLE_ADS_BROKER_ORIGIN:'https://127.0.0.1:'+port,GOOGLE_ADS_BROKER_CA_FILE:cert,
      GOOGLE_ADS_BROKER_KEY_FILE:signer,GOOGLE_ADS_BROKER_AUDIENCE:f.policy.audience,GOOGLE_ADS_BROKER_KEY_ID:'qa-key',RUNTIME_ROLE:'backend',JOB_RUNTIME_NAMESPACE:'qa-native-leads'});
    const service=require('../../services/googleLeadReception.service'),scheduler=require('../../services/jobScheduler.service');
    // Persist the real automation execution/job, but never drain it or send.
    scheduler.setExternalDispatcher(async()=>false);
    const payload={setting_id:setting.id,account_id:CUSTOMER},job={type:service.JOB_TYPE,origin:service.ORIGIN,requested_by:null};
    const env={...process.env},run=()=>service.runGoogleLeadSync(payload,job,{models,env,now:()=>now,
      ensureToken:()=>assert.fail('managed leads cannot hydrate a local token'),search:()=>assert.fail('managed leads cannot use legacy Google')});
    const tx=sql.transaction.bind(sql);sql.transaction=async(...args)=>{const hook=beforeTransaction;beforeTransaction=null;await hook?.();activeTransactions++;try{return await tx(...args);}finally{activeTransactions--;}};
    sql.addHook('afterQuery',(_options,q)=>{queries++;if(/SELECT /i.test(q.sql||'')&&/`GoogleConnections`/.test(q.sql)&&/`(?:accessToken|refreshToken)`/.test(q.sql))credentialQueries++;});
    rows=[row('initial')];const start=Date.now(),q0=queries;const first=await run();
    assert.equal(first.status,'completed',JSON.stringify(first));assert.equal(first.received,1);
    report.firstImport={milliseconds:Date.now()-start,statements:queries-q0};
    const lead=await models.LeadIntake.findOne();assert.equal(lead.clinica_id,71);assert.equal(lead.google_ads_campaign_id,'200');
    assert.equal(lead.email,'fictional-lead@example.invalid');assert.equal(lead.created_at.toISOString(),new Date(rows[0].leadFormSubmissionData.submissionDateTime).toISOString());
    assert.equal(await models.FlowExecutionV2.count(),0);assert.equal(await models.JobRequest.count(),0);
    assert.doesNotMatch(JSON.stringify(await models.LeadAttributionAudit.findAll()),/NEVER_RETAIN|fictional-lead|consent/);
    assert.equal((await run()).duplicates,1);assert.equal(await models.LeadIntake.count(),1);assert.equal(await models.LeadAttributionAudit.count(),1);
    report.checks.push('group account routes to the assigned clinic, preserves provider identity/time and basic contact, atomically audits and deduplicates; paused/no active automation creates no job');
    const flow=await models.AutomationFlowTemplateV2.create({public_id:'fictitious-flow',template_key:'lead_auto_reply_system__clinic_71',version:1,name:'Fictional lead response',
      trigger_type:'lead_nuevo',trigger_config:{configured:true,sources:['write']},is_active:true,clinic_id:71,entry_node_id:'N1',nodes:[],published_at:now,created_by:91002});
    assert.equal((await run()).duplicates,1);assert.equal(await models.FlowExecutionV2.count(),1);assert.equal(await models.JobRequest.count(),1);
    assert.equal((await run()).duplicates,1);assert.equal(await models.FlowExecutionV2.count(),1);assert.equal(await models.JobRequest.count(),1);
    const queued=await models.JobRequest.findOne();assert.equal(queued.type,'automations_v2_execute');assert.equal(queued.status,'pending');
    assert.doesNotMatch(JSON.stringify(queued.payload),/fictional-lead|600000000/);
    report.checks.push('existing recovery on a post-cut duplicate uses the actual automation execution and JobRequest dedupe; two retries retain exactly one pending job with IDs only, dispatcher is disabled');
    await flow.update({is_active:false});
    rows=[row('old',{submissionDateTime:new Date(+now-86400000).toISOString().replace('T',' ').replace(/\.\d+Z$/,'+00:00')})];
    assert.equal((await run()).historical_skipped,1);assert.equal(await models.LeadIntake.count(),1);assert.equal(await models.JobRequest.count(),1);
    report.checks.push('lead before explicit activation is counted as historical_skipped; no import, notification or historical replay');
    rows=[row('new')];
    for(const value of ['false',undefined]){env.GOOGLE_ADS_LEADS_BROKER_ENABLED=value;const before=providerReads;assert.equal((await run()).error_message,'google_lead_broker_disabled');assert.equal(providerReads,before);}
    env.GOOGLE_ADS_LEADS_BROKER_ENABLED='true';env.GOOGLE_ADS_LEADS_ACTIVE_SINCE='invalid';assert.equal((await run()).error_message,'google_lead_broker_configuration_invalid');env.GOOGLE_ADS_LEADS_ACTIVE_SINCE=activeSince;
    report.checks.push('closed gate or absent/invalid activation cut refuses managed import without OAuth fallback');
    rows=[row('malformed')];providerHook=async()=>{await models.GoogleConnectionAssignment.update({status:'disconnected'},{where:{id:100}});};
    assert.equal((await run()).status,'failed');assert.equal(await models.LeadIntake.count(),1);providerHook=null;await models.GoogleConnectionAssignment.update({status:'active'},{where:{id:100}});
    report.checks.push('assignment revoked during provider I/O blocks the received page before SQL writes');
    beforeTransaction=async()=>{await models.ClinicGoogleAdsAccount.update({broker_read_connection_ref:'connection:rebound'},{where:{id:11}});await models.GoogleAdsBrokerBinding.update({connection_ref:'connection:rebound'},{where:{mapping_id:11}});};
    assert.equal((await run()).status,'failed');assert.equal(await models.LeadIntake.count(),1);await models.ClinicGoogleAdsAccount.update({broker_read_connection_ref:f.binding.connectionRef},{where:{id:11}});await models.GoogleAdsBrokerBinding.update({connection_ref:f.binding.connectionRef},{where:{mapping_id:11}});
    report.checks.push('original broker reference is checked under persistence transaction; replacing binding after the read cannot adopt new authority');
    beforeTransaction=()=>models.Clinica.update({estado_clinica:false},{where:{id_clinica:71}});
    assert.equal((await run()).error_message,'google_lead_scope_inactive');await models.Clinica.update({estado_clinica:true},{where:{id_clinica:71}});
    const narrower=await models.CampaignWorkspaceSetting.create({id:'clinic-narrow',scope_type:'clinic',scope_id:71,accounts:[{...accounts[0],include_future:false,campaign_ids:['201']}],updated_by_user_id:91002});
    assert.equal((await run()).pending,1);assert.equal(await models.LeadIntake.count(),1);await narrower.destroy();
    await assignment.update({status:'archived'});assert.equal((await run()).pending,1);await assignment.update({status:'active'});
    report.checks.push('paused recipient, narrower clinic campaign selection and archived assignment never route the lead to the representative clinic');
    beforeTransaction=()=>{env.GOOGLE_ADS_LEADS_ACTIVE_SINCE=new Date(+now-30000).toISOString();};
    assert.equal((await run()).error_message,'google_lead_authorization_changed');env.GOOGLE_ADS_LEADS_ACTIVE_SINCE=activeSince;
    models.LeadAttributionAudit.addHook('beforeCreate','qa-reject',()=>{throw Error('FICTITIOUS_SQL_FAILURE');});
    assert.equal((await run()).status,'failed');assert.equal(await models.LeadIntake.count(),1);assert.equal(await models.LeadAttributionAudit.count(),1);models.LeadAttributionAudit.removeHook('beforeCreate','qa-reject');
    report.checks.push('changed activation cut and attribution write failure roll back the complete lead transaction');
    rows=[row('valid'),row('invalid-contact',{leadFormSubmissionFields:[{fieldType:'EMAIL',fieldValue:'bad'}]})];
    const contacts=await run();assert.equal(contacts.received,1);assert.equal(contacts.invalid_contacts,1);assert.equal(contacts.retryable,false);
    report.checks.push('one invalid contact is reported without discarding a separate valid import');
    const beforeCount=await models.LeadIntake.count();rows=Array.from({length:251},(_,i)=>row('page-'+i));
    rows[250].leadFormSubmissionData.campaign=`customers/9999999999/campaigns/200`;
    pageResponse=request=>request.json.pageToken ? {results:[rows[250]]} : {results:rows.slice(0,250),nextPageToken:'FICTITIOUS_SECOND_PAGE'};
    const badPageReads=providerReads;assert.equal((await run()).status,'failed');assert.equal(providerReads-badPageReads,2);assert.equal(await models.LeadIntake.count(),beforeCount);pageResponse=null;
    report.checks.push('malformed identity after the first slice is refused before any partial SQL import');
    rows=Array.from({length:251},(_,i)=>row('historical-page-'+i,{submissionDateTime:new Date(+now-86400000).toISOString().replace('T',' ').replace(/\.\d+Z$/,'+00:00')}));
    const pageStart=Date.now(),pageQ=queries,readsBefore=providerReads;const pages=await run();
    assert.equal(pages.historical_skipped,251);assert.equal(providerReads-readsBefore,1);assert.equal(await models.LeadIntake.count(),beforeCount);
    report.pagedRead={statements:queries-pageQ,milliseconds:Date.now()-pageStart,providerReads:providerReads-readsBefore,rows:251};
    report.checks.push('251 projected leads traverse two signed slices with one provider query; full completion precedes classification and historical rows never enqueue');
    if(process.env.GOOGLE_NATIVE_LEADS_VISUAL==='1')await require('./fixtures/google_native_leads_visual.fixture')({sql,models,report,registerOwnedLoopbackServer});
    rows=Array.from({length:20},(_,i)=>row('load-'+i));
    const batchStarted=Date.now(),batchQueries=queries;const batch=await run();assert.equal(batch.received,20);assert.equal(batch.status,'completed');
    report.import20={milliseconds:Date.now()-batchStarted,statements:queries-batchQueries,rows:20};
    const retryStarted=Date.now(),retryQueries=queries;const retry=await run();assert.equal(retry.duplicates,20);assert.equal(retry.received,0);
    report.retry20={milliseconds:Date.now()-retryStarted,statements:queries-retryQueries,rows:20};
    assert.equal(await models.JobRequest.count(),1);assert.equal(credentialQueries,0);
    report.checks.push('twenty new contacts and the complete retry use sequential short transactions; exactly twenty leads/audits, no duplicate or new automation job, with measured SQL cost');
    assert.equal(credentialQueries,0);report.credentialQueries=credentialQueries;report.providerReads=providerReads;
    const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.join(report.root,'broker.sqlite'),{readOnly:true});
    const durable=JSON.stringify(db.prepare('SELECT * FROM commands').all())+JSON.stringify(db.prepare('SELECT * FROM audit_outbox').all())+JSON.stringify(events);
    assert.doesNotMatch(durable,/fictional-lead|Contacto ficticio|NEVER_RETAIN|FICTITIOUS_CLICK/);
    report.signedCommands=db.prepare('SELECT count(*) AS n FROM commands').get().n;assert(db.prepare('SELECT result FROM commands').all().every(v=>v.result===null));db.close();
    report.checks.push('actual signed broker receipts and audit contain no contact, click ID or custom answer; backend makes zero credential-column reads');
    report.pool={inUse:sql.connectionManager.pool.using,waiting:sql.connectionManager.pool.waiting};
  }finally{if(apiServer)await new Promise(resolve=>apiServer.close(resolve));if(brokerApp)await brokerApp.close();for(const fn of cleanups.reverse())await fn();}
}).catch(error=>{console.error(error.stack);process.exitCode=1;});
