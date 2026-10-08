'use strict';
const assert = require('node:assert/strict');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const migration = require('../../../migrations/20261008150000-appointment-care-lifecycle');
const release = require('../appointment-care-schema-release');
const states = ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado',
  'recordatorio_confirmado', 'cambio_solicitado', 'completada', 'no_asistio', 'cancelada', 'reprogramada'];

withIsolatedCampaignMysql(async ({ sql, report }) => {
  const qi = sql.getQueryInterface();
  await qi.createTable('CitasPacientes', { id_cita: { type: D.INTEGER, primaryKey: true },
    estado: { type: D.ENUM(...states), allowNull: false, defaultValue: 'pendiente' },
    inicio: D.DATE, fin: D.DATE, arrived_at: D.DATE, arrived_by: D.INTEGER,
    care_started_at: D.DATE, care_started_by: D.INTEGER, care_schedule_start: D.DATE,
    updated_at: D.DATE, created_at: D.DATE, source_system: D.STRING, source_reference: D.STRING,
    import_metadata: D.JSON, created_by: D.INTEGER, updated_by: D.INTEGER });
  await qi.createTable('DoctorClinicas', { id: { type: D.INTEGER, primaryKey: true },
    doctor_id: D.INTEGER, clinica_id: D.INTEGER, allow_legacy_attention_confirmation: D.BOOLEAN });
  await qi.createTable('PreservedEvidence', { id: { type: D.INTEGER, primaryKey: true }, content: D.JSON });
  await qi.createTable('SequelizeMeta', { name: { type: D.STRING, primaryKey: true } });
  await qi.bulkInsert('DoctorClinicas', [{ id: 119, doctor_id: 221, clinica_id: 72, allow_legacy_attention_confirmation: true }]);
  await qi.bulkInsert('PreservedEvidence', [{ id: 1, content: JSON.stringify({ booking: 'synthetic', history: 'synthetic', economics: 'synthetic' }) }]);
  const start = new Date('2026-10-07T10:00:00Z');
  const common = { inicio: start, fin: new Date(+start + 3600000), updated_at: new Date('2026-10-07T09:00:00Z'),
    created_at: new Date('2026-10-06T09:00:00Z'), created_by: 5, updated_by: 6,
    source_system: 'synthetic', source_reference: 'fixture', import_metadata: JSON.stringify({ automation_policy: 'hold' }) };
  await qi.bulkInsert('CitasPacientes', states.map((estado, index) => ({ ...common, id_cita: index + 1, estado })));
  await qi.bulkInsert('CitasPacientes', [
    { ...common, id_cita: 11, estado: 'recordatorio_confirmado', arrived_at: start, arrived_by: 8, care_schedule_start: start },
    { ...common, id_cita: 12, estado: 'info_confirmada', arrived_at: start, arrived_by: 8, care_schedule_start: start,
      care_started_at: new Date(+start + 1000), care_started_by: 9 },
    { ...common, id_cita: 13, estado: 'pendiente', arrived_at: start, arrived_by: 8, care_schedule_start: new Date(+start - 86400000) },
  ]);
  const read = async table => (await sql.query(`SELECT * FROM ${qi.queryGenerator.quoteTable(table)} ORDER BY id${table === 'CitasPacientes' ? '_cita' : ''}`))[0];
  const before = await read('CitasPacientes'), permission = await read('DoctorClinicas'), evidence = await read('PreservedEvidence');
  const connection = await require('mysql2/promise').createConnection({ user: 'root', database: 'campaign_optimization_qa',
    socketPath: sql.options.dialectOptions.socketPath, dateStrings: true, timezone: 'Z' });
  let captured;
  try {
    captured = await release.capture(connection);
    release.assertBefore(captured.summary);
    await release.applyMigration(connection);
    release.assertAfter(captured.summary, await release.capture(connection));
  } finally { await connection.end(); }
  const after = await read('CitasPacientes');
  for (let index = 0; index < before.length; index++) {
    const original = before[index], current = after[index];
    for (const key of Object.keys(original).filter(key => key !== 'estado')) assert.deepEqual(current[key], original[key], `${current.id_cita}/${key}`);
    assert.equal(current.care_completed_at, null);
    assert.equal(current.care_completed_by, null);
    assert.equal(Number(current.care_legacy_attendance), original.estado === 'completada' ? 1 : 0);
    const expected = original.estado === 'completada' || original.id_cita === 11 ? 'ha_acudido'
      : original.id_cita === 12 ? 'en_atencion' : original.estado;
    assert.equal(current.estado, expected);
  }
  assert.deepEqual(await read('DoctorClinicas'), permission);
  assert.deepEqual(await read('PreservedEvidence'), evidence);
  const [[column]] = await sql.query("SHOW COLUMNS FROM CitasPacientes WHERE Field='estado'");
  assert.deepEqual([...column.Type.matchAll(/'([^']+)'/g)].map(match => match[1]), [...states, 'ha_acudido', 'en_atencion']);
  await migration.up(qi);
  assert.deepEqual(await read('CitasPacientes'), after, 'Replay does not reclassify or change any evidence');
  await assert.rejects(migration.down(qi), /rollback requires an explicit compatibility plan/);
  report.checks.push('Actual MySQL migration: all original ENUM ordinals retained; five early states untouched; old completion becomes historical attendance; native current arrival/start projected; stale anchor ignored; all dates, actors, source/HOLD untouched; Piedad permission/evidence unchanged; replay unchanged; unsafe rollback rejected');
  report.checks.push('Actual release operator capture/assertBefore/assertAfter use date-string MySQL rows and verify complete appointment and DoctorClinicas hashes across migration');
}).then(() => {}, error => { console.error(error.code || error.message); process.exitCode = 1; });
