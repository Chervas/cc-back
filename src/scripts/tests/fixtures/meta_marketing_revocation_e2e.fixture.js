'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
module.exports=async({models,report,registerOwnedLoopbackServer,broker,sessions,token,f,control,restart,queries})=>{
  const env=['META_MARKETING_REVOCATION_ENABLED','META_MARKETING_BROKER_ENABLED','META_MARKETING_ACCESS_CHECK_ENABLED'];
  let clock=new Date();
  let activeToken=token();const currentToken=()=>activeToken;
  const previous=env.map(k=>process.env[k]);for(const key of env)process.env[key]='true';let server,browser;
  try{
    const R=require('../../../services/metaMarketingRevocation.service'),C=require('../../../../services/integrations-broker/src/meta-marketing-contract');
    const Rev=models.MetaMarketingBrokerRevocation,Bindings=models.MetaMarketingBrokerBinding,Assets=models.ClinicMetaAsset;
    const migration=require('../../../../migrations/20260919050000-meta-marketing-broker-revocations'),qi=models.sequelize.getQueryInterface();
    await migration.down(qi);await migration.up(qi);
    const bindingIndexes=await qi.showIndex('MetaMarketingBrokerBindings'),assetIndexes=await qi.showIndex('ClinicMetaAssets');
    assert.deepEqual(bindingIndexes.find(i=>i.name==='cc_meta_marketing_scope').fields.map(f=>f.attribute),['scope_key','state']);
    assert.deepEqual(assetIndexes.find(i=>i.name==='cc_meta_asset_identity').fields.map(f=>f.attribute),['assetType','metaAssetId']);
    await Assets.create({id:500,metaConnectionId:2,clinicaId:59,grupoClinicaId:5,assignmentScope:'group',assetType:'whatsapp_phone_number',metaAssetId:'777',waAccessToken:'FICTITIOUS_WA_UNTOUCHED'});
    const app=require('express')();app.use(require('express').json());
    app.use((req,res,next)=>{const start=Date.now(),count=queries();res.on('finish',()=>{if(req.method==='DELETE'&&res.statusCode===202&&!report.revocationFirst)report.revocationFirst={queries:queries()-count,elapsedMs:Date.now()-start};});next();});
    app.use('/oauth/meta/marketing-disconnection',require('../../../routes/metaMarketingRevocation.routes').createRouter({models,sessions}));
    // Product metadata readers used by the same Settings component.
    models.MetaConnectionAssignment.belongsTo(models.MetaConnection,{as:'metaConnection',foreignKey:'metaConnectionId'});
    Assets.belongsTo(models.Clinica,{as:'clinica',foreignKey:'clinicaId'});
    await models.MetaConnection.update({userName:'Responsable ficticio Meta'},{where:{id:2}});
    const SA=require('../../../lib/oauthMarketingScopeAccess'),MA=require('../../../lib/marketingScopeAccess');
    const sessionFor=async req=>{const claims=await sessions.verify(require('../../../services/accessSession.service').bearer(req.headers.authorization));req.userData={userId:claims.userId};return claims;};
    const authorize=req=>SA.authorizeRequestedMarketingConnectionScope({userId:req.userData.userId,...SA.marketingScopeInputFromRequest(req),access:'read',
      findClinicGroupId:async id=>(await models.Clinica.findByPk(id,{attributes:['grupoClinicaId']}))?.grupoClinicaId,
      findGroupClinicIds:async id=>(await models.Clinica.findAll({where:{grupoClinicaId:id},attributes:['id_clinica']})).map(r=>r.id_clinica),authorizeClinicIds:MA.hasMarketingClinicScopeAccess});
    const M=require('../../../services/metaConnectionMetadata.service'),resolver=require('../../../services/scopeConnectionResolver.service');
    const metadata=M.createMetaConnectionMetadata({session:sessionFor,authorize,
      resolve:req=>resolver.resolveMetaConnectionForScope({userId:req.userData.userId,...SA.marketingScopeInputFromRequest(req),allowLegacyUserFallback:false,metadataOnly:true}),
      loadMappings:M.createMetaMetadataRepository(models),scopeResponse:scope=>scope});
    app.get('/oauth/meta/connection-status',metadata.handler());app.get('/oauth/meta/mappings',metadata.handler(true));
    const auditView=await require('./meta_revocation_audit.fixture')({models,sessions,app,now:()=>clock});
    server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));registerOwnedLoopbackServer(server);
    const base='http://127.0.0.1:'+server.address().port,endpoint='/oauth/meta/marketing-disconnection?group_id=5&assignment_scope=group';
    const request=(method='GET',url=endpoint)=>new Promise((resolve,reject)=>{
      const req=http.request(base+url,{method,headers:{authorization:'Bearer '+activeToken}},res=>{let body='';res.on('data',v=>body+=v);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end();
    });
    const unchanged=async()=>{assert.equal(await Rev.count(),0);assert.equal(await Bindings.count({where:{state:'active'}}),4);assert.equal(await Assets.count({where:{isActive:true}}),5);};
    assert.equal((await request()).body.available,true);
    const originalVerifyReference=sessions.verifyReference;
    sessions.verifyReference=async(...args)=>{await models.AuthSession.update({state:'revoked'},{where:{user_id:91002}});return originalVerifyReference(...args);};
    try{assert.equal((await request('DELETE')).status,401);await unchanged();}finally{sessions.verifyReference=originalVerifyReference;}
    activeToken=(await sessions.authenticated(await models.Usuario.findByPk(91002))).body.token;
    const originalRole=(await models.UsuarioClinica.findOne({attributes:['rol_clinica'],raw:true})).rol_clinica;
    await models.UsuarioClinica.update({rol_clinica:'personaldeclinica'},{where:{id_clinica:71}});assert.equal((await request('DELETE')).status,403);await unchanged();
    await models.UsuarioClinica.update({rol_clinica:originalRole},{where:{id_clinica:71}});
    await models.GroupAssetClinicAssignment.create({id:92,assetId:1,assetType:'meta.ad_account',grupoClinicaId:6,clinicaId:88});assert.equal((await request('DELETE')).status,409);await unchanged();await models.GroupAssetClinicAssignment.destroy({where:{id:92}});
    await models.GrupoClinica.update({facebook_primary_asset_id:2},{where:{id_grupo:6}});assert.equal((await request('DELETE')).status,409);await unchanged();await models.GrupoClinica.update({facebook_primary_asset_id:null},{where:{id_grupo:6}});
    const saved=(await Bindings.findByPk(1,{raw:true}));await Bindings.create({...saved,mapping_id:92,scope_key:'clinic:88',tenant_clinic_id:88});assert.equal((await request('DELETE')).status,409);await Bindings.destroy({where:{mapping_id:92}});await unchanged();
    const auditCreate=models.PlatformAuditEvent.create;
    models.PlatformAuditEvent.create=async function(row,opts){if(JSON.parse(row.body).version===21)throw Error('FICTITIOUS_AUDIT_FAILURE');return auditCreate.call(this,row,opts);};
    try{assert.equal((await request('DELETE')).status,503);await unchanged();}finally{models.PlatformAuditEvent.create=auditCreate;}
    await assert.rejects(()=>R.assertLegacyDisconnectAllowed(models,2),{code:'meta_marketing_scoped_revocation_required'});
    report.checks.push('Meta revocation HTTP requires current managed session and whole-group write permission; foreign aliases, sharing and primary groups reject; audit failure rolls back exclusions/intents; universal legacy disconnect cannot remove a vault connection');

    const output=path.join(report.root,'revocation-visual');fs.mkdirSync(output,{mode:0o700});const shots=[],errors=[],writes=[],blocked=[];
    let tab;
    if(process.env.META_REVOCATION_VISUAL==='1'){
      await require('./meta_settings_visual_host.fixture')({app,server,token:currentToken,groupMode:true});
      browser=await require('puppeteer-core').launch({executablePath:'/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']});
      tab=await browser.newPage();await tab.setRequestInterception(true);tab.on('pageerror',e=>errors.push(e.message));tab.on('request',r=>{
        if(!['GET','HEAD'].includes(r.method())){writes.push({method:r.method(),url:r.url()});if(r.method()!=='DELETE'||!r.url().startsWith(base+'/oauth/meta/marketing-disconnection?'))return r.abort();}
        if(r.url().startsWith(base+'/')||r.url().startsWith('data:'))r.continue();else{blocked.push(r.url());r.abort();}
      });
      await models.UsuarioClinica.update({rol_clinica:'personaldeclinica'},{where:{id_clinica:71}});
      await tab.setViewport({width:1440,height:1050});await tab.goto(base,{waitUntil:'networkidle0'});
      await tab.waitForFunction(()=>window.QA_COMPONENT.settings.metaConnectionState==='paused'&&window.QA_COMPONENT.settings.metaMappings.length>0);
      assert.equal(await tab.$('[data-qa="meta-revoke"]'),null);await tab.screenshot({path:path.join(output,'read-only.png')});shots.push('read-only');
      await models.UsuarioClinica.update({rol_clinica:originalRole},{where:{id_clinica:71}});
      for(const size of [{name:'desktop',width:1440,height:1050},{name:'mobile',width:390,height:844}]){
        await tab.setViewport(size);await tab.goto(base,{waitUntil:'networkidle0'});await tab.waitForSelector('[data-qa="meta-revoke"]');await tab.click('[data-qa="meta-revoke"]');
        await tab.waitForSelector('[data-qa="meta-revoke-confirm"]');await tab.$eval('[data-qa="meta-revocation"]',e=>e.scrollIntoView({block:'center'}));
        assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await tab.screenshot({path:path.join(output,size.name+'-confirm.png')});shots.push(size.name+'-confirm');
      }
    }
    // An authorized read is already at the provider when the local withdrawal commits.
    let release,entered;const held=new Promise(r=>entered=r);f.state.httpHook=async req=>{if(req.action==='inspect'){entered();await new Promise(r=>release=r);}};
    const context=await broker.prepare(1),inflight=broker.read(context,C.ASSET,{authorize:async()=>{}}).then(()=>({unexpected:true}),error=>({code:error.code}));await held;
    const beforeAws=f.state.aws.length,beforeProvider=f.state.http.length;
    if(tab){await tab.click('[data-qa="meta-revoke-confirm"]');await tab.waitForFunction(()=>document.querySelector('[data-qa="meta-revocation-state"]')?.textContent.includes('en curso'));}
    else assert.equal((await request('DELETE')).status,202);
    assert.equal(await Rev.count({where:{state:'pending'}}),3);assert.equal(await Bindings.count({where:{state:'blocked'}}),4);
    assert.equal(await Assets.count({where:{isActive:true}}),1);assert.equal(await Assets.count({where:{id:500,isActive:true}}),1);
    assert.equal(await models.MetaConnectionAssignment.count({where:{status:'active'}}),1);assert.equal(f.state.aws.length,beforeAws);assert.equal(f.state.http.length,beforeProvider);
    release();f.state.httpHook=null;assert.equal((await inflight).code,'asset_revoked');
    assert.equal((await request('DELETE')).body.pending_assets,3);assert.equal(await Rev.count(),3);
    await assert.rejects(()=>migration.down(qi),/Preserve durable Meta/);
    if(tab){await tab.$eval('[data-qa="meta-revocation"]',e=>e.scrollIntoView({block:'center'}));await tab.screenshot({path:path.join(output,'mobile-pending.png')});shots.push('mobile-pending');}
    report.checks.push('Atomic local withdrawal blocks an in-flight read, preserves WhatsApp mapping/shared connection assignment, creates one durable intent per asset and remains idempotent; populated migration rollback rejected');

    clock=new Date();let drop=true;const ids=[];const aws=f.state.aws.length,provider=f.state.http.length;
    const client={execute:async(command,budget)=>{ids.push(command.requestId);const result=await control.execute(command,budget);if(drop){drop=false;throw Object.assign(Error('broker_timeout'),{code:'broker_timeout'});}return result;}};
    const repo=R.createRevocationRepository(models);
    const lease1=await repo.claim(clock),lease2=await repo.claim(clock);assert.notEqual(lease1.tuple_hash,lease2.tuple_hash);
    await repo.retry(lease1,'broker_timeout',clock);await repo.retry(lease2,'broker_timeout',clock);assert.equal(await repo.confirm(lease1,clock),false);
    clock=new Date(clock.getTime()+10000);
    const worker=R.createRevocationWorker({repository:repo,client,enabled:()=>true,now:()=>clock});
    models.PlatformAuditEvent.create=async function(row,opts){if(JSON.parse(row.body).version===21&&row.stage==='completed')throw Error('FICTITIOUS_CONFIRM_FAILURE');return auditCreate.call(this,row,opts);};
    let first;try{first=await worker.run();}finally{models.PlatformAuditEvent.create=auditCreate;}
    assert.equal(first.failed,3);assert.equal(first.confirmed,0);assert.equal(await Rev.count({where:{state:'pending'}}),3);
    await models.AuthSession.update({state:'revoked'},{where:{user_id:91002}});assert.equal((await request()).status,401);
    await restart();clock=new Date(clock.getTime()+61000);const recovered=await worker.run();assert.equal(recovered.confirmed,3);assert.equal(recovered.pending,0);
    assert.deepEqual(ids.slice(0,3).sort(),ids.slice(3,6).sort());assert.equal(f.state.aws.length,aws);assert.equal(f.state.http.length,provider);
    assert.equal((await worker.run()).confirmed,0);assert.equal(ids.length,6);
    activeToken=(await sessions.authenticated(await models.Usuario.findByPk(91002))).body.token;
    assert.equal((await request()).body.status,'confirmed');
    const auditRows=await models.PlatformAuditEvent.findAll({attributes:['body'],raw:true});const events=auditRows.map(r=>JSON.parse(r.body)).filter(e=>e.version===21);
    assert.equal(events.length,6);for(const id of new Set(ids))assert.equal(events.filter(e=>e.correlationId===id).length,2);
    await Bindings.update({state:'active'},{where:{}});await Assets.update({isActive:true},{where:{id:[1,2,3,11]}});
    await assert.rejects(()=>broker.prepare(1),{code:'asset_revoked'});
    await Bindings.update({state:'blocked'},{where:{}});await Assets.update({isActive:false},{where:{id:[1,2,3,11]}});
    report.checks.push('Lost broker acknowledgement and local confirmation audit failure retain the same pending UUID; restart/retry confirms without another provider or Secrets call; independent revocation history rejects reactivated bindings and mappings');
    await auditView.verify(activeToken);
    if(tab){
      await tab.goto(base,{waitUntil:'networkidle0'});
      for(const size of [{name:'mobile',width:390,height:844},{name:'desktop',width:1440,height:1050}]){
        await tab.setViewport(size);await tab.click('[data-qa="meta-revoke-refresh"]');await tab.waitForFunction(()=>document.querySelector('[data-qa="meta-revocation-state"]')?.textContent.includes('confirmada'));
        await tab.$eval('[data-qa="meta-revocation"]',e=>e.scrollIntoView({block:'center'}));assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
        await tab.screenshot({path:path.join(output,size.name+'-confirmed.png')});shots.push(size.name+'-confirmed');
      }
      await tab.evaluate(value=>window.QA_TOKEN=value,auditView.token);await tab.click('#audit');await tab.waitForSelector('[data-qa="audit-meta-revocation"]');
      await tab.$eval('[data-qa="audit-meta-revocation"]',e=>{e.closest('details').open=true;e.scrollIntoView({block:'center'});});
      assert.match(await tab.$eval('body',e=>e.innerText),/retirada del acceso a los activos Meta está confirmada/);
      await tab.screenshot({path:path.join(output,'audit-confirmed.png')});shots.push('audit-confirmed');
      assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.equal(writes.length,1);assert.equal(writes[0].method,'DELETE');
      report.revocationVisual={shots,errors,blocked,businessWrites:0,withdrawalRequests:writes.length};
    }
    report.revocation={pendingAfterLostReply:first.pending,confirmedAfterRestart:recovered.confirmed,controlRequests:ids.length,distinctIds:new Set(ids).size,auditEvents:events.length,providerCallsDuringControl:f.state.http.length-provider,secretCallsDuringControl:f.state.aws.length-aws,whatsappMappingsPreserved:1};
  }catch(error){fs.writeFileSync(path.join(report.root,'revocation-failure.txt'),error.stack);if(browser){const tabs=await browser.pages();await tabs.at(-1).screenshot({path:path.join(report.root,'revocation-failure.png'),fullPage:true});}throw error;}
  finally{f.state.httpHook=null;if(browser)await browser.close();if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});for(const [i,key]of env.entries()){if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];}}
};
