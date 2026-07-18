'use strict';

const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260717211000-unique-campaign-optimization-policy-strategy');

async function testDuplicatePreflightFailsWithoutMutation() {
  let addIndexCalls = 0;
  await assert.rejects(
    () => migration.up({
      sequelize: {
        async query() { return [[{ strategy_id: 901, total: 2 }], []]; },
      },
      async showIndex() { return []; },
      async addIndex() { addIndexCalls += 1; },
    }),
    (error) => error.message.includes('901:2')
      && error.message.includes('no borra ni fusiona datos')
  );
  assert.equal(addIndexCalls, 0);
}

async function testUniqueIndexIsIdempotent() {
  const additions = [];
  const queryInterface = {
    sequelize: { async query() { return [[], []]; } },
    async showIndex() { return []; },
    async addIndex(table, fields, options) { additions.push({ table, fields, options }); },
  };
  await migration.up(queryInterface);
  assert.deepEqual(additions, [{
    table: 'CampaignOptimizationPolicies',
    fields: ['strategy_id'],
    options: { name: 'uniq_campaign_optimization_policy_strategy', unique: true },
  }]);

  let repeatedAdds = 0;
  await migration.up({
    sequelize: { async query() { return [[], []]; } },
    async showIndex() { return [{ name: 'uniq_campaign_optimization_policy_strategy' }]; },
    async addIndex() { repeatedAdds += 1; },
  });
  assert.equal(repeatedAdds, 0);
}

Promise.resolve()
  .then(testDuplicatePreflightFailsWithoutMutation)
  .then(testUniqueIndexIsIdempotent)
  .then(() => console.log('campaign_optimization_unique_strategy_migration.test.js OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
