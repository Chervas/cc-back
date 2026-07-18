'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const migration = require('../../../migrations/20260718225000-add-campaign-destination-drift-event');

const base = [
  'landing_published', 'destination_ready', 'apply_requested', 'apply_started',
  'readback_verified', 'readback_failed', 'rollback_requested', 'rollback_started',
  'rollback_verified', 'rollback_failed',
];
const Sequelize = { ENUM: (...values) => `ENUM('${values.join("','")}')` };

function queryInterface(initialValues = base) {
  let type = Sequelize.ENUM(...initialValues);
  let changes = 0;
  return {
    get changes() { return changes; },
    async showAllTables() { return ['CampaignDestinationBindingEvents']; },
    async describeTable() { return { event_type: { type, allowNull: false } }; },
    async changeColumn(_table, _column, definition) {
      type = definition.type;
      changes += 1;
    },
    sequelize: { query: async () => [[{ row_count: 0 }]] },
  };
}

test('añade drift_detected de forma idempotente al ENUM durable', async () => {
  const qi = queryInterface();
  await migration.up(qi, Sequelize);
  assert.equal(qi.changes, 1);
  assert.match((await qi.describeTable()).event_type.type, /drift_detected/);
  await migration.up(qi, Sequelize);
  assert.equal(qi.changes, 1);
});

test('falla cerrado ante una tabla ausente o un ENUM ambiguo', async () => {
  await assert.rejects(() => migration.up({
    async showAllTables() { return []; },
  }, Sequelize), (error) => error.code === 'campaign_destination_drift_event_dependency_missing');

  const qi = queryInterface([...base, 'evento_desconocido']);
  await assert.rejects(
    () => migration.up(qi, Sequelize),
    (error) => error.code === 'campaign_destination_drift_event_enum_incompatible'
  );
  assert.equal(qi.changes, 0);
});

test('rollback elimina el valor solo cuando no existen eventos drift_detected', async () => {
  const qi = queryInterface([...base, 'drift_detected']);
  await migration.down(qi, Sequelize);
  assert.equal(qi.changes, 1);
  assert.doesNotMatch((await qi.describeTable()).event_type.type, /drift_detected/);

  const blocked = queryInterface([...base, 'drift_detected']);
  blocked.sequelize.query = async () => [[{ row_count: 1 }]];
  await assert.rejects(
    () => migration.down(blocked, Sequelize),
    (error) => error.code === 'campaign_destination_drift_event_rollback_data_present'
  );
  assert.equal(blocked.changes, 0);
});
