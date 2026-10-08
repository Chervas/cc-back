'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('sequelize').DataTypes;
const receipts = require('../../../migrations/20261008123000-personal-calendar-undo-receipts');
const until = require('../../../migrations/20261008123100-add-personal-block-recurrence-until');

function schemaFixture() {
  const tables = new Map([['DoctorBloqueos', { columns: {}, rows: [], indexes: [] }]]);
  const q = {
    createTable: async (name, columns) => { assert.equal(tables.has(name), false); tables.set(name, { columns, rows: [], indexes: [] }); },
    dropTable: async name => { assert.ok(tables.has(name)); tables.delete(name); },
    addIndex: async (name, fields) => { tables.get(name).indexes.push(fields); },
    addColumn: async (name, field, definition) => { assert.equal(Object.hasOwn(tables.get(name).columns, field), false); tables.get(name).columns[field] = definition; },
    removeColumn: async (name, field) => { assert.ok(Object.hasOwn(tables.get(name).columns, field)); delete tables.get(name).columns[field]; },
    sequelize: { query: async sql => {
      if (sql === 'SELECT COUNT(*) AS n FROM PersonalCalendarUndoReceipts') return [[{ n: tables.get('PersonalCalendarUndoReceipts').rows.length }]];
      if (sql === 'SELECT COUNT(*) AS n FROM DoctorBloqueos WHERE recurrente_hasta IS NOT NULL') return [[{ n: tables.get('DoctorBloqueos').rows.filter(row => row.recurrente_hasta != null).length }]];
      throw Error('Unexpected synthetic migration query');
    } },
  };
  return { q, tables };
}
test('additive workflow migrations round-trip up/down/up in an isolated schema and keep nullable series limits', async () => {
  const { q, tables } = schemaFixture();
  tables.get('DoctorBloqueos').rows.push({ id: 1, recurrente: 'weekly', recurrente_hasta: null });
  await receipts.up(q, D); await until.up(q, D);
  const undo = tables.get('PersonalCalendarUndoReceipts'), revision = tables.get('PersonalCalendarRevisions');
  assert.equal(undo.columns.token_hash.unique, true); assert.equal(undo.columns.token_hash.type.options.length, 64);
  assert.equal(undo.columns.consumed_at.allowNull, true); assert.equal(undo.columns.expires_at.type.options.length, 3);
  assert.deepEqual(undo.indexes, [['expires_at'], ['actor_user_id', 'created_at']]);
  assert.equal(revision.columns.doctor_id.primaryKey, true); assert.equal(revision.columns.revision.type.options.unsigned, true);
  assert.equal(tables.get('DoctorBloqueos').columns.recurrente_hasta.allowNull, true);
  assert.equal(tables.get('DoctorBloqueos').columns.recurrente_hasta.defaultValue, null);
  await until.down(q); await receipts.down(q);
  assert.equal(tables.has('PersonalCalendarUndoReceipts'), false); assert.equal(tables.has('PersonalCalendarRevisions'), false);
  assert.deepEqual(tables.get('DoctorBloqueos').rows, [{ id: 1, recurrente: 'weekly', recurrente_hasta: null }]);
  await receipts.up(q, D); await until.up(q, D);
  assert.ok(tables.has('PersonalCalendarUndoReceipts')); assert.ok(tables.get('DoctorBloqueos').columns.recurrente_hasta);
});
test('migration rollback rejects removal of durable receipts or stored recurrence limits before any destructive DDL', async () => {
  const { q, tables } = schemaFixture(); await receipts.up(q, D); await until.up(q, D);
  tables.get('PersonalCalendarUndoReceipts').rows.push({ id: 'fictitious-receipt' });
  tables.get('DoctorBloqueos').rows.push({ id: 1, recurrente_hasta: '2027-01-31' });
  await assert.rejects(receipts.down(q), /requires_empty_receipts/);
  await assert.rejects(until.down(q), /requires_empty_limits/);
  assert.ok(tables.has('PersonalCalendarRevisions')); assert.ok(tables.has('PersonalCalendarUndoReceipts'));
  assert.ok(tables.get('DoctorBloqueos').columns.recurrente_hasta);
});
