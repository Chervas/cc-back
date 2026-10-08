'use strict';

// Synthetic schema/ORM and RAM calendar fixtures only. No runtime or DB writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, DataTypes } = require('sequelize');
const migration = require('../../../migrations/20261008133000-add-legacy-attention-confirmation');
const doctorClinicaModel = require('../../../models/doctorclinica');
const undoService = require('../../services/personalCalendarUndo.service');
const { withCalendarMutation } = require('../../services/appointmentCalendarMutation.service');
const { fixture, clone } = require('./fixtures/personal_calendar_undo_ram.cjs');
const FIELD = 'allow_legacy_attention_confirmation';

function schemaFixture(enabled = 0) {
  const columns = {}, calls = [];
  const q = {
    addColumn: async (table, field, definition) => {
      calls.push(['add', table, field]); columns[field] = definition;
    },
    removeColumn: async (table, field) => {
      calls.push(['remove', table, field]); delete columns[field];
    },
    sequelize: { query: async sql => {
      assert.equal(sql, `SELECT COUNT(*) AS n FROM DoctorClinicas WHERE ${FIELD} = 1`);
      calls.push(['count']); return [[{ n: enabled }]];
    } },
  };
  return { q, columns, calls };
}

test('membership permission is additive and default-off without granting any clinician or role', async () => {
  const f = schemaFixture();
  await migration.up(f.q, DataTypes);
  assert.deepEqual(f.calls, [['add', 'DoctorClinicas', FIELD]]);
  assert.equal(f.columns[FIELD].type, DataTypes.BOOLEAN);
  assert.equal(f.columns[FIELD].allowNull, false);
  assert.equal(f.columns[FIELD].defaultValue, false);
  await migration.down(f.q);
  assert.equal(Object.hasOwn(f.columns, FIELD), false);
  await migration.up(f.q, DataTypes);
  assert.equal(f.columns[FIELD].defaultValue, false);
});

test('rollback refuses to drop a permission until all grants have been disabled', async () => {
  const f = schemaFixture(1);
  await migration.up(f.q, DataTypes);
  await assert.rejects(migration.down(f.q), /requires_disabled_permissions/);
  assert.equal(f.calls.some(call => call[0] === 'remove'), false);
  assert.ok(f.columns[FIELD]);
});

test('ORM membership contract matches the default-off non-null boolean migration', async () => {
  const sequelize = new Sequelize('synthetic_schema', 'synthetic_user', null, { dialect: 'mysql', logging: false });
  try {
    const Model = doctorClinicaModel(sequelize, DataTypes);
    assert.equal(Model.tableName, 'DoctorClinicas');
    assert.equal(Model.rawAttributes[FIELD].type.key, 'BOOLEAN');
    assert.equal(Model.rawAttributes[FIELD].allowNull, false);
    assert.equal(Model.rawAttributes[FIELD].defaultValue, false);
    assert.equal(Model.build({ doctor_id: 2, clinica_id: 10 }).get(FIELD), false);
  } finally { await sequelize.close(); }
});

test('calendar undo snapshots retain a deleted membership compatibility permission', async () => {
  const f = fixture(); f.state().DoctorClinica[0][FIELD] = true;
  const before = clone(f.state().DoctorClinica);
  const result = await withCalendarMutation({ ...f.options(), undoContext: { actorId: 1, now: f.now },
    mutate: async transaction => {
      await f.db.DoctorHorario.destroy({ where: { doctor_clinica_id: 201 }, transaction });
      await f.db.DoctorClinica.destroy({ where: { id: 201 }, transaction });
    } });
  assert.equal(f.state().PersonalCalendarUndoReceipt[0].before_state.DoctorClinica[0][FIELD], true);
  await undoService.undoAvailability({ db: f.db, actorId: 1, token: result.undo.token, now: f.now,
    assertPermissions: async () => true, calendarOptions: f.options() });
  assert.deepEqual(f.state().DoctorClinica, before);
});

test('a grant or revocation after schedule mutation invalidates undo and is not overwritten', async () => {
  for (const original of [false, true]) {
    const f = fixture(); f.state().DoctorClinica[0][FIELD] = original;
    const result = await withCalendarMutation({ ...f.options(), undoContext: { actorId: 1, now: f.now },
      mutate: transaction => f.db.DoctorHorario.create({ doctor_clinica_id: 201, dia_semana: 1,
        activo: true, hora_inicio: '12:00', hora_fin: '16:00', rrule: null }, { transaction }) });
    f.state().DoctorClinica[0][FIELD] = !original;
    const beforeUndo = clone(f.state());
    await assert.rejects(undoService.undoAvailability({ db: f.db, actorId: 1, token: result.undo.token, now: f.now,
      assertPermissions: async () => true, calendarOptions: f.options() }), { code: 'availability_undo_conflict' });
    assert.deepEqual(f.state(), beforeUndo);
  }
});
