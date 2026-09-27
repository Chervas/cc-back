#!/usr/bin/env node
'use strict';
// Operator only: ordinary authenticated program API; SQL is SELECT-only.
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const {parseArgs,writePrivateJson,readBytes}=require('../lib/cliniccloud-import/io');
const {hash}=require('../lib/cliniccloud-import/adapter');
const {connectOperatorDatabase}=require('../lib/cliniccloud-import/operator-database');
const {normalizeValues,payloadHash}=require('../lib/treatmentPrograms.contract');
const {prepare,SOURCES}=require('../lib/cliniccloud-import/corporal-program-drafts');
const {privateJson,openJournal,acquireExecutorLocks}=require('./cliniccloud-import-appointments-apply');
const {validateBackup}=require('./cliniccloud-import-contacts-apply');

async function capture(c){
 const select=async(sql,args=[])=>(await c.query(sql,args))[0];
 return{
  clinics:await select('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica=72'),
  treatments:await select("SELECT * FROM Tratamientos WHERE clinica_id=72 AND codigo LIKE 'BS26-%' ORDER BY id_tratamiento"),
  existingPrograms:await select('SELECT * FROM TreatmentPrograms WHERE clinic_id IN (66,72) ORDER BY id'),
 };
}
async function invariants(c){
 const out={};
 for(const [key,sql]of Object.entries({
  appointments:'SELECT id_cita,estado,inicio,fin,tratamiento_id,source_system,source_reference,import_metadata,updated_at FROM CitasPacientes WHERE clinica_id IN (66,72) ORDER BY id_cita',
  treatments:'SELECT * FROM Tratamientos WHERE clinica_id IN (66,72) ORDER BY id_tratamiento',
  requirements:'SELECT * FROM TreatmentConsentRequirements WHERE clinica_id IN (66,72) ORDER BY id',
 })) {const [rows]=await c.query(sql);out[key]={count:rows.length,sha256:hash(rows)};}
 return out;
}
function verifyRow(row,program){
 assert.equal(row.clinic_id,72);assert.equal(row.version_number,1);
 assert.equal(row.request_key,payloadHash([72,program.payload.idempotency_key]));
 assert.equal(hash(normalizeValues(row)),hash(normalizeValues(program.payload)));
 assert.equal(row.request_payload_hash,payloadHash(normalizeValues(program.payload)));
}
async function verify(c,pkg,oldPrograms){
 const after=await capture(c),created=[];
 for(const p of pkg.programs){
  const rows=after.existingPrograms.filter(r=>r.request_key===payloadHash([72,p.payload.idempotency_key]));
  assert.equal(rows.length,1);verifyRow(rows[0],p);
  const [revisions]=await c.query('SELECT * FROM TreatmentProgramRevisions WHERE program_id=? ORDER BY version_number',[rows[0].id]);
  assert.equal(revisions.length,1);assert.equal(revisions[0].version_number,1);verifyRow(revisions[0].snapshot,p);
  created.push({id:rows[0].public_id,name:rows[0].name,appointments:rows[0].appointments.length,status:rows[0].status});
 }
 if(oldPrograms)for(const old of oldPrograms)assert.equal(hash(after.existingPrograms.find(p=>p.id===old.id)),hash(old),'Existing definition changed');
 return created;
}
async function run(args){
 const o=parseArgs(args,['--mode','--target','--plan','--workbook','--archive','--package','--private-output','--approved-sha256','--backup-manifest','--private-journal']);
 if(o['--target']!=='crm'||!['prepare','preview','apply','verify'].includes(o['--mode']))throw Error('EXPLICIT_CRM_DRAFT_MODE_REQUIRED');
 if(process.cwd()!=='/home/ubuntu/wt/back-dev'||execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='dev')throw Error('DEV_OPERATOR_REQUIRED');
 const plan=privateJson(o['--plan']);if(hash(readBytes(o['--workbook']))!==plan.workbook_sha256)throw Error('SOURCE_WORKBOOK_CHANGED');
 const sourceHashes=JSON.parse(execFileSync('python3',['-c',
  'import sys,zipfile,hashlib,json; z=zipfile.ZipFile(sys.argv[1]); out={};\nfor n in json.loads(sys.argv[2]):\n a=[i for i in z.infolist() if i.filename.split("/")[-1]==n and not i.filename.startswith("__MACOSX/")]; assert len(a)==1 and a[0].file_size<10485760; out[n]=hashlib.sha256(z.read(a[0])).hexdigest()\nprint(json.dumps(out))',
  o['--archive'],JSON.stringify(Object.keys(SOURCES))],{encoding:'utf8',timeout:30000}));
 const c=await connectOperatorDatabase('crm');let browser,journal;
 try{
  await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  const before=await capture(c),pkg=prepare({plan,sourceHashes,...before}),baseline=await invariants(c);await c.rollback();
  // Never replay onto a definition that somebody has completed or edited.
  for(const p of pkg.programs){const existing=before.existingPrograms.filter(r=>r.request_key===payloadHash([72,p.payload.idempotency_key]));
   assert(existing.length<=1);if(existing.length)verifyRow(existing[0],p);
  }
  if(o['--mode']==='prepare'){
   writePrivateJson(o['--private-output'],{prepared_at:new Date().toISOString(),...pkg});
   return{mode:'prepared',programs:pkg.programs.length,package_sha256:pkg.package_sha256,writes:0};
  }
  const saved=privateJson(o['--package']),{prepared_at,...savedBody}=saved;assert.equal(hash(savedBody),hash(pkg),'Prepared sources or treatments changed');
  if(o['--mode']==='verify'){
   const rows=await verify(c,pkg);writePrivateJson(o['--private-output'],{verified_at:new Date().toISOString(),programs:rows,policy:pkg.policy});
   return{mode:'verified',programs:rows,writes:0};
  }
  if(o['--mode']==='apply'){
   if(o['--approved-sha256']!==pkg.package_sha256||!Number.isFinite(Date.parse(prepared_at))||Date.now()-Date.parse(prepared_at)>7200000||Date.parse(prepared_at)>Date.now())throw Error('FRESH_EXACT_REVIEW_REQUIRED');
   if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())throw Error('CLEAN_COMMITTED_OPERATOR_REQUIRED');
   const backup=privateJson(o['--backup-manifest']);
   if(backup.database_target!=='crm'||!backup.full_gzip_verified||!backup.dump_completion_verified
    ||!Number.isFinite(Date.parse(backup.generated_at))||Date.now()-Date.parse(backup.generated_at)>7200000||Date.parse(backup.generated_at)>Date.now())throw Error('FRESH_CRM_BACKUP_REQUIRED');
   await validateBackup(o['--backup-manifest']);await acquireExecutorLocks(c,pkg.package_sha256,o['--private-journal']);
   journal=openJournal(o['--private-journal'],pkg.package_sha256);await journal.append({stage:'before',package_sha256:pkg.package_sha256,baseline,existing_programs:before.existingPrograms});
  }
  browser=await require('puppeteer-core').connect({browserURL:'http://127.0.0.1:9227',defaultViewport:null});
  const page=(await browser.pages()).find(p=>p.url().startsWith('https://crm.clinicaclick.com/')&&!p.url().includes('/sign-in'));
  if(!page)throw Error('NORMAL_CRM_SESSION_REQUIRED');
  const results=[];
  for(const program of pkg.programs){
   const current=await capture(c);assert.equal(hash(current.treatments),hash(before.treatments),'Treatments changed before API call');
   for(const old of before.existingPrograms)assert.equal(hash(current.existingPrograms.find(p=>p.id===old.id)),hash(old),'Existing program changed before API call');
   const response=await page.evaluate(async({payload,preview})=>{
    const r=await fetch('/api/treatment-programs'+(preview?'/preview':'')+'?clinic_id=72',{
     method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('accessToken')},body:JSON.stringify(payload)});
    return{status:r.status,body:await r.json()};
   },{payload:program.payload,preview:o['--mode']==='preview'});
   if(![200,201].includes(response.status)){await journal?.append({stage:'api_rejected',code:program.code,response});throw Error('PROGRAM_API_REJECTED_'+response.status);}
   const item=response.body.item;
   assert.equal(item.clinic_id,72);assert.equal(item.status,'draft');assert.equal(item.purchase_enabled,false);
   assert.equal(item.total_price,null);assert.equal(item.appointments.length,program.payload.appointments.length);assert.equal(item.summary.ready_for_scheduling,false);
   results.push({code:program.code,name:item.name,id:item.id,appointments:item.appointments.length,purchase_enabled:item.purchase_enabled,
    created:response.body.created,issues:[...new Set(item.summary.issues.map(x=>x.code))]});
   await journal?.append({stage:'canonical_create_returned',result:results.at(-1)});
  }
  const verified=o['--mode']==='apply'?await verify(c,pkg,before.existingPrograms):null;
  assert.equal(hash(await invariants(c)),hash(baseline),'Protected data changed; review, do not restore');
  if(o['--mode']==='preview')assert.equal(hash((await capture(c)).existingPrograms),hash(before.existingPrograms));
  const result={mode:o['--mode'],results,verified,protected_tables_unchanged:true,policy:pkg.policy};
  writePrivateJson(o['--private-output'],result);await journal?.append({stage:'independent_sql_verified',result});return result;
 }finally{browser?.disconnect();journal?.close();await c.end();}
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{
 console.error(/^[A-Z_0-9]+$/.test(e.message)?e.message:'CORPORAL_DRAFTS_STOPPED_REVIEW_JOURNAL');process.exitCode=1;
});
module.exports={run,verifyRow};
