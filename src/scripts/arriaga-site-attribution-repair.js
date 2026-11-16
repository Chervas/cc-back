#!/usr/bin/env node
'use strict';
// Explicit private operator. plan/verify are read-only; ROOT reviews and applies.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const repair=require('../lib/arriaga-import/site-attribution-repair');
const connector=require('../lib/cliniccloud-import/operator-database');
process.umask(0o077);
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{safeCode:c});};
const bytesHash=b=>crypto.createHash('sha256').update(b).digest('hex');
function argumentsOf(argv){const args={};for(let i=0;i<argv.length;i+=2){need(['--mode','--target','--bundle','--out','--plan','--approve-plan','--actor-id'].includes(argv[i])&&argv[i+1]&&!Object.hasOwn(args,argv[i].slice(2)),'ARRIAGA_REPAIR_ARGUMENTS');args[argv[i].slice(2)]=argv[i+1];}need(['plan','apply','verify'].includes(args.mode)&&['dev','crm'].includes(args.target)&&path.isAbsolute(args.bundle||'')&&path.isAbsolute(args.out||''),'ARRIAGA_REPAIR_ARGUMENTS');return args;}
function privateDirectory(dir){need(/^\/home\/ubuntu\/(?:artifacts|secure-imports)\//.test(dir)&&path.resolve(dir)===dir,'ARRIAGA_REPAIR_PRIVATE_OUTPUT');fs.mkdirSync(dir,{mode:0o700,recursive:true});const s=fs.lstatSync(dir);need(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o077)===0&&s.uid===process.getuid(),'ARRIAGA_REPAIR_PRIVATE_OUTPUT');}
function write(file,value){fs.writeFileSync(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function pins(){return Object.fromEntries([__filename,require.resolve('../lib/arriaga-import/site-attribution-repair'),require.resolve('../lib/arriaga-import/store'),require.resolve('../lib/cliniccloud-import/operator-database')].map(f=>[path.relative(path.resolve(__dirname,'../..'),f),repair.hash(fs.readFileSync(f).toString())]));}
function journal(dir,event){const fd=fs.openSync(path.join(dir,'journal.private.jsonl'),'a',0o600);try{fs.writeSync(fd,JSON.stringify({at:new Date().toISOString(),...event})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
async function main(argv=process.argv.slice(2)){
 const a=argumentsOf(argv);privateDirectory(a.out);const bundle=JSON.parse(fs.readFileSync(a.bundle));repair.cohort(bundle);
 const db=connector.databaseOptions(a.target);const targetProof=repair.hash({target:a.target,host:db.host,port:db.port,database:db.database,user:db.user});
 const c=await connector.connectOperatorDatabase(a.target);
 try{
  if(a.mode==='plan'){
   need(/^\d+$/.test(a['actor-id']||''),'ARRIAGA_REPAIR_ACTOR_REQUIRED');
   await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const before=await repair.capture(c,bundle);await c.rollback();
   const core=repair.planRepair(bundle,before,{actorId:Number(a['actor-id'])});
   const backupFile=path.join(a.out,'target-before.private.json.gz'),backup=zlib.gzipSync(Buffer.from(JSON.stringify(before)),{level:9});
   write(backupFile,backup);
   const proof={version:repair.VERSION,target:a.target,targetProof,codePins:pins(),bundleFileSha256:repair.hash(fs.readFileSync(a.bundle).toString()),
    backup:{path:backupFile,sha256:bytesHash(backup),uncompressedSha256:repair.hash(before)},planSha256:core.planSha256,patientCorrections:core.patientCorrections,core};
   const plan={...proof,operatorPlanSha256:repair.hash(proof)};const file=path.join(a.out,'plan.json');
   write(file,plan);
   journal(a.out,{event:'plan_readonly',operatorPlanSha256:plan.operatorPlanSha256,planSha256:core.planSha256,summary:core.summary});
   console.log(JSON.stringify({status:'plan_ready_readonly',target:a.target,plan:file,operatorPlanSha256:plan.operatorPlanSha256,planSha256:core.planSha256,summary:core.summary,codePins:proof.codePins}));return;
  }
  need(path.isAbsolute(a.plan||''),'ARRIAGA_REPAIR_PLAN_REQUIRED');const plan=JSON.parse(fs.readFileSync(a.plan)),{operatorPlanSha256,...body}=plan;
  need(repair.hash(body)===operatorPlanSha256&&plan.target===a.target&&plan.targetProof===targetProof&&repair.hash(plan.codePins)===repair.hash(pins())&&plan.bundleFileSha256===repair.hash(fs.readFileSync(a.bundle).toString()),'ARRIAGA_REPAIR_OPERATOR_PLAN_CHANGED');
  need(plan.planSha256===plan.core.planSha256&&repair.hash(plan.patientCorrections)===repair.hash(plan.core.patientCorrections),'ARRIAGA_REPAIR_PUBLIC_PLAN_CONTRACT');
  const backup=fs.readFileSync(plan.backup.path);need(bytesHash(backup)===plan.backup.sha256&&repair.hash(JSON.parse(zlib.gunzipSync(backup)))===plan.core.beforeSha256,'ARRIAGA_REPAIR_BACKUP_CHANGED');
  if(a.mode==='verify'){
   await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const after=await repair.capture(c,bundle);const report=repair.verifyState(plan.core,after);await c.rollback();
   const output={...report,target:a.target,operatorPlanSha256,planSha256:plan.core.planSha256,afterSha256:repair.hash(after),writes:0};write(path.join(a.out,'verify-'+Date.now()+'.json'),output);console.log(JSON.stringify(output));return;
  }
  need(a['approve-plan']===operatorPlanSha256,'ARRIAGA_REPAIR_EXACT_APPROVAL_REQUIRED');
  journal(a.out,{event:'apply_started',operatorPlanSha256,planSha256:plan.core.planSha256});let observedAfterSha256;
  const result=await repair.applyRepair(c,{bundle,plan:plan.core,beforeCommit:async({after,verified})=>{observedAfterSha256=repair.hash(after);const name='before-commit-'+Date.now()+'.private.json.gz';write(path.join(a.out,name),zlib.gzipSync(Buffer.from(JSON.stringify(after)),{level:9}));journal(a.out,{event:'before_commit',afterFile:name,afterSha256:observedAfterSha256,verified});}});
  const receipt={...result,target:a.target,operatorPlanSha256,afterSha256:observedAfterSha256||null,committed_at:new Date().toISOString(),messagesSent:0,appointmentsChanged:0,sentSnapshotsChanged:0};write(path.join(a.out,'receipt-'+Date.now()+'.json'),receipt);journal(a.out,{event:'apply_complete',...receipt});console.log(JSON.stringify(receipt));
 }catch(e){journal(a.out,{event:'failed',code:e.safeCode||e.code||e.name,automatic_post_commit_rollback:false});throw e;}finally{await c.end();}
}
module.exports={argumentsOf,main};
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({status:'failed',code:e.safeCode||e.code||e.name,source_payload_not_printed:true}));process.exitCode=1;});
