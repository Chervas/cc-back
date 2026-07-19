'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const migration = require('../../../migrations/20260719093000-index-web-publication-deployment-artifact');

const TABLE = 'WebPublicationDeployments';
const INDEX = 'idx_web_publication_deployments_artifact_status';
const FIELDS = ['artifact_id', 'status', 'publication_id'];

function index(fields = FIELDS, unique = false) {
  return {
    name: INDEX,
    unique,
    fields: fields.map((attribute) => ({ attribute })),
  };
}

function fakeQueryInterface(seedIndexes = []) {
  const indexes = seedIndexes.map((candidate) => ({
    ...candidate,
    fields: candidate.fields.map((field) => ({ ...field })),
  }));
  const calls = [];
  return {
    calls,
    indexes,
    async showIndex(table) {
      assert.equal(table, TABLE);
      return indexes;
    },
    async addIndex(table, fields, options) {
      assert.equal(table, TABLE);
      calls.push(['addIndex', fields, options]);
      indexes.push({
        name: options.name,
        unique: Boolean(options.unique),
        fields: fields.map((attribute) => ({ attribute })),
      });
    },
    async removeIndex(table, name) {
      assert.equal(table, TABLE);
      calls.push(['removeIndex', name]);
      const position = indexes.findIndex((candidate) => candidate.name === name);
      if (position >= 0) indexes.splice(position, 1);
    },
  };
}

test('crea el índice dirigido exacto y es idempotente', async () => {
  const queryInterface = fakeQueryInterface();
  await migration.up(queryInterface);
  assert.deepEqual(queryInterface.indexes, [index()]);
  assert.deepEqual(queryInterface.calls, [[
    'addIndex',
    FIELDS,
    { name: INDEX },
  ]]);

  await migration.up(queryInterface);
  assert.equal(queryInterface.calls.length, 1);
});

test('falla cerrado si el índice homónimo es único o cambia el orden de columnas', async () => {
  for (const incompatible of [index(FIELDS, true), index(['artifact_id', 'publication_id', 'status'])]) {
    const queryInterface = fakeQueryInterface([incompatible]);
    await assert.rejects(
      () => migration.up(queryInterface),
      (error) => error.code === 'web_publication_deployment_artifact_index_incompatible'
    );
    assert.deepEqual(queryInterface.calls, []);
  }
});

test('down retira únicamente el índice compatible', async () => {
  const queryInterface = fakeQueryInterface([index()]);
  await migration.down(queryInterface);
  assert.deepEqual(queryInterface.calls, [['removeIndex', INDEX]]);
  assert.deepEqual(queryInterface.indexes, []);

  await migration.down(queryInterface);
  assert.equal(queryInterface.calls.length, 1);
});
