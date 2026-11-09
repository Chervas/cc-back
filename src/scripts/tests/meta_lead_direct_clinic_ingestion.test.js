'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { brokerPairsForPage, runMetaLeadReceptionJob } = require('../../services/metaLeadReception.service');
const { loadRoute } = require('../../services/metaLeadRoutes.service');
const { createMetaMarketingLeadReader } = require('../../services/metaMarketingLeadReader.service');
const receiptRef = '11111111-1111-4111-8111-111111111111';
// Only clinic95 is intentionally shared with the rollout label. Every provider
// identity, enrollment, receipt, contact and transport below is fictitious.
function fixture(registry) {
  const state = { calls: [], leads: [], audits: [], forms: [], notices: [], workspace: { id: 'fixture-setting', version: 1,
    scope_type: 'clinic', scope_id: 95, preferences: registry === undefined ? {} : { meta_lead_routes: registry } },
    mappings: [
      { id: 10, assetType: 'facebook_page', metaAssetId: '501', metaConnectionId: 12, assignmentScope: 'clinic', clinicaId: 95, grupoClinicaId: null },
      { id: 11, assetType: 'ad_account', metaAssetId: '601', metaConnectionId: 12, assignmentScope: 'clinic', clinicaId: 95, grupoClinicaId: null },
      { id: 13, assetType: 'facebook_page', metaAssetId: '502', metaConnectionId: 12, assignmentScope: 'clinic', clinicaId: 95, grupoClinicaId: null },
    ], foreignScope: false, organic: true };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    ClinicMetaAsset: { findAll: async ({ where }) => state.mappings.filter(row => row.assetType === where.assetType && where.metaAssetId[Op.in].includes(row.metaAssetId)) },
    MetaMarketingBrokerBinding: { findAll: async ({ where }) => where.mapping_id
      ? [{ mapping_id: where.mapping_id, enrollment_id: receiptRef, scope_key: 'clinic:95', connection_ref: 'fixture-enrollment' }]
      : state.mappings.map(row => ({ mapping_id: row.id, asset_ref: 'meta-' + row.assetType + ':' + row.metaAssetId })) },
    CampaignWorkspaceSetting: { findOne: async ({ where }) => { assert.deepEqual(where, { scope_type: 'clinic', scope_id: 95 });return state.workspace; },
      findAll: async () => state.workspace ? [state.workspace] : [] },
    ExternalCampaignAssignment: { findAll: async () => [] },
    Clinica: { findByPk: async id => id === 95 ? { id_clinica: 95, grupoClinicaId: null, estado_clinica: 1 } : null },
    LeadIntake: { findOne: async ({ where }) => state.leads.find(lead => lead.external_id === where.external_id), create: async row => { const lead = { id: state.leads.length + 1, ...row };state.leads.push(lead);return lead; } },
    LeadAttributionAudit: { create: async row => state.audits.push(row) },
    FormSubmissionEvent: {
      findAll: async ({ where }) => state.forms.filter(row => row.lead_intake_id === where.lead_intake_id && row.source_detail === where.source_detail),
      create: async input => { const row = { id: state.forms.length + 1, ...input };state.forms.push(row);return row; },
    },
    sequelize: { transaction: async fn => fn(transaction) },
  };
  const metadata = mappingId => {
    const row = state.mappings.find(row => row.id === mappingId);
    return { mappingId, kind: row.assetType, id: row.metaAssetId, assetRef: 'meta-' + row.assetType + ':' + row.metaAssetId,
      connectionId: 12, connectionRef: 'fixture-enrollment', appId: '701', subjectId: '801',
      enrollmentId: receiptRef, enrollmentHash: 'fictitious-active-enrollment', scopeKey: state.foreignScope ? 'clinic:96' : 'clinic:95', tenantRef: 'clinic:95', clinicIds: [95] };
  };
  const reader = createMetaMarketingLeadReader({ enabled: () => true,
    scope: { prepare: async mappingId => ({ mappingId }), assertContext: async context => metadata(context.mappingId) },
    transactionStates: async (pageId, accountId) => ({ page: metadata(pageId), account: metadata(accountId) }),
    loadRoute: (page, account, transaction) => loadRoute({ models, page, account, transaction }),
    client: { execute: async command => {
      state.calls.push(command);assert.equal(command.operation, 'meta.marketing.leads.receipt.read.v1');assert.equal(command.tenantRef, 'clinic:95');
      assert.deepEqual(command.payload, { receiptRef, responseVersion: 2, adAccountAssetRef: 'meta-ad_account:601' });
      const pageId = command.assetRef.split(':')[1], event = state.event;
      assert.equal(event.page_id, pageId);
      return { requestId: command.requestId, data: { event, recipientClinicId: null,
        lead: { id: event.lead_id, form_id: event.form_id, ad_id: event.ad_id, campaign_id: state.organic ? null : '901',
          created_time: '2026-01-01T00:00:00Z', is_organic: state.organic,
          field_data: [{ name: 'email', values: ['fixture@example.invalid'] }] },
        identity: state.organic ? null : { account_id: '601', campaign_id: '901', ad_id: event.ad_id, adset_id: '902' },
        form_response: { version: 2, formId: event.form_id, name: 'Fictitious native form',
          fields: [{ key: 'email', label: 'Email', type: 'EMAIL', values: ['fixture@example.invalid'] }] },
        usage: { usagePct: 1, nextAllowedAt: 0, pauseUntil: 0 } } };
    } },
  });
  const ingest = async pageId => {
    state.event = { lead_id: pageId === '501' ? '1001' : '1002', page_id: pageId, form_id: '1101', ad_id: state.organic ? null : '1201' };
    const selected = (await brokerPairsForPage(models, pageId, reader))[0];
    assert.equal((await reader.assertPair(selected.pair)).route.recipientClinicId, null);
    const result = await runMetaLeadReceptionJob({ ...state.event, receipt_ref: receiptRef,
      page_asset_id: selected.pageAssetId, account_asset_id: selected.accountAssetId }, null,
    { models, reader, notify: async notice => state.notices.push(notice) });
    return { selected, result };
  };
  return { state, models, reader, ingest };
}
test('direct clinic95 with absent registry pairs each selected Page to its one account and ingests organic forms through null-recipient fallback', async () => {
  const f = fixture();
  assert(!Object.hasOwn(f.state.workspace.preferences, 'meta_lead_routes'));
  for (const pageId of ['501', '502']) {
    const { selected, result } = await f.ingest(pageId);
    assert.equal(selected.accountAssetId, 11);assert.equal(result.status, 'completed');
  }
  assert.deepEqual(f.state.leads.map(lead => lead.clinica_id), [95, 95]);assert.equal(f.state.audits.length, 2);
  assert.equal(f.state.notices.length, 2);assert.equal(f.state.calls.length, 2);
});
test('paid receipt without a campaign assignment uses the exact direct-clinic account and retains clinic95', async () => {
  const f = fixture();f.state.workspace = null;f.state.organic = false;
  const { result } = await f.ingest('501');assert.equal(result.status, 'completed');
  assert.equal(f.state.leads[0].clinica_id, 95);assert.equal(f.state.leads[0].source, 'meta_ads');assert.equal(f.state.leads[0].channel, 'paid');
});
test('explicit empty registry remains closed even with one enrolled account and multiple Pages', async () => {
  const f = fixture([]);
  for (const pageId of ['501', '502']) await assert.rejects(brokerPairsForPage(f.models, pageId, f.reader), /meta_lead_account_access_required/);
  assert.equal(f.state.calls.length, 0);assert.equal(f.state.leads.length, 0);
});
test('a second account or foreign direct-clinic Page never guesses a recipient or creates a lead', async () => {
  const f = fixture();f.state.mappings.push({ ...f.state.mappings[1], id: 14, metaAssetId: '602' });
  await assert.rejects(brokerPairsForPage(f.models, '501', f.reader), /meta_lead_account_access_required/);assert.equal(f.state.calls.length, 0);
  const foreign = fixture();foreign.state.mappings[0].clinicaId = 96;
  const { result } = await foreign.ingest('501');assert.equal(result.status, 'failed');assert.equal(result.error_message, 'meta_lead_clinic_scope_mismatch');
  assert.equal(foreign.state.leads.length, 0);assert.equal(foreign.state.notices.length, 0);
});
