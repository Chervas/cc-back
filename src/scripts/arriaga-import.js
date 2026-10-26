#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const store=require('../lib/arriaga-import/store'),{connectOperatorDatabase}=require('../lib/cliniccloud-import/operator-database');
process.umask(0o077);
const args=process.argv.slice(2),option=k=>{const n=args.indexOf('--'+k);return n<0?null:args[n+1];};
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
(async()=>{
 const target=option('target'),mode=option('mode'),bundleFile=option('bundle'),dir=option('out');
 if(!['crm','dev'].includes(target)||!['plan','apply','verify'].includes(mode)||!bundleFile||!dir)throw Object.assign(Error(),{safeCode:'ARRIAGA_ARGUMENTS_REQUIRED'});
 fs.mkdirSync(dir,{recursive:true,mode:0o700});const bundle=JSON.parse(fs.readFileSync(bundleFile));store.validateBundle(bundle);
 const c=await connectOperatorDatabase(target);
 try{
  if(mode==='plan'){
   await c.query('START TRANSACTION READ ONLY');const snapshot=await store.capture(c);await c.query('ROLLBACK');
   const plan=store.planImport(bundle,snapshot);
   write(path.join(dir,'target-before.json'),snapshot);write(path.join(dir,'plan.json'),plan);
   const summary={target,bundleSha256:bundle.sha256,planSha256:plan.sha256,snapshotSha256:plan.snapshotSha256,patientsCreate:plan.operations.filter(p=>p.action==='create').length,patientsPreserve:plan.operations.filter(p=>p.action==='preserve').length,historyRenumbered:plan.operations.filter(p=>p.historyRenumbered).length,historicalActivities:bundle.activity.length,catalogCreate:plan.catalogOps.filter(p=>p.action==='create').length,scope:store.SCOPE,sourceCodeSha256:crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../lib/arriaga-import/store'))).digest('hex')};
   write(path.join(dir,'plan-summary.json'),summary);console.log(JSON.stringify(summary));return;
  }
  if(mode==='verify'){
   await c.query('START TRANSACTION READ ONLY');const snap=await store.capture(c);await c.query('ROLLBACK');const plan=store.planImport(bundle,snap);
   const report={target,bundleSha256:bundle.sha256,allPatientsPreserved:plan.operations.every(p=>p.action==='preserve'),allCatalogPreserved:plan.catalogOps.every(t=>t.action==='preserve'),patients:plan.operations.length,identities:snap.identities.length,records:snap.sourceRecords.length,expectedRecords:bundle.activity.length,allHolds:snap.identities.every(i=>Number(i.messages_hold)===1)};
   if(!report.allPatientsPreserved||!report.allCatalogPreserved||report.records!==report.expectedRecords||!report.allHolds)throw Object.assign(Error(),{safeCode:'ARRIAGA_VERIFY_FAILED'});
   write(path.join(dir,'verification.json'),report);console.log(JSON.stringify(report));return;
  }
  const plan=JSON.parse(fs.readFileSync(path.join(dir,'plan.json'))),summary=JSON.parse(fs.readFileSync(path.join(dir,'plan-summary.json')));
  const actualCode=crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../lib/arriaga-import/store'))).digest('hex');
  if(summary.sourceCodeSha256!==actualCode)throw Object.assign(Error(),{safeCode:'ARRIAGA_CODE_CHANGED_REPLAN'});
  write(path.join(dir,'apply-attempt.json'),{target,started_at:new Date().toISOString(),planSha256:plan.sha256});
  const result=await store.applyImport(c,{bundle,plan,actorId:1,
   writeJournal:async journal=>write(path.join(dir,'transaction-patient-journal.json'),journal),
   beforeCommit:async({result,patientIds})=>{write(path.join(dir,'before-commit-result.json'),result);write(path.join(dir,'imported-patient-ids.json'),patientIds);}});
  write(path.join(dir,'committed-result.json'),{...result,committed_at:new Date().toISOString()});console.log(JSON.stringify(result));
 }finally{await c.end();}
})().catch(error=>{console.error(JSON.stringify({failed:true,code:error.safeCode||error.code||'ARRIAGA_IMPORT_FAILED'}));process.exitCode=1;});
