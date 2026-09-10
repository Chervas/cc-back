'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { deliveryEvidence, loadMetaSignalEvidence, MAX_ROWS } = require('../../services/campaignWorkspaceSignalEvidence.service');
const { buildWorkspaceHealth } = require('../../services/campaignWorkspaceHealth.service');
const migration = require('../../../migrations/20260910210000-create-meta-signal-deliveries');

function harness() {
  const date = new Date('2026-09-10T18:00:00Z');
  const account = { provider: 'meta_ads', account_id: '20', campaign_ids: ['30'], include_future: false };
  const setting = { id: 'setting', scope_type: 'clinic', scope_id: 1, version: 2, accounts: [account], activation: {
    schema_version: 1, mode: 'measurement', status: 'active', signals: { enabled: true, events: ['lead', 'schedule'] }, account_authorizations: [account],
  } };
  const record = { id: 'web', assignment_scope: 'clinic', clinic_id: 1, config: {
    meta_ads: { connection_id: 7, ad_account_id: '20', pixel_id: '50' }, campaigns: {
      workspace_policy: { schema_version: 1, setting_id: setting.id, scope_type: 'clinic', scope_id: 1 },
    },
  } };
  const state = { date, setting, queries: [], rows: [{ clinic_id: 1, account_id: '20', campaign_id: '30', dataset_id: '50',
    destination_key: 'current', event_name: 'Lead', policy_refs: [{ setting_id: 'setting', scope_type: 'clinic', scope_id: 1, version: 2 }],
    status: 'accepted', attempted_at: new Date(+date - 10000), completed_at: new Date(+date - 9000) }] };
  const campaign = { id: 'meta_ads:20:30', provider: 'meta_ads', account_id: '20', campaign_id: '30', assigned: true, clinicId: 1 };
  const models = { MetaSignalDelivery: { findAll: async query => { state.queries.push(query); return state.rows; } },
    IntakeConfig: { findAll: async () => [record] }, CampaignWorkspaceSetting: { findByPk: async () => state.setting } };
  const context = async () => ({ destinationKey: 'current', webPolicyRecord: record, signalPolicyRecord: record });
  const run = extra => loadMetaSignalEvidence({ models, campaigns: [campaign], selectedClinics: [{ id_clinica: 1, grupoClinicaId: null }],
    now: state.date, context, ...extra });
  return { state, models, campaign, run };
}

