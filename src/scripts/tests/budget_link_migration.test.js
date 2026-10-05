'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const migration = require('../../../migrations/20261005052000-allow-budget-appointment-link-events');
const Sequelize = { ENUM: (...values) => values };
const database = (type, count = 0) => ({ calls: [],
  describeTable: async () => ({ event_type: { type } }),
  async changeColumn(table, column, options) { this.calls.push({ table, column, options }); },
  sequelize: { query: async () => [[{ total: count }]] },
});
test('budget-link migration appends its type and preserves every existing enum value', async () => {
  const db = database("ENUM('created','v2-import','signature')");
  await migration.up(db, Sequelize);
  assert.deepEqual(db.calls[0].options.type, ['created', 'v2-import', 'signature', 'appointment_linked']);
  const existing = database("ENUM('created','appointment_linked')");
  await migration.up(existing, Sequelize); assert.equal(existing.calls.length, 0);
});
test('unknown enum schemas and rollbacks with recorded links fail closed', async () => {
  for (const type of ['VARCHAR(30)', "ENUM('created','unsafe\\\'quote')", "ENUM('created') unexpected"]) {
    const db = database(type); await assert.rejects(migration.up(db, Sequelize)); assert.equal(db.calls.length, 0);
  }
  const db = database("ENUM('created','appointment_linked')", 1);
  await assert.rejects(migration.down(db, Sequelize), /audit history/); assert.equal(db.calls.length, 0);
  const empty = database("ENUM('created','appointment_linked')");
  await migration.down(empty, Sequelize); assert.deepEqual(empty.calls[0].options.type, ['created']);
});
