#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {hash}=require('../lib/cliniccloud-import/adapter');
const {parseArgs,readBytes,writePrivateJson}=require('../lib/cliniccloud-import/io');
const {connectOperatorDatabase}=require('../lib/cliniccloud-import/operator-database');
const {prepare,verifyVariant,programUpdate,verifyProgram,SPECS}=require('../lib/cliniccloud-import/capillary-program-variants');
const {PDF_NAME}=require('../lib/cliniccloud-import/capillary-program-drafts');
const {privateJson,openJournal,acquireExecutorLocks}=require('./cliniccloud-import-appointments-apply');
const {validateBackup}=require('./cliniccloud-import-contacts-apply');

async function capture(c) {
  const select=async(sql,args=[]) => (await c.query(sql,args))[0];
  const codes=SPECS.map(s=>s.code);
  return {
    clinics:await select('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica=66'),
    treatments:await select("SELECT * FROM Tratamientos WHERE clinica_id=66 AND codigo LIKE 'BS26-%' AND codigo NOT IN (?) ORDER BY id_tratamiento",[codes]),
    existingVariants:await select('SELECT * FROM Tratamientos WHERE codigo IN (?) ORDER BY codigo',[codes]),
    programs:await select('SELECT * FROM TreatmentPrograms WHERE clinic_id IN (66,72) ORDER BY id'),
    staff:await select('SELECT * FROM DoctorClinicas WHERE doctor_id=50 AND clinica_id=66'),
    staff_hours:await select('SELECT h.* FROM DoctorHorarios h JOIN DoctorClinicas d ON d.id=h.doctor_clinica_id WHERE d.doctor_id=50 AND d.clinica_id=66 ORDER BY h.id'),
    rooms:await select('SELECT * FROM Instalaciones WHERE id IN (75,83,86) ORDER BY id'),
    room_hours:await select('SELECT * FROM InstalacionHorarios WHERE instalacion_id IN (75,83,86) ORDER BY id'),
    units:await select('SELECT * FROM BookingEquipment WHERE id IN (12,14,15) ORDER BY id'),
    shares:await select('SELECT * FROM BookingEquipmentClinics WHERE equipment_id IN (12,14,15) ORDER BY equipment_id,clinic_id'),
    aliases:await select('SELECT * FROM InstallationPhysicalAliases WHERE group_id=29 ORDER BY installation_id'),
  };
}
function verifyState(actual,pkg,{complete=false}={}) {
  assert.equal(hash({...actual,existingVariants:[],programs:pkg.before.programs}),hash(pkg.before),'Source treatment or resources changed');
  for(const row of actual.existingVariants){
    const variant=pkg.variants.find(v=>v.payload.codigo===row.codigo);assert(variant);
    assert.equal(actual.existingVariants.filter(t=>t.codigo===row.codigo).length,1,'Duplicate variant code');
    verifyVariant(row,variant);
  }
  if(complete)assert.equal(actual.existingVariants.length,3);
  for(const old of pkg.before.programs){
    const current=actual.programs.find(p=>p.id===old.id);assert(current);
    const target=pkg.programs.find(p=>p.before.id===old.id);
    if(!target || (!complete&&current.version_number===old.version_number))assert.equal(hash(current),hash(old),'Program edited concurrently');
    else verifyProgram(current,target,actual.existingVariants);
  }
  assert.equal(actual.programs.length,pkg.before.programs.length);
}
async function protectedRows(c) {
  const result={};
  for(const [key,sql]of Object.entries({
    appointments:"SELECT id_cita,estado,inicio,fin,tratamiento_id,import_metadata,updated_at FROM CitasPacientes WHERE clinica_id IN (66,72) AND inicio >= '2026-09-21' ORDER BY id_cita",
    requirements:'SELECT * FROM TreatmentConsentRequirements WHERE clinica_id IN (66,72) ORDER BY id',
  })) {const [rows]=await c.query(sql);result[key]={count:rows.length,sha256:hash(rows)};}
  return result;
}
async function run(args) {
  const o=parseArgs(args,['--mode','--target','--plan','--workbook','--archive','--package','--private-output','--approved-sha256','--backup-manifest','--private-journal']);
  assert.equal(o['--target'],'crm');assert(['prepare','apply','verify'].includes(o['--mode']));
  assert.equal(process.cwd(),'/home/ubuntu/wt/back-dev');assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),'dev');
  const plan=privateJson(o['--plan']);assert.equal(hash(readBytes(o['--workbook'])),plan.workbook_sha256);
  const pdfSha256=execFileSync('python3',['-c',
    'import zipfile,sys,hashlib; z=zipfile.ZipFile(sys.argv[1]); a=[i for i in z.infolist() if i.filename==sys.argv[2]]; assert len(a)==1 and a[0].file_size<10485760; print(hashlib.sha256(z.read(a[0])).hexdigest())',o['--archive'],PDF_NAME],{encoding:'utf8',timeout:30000}).trim();
  const c=await connectOperatorDatabase('crm');let browser,journal;
  try{
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const actual=await capture(c),baseline=await protectedRows(c);await c.rollback();
    if(o['--mode']==='prepare'){
      const pkg=prepare({plan,pdfSha256,before:actual});
      writePrivateJson(o['--private-output'],{prepared_at:new Date().toISOString(),...pkg});
      return {status:'prepared',variants:3,programs:3,package_sha256:pkg.package_sha256,writes:0};
    }
    const {prepared_at,...pkg}=privateJson(o['--package']);
    assert.equal(hash(pkg),hash(prepare({plan,pdfSha256,before:pkg.before})),'Reviewed package changed');
    verifyState(actual,pkg,{complete:o['--mode']==='verify'});
    if(o['--mode']==='verify'){
      writePrivateJson(o['--private-output'],{verified_at:new Date().toISOString(),variants:actual.existingVariants.map(t=>({id:t.id_tratamiento,code:t.codigo})),
        programs:actual.programs.filter(p=>pkg.programs.some(s=>s.before.id===p.id)).map(p=>({id:p.public_id,version:p.version_number,status:p.status})),policy:pkg.policy});
      return {status:'verified_read_only',variants:3,programs:3,writes:0};
    }
    assert.equal(o['--approved-sha256'],pkg.package_sha256);assert(Number.isFinite(Date.parse(prepared_at))&&Date.now()-Date.parse(prepared_at)<7200000&&Date.parse(prepared_at)<=Date.now());
    assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'','Commit the operator before writing');
    const backup=privateJson(o['--backup-manifest']);assert.equal(backup.database_target,'crm');
    assert(backup.full_gzip_verified&&backup.dump_completion_verified&&Number.isFinite(Date.parse(backup.generated_at))&&Date.now()-Date.parse(backup.generated_at)<7200000);
    await validateBackup(o['--backup-manifest']);
    await acquireExecutorLocks(c,pkg.package_sha256,o['--private-journal']);journal=openJournal(o['--private-journal'],pkg.package_sha256);
    await journal.append({stage:'verified_before',baseline,package_sha256:pkg.package_sha256});
    browser=await require('puppeteer-core').connect({browserURL:'http://127.0.0.1:9227',defaultViewport:null});
    const page=(await browser.pages()).find(p=>p.url().startsWith('https://crm.clinicaclick.com/')&&!p.url().includes('/sign-in'));assert(page,'Normal CRM session required');
    const call=async(route,method,payload)=>{
      await journal.append({stage:'request_intent',route,method,payload_sha256:hash(payload)});
      const r=await page.evaluate(async({route,method,payload})=>{
        const response=await fetch('/api/'+route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('accessToken')},body:JSON.stringify(payload)});
        return {status:response.status,body:await response.json()};
      },{route,method,payload});
      await journal.append({stage:'request_returned',route,status:r.status});assert([200,201].includes(r.status),'API rejected request; review journal, never blind retry');return r;
    };
    let created=0,updated=0;
    for(const variant of pkg.variants){
      const state=await capture(c);verifyState(state,pkg);
      if(state.existingVariants.some(t=>t.codigo===variant.payload.codigo))continue;
      await call('tratamientos','POST',variant.payload);
      verifyState(await capture(c),pkg);created++;
    }
    for(const program of pkg.programs){
      const state=await capture(c);verifyState(state,pkg);
      const row=state.programs.find(p=>p.id===program.before.id);
      if(row.version_number===program.before.version_number+1)continue;
      const response=await call(`treatment-programs/${program.before.public_id}?clinic_id=66`,'PATCH',programUpdate(program,state.existingVariants));
      assert.equal(response.body.item.purchase_enabled,false);assert.equal(response.body.item.status,'draft');
      verifyState(await capture(c),pkg);updated++;
    }
    const independent=await connectOperatorDatabase('crm');
    try{await independent.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');verifyState(await capture(independent),pkg,{complete:true});
      assert.equal(hash(await protectedRows(independent)),hash(baseline),'Protected data changed; inspect, do not restore');await independent.rollback();
    }finally{await independent.end();}
    const result={status:'applied_and_verified',created,updated,protected_tables_unchanged:true,policy:pkg.policy};
    await journal.append({stage:'independent_read_verified',result});writePrivateJson(o['--private-output'],result);return result;
  }finally{browser?.disconnect();journal?.close();await c.end();}
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('CAPILLARY_VARIANTS_STOPPED_REVIEW_JOURNAL');process.exitCode=1;});
module.exports={capture,verifyState,run};
