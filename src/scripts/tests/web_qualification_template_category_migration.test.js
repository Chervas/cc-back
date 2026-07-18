'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const migration = require('../../../migrations/20260718103000-normalize-web-qualification-template-category');

const TEMPLATE_ID = '61e5a73e-bcd5-47f0-a145-a0ddcbd76005';

function template(overrides = {}) {
  return {
    id: TEMPLATE_ID,
    catalog_key: 'qualification-form-v1',
    version: 1,
    category: 'form',
    scope_type: 'global',
    clinica_id: null,
    grupo_clinica_id: null,
    is_public: 1,
    ...overrides,
  };
}

function fakeQueryInterface({ hasTable = true, row = template(), skipWrites = false } = {}) {
  const state = { row: row ? { ...row } : null, writes: [] };
  return {
    state,
    showAllTables: async () => hasTable ? ['WebTemplates'] : [],
    sequelize: {
      QueryTypes: { SELECT: 'SELECT' },
      query: async (sql, options) => {
        assert.match(sql, /FROM WebTemplates/);
        assert.equal(options.replacements.id, TEMPLATE_ID);
        return state.row ? [{ ...state.row }] : [];
      },
    },
    bulkUpdate: async (tableName, values, where) => {
      state.writes.push({ tableName, values, where });
      if (skipWrites || !state.row) return 0;
      if (
        state.row.id === where.id
        && state.row.catalog_key === where.catalog_key
        && state.row.version === where.version
        && state.row.category === where.category
      ) {
        Object.assign(state.row, values);
        return 1;
      }
      return 0;
    },
  };
}

test('normaliza form a qualification y es idempotente', async () => {
  const queryInterface = fakeQueryInterface();
  await migration.up(queryInterface);
  assert.equal(queryInterface.state.row.category, 'qualification');
  assert.equal(queryInterface.state.writes.length, 1);
  assert.deepEqual(queryInterface.state.writes[0].where, {
    id: TEMPLATE_ID,
    catalog_key: 'qualification-form-v1',
    version: 1,
    category: 'form',
  });
  await migration.up(queryInterface);
  assert.equal(queryInterface.state.writes.length, 1);

  await migration.down(queryInterface);
  assert.equal(queryInterface.state.row.category, 'form');
  assert.equal(queryInterface.state.writes.length, 2);
  await migration.down(queryInterface);
  assert.equal(queryInterface.state.writes.length, 2);
});

test('falla cerrado ante dependencia, identidad o categoría inesperadas', async () => {
  await assert.rejects(
    () => migration.up(fakeQueryInterface({ hasTable: false })),
    (error) => error.code === 'web_qualification_category_missing_dependency'
  );
  await assert.rejects(
    () => migration.up(fakeQueryInterface({ row: null })),
    (error) => error.code === 'web_qualification_category_template_missing'
  );
  for (const row of [
    template({ catalog_key: 'otro-catalogo' }),
    template({ scope_type: 'clinic', clinica_id: 66 }),
    template({ is_public: 0 }),
    template({ category: 'custom' }),
  ]) {
    const queryInterface = fakeQueryInterface({ row });
    await assert.rejects(
      () => migration.up(queryInterface),
      (error) => error.code === 'web_qualification_category_template_conflict'
    );
    assert.equal(queryInterface.state.writes.length, 0);
  }
});

test('verifica el resultado y detecta una actualización concurrente o nula', async () => {
  await assert.rejects(
    () => migration.up(fakeQueryInterface({ skipWrites: true })),
    (error) => error.code === 'web_qualification_category_update_failed'
  );
});
