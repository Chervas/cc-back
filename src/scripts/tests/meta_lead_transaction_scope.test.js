'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = require.resolve('../../services/metaMarketingBrokerScope.service'), localRequire = createRequire(filename);
function fixture(transaction = null) {
  const calls = [], transactions = [], committed = [];
  const models = Object.fromEntries(['ClinicMetaAsset', 'MetaMarketingBrokerRevocation', 'MetaMarketingBrokerBinding', 'Clinica',
    'GroupAssetClinicAssignment', 'GrupoClinica', 'MetaConnectionAssignment', 'MetaConnection'].map(name => [name, {
    findAll: async options => { calls.push({ name, options }); return []; },
    findByPk: async (id, options) => { calls.push({ name, options }); return null; },
  }]));
  models.sequelize = { transaction: async (options, work) => { transactions.push(options); return work({ fixture: true }); } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process, structuredClone,
    require: name => name === './metaMarketingEnrollmentBinding.service' ? { createBindings: () => ({ committed: async (id, tx) => { committed.push(tx); return {}; } }) }
      : name === './metaScopeBlock.service' ? { blocked: async (_scope, options) => { calls.push({ name: 'blocked', options }); return false; } } : localRequire(name) }, { filename });
  return { repository: module.exports.createMetaMarketingScopeRepository(() => models, { transaction }), calls, transactions, committed };
}
test('every transaction-bound metadata read and enrollment validation uses the caller transaction', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } }, f = fixture(transaction), r = f.repository;
  await r.loadMapping(1); await r.loadRevocations('meta-facebook_page:200'); await r.loadBindings(null, 1);
  await r.loadMappings({ kind: 'facebook_page', id: '200' }); await r.loadClinics({ assignmentScope: 'group', groupId: 28 });
  await r.loadShared('facebook_page', [1]); await r.loadPrimaryGroups('facebook_page', [1]); await r.loadGrants([1], [28]);
  await r.loadConnection(1, '800'); await r.blocked({ assignmentScope: 'group', groupId: 28 }); await r.inspectEnrollment('id');
  assert.equal(f.transactions.length, 0); assert.equal(f.committed[0], transaction);
  for (const call of f.calls) { assert.equal(call.options.transaction, transaction); if (call.name !== 'blocked') assert.equal(call.options.lock, 'UPDATE'); }
});
test('default scope repository keeps its own enrollment transaction and original read options', async () => {
  const f = fixture(); await f.repository.loadMapping(1); await f.repository.inspectEnrollment('id');
  assert(!Object.hasOwn(f.calls[0].options, 'transaction')); assert(!Object.hasOwn(f.calls[0].options, 'lock'));
  assert.equal(f.transactions.length, 1); assert.equal(f.transactions[0].isolationLevel, 'REPEATABLE READ');
});
