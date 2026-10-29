'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { effectiveContract, compare } = require('../../lib/securitySchemaContract');
const contract = require('../../../ops/security/schema-contract.json');
const schema = require('../../lib/searchConsoleAnalyticsSchema');

test('a read-only SC rollout requires the compact schema and its migration', () => {
  const selected = effectiveContract(contract, { SC_ANALYTICS_READ_ENABLED: 'true' });
  const names = Object.keys(schema.definitions);
  assert.equal(names.length, 12);
  assert.ok(names.every(name => selected.tables[name]));
  const migration = '20261018150000-create-search-console-analytics.js';
  assert.ok(selected.migrations.some(item => item.name === migration));
  const actual = { defaults: {}, tables: [], columns: [], indexes: [], migrations: [] };
  const result = compare(actual, {
    defaults: {}, tables: Object.fromEntries(names.map(name => [name, selected.tables[name]])),
    migrations: selected.migrations.filter(item => item.name === migration),
  });
  assert.equal(result.compatible, false);
  assert.equal(result.issues.filter(item => item.reason === 'missing_table').length, 12);
  assert.deepEqual(result.missingMigrations, [migration]);
});

test('every SC gate alone protects its required tables; disabled gates preserve normal deployment', () => {
  const group = contract.featureGroups.search_console_analytics;
  for (const flag of Object.keys(group.enabledWhenAny)) {
    const active = effectiveContract(contract, { [flag]: 'true' });
    assert.ok(group.tables.every(name => active.tables[name]), flag);
  }
  for (const value of [undefined, 'false', 'TRUE', '1']) {
    const inactive = effectiveContract(contract, { SC_ANALYTICS_WRITE_ENABLED: value });
    assert.ok(group.tables.every(name => !inactive.tables[name]));
  }
});

test('all and any conditions combine without weakening existing all-only groups', () => {
  const base = {
    tables: { all: { columns: [], indexes: [] }, both: { columns: [], indexes: [] } },
    migrations: [], featureGroups: {
      all: { enabledWhenAll: { A: 'true', B: 'true' }, tables: ['all'] },
      both: { enabledWhenAll: { A: 'true' }, enabledWhenAny: { B: 'true', C: 'true' }, tables: ['both'] },
    },
  };
  assert.ok(effectiveContract(base, { A: 'true', B: 'true' }).tables.all);
  assert.equal(effectiveContract(base, { A: 'true', C: 'true' }).tables.all, undefined);
  assert.ok(effectiveContract(base, { A: 'true', C: 'true' }).tables.both);
  assert.equal(effectiveContract(base, { A: 'false', B: 'true' }).tables.both, undefined);
  assert.equal(effectiveContract(base, { A: 'true', B: 'false', C: 'false' }).tables.both, undefined);
});
