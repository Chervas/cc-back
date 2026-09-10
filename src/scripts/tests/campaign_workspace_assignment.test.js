'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assignWorkspaceCampaign, assignmentClinics } = require('../../services/campaignWorkspaceAssignment.service');

function fixture() {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } }; const writes = [];
  const clinics = [1, 2].map(id => ({ id_clinica: id, nombre_clinica: `Clinic ${id}`, estado_clinica: true }));
  const state = { assignments: [], auditFails: false, existing: null, authorized: true };
  const campaign = { provider: 'meta_ads', account_id: '123', campaign_id: '456', name: 'Primera visita', assigned: false };
  const setting = { version: 2, accounts: [{ provider: 'meta_ads', account_id: '123', include_future: true, campaign_ids: [] }] };
  const assertTransaction = options => { assert.equal(options.transaction, transaction); assert.equal(options.lock, 'UPDATE'); };
  const models = {
    sequelize: { transaction: async fn => { try { return await fn(transaction); } catch (error) { writes.length = 0; throw error; } } },
    GrupoClinica: { findByPk: async (_, options) => { assertTransaction(options); return {}; } },
    Clinica: { findAll: async options => { assertTransaction(options); return clinics; } },
    CampaignWorkspaceSetting: { findOne: async options => { assertTransaction(options); return setting; } },
    ExternalCampaignAssignment: {
      findAll: async options => { assertTransaction(options); return state.assignments; },
      findOne: async options => { assertTransaction(options); return state.existing; },
      create: async (values, options) => { assert.equal(options.transaction, transaction); writes.push(values); return { id: 5, ...values }; },
    },
    ExternalCampaignAssignmentAudit: { create: async (values, options) => {
      assert.equal(options.transaction, transaction); if (state.auditFails) throw new Error('audit_failure'); writes.push(values);
    } },
  };
  const input = { provider: 'meta_ads', account_id: '123', campaign_id: '456', clinic_id: 2, expected_version: 2, confirmed: true };
  const options = { models, scope: { groupId: 28, clinicIds: [1, 2] }, actorId: 7, input,
    loadInventory: async value => { assert.equal(value.transaction, transaction); return { campaigns: [campaign] }; },
    accountScope: async value => { assert.equal(value.models, models); assert.equal(value.transaction, transaction); assert.equal(value.lock, true); return state.authorized ? {} : null; },
  };
  return { models, options, input, clinics, campaign, setting, state, writes, run: extra => assignWorkspaceCampaign({ ...options, ...extra }) };
}

test('first clinic assignment uses the existing external identity and writes an atomic decision and audit', async () => {
  const f = fixture(); const response = await f.run();
  assert.equal(response.assignment.clinic_id, 2); assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].provider, 'meta_ads'); assert.equal(f.writes[0].customer_id, '123');
  assert.equal(f.writes[0].campaign_request_id, undefined); assert.equal(f.writes[0].strategy_campaign_id, undefined);
  assert.equal(f.writes[0].approved_by_user_id, 7);
  assert.equal(f.writes[1].event_type, 'clinic_assigned'); assert.equal(f.writes[1].from_version, 0);
  assert.equal(f.writes[1].changes.clinica_id.after, 2);
});
test('the same assignment command works with a canonical Google campaign identity', async () => {
  const f = fixture(); f.input.provider = f.campaign.provider = f.setting.accounts[0].provider = 'google_ads';
  await f.run(); assert.equal(f.writes[0].provider, 'google_ads');
});
test('invalid payloads, unconfirmed writes and non-group scopes fail without writes', async () => {
  for (const patch of [{ confirmed: false }, { actorId: 9 }, { clinic_id: '2' }, { account_id: 'act_123' }, { campaign_id: '' }]) {
    const f = fixture(); await assert.rejects(f.run({ input: { ...f.input, ...patch } }), /invalid_workspace_assignment/); assert.equal(f.writes.length, 0);
  }
  const f = fixture(); await assert.rejects(f.run({ scope: { clinicIds: [2] } }), /workspace_assignment_group_required/);
  await assert.rejects(f.run({ actorId: 0 }), /unauthenticated/);
});
test('new group members, inactive clinics and foreign target clinics require a fresh authorized scope', async () => {
  const f = fixture(); f.clinics.push({ id_clinica: 3, estado_clinica: true });
  await assert.rejects(f.run(), /workspace_assignment_scope_changed/);
  f.clinics.pop(); f.clinics[1].estado_clinica = false;
  await assert.rejects(f.run(), /workspace_assignment_clinic_forbidden/);
  f.input.clinic_id = 99; await assert.rejects(f.run(), /workspace_assignment_clinic_forbidden/);
});
test('revoked account access, stale selection and invisible campaigns cannot be assigned', async () => {
  const f = fixture(); f.state.authorized = false;
  await assert.rejects(f.run(), /workspace_assignment_account_forbidden/);
  f.state.authorized = true; f.input.expected_version = 1;
  await assert.rejects(f.run(), /workspace_version_conflict/);
  f.input.expected_version = 2; f.setting.accounts = [];
  await assert.rejects(f.run(), /workspace_assignment_campaign_unavailable/);
});
test('existing assignments, archived decisions and formatted account aliases are never reactivated or moved implicitly', async () => {
  for (const prior of [{ customer_id: 'act_123', status: 'archived' }, { status: 'active', campaign_request_id: 9 }]) {
    const f = fixture(); f.state.assignments = [prior];
    await assert.rejects(f.run(), /workspace_assignment_already_reviewed/); assert.equal(f.writes.length, 0);
  }
  const f = fixture(); f.campaign.assigned = true;
  await assert.rejects(f.run(), /workspace_assignment_already_reviewed/);
});
test('a concurrent reviewed decision cannot be overwritten by the shared persistence helper', async () => {
  const f = fixture(); f.state.existing = { grupo_clinica_id: 28, clinica_id: 1 };
  await assert.rejects(f.run(), /workspace_assignment_already_reviewed/); assert.equal(f.writes.length, 0);
});
test('audit failure rolls back the assignment', async () => {
  const f = fixture(); f.state.auditFails = true;
  await assert.rejects(f.run(), /audit_failure/); assert.equal(f.writes.length, 0);
});
test('clinic choices exclude disabled and test clinics without exposing other fields', () => {
  assert.deepEqual(assignmentClinics([{ id_clinica: 2, nombre_clinica: 'Clinic', estado_clinica: true, secret: 'no' },
    { id_clinica: 3, nombre_clinica: 'Test demo', estado_clinica: true }, { id_clinica: 4, estado_clinica: false }]), [{ id: 2, name: 'Clinic' }]);
});
