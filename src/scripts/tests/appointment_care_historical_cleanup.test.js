'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/owned-historical-cleanup-module');
const cleanup = load();
const base = () => ({ id_cita: 10, clinica_id: 1, paciente_id: 20,
  estado: 'completada', titulo: 'Histórico: prueba ficticia', motivo: 'Importación de pacientes para reactivación',
  inicio: '2026-09-01T10:00:00Z', fin: '2026-09-01T10:30:00Z',
  created_by: 3, updated_by: 4, created_at: '2026-09-01T09:00:00Z', updated_at: '2026-09-01T09:30:00Z',
  source_system: 'clinicaclick_reactivation_import', import_metadata: { automation_policy: 'hold' } });

test('cleanup targets historical attendance, never native completion or unmarked arrivals', () => {
  const sql = cleanup.strictWhereSql(false);
  assert.match(sql, /inicio > NOW\(\)/);
  assert.match(sql, /estado = 'ha_acudido'/);
  assert.match(sql, /care_legacy_attendance = 1/);
  assert.match(sql, /care_completed_at IS NULL/);
  assert.match(sql, /care_completed_by IS NULL/);
  assert.match(sql, /cl\.grupoClinicaId = :groupId/);
  assert.doesNotMatch(cleanup.strictWhereSql(true), /inicio > NOW\(\)/);
});

test('old backup restores attendance and preserves every ordinary date, actor and HOLD without mutating input', () => {
  const row = base(), before = JSON.stringify(row), restored = cleanup.normalizeBackupRow(row);
  assert.equal(restored.estado, 'ha_acudido');
  assert.equal(restored.care_legacy_attendance, true);
  for (const key of Object.keys(row).filter(key => key !== 'estado')) assert.deepEqual(restored[key], row[key]);
  assert.equal(JSON.stringify(row), before);
  assert.equal(restored.care_completed_at, undefined);
  assert.equal(restored.care_completed_by, undefined);
});

test('new backup retains attendance and its old arrival/start evidence, without claiming a finish', () => {
  for (const flag of [true, 1]) {
    const row = { ...base(), estado: 'ha_acudido', care_legacy_attendance: flag,
      arrived_at: '2026-09-01T10:00:00Z', arrived_by: 3, care_started_at: '2026-09-01T10:05:00Z', care_started_by: 4 };
    assert.equal(cleanup.validateBackupRow(row), true);
    const restored = cleanup.normalizeBackupRow(row);
    for (const key of ['arrived_at', 'arrived_by', 'care_started_at', 'care_started_by']) assert.equal(restored[key], row[key]);
  }
});

test('early states, active clinical attention, native finish evidence and malformed IDs cannot be restored by this operator', () => {
  const invalid = [
    ...['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'en_atencion'].map(estado => ({ ...base(), estado })),
    { ...base(), estado: 'ha_acudido', care_legacy_attendance: false },
    { ...base(), care_completed_at: '2026-09-01T10:30:00Z' },
    { ...base(), care_completed_by: 4 },
    { ...base(), id_cita: 0 }, { ...base(), clinica_id: -1 },
    { ...base(), titulo: 'Atención real' }, { ...base(), motivo: 'Cita normal' },
    null,
  ];
  for (const row of invalid) {
    assert.equal(cleanup.validateBackupRow(row), false);
    assert.throws(() => cleanup.normalizeBackupRow(row), /invalid_cleanup_backup/);
  }
});

test('loading tests never runs the CLI, opens SQL or reads production configuration', () => {
  const logs = [];
  const db = new Proxy({}, { get() { throw Error('Production SQL is forbidden'); } });
  assert.equal(typeof load({ db, logs }).restoreBackup, 'function');
  assert.deepEqual(logs, []);
});
