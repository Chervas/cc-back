#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { prepare, verifyPackage, verifyAfter } = require('../lib/cliniccloud-import/catalog-simple-activation');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');

async function capture(c, review, lock = false) {
  const ids = review?.bindings?.map(b => b.id);
  if (!ids?.length || ids.length > 30 || ids.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(ids).size !== ids.length) throw Error('CATALOG_ACTIVATION_SCOPE_INVALID');
  const suffix = lock ? ' FOR UPDATE' : '';
  const select = async (sql, args = []) => (await c.query(sql + suffix, args))[0];
  const clinics = await select('SELECT id_clinica,grupoClinicaId AS grupo_clinica_id FROM Clinicas WHERE id_clinica=72');
  const treatments = await select('SELECT * FROM Tratamientos WHERE id_tratamiento IN (?) ORDER BY id_tratamiento', [ids]);
  const profiles = treatments.map(t => t.clinical_config?.booking_profile);
  const roomIds = [...new Set(profiles.flatMap(p => p?.phases?.flatMap(p => p.installation_ids) || []))];
  const doctorIds = [...new Set(profiles.flatMap(p => p?.phases?.flatMap(p => p.professionals.ids) || []))];
  if (!roomIds.length || !doctorIds.length || roomIds.length > 30 || doctorIds.length > 30) throw Error('CATALOG_ACTIVATION_RESOURCES_PENDING');
  const rooms = await select('SELECT * FROM Instalaciones WHERE id IN (?) ORDER BY id', [roomIds]);
  const staff = await select('SELECT * FROM DoctorClinicas WHERE doctor_id IN (?) AND clinica_id=72 ORDER BY id', [doctorIds]);
  const room_hours = await select('SELECT * FROM InstalacionHorarios WHERE instalacion_id IN (?) ORDER BY id', [roomIds]);
  const staff_hours = staff.length ? await select('SELECT * FROM DoctorHorarios WHERE doctor_clinica_id IN (?) ORDER BY id', [staff.map(s => s.id)]) : [];
  const requirements = await select('SELECT * FROM TreatmentConsentRequirements WHERE tratamiento_id IN (?) ORDER BY id', [ids]);
  const templateIds = [...new Set(requirements.map(r => r.clinic_template_id).filter(Boolean))];
  const templates = templateIds.length ? await select('SELECT * FROM ClinicConsentTemplates WHERE id IN (?) ORDER BY id', [templateIds]) : [];
  const versions = templateIds.length ? await select('SELECT * FROM ClinicConsentTemplateVersions WHERE clinic_template_id IN (?) ORDER BY id', [templateIds]) : [];
  const appointments = await select('SELECT id_cita,tratamiento_id FROM CitasPacientes WHERE tratamiento_id IN (?) ORDER BY id_cita', [ids]);
  return { clinics, treatments, rooms, staff, room_hours, staff_hours, requirements, templates, versions, appointments };
}

async function execute({ c, pkg, journal, dryRun = false }) {
  let commitAttempted = false;
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await c.beginTransaction();
    const before = await capture(c, pkg.review, true);
    if (hash(before) !== pkg.before_sha256) {
      verifyAfter(before, pkg); await c.rollback();
      await journal.append({ stage: 'activation_replay_preserved', activated: 0 });
      return { status: 'replay_preserved', activated: 0 };
    }
    await journal.append({ stage: 'activation_before', before, operations: pkg.operations });
    for (const op of pkg.operations) {
      const [result] = await c.query('UPDATE Tratamientos SET activo=1,clinical_config=?,descripcion=?,updatedAt=UTC_TIMESTAMP() WHERE id_tratamiento=? AND activo=0',
        [JSON.stringify(op.after.clinical_config), op.after.descripcion, op.id]);
      if (result.affectedRows !== 1) throw Error('CATALOG_ACTIVATION_UPDATE_FAILED');
    }
    const after = await capture(c, pkg.review); verifyAfter(after, pkg);
    await journal.append({ stage: 'activation_verified_before_commit', after, after_sha256: hash(after) });
    if (dryRun) {
      await c.rollback();
      if (hash(await capture(c, pkg.review)) !== pkg.before_sha256) throw Error('CATALOG_ACTIVATION_ROLLBACK_MISMATCH');
      await journal.append({ stage: 'activation_dry_run_rolled_back' });
      return { status: 'rolled_back_and_verified', proposed: pkg.operations.length, activated: 0 };
    }
    commitAttempted = true; await c.commit();
    await journal.append({ stage: 'activation_committed', activated: pkg.operations.length });
    const independent = await connectOperatorDatabase('crm');
    try {
      await independent.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const actual = await capture(independent, pkg.review); verifyAfter(actual, pkg);
      if (hash(actual) !== hash(after)) throw Error('CATALOG_ACTIVATION_READBACK_MISMATCH');
      await independent.rollback();
      await journal.append({ stage: 'activation_independent_read_verified', after_sha256: hash(actual) });
    } finally { await independent.end(); }
    return { status: 'committed_and_verified', activated: pkg.operations.length, ...pkg.policy };
  } catch (error) {
    await c.rollback().catch(() => {});
    if (commitAttempted) throw Error('CATALOG_ACTIVATION_COMMIT_RESULT_REQUIRES_JOURNAL_REVIEW');
    throw error;
  }
}

