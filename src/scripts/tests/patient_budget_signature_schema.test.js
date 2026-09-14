'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260914003000-allow-budget-signature-events');
const base = ['created', 'edited', 'presented', 'accepted', 'partially_accepted', 'rejected', 'expired', 'duplicated', 'superseded'];
function harness({ values = base, rows = 0, type = null } = {}) {
  let changes = 0, actual = [...values];
  return { get changes() { return changes; }, get values() { return actual; },
    q: { describeTable: async () => ({ event_type: { type: type || `ENUM(${actual.map(v => `'${v}'`).join(',')})`, allowNull: false } }),
      changeColumn: async (_t, _c, spec) => { changes++; actual = spec.type; assert.equal(spec.allowNull, false); },
      sequelize: { query: async () => [[{ total: rows }]] } }, S: { ENUM: (...values) => values } };
}
test('additive signature event migration preserves original ENUM positions and is idempotent', async () => {
  const h = harness(); await migration.up(h.q, h.S); await migration.up(h.q, h.S);
  assert.equal(h.changes, 1); assert.deepEqual(h.values.slice(0, base.length), base); assert.equal(h.values.length, 15);
});
test('unknown or non-enum database schema is never rewritten', async () => {
  for (const options of [{ values: [...base, 'unknown'] }, { type: 'VARCHAR(30)' }, { values: base.slice(1) }]) {
    const h = harness(options); await assert.rejects(migration.up(h.q, h.S)); assert.equal(h.changes, 0);
  }
});
test('rollback refuses to erase signature audit history', async () => {
  const h = harness({ rows: 1 }); await migration.up(h.q, h.S);
  await assert.rejects(migration.down(h.q, h.S), { code: 'budget_event_rollback_has_audit_history' }); assert.equal(h.changes, 1);
});
test('empty additive extension can be rolled back without rewriting events', async () => {
  const h = harness(); await migration.up(h.q, h.S); await migration.down(h.q, h.S); assert.deepEqual(h.values, base);
});
