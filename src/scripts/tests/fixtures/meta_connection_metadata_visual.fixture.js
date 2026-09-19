'use strict';
// Actual Settings and shared selector classes/templates. Their metadata HTTP
// reads use the owned SQL API; unrelated services use explicit fixture data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
module.exports=async({app,server,report,token,reads,models,gates})=>{
  const puppeteer=require('puppeteer-core');
  await require('./meta_settings_visual_host.fixture')({app,server,token});
  const output=path.join(report.root,'visual');fs.mkdirSync(output,{mode:0o700});let browser;const errors=[],blocked=[],shots=[],writes=[],metaCalls=[];
  try {
    browser=await puppeteer.launch({executablePath:'/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage(),base='http://127.0.0.1:'+server.address().port;
    await page.setRequestInterception(true);page.on('request',r=>{if(r.url().includes('/oauth/meta/'))metaCalls.push(new URL(r.url()).pathname);
      if(!['GET','HEAD'].includes(r.method())){writes.push(r.url());r.abort();}else if(r.url().startsWith(base+'/')||r.url().startsWith('data:'))r.continue();else{blocked.push(r.url().split('?')[0]);r.abort();}});
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',msg=>{if(msg.type()==='error')fs.appendFileSync(path.join(output,'browser-errors.log'),msg.text()+'\n');});
    const ready=()=>page.waitForFunction(()=>window.QA_COMPONENT?.settings?.metaConnectionState==='paused'&&!window.QA_COMPONENT.settings.isLoadingMappings);
    for(const view of [{name:'desktop',width:1440,height:1100},{name:'mobile',width:390,height:844}]){
      await page.setViewport(view);const prior=reads();await page.goto(base,{waitUntil:'networkidle0'});await ready();assert(reads()>prior);
      assert.equal(await page.evaluate(()=>window.QA_COMPONENT.settings.accounts.find(a=>a.id==='meta').connected),false);
      assert.equal(await page.evaluate(()=>window.QA_COMPONENT.settings.accounts.find(a=>a.id==='meta').connectionStored),true);
      const banner=await page.$('[data-qa="meta-paused-notice"]');assert(banner);await banner.evaluate(e=>e.scrollIntoView({block:'center'}));
      assert.match(await banner.evaluate(e=>e.innerText),/No necesitas volver a conectar/);assert.match(await page.$eval('body',e=>e.innerText),/Responsable ficticio A/);
      assert.match(await page.$eval('body',e=>e.innerText),/Cuenta ficticia A/);
      const priorCalls=metaCalls.length;await page.evaluate(()=>{const c=window.QA_COMPONENT.settings;c.connectAccount('meta');c.openAssetMapping();});
      assert.equal(metaCalls.length,priorCalls);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      await page.screenshot({path:path.join(output,view.name+'-settings.png')});shots.push(view.name+'-settings');
      await page.click('#group');await ready();await page.waitForSelector('[data-meta-scope="group:5"]');
      assert.equal(await page.$$eval('[data-meta-scope="group:5"]',els=>els.length),1);
      const group=await page.$('[data-meta-scope="group:5"]');await group.evaluate(e=>e.scrollIntoView({block:'center'}));
      const groupText=await group.evaluate(e=>e.innerText);assert.match(groupText,/Grupo ficticio/);assert.match(groupText,/Grupo completo · 2 clínicas/);
      assert.match(groupText,/Cuenta de grupo ficticia/);assert.equal(await group.$$eval('[mat-icon-button]',els=>els.length),0);
      const dto=await page.evaluate(()=>window.QA_COMPONENT.settings.scopedMetaMappings.find(v=>v.scope.type==='group'));
      assert.equal(dto.clinica,null);assert.equal(dto.totalAssets,1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      await page.screenshot({path:path.join(output,view.name+'-group.png')});shots.push(view.name+'-group');
      await page.click('#clinic-a');await ready();assert.equal(await page.$('[data-meta-scope="group:5"]'),null);
    }
    await page.setViewport({width:1440,height:1000});await page.goto(base,{waitUntil:'networkidle0'});await ready();
    const gate={path:'/oauth/meta/connection-status',clinic:'59'};gates.push(gate);
    await page.click('[data-qa="meta-refresh"]');
    for(let i=0;!gate.captured&&i<100;i++)await new Promise(r=>setTimeout(r,20));assert(gate.captured);
    await page.click('#clinic-b');await ready();assert.match(await page.$eval('body',e=>e.innerText),/Responsable ficticio B/);gate.deliver();
    await new Promise(r=>setTimeout(r,100));assert.doesNotMatch(await page.$eval('body',e=>e.innerText),/Responsable ficticio A|Cuenta ficticia A/);
    await page.screenshot({path:path.join(output,'changed-clinic.png')});shots.push('changed-clinic');
    await page.click('#clinic-a');await ready();
    const mappingGate={path:'/oauth/meta/mappings',clinic:'59'};gates.push(mappingGate);
    await page.click('[data-qa="meta-refresh"]');
    for(let i=0;!mappingGate.captured&&i<100;i++)await new Promise(r=>setTimeout(r,20));assert(mappingGate.captured);
    await models.ClinicMetaAsset.update({metaAssetName:'Cuenta ficticia A revisada'},{where:{id:1}});
    await page.click('#clinic-b');await ready();await page.click('#clinic-a');await ready();mappingGate.deliver();
    await new Promise(r=>setTimeout(r,100));assert.doesNotMatch(await page.$eval('body',e=>e.innerText),/Responsable ficticio B|Cuenta ficticia B/);
    assert.match(await page.$eval('body',e=>e.innerText),/Cuenta ficticia A revisada/);
    await models.UsuarioClinica.update({estado_invitacion:'pendiente'},{where:{id_clinica:59}});
    await page.click('[data-qa="meta-refresh"]');await page.waitForFunction(()=>window.QA_COMPONENT.settings.metaConnectionState==='unavailable');
    assert.doesNotMatch(await page.$eval('body',e=>e.innerText),/Responsable ficticio A|Cuenta ficticia A/);
    await page.screenshot({path:path.join(output,'permission-revoked.png')});shots.push('permission-revoked');
    await models.UsuarioClinica.update({estado_invitacion:'aceptada'},{where:{id_clinica:59}});
    await page.click('#mapping');await page.waitForFunction(()=>window.QA_COMPONENT.mapping?.metaConnectionState==='paused');
    assert(await page.$('[data-qa="meta-mapping-unavailable"]'));assert.equal(await page.$('mat-stepper'),null);
    await page.evaluate(()=>window.QA_COMPONENT.mapping.connectMeta());await page.screenshot({path:path.join(output,'selector-paused.png')});shots.push('selector-paused');
    const paused=await page.evaluate(()=>{try{window.QA_ACCOUNT_STEP({connected:true,reason:'meta_security_quarantine'});return null;}catch(e){return window.QA_WORKSPACE_MESSAGE(e);}});assert.match(paused,/Meta Ads está en pausa/);
    assert(metaCalls.every(p=>/^\/(api\/)?oauth\/meta\/(connection-status|mappings|marketing-disconnection|marketing\/(authorization|enrollment))$/.test(p)),JSON.stringify([...new Set(metaCalls)]));
    assert.deepEqual(writes,[]);assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
    report.visual={shots,metaRequests:metaCalls.length,errors,writes,blocked,actualComponents:['SettingsConnectedAccountsComponent','AssetMappingComponent'],workspace:'actual decision model; no full workspace rendering'};
  } catch(error) {fs.writeFileSync(path.join(output,'failure.txt'),error.stack);if(browser){const pages=await browser.pages();await pages.at(-1)?.screenshot({path:path.join(output,'failure.png'),fullPage:true});}throw error;
  } finally {if(browser)await browser.close();fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({shots,errors,writes,blocked,metaCalls},null,2));}
};
