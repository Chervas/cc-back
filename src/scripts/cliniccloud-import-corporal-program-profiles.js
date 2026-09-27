#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {parseArgs,writePrivateJson,readBytes}=require('../lib/cliniccloud-import/io');
const {hash}=require('../lib/cliniccloud-import/adapter');
const {connectOperatorDatabase}=require('../lib/cliniccloud-import/operator-database');
const {prepare,verifyState,verifyProgram}=require('../lib/cliniccloud-import/corporal-program-profiles');
const {SOURCES}=require('../lib/cliniccloud-import/corporal-program-drafts');
const {privateJson,openJournal,acquireExecutorLocks}=require('./cliniccloud-import-appointments-apply');
const {validateBackup}=require('./cliniccloud-import-contacts-apply');

async function capture(c,lock=false){
 const query=async(sql)=>(await c.query(sql+(lock?' FOR UPDATE':'')))[0];
 return {
  clinics:await query('SELECT id_clinica,grupoClinicaId,equipment_booking_enabled FROM Clinicas WHERE id_clinica=72'),
  treatments:await query('SELECT * FROM Tratamientos WHERE clinica_id IN (66,72) ORDER BY id_tratamiento'),
  programs:await query('SELECT * FROM TreatmentPrograms WHERE clinic_id IN (66,72) ORDER BY id'),
  staff:await query('SELECT * FROM DoctorClinicas WHERE doctor_id=221 AND clinica_id=72'),
  staff_hours:await query('SELECT h.* FROM DoctorHorarios h JOIN DoctorClinicas d ON d.id=h.doctor_clinica_id WHERE d.doctor_id=221 AND d.clinica_id=72 ORDER BY h.id'),
  rooms:await query('SELECT * FROM Instalaciones WHERE id IN(82,85,87) ORDER BY id'),
  room_hours:await query('SELECT * FROM InstalacionHorarios WHERE instalacion_id IN(82,85,87) ORDER BY id'),
  units:await query('SELECT * FROM BookingEquipment WHERE group_id=29 ORDER BY id'),
  shares:await query('SELECT * FROM BookingEquipmentClinics WHERE equipment_id IN(4,6,10,11,14) ORDER BY equipment_id,clinic_id'),
  aliases:await query('SELECT * FROM InstallationPhysicalAliases WHERE group_id=29 ORDER BY installation_id'),
  policies:await query('SELECT * FROM BookingEquipmentRoomPolicies WHERE installation_id IN(82,85,87) ORDER BY installation_id'),
 };
}
async function protectedRows(c){
 const result={};
 for(const [k,q]of Object.entries({
  appointments:'SELECT * FROM CitasPacientes WHERE clinica_id IN(66,72) ORDER BY id_cita',
  requirements:'SELECT * FROM TreatmentConsentRequirements WHERE clinica_id IN(66,72) ORDER BY id',
 })){const [rows]=await c.query(q);result[k]={count:rows.length,sha256:hash(rows)};}
 return result;
}
async function executeProfiles({c,pkg,journal,rehearse=false}){
 let commitAttempted=false;
 try{
  await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await c.beginTransaction();
  const before=await capture(c,true);verifyState(before,pkg);
  const updated=pkg.operations.filter(op=>hash(before.treatments.find(t=>t.id_tratamiento===op.id))!==op.before_sha256).length;
  assert(updated===0||updated===5,'Partial profile state requires investigation');
  if(updated===5){await c.rollback();return{status:'replay',updated:0};}
  await journal.append({stage:'profiles_locked_before',before_sha256:hash(before),operations:pkg.operations});
  for(const op of pkg.operations){
   const [r]=await c.query('UPDATE Tratamientos SET clinical_config=?,updatedAt=UTC_TIMESTAMP() WHERE id_tratamiento=?',[JSON.stringify(op.after_config),op.id]);
   assert.equal(r.affectedRows,1);
  }
  const after=await capture(c);verifyState(after,pkg,{profilesComplete:true});
  await journal.append({stage:'profiles_written_before_commit',after_sha256:hash(after)});
  if(rehearse){await c.rollback();assert.equal(hash(await capture(c)),hash(before));return{status:'rehearsed_rolled_back',updated:0,proposed:5};}
  commitAttempted=true;await c.commit();await journal.append({stage:'profiles_committed',updated:5});
  return{status:'committed',updated:5};
 }catch(e){await c.rollback().catch(()=>{});if(commitAttempted)throw Error('CORPORAL_PROFILES_COMMIT_REQUIRES_JOURNAL_RECONCILIATION');throw e;}
}
async function run(args){
 const o=parseArgs(args,['--mode','--target','--plan','--workbook','--archive','--package','--private-output','--approved-sha256','--backup-manifest','--private-journal']);
 assert.equal(o['--target'],'crm');assert(['prepare','rehearse','apply','verify'].includes(o['--mode']));
 assert.equal(process.cwd(),'/home/ubuntu/wt/back-dev');assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),'dev');
 const plan=privateJson(o['--plan']);assert.equal(hash(readBytes(o['--workbook'])),plan.workbook_sha256);
 const sourceHashes=JSON.parse(execFileSync('python3',['-c',
  'import sys,zipfile,hashlib,json; z=zipfile.ZipFile(sys.argv[1]); out={};\nfor n in json.loads(sys.argv[2]):\n a=[i for i in z.infolist() if i.filename==n]; assert len(a)==1 and a[0].file_size<10485760; out[n]=hashlib.sha256(z.read(a[0])).hexdigest()\nprint(json.dumps(out))',
  o['--archive'],JSON.stringify(Object.keys(SOURCES))],{encoding:'utf8',timeout:30000}));
 const c=await connectOperatorDatabase('crm');let journal,browser;
 try{
  await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  const before=await capture(c),baseline=await protectedRows(c);await c.rollback();
  if(o['--mode']==='prepare'){
   const pkg=prepare({plan,sourceHashes,before});writePrivateJson(o['--private-output'],{prepared_at:new Date().toISOString(),...pkg});
   return{status:'prepared',profiles:5,program_notes:7,package_sha256:pkg.package_sha256,writes:0};
  }
  const {prepared_at,...pkg}=privateJson(o['--package']);assert.equal(hash(pkg),hash(prepare({plan,sourceHashes,before:pkg.before})));
  verifyState(before,pkg,{complete:o['--mode']==='verify'});
  if(o['--mode']==='verify'){
   for(const p of pkg.programs){const [rows]=await c.query('SELECT * FROM TreatmentProgramRevisions WHERE program_id=? AND version_number=2',[p.before.id]);assert.equal(rows.length,1);verifyProgram(rows[0].snapshot,p);}
   const result={status:'verified',profiles:5,program_revisions:7,writes:0,policy:pkg.policy};writePrivateJson(o['--private-output'],result);return result;
  }
  assert.equal(o['--approved-sha256'],pkg.package_sha256);
  assert(Number.isFinite(Date.parse(prepared_at))&&Date.now()-Date.parse(prepared_at)<7200000&&Date.parse(prepared_at)<=Date.now());
  assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'','Commit operator first');
  const backup=privateJson(o['--backup-manifest']);assert.equal(backup.database_target,'crm');
  assert(backup.full_gzip_verified&&backup.dump_completion_verified&&Number.isFinite(Date.parse(backup.generated_at))&&Date.now()-Date.parse(backup.generated_at)<7200000&&Date.parse(backup.generated_at)<=Date.now());
  await validateBackup(o['--backup-manifest']);await acquireExecutorLocks(c,pkg.package_sha256,o['--private-journal']);
  journal=openJournal(o['--private-journal'],pkg.package_sha256);await journal.append({stage:'baseline',baseline,package_sha256:pkg.package_sha256});
  // Authenticate before any durable change; never mint/copy credentials or bypass MFA.
  browser=await require('puppeteer-core').connect({browserURL:'http://127.0.0.1:9227',defaultViewport:null});
  const page=(await browser.pages()).find(p=>p.url().startsWith('https://crm.clinicaclick.com/')&&!p.url().includes('/sign-in'));assert(page);
  const call=(route,method,payload)=>page.evaluate(async({route,method,payload})=>{
   const r=await fetch('/api/'+route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('accessToken')},...(payload?{body:JSON.stringify(payload)}:{})});
   return{status:r.status,body:await r.json()};
  },{route,method,payload});
  const access=await call('treatment-programs?clinic_id=72','GET');assert.equal(access.status,200,'Normal CRM access required');
  const profiles=await executeProfiles({c,pkg,journal,rehearse:o['--mode']==='rehearse'});let revised=0;
  if(o['--mode']==='apply')for(const p of pkg.programs){
   const actual=await capture(c);verifyState(actual,pkg,{profilesComplete:true});
   if(actual.programs.find(r=>r.id===p.before.id).version_number===2)continue;
   const route=`treatment-programs/${p.before.public_id}?clinic_id=72`;
   await journal.append({stage:'revision_intent',route,expected_version:1,payload_sha256:hash(p.payload)});
   const response=await call(route,'PATCH',p.payload);await journal.append({stage:'revision_returned',route,status:response.status});
   assert.equal(response.status,200,'API rejected revision; inspect journal');assert.equal(response.body.item.purchase_enabled,false);assert.equal(response.body.item.status,'draft');revised++;
  }
  const independent=await connectOperatorDatabase('crm');
  try{await independent.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const actual=await capture(independent);
   if(o['--mode']==='rehearse')assert.equal(hash(actual),hash(before));else verifyState(actual,pkg,{complete:true});
   assert.equal(hash(await protectedRows(independent)),hash(baseline),'Protected data changed: inspect, never restore');await independent.rollback();
  }finally{await independent.end();}
  const result={status:o['--mode'],profiles,revised,protected_tables_unchanged:true,policy:pkg.policy};
  await journal.append({stage:'independent_verified',result});writePrivateJson(o['--private-output'],result);return result;
 }finally{browser?.disconnect();journal?.close();await c.end();}
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{
 console.error(/^[A-Z_]+$/.test(e.message)?e.message:'CORPORAL_PROFILES_STOPPED_REVIEW_JOURNAL');process.exitCode=1;
});
module.exports={capture,executeProfiles,run};
