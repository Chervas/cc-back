#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { SINCE, prepare, verifyPackage, verifyAfter, referencedTreatmentIds } = require('../lib/cliniccloud-import/catalog-retirement');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
// Launch week starts at midnight Europe/Madrid, two hours ahead of stored UTC.
const APPOINTMENT_START_UTC = '2026-09-20 22:00:00';

const directReferences = [
  ['AdminCampaignPlaybooks','treatment_id'],['AppointmentClinicalReports','treatment_id'],
  ['AppointmentFlowInstances','tratamiento_id'],['AutomationFlows','tratamiento_id'],
  ['CampaignDestinationBindings','treatment_id'],['CampaignDestinationBindings','treatment_identity'],
  ['ConsentSignaturePackages','tratamiento_id'],['ConsentTemplateCatalogTreatments','tratamiento_id'],
  ['DependenciaTratamiento','id_tratamiento_destino'],['DependenciaTratamiento','id_tratamiento_origen'],
  ['ExternalCampaignAssignments','target_treatment_id'],['MarketingPatientListItems','treatment_id'],
  ['PatientConsentDocuments','tratamiento_id'],['PatientConsentExternalAttestations','tratamiento_id'],
  ['PatientFollowUps','treatment_id'],['PatientNutritionMeasurements','treatment_id'],
  ['PatientNutritionReports','treatment_id'],['PatientVouchers','treatment_id'],
  ['Tratamientos','id_tratamiento_base'],['TreatmentConsentRequirements','tratamiento_id'],
];
const snapshots = [
  ['EconomicBudgetVersions','lines'],['EconomicBudgetSignatureRequests','snapshot_json'],
  ['PatientProgramSessions','snapshot'],['TreatmentPrograms','appointments'],
  ['TreatmentProgramRevisions','snapshot'],['Instalaciones','tratamientos_exclusivos'],
  ['TreatmentProtocols','treatment_ids'],
];

function readSource(filename) {
  const data = execFileSync('python3',['-c',
    "import sys,json,zipfile,csv,io\nwith zipfile.ZipFile(sys.argv[1]) as z:\n rows=csv.DictReader(io.StringIO(z.read('BACKUP_CITAS_2026-09-01_2026-12-31.csv').decode('utf-8-sig')),delimiter=';')\n services=sorted({r['SERVICIOS'].strip() for r in rows if r['FECHA']>=sys.argv[2] and r['SERVICIOS'].strip()})\n print(json.dumps(services))", filename,SINCE],{encoding:'utf8',maxBuffer:1024*1024});
  return { since:SINCE, zip_sha256:hash(readBytes(filename)), services:JSON.parse(data) };
}

