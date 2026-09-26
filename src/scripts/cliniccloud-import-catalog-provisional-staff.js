#!/usr/bin/env node
'use strict';
const path=require('node:path'),{execFileSync}=require('node:child_process');
const {hash}=require('../lib/cliniccloud-import/adapter');
const {parseArgs,readBytes,writePrivateJson}=require('../lib/cliniccloud-import/io');
const {connectOperatorDatabase}=require('../lib/cliniccloud-import/operator-database');
const {SOURCE,prepare,verifyPackage,verifyAfter}=require('../lib/cliniccloud-import/catalog-provisional-staff');
const {privateJson,openJournal,acquireExecutorLocks}=require('./cliniccloud-import-appointments-apply');
const {validateBackup}=require('./cliniccloud-import-contacts-apply');
async function capture(c,lock=false){
  const select=async sql=>(await c.query(sql+(lock?' FOR UPDATE':'')))[0];
  return {
    clinics:await select('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica=72'),
    treatments:await select('SELECT * FROM Tratamientos WHERE id_tratamiento IN (1973,1974) ORDER BY id_tratamiento'),
    rooms:await select('SELECT * FROM Instalaciones WHERE id IN (82,84) ORDER BY id'),
    room_hours:await select('SELECT * FROM InstalacionHorarios WHERE instalacion_id IN (82,84) ORDER BY id'),
    staff:await select('SELECT * FROM DoctorClinicas WHERE doctor_id=221 AND clinica_id=72 ORDER BY id'),
    staff_hours:await select('SELECT * FROM DoctorHorarios WHERE doctor_clinica_id=119 ORDER BY id'),
    equipment:await select('SELECT * FROM BookingEquipment WHERE id=12'),
    equipment_clinics:await select('SELECT * FROM BookingEquipmentClinics WHERE equipment_id=12 ORDER BY clinic_id'),
    requirements:await select('SELECT * FROM TreatmentConsentRequirements WHERE tratamiento_id IN (1973,1974) ORDER BY id'),
    appointments:await select('SELECT id_cita,tratamiento_id FROM CitasPacientes WHERE tratamiento_id IN (1973,1974) ORDER BY id_cita'),
  };
}
async function execute({c,pkg,journal,dryRun=false}){
  let commitAttempted=false;
  try{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.beginTransaction();
    const before=await capture(c,true);
    if(hash(before)!==pkg.before_sha256){verifyAfter(before,pkg);await c.rollback();await journal.append({stage:'provisional_staff_replay',updated:0});return{status:'replay_preserved',updated:0};}
    await journal.append({stage:'provisional_staff_before',before,operations:pkg.operations});
    for(const op of pkg.operations){
      const [r]=await c.query('UPDATE Tratamientos SET clinical_config=?,updatedAt=UTC_TIMESTAMP() WHERE id_tratamiento=? AND activo=0',[JSON.stringify(op.after_config),op.id]);
      if(r.affectedRows!==1)throw Error('PROVISIONAL_STAFF_UPDATE_MISMATCH');
    }
    const after=await capture(c);verifyAfter(after,pkg);await journal.append({stage:'provisional_staff_verified_before_commit',after});
    if(dryRun){await c.rollback();if(hash(await capture(c))!==pkg.before_sha256)throw Error('PROVISIONAL_STAFF_ROLLBACK_MISMATCH');await journal.append({stage:'provisional_staff_rolled_back'});return{status:'rolled_back_and_verified',proposed:pkg.operations.length,updated:0};}
    commitAttempted=true;await c.commit();await journal.append({stage:'provisional_staff_committed',updated:pkg.operations.length});
    const independent=await connectOperatorDatabase('crm');
    try{await independent.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const current=await capture(independent);verifyAfter(current,pkg);await independent.rollback();await journal.append({stage:'provisional_staff_independent_read_verified',after_sha256:hash(current)});}
    finally{await independent.end();}
    return{status:'committed_and_verified',updated:pkg.operations.length,...pkg.policy};
  }catch(e){await c.rollback().catch(()=>{});if(commitAttempted)throw Error('PROVISIONAL_STAFF_COMMIT_RESULT_REQUIRES_JOURNAL_REVIEW');throw e;}
}
async function run(args){
  const o=parseArgs(args,['--target','--mode','--workbook','--review','--package','--private-output','--approved-sha256','--backup-manifest','--private-journal']);
  if(o['--target']!=='crm'||!['prepare','dry-run','apply','verify'].includes(o['--mode']))throw Error('EXPLICIT_PROVISIONAL_STAFF_MODE_REQUIRED');
  if(process.cwd()!=='/home/ubuntu/wt/back-dev'||path.resolve(__dirname,'../..')!==process.cwd()
    ||execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='dev')throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
  if(hash(readBytes(o['--workbook']))!==SOURCE)throw Error('PROVISIONAL_STAFF_SOURCE_CHANGED');
  const c=await connectOperatorDatabase('crm');let journal;
  try{
    if(o['--mode']==='prepare'){
      const review=privateJson(o['--review']);await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const pkg=prepare({before:await capture(c),review});await c.rollback();writePrivateJson(o['--private-output'],pkg);
      return{status:'prepared',proposed:pkg.operations.length,package_sha256:pkg.package_sha256,writes:0};
    }
    const pkg=privateJson(o['--package']);verifyPackage(pkg);
    if(o['--mode']==='verify'){
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const after=await capture(c);verifyAfter(after,pkg);await c.rollback();
      writePrivateJson(o['--private-output'],{verified_at:new Date().toISOString(),package_sha256:pkg.package_sha256,after,policy:pkg.policy});return{status:'verified_read_only',treatments:after.treatments.length};
    }
    const age=Date.now()-Date.parse(pkg.created_at);
    if(o['--approved-sha256']!==pkg.package_sha256||!Number.isFinite(age)||age<0||age>7200000)throw Error('FRESH_PROVISIONAL_STAFF_REVIEW_REQUIRED');
    const manifest=privateJson(o['--backup-manifest']),backupAge=Date.now()-Date.parse(manifest.generated_at);
    if(manifest.database_target!=='crm'||!manifest.full_gzip_verified||!manifest.dump_completion_verified
      ||!Number.isFinite(backupAge)||backupAge<0||backupAge>7200000)throw Error('FRESH_PROVISIONAL_STAFF_BACKUP_REQUIRED');
    await validateBackup(o['--backup-manifest']);await acquireExecutorLocks(c,pkg.package_sha256,path.resolve(o['--private-journal']));
    journal=openJournal(o['--private-journal'],pkg.package_sha256);
    await journal.append({stage:'provisional_staff_inputs_verified',mode:o['--mode'],backup_manifest_sha256:hash(readBytes(o['--backup-manifest']))});
    return await execute({c,pkg,journal,dryRun:o['--mode']==='dry-run'});
  }finally{journal?.close();await c.end();}
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'PROVISIONAL_STAFF_FAILED_REVIEW_PRIVATE_JOURNAL');process.exitCode=1;});
module.exports={capture,execute,run};
