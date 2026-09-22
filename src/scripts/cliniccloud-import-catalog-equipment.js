#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { privateJson, openJournal, acquireExecutorLocks } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
const { prepareCatalogEquipment, verifyCatalogEquipment, equipmentConfig, equipmentReplay } = require('../lib/cliniccloud-import/catalog-equipment');

async function capture(c, ids, lock = false) {
  const result = {}, suffix = lock ? ' FOR UPDATE' : '';
  for (const [key, query, params] of [
    ['clinics', 'SELECT id_clinica,grupoClinicaId,equipment_booking_enabled FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica', []],
    ['units', 'SELECT * FROM BookingEquipment WHERE group_id=29 ORDER BY id', []],
    ['shares', 'SELECT * FROM BookingEquipmentClinics WHERE clinic_id IN (66,72) ORDER BY equipment_id,clinic_id', []],
    ['rooms', 'SELECT id,clinica_id,activo,capacidad FROM Instalaciones WHERE clinica_id IN (66,72) ORDER BY id', []],
    ['aliases', 'SELECT * FROM InstallationPhysicalAliases WHERE group_id=29 ORDER BY installation_id', []],
    ['policies', 'SELECT p.* FROM BookingEquipmentRoomPolicies p INNER JOIN Instalaciones i ON i.id=p.installation_id WHERE i.clinica_id IN (66,72) ORDER BY p.installation_id', []],
    ['treatments', 'SELECT * FROM Tratamientos WHERE id_tratamiento IN (?) ORDER BY id_tratamiento', [ids]],
  ]) result[key] = (await c.query(query + suffix, params))[0];
  return result;
}

async function execute({ c, pkg, journal, rehearse = false }) {
  let commitAttempted = false;
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await c.beginTransaction();
    const ids = pkg.operations.map(op => op.id), before = await capture(c, ids, true);
    if (pkg.operations.every(op => equipmentReplay(before.treatments.find(t => t.id_tratamiento === op.id), op, pkg))) {
      await c.rollback(); await journal.append({ stage: 'catalog_equipment_replay', count: ids.length });
      return { status: 'replay_preserved', updated: 0, replayed: ids.length };
    }
    if (hash(before) !== pkg.before_sha256) throw Error('CATALOG_EQUIPMENT_STATE_DRIFT');
    await journal.append({ stage: 'catalog_equipment_before', before, operations: pkg.operations });
    for (const op of pkg.operations) {
      const [r] = await c.query('UPDATE Tratamientos SET clinical_config=?,updatedAt=UTC_TIMESTAMP() WHERE id_tratamiento=? AND activo=0',
        [JSON.stringify(equipmentConfig(op, pkg)), op.id]);
      if (r.affectedRows !== 1) throw Error('CATALOG_EQUIPMENT_WRITE_MISMATCH');
    }
    const after = await capture(c, ids);
    if (!pkg.operations.every(op => equipmentReplay(after.treatments.find(t => t.id_tratamiento === op.id), op, pkg))
      || hash({ ...after, treatments: before.treatments }) !== hash(before)) throw Error('CATALOG_EQUIPMENT_AFTER_MISMATCH');
    await journal.append({ stage: 'catalog_equipment_written', after });
    if (rehearse) {
      await c.rollback();
      if (hash(await capture(c, ids)) !== hash(before)) throw Error('CATALOG_EQUIPMENT_ROLLBACK_MISMATCH');
    } else { commitAttempted = true; await c.commit(); }
    await journal.append({ stage: rehearse ? 'catalog_equipment_rolled_back' : 'catalog_equipment_committed', updated: ids.length });
    return { status: rehearse ? 'rehearsed_and_rolled_back' : 'committed', updated: rehearse ? 0 : ids.length,
      rehearsed: rehearse ? ids.length : 0, active_changed: 0, prices_changed: 0, appointments_changed: 0, reminders_activated: false };
  } catch (error) {
    await c.rollback().catch(() => {});
    if (commitAttempted) throw Error('CATALOG_EQUIPMENT_COMMIT_REQUIRES_JOURNAL_REVIEW');
    throw error;
  }
}
async function run(args) {
  const o = parseArgs(args, ['--target', '--mode', '--review', '--private-output', '--package', '--approved-sha256', '--backup-manifest', '--private-journal']);
  if (o['--target'] !== 'crm' || !['prepare', 'rehearse', 'apply'].includes(o['--mode'])) throw Error('EXPLICIT_CRM_EQUIPMENT_MODE_REQUIRED');
  if (process.cwd() !== '/home/ubuntu/wt/back-dev' || path.resolve(__dirname, '../..') !== process.cwd()
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev') throw Error('DEV_OPERATOR_WORKTREE_REQUIRED');
  const review = privateJson(o['--review']);
  if (!Array.isArray(review.targets) || !review.targets.length || review.targets.length > 20
    || review.targets.some(t => !Number.isSafeInteger(t.treatment_id) || t.treatment_id < 1)) throw Error('CATALOG_EQUIPMENT_TARGETS_INVALID');
  let pkg;
  if (o['--mode'] !== 'prepare') {
    pkg = privateJson(o['--package']); verifyCatalogEquipment(pkg, review);
    if (pkg.package_sha256 !== o['--approved-sha256'] || Date.parse(pkg.created_at) > Date.now()
      || Date.now() - Date.parse(pkg.created_at) > 7200000) throw Error('FRESH_EQUIPMENT_REVIEW_REQUIRED');
    const backup = privateJson(o['--backup-manifest']);
    if (backup.database_target !== 'crm' || !backup.full_gzip_verified || !backup.dump_completion_verified) throw Error('EQUIPMENT_VERIFIED_BACKUP_REQUIRED');
    await validateBackup(o['--backup-manifest']);
  }
  const c = await connectOperatorDatabase('crm'); let journal;
  try {
    if (o['--mode'] === 'prepare') {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const before = await capture(c, review.targets.map(t => t.treatment_id));
      pkg = prepareCatalogEquipment({ before, review });
      await c.rollback(); writePrivateJson(o['--private-output'], pkg);
      return { status: 'prepared', proposed: pkg.operations.length, package_sha256: pkg.package_sha256, writes: 0 };
    }
    await acquireExecutorLocks(c, pkg.package_sha256, path.resolve(o['--private-journal']));
    const [triggers] = await c.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='Tratamientos'");
    if (triggers.length) throw Error('CATALOG_EQUIPMENT_TRIGGER_REVIEW_REQUIRED');
    journal = openJournal(o['--private-journal'], pkg.package_sha256);
    return await execute({ c, pkg, journal, rehearse: o['--mode'] === 'rehearse' });
  } finally { journal?.close(); await c.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(r => console.log(JSON.stringify(r))).catch(e => {
  console.error(/^[A-Z_]+$/.test(e.message) ? e.message : 'CATALOG_EQUIPMENT_FAILED_REVIEW_PRIVATE_JOURNAL'); process.exitCode = 1;
});
module.exports = { capture, execute, run };