async function run(args) {
  const o = parseArgs(args, ['--mode','--target','--plan','--workbook','--review','--package','--private-output',
    '--approved-sha256','--backup-manifest','--private-journal']);
  if (o['--target'] !== 'crm' || !['prepare','dry-run','apply','verify'].includes(o['--mode'])) throw Error('EXPLICIT_CATALOG_ACTIVATION_MODE_REQUIRED');
  if (process.cwd() !== '/home/ubuntu/wt/back-dev' || path.resolve(__dirname, '../..') !== process.cwd()
    || execFileSync('git', ['branch','--show-current'], { encoding:'utf8' }).trim() !== 'dev') throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
  const plan = privateJson(o['--plan']);
  if (hash(readBytes(o['--workbook'])) !== plan.workbook_sha256) throw Error('CATALOG_ACTIVATION_SOURCE_CHANGED');
  const c = await connectOperatorDatabase('crm'); let journal;
  try {
    if (o['--mode'] === 'prepare') {
      const review = privateJson(o['--review']);
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const before = await capture(c, review), pkg = prepare({ plan, review, before });
      await c.rollback(); writePrivateJson(o['--private-output'], pkg);
      return { status:'prepared', proposed:pkg.operations.length, package_sha256:pkg.package_sha256, writes:0 };
    }
    const pkg = privateJson(o['--package']); verifyPackage(pkg, plan);
    if (o['--mode'] === 'verify') {
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const after = await capture(c, pkg.review); verifyAfter(after, pkg); await c.rollback();
      writePrivateJson(o['--private-output'], { verified_at:new Date().toISOString(), package_sha256:pkg.package_sha256, after_sha256:hash(after), after, policy:pkg.policy });
      return { status:'verified_read_only', treatments:after.treatments.length };
    }
    if (o['--approved-sha256'] !== pkg.package_sha256 || !Number.isFinite(Date.parse(pkg.created_at))
      || Date.now()-Date.parse(pkg.created_at)>7200000 || Date.parse(pkg.created_at)>Date.now()) throw Error('FRESH_CATALOG_ACTIVATION_REVIEW_REQUIRED');
    for (const filename of ['/home/ubuntu/wt/back-staging/.env','/home/ubuntu/wt/gateway/.env']) {
      const env = require('dotenv').parse(fs.readFileSync(filename));
      if (env.BOOKING_PROFILES_ENABLED !== 'true' || env.BOOKING_MULTI_RESOURCE_ENABLED !== 'true') throw Error('CATALOG_ACTIVATION_RUNTIME_NOT_READY');
    }
    const manifest = privateJson(o['--backup-manifest']);
    if (manifest.database_target !== 'crm' || !manifest.full_gzip_verified || !manifest.dump_completion_verified
      || Date.now()-Date.parse(manifest.generated_at)>7200000 || !Number.isFinite(Date.parse(manifest.generated_at))) throw Error('CATALOG_ACTIVATION_FRESH_BACKUP_REQUIRED');
    await validateBackup(o['--backup-manifest']);
    await acquireExecutorLocks(c, pkg.package_sha256, path.resolve(o['--private-journal']));
    journal = openJournal(o['--private-journal'], pkg.package_sha256);
    await journal.append({ stage:'activation_inputs_verified', mode:o['--mode'], backup_manifest_sha256:hash(readBytes(o['--backup-manifest'])) });
    return await execute({ c, pkg, journal, dryRun:o['--mode']==='dry-run' });
  } finally { journal?.close(); await c.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{
  console.error(/^[A-Z_]+$/.test(e.message)?e.message:'CATALOG_ACTIVATION_FAILED_REVIEW_PRIVATE_JOURNAL'); process.exitCode=1;
});
module.exports = { capture, execute, run };