async function capture(c, lock = false) {
  // Canonical booking takes SHARE on its clinic. Take both clinics first so
  // the candidate snapshot includes earlier completed reservations.
  const clinics = (await c.query('SELECT id_clinica,grupoClinicaId AS grupo_clinica_id FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica'+(lock?' FOR UPDATE':'')))[0];
  const treatments = (await c.query("SELECT * FROM Tratamientos WHERE clinica_id IN (66,72) AND codigo LIKE 'CCLOUD-%' ORDER BY id_tratamiento"+(lock?' FOR UPDATE':'')))[0];
  if (!treatments.length || treatments.length>250) throw Error('RETIREMENT_SCOPE_INVALID');
  const ids = treatments.map(t=>t.id_tratamiento), candidates = new Set(ids), references = [], dependency_hashes = {};
  // Fail closed if the schema gains another direct treatment consumer.
  const columns = (await c.query("SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND DATA_TYPE IN ('int','bigint') AND (LOWER(COLUMN_NAME) LIKE '%tratamiento%' OR LOWER(COLUMN_NAME) LIKE '%treatment%') ORDER BY TABLE_NAME,COLUMN_NAME"))[0];
  const known = new Set([...directReferences.map(r=>r.join('.')),'Tratamientos.id_tratamiento','CitasPacientes.tratamiento_id']);
  if (columns.length!==known.size || columns.some(r=>!known.has(r.TABLE_NAME+'.'+r.COLUMN_NAME))) throw Error('RETIREMENT_REFERENCE_SCHEMA_CHANGED');
  const appointments = (await c.query('SELECT * FROM CitasPacientes WHERE clinica_id IN (66,72) OR tratamiento_id IN (?) ORDER BY id_cita',[ids]))[0];
  dependency_hashes.appointments = hash(appointments);
  const usage = new Map();
  const sourceIds = new Map(treatments.map(t => [String(t.clinical_config?.raw?.idServicio), t.id_tratamiento]));
  for (const row of appointments) {
    if (candidates.has(row.tratamiento_id)) {
      const item = usage.get(row.tratamiento_id) || { treatment_id:row.tratamiento_id,count:0,recent_count:0 };
      item.count++; if(String(row.inicio)>=APPOINTMENT_START_UTC)item.recent_count++;
      usage.set(row.tratamiento_id,item);
    }
    if (String(row.inicio)>=APPOINTMENT_START_UTC) {
      for(const id of referencedTreatmentIds(row.import_metadata,candidates)) references.push({kind:'appointment_snapshot',treatment_id:id});
      // Imported rows can still lack a local treatment while retaining the
      // exact external service ID. Protect that provenance as well.
      const metadata = typeof row.import_metadata==='string'?JSON.parse(row.import_metadata):row.import_metadata;
      for(const external of [metadata?.source_service_id,metadata?.raw?.idServicio].filter(v=>v!=null)) {
        const id=sourceIds.get(String(external));if(id)references.push({kind:'appointment_source_service',treatment_id:id});
      }
    }
  }
  for (const [table,column] of directReferences) {
    const rows = (await c.query(`SELECT * FROM \`${table}\` WHERE \`${column}\` IN (?)`,[ids]))[0];
    // Stable independently of server iteration order; full row hashes preserve
    // historical documents, voucher balances and config without copying PII.
    dependency_hashes[table+'.'+column] = hash(rows.map(hash).sort());
    for(const id of new Set(rows.map(r=>r[column])))references.push({kind:table,treatment_id:Number(id)});
  }
  for (const [table,column] of snapshots) {
    const rows = (await c.query(`SELECT id,\`${column}\` AS payload FROM \`${table}\` WHERE \`${column}\` IS NOT NULL ORDER BY id`))[0];
    const matching=[];
    for(const row of rows){
      const payload = typeof row.payload==='string'?JSON.parse(row.payload):row.payload;
      const wrapped = ['tratamientos_exclusivos','treatment_ids'].includes(column)?{treatment_ids:payload}:payload;
      const found = referencedTreatmentIds(wrapped,candidates);
      if(found.length){matching.push({id:row.id,sha256:hash(payload)});for(const id of found)references.push({kind:table+'.'+column,treatment_id:id});}
    }
    dependency_hashes[table+'.'+column]=hash(matching);
  }
  const unique = [...new Map(references.map(r=>[r.kind+':'+r.treatment_id,r])).values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.treatment_id-b.treatment_id);
  return {clinics,treatments,appointment_usage:[...usage.values()].sort((a,b)=>a.treatment_id-b.treatment_id),references:unique,dependency_hashes};
}

