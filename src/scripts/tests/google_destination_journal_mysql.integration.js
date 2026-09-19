'use strict';
// Own MySQL/SQLite only. Managed-session proofs and Google/AWS are fictitious.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const migrations = ['20260918190000-create-google-ads-action-journal.js', '20260918203000-google-action-recovery-ownership.js',
    '20260918220000-create-google-destination-journal.js', '20260918224500-index-google-destination-recovery.js'];
  for (const name of migrations) { const m = require('../../../migrations/' + name); await m.up(sql.getQueryInterface()); await m.up(sql.getQueryInterface()); }
  for (const [name,file] of [['GoogleAdsActionPlan','googleadsactionplan'],['GoogleAdsActionCommand','googleadsactioncommand'],
    ['GoogleDestinationAuthorization','googledestinationauthorization'],['GoogleDestinationCommand','googledestinationcommand'],['PlatformAuditEvent','platformauditevent']]) {
    models[name] = require('../../../models/' + file)(sql,D);
  }
  await models.PlatformAuditEvent.sync();
  for (const [name,fields] of [
    ['Clinica',{ id_clinica: { type:D.INTEGER,primaryKey:true },grupoClinicaId:D.INTEGER,estado_clinica:{type:D.BOOLEAN,defaultValue:true} }],
    ['ClinicGoogleAdsAccount',{ id:{type:D.INTEGER,primaryKey:true},customerId:D.STRING,isActive:D.BOOLEAN,clinicaId:D.INTEGER,assignmentScope:D.STRING,grupoClinicaId:D.INTEGER }],
    ['GroupAssetClinicAssignment',{assetType:D.STRING,assetId:D.INTEGER,clinicaId:D.INTEGER}],
    ['UsuarioClinica',{id_usuario:D.INTEGER,id_clinica:D.INTEGER,rol_clinica:D.STRING,estado_invitacion:D.STRING}],
  ]) { models[name]=sql.define(name,fields,{timestamps:false}); await models[name].sync(); }
  await models.Clinica.bulkCreate([{id_clinica:59,grupoClinicaId:5},{id_clinica:71,grupoClinicaId:5}]);
  await models.ClinicGoogleAdsAccount.create({id:11,customerId:'1234567890',isActive:true,clinicaId:59,assignmentScope:'group',grupoClinicaId:5});
  const role=require('../../lib/role-helpers').MARKETING_WRITE_ROLES[0];
  await models.UsuarioClinica.bulkCreate([59,71].map(id_clinica=>({id_usuario:91002,id_clinica,rol_clinica:role,estado_invitacion:'aceptada'})));
  const A=require('../../../services/integrations-broker/src/google-action-management-contract');
  const C=require('../../../services/integrations-broker/src/google-destination-contract');
  const {adsFixture,CUSTOMER,MANAGER,ASSET,ACCESS}=require('../../../services/integrations-broker/test/google-ads-fixture.cjs');
  const cleanups=[], f=adsFixture({after:fn=>cleanups.push(fn)}), scope=require('./fixtures/google_ads_broker_scope.fixture').scopeFixture();
  scope.mapping.clinicaId=59; scope.binding.connection_ref=f.binding.connectionRef;scope.mapping.broker_read_connection_ref=f.binding.connectionRef;
  f.policy.grants.forEach(g=>{g.tenantRef='clinic:59';});
  f.policy.grants[0].operations=[...f.policy.grants[0].operations,...Object.values(A.OPERATIONS),...Object.values(C.OPERATIONS)];
  f.binding.googleDataManager={quotaProjectId:'fictitious-project',destinations:[]};
  f.binding.googleAdsActionManagement={accounts:[{assetRef:ASSET,events:A.EVENTS,currencies:['EUR'],allowCreate:true,allowNormalize:true}]};
  f.binding.googleDataManagerEnrollment={accounts:[{assetRef:ASSET,events:A.EVENTS,sources:['WEB','OTHER']}]};
  let at=Date.now(),allowed=true,sessionValid=true,enabled=true,beforeRemote,afterRemote,writes=0;
  const rows=[],calls=[];
  const http=async request=>{
    assert.equal(request.hostname,'googleads.googleapis.com');assert.equal(request.token.toString(),ACCESS);assert.equal(request.loginCustomerId,MANAGER);
    if(request.path.endsWith('/googleAds:search')) return {results:structuredClone(rows)};
    if(request.json.validateOnly) return {}; writes++;
    return {results:request.json.operations.map(op=>{
      assert(op.create);const id=String(456+rows.length),action={...op.create,id,resourceName:`customers/${CUSTOMER}/conversionActions/${id}`,
        ownerCustomer:'customers/'+CUSTOMER,includeInConversionsMetric:false};
      rows.push({customer:{id:CUSTOMER},conversionAction:action});return {resourceName:action.resourceName};
    })};
  };
  const config=require('../../../services/integrations-broker/src/google-main');
  const {createGoogleAdsDeveloperSecret}=require('../../../services/integrations-broker/src/google-ads-developer-secret');
  const makeRemote=()=>{
    const actions=require('../../../services/integrations-broker/src/google-action-management').createGoogleActionManagement({store:f.store,http,
      withDeveloperSecret:createGoogleAdsDeveloperSecret({client:f.sdk,accountId:config.ACCOUNT,prefix:'/clinicaclick/integrations/prod/',kmsKeyArn:config.SECRET_KEY}),now:()=>at});
    const destinations=require('../../../services/integrations-broker/src/google-destinations').createGoogleDestinations({store:f.store,actionManagement:actions,now:()=>at});
    return new (require('../../../services/integrations-broker/src/broker').Broker)({store:f.store,policy:f.policy,secrets:f.secrets,now:()=>at,
      operations:{...actions.operations,...destinations.operations}});
  };
  let remote=makeRemote();
  const client={execute:async command=>{
    const destination=Object.values(C.OPERATIONS).includes(command.operation);
    const q=await models[destination?'GoogleDestinationCommand':'GoogleAdsActionCommand'].findByPk(command.requestId);
    assert.equal(q?.state,'attempted','SQL admission must be committed before transport');
    calls.push(structuredClone(command));await beforeRemote?.(command);
    const signed=require('../../../services/integrations-broker/src/auth').signRequest(command,{keyId:'qa-key',privateKey:f.keys.privateKey,audience:f.policy.audience,now:at});
    const result=await remote.execute(signed.raw,signed.headers);await afterRemote?.(command,result);return result;
  }};
  const broker=require('../../services/googleAdsBroker.service').createGoogleAdsBroker({...scope.options,client,actionManagementEnabled:()=>enabled,destinationsEnabled:()=>enabled,now:()=>at});
  const sessions={verifyReference:async()=>{if(!sessionValid) throw Object.assign(Error('PRIVATE'),{status:401});}};
  const actionService=require('../../services/googleAdsActionJournal.service').createGoogleAdsActionJournal({models,sessions,now:()=>at,enabled:()=>enabled});
  const make=(audit)=>require('../../services/googleDestinationJournal.service').createGoogleDestinationJournal({models,sessions,now:()=>at,enabled:()=>enabled,audit});
  let service=make();
  const context={actor:{userId:91002,sessionRef:randomUUID(),expiresAt:at+3600000},scopeKey:'group:5',
    runtime:{deliveryMode:'broker',broker,brokerContext:await broker.prepare(scope.mapping),account:scope.mapping},beforeExecute:async()=>allowed};
  const actionRun=(family,input,requestId=randomUUID())=>actionService.execute(context,family,input,{requestId,confirmExternalMutation:family==='apply'});
  const newPlan=async()=>{
    const p=await actionRun('prepare',{mode:'create',currency:'EUR',targets:[{event:'lead',actionId:null}]});
    await actionRun('apply',{planId:p.planId});return p.planId;
  };
  const input=planId=>({planId,targets:[{event:'lead',sources:['WEB']}]});
  const run=(family,payload,requestId=randomUUID(),ctx=context,confirm=family==='authorize')=>service.execute(ctx,family,payload,{requestId,confirmAuthorization:confirm});
  const newIntent=async()=>({authorizationId:randomUUID(),input:input(await newPlan())});
  const revoke=async(intent,ctx=context)=>run('revoke',intent,randomUUID(),ctx);
  try {
    const first=await newIntent(), baseline=calls.length;
    await assert.rejects(run('authorize',first.input,first.authorizationId,context,false),{code:'google_destination_confirmation_required'});
    assert.equal(calls.length,baseline);
    const authorized=await run('authorize',first.input,first.authorizationId);assert.equal(authorized.authorization.state,'active');assert.equal(authorized.outcomeUnknown,false);
    service=make();assert.equal((await run('authorize',first.input,first.authorizationId)).authorization.state,'active');assert.equal(calls.length,baseline+1);
    await assert.rejects(run('authorize',first.input),{code:'google_destination_conflict'});
    await assert.rejects(run('authorize',{...first.input,targets:[{event:'lead',sources:['OTHER']}]},first.authorizationId),{code:'google_destination_conflict'});
    const renewed={...context,actor:{...context.actor,sessionRef:randomUUID(),expiresAt:at+7200000}};
    assert.equal((await run('status',{authorizationId:first.authorizationId},randomUUID(),renewed)).authorization.state,'active');
    await assert.rejects(run('authorize',first.input,first.authorizationId,renewed),{code:'google_destination_not_found'});
    await revoke(first,renewed);
    report.checks.push('explicit confirmation, original selection, command identity and actor ownership survive restart; new session can read/revoke but cannot redispatch authorize');

    const lost=await newIntent();afterRemote=command=>{if(command.operation===C.OPERATIONS.authorize) throw Object.assign(Error('PRIVATE'),{code:'broker_unavailable'});};
    await assert.rejects(run('authorize',lost.input,lost.authorizationId),{code:'broker_unavailable'});afterRemote=null;remote=makeRemote();
    const count=calls.length;assert.equal((await run('authorize',lost.input,lost.authorizationId)).outcomeUnknown,true);assert.equal(calls.length,count);
    assert.equal((await run('status',{authorizationId:lost.authorizationId},randomUUID(),renewed)).authorization.state,'active');
    assert.equal((await models.GoogleDestinationCommand.findByPk(lost.authorizationId)).state,'completed');await revoke(lost);
    report.checks.push('lost broker authorization response recovers through read-only status and completes the original human audit without another authorize');

    const early=await newIntent();assert.equal((await revoke(early,renewed)).authorization.state,'revoked');
    await assert.rejects(run('authorize',early.input,early.authorizationId),error=>['google_destination_not_found','google_destination_conflict'].includes(error.code));
    assert.equal((await run('status',{authorizationId:early.authorizationId})).authorization.state,'revoked');
    const racing=await newIntent();beforeRemote=async command=>{if(command.operation===C.OPERATIONS.authorize){beforeRemote=null;await revoke(racing,renewed);}};
    await assert.rejects(run('authorize',racing.input,racing.authorizationId));
    const raceStatus=await run('status',{authorizationId:racing.authorizationId});assert.equal(raceStatus.authorization.state,'revoked');
    const original=await models.GoogleDestinationCommand.findByPk(racing.authorizationId);assert.equal(original.state,'completed');assert.equal(original.last_error,'authorization_withdrawn');
    report.checks.push('early withdrawal and racing revoke create durable broker tombstones, prevent late activation and record unknown original outcomes honestly');

    const late=await newIntent();afterRemote=async command=>{if(command.operation===C.OPERATIONS.authorize){afterRemote=null;await revoke(late,renewed);}};
    const lateReceipt=await run('authorize',late.input,late.authorizationId);
    assert.equal(lateReceipt.authorization.state,'revoked');assert.equal(lateReceipt.canRevoke,false);
    assert.equal((await models.GoogleDestinationCommand.findByPk(late.authorizationId)).last_error,'authorization_withdrawn');
    report.checks.push('a late active authorization response cannot overwrite a withdrawal already confirmed in SQL or rewrite its unknown original audit outcome');

    const lostRevoke=await newIntent();await run('authorize',lostRevoke.input,lostRevoke.authorizationId);
    const revokeId=randomUUID();afterRemote=command=>{if(command.operation===C.OPERATIONS.revoke) throw Object.assign(Error('PRIVATE'),{code:'broker_unavailable'});};
    await assert.rejects(run('revoke',lostRevoke,revokeId),{code:'broker_unavailable'});afterRemote=null;
    assert.equal((await run('revoke',lostRevoke,revokeId)).outcomeUnknown,true);
    const recovered=await run('status',{authorizationId:lostRevoke.authorizationId},randomUUID(),renewed);
    assert.equal(recovered.outcomeUnknown,false);assert.equal(recovered.canRevoke,false);assert.equal(recovered.authorization.state,'revoked');
    assert.equal((await models.GoogleDestinationCommand.findByPk(revokeId)).state,'completed');
    report.checks.push('lost revocation acknowledgement remains uncertain until status proves the durable withdrawal; repeat UUID does not transmit');

    const retryWithdrawal=await newIntent();await run('authorize',retryWithdrawal.input,retryWithdrawal.authorizationId);
    const missingWithdrawalId=randomUUID();beforeRemote=command=>{if(command.operation===C.OPERATIONS.revoke) throw Object.assign(Error('PRIVATE'),{code:'broker_unavailable'});};
    await assert.rejects(run('revoke',retryWithdrawal,missingWithdrawalId),{code:'broker_unavailable'});beforeRemote=null;
    const stillActive=await run('status',{authorizationId:retryWithdrawal.authorizationId});assert.equal(stillActive.outcomeUnknown,true);assert.equal(stillActive.canRevoke,true);
    assert.equal((await revoke(retryWithdrawal,renewed)).authorization.state,'revoked');
    assert.equal((await models.GoogleDestinationCommand.findByPk(missingWithdrawalId)).state,'completed');
    report.checks.push('a new explicit withdrawal of the SAME intent safely completes a prior unreceived withdrawal; no authorization retry or new permission');

    const paused=await newIntent();await models.Clinica.update({estado_clinica:false},{where:{id_clinica:71}});
    await assert.rejects(run('authorize',paused.input,paused.authorizationId),{code:'conversion_paused'});
    assert.equal((await revoke(paused)).authorization.state,'revoked');
    assert.equal((await run('status',{authorizationId:paused.authorizationId})).authorization.state,'revoked');
    await models.Clinica.update({estado_clinica:true},{where:{id_clinica:71}});
    report.checks.push('a paused shared clinic prevents granting permission but allows authorized withdrawal and observation');

    const access=await newIntent(), beforeDenied=calls.length;
    for(const mutate of [()=>{allowed=false;},()=>{sessionValid=false;},()=>{enabled=false;}]){
      mutate();await assert.rejects(run('authorize',access.input,access.authorizationId));allowed=true;sessionValid=true;enabled=true;
    }
    await models.UsuarioClinica.destroy({where:{id_usuario:91002,id_clinica:71}});
    await assert.rejects(run('authorize',access.input,access.authorizationId),{code:'scope_denied'});
    await models.UsuarioClinica.create({id_usuario:91002,id_clinica:71,rol_clinica:role,estado_invitacion:'aceptada'});
    await assert.rejects(run('status',{authorizationId:early.authorizationId},randomUUID(),{...context,actor:{...context.actor,userId:91003}}));
    assert.equal(calls.length,beforeDenied);
    report.checks.push('managed session, cohort flags, ALL shared clinic write memberships and actor ownership deny before transport');

    const revokedAccess=await newIntent();afterRemote=async command=>{if(command.operation===C.OPERATIONS.authorize){afterRemote=null;
      await models.UsuarioClinica.destroy({where:{id_usuario:91002,id_clinica:71}});}};
    await assert.rejects(run('authorize',revokedAccess.input,revokedAccess.authorizationId),{code:'scope_denied'});
    assert.equal((await models.GoogleDestinationAuthorization.findByPk(revokedAccess.authorizationId)).receipt,null);
    await models.UsuarioClinica.create({id_usuario:91002,id_clinica:71,rol_clinica:role,estado_invitacion:'aceptada'});
    assert.equal((await run('status',{authorizationId:revokedAccess.authorizationId},randomUUID(),renewed)).authorization.state,'active');await revoke(revokedAccess);
    report.checks.push('loss of shared-clinic membership after broker commit discards the response; authorized recovery later reads the original receipt without repeating authorization');

    const repo=require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent), failAt={reason:null};
    service=make({...repo,append:async(value,options)=>{if(value.reason===failAt.reason) throw Error('PRIVATE');return repo.append(value,options);}});
    const failed=await newIntent();failAt.reason='command_admitted';
    const beforeFailed=calls.length;await assert.rejects(run('authorize',failed.input,failed.authorizationId),{code:'audit_unavailable'});
    assert.equal(calls.length,beforeFailed);assert.equal(await models.GoogleDestinationAuthorization.findByPk(failed.authorizationId),null);
    failAt.reason='broker_acknowledged';await assert.rejects(run('authorize',failed.input,failed.authorizationId),{code:'audit_unavailable'});
    assert.equal((await models.GoogleDestinationCommand.findByPk(failed.authorizationId)).state,'attempted');
    failAt.reason=null;assert.equal((await run('status',{authorizationId:failed.authorizationId})).authorization.state,'active');await revoke(failed);
    service=make();report.checks.push('outbox admission failure rolls back decision and transport; failed receipt transaction preserves UUID and recovers after broker commit');

    const concurrent=await newIntent();const outcomes=await Promise.allSettled([run('authorize',concurrent.input,concurrent.authorizationId),run('authorize',concurrent.input,concurrent.authorizationId)]);
    assert(outcomes.some(v=>v.status==='fulfilled'));assert.equal(calls.filter(c=>c.requestId===concurrent.authorizationId).length,1);
    await run('status',{authorizationId:concurrent.authorizationId});await revoke(concurrent);
    report.checks.push('concurrent admission of one authorization UUID crosses transport at most once');

    // A fresh browser knows no UUID. Listing only reads its own durable decisions;
    // selecting one later triggers an explicit status request, never authorize.
    const list=(cursor=null,planId=null,ctx=renewed)=>service.list(ctx,{cursor,planId},{requestId:randomUUID()});
    const pending=await newIntent();beforeRemote=command=>{if(command.operation===C.OPERATIONS.authorize)throw Object.assign(Error('PRIVATE'),{code:'broker_unavailable'});};
    await assert.rejects(run('authorize',pending.input,pending.authorizationId));beforeRemote=null;
    const pendingPage=await list(null,pending.input.planId);assert.equal(pendingPage.items.length,1);
    assert.equal(pendingPage.items[0].authorizationId,pending.authorizationId);assert.equal(pendingPage.items[0].observedState,'unknown');
    assert.equal(pendingPage.items[0].outcomeUnknown,true);assert.deepEqual(pendingPage.items[0].input,pending.input);
    assert.deepEqual(pendingPage.items[0].expected,[{event:'lead',conversionActionId:'456',sources:['WEB']}]);
    const beforeList=calls.length;const commandCount=await models.GoogleDestinationCommand.count();
    for(let i=0;i<2;i++)await list(null,pending.input.planId);
    assert.equal(calls.length,beforeList);assert.equal(await models.GoogleDestinationCommand.count(),commandCount);
    await revoke({authorizationId:pendingPage.items[0].authorizationId,input:pendingPage.items[0].input},renewed);
    report.checks.push('reference-free renewed-session recovery includes unknown original decisions and derives exact action IDs from the applied parent; listing dispatches zero broker calls and no mutation commands');

    for(let i=0;i<24;i++)await revoke(await newIntent());
    const all=(await models.GoogleDestinationAuthorization.findAll({attributes:['authorization_id'],raw:true})).map(row=>row.authorization_id);
    const pages=[],seen=[];let cursor=null;
    do{const page=await list(cursor);pages.push(page.items.length);seen.push(...page.items.map(row=>row.authorizationId));cursor=page.nextCursor;}while(cursor);
    assert.equal(new Set(seen).size,seen.length);assert.deepEqual([...seen].sort(),all.sort());assert(pages[0]===20&&pages.length>1);
    const firstPage=await list();at+=1000;const inserted=await newIntent();await revoke(inserted);
    const later=await list(firstPage.nextCursor);assert(!later.items.some(row=>row.authorizationId===inserted.authorizationId));
    const captured=await broker.assert(context.runtime.account,context.runtime.brokerContext);
    const [explain]=await sql.query('EXPLAIN SELECT * FROM GoogleDestinationAuthorizations FORCE INDEX (cc_google_destination_recovery) WHERE actor_user_id=? AND mapping_id=? AND scope_key=? AND scope_digest=? ORDER BY created_at DESC,authorization_id DESC LIMIT 21',
      {replacements:[context.actor.userId,11,'group:5',A.hash(captured)]});
    assert.equal(explain[0].key,'cc_google_destination_recovery');assert.doesNotMatch(explain[0].Extra||'',/filesort/);
    report.recoveryQueryPlan=explain;
    report.checks.push('20-row keyset pages cover equal-millisecond records exactly once and exclude newer inserts on later pages; full-row EXPLAIN uses the same forced scoped index without filesort');

    await models.UsuarioClinica.bulkCreate([59,71].map(id_clinica=>({id_usuario:91003,id_clinica,rol_clinica:role,estado_invitacion:'aceptada'})));
    assert.equal((await list(null,null,{...renewed,actor:{...renewed.actor,userId:91003}})).items.length,0);
    assert.equal((await list(null,inserted.input.planId,{...renewed,actor:{...renewed.actor,userId:91003}})).items.length,0);
    await models.Clinica.update({estado_clinica:false},{where:{id_clinica:71}});assert.equal((await list(null,inserted.input.planId)).items.length,1);
    await models.Clinica.update({estado_clinica:true},{where:{id_clinica:71}});
    await models.UsuarioClinica.destroy({where:{id_usuario:91002,id_clinica:71}});await assert.rejects(list(),{code:'scope_denied'});
    await models.UsuarioClinica.create({id_usuario:91002,id_clinica:71,rol_clinica:role,estado_invitacion:'aceptada'});
    sessionValid=false;await assert.rejects(list(),{code:'google_destination_session_required'});sessionValid=true;
    enabled=false;await assert.rejects(list(),{code:'broker_cohort_disabled'});enabled=true;
    for(const bad of [{createdAt:'bad',authorizationId:randomUUID()},{createdAt:'2026-99-01T00:00:00.000Z',authorizationId:randomUUID()},
      {createdAt:new Date(at).toISOString(),authorizationId:randomUUID(),scope:'other'}])await assert.rejects(list(bad),{code:'invalid_request'});
    await assert.rejects(list(firstPage.nextCursor,inserted.input.planId),{code:'invalid_request'});
    const stored=await models.GoogleDestinationAuthorization.findByPk(inserted.authorizationId),ownerBefore=stored.owner_digest;
    await stored.update({owner_digest:'a'.repeat(64)});await assert.rejects(list(null,inserted.input.planId),{code:'google_destination_recovery_unavailable'});
    await stored.update({owner_digest:ownerBefore});
    report.checks.push('listing cannot cross actor ownership, tampered original identity, missing shared-clinic permissions, session or cohort; paused clinics remain recoverable and malformed cursors cannot broaden scope');

    let listReads=0;const originalFind=models.GoogleDestinationAuthorization.findAll.bind(models.GoogleDestinationAuthorization);
    models.GoogleDestinationAuthorization.findAll=async(...args)=>{listReads++;return originalFind(...args);};
    service=make({...repo,append:async(value,options)=>{if(value.reason===failAt.reason)throw Error('PRIVATE');return repo.append(value,options);}});
    failAt.reason='list_requested';await assert.rejects(list(),{code:'audit_unavailable'});assert.equal(listReads,0);
    failAt.reason='list_prepared';await assert.rejects(list(),{code:'audit_unavailable'});assert.equal(listReads,1);
    failAt.reason=null;service=make();models.GoogleDestinationAuthorization.findAll=originalFind;
    assert.equal((await list(null,inserted.input.planId)).items.length,1);
    await require('../../../migrations/'+migrations[3]).down(sql.getQueryInterface());await require('../../../migrations/'+migrations[3]).up(sql.getQueryInterface());
    assert.equal((await list(null,inserted.input.planId)).items.length,1);
    service=make({...repo,append:async(value,options)=>{const result=await repo.append(value,options);if(value.reason==='list_prepared')allowed=false;return result;}});
    await assert.rejects(list(),{code:'scope_denied'});allowed=true;service=make();
    assert.equal((await list(null,inserted.input.planId)).items.length,1);
    report.checks.push('failed list admission prevents decision reads; failed completion releases no page and leaves an auditable attempt; post-read permission loss suppresses the page; index rollback/reapply preserves all decisions');

    const httpNode=require('node:http'),express=require('express'),app=express();app.use(express.json({limit:'16kb'}));
    const apiSessions={...sessions,bearer:value=>{assert.equal(value,'Bearer FICTITIOUS_QA_SESSION');return 'FICTITIOUS';},
      verify:async()=>({sessionVersion:1,userId:context.actor.userId,jti:context.actor.sessionRef,exp:context.actor.expiresAt/1000})};
    app.use('/destinations',require('../../routes/googleDestinations.routes').createRouter({models,sessions:apiSessions,journal:service,
      resolveRuntime:async options=>{assert.equal(options.requireBroker,true);return context.runtime;}}));
    const server=httpNode.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const agent=new httpNode.Agent({keepAlive:false});agent.createConnection=require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
    const request=(suffix,body,auth=true)=>new Promise((resolve,reject)=>{
      const req=httpNode.request({host:'127.0.0.1',port:server.address().port,agent,path:'/destinations'+suffix,method:'POST',
        headers:{'content-type':'application/json',...(auth?{authorization:'Bearer FICTITIOUS_QA_SESSION'}:{})}},res=>{
        const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>{
          const text=Buffer.concat(chunks).toString();assert.doesNotMatch(text,/PRIVATE|FICTITIOUS|secretArn|connectionRef|googleSubject/);
          resolve({status:res.statusCode,body:JSON.parse(text),cache:res.headers['cache-control']});
        });
      });req.on('error',reject);req.end(JSON.stringify(body));
    });
    try{
      const intent=await newIntent(),body={group_id:5,customer_id:CUSTOMER,request_id:intent.authorizationId,plan_id:intent.input.planId,targets:intent.input.targets,confirm_authorization:true};
      assert.equal((await request('/',body,false)).status,401);
      assert.equal((await request('/',{...body,confirm_authorization:false})).status,409);
      for(const bad of [{...body,clinic_id:59},{...body,token:'PRIVATE'},{...body,group_id:'5suffix'}])assert.equal((await request('/',bad)).status,400);
      const response=await request('/',body);assert.equal(response.status,200);assert.equal(response.cache,'private, no-store');assert.equal(response.body.authorization.state,'active');
      const follow={group_id:5,customer_id:CUSTOMER,request_id:randomUUID()};
      assert.equal((await request('/'+intent.authorizationId+'/status',follow)).status,200);
      assert.equal((await request('/'+intent.authorizationId+'/revoke',{...follow,request_id:randomUUID(),input:intent.input})).body.authorization.state,'revoked');
      assert.equal((await request('/'+randomUUID()+'/status',{...follow,request_id:randomUUID()})).status,404);
      const listing=await request('/list',{...follow,request_id:randomUUID(),cursor:null,plan_id:intent.input.planId});
      assert.equal(listing.status,200);assert.equal(listing.cache,'private, no-store');assert.equal(listing.body.items[0].authorizationId,intent.authorizationId);
      for(const patch of [{cursor:{limit:1000}},{plan_id:'foreign'},{owner_id:91003}])assert.equal((await request('/list',{...follow,request_id:randomUUID(),cursor:null,plan_id:null,...patch})).status,400);
    }finally{agent.destroy();await new Promise(resolve=>server.close(resolve));}
    report.checks.push('loopback HTTP API checks managed-session proof, explicit confirmation, closed bodies, scope and no-store without credential exposure');

    await assert.rejects(require('../../../migrations/'+migrations[2]).down(sql.getQueryInterface()),/Preserve destination/);
    const snapshot=await require('../../lib/securitySchemaContract').snapshot(async(query,values)=>(await sql.query(query,{replacements:values}))[0]);
    const contract={tables:{},migrations:migrations.slice(2).map(name=>({name,sha256:createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../../../migrations',name))).digest('hex')}))};
    for(const name of ['GoogleDestinationAuthorizations','GoogleDestinationCommands']){
      const table=snapshot.tables.find(row=>row.TABLE_NAME===name);
      contract.tables[name]={ENGINE:table.ENGINE,TABLE_COLLATION:table.TABLE_COLLATION,
        columns:snapshot.columns.filter(row=>row.TABLE_NAME===name).map(({TABLE_NAME,...row})=>row),
        indexes:[...new Set(snapshot.indexes.filter(row=>row.TABLE_NAME===name).map(row=>row.INDEX_NAME))].map(index=>({name:index,
          columns:snapshot.indexes.filter(row=>row.TABLE_NAME===name&&row.INDEX_NAME===index).map(({TABLE_NAME,...row})=>row)})),
        checks:snapshot.checks.filter(row=>row.TABLE_NAME===name).map(({TABLE_NAME,...row})=>row)};
    }
    report.schema=path.join(report.root,'destination-schema.json');fs.writeFileSync(report.schema,JSON.stringify(contract,null,2));
    console.log('SCHEMA_EVIDENCE='+report.schema);
    const published=require('../../../ops/security/schema-contract.json');
    if(process.env.GOOGLE_DESTINATION_SCHEMA_CAPTURE!=='1'){
      for(const [name,value] of Object.entries(contract.tables)){
        // Older journal contracts imply no generated columns. Check the empty
        // expression explicitly so an unexpected computed column still fails.
        const expected=published.tables[name];
        assert.deepEqual(value,{...expected,columns:expected.columns.map(column=>({
          ...column,GENERATION_EXPRESSION:column.GENERATION_EXPRESSION??'',
        }))});
      }
      for(const migration of contract.migrations)assert.deepEqual(published.migrations.find(v=>v.name===migration.name),migration);
    }
    report.checks.push('repeatable additive migration, exact MySQL metadata and refusal to destroy authorization history');
    const events=(await models.PlatformAuditEvent.findAll({raw:true})).map(row=>JSON.parse(row.body));
    assert(events.some(v=>v.version===18&&v.reason==='authorization_withdrawn'&&v.outcome==='unknown'));
    assert(events.some(v=>v.version===18&&v.reason==='result_recovered'&&v.sessionRef!==v.initiatorSessionRef));
    assert.doesNotMatch(JSON.stringify(events),/FICTITIOUS|PRIVATE|userIdentifiers|clickId/);report.providerWrites=writes;
  }finally{for(const cleanup of cleanups.reverse())await cleanup();}
}).catch(error=>{console.error(error);process.exitCode=1;});
