'use strict';
// Storage and wire-contract acceptance only. Does not impersonate the pending
// clinical writer/worker, expose an API, or assert a completed user enrollment.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{DataTypes:D}=require('sequelize');
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const C=require('../../services/metaMarketingEnrollment.contract');
withIsolatedCampaignMysql(async({sql,models,report,registerOwnedLoopbackServer})=>{
  const qi=sql.getQueryInterface(),migration=require('../../../migrations/20260919080000-meta-marketing-enrollment-journal');
  await migration.up(qi);await migration.down(qi);await migration.up(qi);
  const delivery=require('../../../migrations/20260919100000-meta-marketing-enrollment-delivery-markers');await delivery.up(qi);await delivery.down(qi);await delivery.up(qi);
  for(const [name,file] of [['MetaMarketingEnrollmentRequest','metamarketingenrollmentrequest'],['MetaMarketingEnrollmentClaim','metamarketingenrollmentclaim'],['MetaMarketingEnrollmentIdentity','metamarketingenrollmentidentity']])
    models[name]=require('../../../models/'+file)(sql,D);
  const Requests=models.MetaMarketingEnrollmentRequest,Claims=models.MetaMarketingEnrollmentClaim,Identities=models.MetaMarketingEnrollmentIdentity;
  const cleanup=[],{fixture,TOKEN,APP}=require('../../../services/integrations-broker/test/meta-marketing-oauth-fixture.cjs'),f=fixture({after:fn=>cleanup.push(fn)},{enrollment:true});
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',f.config.tlsKeyFile,'-out',f.config.tlsCertFile,'-days','1',
      '-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    for(const file of [f.config.tlsKeyFile,f.config.tlsCertFile])fs.chmodSync(file,0o600);
    const received=[];let lostReply=null;
    const server=require('../../../services/integrations-broker/src/server').createServer({async execute(raw,headers){
      const command=JSON.parse(raw);received.push({requestId:command.requestId,operation:command.operation,keyId:headers['x-broker-key-id']});
      const result=await f.current.broker.execute(raw,headers);
      if(lostReply===command.operation){lostReply=null;throw Error('FICTITIOUS_ACK_LOST_AFTER_COMMIT');}return result;
    }},{key:fs.readFileSync(f.config.tlsKeyFile),cert:fs.readFileSync(f.config.tlsCertFile)});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));registerOwnedLoopbackServer(server);
    cleanup.push(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
    const gatewayKey=path.join(f.dir,'gateway.pem'),controlKey=path.join(f.dir,'control.pem');
    fs.writeFileSync(gatewayKey,f.gateway.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    fs.writeFileSync(controlKey,f.control.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    const env={META_MARKETING_OAUTH_BROKER_ORIGIN:'https://127.0.0.1:'+server.address().port,META_MARKETING_OAUTH_BROKER_AUDIENCE:f.policy.audience,
      META_MARKETING_OAUTH_BROKER_KEY_ID:'qa-gateway',META_MARKETING_OAUTH_BROKER_KEY_FILE:gatewayKey,
      META_MARKETING_OAUTH_BROKER_CONTROL_KEY_ID:'qa-control',META_MARKETING_OAUTH_BROKER_CONTROL_KEY_FILE:controlKey,META_MARKETING_OAUTH_BROKER_CA_FILE:f.config.tlsCertFile};
    const createClient=require('../../services/metaMarketingOAuthClient.service').createClient,wire=createClient({env});
    const execute=(operation,payload,overrides={})=>wire.execute(f.command(operation,payload,overrides),{timeoutMs:30000});
    const flow=await f.begin(),candidate=(await f.finish(flow)).data.candidate,now=new Date(f.now()),id=randomUUID();
    const selected=C.assets([{assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null},{assetRef:'meta-facebook_page:401',kind:'facebook_page',id:'401',parentPageId:null},
      {assetRef:'meta-instagram_business:501',kind:'instagram_business',id:'501',parentPageId:'401'}]);
    const row={enrollment_id:id,flow_id:flow.flowId,scope_key:f.binding.metaMarketingOAuth.scopeKey,clinic_ids:JSON.stringify(f.binding.metaMarketingOAuth.clinicIds),connection_ref:f.binding.connectionRef,
      scope_digest:flow.payload.scopeDigest,flow_digest:C.hash('FICTITIOUS_FLOW_SNAPSHOT'),candidate_digest:candidate.digest,meta_user_id:candidate.subjectId,app_id:candidate.appId,
      meta_connection_id:2,assignment_digest:C.hash('FICTITIOUS_ASSIGNMENT_SNAPSHOT'),assets:JSON.stringify(selected),mapping_ids:'[]',actor_user_id:91002,session_ref:randomUUID(),session_expires_at:new Date(+now+3600000),
      prepare_request_id:randomUUID(),activate_request_id:randomUUID(),revoke_request_id:randomUUID(),selection_digest:null,state:'prepare_pending',requested_at:now,updated_at:now,prepared_at:null,activated_at:null,revoked_at:null,
      attempts:0,next_attempt_at:now,lease_token:null,lease_until:null,last_error:null};
    C.request(row);
    const unknown=(await execute(C.E.OPERATIONS.status,{enrollmentId:id})).data;
    C.receipt(unknown,row,{states:['prepared','active','revoked'],allowUnknown:true});assert.throws(()=>C.receipt(unknown,row,{states:['prepared']}),{code:'broker_response_invalid'});
    const prepared=(await execute(C.E.OPERATIONS.prepare,{enrollmentId:id,flowId:flow.flowId,scopeDigest:row.scope_digest,candidateDigest:row.candidate_digest,assetRefs:selected.map(a=>a.assetRef)},
      {requestId:row.prepare_request_id})).data;
    C.receipt(prepared,row,{states:['prepared']});
    const stored=await sql.transaction(async transaction=>{
      const request=await Requests.create(C.request(row),{transaction});
      await Identities.create({meta_user_id:row.meta_user_id,app_id:row.app_id,meta_connection_id:2,created_at:now},{transaction});
      await Claims.bulkCreate(C.physical(selected).map(asset_ref=>({asset_ref,enrollment_id:id,created_at:now})),{transaction});return request;
    });
    assert.equal((await Claims.count()),3);assert.equal(C.request(stored.get({plain:true})).enrollment_id,id);
    await assert.rejects(migration.down(qi),/Preserve Meta enrollment ownership/);
    for(const table of ['MetaMarketingEnrollmentRequests','MetaMarketingEnrollmentClaims','MetaMarketingEnrollmentIdentities']){
      const [rows]=await sql.query('SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=:table AND CONSTRAINT_TYPE=\'FOREIGN KEY\'',{replacements:{table}});assert.equal(rows.length,0);
    }
    report.checks.push('Actual additive MySQL journal/claims/identity DDL round trip; atomic insert, canonical model round trip, no cascading FK and populated rollback rejection');
    assert.deepEqual(C.physical([selected.find(a=>a.kind==='instagram_business')]),['meta-facebook_page:401','meta-instagram_business:501']);
    const losers=[randomUUID(),randomUUID()];
    for(const enrollmentId of losers){
      await assert.rejects(sql.transaction(async transaction=>{
        await Requests.create({...row,enrollment_id:enrollmentId,flow_id:randomUUID(),prepare_request_id:randomUUID(),activate_request_id:randomUUID(),revoke_request_id:randomUUID()},{transaction});
        await Claims.create({asset_ref:'meta-facebook_page:401',enrollment_id:enrollmentId,created_at:now},{transaction});
      }),{name:'SequelizeUniqueConstraintError'});
      assert.equal(await Requests.findByPk(enrollmentId),null);
    }
    await assert.rejects(Identities.create({meta_user_id:row.meta_user_id,app_id:'999',meta_connection_id:3,created_at:now}),{name:'SequelizeUniqueConstraintError'});
    await assert.rejects(Identities.create({meta_user_id:'999',app_id:row.app_id,meta_connection_id:2,created_at:now}),{name:'SequelizeUniqueConstraintError'});
    await assert.rejects(Requests.create({...row,enrollment_id:randomUUID(),prepare_request_id:randomUUID(),activate_request_id:randomUUID(),revoke_request_id:randomUUID()}),{name:'SequelizeUniqueConstraintError'});
    report.checks.push('One flow/selection and one physical owner, including IG parent; conflicting subject/app/connection or owner rolls back the whole attempted journal insert');
    // Race for a previously unused physical key, with two independent SQL connections.
    const racing=await Promise.allSettled([0,1].map(()=>sql.transaction(async transaction=>{
      const enrollment_id=randomUUID();await Requests.create({...row,enrollment_id,flow_id:randomUUID(),prepare_request_id:randomUUID(),activate_request_id:randomUUID(),revoke_request_id:randomUUID()},{transaction});
      await Claims.create({asset_ref:'meta-facebook_page:777',enrollment_id,created_at:now},{transaction});return enrollment_id;
    })));
    assert.equal(racing.filter(r=>r.status==='fulfilled').length,1);assert.equal(racing.filter(r=>r.status==='rejected').length,1);
    assert.equal(await Requests.count(),2);assert.equal(await Claims.count(),4);
    report.checks.push('Concurrent independent MySQL transactions claiming the same new page produce exactly one owner and no orphan losing request');
    await stored.update({selection_digest:prepared.selectionDigest,state:'prepared',prepared_at:new Date(prepared.preparedAt)});
    const pending=C.request(stored.get({plain:true}));
    for(const mutate of [v=>v.mapping_ids='[2, 3]',v=>v.prepared_at=null,v=>v.prepared_at=new Date('invalid'),
      v=>v.state='active',v=>{v.state='active';v.activated_at=now;},v=>v.state='revoked',v=>v.last_error=TOKEN,v=>v.lease_token=randomUUID()]){
      const value={...pending};mutate(value);assert.throws(()=>C.request(value),{code:'meta_enrollment_unavailable'});
    }
    for(const mutate of [v=>v.enrollmentId=randomUUID(),v=>v.flowId=randomUUID(),v=>v.scopeKey='clinic:999',v=>v.scopeDigest=C.hash('other'),v=>v.candidateDigest=C.hash('other'),v=>v.clinicSetDigest=C.hash('other'),
      v=>v.selectionDigest=C.hash('other'),v=>v.assets[2].parentPageId='999',v=>v.assets[0].kind='whatsapp_phone_number',v=>v.activatedAt=prepared.preparedAt,v=>v.secret=TOKEN,v=>v.assets=null]){
      const v=structuredClone(prepared);mutate(v);assert.throws(()=>C.receipt(v,pending,{states:['prepared']}),{code:'broker_response_invalid'});
    }
    lostReply=C.E.OPERATIONS.activate;
    await assert.rejects(execute(C.E.OPERATIONS.activate,{enrollmentId:id,scopeDigest:row.scope_digest,selectionDigest:prepared.selectionDigest},{requestId:row.activate_request_id}),{code:'internal_error'});
    assert.equal(received.filter(v=>v.operation===C.E.OPERATIONS.activate).length,1);
    f.restart();
    const active=(await execute(C.E.OPERATIONS.status,{enrollmentId:id})).data;
    C.receipt(active,pending,{states:['active']});assert.equal(active.accessBlocked,false);
    // Controls still work with the ordinary key unavailable. Never fall back to
    // another principal to grant access, or resend an uncertain activation.
    const controlOnly=createClient({env:{...env,META_MARKETING_OAUTH_BROKER_KEY_FILE:path.join(f.dir,'missing-gateway.pem')}});
    const revoked=(await controlOnly.execute(f.command(C.E.OPERATIONS.revoke,{enrollmentId:id},{requestId:row.revoke_request_id}))).data;
    C.receipt(revoked,pending,{states:['revoked']});assert.equal(revoked.accessBlocked,true);
    await stored.update({state:'revoked',revoked_at:new Date(f.now())});assert.equal(await Claims.count(),4);assert.equal(await Identities.count(),1);
    report.checks.push('Actual CRM client over verified TLS/Ed25519 to broker/SQLite; lost activation reply is not retried, control status recovers active after restart and revoke works without the ordinary key');
    report.checks.push('Prepared/active/revoked receipts validate against immutable SQL identity; twelve malformed/cross-scope responses rejected, ownership survives cancellation');
    const tombstoneRow={...row,enrollment_id:randomUUID(),flow_id:randomUUID()};
    const tombstone=(await execute(C.E.OPERATIONS.revoke,{enrollmentId:tombstoneRow.enrollment_id})).data;
    C.receipt(tombstone,tombstoneRow,{states:['revoked']});assert.equal(tombstone.flowId,null);
    for(const mutate of [v=>v.flowId='invalid',v=>v.assets=[selected[0]],v=>v.candidateDigest=row.candidate_digest,v=>v.accessBlocked=false]){
      const value=structuredClone(tombstone);mutate(value);assert.throws(()=>C.receipt(value,tombstoneRow,{states:['revoked']}),{code:'broker_response_invalid'});
    }
    const serialized=JSON.stringify(await Requests.findAll({raw:true}));for(const secret of [TOKEN,APP,flow.code,flow.payload.state])assert(!serialized.includes(secret));
    report.checks.push('Control-before-prepare tombstone accepted only with empty candidate/selection; SQL request contains no OAuth code, state, access token or app credential');
    const before=received.length;
    for(const operation of ['meta.whatsapp.send.v1','meta.marketing.enrollment.prepare.v2','arbitrary.proxy',null])
      assert.throws(()=>wire.execute(f.command(operation,{})),{code:'meta_oauth_unavailable'});
    assert.throws(()=>wire.execute(null),{code:'meta_oauth_unavailable'});
    env.META_MARKETING_OAUTH_BROKER_CONTROL_KEY_ID='changed-control';
    assert.throws(()=>wire.execute(f.command(C.E.OPERATIONS.status,{enrollmentId:id})),{code:'broker_configuration_invalid'});
    env.META_MARKETING_OAUTH_BROKER_CONTROL_KEY_ID='qa-control';
    assert.equal(received.length,before);
    for(const command of received){
      assert.equal(command.keyId,[C.E.OPERATIONS.status,C.E.OPERATIONS.revoke].includes(command.operation)?'qa-control':'qa-gateway');
      if(command.operation===C.E.OPERATIONS.prepare)assert.equal(command.requestId,row.prepare_request_id);
      if(command.operation===C.E.OPERATIONS.activate)assert.equal(command.requestId,row.activate_request_id);
    }
    report.checks.push('Closed operation allowlist and changed signing configuration rejected before network I/O; ordinary/control principals and original command UUIDs verified at the receiving TLS server');
    report.pool={inUse:sql.connectionManager.pool.using,waiting:sql.connectionManager.pool.waiting};assert.deepEqual(report.pool,{inUse:0,waiting:0});
    report.transport={requests:received.length,activationRequests:received.filter(v=>v.operation===C.E.OPERATIONS.activate).length,tls:true,realProvider:false};
    report.completeConsumer=false;report.provider='Fictitious Graph/Secrets; MySQL, configured CRM client, TLS/Ed25519, broker and SQLite real; no CRM route, writer/worker or visual acceptance in this structural test';
  }finally{for(const fn of cleanup.reverse())await fn();}
}).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
