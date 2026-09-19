'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async({app,server,token,auditView,base,report})=>{
  await require('./meta_settings_visual_host.fixture')({app,server,token,groupMode:true});
  const output=path.join(report.root,'enrollment-runtime-visual');fs.mkdirSync(output,{mode:0o700});
  const browser=await require('puppeteer-core').launch({executablePath:'/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell',headless:true,pipe:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const errors=[],blocked=[],shots=[];
  try{
    const tab=await browser.newPage();await tab.setRequestInterception(true);tab.on('pageerror',e=>errors.push(e.message));
    tab.on('request',r=>{if((!r.url().startsWith(base+'/')&&!r.url().startsWith('data:'))||!['GET','HEAD'].includes(r.method())){blocked.push(r.url().split('?')[0]);return r.abort();}r.continue();});
    for(const size of [{name:'desktop',width:1440,height:1050},{name:'mobile',width:390,height:844}]){
      await tab.setViewport(size);await tab.goto(base,{waitUntil:'networkidle0'});await tab.evaluate(value=>window.QA_TOKEN=value,auditView.token);
      const response=tab.waitForResponse(r=>r.url().includes('/api/system-monitoring/audit/events'));await tab.click('#audit');const auditPage=await(await response).json();
      await tab.waitForSelector('[data-qa="audit-meta-enrollment"]');
      const cancellation=await tab.$$eval('article',elements=>{
        const el=elements.find(e=>e.textContent.includes('authorization_cancelled'));return el?.innerText;
      });
      assert(cancellation?.includes('Cancelada'));assert(!cancellation.includes('Denegado'));
      const expectedDenied=auditPage.events.filter(v=>v.outcome==='denied'&&!(v.metaOAuth&&v.stage==='completed'&&v.reason==='authorization_cancelled')).length;
      const summary=await tab.$eval('[data-qa="audit-summary"]',el=>Number(el.children[1].querySelectorAll('p')[1].textContent));
      assert.equal(summary,expectedDenied);
      for(const [reason,label,description] of [['meta_enrollment_activation_requested','Conexión pendiente','La conexión aún está pendiente'],
        ['meta_enrollment_activated','Conectada','se guardó la asignación en el CRM'],['meta_enrollment_cancelled','Retirada','el bloqueo del acceso']]){
        const text=await tab.$$eval('[data-qa="audit-meta-enrollment"]',(elements,reason)=>{
          const el=elements.find(e=>e.closest('article').textContent.includes(reason));if(!el)return null;
          el.closest('details').open=true;el.closest('article').scrollIntoView({block:'center'});return el.closest('article').innerText;
        },reason);
        assert(text?.includes(label));assert(text.includes(description));assert(text.includes('Clínicas: 2 · Activos: 2'));
        assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
        const name=size.name+'-'+reason;await tab.screenshot({path:path.join(output,name+'.png')});shots.push(name);
      }
    }
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);report.enrollmentRuntimeVisual={shots,errors,blocked,
      source:'Actual service transitions in isolated MySQL, signed broker HTTPS and final writer; actual audit API/Angular with fictitious S3. No selection UI/public MFA or real Meta acceptance.'};
  }finally{await browser.close();}
};
