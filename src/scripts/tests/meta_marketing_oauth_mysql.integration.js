'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),http=require('node:http');
const {execFileSync}=require('node:child_process'),{randomUUID,randomBytes}=require('node:crypto'),{DataTypes:D}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async({sql,models,report,registerOwnedLoopbackServer})=>{
  const discovery=process.env.META_OAUTH_DISCOVERY_TEST==='1';
  const cleanup=[],{fixture,TOKEN,APP}=require('../../../services/integrations-broker/test/meta-marketing-oauth-fixture.cjs'),f=fixture({after:fn=>cleanup.push(fn)},{discovery});
  const B=require('../../../services/integrations-broker/src/meta-marketing-oauth-contract'),C=require('../../services/metaMarketingOAuth.contract');
  let brokerApp,server,browser,clock=new Date(),queryCount=0;
  try{
    for(const [name,file] of [['Usuario','usuario'],['Clinica','clinica'],['GrupoClinica','grupoclinica'],['AuthSession','authsession'],['AuthEmailChallenge','authemailchallenge'],
      ['PlatformAuditEvent','platformauditevent'],['MetaScopeBlock','metascopeblock'],['MetaMarketingBrokerRevocation','metamarketingbrokerrevocation']]){
      models[name]=require('../../../models/'+file)(sql,D);for(const attribute of Object.values(models[name].rawAttributes))delete attribute.references;models[name].refreshAttributes();await models[name].sync();
    }
    models.UsuarioClinica=sql.define('UsuarioClinica',{id_usuario:D.INTEGER,id_clinica:D.INTEGER,rol_clinica:D.STRING,estado_invitacion:D.STRING},{timestamps:false});await models.UsuarioClinica.sync();
    const migration=require('../../../migrations/20260919060000-meta-marketing-oauth'),qi=sql.getQueryInterface();await migration.up(qi);await migration.down(qi);await migration.up(qi);
    models.MetaMarketingOAuthSlot=require('../../../models/metamarketingoauthslot')(sql,D);models.MetaMarketingOAuthRequest=require('../../../models/metamarketingoauthrequest')(sql,D);
    const Slot=models.MetaMarketingOAuthSlot,Requests=models.MetaMarketingOAuthRequest;
    await models.GrupoClinica.bulkCreate([{id_grupo:5,nombre_grupo:'Grupo ficticio'},{id_grupo:6,nombre_grupo:'Grupo ajeno'}]);
    await models.Clinica.bulkCreate([59,71,88].map(id=>({id_clinica:id,nombre_clinica:'Clínica ficticia '+id,grupoClinicaId:id===88?6:5,estado_clinica:true})));
    const role=require('../../lib/role-helpers').MARKETING_WRITE_ROLES[0];await models.UsuarioClinica.bulkCreate([59,71].map(id_clinica=>({id_usuario:91002,id_clinica,rol_clinica:role,estado_invitacion:'aceptada'})));
    const user=await models.Usuario.create({id_usuario:91002,nombre:'Responsable ficticio',email_usuario:'meta-oauth@example.invalid',password_usuario:'FICTITIOUS_PASSWORD_HASH'});
    const secret='FICTITIOUS_META_OAUTH_SESSION',sessions=require('../../services/accessSession.service').createService({models,now:()=>clock,config:()=>({mode:'enforce',ttl:3600,secret})});
    let token=(await sessions.authenticated(user)).body.token;
    const mfa=async()=>{
      const at=new Date(Math.floor(+clock/1000)*1000),id=randomUUID();
      await models.AuthEmailChallenge.create({challenge_id:id,user_id:91002,challenge_hash:C.hash(id),code_hash:C.hash('fictitious-code:'+id),credential_binding:require('../../services/accessSession.service').binding(user,secret),email_hash:C.hash('fictitious-email'),
        state:'verified',created_at:at,expires_at:new Date(+at+300000),absolute_expires_at:new Date(+at+300000),last_sent_at:at,verified_at:at});
      token=(await sessions.authenticated(user,{emailChallengeId:id})).body.token;return token;
    };
    const mb=f.binding.metaMarketingOAuth;mb.scopeKey='group:5';mb.clinicIds=[59,71];mb.scopes.sort();
    for(const grant of f.policy.grants){grant.tenantRef='clinic:59';grant.assetRef='meta-enroll:group:5';}
    f.records.get(f.binding.secretArn).get(mb.slotVersionId).body=JSON.stringify({version:1,provider:'meta-marketing-oauth-slot',connectionRef:f.binding.connectionRef,scopeKey:mb.scopeKey,clinicSetDigest:B.clinicDigest(mb),appId:mb.appId});
    await Slot.create({scope_key:mb.scopeKey,connection_ref:f.binding.connectionRef,asset_ref:'meta-enroll:'+mb.scopeKey,app_id:mb.appId,clinic_ids:JSON.stringify(mb.clinicIds),scopes:JSON.stringify(mb.scopes),
      redirect_uri:mb.redirectUri,expires_at:new Date(f.binding.expiresAt),state:'active'});
    await assert.rejects(migration.down(qi),/Preserve Meta OAuth/);
    const index=await qi.showIndex('MetaMarketingOAuthRequests');assert(index.some(i=>i.name==='cc_meta_oauth_scope_state'));
    report.checks.push('Actual additive DDL up/down/up, populated rollback denial and request scope/state index');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',f.config.tlsKeyFile,'-out',f.config.tlsCertFile,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    for(const p of [f.config.tlsKeyFile,f.config.tlsCertFile])fs.chmodSync(p,0o600);
    const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));f.config.port=reserve.address().port;await new Promise(r=>reserve.close(r));
    const configFile=path.join(f.dir,'runtime.json');fs.writeFileSync(configFile,JSON.stringify(f.config),{mode:0o600});
    const technical=[],start=async()=>{brokerApp=await require('../../../services/integrations-broker/src/meta-marketing-oauth-main').main(configFile,{http:f.http,awsFactory:async()=>({secrets:f.aws,sink:{write:async row=>{technical.push(JSON.parse(row.event));return {versionId:randomUUID(),digest:row.digest};}},close(){}})});registerOwnedLoopbackServer(brokerApp.server);};await start();
    const gatewayKey=path.join(f.dir,'gateway.pem'),controlKey=path.join(f.dir,'control.pem');
    fs.writeFileSync(gatewayKey,f.gateway.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});fs.writeFileSync(controlKey,f.control.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    const wire=require('../../services/metaMarketingOAuthClient.service').createClient({env:{META_MARKETING_OAUTH_BROKER_ORIGIN:'https://127.0.0.1:'+f.config.port,META_MARKETING_OAUTH_BROKER_AUDIENCE:f.policy.audience,
      META_MARKETING_OAUTH_BROKER_KEY_ID:'qa-gateway',META_MARKETING_OAUTH_BROKER_KEY_FILE:gatewayKey,META_MARKETING_OAUTH_BROKER_CONTROL_KEY_ID:'qa-control',META_MARKETING_OAUTH_BROKER_CONTROL_KEY_FILE:controlKey,META_MARKETING_OAUTH_BROKER_CA_FILE:f.config.tlsCertFile}});
    let commands=0,enabled=true,afterWire=null;
    const service=require('../../services/metaMarketingOAuth.service').createService({models,sessions,now:()=>clock,enabled:()=>enabled,workerEnabled:()=>true,discoveryEnabled:()=>discovery,
      client:{execute:async(...args)=>{commands++;const result=await wire.execute(...args);if(afterWire)await afterWire(args[0],result);return result;}},returnOrigin:'https://app.example.invalid'});
    const app=require('express')();app.use(require('express').json());app.use('/oauth/meta/marketing',require('../../routes/metaMarketingOAuth.routes').createRouter({service,sessions,returnOrigin:'https://app.example.invalid'}));
    const auditView=await require('./fixtures/meta_oauth_audit.fixture')({models,sessions,app,now:()=>clock,discovery});
    server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));registerOwnedLoopbackServer(server);const base='http://127.0.0.1:'+server.address().port;
    const endpoint='/oauth/meta/marketing/authorization',query='?assignment_scope=group&group_id=5';
    const request=(method='GET',target=endpoint+query,body)=>new Promise((resolve,reject)=>{
      const req=http.request(base+target,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})}},res=>{let text='';res.on('data',v=>text+=v);res.on('end',()=>{let value;try{value=JSON.parse(text);}catch{value=null;}resolve({status:res.statusCode,body:value,location:res.headers.location});});});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
    });
    const begin=async()=>{const r=await request('POST');assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
    const callback=flow=>request('GET','/oauth/meta/marketing/callback?'+new URLSearchParams({state:new URL(flow.authUrl).searchParams.get('state'),code:'FICTITIOUS_CRM_CODE_'+flow.requestId}));
    const cancel=flow=>request('DELETE',endpoint+'/'+flow.requestId+query);
    const latest=id=>Requests.findByPk(id,{raw:true});
    sql.addHook('beforeQuery',()=>queryCount++);
    assert.equal((await request('POST')).status,401);assert.equal(await Requests.count(),0);await mfa();
    await models.UsuarioClinica.update({rol_clinica:'personaldeclinica'},{where:{id_clinica:71}});assert.equal((await request('POST')).status,403);assert.equal(commands,0);
    await models.UsuarioClinica.update({rol_clinica:role},{where:{id_clinica:71}});
    assert.equal((await request('POST',endpoint+query,{code:'FICTITIOUS_UNEXPECTED'})).status,400);
    assert.equal((await request('POST',endpoint+'?assignment_scope=group&group_id=5&clinic_id=88')).status,400);
    models.PlatformAuditEvent.addHook('beforeCreate','qa-meta-audit-failure',()=>{throw Error('FICTITIOUS_AUDIT_FAILURE');});
    try{assert.equal((await request('POST')).status,503);assert.equal(await Requests.count(),0);assert.equal(commands,0);}
    finally{models.PlatformAuditEvent.removeHook('beforeCreate','qa-meta-audit-failure');}
    report.checks.push('Managed email MFA, write permission in every clinic and canonical scope/body enforced before broker I/O');
    const before=queryCount,at=Date.now(),flow=await begin();report.begin={queries:queryCount-before,elapsedMs:Date.now()-at};
    assert.equal((await request('POST')).status,409);const codes=f.state.codes;
    const cb=await callback(flow);assert.equal(cb.status,303);assert(cb.location.startsWith('https://app.example.invalid/pages/settings?meta_authorization='));
    assert.equal((await latest(flow.requestId)).state,'staged');assert.equal(f.state.codes,codes+1);
    await callback(flow);assert.equal(f.state.codes,codes+1);assert.equal((await request()).body.candidateReady,true);
    if(discovery){
      const target=endpoint+'/'+flow.requestId+'/assets'+query,q=queryCount,t=Date.now();const d=await request('POST',target);assert.equal(d.status,200,JSON.stringify(d.body));assert.equal(d.body.inventory.assets.length,3);
      report.discoveryFirst={queries:queryCount-q,elapsedMs:Date.now()-t,assets:d.body.inventory.assets.length};
      models.PlatformAuditEvent.addHook('beforeCreate','qa-inventory-capture',row=>{if(JSON.parse(row.body).version===23)throw Error('FICTITIOUS_DISCOVERY_AUDIT_FAILURE');});
      const before=commands;try{assert.equal((await request('POST',target)).status,503);assert.equal(commands,before);}finally{models.PlatformAuditEvent.removeHook('beforeCreate','qa-inventory-capture');}
      afterWire=async command=>{if(command.operation.endsWith('.assets.v1'))await models.UsuarioClinica.update({rol_clinica:'personaldeclinica'},{where:{id_clinica:71}});};
      const changed=await request('POST',target);afterWire=null;assert.equal(changed.status,403);assert.equal(changed.body.inventory,undefined);
      await models.UsuarioClinica.update({rol_clinica:role},{where:{id_clinica:71}});
      models.PlatformAuditEvent.addHook('beforeCreate','qa-inventory-result',row=>{if(JSON.parse(row.body).version===23&&row.stage==='completed')throw Error('FICTITIOUS_DISCOVERY_RESULT_FAILURE');});
      try{const r=await request('POST',target);assert.equal(r.status,503);assert.equal(r.body.inventory,undefined);}finally{models.PlatformAuditEvent.removeHook('beforeCreate','qa-inventory-result');}
      report.checks.push('Candidate inventory traverses actual CRM/TLS/broker/Graph adapter; human v23 capture/result and fresh whole-scope permission gate output; no partial result after audit failure');
    }
    const serialized=JSON.stringify(await Requests.findAll({raw:true}));for(const hidden of [TOKEN,APP,new URL(flow.authUrl).searchParams.get('state'),'FICTITIOUS_CRM_CODE_'+flow.requestId])assert(!serialized.includes(hidden));
    models.PlatformAuditEvent.addHook('beforeCreate','qa-meta-cancel-failure',row=>{if(JSON.parse(row.body).reason==='authorization_cancelled')throw Error('FICTITIOUS_CANCEL_AUDIT_FAILURE');});
    try{
      const pending=await cancel(flow);assert.equal(pending.status,200);assert.equal(pending.body.status,'cancel_pending');
      const health=await require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent).health(clock);
      assert.equal(health.unresolvedAttempts,discovery?2:1,'A staged credential must not hide an unconfirmed cancellation or a failed inventory audit');
    }finally{models.PlatformAuditEvent.removeHook('beforeCreate','qa-meta-cancel-failure');}
    const cancelled=await cancel(flow);assert.equal(cancelled.status,200,JSON.stringify(cancelled.body));assert.equal(cancelled.body.status,'cancelled');assert.equal((await cancel(flow)).body.status,'cancelled');
    const phases=await models.PlatformAuditEvent.findAll({where:{correlation_id:flow.requestId},attributes:['stage','result_part'],raw:true});
    assert.deepEqual(phases.map(r=>r.stage+':'+r.result_part).sort(),['attempted:0','attempted:1','completed:0','completed:1']);
    report.checks.push('Actual API/TLS/broker/vault candidate and v22 SQL audit; no code/token/state in request table, duplicate callback never exchanges twice and cancellation is idempotent');
    const lost=await begin();f.state.losePut=true;await callback(lost);assert.equal((await latest(lost.requestId)).state,'processing');
    await brokerApp.close();brokerApp=null;await start();clock=new Date(+clock+61000);const result=await service.run();assert.equal(result.failed,0);assert.equal((await latest(lost.requestId)).state,'staged');
    assert.equal(f.state.codes,codes+2);clock=new Date();await cancel(lost);
    report.checks.push('Lost candidate write ACK keeps SQL processing; actual broker restart and gated worker reconcile the original version without code replay');
    const revoked=await begin();await models.AuthSession.update({state:'revoked'},{where:{user_id:91002}});const n=f.state.codes;await callback(revoked);assert.equal(f.state.codes,n);assert.equal((await latest(revoked.requestId)).state,'cancel_pending');
    clock=new Date(+clock+1000);await service.run();assert.equal((await latest(revoked.requestId)).state,'cancelled');clock=new Date();await mfa();
    report.checks.push('Session revoked before callback prevents exchange and worker completes durable cancellation after logout');
    const changed=await begin();afterWire=async command=>{if(command.operation===B.OPERATIONS.finish)await models.UsuarioClinica.update({rol_clinica:'personaldeclinica'},{where:{id_clinica:71}});};
    await callback(changed);afterWire=null;assert.equal((await latest(changed.requestId)).state,'cancelled');assert.equal((await latest(changed.requestId)).candidate_metadata,null);
    clock=new Date(+clock+1000);await service.run();assert.equal((await latest(changed.requestId)).state,'cancelled');
    await models.UsuarioClinica.update({rol_clinica:role},{where:{id_clinica:71}});
    clock=new Date();
    report.checks.push('Permission lost after remote success prevents local candidate readiness and confirms withdrawal through the independent control path');
    const history=await begin(),beforeHistory=f.state.codes;
    await models.MetaMarketingBrokerRevocation.create({tuple_hash:C.hash('FICTITIOUS_EXISTING_REVOCATION'),connection_ref:'meta:previous',asset_ref:'page:123',tenant_clinic_id:59,
      meta_connection_id:2,meta_user_id:'123',app_id:mb.appId,scope_key:'group:5',clinic_ids:'[59,71]',mapping_ids:'[1]',request_id:randomUUID(),actor_user_id:91002,requested_at:clock,next_attempt_at:clock,state:'confirmed'});
    await callback(history);assert.equal(f.state.codes,beforeHistory);assert.equal((await latest(history.requestId)).state,'cancel_pending');
    clock=new Date(+clock+1000);await service.run();assert.equal((await latest(history.requestId)).state,'cancelled');clock=new Date();
    assert.equal(await models.MetaMarketingBrokerRevocation.count(),1);
    report.checks.push('Changed independent withdrawal history invalidates an in-flight authorization before exchange; old history is preserved');
    const events=(await models.PlatformAuditEvent.findAll({attributes:['body'],raw:true})).map(r=>JSON.parse(r.body)).filter(v=>v.version===22);
    assert(events.length>=12);for(const hidden of [TOKEN,APP])assert(!JSON.stringify(events).includes(hidden));await auditView.verify(token);
    report.humanAuditEvents=events.length;
    // Visual extension uses product components and this same API below.
    if(process.env.META_OAUTH_CRM_VISUAL==='1'){
      // Time-controlled recovery tests end here. Browser work must use a moving clock
      // to exercise the actual five-second broker/CRM observation skew contract.
      let visualOffset=0;clock=new Date();const tick=setInterval(()=>{clock=new Date(Date.now()+visualOffset);},20);
      try{await require('./fixtures/meta_oauth_crm_visual.fixture')({models,app,server,base,token:()=>token,service,request,begin,callback,cancel,latest,report,auditView,f,
        advance:ms=>{visualOffset+=ms;clock=new Date(Date.now()+visualOffset);}});}finally{clearInterval(tick);}
    }
    report.commands=commands;report.metaCalls=f.state.httpCalls.length;report.secretCalls=f.state.awsCalls.length;report.queries=queryCount;
    report.pool={inUse:sql.connectionManager.pool.using,waiting:sql.connectionManager.pool.waiting};assert.equal(report.pool.inUse,0);assert.equal(report.pool.waiting,0);
    assert(technical.every(e=>!JSON.stringify(e).includes(TOKEN)&&!JSON.stringify(e).includes(APP)));
  }finally{
    await browser?.close();if(server)await new Promise(r=>server.close(r));await brokerApp?.close();for(const fn of cleanup.reverse())await fn();
  }
}).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
