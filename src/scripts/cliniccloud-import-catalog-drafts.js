#!/usr/bin/env node
'use strict';
// Operator-only import. No application models/hooks/providers or workflow events.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { prepareDraftPackage, verifyDraftPackage, BATCH } = require('../lib/cliniccloud-import/catalog-drafts');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
async function capture(c, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [clinics] = await c.query('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica' + suffix);
  if (clinics.length !== 2 || clinics.some(r => Number(r.grupoClinicaId) !== 29)) throw Error('CATALOG_GROUP_CHANGED');
  const [triggers] = await c.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='Tratamientos'");
  if (triggers.length) throw Error('CATALOG_TRIGGERS_REQUIRE_REVIEW');
  // Include any colliding source code outside the group too; never duplicate it.
  const [treatments] = await c.query("SELECT * FROM Tratamientos WHERE clinica_id IN (66,72) OR codigo LIKE 'BS26-%' ORDER BY id_tratamiento" + suffix);
  const [installations] = await c.query('SELECT id,clinica_id,activo FROM Instalaciones WHERE clinica_id IN (66,72) ORDER BY id' + suffix);
  const [professionals] = await c.query('SELECT id,doctor_id,clinica_id,activo,recibe_citas FROM DoctorClinicas WHERE clinica_id IN (66,72) ORDER BY id' + suffix);
  return { treatments, installations, professionals };
}
function verifyResources(values, current) {
  for (const phase of values.clinical_config.booking_profile?.phases || []) {
    for (const id of phase.installation_ids) if (!current.installations.some(r => r.id === id && r.clinica_id === values.clinica_id)) throw Error('CATALOG_ROOM_SCOPE_CHANGED');
    for (const id of phase.professionals.ids) if (current.professionals.filter(r => r.doctor_id === id && r.clinica_id === values.clinica_id).length !== 1) throw Error('CATALOG_STAFF_SCOPE_CHANGED');
  }
}
function verifySources(o, plan) {
  for (const [option, field] of [['--workbook','workbook_sha256'],['--client-replies','replies_sha256']]) {
    if (!o[option] || hash(readBytes(o[option])) !== plan[field]) throw Error('CATALOG_SOURCE_CHANGED');
  }
  if (!o['--resource-map'] || hash(privateJson(o['--resource-map'])) !== plan.resource_map_sha256) throw Error('CATALOG_RESOURCE_MAP_CHANGED');
}
async function insertDraft(c, op, packageHash) {
  const values = { ...op.values, clinical_config: { ...op.values.clinical_config, catalog_import_package:packageHash } };
  const columns = Object.keys(values);
  // Column names come exclusively from treatmentDraft, never CLI input.
  const [result] = await c.query(`INSERT INTO Tratamientos (${columns.join(',')},createdAt,updatedAt) VALUES (${columns.map(()=>'?').join(',')},UTC_TIMESTAMP(),UTC_TIMESTAMP())`,
    columns.map(key => values[key] !== null && typeof values[key] === 'object' ? JSON.stringify(values[key]) : values[key]));
  if (result.affectedRows !== 1 || !Number.isSafeInteger(Number(result.insertId))) throw Error('CATALOG_INSERT_FAILED');
  return { id:Number(result.insertId), code:values.codigo, values };
}
async function run(args) {
  const o = parseArgs(args, ['--mode','--target','--plan','--workbook','--client-replies','--resource-map',
    '--private-output','--package','--approved-sha256','--backup-manifest','--private-journal']);
  if (o['--target'] !== 'crm' || !['prepare','apply'].includes(o['--mode'])) throw Error('EXPLICIT_CRM_CATALOG_MODE_REQUIRED');
  if (process.cwd() !== '/home/ubuntu/wt/back-dev' || path.resolve(__dirname,'../..') !== process.cwd()
    || execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim() !== 'dev') throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
  const plan = privateJson(o['--plan']); verifySources(o, plan);
  const c = await connectOperatorDatabase('crm'); let journal, commitAttempted = false;
  try {
    if (o['--mode'] === 'prepare') {
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const before = await capture(c); const pkg = prepareDraftPackage({ plan, before });
      for (const op of pkg.operations) verifyResources(op.values, before);
      await c.rollback(); writePrivateJson(o['--private-output'], pkg);
      return { status: 'prepared', proposed: pkg.operations.length, preserved: pkg.preserved.length,
        prepared_profiles: pkg.operations.filter(op => op.values.clinical_config.booking_profile).length, package_sha256: pkg.package_sha256 };
    }
    const pkg = privateJson(o['--package']); verifyDraftPackage(pkg, plan);
    if (o['--approved-sha256'] !== pkg.package_sha256 || !Number.isFinite(Date.parse(pkg.created_at))
      || Date.now() - Date.parse(pkg.created_at) > 2*3600000 || Date.parse(pkg.created_at)>Date.now()) throw Error('FRESH_CATALOG_APPROVAL_REQUIRED');
    const manifest = privateJson(o['--backup-manifest']);
    if (manifest.database_target !== 'crm' || !manifest.full_gzip_verified || !manifest.dump_completion_verified) throw Error('CATALOG_VERIFIED_BACKUP_REQUIRED');
    const backup = await validateBackup(o['--backup-manifest']);
    await acquireExecutorLocks(c, pkg.package_sha256, path.resolve(o['--private-journal']));
    journal = openJournal(o['--private-journal'], pkg.package_sha256);
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await c.beginTransaction();
    const before = await capture(c, true);
    const replay = pkg.operations.map(op => before.treatments.filter(t => t.codigo === op.values.codigo));
    if (pkg.operations.length && replay.every(rows => rows.length === 1)) {
      for (let i=0;i<replay.length;i++) {
        const row = replay[i][0], config = typeof row.clinical_config === 'string' ? JSON.parse(row.clinical_config) : row.clinical_config;
        if (config?.import_batch !== BATCH || config?.catalog_import_package !== pkg.package_sha256
          || row.clinica_id !== pkg.operations[i].values.clinica_id) throw Error('CATALOG_REPLAY_SOURCE_CONFLICT');
      }
      await c.rollback(); await journal.append({ stage: 'replay_preserved', count: replay.length });
      return { status:'replay_preserved', created:0, preserved:replay.length+pkg.preserved.length, reminders_activated:false };
    }
    if (hash(before) !== pkg.before_sha256) throw Error('CATALOG_STATE_DRIFT_REPREPARE');
    for (const op of pkg.operations) verifyResources(op.values, before);
    await journal.append({ stage:'prepared', backup, before, operations:pkg.operations, operator:'codex-authorized-cliniccloud-import' });
    const inserted = [];
    for (const op of pkg.operations) inserted.push(await insertDraft(c, op, pkg.package_sha256));
    const after = await capture(c);
    if (hash({ ...after, treatments:after.treatments.filter(r=>!inserted.some(i=>i.id===r.id_tratamiento)) }) !== pkg.before_sha256) throw Error('CATALOG_UNRELATED_ROW_CHANGED');
    for (const row of inserted) {
      const saved = after.treatments.find(t=>t.id_tratamiento===row.id);
      if (!saved) throw Error('CATALOG_POST_WRITE_MISMATCH');
      const actual = Object.fromEntries(Object.keys(row.values).map(key=>[key,
        key==='clinical_config' && typeof saved[key]==='string' ? JSON.parse(saved[key]) : saved[key]]));
      if (hash(actual)!==hash(row.values)) throw Error('CATALOG_POST_WRITE_MISMATCH');
    }
    await journal.append({ stage:'written_before_commit', inserted, after_sha256:hash(after) });
    commitAttempted=true; await c.commit(); await journal.append({ stage:'committed', inserted, after_sha256:hash(after) });
    return { status:'committed', created:inserted.length, preserved:pkg.preserved.length, active_created:0, reminders_activated:false };
  } catch(e) { await c.rollback().catch(()=>{}); if(commitAttempted)throw Error('CATALOG_COMMIT_RESULT_REQUIRES_JOURNAL_REVIEW'); throw e; }
  finally { journal?.close(); await c.end(); }
}
if(require.main===module)run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{
  console.error(/^[A-Z_]+$/.test(e.message)?e.message:'CATALOG_IMPORT_FAILED_REVIEW_PRIVATE_JOURNAL');process.exitCode=1;
});
module.exports={run,capture,verifyResources,verifySources,insertDraft};
