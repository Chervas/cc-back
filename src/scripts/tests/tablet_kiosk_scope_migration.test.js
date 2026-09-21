'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const migration = require('../../../migrations/20260921080000-add-tablet-consent-group-scope');
test('additive column defaults to NULL, no automatic grant or password rewrite', async () => {
    const writes = [];
    const q = { describeTable: async () => ({}), addColumn: async (...args) => writes.push(args) };
    await migration.up(q, { INTEGER: 'INTEGER' });
    assert.deepEqual(writes, [['ClinicTabletKiosks', 'consent_group_id', { type: 'INTEGER', allowNull: true, defaultValue: null }]]);
});
test('idempotent matching schema; incompatible existing column rejected', async () => {
    await migration.up({ describeTable: async () => ({ consent_group_id: { type: 'INT', allowNull: true, defaultValue: null } }) });
    await assert.rejects(migration.up({ describeTable: async () => ({ consent_group_id: { type: 'INT', allowNull: false } }) }), /INCOMPATIBLE/);
});
test('rollback refuses to remove a used grant column', async () => {
    const q = { describeTable: async () => ({ consent_group_id: {} }), sequelize: { query: async () => [[{ total: 1 }]] },
        removeColumn: async () => assert.fail('cannot discard grants') };
    await assert.rejects(migration.down(q), /HAS_GRANTS/);
});
