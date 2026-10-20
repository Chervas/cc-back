#!/usr/bin/env node
'use strict';
// Published CRM smoke. Only existing, explicitly named fictitious patient;
// blocks EVERY mutation, including enrolment/booking. Never clicks Find hours.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer-core');
const {createActions}=require('./program-direct-agenda-ui-actions');
const ORIGIN='https://crm.clinicaclick.com',PATIENT='Paciente Prueba Tablet Medical';
async function main(){
 const out=fs.mkdtempSync('/home/ubuntu/qa-evidence/program-agenda-crm-readonly-');fs.chmodSync(out,0o700);
 const report={success:false,mutations:[],errors:[],checks:[],mode:'Published CRM, read-only, no enrolment or appointment writes'};
 const b=await puppeteer.connect({browserURL:'http://127.0.0.1:9227',defaultViewport:null});let context;
 try{
  const source=await b.targets().find(t=>t._targetId==='1B6C705EAAD0B850ECB5F21F3FE6E26D')?.page();
  assert(source&&new URL(source.url()).origin===ORIGIN,'EXACT_AUTHENTICATED_CRM_SOURCE_REQUIRED');
  const auth=await source.evaluate(()=>Object.fromEntries(['accessToken','currentUser','userInfo','currentRole'].map(k=>[k,localStorage.getItem(k)]).filter(([,v])=>v!==null)));
  assert(auth.accessToken,'CRM_SESSION_REQUIRED');context=await b.createBrowserContext();
  const cookies=(await source.browserContext().cookies()).filter(c=>['crm.clinicaclick.com','.clinicaclick.com'].includes(c.domain));if(cookies.length)await context.setCookie(...cookies);
  const cdp=await b.target().createCDPSession(),{targetId}=await cdp.send('Target.createTarget',{url:'about:blank',browserContextId:context.id,background:true});await cdp.detach();
  const page=await(await b.waitForTarget(t=>t._targetId===targetId)).page();report.target_id=targetId;
  await page.evaluateOnNewDocument(({origin,auth})=>{if(location.origin===origin){for(const[k,v]of Object.entries(auth))localStorage.setItem(k,v);localStorage.setItem('selectedClinicId','72');}},{origin:ORIGIN,auth});
  await page.setViewport({width:1440,height:1000});await page.setRequestInterception(true);
  page.on('request',r=>{const u=new URL(r.url());if(!['http:','https:'].includes(u.protocol))return r.continue();
   if(u.origin!==ORIGIN)return r.abort();if(!['GET','HEAD','OPTIONS'].includes(r.method())){if(!u.pathname.startsWith('/socket.io/'))report.mutations.push({path:u.pathname,method:r.method()});return r.abort();}return r.continue();});
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(ORIGIN+'/agenda-de-citas?clinica_id=72&fecha=2026-11-03&vista=day',{waitUntil:'domcontentloaded'});
  const a=createActions(page);await page.waitForSelector('[data-qa="agenda-create-fab"]',{timeout:60000});
  const read=url=>page.evaluate(async url=>{const r=await fetch(url,{headers:{Authorization:'Bearer '+localStorage.getItem('accessToken')}});return{status:r.status,data:await r.json()};},url);
  assert.equal((await read('/api/auth/me')).status,200);
  for(const clinic of[66,72]){const r=await read('/api/treatment-programs?clinic_id='+clinic+'&kind=program&booking=true&page=1&page_size=20');assert.equal(r.status,200);report.checks.push('Catálogo accesible clínica '+clinic+' ('+r.data.items.length+' en página).');}
  await a.openPatientDrawer(PATIENT);await a.setType('con tratamiento');await a.click('[data-qa="appointment-treatment-tabs"] button','Programas');
  await a.input('input[placeholder="Buscar programa"]','GLP');
  await page.waitForFunction(()=>[...document.querySelectorAll('mat-option')].some(e=>e.getClientRects().length&&e.textContent.includes('GLP')),{timeout:30000});
  await a.click('mat-option','GLP');await a.click('[data-qa="appointment-assign-clinical-program"]');
  await page.waitForSelector('[data-qa="program-agenda-planner"]',{visible:true,timeout:30000});
  const content=await page.$eval('[data-qa="program-agenda-planner"]',e=>e.textContent);
  assert(content.includes(PATIENT)&&content.includes('Prepara la búsqueda')&&content.includes('Encontrar horas disponibles'));
  assert(!await page.$('cc-history-prototype'));
  await page.screenshot({path:path.join(out,'crm-preparar-sin-asignar.png')});
  report.checks.push('CRM abre el widget real con GLP-1 y el paciente ficticio; se cierra antes de asignar/buscar/reservar.');
  await a.click('[data-qa="program-agenda-planner"] button[aria-label="Cerrar planificador del programa"]');
  await page.waitForFunction(()=>!document.querySelector('app-program-agenda-planner'));
  assert.deepEqual(report.mutations,[]);assert.deepEqual(report.errors,[]);report.success=true;
 }catch(e){report.error=e.message;throw e;}finally{if(context)await context.close();b.disconnect();fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({success:report.success,evidence:out,error:report.error||null}));}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
