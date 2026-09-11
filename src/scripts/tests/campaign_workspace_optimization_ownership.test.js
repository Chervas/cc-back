'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertOptimizationExecutionOwnership } = require('../../services/campaignWorkspaceOptimizationAuthorization.service');
const { Op } = require('sequelize');

function fixture() {
  const campaign = { provider: 'meta_ads', account_id: '20', campaign_id: '30' };
  const state = { clinics: [{ id_clinica: 1, grupoClinicaId: 10 }], policies: [], settings: [], calls: [], mode: 'connect_only' };
  const models = { Clinica: { findAll: async () => state.clinics },
    CampaignOptimizationPolicy: { findAll: async input => { state.calls.push(input); return state.policies; } },
    CampaignWorkspaceSetting: { findAll: async () => state.settings },
    IntakeConfig: { findOne: async () => null }, CampaignRequest: { findAll: async () => [] } };
  const run = (extra = {}) => assertOptimizationExecutionOwnership({ models, setting: { id: 'own' }, scope: { clinicIds: [1] }, campaign,
    resolveMode: async (scope, dependencies) => { assert.equal(scope.group_id, 10); assert.ok(dependencies.IntakeConfig); return { mode: state.mode }; }, ...extra });
  return { run, state, campaign };
}
test('the current effective mode and policies include the parent group, even in a single-clinic workspace', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.state.calls[0].where[Op.or][1].scopeId[Op.in], [10]);
  for (const mode of ['guided_improvement', 'managed_service', 'managed_self']) {
    f.state.mode = mode; await assert.rejects(f.run(), /contract_conflict/);
  }
});
test('active or paused legacy policies and overlapping live workspace mandates prevent new writes', async () => {
  const f = fixture(); f.state.policies = [{ id: 1 }]; await assert.rejects(f.run(), /contract_conflict/);
  f.state.policies = []; f.state.settings = [{ activation: { optimization: { authorization: { campaigns: [f.campaign] } } } }];
  await assert.rejects(f.run(), /contract_conflict/);
  f.state.settings[0].activation.optimization.authorization.campaigns[0] = { ...f.campaign, campaign_id: '31' }; await f.run();
});
test('missing clinics and unknown ownership fail closed; canonical native-only fallback is actually consulted', async () => {
  const f = fixture(); f.state.clinics = []; await assert.rejects(f.run(), /scope_changed/);
  const g = fixture(); g.state.settings = [{ activation: {} }]; await assert.rejects(g.run(), /contract_conflict/);
  const h = fixture(); await h.run({ resolveMode: undefined });
});
