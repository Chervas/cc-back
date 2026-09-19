'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{randomUUID,randomBytes}=require('node:crypto'),{Readable}=require('node:stream');
module.exports=async({models,report,registerOwnedLoopbackServer,broker,sessions,token,f,queries,technicalEvents})=>{
  const oldFlags=[process.env.META_MARKETING_BROKER_ENABLED,process.env.META_MARKETING_ACCESS_CHECK_ENABLED];
  process.env.META_MARKETING_BROKER_ENABLED='true';process.env.META_MARKETING_ACCESS_CHECK_ENABLED='true';
  let server,browser;const cleanup=[];
  try {
    models.MetaConnectionAssignment.belongsTo(models.MetaConnection,{as:'metaConnection',foreignKey:'metaConnectionId'});
    models.ClinicMetaAsset.belongsTo(models.Clinica,{as:'clinica',foreignKey:'clinicaId'});
    await models.MetaConnection.update({userName:'Responsable ficticio Meta'},{where:{id:2}});
    await models.ClinicMetaAsset.update({metaAssetName:'Cuenta ficticia Meta'},{where:{id:1}});
    const admin=await models.Usuario.create({id_usuario:1,nombre:'Administrador ficticio',email_usuario:'admin-meta@example.invalid',password_usuario:'FICTITIOUS_ADMIN_HASH'});
    const adminToken=(await sessions.authenticated(admin)).body.token;
    const scope=require('../../../lib/oauthMarketingScopeAccess'),scopeAccess=require('../../../lib/marketingScopeAccess');
    const sessionForReq=async req=>{try{return await sessions.verify(require('../../../services/accessSession.service').bearer(req.headers.authorization));}catch{throw Object.assign(Error('meta_broker_session_required'),{code:'meta_broker_session_required'});}};
    const authorizeScope=req=>scope.authorizeRequestedMarketingConnectionScope({userId:req.userData.userId,...scope.marketingScopeInputFromRequest(req),access:'read',
      findClinicGroupId:async id=>(await models.Clinica.findByPk(id,{attributes:['grupoClinicaId']}))?.grupoClinicaId,
      findGroupClinicIds:async id=>(await models.Clinica.findAll({where:{grupoClinicaId:id},attributes:['id_clinica']})).map(r=>r.id_clinica),authorizeClinicIds:scopeAccess.hasMarketingClinicScopeAccess});
    const service=require('../../../services/metaMarketingAccessCheck.service').createMetaMarketingAccessCheck({models,broker,sessions:sessionForReq,authorizeScope,
      scopeInput:(_req,authorized)=>`${authorized.assignmentScope}:${authorized.assignmentScope==='group'?authorized.groupId:authorized.clinicId}`});
    const metadata=require('../../../services/metaConnectionMetadata.service'),resolver=require('../../../services/scopeConnectionResolver.service');
    const meta=metadata.createMetaConnectionMetadata({authorize:authorizeScope,session:sessionForReq,
      resolve:req=>resolver.resolveMetaConnectionForScope({userId:req.userData.userId,...scope.marketingScopeInputFromRequest(req),allowLegacyUserFallback:false,metadataOnly:true}),
      loadMappings:metadata.createMetaMetadataRepository(models),scopeResponse:scope=>scope});
    const app=require('express')();
    app.use('/oauth',async(req,res,next)=>{try{req.userData=await sessionForReq(req);next();}catch{res.status(401).json({error:'unauthenticated'});}});
    app.get('/oauth/meta/mappings/:mappingId/verification',service.handler());app.get('/oauth/meta/connection-status',meta.handler());app.get('/oauth/meta/mappings',meta.handler(true));
    const {createRepository,drain}=require('../../../services/platformAudit.repository'),audit=createRepository(models.PlatformAuditEvent);
    const versions=new Map(),{createWriter,KEY_ARN}=require('../../../../services/platform-audit/src/s3');
    const s3={send:async command=>{const input=command.input;
      if(command.constructor.name==='PutObjectCommand'){
        assert(!versions.has(input.Key));const row={body:input.Body,VersionId:randomUUID(),ChecksumSHA256:input.ChecksumSHA256};versions.set(input.Key,row);return {...row,ServerSideEncryption:'aws:kms',SSEKMSKeyId:KEY_ARN};
      }
      assert.equal(command.constructor.name,'GetObjectCommand');const row=versions.get(input.Key);assert(row);assert.equal(input.VersionId,row.VersionId);
      return {ContentLength:Buffer.byteLength(row.body),ContentType:'application/json',VersionId:row.VersionId,ChecksumSHA256:row.ChecksumSHA256,ServerSideEncryption:'aws:kms',SSEKMSKeyId:KEY_ARN,Body:Readable.from([row.body])};
    }};
    const flush=()=>drain(audit,createWriter(s3),{limit:100});
    const reader={read:input=>require('../../../../services/platform-audit/src/reader').readBatch({version:1,audience:'clinicaclick-audit-reader-v1',issuedAt:Date.now(),nonce:randomUUID(),...input},s3)};
    const view=require('../../../services/platformAudit.view').createView({model:models.PlatformAuditEvent,audit,reader,codec:require('../../../../services/platform-audit/src/view-contract').cursorCodec(randomBytes(32))});
    app.get('/api/system-monitoring/audit/events',async(req,res)=>{try{const claims=await sessionForReq(req);await flush();res.json(await view.read({actorId:claims.userId,sessionRef:claims.jti,query:req.query}));}catch(error){res.status(error.status||503).json({error:error.code||'audit_unavailable'});}});
    server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));registerOwnedLoopbackServer(server);
    const agent=new http.Agent();cleanup.push(()=>agent.destroy());
    const get=(url,bearer=token())=>new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:server.address().port,path:url,agent,headers:{authorization:'Bearer '+bearer}},res=>{let body='';res.on('data',v=>body+=v);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);});
    const endpoint='/oauth/meta/mappings/1/verification?group_id=5&assignment_scope=group';
    const before=f.state.http.length,beginQueries=queries(),beginTime=Date.now();const checked=await get(endpoint);report.accessCheckFirst={queries:queries()-beginQueries,elapsedMs:Date.now()-beginTime};assert.equal(checked.status,200);assert.equal(checked.body.verification.asset.id,'act_301');assert.equal(checked.body.availability.available,false);
    const events=await models.PlatformAuditEvent.findAll({where:{correlation_id:checked.body.requestId},raw:true});assert.equal(events.length,2);assert(events.every(e=>JSON.parse(e.body).version===20));assert(events.some(e=>JSON.parse(e.body).reason==='asset_verified'));assert(f.state.http.length>before);
    assert.equal(technicalEvents().filter(event=>event.correlationId===checked.body.requestId).length,2);
    const auditCreate=models.PlatformAuditEvent.create;
    const noExternal=async fn=>{const n=f.state.http.length;await fn();assert.equal(f.state.http.length,n);};
    await noExternal(async()=>assert.equal((await get('/oauth/meta/mappings/1/verification?clinic_id=59')).status,403));
    await noExternal(async()=>assert.equal((await get('/oauth/meta/mappings/1/verification')).status,403));
    models.PlatformAuditEvent.create=async()=>{throw Error('FICTITIOUS_AUDIT_PASSWORD');};
    try{await noExternal(async()=>{const r=await get(endpoint);assert.equal(r.status,503);assert.equal(r.body.error,'audit_unavailable');});}finally{models.PlatformAuditEvent.create=auditCreate;}
    models.PlatformAuditEvent.create=async function(row,options){if(JSON.parse(row.body).version===20&&row.stage==='completed')throw Error('FICTITIOUS_AUDIT_PASSWORD');return auditCreate.call(this,row,options);};
    try{const r=await get(endpoint);assert.equal(r.status,503);assert.equal(r.body.error,'audit_unavailable');assert.equal(r.body.verification,undefined);}finally{models.PlatformAuditEvent.create=auditCreate;}
    let once=true;f.state.httpHook=async req=>{if(once&&req.action==='inspect'){once=false;await models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_clinica:71}});}};
    try{const r=await get(endpoint);assert.equal(r.status,403);assert.equal(r.body.verification,undefined);}finally{f.state.httpHook=null;await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_clinica:71}});}
    const now=new Date().toISOString().slice(0,10),auditUrl='/api/system-monitoring/audit/events?from='+now+'&to='+now+'&action=integration.meta.access_check';
    assert.equal((await get(auditUrl)).status,403);const page=await get(auditUrl,adminToken);assert.equal(page.status,200);assert(page.body.events.some(row=>row.metaAccessCheck&&row.reason==='asset_verified'));assert(page.body.events.every(row=>row.verification==='s3_version_verified'));
    report.checks.push('Actual access-check HTTP uses current SQL session/full group scope, durable v20 intent/result and sanitized audit failure; S3-writer/reader contracts and technical-admin view verify fixture object versions');
    if(process.env.META_ACCESS_E2E_VISUAL==='1'){
      await require('./meta_settings_visual_host.fixture')({app,server,token,groupMode:true});
      const output=path.join(report.root,'access-visual');fs.mkdirSync(output,{mode:0o700});const errors=[],requests=[],writes=[],blocked=[],shots=[];
      const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:'/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']});
      const tab=await browser.newPage(),base='http://127.0.0.1:'+server.address().port;await tab.setRequestInterception(true);
      tab.on('request',r=>{if(r.url().includes('/verification'))requests.push(r.url());if(!['GET','HEAD'].includes(r.method())){writes.push(r.url());r.abort();}else if(r.url().startsWith(base+'/')||r.url().startsWith('data:'))r.continue();else{blocked.push(r.url());r.abort();}});tab.on('pageerror',e=>errors.push(e.message));
      try{
        for(const v of [{name:'desktop',width:1440,height:1100},{name:'mobile',width:390,height:844}]){
          await tab.setViewport(v);const n=requests.length;await tab.goto(base,{waitUntil:'networkidle0'});await tab.waitForSelector('[data-meta-check="1"]');assert.equal(requests.length,n);
          await tab.click('[data-meta-check="1"]');await tab.waitForFunction(()=>document.querySelector('[data-meta-check-result="1"]')?.textContent.includes('Acceso comprobado'));
          assert.equal(requests.length,n+1);assert.equal(await tab.evaluate(()=>window.QA_COMPONENT.settings.accounts.find(a=>a.id==='meta').connected),false);
          await tab.$eval('[data-meta-check="1"]',e=>e.scrollIntoView({block:'center'}));assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
          await tab.screenshot({path:path.join(output,v.name+'-verified.png')});shots.push(v.name+'-verified');
        }
        await tab.setViewport({width:1440,height:1050});let release,entered;const held=new Promise(r=>entered=r);f.state.httpHook=async req=>{if(req.action==='inspect'){entered();await new Promise(r=>release=r);}};
        await tab.click('[data-meta-check="1"]');await held;await models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_clinica:71}});release();f.state.httpHook=null;
        await tab.waitForFunction(()=>window.QA_COMPONENT.settings.metaConnectionState==='unavailable');await tab.waitForFunction(()=>!document.body.innerText.includes('Responsable ficticio Meta'));
        assert.equal(await tab.$('[data-meta-check-result="1"]'),null);await tab.evaluate(()=>window.scrollTo(0,0));await tab.screenshot({path:path.join(output,'permission-revoked.png')});shots.push('permission-revoked');
        await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_clinica:71}});
        await tab.evaluate(value=>window.QA_TOKEN=value,adminToken);await tab.click('#audit');await tab.waitForSelector('[data-qa="audit-meta-access-check"]');
        assert.match(await tab.$eval('body',e=>e.innerText),/Comprobación de acceso a Meta/);assert.match(await tab.$eval('body',e=>e.innerText),/Meta Ads continúa en pausa/);
        await tab.$eval('[data-qa="audit-meta-access-check"]',e=>{e.closest('details').open=true;e.scrollIntoView({block:'center'});});await tab.screenshot({path:path.join(output,'audit-v20.png')});shots.push('audit-v20');
        assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assert.deepEqual(blocked,[]);report.accessVisual={shots,errors,writes,blocked,verificationRequests:requests.length};
      }catch(error){fs.writeFileSync(path.join(output,'failure.txt'),error.stack);await tab.screenshot({path:path.join(output,'failure.png'),fullPage:true});throw error;}
      finally{f.state.httpHook=null;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({shots,errors,writes,blocked},null,2));await browser.close();browser=null;}
    }
  }catch(error){fs.writeFileSync(path.join(report.root,'access-e2e-failure.txt'),error.stack);throw error;}finally{if(browser)await browser.close();if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});for(const fn of cleanup)await fn();for(const [i,key] of ['META_MARKETING_BROKER_ENABLED','META_MARKETING_ACCESS_CHECK_ENABLED'].entries()){if(oldFlags[i]===undefined)delete process.env[key];else process.env[key]=oldFlags[i];}}
};
