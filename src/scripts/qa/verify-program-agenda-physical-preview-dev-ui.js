#!/usr/bin/env node
'use strict';

// Retained synthetic DEV target only. Preview requests are the ONLY allowed mutations.
// The decisive grid gesture is a physical CDP mouse click, never DOM event dispatch.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),{spawn}=require('node:child_process');
const puppeteer=require('puppeteer-core');
const {connectOperatorDatabase}=require('../../lib/cliniccloud-import/operator-database');
const {readSqlState}=require('./verify-program-direct-agenda-dev-ui');
const {createActions}=require('./program-direct-agenda-ui-actions');
const ORIGIN='http://localhost:4203',TARGET='572FA4171880221E3065D3AEAF421A7B',PROGRAM='7ee16f23-a40e-4fe4-90d0-d02aac81dd69';
const VOUCHER='b061339e-99e5-4679-9ecb-7e32e3b2349b',NAME='QA · Programa en agenda · Continuación 20/10';
const BASE='/api/economics/vouchers/'+VOUCHER,OUT=fs.mkdtempSync('/home/ubuntu/qa-evidence/program-physical-preview-dev-20261020-');fs.chmodSync(OUT,0o700);
const copy=v=>JSON.parse(JSON.stringify(v)),wait=ms=>new Promise(r=>setTimeout(r,ms));
function allowed(request){let url;try{url=new URL(request.url());}catch{return false;}if(url.origin!==ORIGIN)return false;
 if(['GET','HEAD','OPTIONS'].includes(request.method()))return true;
 if(request.method()!=='POST'||url.pathname!==BASE+'/program-proposals')return false;
 let body;try{body=JSON.parse(request.postData()||'{}');}catch{return false;}
 return !body.force&&!body.force_schedule&&body.draft_strategy&&['initial','reset','cascade','previous_day','next_day','previous_time','next_time'].includes(body.draft_strategy.action)
  && !['manual_sessions','fixed_sessions','session_keys','mode'].some(key=>body[key]!=null)
  && (!body.draft_strategy.sessions||body.draft_strategy.sessions.every(row=>['qa_4','qa_5'].includes(row.key)));
}
async function main(){
 const report={success:false,synthetic_only:true,mode:'Physical native grid click; preview-only request allowlist; no booking/enrollment/payment/outbound',target:TARGET,program_id:PROGRAM,voucher_id:VOUCHER,evidence:OUT,checks:[],blocked:[],posts:[],responses:[],errors:[]};
 const save=()=>fs.writeFileSync(path.join(OUT,'summary.json'),JSON.stringify(report,null,2),{mode:0o600});
 const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9227',defaultViewport:null,protocolTimeout:30000});
 const target=browser.targets().find(t=>t._targetId===TARGET);assert(target,'EXACT_PRIVATE_QA_TARGET_REQUIRED');const page=await target.page();assert.equal(new URL(page.url()).origin,ORIGIN);
 const connection=await connectOperatorDatabase('dev');await connection.query('SET SESSION TRANSACTION READ ONLY');
 const a=createActions(page),check=(name,value)=>{report.checks.push({name,passed:!!value});save();assert(value,name);};
 let recorder=null,recorderReady=null,recording=false,intercepting=false;
 const requestHandler=request=>{if(!/^(?:http:|https:)/.test(request.url()))return request.continue();
  if(!allowed(request)){report.blocked.push({path:new URL(request.url()).pathname,method:request.method()});save();return request.abort();}
  if(request.method()==='POST'){report.posts.push({path:new URL(request.url()).pathname,body:JSON.parse(request.postData())});save();}return request.continue();};
 const responseHandler=async response=>{const url=new URL(response.url());if(url.origin===ORIGIN&&url.pathname===BASE+'/program-proposals'){
  report.responses.push({path:url.pathname,status:response.status(),data:await response.json().catch(()=>null)});save();}};
 const pageErrorHandler=error=>{report.errors.push(error.message);save();};
 async function safeScreen(){const ids=await page.$$eval('app-tarjeta-citas[data-appointment-id],app-tarjeta-citas[data-day-appointment-id]',rows=>rows.filter(r=>r.getClientRects().length).map(r=>r.getAttribute('data-appointment-id')||r.getAttribute('data-day-appointment-id')));
  assert(ids.every(id=>/^(?:cita-)?(75659|75660)$/.test(id)),'RECORDING_MUST_NOT_SHOW_OTHER_APPOINTMENTS');return ids;}
 async function shot(name){await safeScreen();await page.screenshot({path:path.join(OUT,name+'.png')});}
 async function recordStart(){
  const ffmpeg='/home/ubuntu/qa-evidence/program-video-tools-20261020-D2Qzt4/node_modules/ffmpeg-static/ffmpeg';
  const script='/home/ubuntu/wt/front-dev/scripts/tests/program_walkthrough_recorder.cjs';
  if(!fs.existsSync(ffmpeg))return;
  recorder=spawn(process.execPath,[script,'--target-id',TARGET,'--ffmpeg',ffmpeg,'--reviewed-fictitious-ui','--seconds','35'],{stdio:['pipe','pipe','pipe']});
  recorder.stderr.on('data',data=>fs.appendFileSync(path.join(OUT,'recorder.stderr'),data,{mode:0o600}));
  const lines=readline.createInterface({input:recorder.stdout});const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('RECORDER_READY_TIMEOUT')),20000);
   lines.on('line',line=>{fs.appendFileSync(path.join(OUT,'recorder.jsonl'),line+'\n',{mode:0o600});let result;try{result=JSON.parse(line);}catch{return;}if(result.ready){clearTimeout(timer);recorderReady=result;resolve(result);}if(result.video)report.video=result.video;save();});recorder.once('error',reject);});
  await ready;recorder.stdin.write(JSON.stringify({action:'caption',text:'Acepta una propuesta y coloca la siguiente directamente en la agenda. Aún no se reserva nada.',step:'1/3'})+'\n');
  recorder.stdin.write(JSON.stringify({action:'resume',reviewed:true})+'\n');recording=true;await wait(1800);
 }
 function caption(text,step){if(recording)recorder.stdin.write(JSON.stringify({action:'caption',text,step})+'\n');}
 async function recordStop(){if(!recorder)return;if(recorder.exitCode!==null)return;recorder.stdin.write('{"action":"stop"}\n');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('RECORDER_STOP_TIMEOUT')),20000);recorder.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('RECORDER_FAILED'));});});recording=false;}
 try{
  report.before=await readSqlState(connection,PROGRAM,VOUCHER);check('exact existing synthetic voucher and two booked appointments are retained',report.before.voucher?.public_id===VOUCHER&&report.before.voucher.patient_id===33021&&report.before.voucher.clinic_id===1
   &&report.before.appointments.map(r=>r.id_cita).join(',')==='75659,75660'&&report.before.unit_movements===0&&report.before.voucher.budget_id===null);
  await page.setRequestInterception(true);intercepting=true;page.on('request',requestHandler);page.on('response',responseHandler);page.on('pageerror',pageErrorHandler);
  await page.goto(ORIGIN+'/agenda-de-citas?clinica_id=1&fecha=2026-12-03&vista=day',{waitUntil:'domcontentloaded'});await page.waitForSelector('[data-qa="agenda-create-fab"]',{timeout:60000});
  await a.openPatientDrawer('Paciente ficticio Prueba BS Medical');await a.setType('Continuación');await a.click('[data-qa="appointment-treatment-tabs"] button','Programas');
  await page.waitForFunction(name=>[...document.querySelectorAll('[data-qa="appointment-pending-clinical-programs"] button')].some(b=>b.textContent.includes(name)),{timeout:30000},NAME);
  await a.click('[data-qa="appointment-pending-clinical-programs"] button',NAME);await page.waitForSelector('app-program-agenda-planner h2',{timeout:30000});
  await page.waitForFunction(()=>!document.querySelector('app-program-agenda-planner mat-progress-bar'));
  await a.input('input[aria-label="Día inicial del programa"]','03/12/2026');await a.input('input[aria-label="Hora preferida del programa"]','16:00');
  for(const selector of ['program-preference-friday','program-preference-afternoon'])if(!await page.$eval('[data-qa="'+selector+'"] input',i=>i.checked))await a.click('[data-qa="'+selector+'"]');
  const initialResponse=page.waitForResponse(r=>new URL(r.url()).pathname===BASE+'/program-proposals',{timeout:60000});await a.click('[data-qa="program-agenda-continue"]');check('initial canonical preview returns200', (await initialResponse).status()===200);
  await page.waitForFunction(()=>!document.querySelector('app-program-agenda-planner mat-progress-bar'));
  check('only two remaining original sessions are shown, not the unrecorded prefix or booked sessions',await page.$$eval('[data-program-session-key]',rows=>rows.map(r=>r.getAttribute('data-program-session-key')).join(',')==='qa_4,qa_5'));
  await page.waitForFunction(()=>!document.querySelector('[data-qa="agenda-day-navigation-loading"]'),{timeout:45000});
  await shot('01-proposals-before-physical-gesture');report.ready=true;save();console.log(JSON.stringify({ready:true,evidence:OUT,target:TARGET,controls:'stdin {"action":"run","reviewed":true} or {"action":"stop"}'}));
  let command;if(process.argv.includes('--reviewed-physical-preview'))command={action:'run',reviewed:true};else{
   const input=readline.createInterface({input:process.stdin,terminal:false});command=await new Promise((resolve,reject)=>{input.once('close',()=>resolve({action:'stop'}));input.once('line',line=>{try{resolve(JSON.parse(line));}catch(error){reject(error);}});});input.close();}
  if(command.action!=='run'||command.reviewed!==true){report.stopped_before_gesture=true;return;}
  await recordStart();await a.click('[data-qa-accept="qa_4"]');check('accepting session4 is provisional and leaves exactly one remaining',await page.$eval('[data-program-session-key="qa_4"]',el=>el.getAttribute('data-accepted')==='true')&&await page.$eval('[data-qa="program-agenda-place-remaining"]',el=>el.textContent.includes('(1)')));
  await a.click('[data-qa="program-agenda-manual"]');await page.waitForSelector('[data-qa="program-agenda-provisional"][data-program-session="qa_5"][data-program-active="true"]',{timeout:30000});
  await page.waitForFunction(()=>!document.querySelector('[data-qa="agenda-day-navigation-loading"]'),{timeout:45000});
  caption('En «Colocar en agenda», pulsa un hueco vacío de la misma columna. La propuesta se comprueba antes de aceptarla.','2/3');await wait(1800);
  let point;
  for(let attempt=0;attempt<4;attempt++){
   point=await page.evaluate(()=>{const ghosts=[...document.querySelectorAll('[data-qa="program-agenda-provisional"][data-program-session="qa_5"][data-program-active="true"]')].sort((a,b)=>Number.parseFloat(a.style.top)-Number.parseFloat(b.style.top));
    const ghost=ghosts[0];if(!ghost)return null;const surface=ghost.closest('.agenda-resource-grid')?.querySelector('[data-qa="agenda-slot-surface"]'),scroll=ghost.closest('[data-slot-minutes]');if(!surface||!scroll)return null;
    const gr=ghost.getBoundingClientRect(),sr=surface.getBoundingClientRect(),rows=Number(surface.getAttribute('data-slot-count')),minutes=Number(scroll.getAttribute('data-slot-minutes'));
    const x=gr.left+gr.width/2,y=gr.top+60/minutes*(sr.height/rows)+2,hit=document.elementFromPoint(x,y);
    return{x,y,ghost:{top:gr.top,bottom:gr.bottom,left:gr.left,right:gr.right,label:ghost.getAttribute('aria-label')},rowMinutes:minutes,rowHeight:sr.height/rows,
     viewport:{width:innerWidth,height:innerHeight},hit:{tag:hit?.tagName,qa:hit?.getAttribute('data-qa'),classes:hit?.className,surface:!!hit?.closest('[data-qa="agenda-slot-surface"]'),ghost:!!hit?.closest('[data-qa="program-agenda-provisional"]')}};});
   if(point&&point.y>200&&point.y<point.viewport.height-100)break;
   const ghost=await page.$('[data-qa="program-agenda-provisional"][data-program-session="qa_5"][data-program-active="true"]');await ghost.evaluate(el=>el.scrollIntoView({block:'center',inline:'center'}));await wait(300);
  }
  report.physical_point=point;save();check('physical target is the empty grid surface,60minutes after the earliest phase in the same subcolumn, outside all ghosts',point&&point.hit.surface&&!point.hit.ghost&&point.y>point.ghost.bottom&&point.x>=point.ghost.left&&point.x<=point.ghost.right);
  await shot('02-physical-grid-target-before-click');await page.mouse.move(point.x,point.y,{steps:16});await wait(600);
  const clickedResponse=page.waitForResponse(r=>new URL(r.url()).pathname===BASE+'/program-proposals',{timeout:20000});await page.mouse.click(point.x,point.y,{button:'left',clickCount:1,delay:80});
  check('physical mouse gesture triggers exactly the canonical proposal endpoint with200', (await clickedResponse).status()===200);
  await page.waitForFunction(()=>!document.querySelector('app-program-agenda-planner mat-progress-bar'));
  check('validated session5 is automatically accepted and opens final review without saving',await page.$eval('[data-qa="program-agenda-confirm"]',button=>!button.disabled&&button.textContent.includes('(2)')));
  check('no enrollment,booking,ordinary appointment mutation or other outbound API request was attempted',!report.blocked.some(row=>row.path.startsWith('/api/'))&&report.posts.length===2&&report.posts.every(r=>r.path===BASE+'/program-proposals'));
  caption('Esta demo no guarda nuevas citas; «Confirmar» es el último paso. Las dos propuestas quedan listas para revisar.','3/3');await shot('03-final-review-not-saved');await wait(4500);await recordStop();
  report.success=true;report.left_open=page.url();report.left_open_stage='Final review, two provisional sessions; not saved';
 }catch(error){report.error=error.message;await recordStop().catch(e=>report.recorder_error=e.message);await page.screenshot({path:path.join(OUT,'failure.png')}).catch(()=>{});throw error;
 }finally{
  report.after=await readSqlState(connection,PROGRAM,VOUCHER);report.sql_unchanged=JSON.stringify(report.before)===JSON.stringify(report.after);
  if(!report.sql_unchanged)report.success=false;save();await connection.end();
  page.off('request',requestHandler);page.off('response',responseHandler);page.off('pageerror',pageErrorHandler);if(intercepting)await page.setRequestInterception(false).catch(()=>{});browser.disconnect();console.log(JSON.stringify({success:report.success,evidence:OUT,sql_unchanged:report.sql_unchanged,video:report.video,error:report.error}));
 }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={allowed};
