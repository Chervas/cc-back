#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {hash}=require('../lib/cliniccloud-import/adapter');
const {parseArgs,writePrivateJson,readBytes}=require('../lib/cliniccloud-import/io');
const {verifyPlan:verifyCatalog}=require('../lib/cliniccloud-import/catalog-drafts');
const {operationFor,preparePackage,verifyPackage,executeAssignments}=require('../lib/cliniccloud-import/cabin-assignments');
const {createCabinStore}=require('../lib/cliniccloud-import/cabin-assignments-store');
const {connectOperatorDatabase}=require('../lib/cliniccloud-import/operator-database');
const {privateJson,openJournal,acquireExecutorLocks}=require('./cliniccloud-import-appointments-apply');
const {validateBackup}=require('./cliniccloud-import-contacts-apply');
async function run(args){
 const o=parseArgs(args,['--target','--mode','--plan','--catalog-plan','--review','--private-output','--package','--approved-sha256','--backup-manifest','--private-journal']);
 if(process.cwd()!=='/home/ubuntu/wt/back-dev'||execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='dev')throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
 if(o['--target']!=='crm'||!['prepare','apply'].includes(o['--mode']))throw Error('EXPLICIT_CRM_MODE_REQUIRED');
 const plan=privateJson(o['--plan']),catalog=privateJson(o['--catalog-plan']),review=privateJson(o['--review']);
 verifyCatalog(catalog);
 if(hash({manifest:plan.manifest,actions:plan.actions})!==plan.plan_sha256||review.plan_sha256!==plan.plan_sha256||review.catalog_plan_sha256!==catalog.plan_sha256
   ||!review.reviewed_by||!review.targets?.length||review.targets.length>100)throw Error('CABIN_REVIEW_INPUTS_CHANGED');
 const c=await connectOperatorDatabase('crm');let journal;
 const inputs=()=>review.targets.map(t=>{
  const action=plan.actions.find(a=>a.action_key===t.action_key&&a.entity==='appointment');
  const catalogRow=catalog.rows.find(r=>r.source_catalog_key===t.catalog_source_key);
  if(!action||!catalogRow||!t.reason||!Number.isSafeInteger(t.appointment_id)||t.appointment_id<=0)throw Error('CABIN_REVIEW_TARGET_INVALID');
  return {target:t,source:action.source,catalogRow};
 });
 try{
  if(o['--mode']==='prepare'){
   await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
   const store=await createCabinStore(c),operations=[],preflight=[];
   for(const {target,source,catalogRow} of inputs()){
    const before=await store.read(target.appointment_id);
    const [[cabin]]=await c.query('SELECT * FROM Instalaciones WHERE id=?',[target.installation_id]);
    const op=operationFor({before,source,cabin,catalogRow,reason:target.reason,projectedConflicts:target.projected_conflicts});
    operations.push(op);preflight.push({id:op.appointment_id,reasons:await store.validate(op)});
   }
   await c.rollback();
   const pkg=preparePackage({operations,catalogPlanHash:catalog.plan_sha256,sourcePlanHash:plan.plan_sha256,reviewedBy:review.reviewed_by});
   writePrivateJson(o['--private-output'],pkg);
   return {package_sha256:pkg.package_sha256,prepared:operations.length,preflight,appointments_changed:0};
  }
  const pkg=privateJson(o['--package']);verifyPackage(pkg);
  if(o['--approved-sha256']!==pkg.package_sha256||pkg.catalog_plan_sha256!==catalog.plan_sha256||pkg.source_plan_sha256!==plan.plan_sha256||pkg.reviewed_by!==review.reviewed_by)throw Error('CABIN_CURRENT_PACKAGE_APPROVAL_REQUIRED');
  const proposed=inputs();
  if(proposed.length!==pkg.operations.length)throw Error('CABIN_REVIEW_TARGETS_CHANGED');
  for(const op of pkg.operations){
   const item=proposed.find(i=>i.target.appointment_id===op.appointment_id);
   if(!item||item.target.installation_id!==op.cabin.id||hash(operationFor({before:op.before,source:item.source,cabin:op.cabin,catalogRow:item.catalogRow,reason:item.target.reason,projectedConflicts:item.target.projected_conflicts}))!==hash(op))throw Error('CABIN_REVIEW_TARGETS_CHANGED');
  }
  const manifest=privateJson(o['--backup-manifest']);
  if(manifest.database_target!=='crm'||!manifest.full_gzip_verified||!manifest.dump_completion_verified)throw Error('VERIFIED_CRM_BACKUP_REQUIRED');
  await validateBackup(o['--backup-manifest']);
  await acquireExecutorLocks(c,pkg.package_sha256,path.resolve(o['--private-journal']));
  journal=openJournal(o['--private-journal'],pkg.package_sha256);
  await journal.append({phase:'cabin_apply_verified',backup_manifest_sha256:hash(readBytes(o['--backup-manifest'])),review_sha256:hash(review)});
  return await executeAssignments({pkg,store:await createCabinStore(c,{readOnly:false}),journal});
 }finally{journal?.close();await c.end();}
}
if(require.main===module)run(process.argv.slice(2)).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'CABIN_ASSIGNMENT_REQUIRES_JOURNAL_REVIEW');process.exitCode=1;});
module.exports={run};
