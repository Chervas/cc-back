'use strict';
// Product Angular components, HTTP controllers and workers with owned MySQL/TLS
// broker. Provider, MFA delivery and surrounding Settings services are fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async({models,sql,sessions,service,enrollment,flow,api,token,report,app,server,base,advance,restart,mfa,loseActivationReply,closeEnrollment,commands})=>{
  models.MetaConnectionAssignment.belongsTo(models.MetaConnection,{as:'metaConnection',foreignKey:'metaConnectionId'});
  models.ClinicMetaAsset.belongsTo(models.Clinica,{as:'clinica',foreignKey:'clinicaId'});
  const auth=require('../../../lib/oauthMarketingScopeAccess'),scopeAccess=require('../../../lib/marketingScopeAccess');
  const resolver=require('../../../services/scopeConnectionResolver.service'),contract=require('../../../services/metaConnectionMetadata.service');
  const reader=contract.createMetaConnectionMetadata({
    session:req=>sessions.verify(require('../../../services/accessSession.service').bearer(req.headers.authorization)),
    authorize:req=>auth.authorizeRequestedMarketingConnectionScope({userId:req.userData.userId,...auth.marketingScopeInputFromRequest(req),access:'read',
      findClinicGroupId:async id=>(await models.Clinica.findByPk(id,{attributes:['grupoClinicaId']}))?.grupoClinicaId,
      findGroupClinicIds:async id=>(await models.Clinica.findAll({where:{grupoClinicaId:id},attributes:['id_clinica']})).map(r=>r.id_clinica),authorizeClinicIds:scopeAccess.hasMarketingClinicScopeAccess}),
    resolve:req=>resolver.resolveMetaConnectionForScope({userId:req.userData.userId,...auth.marketingScopeInputFromRequest(req),allowLegacyUserFallback:false,metadataOnly:true}),
    loadMappings:contract.createMetaMetadataRepository(models),scopeResponse:(scope,assignment)=>({...scope,authorizedByUserId:assignment?.authorizedByUserId||null})
  });
  const actor=(req,_res,next)=>{req.userData={userId:91002};next();};
  app.get(['/oauth/meta/connection-status','/api/oauth/meta/connection-status'],actor,reader.handler());
  app.get(['/oauth/meta/mappings','/api/oauth/meta/mappings'],actor,reader.handler(true));
  await require('./meta_settings_visual_host.fixture')({app,server,token,groupMode:true});
  const output=path.join(report.root,'selection-visual');fs.mkdirSync(output,{mode:0o700});
  const browser=await require('puppeteer-core').launch({executablePath:'/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const errors=[],blocked=[],writes=[],shots=[];let page;
  try{
    page=await browser.newPage();await page.setViewport({width:1440,height:1050});await page.setRequestInterception(true);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',r=>{
      const local=r.url().startsWith(base+'/'),p=local?new URL(r.url()).pathname:'';
      const mutation=r.method()==='POST'&&(/^\/oauth\/meta\/marketing\/authorization\/[a-f0-9-]{36}\/assets$/.test(p)||/^\/oauth\/meta\/marketing\/enrollment(?:\/[a-f0-9-]{36}\/confirmation)?$/.test(p))
        ||r.method()==='DELETE'&&/^\/oauth\/meta\/marketing\/enrollment\/[a-f0-9-]{36}$/.test(p);
      if(!local&&!r.url().startsWith('data:')||!['GET','HEAD'].includes(r.method())&&!mutation){blocked.push(r.method()+' '+p);return r.abort();}
      if(mutation)writes.push(r.method()+' '+p);r.continue();
    });
    const click=async selector=>{await page.waitForFunction(s=>{const el=document.querySelector(s);return el&&!el.disabled;},{},selector);await page.click(selector);};
    const state=expected=>page.waitForFunction(s=>document.querySelector('[data-qa="meta-enrollment-state"]')?.textContent?.includes(s),{},expected);
    const refresh=async expected=>{const response=page.waitForResponse(r=>r.request().method()==='GET'&&r.url().includes('/marketing/enrollment?'));await click('[data-qa="meta-enrollment-refresh"]');assert.equal((await response).status(),200);await state(expected);};
    const shot=async name=>{const el=await page.$('[data-qa="meta-enrollment"]');await el.evaluate(e=>e.scrollIntoView({block:'center'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:path.join(output,name+'.png')});shots.push(name);};
    await page.goto(base,{waitUntil:'networkidle0'});
    await click('[data-qa="meta-oauth-assets"]');await page.waitForSelector('[data-meta-select="meta-ad_account:301"]');
    await page.click('[data-meta-select="meta-ad_account:301"]');await page.click('[data-meta-select="meta-instagram_business:501"]');
    await click('[data-qa="meta-enrollment-reserve"]');await state('Preparación pendiente');
    let overview=await api();const id=overview.selection.requestId,latest=()=>models.MetaMarketingEnrollmentRequest.findByPk(id);
    assert.equal(overview.selection.state,'prepare_pending');assert.equal(await models.ClinicMetaAsset.count(),0);
    assert.equal((await enrollment.run({enrollmentId:id})).failed,0);await refresh('Selección preparada');
    assert(await page.$('[data-qa="meta-enrollment-confirm"]'));await shot('desktop-prepared');
    await page.setViewport({width:390,height:844});await shot('mobile-prepared');
    loseActivationReply();await click('[data-qa="meta-enrollment-confirm"]');await state('Conexión pendiente');
    assert.equal((await enrollment.run({enrollmentId:id})).failed,1);assert.equal(await models.ClinicMetaAsset.count(),0);
    await refresh('Conexión pendiente');await shot('mobile-response-lost');
    await restart();advance(130000);assert.equal((await enrollment.run({enrollmentId:id})).failed,0);
    await refresh('conectada en el CRM');assert.equal(commands.filter(v=>v.operation.endsWith('.activate.v1')).length,1);
    const mappings=await models.ClinicMetaAsset.findAll({raw:true});assert.equal(mappings.length,2);assert(mappings.every(v=>v.assignmentScope==='group'&&v.grupoClinicaId===5&&v.clinicaId===null));
    const snapshot=await page.evaluate(async()=>({settings:{state:window.QA_COMPONENT.settings.metaConnectionState,mappings:window.QA_COMPONENT.settings.metaMappings,account:window.QA_COMPONENT.settings.accounts.find(v=>v.id==='meta')},
      status:await fetch('/oauth/meta/connection-status?assignment_scope=group&group_id=5',{headers:{authorization:'Bearer '+window.QA_TOKEN}}).then(r=>r.json()),
      mappings:await fetch('/oauth/meta/mappings?assignment_scope=group&group_id=5',{headers:{authorization:'Bearer '+window.QA_TOKEN}}).then(r=>r.json())}));
    fs.writeFileSync(path.join(output,'active-metadata.json'),JSON.stringify(snapshot,null,2));
    await page.waitForSelector('[data-meta-scope="group:5"]');
    assert.equal(await page.$$eval('[data-meta-scope="group:5"]',els=>els.length),1);
    assert.match(await page.$eval('[data-meta-scope="group:5"]',el=>el.innerText),/Grupo completo · 2 clínicas/);
    await shot('mobile-active');await page.setViewport({width:1440,height:1050});await shot('desktop-active');
    const reads=commands.length;
    await models.MetaMarketingBrokerBinding.update({state:'blocked'},{where:{mapping_id:mappings[0].id}});
    await refresh('requiere revisión');overview=await api();assert.equal(overview.selection.connected,false);assert.equal(overview.selection.canCancel,true);assert.equal(commands.length,reads);
    await shot('desktop-attention');await models.MetaMarketingBrokerBinding.update({state:'active'},{where:{mapping_id:mappings[0].id}});
    closeEnrollment();await refresh('conectada en el CRM');overview=await api();assert.equal(overview.enabled,false);assert.equal(overview.selection.canCancel,true);
    await models.AuthSession.update({state:'revoked'},{where:{user_id:91002}});await mfa();await page.goto(base,{waitUntil:'networkidle0'});await state('conectada en el CRM');
    await click('[data-qa="meta-enrollment-cancel"]');await page.waitForSelector('[data-qa="meta-enrollment-withdrawal"]');await shot('desktop-withdrawal-review');
    await click('[data-qa="meta-enrollment-withdraw-confirm"]');await state('Retirada solicitada');assert.equal((await latest()).state,'revoke_pending');assert.equal(await models.ClinicMetaAsset.count({where:{isActive:true}}),0);
    await models.AuthSession.update({state:'revoked'},{where:{user_id:91002}});advance(1);assert.equal((await enrollment.run({enrollmentId:id})).failed,0);
    assert.equal((await service.run()).failed,0);assert.equal((await latest()).state,'revoked');
    assert.equal((await models.MetaMarketingOAuthRequest.findByPk(flow.requestId)).state,'cancelled');
    await mfa();await page.goto(base,{waitUntil:'networkidle0'});await state('Retirada');await shot('desktop-revoked');await page.setViewport({width:390,height:844});await shot('mobile-revoked');
    assert.equal(await models.MetaMarketingEnrollmentClaim.count(),3);assert.equal(await models.MetaConnectionAssignment.count(),1);
    const events=(await models.PlatformAuditEvent.findAll({attributes:['body','result_part'],raw:true})).filter(v=>JSON.parse(v.body).version===24);assert.deepEqual(events.map(v=>v.result_part).sort(),[1,2,3,4,5,6]);
    assert.equal(writes.filter(v=>v.startsWith('POST')&&v.includes('/enrollment')).length,2);assert.equal(writes.filter(v=>v.startsWith('DELETE')).length,1);
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
    report.checks.push('Actual Angular selection, preparation, human confirmation, lost activation response and status recovery; one complete group card, no early mappings or activation replay');
    report.checks.push('Withdrawal UI survives gate closure and new MFA session; local access blocks immediately and independent worker retires candidate after logout, with all six durable audit phases');
    report.selectionVisual={shots,errors,blocked,writes,activationCalls:1,canonicalMappings:2,limits:'Owned MySQL and broker HTTPS, fictitious provider/MFA delivery. Worker invoked directly; no deployed cron, public session or live Meta acceptance.'};
  }catch(error){fs.writeFileSync(path.join(output,'failure.txt'),error.stack);if(page){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});fs.writeFileSync(path.join(output,'page.txt'),await page.$eval('body',el=>el.innerText));}throw error;}
  finally{await browser.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({shots,errors,blocked,writes},null,2));}
};
