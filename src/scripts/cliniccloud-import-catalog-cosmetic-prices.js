#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {hash}=require('../lib/cliniccloud-import/adapter');
const {parseArgs,readBytes,writePrivateJson}=require('../lib/cliniccloud-import/io');
const {connectOperatorDatabase}=require('../lib/cliniccloud-import/operator-database');
const {prepareCosmeticPrices,reviewedConfig,verifyCosmeticPrices,verifyPricedState}=require('../lib/cliniccloud-import/catalog-cosmetic-prices');
const {privateJson,openJournal,acquireExecutorLocks}=require('./cliniccloud-import-appointments-apply');
const {validateBackup}=require('./cliniccloud-import-contacts-apply');
async function capture(c,plan,review,lock=false) {
  const suffix=lock?' FOR UPDATE':'',keys=new Set(review.bindings.map(b=>b.source_catalog_key));
  const codes=plan.rows.filter(r=>keys.has(r.source_catalog_key)).map(r=>r.proposed_code);
  const anchorCodes=review.anchors.map(a=>a.codigo);
  if(!codes.length||codes.length>30||anchorCodes.length!==2)throw Error('COSMETIC_PRICE_SCOPE_LIMIT');
  const [clinics]=await c.query('SELECT id_clinica,grupoClinicaId AS grupo_clinica_id FROM Clinicas WHERE id_clinica=72'+suffix);
  // Lock treatment identities in one stable order, including unchanged anchors.
  const [all]=await c.query('SELECT * FROM Tratamientos WHERE codigo IN (?) ORDER BY id_tratamiento'+suffix,[[...codes,...anchorCodes]]);
  const treatments=all.filter(t=>codes.includes(t.codigo)),anchors=all.filter(t=>anchorCodes.includes(t.codigo));
  if(!treatments.length)throw Error('COSMETIC_PRICE_DRAFTS_MISSING');
  const ids=treatments.map(t=>t.id_tratamiento);
  const [appointments]=await c.query('SELECT id_cita,tratamiento_id FROM CitasPacientes WHERE tratamiento_id IN (?) ORDER BY id_cita'+suffix,[ids]);
  const [requirements]=await c.query('SELECT * FROM TreatmentConsentRequirements WHERE tratamiento_id IN (?) ORDER BY id'+suffix,[ids]);
  return {clinics,treatments,anchors,appointments,requirements};
}
async function execute({c,pkg,plan,journal,dryRun=false}) {
  let commitAttempted=false;
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.beginTransaction();
    const before=await capture(c,plan,pkg.review,true);
    if(hash(before)!==pkg.before_sha256){verifyPricedState(before,pkg);await c.rollback();await journal.append({stage:'cosmetic_price_replay_preserved',updated:0});return{status:'replay_preserved',updated:0};}
    await journal.append({stage:'cosmetic_price_prepared',before,operations:pkg.operations});
    for(const op of pkg.operations){
      const [result]=await c.query('UPDATE Tratamientos SET precio_base=?,clinical_config=?,updatedAt=UTC_TIMESTAMP() WHERE id_tratamiento=? AND activo=0',
        [op.gross_amount,JSON.stringify(reviewedConfig(op,pkg)),op.id]);
      if(result.affectedRows!==1)throw Error('COSMETIC_PRICE_WRITE_MISMATCH');
    }
    const after=await capture(c,plan,pkg.review);verifyPricedState(after,pkg);
    await journal.append({stage:'cosmetic_price_verified_before_commit',after,after_sha256:hash(after)});
    if(dryRun){await c.rollback();if(hash(await capture(c,plan,pkg.review))!==pkg.before_sha256)throw Error('COSMETIC_PRICE_ROLLBACK_MISMATCH');
      await journal.append({stage:'cosmetic_price_dry_run_rolled_back',proposed:pkg.operations.length});return{status:'rolled_back_and_verified',updated:0,proposed:pkg.operations.length};}
    commitAttempted=true;await c.commit();await journal.append({stage:'cosmetic_price_committed',updated:pkg.operations.length,after_sha256:hash(after)});
    const independent=await connectOperatorDatabase('crm');
    try{await independent.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const readback=await capture(independent,plan,pkg.review);
      verifyPricedState(readback,pkg);if(hash(readback)!==hash(after))throw Error('COSMETIC_PRICE_READBACK_MISMATCH');await independent.rollback();
      await journal.append({stage:'cosmetic_price_independent_read_verified',after_sha256:hash(readback)});
    }finally{await independent.end();}
    return{status:'committed_and_verified',updated:pkg.operations.length,activated:0,messages:0,budgets_changed:0};
  }catch(error){await c.rollback().catch(()=>{});if(commitAttempted)throw Error('COSMETIC_PRICE_COMMIT_RESULT_REQUIRES_JOURNAL_REVIEW');throw error;}
}
async function run(args){
  const o=parseArgs(args,['--mode','--target','--plan','--workbook','--purpose-document','--review','--package','--private-output','--approved-sha256','--backup-manifest','--private-journal']);
  if(o['--target']!=='crm'||!['prepare','dry-run','apply','verify'].includes(o['--mode']))throw Error('EXPLICIT_CRM_COSMETIC_PRICE_MODE_REQUIRED');
  if(process.cwd()!=='/home/ubuntu/wt/back-dev'||path.resolve(__dirname,'../..')!==process.cwd()
    ||execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='dev')throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
  const plan=privateJson(o['--plan']),purposeDocument=readBytes(o['--purpose-document']).toString('utf8');
  if(hash(readBytes(o['--workbook']))!==plan.workbook_sha256)throw Error('COSMETIC_PRICE_SOURCE_CHANGED');
  const c=await connectOperatorDatabase('crm');let journal;
  try{
    if(o['--mode']==='prepare'){
      const review=privateJson(o['--review']);await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const before=await capture(c,plan,review),pkg=prepareCosmeticPrices({plan,review,purposeDocument,before});await c.rollback();
      writePrivateJson(o['--private-output'],pkg);return{status:'prepared',proposed:pkg.operations.length,package_sha256:pkg.package_sha256,writes:0};
    }
    const pkg=privateJson(o['--package']);verifyCosmeticPrices(pkg,plan,purposeDocument);
    if(o['--mode']==='verify'){
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const after=await capture(c,plan,pkg.review);
      verifyPricedState(after,pkg);await c.rollback();writePrivateJson(o['--private-output'],{verified_at:new Date().toISOString(),package_sha256:pkg.package_sha256,after,after_sha256:hash(after),policy:pkg.policy});
      return{status:'verified_read_only',treatments:after.treatments.length};
    }
    if(o['--approved-sha256']!==pkg.package_sha256||!Number.isFinite(Date.parse(pkg.created_at))||Date.now()-Date.parse(pkg.created_at)>7200000||Date.parse(pkg.created_at)>Date.now())throw Error('FRESH_COSMETIC_PRICE_APPROVAL_REQUIRED');
    const manifest=privateJson(o['--backup-manifest']);if(manifest.database_target!=='crm'||!manifest.full_gzip_verified||!manifest.dump_completion_verified)throw Error('COSMETIC_PRICE_BACKUP_REQUIRED');
    await validateBackup(o['--backup-manifest']);await acquireExecutorLocks(c,pkg.package_sha256,path.resolve(o['--private-journal']));
    journal=openJournal(o['--private-journal'],pkg.package_sha256);
    await journal.append({stage:'cosmetic_price_verified',mode:o['--mode'],backup_manifest_sha256:hash(readBytes(o['--backup-manifest']))});
    return await execute({c,pkg,plan,journal,dryRun:o['--mode']==='dry-run'});
  }finally{journal?.close();await c.end();}
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'COSMETIC_PRICE_FAILED_REVIEW_PRIVATE_JOURNAL');process.exitCode=1;});
module.exports={capture,execute,run};
