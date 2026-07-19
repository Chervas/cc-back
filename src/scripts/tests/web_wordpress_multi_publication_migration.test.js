'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Sequelize = require('sequelize');

const migration = require('../../../migrations/20260718230000-enable-multiple-wordpress-publications');

const TABLE = 'WebPublications';
const UNIQUE_INDEX = 'uniq_web_publications_wordpress_installation';
const ROUTE_INDEX = 'idx_web_publications_wordpress_status_path';

function index(name, fields, unique = false) {
  return {
    name,
    unique,
    fields: fields.map((attribute) => ({ attribute })),
  };
}

function fakeQueryInterface({
  seedIndexes = [],
  duplicateRows = [],
  wrapQueryResult = false,
  failRouteAdd = false,
  failUniqueAdd = false,
} = {}) {
  const liveIndexes = seedIndexes.map((item) => ({
    ...item,
    fields: item.fields.map((field) => ({ ...field })),
  }));
  const calls = [];
  return {
    calls,
    indexes: liveIndexes,
    queryGenerator: {
      quoteTable(name) { return `\`${name}\``; },
      quoteIdentifier(name) { return `\`${name}\``; },
    },
    sequelize: {
      async query() {
        calls.push(['query']);
        return wrapQueryResult ? [duplicateRows, []] : duplicateRows;
      },
    },
    async showIndex(table) {
      assert.equal(table, TABLE);
      calls.push(['showIndex']);
      return liveIndexes;
    },
    async addIndex(table, fields, options) {
      assert.equal(table, TABLE);
      calls.push(['addIndex', options.name]);
      if (failRouteAdd && options.name === ROUTE_INDEX) {
        throw new Error('simulated route DDL failure');
      }
      if (failUniqueAdd && options.name === UNIQUE_INDEX) {
        throw new Error('simulated unique DDL failure');
      }
      liveIndexes.push(index(options.name, fields, Boolean(options.unique)));
    },
    async removeIndex(table, name) {
      assert.equal(table, TABLE);
      calls.push(['removeIndex', name]);
      const position = liveIndexes.findIndex((item) => item.name === name);
      if (position >= 0) liveIndexes.splice(position, 1);
    },
  };
}

function ddlCalls(queryInterface) {
  return queryInterface.calls.filter(([operation]) => (
    operation === 'addIndex' || operation === 'removeIndex'
  ));
}

test('up sustituye el UNIQUE por el índice de ruta y es idempotente', async () => {
  const queryInterface = fakeQueryInterface({
    seedIndexes: [index(UNIQUE_INDEX, ['wordpress_installation_id'], true)],
  });

  await migration.up(queryInterface, Sequelize);
  assert.deepEqual(ddlCalls(queryInterface), [
    ['addIndex', ROUTE_INDEX],
    ['removeIndex', UNIQUE_INDEX],
  ]);
  assert.deepEqual(queryInterface.indexes, [
    index(ROUTE_INDEX, ['wordpress_installation_id', 'status', 'path']),
  ]);

  const mutationCount = ddlCalls(queryInterface).length;
  await migration.up(queryInterface, Sequelize);
  assert.equal(ddlCalls(queryInterface).length, mutationCount);
});

test('up rechaza índices homónimos con unique o columnas incompatibles', async () => {
  const cases = [
    index(UNIQUE_INDEX, ['wordpress_installation_id'], false),
    index(ROUTE_INDEX, ['wordpress_installation_id', 'path', 'status']),
  ];

  for (const incompatible of cases) {
    const queryInterface = fakeQueryInterface({ seedIndexes: [incompatible] });
    await assert.rejects(
      () => migration.up(queryInterface, Sequelize),
      (error) => error.code === 'web_wordpress_multi_publication_index_incompatible'
    );
    assert.deepEqual(ddlCalls(queryInterface), []);
  }
});

test('up conserva el UNIQUE si falla el DDL del índice de ruta', async () => {
  const queryInterface = fakeQueryInterface({
    seedIndexes: [index(UNIQUE_INDEX, ['wordpress_installation_id'], true)],
    failRouteAdd: true,
  });

  await assert.rejects(
    () => migration.up(queryInterface, Sequelize),
    /simulated route DDL failure/
  );
  assert.deepEqual(ddlCalls(queryInterface), [['addIndex', ROUTE_INDEX]]);
  assert.deepEqual(queryInterface.indexes, [
    index(UNIQUE_INDEX, ['wordpress_installation_id'], true),
  ]);
});

test('down sin duplicados crea primero el UNIQUE, retira la ruta y es idempotente', async () => {
  const queryInterface = fakeQueryInterface({
    seedIndexes: [index(ROUTE_INDEX, ['wordpress_installation_id', 'status', 'path'])],
    wrapQueryResult: true,
  });

  await migration.down(queryInterface, Sequelize);
  assert.deepEqual(ddlCalls(queryInterface), [
    ['addIndex', UNIQUE_INDEX],
    ['removeIndex', ROUTE_INDEX],
  ]);
  assert.deepEqual(queryInterface.indexes, [
    index(UNIQUE_INDEX, ['wordpress_installation_id'], true),
  ]);

  const mutationCount = ddlCalls(queryInterface).length;
  await migration.down(queryInterface, Sequelize);
  assert.equal(ddlCalls(queryInterface).length, mutationCount);
});

test('down falla cerrado ante duplicados y conserva el índice de ruta', async () => {
  const queryInterface = fakeQueryInterface({
    seedIndexes: [index(ROUTE_INDEX, ['wordpress_installation_id', 'status', 'path'])],
    duplicateRows: [{ installation_id: 'wp-42', publication_count: '2' }],
  });

  await assert.rejects(() => migration.down(queryInterface, Sequelize), (error) => {
    assert.equal(error.code, 'web_wordpress_multi_publication_down_forbidden');
    assert.deepEqual(error.details, { installation_id: 'wp-42', publication_count: 2 });
    return true;
  });
  assert.deepEqual(ddlCalls(queryInterface), []);
  assert.deepEqual(queryInterface.indexes, [
    index(ROUTE_INDEX, ['wordpress_installation_id', 'status', 'path']),
  ]);
});

test('down no retira el índice de ruta si falla el DDL del UNIQUE', async () => {
  const queryInterface = fakeQueryInterface({
    seedIndexes: [index(ROUTE_INDEX, ['wordpress_installation_id', 'status', 'path'])],
    failUniqueAdd: true,
  });

  await assert.rejects(
    () => migration.down(queryInterface, Sequelize),
    /simulated unique DDL failure/
  );
  assert.deepEqual(ddlCalls(queryInterface), [['addIndex', UNIQUE_INDEX]]);
  assert.deepEqual(queryInterface.indexes, [
    index(ROUTE_INDEX, ['wordpress_installation_id', 'status', 'path']),
  ]);
});
