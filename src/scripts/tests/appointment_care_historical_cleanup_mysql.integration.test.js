'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const load = require('./helpers/owned-historical-cleanup-module');
const care = require('../../lib/appointment-care');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  const CitaPaciente = require('../../../models/citapaciente')(sql, D);
  await CitaPaciente.sync();
  const qi = sql.getQueryInterface();
  await qi.createTable('Clinicas', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER });
  await qi.bulkInsert('Clinicas', [{ id_clinica: 1, grupoClinicaId: 5 }, { id_clinica: 2, grupoClinicaId: 6 }]);
  const start = new Date('2099-09-01T10:00:00Z');
  const common = { clinica_id: 1, paciente_id: 20, estado: 'ha_acudido', care_legacy_attendance: true,
    titulo: 'Histórico: prueba ficticia', motivo: 'Importación de pacientes para reactivación',
    inicio: start, fin: new Date(+start + 1800000),
    created_at: new Date('2026-09-01T09:00:00Z'), updated_at: new Date('2026-09-01T09:30:00Z'), created_by: 3, updated_by: 4,
    source_system: 'clinicaclick_reactivation_import', source_reference: 'synthetic', import_metadata: { automation_policy: 'hold' } };
  await CitaPaciente.bulkCreate([
    { ...common, id_cita: 101 },
    { ...common, id_cita: 102, inicio: new Date('2020-09-01T10:00:00Z'), fin: new Date('2020-09-01T10:30:00Z') },
    { ...common, id_cita: 103, care_legacy_attendance: false },
    { ...common, id_cita: 104, estado: 'completada', care_legacy_attendance: false,
      arrived_at: start, care_started_at: start, care_completed_at: new Date(+start + 1800000), care_completed_by: 4, care_schedule_start: start },
    { ...common, id_cita: 105, clinica_id: 2 }, { ...common, id_cita: 106, estado: 'pendiente' },
    { ...common, id_cita: 107, care_completed_at: start },
    { ...common, id_cita: 108, motivo: 'Cita normal' }, { ...common, id_cita: 109, titulo: 'Atención real' },
  ]);
  let attemptedHooks = 0;
  CitaPaciente.addHook('afterBulkCreate', () => { attemptedHooks++; throw Error('Communication hooks are forbidden'); });
  const backupDir = path.join(report.root, 'historical-cleanup');
  const logs = [];
  const cleanup = load({ db: { sequelize: sql, CitaPaciente }, backupDir, logs });
  const snapshot = async () => JSON.parse(JSON.stringify(await CitaPaciente.findAll({ raw: true, order: [['id_cita', 'ASC']] })));
  const before = await snapshot();
  assert.deepEqual((await cleanup.findTargets()).map(row => row.id_cita), [101]);
  assert.deepEqual((await cleanup.findTargets(null, false, true)).map(row => row.id_cita), [101, 102]);

  await qi.createTable('HistoricalReference', { id: { type: D.INTEGER, primaryKey: true },
    cita_id: { type: D.INTEGER, references: { model: 'CitasPacientes', key: 'id_cita' } } });
  await qi.bulkInsert('HistoricalReference', [{ id: 1, cita_id: 101 }]);
  await assert.rejects(cleanup.applyCleanup(), /cleanup_dependencies_found/);
  assert.deepEqual(await snapshot(), before);
  await sql.query('DELETE FROM HistoricalReference');

  await cleanup.applyCleanup();
  const deleted = await snapshot();
  assert.deepEqual(deleted, before.filter(row => row.id_cita !== 101));
  const files = fs.readdirSync(backupDir);
  assert.equal(files.length, 1);
  const backup = path.join(backupDir, files[0]);
  assert.equal(fs.statSync(backup).mode & 0o077, 0);
  const payload = JSON.parse(fs.readFileSync(backup, 'utf8'));
  assert.equal(payload.schema_version, 2);
  await cleanup.restoreBackup(backup);
  assert.deepEqual(await snapshot(), before, 'Exact restoration of new-format historical attendance');
  await assert.rejects(cleanup.restoreBackup(backup), /restore_conflict/);
  assert.deepEqual(await snapshot(), before);

  const legacy = { ...before[0], id_cita: 201, estado: 'completada' };
  delete legacy.care_legacy_attendance;
  delete legacy.care_completed_at;
  delete legacy.care_completed_by;
  const write = (name, rows) => {
    const file = path.join(backupDir, name);
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, rows }), { mode: 0o600 });
    return file;
  };
  await cleanup.restoreBackup(write('old-backup.json', [legacy]));
  const restored = (await snapshot()).find(row => row.id_cita === 201);
  assert.equal(restored.estado, 'ha_acudido');
  assert.equal(Number(restored.care_legacy_attendance), 1);
  assert.equal(restored.care_completed_at, null);
  assert.equal(restored.care_completed_by, null);
  for (const key of Object.keys(legacy).filter(key => key !== 'estado')) assert.deepEqual(restored[key], legacy[key], key);
  for (const trigger of ['appointment_after', 'appointment_completed', 'appointment_created', 'appointment_reminder_window', 'consent_required']) {
    assert.equal(care.allowsAppointmentAutomation(restored, trigger), false);
  }
  const afterRestore = await snapshot();
  const native = { ...before.find(row => row.id_cita === 104), id_cita: 202 };
  await assert.rejects(cleanup.restoreBackup(write('native-finish.json', [native])), /invalid_cleanup_backup/);
  await assert.rejects(cleanup.restoreBackup(write('mixed.json', [{ ...legacy, id_cita: 203 }, native])), /invalid_cleanup_backup/);
  assert.deepEqual(await snapshot(), afterRestore, 'No partial restore of invalid or native finished care');
  assert.equal(attemptedHooks, 0);
  report.checks.push('Actual MySQL historical cleanup: strict legacy attendance/source/group scope; references prevent deletion; new backup exact restore; old completion backup becomes attendance without finish; ordinary fields/dates/actors/HOLD preserved; conflict replay and mixed/native backup rejection are atomic; communication hooks never run; historical automations remain ineligible');
}).then(() => {}, error => { console.error(error.code || error.message); process.exitCode = 1; });
