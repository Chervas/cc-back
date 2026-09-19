'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async({models,app,server,base,token,service,callback,latest,report,auditView,advance,f})=>{
  const output=path.join(report.root,'oauth-visual');fs.mkdirSync(output,{mode:0o700});
  const shots=[],errors=[],blocked=[],writes=[];let browser,tab;
  const section='[data-qa="meta-oauth"]',state='[data-qa="meta-oauth-state"]';
  try{
    await require('./meta_settings_visual_host.fixture')({app,server,token,groupMode:true});
    browser=await require('puppeteer-core').launch({executablePath:'/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    tab=await browser.newPage();await tab.setRequestInterception(true);tab.on('pageerror',e=>errors.push(e.message));
    tab.on('request',r=>{
      if(!r.url().startsWith(base+'/')&&!r.url().startsWith('data:')){blocked.push(r.url().split('?')[0]);return r.abort();}
      if(!['GET','HEAD'].includes(r.method())){
        const url=new URL(r.url());writes.push({method:r.method(),path:url.pathname});
        if(!['POST','DELETE'].includes(r.method())||!url.pathname.startsWith('/oauth/meta/marketing/authorization'))return r.abort();
      }
      r.continue();
    });
    const shot=async name=>{
      await tab.$eval(section,e=>e.scrollIntoView({block:'center'}));
      assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      await tab.screenshot({path:path.join(output,name+'.png')});shots.push(name);
    };
    const waitState=text=>tab.waitForFunction(({state,text})=>document.querySelector(state)?.textContent.includes(text),{}, {state,text});
    const providerBeforeOpen=f.state.httpCalls.length,secretsBeforeOpen=f.state.awsCalls.length;
    for(const size of [{name:'desktop',width:1440,height:1050},{name:'mobile',width:390,height:844}]){
      await tab.setViewport(size);await tab.goto(base,{waitUntil:'networkidle0'});await tab.waitForSelector('[data-qa="meta-oauth-begin"]');await shot(size.name+'-ready');
    }
    assert.equal(f.state.httpCalls.length,providerBeforeOpen);assert.equal(f.state.awsCalls.length,secretsBeforeOpen);
    await tab.click('[data-qa="meta-oauth-begin"]');await tab.waitForSelector('[data-qa="meta-oauth-continue"]');await waitState('Continúa en Meta');
    const authUrl=await tab.$eval('[data-qa="meta-oauth-continue"]',e=>e.href);assert.equal(new URL(authUrl).origin,'https://www.facebook.com');
    assert.equal(await tab.$eval('[data-qa="meta-oauth-continue"]',e=>e.rel),'noopener noreferrer');
    const stored=await models.MetaMarketingOAuthRequest.findOne({where:{state:'awaiting'},raw:true});assert(stored);
    await shot('mobile-awaiting');
    await tab.click('#clinic-b');await tab.waitForFunction(()=>!document.querySelector('[data-qa="meta-oauth-continue"]'));
    await tab.goto(base,{waitUntil:'networkidle0'});await waitState('Continúa en Meta');assert.equal(await tab.$('[data-qa="meta-oauth-continue"]'),null);
    // The provider is the actual broker adapter with a fictitious transport. No Facebook popup is opened.
    await callback({requestId:stored.flow_id,authUrl});assert.equal((await latest(stored.flow_id)).state,'staged');
    await tab.click('[data-qa="meta-oauth-reconcile"]');await waitState('Autorización guardada');await shot('mobile-staged');
    await tab.setViewport({width:1440,height:1050});await shot('desktop-staged');
    const discovery=process.env.META_OAUTH_DISCOVERY_TEST==='1';
    if(discovery){
      const h=f.state.httpCalls.length;await tab.click('[data-qa="meta-oauth-assets"]');await tab.waitForSelector('[data-qa="meta-oauth-inventory"]');
      assert.equal((await tab.$$('[data-qa="meta-oauth-inventory-asset"]')).length,3);assert.equal(f.state.httpCalls.length-h,4);await shot('desktop-inventory');
      await tab.setViewport({width:390,height:844});await shot('mobile-inventory');
      await tab.evaluate(()=>window.QA_TOKEN='FICTITIOUS_CHANGED_SESSION');await tab.waitForFunction(()=>!document.querySelector('[data-qa="meta-oauth-inventory"]'));
      await tab.evaluate(v=>window.QA_TOKEN=v,token());await tab.setViewport({width:1440,height:1050});
    }
    const providerBeforeCancel=f.state.httpCalls.length,secretsBeforeCancel=f.state.awsCalls.length;
    models.PlatformAuditEvent.addHook('beforeCreate','qa-meta-visual-cancel',row=>{if(JSON.parse(row.body).reason==='authorization_cancelled')throw Error('FICTITIOUS_VISUAL_AUDIT_FAILURE');});
    try{
      await tab.click('[data-qa="meta-oauth-cancel"]');await waitState('Cancelación pendiente');await shot('desktop-cancel-pending');
      assert.equal((await latest(stored.flow_id)).state,'cancel_pending');
    }finally{models.PlatformAuditEvent.removeHook('beforeCreate','qa-meta-visual-cancel');}
    advance(1000);const recovered=await service.run();assert.equal(recovered.failed,0);assert.equal((await latest(stored.flow_id)).state,'cancelled');
    await tab.click('[data-qa="meta-oauth-reconcile"]');await waitState('Autorización cancelada');await tab.waitForSelector('[data-qa="meta-oauth-begin"]');await shot('desktop-cancelled');
    assert.equal(f.state.httpCalls.length,providerBeforeCancel);assert.equal(f.state.awsCalls.length,secretsBeforeCancel);
    const role=(await models.UsuarioClinica.findOne({where:{id_clinica:71},raw:true})).rol_clinica;
    await models.UsuarioClinica.update({rol_clinica:'personaldeclinica'},{where:{id_clinica:71}});
    try{await tab.goto(base,{waitUntil:'networkidle0'});assert.equal(await tab.$('[data-qa="meta-oauth-begin"]'),null);}
    finally{await models.UsuarioClinica.update({rol_clinica:role},{where:{id_clinica:71}});}
    await tab.evaluate(value=>window.QA_TOKEN=value,auditView.token);await tab.click('#audit');await tab.waitForSelector('[data-qa="audit-meta-oauth"]');
    await tab.$eval('[data-qa="audit-meta-oauth"]',e=>{e.closest('details').open=true;e.scrollIntoView({block:'center'});});
    assert.match(await tab.$eval('body',e=>e.innerText),/autorización/i);await tab.screenshot({path:path.join(output,'audit.png')});shots.push('audit');
    if(discovery){await tab.waitForSelector('[data-qa="audit-meta-discovery"]');await tab.$eval('[data-qa="audit-meta-discovery"]',e=>{e.closest('details').open=true;e.scrollIntoView({block:'center'});});await tab.screenshot({path:path.join(output,'audit-discovery.png')});shots.push('audit-discovery');}
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.equal(writes.filter(v=>v.method==='DELETE').length,1);assert.equal(writes.length,discovery?5:4);
    report.oauthVisual={shots,errors,blocked,businessWrites:0,authorizationRequests:writes.length,openingProviderCalls:0,cancellationProviderCalls:0,cancellationSecretCalls:0,provider:'fictitious transport; no actual Facebook popup'};
  }catch(error){fs.writeFileSync(path.join(output,'failure.txt'),error.stack);await tab?.screenshot({path:path.join(output,'failure.png'),fullPage:true});throw error;}
  finally{await browser?.close();}
};