test('a confirmed delivery is scoped to its campaign and does not claim attribution', async () => {
  const h = harness(); const evidence = await h.run();
  assert.equal(evidence.get(h.campaign.id).ready, true);
  assert.equal(evidence.get(h.campaign.id).received, 1);
  assert.match(evidence.get(h.campaign.id).detail, /No confirma su atribución/);
  assert.equal(h.state.queries[0].limit, MAX_ROWS + 1);
  assert.ok(h.state.queries[0].where.attempted_at);
  assert.doesNotMatch(JSON.stringify(h.state.queries[0].attributes), /trace|event_key|user_data|accessToken/);
});
test('failure, pending, timeout and warning remain visible alongside accepted deliveries', async () => {
  for (const status of ['warning', 'failed', 'pending', 'unknown', 'skipped']) {
    const h = harness(); h.state.rows.push({ ...h.state.rows[0], status });
    const evidence = (await h.run()).get(h.campaign.id);
    assert.equal(evidence.checked, true); assert.equal(evidence.ready, false); assert.match(evidence.detail, /Meta:/);
  }
});
test('an abandoned pending lease is unconfirmed rather than permanently in progress', () => {
  const h = harness(); const row = { ...h.state.rows[0], status: 'pending', attempted_at: new Date(+h.state.date - 100000) };
  assert.match(deliveryEvidence([row], h.state.date).detail, /sin confirmación/);
});
test('empty, truncated and unrecognized delivery histories never produce OK', async () => {
  const h = harness(); h.state.rows = []; assert.equal((await h.run()).size, 0);
  h.state.rows = Array.from({ length: MAX_ROWS + 1 }, () => ({})); assert.equal((await h.run()).size, 0);
  assert.equal(deliveryEvidence([]).checked, false); assert.equal(deliveryEvidence([{ status: 'made_up' }]).checked, false);
});
test('another clinic, campaign, dataset, grant, policy version or unauthorized event is not evidence', async () => {
  for (const patch of [{ clinic_id: 2 }, { account_id: '99' }, { campaign_id: '31' }, { dataset_id: '99' },
    { destination_key: 'old' }, { policy_refs: [{ setting_id: 'setting', scope_type: 'clinic', scope_id: 1, version: 1 }] },
    { policy_refs: [null] }, { event_name: 'Purchase' }, { completed_at: 'invalid' }, { completed_at: '2099-01-01' }]) {
    const h = harness(); Object.assign(h.state.rows[0], patch);
    assert.notEqual((await h.run()).get(h.campaign.id)?.ready, true);
  }
});
test('revocation and a missing current grant invalidate old green receipts', async () => {
  const h = harness(); h.state.setting.activation.signals.enabled = false;
  assert.notEqual((await h.run()).get(h.campaign.id)?.ready, true);
  h.state.setting.activation.signals.enabled = true;
  assert.notEqual((await h.run({ context: () => { throw Object.assign(new Error('revoked'), { code: 'workspace_meta_permissions_required' }); } })).get(h.campaign.id)?.ready, true);
});
test('Google and unassigned campaigns cannot borrow a Meta delivery', async () => {
  const h = harness();
  assert.equal((await h.run({ campaigns: [{ ...h.campaign, provider: 'google_ads' }, { ...h.campaign, assigned: false }] })).size, 0);
  assert.equal(h.state.queries.length, 0);
});
test('database failures are surfaced rather than silently presented as healthy', async () => {
  const h = harness();
  await assert.rejects(h.run({ context: () => { throw new Error('database unavailable'); } }), /database unavailable/);
});
test('health aggregates delivery counters while retaining missing campaign coverage', async () => {
  const h = harness(); const evidence = await h.run();
  const report = buildWorkspaceHealth({ period: { end: '2026-09-09' }, rows: [h.campaign, { ...h.campaign, id: 'meta_ads:20:31', campaign_id: '31' }]
    .map(campaign => ({ campaign, coverage: {}, ads: [], performance: 'insufficient' })) },
  new Map([...evidence].map(([id, signals]) => [id, { signals }])), h.state.date);
  const block = report.healthBlocks.find(row => row.id === 'signals');
  assert.equal(block.status, 'Datos parciales'); assert.equal(block.checks.find(row => row.label === 'Recibidos por Meta').value, '1');
  assert.equal(block.checks.find(row => row.label === 'Cobertura').value, '1 de 2');
});

function schemaFixture() {
  const state = { columns: null, indexes: [], rows: 0, creates: 0, drops: 0 };
  const qi = { showAllTables: async () => state.columns ? ['MetaSignalDeliveries'] : [],
    createTable: async (_, columns) => {
      state.creates++;
      state.columns = Object.fromEntries(Object.entries(columns).map(([key, column]) => {
        const type = typeof column.type === 'function' ? column.type() : column.type;
        return [key, { ...column, type: type.values ? `ENUM(${type.values.map(value => `'${value}'`).join(',')})` : String(type) }];
      }));
    }, describeTable: async () => state.columns, showIndex: async () => state.indexes,
    addIndex: async (_, fields, options) => state.indexes.push({ ...options, fields: fields.map(attribute => ({ attribute })) }),
    sequelize: { query: async () => [[{ count: state.rows }]] }, dropTable: async () => { state.drops++; state.columns = null; },
  };
  return { state, qi };
}
test('the delivery migration is additive, resumable and validates the complete contract', async () => {
  const h = schemaFixture(); await migration.up(h.qi, Sequelize); await migration.up(h.qi, Sequelize);
  assert.equal(h.state.creates, 1); assert.equal(h.state.indexes.length, 2);
  h.state.columns.policy_refs.type = 'TEXT'; await assert.rejects(migration.up(h.qi, Sequelize), /incompatible column/);
  h.state.columns.policy_refs.type = 'JSON'; delete h.state.columns.destination_key;
  await assert.rejects(migration.up(h.qi, Sequelize), /missing column/);
});
test('the delivery migration refuses a conflicting unique index and a populated rollback', async () => {
  const h = schemaFixture(); await migration.up(h.qi, Sequelize);
  h.state.indexes[0].unique = false; await assert.rejects(migration.up(h.qi, Sequelize), /Incompatible/);
  h.state.rows = 1; await assert.rejects(migration.down(h.qi), /archival/); assert.equal(h.state.drops, 0);
  h.state.rows = 0; await migration.down(h.qi); await migration.down(h.qi); assert.equal(h.state.drops, 1);
});
