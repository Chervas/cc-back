#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {hash}=require('../lib/cliniccloud-import/adapter');
const {parseArgs,readBytes,writePrivateJson}=require('../lib/cliniccloud-import/io');
const {connectOperatorDatabase}=require('../lib/cliniccloud-import/operator-database');
const {prepare,verifyState,verifyProgram,CODE}=require('../lib/cliniccloud-import/contorno-program-variant');
const {SOURCES}=require('../lib/cliniccloud-import/corporal-program-drafts');
const {privateJson,openJournal,acquireExecutorLocks}=require('./cliniccloud-import-appointments-apply');
const {validateBackup}=require('./cliniccloud-import-contacts-apply');

async function capture(c) {
  const state=await require('./cliniccloud-import-corporal-program-profiles').capture(c);
  state.treatments=state.treatments.filter(t=>t.codigo!==CODE);
  state.existingVariants=(await c.query('SELECT * FROM Tratamientos WHERE codigo=? ORDER BY id_tratamiento',[CODE]))[0];
  return state;
}
async function protectedRows(c) {
  const result={};
  for(const [key,sql]of Object.entries({
    appointments:"SELECT * FROM CitasPacientes WHERE clinica_id IN (66,72) ORDER BY id_cita",
    requirements:'SELECT * FROM TreatmentConsentRequirements WHERE clinica_id IN (66,72) ORDER BY id',
  })) {const [rows]=await c.query(sql);result[key]={count:rows.length,sha256:hash(rows)};}
  return result;
}
async function run(args) {
  const o=parseArgs(args,['--mode','--target','--plan','--workbook','--archive','--package','--private-output','--approved-sha256','--backup-manifest','--private-journal']);
  assert.equal(o['--target'],'crm');assert(['prepare','apply','verify'].includes(o['--mode']));
  assert.equal(process.cwd(),'/home/ubuntu/wt/back-dev');assert.equal(execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),'dev');
  const plan=privateJson(o['--plan']);assert.equal(hash(readBytes(o['--workbook'])),plan.workbook_sha256);
  const sourceHashes=JSON.parse(execFileSync('python3',['-c',
    'import sys,zipfile,hashlib,json; z=zipfile.ZipFile(sys.argv[1]); out={};\nfor n in json.loads(sys.argv[2]):\n a=[i for i in z.infolist() if i.filename==n]; assert len(a)==1 and a[0].file_size<10485760; out[n]=hashlib.sha256(z.read(a[0])).hexdigest()\nprint(json.dumps(out))',
    o['--archive'],JSON.stringify(Object.keys(SOURCES))],{encoding:'utf8',timeout:30000}));
  const c=await connectOperatorDatabase('crm');let browser,journal;
  try{
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const actual=await capture(c),baseline=await protectedRows(c);await c.rollback();
    if(o['--mode']==='prepare'){
      const pkg=prepare({plan,sourceHashes,before:actual});
      writePrivateJson(o['--private-output'],{prepared_at:new Date().toISOString(),...pkg});
      return {status:'prepared',variants:1,programs:1,package_sha256:pkg.package_sha256,writes:0};
    }
    const {prepared_at,...pkg}=privateJson(o['--package']);
    assert.equal(hash(pkg),hash(prepare({plan,sourceHashes,before:pkg.before})),'Reviewed package changed');
    verifyState(actual,pkg,{complete:o['--mode']==='verify'});
    if(o['--mode']==='verify'){
      for(const program of pkg.programs){
        const [rows]=await c.query('SELECT snapshot FROM TreatmentProgramRevisions WHERE program_id=? AND version_number=2',[program.before.id]);
        assert.equal(rows.length,1);verifyProgram(rows[0].snapshot,program,actual.existingVariants);
      }
      writePrivateJson(o['--private-output'],{verified_at:new Date().toISOString(),variants:actual.existingVariants.map(t=>({id:t.id_tratamiento,code:t.codigo})),
        programs:actual.programs.filter(p=>pkg.programs.some(s=>s.before.id===p.id)).map(p=>({id:p.public_id,version:p.version_number,status:p.status})),policy:pkg.policy});
      return {status:'verified_read_only',variants:1,programs:1,writes:0};
    }
    assert.equal(o['--approved-sha256'],pkg.package_sha256);assert(Number.isFinite(Date.parse(prepared_at))&&Date.now()-Date.parse(prepared_at)<7200000&&Date.parse(prepared_at)<=Date.now());
    assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'','Commit the operator before writing');
    const backup=privateJson(o['--backup-manifest']);assert.equal(backup.database_target,'crm');
    assert(backup.full_gzip_verified&&backup.dump_completion_verified&&Number.isFinite(Date.parse(backup.generated_at))&&Date.now()-Date.parse(backup.generated_at)<7200000&&Date.parse(backup.generated_at)<=Date.now());
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
    const {programUpdate}=require('../lib/cliniccloud-import/contorno-program-variant');
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
      const response=await call(`treatment-programs/${program.before.public_id}?clinic_id=72`,'PATCH',programUpdate(program,state.existingVariants));
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
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('CONTORNO_VARIANT_STOPPED_REVIEW_JOURNAL');process.exitCode=1;});
module.exports={capture,verifyState,run};
