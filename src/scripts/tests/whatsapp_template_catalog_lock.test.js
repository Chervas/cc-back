#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  acquireWabaCatalogCreationLease,
} = require('../../lib/waba-catalog-creation-lease');

function buildHarness({ acquired }) {
  const queries = [];
  const releasedConnections = [];
  const destroyedConnections = [];
  const connection = {
    promise() {
      return {
        async query(sql, values) {
          queries.push({ sql, values });
          if (sql.includes('GET_LOCK')) return [[{ acquired }]];
          if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
          return [[]];
        },
      };
    },
  };
  const connectionManager = {
    async getConnection() {
      return connection;
    },
    async releaseConnection(value) {
      releasedConnections.push(value);
    },
    async destroyConnection(value) {
      destroyedConnections.push(value);
    },
  };
  const sequelizeInstance = {
    connectionManager,
    getDialect() {
      return 'mysql';
    },
  };
  return {
    connectionManager,
    sequelizeInstance,
    queries,
    releasedConnections,
    destroyedConnections,
  };
}

test('serializa la creacion de catalogo por WABA y libera el advisory lock', async () => {
  const harness = buildHarness({ acquired: 1 });
  const lease = await acquireWabaCatalogCreationLease(
    '102043429223140',
    {
      sequelizeInstance: harness.sequelizeInstance,
      connectionManager: harness.connectionManager,
      waitSeconds: 7,
    }
  );

  assert.equal(lease.acquired, true);
  assert.equal(harness.queries.length, 1);
  assert.match(harness.queries[0].sql, /GET_LOCK/);
  assert.deepEqual(harness.queries[0].values, ['cc:wa:catalog:102043429223140', 7]);

  await lease.release();
  await lease.release();

  assert.equal(harness.queries.length, 2);
  assert.match(harness.queries[1].sql, /RELEASE_LOCK/);
  assert.equal(harness.releasedConnections.length, 1);
  assert.equal(harness.destroyedConnections.length, 0);
});

test('una creacion concurrente no entra en Meta si otro proceso tiene el WABA', async () => {
  const harness = buildHarness({ acquired: 0 });
  const lease = await acquireWabaCatalogCreationLease(
    '102043429223140',
    {
      sequelizeInstance: harness.sequelizeInstance,
      connectionManager: harness.connectionManager,
      waitSeconds: 0,
    }
  );

  assert.equal(lease.acquired, false);
  assert.equal(lease.reason, 'contended');
  assert.equal(harness.releasedConnections.length, 1);
  assert.equal(harness.destroyedConnections.length, 0);
});
