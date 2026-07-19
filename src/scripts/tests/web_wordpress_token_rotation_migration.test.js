'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Sequelize = require('sequelize');

const migration = require('../../../migrations/20260718233000-stage-wordpress-installation-token-rotation');

const TABLE = 'WebWordpressInstallations';
const INDEX = 'uniq_web_wordpress_next_token_hash';
const COLUMNS = [
  'next_token_hash',
  'next_token_prefix',
  'next_token_issued_at',
  'next_token_expires_at',
];

function index(name = INDEX, fields = ['next_token_hash'], unique = true) {
  return { name, unique, fields: fields.map((attribute) => ({ attribute })) };
}

function fakeQueryInterface({ seedColumns = {}, seedIndexes = [] } = {}) {
  const columns = { ...seedColumns };
  const indexes = seedIndexes.map((candidate) => ({
    ...candidate,
    fields: candidate.fields.map((field) => ({ ...field })),
  }));
  const calls = [];
  return {
    calls,
    columns,
    indexes,
    async describeTable(table) {
      assert.equal(table, TABLE);
      return { ...columns };
    },
    async showIndex(table) {
      assert.equal(table, TABLE);
      return indexes;
    },
    async addColumn(table, name, definition) {
      assert.equal(table, TABLE);
      calls.push(['addColumn', name]);
      columns[name] = definition;
    },
    async removeColumn(table, name) {
      assert.equal(table, TABLE);
      calls.push(['removeColumn', name]);
      delete columns[name];
    },
    async addIndex(table, fields, options) {
      assert.equal(table, TABLE);
      calls.push(['addIndex', options.name]);
      indexes.push(index(options.name, fields, Boolean(options.unique)));
    },
    async removeIndex(table, name) {
      assert.equal(table, TABLE);
      calls.push(['removeIndex', name]);
      const position = indexes.findIndex((candidate) => candidate.name === name);
      if (position >= 0) indexes.splice(position, 1);
    },
  };
}

test('la migración staged crea columnas e índice único exacto y es idempotente', async () => {
  const queryInterface = fakeQueryInterface();
  await migration.up(queryInterface, Sequelize);
  assert.deepEqual(Object.keys(queryInterface.columns).sort(), [...COLUMNS].sort());
  assert.deepEqual(queryInterface.indexes, [index()]);
  const mutationCount = queryInterface.calls.length;
  await migration.up(queryInterface, Sequelize);
  assert.equal(queryInterface.calls.length, mutationCount);
});

test('la migración staged falla cerrado ante un índice homónimo incompatible', async () => {
  for (const incompatible of [
    index(INDEX, ['next_token_hash'], false),
    index(INDEX, ['token_hash'], true),
  ]) {
    const queryInterface = fakeQueryInterface({ seedIndexes: [incompatible] });
    await assert.rejects(
      () => migration.up(queryInterface, Sequelize),
      (error) => error.code === 'web_wordpress_token_rotation_index_incompatible'
    );
    assert.equal(queryInterface.calls.some(([operation]) => operation === 'addIndex'), false);
  }
});

test('down retira primero el índice y después todas las columnas', async () => {
  const queryInterface = fakeQueryInterface({
    seedColumns: Object.fromEntries(COLUMNS.map((name) => [name, {}])),
    seedIndexes: [index()],
  });
  await migration.down(queryInterface, Sequelize);
  assert.deepEqual(queryInterface.calls, [
    ['removeIndex', INDEX],
    ['removeColumn', 'next_token_expires_at'],
    ['removeColumn', 'next_token_issued_at'],
    ['removeColumn', 'next_token_prefix'],
    ['removeColumn', 'next_token_hash'],
  ]);
  assert.deepEqual(queryInterface.columns, {});
});