async function execute({c,pkg,journal,dryRun=false,independentFactory=()=>connectOperatorDatabase('crm')}) {
  let commitAttempted=false;
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.beginTransaction();
    const before=await capture(c,true);
    if(hash(before)!==pkg.before_sha256){verifyAfter(before,pkg);await c.rollback();await journal.append({stage:'retirement_replay_preserved',retired:0});return{status:'replay_preserved',retired:0};}
    await journal.append({stage:'retirement_before',before,operations:pkg.operations});
    for(const op of pkg.operations){
      const [result]=await c.query('UPDATE Tratamientos SET activo=0,clinical_config=?,updatedAt=UTC_TIMESTAMP() WHERE id_tratamiento=? AND activo=1',[JSON.stringify(op.after.clinical_config),op.id]);
      if(result.affectedRows!==1)throw Error('RETIREMENT_UPDATE_FAILED');
    }
    const after=await capture(c);verifyAfter(after,pkg);await journal.append({stage:'retirement_verified_before_commit',after_sha256:hash(after)});
    if(dryRun){await c.rollback();if(hash(await capture(c))!==pkg.before_sha256)throw Error('RETIREMENT_ROLLBACK_MISMATCH');await journal.append({stage:'retirement_dry_run_rolled_back'});return{status:'rolled_back_and_verified',proposed:pkg.operations.length,retired:0};}
    commitAttempted=true;await c.commit();await journal.append({stage:'retirement_committed',retired:pkg.operations.length});
    const independent=await independentFactory();try{await independent.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const actual=await capture(independent);verifyAfter(actual,pkg);if(hash(actual)!==hash(after))throw Error('RETIREMENT_READBACK_MISMATCH');await independent.rollback();await journal.append({stage:'retirement_readback_verified',after_sha256:hash(actual)});}finally{await independent.end();}
    return{status:'committed_and_verified',retired:pkg.operations.length,retained:pkg.retained.length,...pkg.policy};
  }catch(error){await c.rollback().catch(()=>{});if(commitAttempted)throw Error('RETIREMENT_COMMIT_REQUIRES_JOURNAL_REVIEW');throw error;}
}

async function run(args) {
  const o=parseArgs(args,['--mode','--target','--source-zip','--package','--private-output','--approved-sha256','--backup-manifest','--private-journal']);
  if(o['--target']!=='crm'||!['prepare','dry-run','apply','verify'].includes(o['--mode']))throw Error('EXPLICIT_RETIREMENT_MODE_REQUIRED');
  if(process.cwd()!=='/home/ubuntu/wt/back-dev'||execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim()!=='dev')throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
  const source=readSource(o['--source-zip']),c=await connectOperatorDatabase('crm');let journal;
  try{
    if(o['--mode']==='prepare'){
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const before=await capture(c),pkg=prepare({before,source});await c.rollback();writePrivateJson(o['--private-output'],pkg);
      return{status:'prepared',retirable:pkg.operations.length,retained:pkg.retained.length,package_sha256:pkg.package_sha256,writes:0};
    }
    const pkg=privateJson(o['--package']);verifyPackage(pkg);if(hash(source)!==hash(pkg.source))throw Error('RETIREMENT_SOURCE_CHANGED');
    if(o['--mode']==='verify'){await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');const after=await capture(c);verifyAfter(after,pkg);await c.rollback();writePrivateJson(o['--private-output'],{verified_at:new Date().toISOString(),package_sha256:pkg.package_sha256,after_sha256:hash(after),after});return{status:'verified_read_only',retired:pkg.operations.length};}
    if(!pkg.operations.length||o['--approved-sha256']!==pkg.package_sha256||!Number.isFinite(Date.parse(pkg.created_at))||Date.now()-Date.parse(pkg.created_at)>7200000||Date.parse(pkg.created_at)>Date.now())throw Error('FRESH_RETIREMENT_APPROVAL_REQUIRED');
    if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())throw Error('RETIREMENT_CLEAN_WORKTREE_REQUIRED');
    const manifest=privateJson(o['--backup-manifest']);
    if(manifest.database_target!=='crm'||!manifest.full_gzip_verified||!manifest.dump_completion_verified||!Number.isFinite(Date.parse(manifest.generated_at))||Date.now()-Date.parse(manifest.generated_at)>7200000)throw Error('RETIREMENT_FRESH_BACKUP_REQUIRED');
    await validateBackup(o['--backup-manifest']);await acquireExecutorLocks(c,pkg.package_sha256,path.resolve(o['--private-journal']));
    journal=openJournal(o['--private-journal'],pkg.package_sha256);await journal.append({stage:'retirement_inputs_verified',mode:o['--mode'],backup_manifest_sha256:hash(readBytes(o['--backup-manifest']))});
    return await execute({c,pkg,journal,dryRun:o['--mode']==='dry-run'});
  }finally{journal?.close();await c.end();}
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'RETIREMENT_FAILED_REVIEW_PRIVATE_JOURNAL');process.exitCode=1;});
module.exports={directReferences,snapshots,readSource,capture,execute,run};
