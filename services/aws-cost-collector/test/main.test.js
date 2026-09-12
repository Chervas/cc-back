'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { ACCOUNT, ROLE, BUDGET } = require('../src/report');
test('AWS bootstrap uses only the dedicated assumed role and a fixed read-only command surface', async () => {
  const called = []; const configured = []; const providers = [];
  const command = name => class { constructor(input) { this.name = name; this.input = input; } };
  class Client {
    constructor(config) { configured.push(config); }
    async send(cmd) {
      called.push(cmd);
      switch (cmd.name) {
        case 'identity': return { Account: ACCOUNT, Arn: 'arn:aws:sts::' + ACCOUNT + ':assumed-role/clinicaclick-integrations-prod-cost-reader-role/fixture' };
        case 'tags': return { CostAllocationTags: ['application', 'component', 'environment'].map(TagKey => ({ TagKey, Status: 'Active' })) };
        case 'usage': return { ResultsByTime: [] };
        case 'forecast': return { Total: { Amount: '1', Unit: 'USD' } };
        case 'budget': return { Budget: { BudgetName: BUDGET, BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '60', Unit: 'USD' } } };
        default: assert.fail('Unexpected AWS operation');
      }
    }
    destroy() { providers.push('destroy'); }
  }
  const master = async () => ({ fixture: true }); const assumed = async () => ({ fixture: true });
  const overrides = {
    '@aws-sdk/credential-providers': {
      fromInstanceMetadata: config => { providers.push(['imds', config]); return master; },
      fromTemporaryCredentials: config => { assert.equal(config.masterCredentials, master); assert.equal(config.params.RoleArn, ROLE);
        assert.equal(config.params.DurationSeconds, 900); providers.push('assume'); return assumed; },
    },
    '@aws-sdk/client-sts': { STSClient: Client, GetCallerIdentityCommand: command('identity') },
    '@aws-sdk/client-cost-explorer': { CostExplorerClient: Client, GetCostAndUsageCommand: command('usage'),
      GetCostForecastCommand: command('forecast'), ListCostAllocationTagsCommand: command('tags') },
    '@aws-sdk/client-budgets': { BudgetsClient: Client, DescribeBudgetCommand: command('budget') },
  };
  const filename = path.resolve(__dirname, '../src/main.js'); const localRequire = createRequire(filename); const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name) }, { filename });
  const snapshot = await module.exports.run({ accountId: ACCOUNT, roleArn: ROLE, environment: 'prod', month: new Date().toISOString().slice(0, 7) });
  assert.equal(snapshot.status, 'pending'); assert.equal(called[0].name, 'identity');
  assert(configured.every(config => config.credentials === assumed && config.maxAttempts === 2));
  assert.deepEqual(configured.map(config => config.region), ['eu-west-3', 'us-east-1', 'us-east-1']);
  assert.equal(providers.filter(value => value === 'destroy').length, 3);
  assert(called.every(cmd => ['identity', 'tags', 'usage', 'forecast', 'budget'].includes(cmd.name)));
});
