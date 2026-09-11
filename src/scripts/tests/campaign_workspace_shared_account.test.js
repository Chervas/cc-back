'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { loadSharedAccountReview, assignSharedAccountCampaigns } = require('../../services/campaignWorkspaceSharedAccount.service');

function fixture() {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const scope = { groupId: 10, clinicIds: [1, 2] };
  const state = { permitted: true, authorized: true, access: [], broadReads: 0, assignments: [], audits: [], rollback: false,
    clinics: [{ id_clinica: 1, grupoClinicaId: 10, nombre_clinica: 'Centro', estado_clinica: true },
      { id_clinica: 2, grupoClinicaId: 10, nombre_clinica: 'Norte', estado_clinica: true },
      { id_clinica: 3, grupoClinicaId: 20, nombre_clinica: 'Private other clinic', estado_clinica: true }],
    owners: [{ id: 1, assignmentScope: 'group', grupoClinicaId: 10, googleConnectionId: 7 },
      { id: 2, assignmentScope: 'clinic', clinicaId: 3, googleConnectionId: 8 }],
    campaigns: Array.from({ length: 12 }, (_, i) => ({ provider: 'google_ads', account_id: '20', campaign_id: String(i + 100), name: `Campaign ${String(i + 1).padStart(2, '0')}`,
      assigned: false, paused: false, urls: ['https://private.example/'], privateField: 'must-not-leak' })),
    setting: { id: 'setting', version: 1, accounts: [{ provider: 'google_ads', account_id: '20', include_future: true, campaign_ids: [] }] },
  };
  const models = {
    sequelize: { transaction: async callback => {
      const before = structuredClone({ assignments: state.assignments, audits: state.audits });
      try { return await callback(transaction); }
      catch (error) { state.assignments = before.assignments; state.audits = before.audits; state.rollback = true; throw error; }
    } },
    GrupoClinica: { findByPk: async id => ({ id_grupo: id }) },
    Clinica: { findByPk: async id => state.clinics.find(row => row.id_clinica === id), findAll: async options => {
      if (options.where.grupoClinicaId) return state.clinics.filter(row => row.grupoClinicaId === options.where.grupoClinicaId);
      if (options.where.id_clinica) return state.clinics.filter(row => row.id_clinica === options.where.id_clinica);
      return state.clinics.filter(row => options.where[Op.or].some(clause => clause.id_clinica?.[Op.in]?.includes(row.id_clinica)
        || clause.grupoClinicaId?.[Op.in]?.includes(row.grupoClinicaId)));
    } },
    ClinicGoogleAdsAccount: { findAll: async input => {
      assert.ok(input.attributes.includes('googleConnectionId'));
      assert.deepEqual(input.where.customerId[Op.in], ['20', 'act_20']);
      return state.owners;
    } },
    ClinicMetaAsset: { findAll: async input => {
      assert.ok(input.attributes.includes('metaConnectionId'));
      assert.equal(input.where.assetType, 'ad_account');
      assert.deepEqual(input.where.metaAssetId[Op.in], ['20', 'act_20']);
      return state.owners;
    } },
    CampaignWorkspaceSetting: { findOne: async () => state.setting },
    ExternalCampaignAssignment: {
      findAll: async options => state.assignments.filter(row => row.campaign_id === options.where.campaign_id
        && options.where.customer_id[Op.in].includes(row.customer_id)),
      findOne: async options => state.assignments.find(row => row.campaign_id === options.where.campaign_id),
      create: async (values, options) => { assert.equal(options.transaction, transaction); const row = { id: state.assignments.length + 1, ...values }; state.assignments.push(row); return row; },
    },
    ExternalCampaignAssignmentAudit: { create: async (values, options) => {
      assert.equal(options.transaction, transaction); if (state.failAudit) throw new Error('audit_failed'); state.audits.push(values); return values;
    } },
  };
  const options = { models, scope, actorId: 9, hasAccess: async input => { state.access.push(input); return state.permitted && !(state.revokeAfterRead && state.broadReads); },
    loadInventory: async input => {
      assert.deepEqual(input.accountReference, { provider: state.provider || 'google_ads', account_id: '20' });
      const broad = input.scope.clinicIds.includes(3); if (broad) state.broadReads++;
      return { accounts: state.unmapped ? [] : [{ provider: state.provider || 'google_ads', id: '20', name: 'Shared account' }],
        campaigns: broad ? state.campaigns : [] };
    },
    accountScope: async () => state.authorized ? { account: { selectable: true } } : null,
    now: () => new Date('2026-09-11T12:00:00Z'),
  };
  const reference = () => ({ provider: state.provider || 'google_ads', account_id: '20' });
  return { state, options, read: extra => loadSharedAccountReview({ ...options, input: reference(), ...extra }),
    write: (review, patch = {}) => assignSharedAccountCampaigns({ ...options, input: { ...reference(), revision: review.revision,
      clinic_id: 1, campaigns: review.campaigns.slice(0, 2).map(row => ({ campaign_id: row.campaign_id, revision: row.revision })), confirmed: true, ...patch } }) };
}

test('account review is paginated and exposes only unassigned campaign labels and clinics in the requested scope', async () => {
  const f = fixture(); const result = await f.read();
  assert.equal(result.total, 12); assert.equal(result.campaigns.length, 10); assert.equal((await f.read({ page: 2 })).campaigns.length, 2);
  assert.equal((await f.read({ search: 'campaign 12' })).campaigns[0].campaign_id, '111');
  assert.deepEqual(result.clinics.map(row => row.id), [1, 2]);
  assert.doesNotMatch(JSON.stringify(result), /Private other clinic|privateField|must-not-leak|private.example|googleConnectionId/);
  assert.deepEqual(f.state.access[0].clinicIds, [1, 2, 3]); assert.equal(f.state.access[0].access, 'write');
});
test('a user missing permission on any owner never receives the expanded account inventory', async () => {
  const f = fixture(); f.state.permitted = false;
  await assert.rejects(f.read(), { code: 'workspace_shared_account_access_required', status: 403 });
  assert.equal(f.state.broadReads, 0);
});
test('every group-owner member, including inactive clinics, is checked before widening the review', async () => {
  const f = fixture(); f.state.owners[1] = { id: 2, assignmentScope: 'group', grupoClinicaId: 20, googleConnectionId: 8 };
  f.state.clinics.push({ id_clinica: 4, grupoClinicaId: 20, estado_clinica: false });
  await f.read(); assert.deepEqual(f.state.access[0].clinicIds, [1, 2, 3, 4]);
});
test('permission revocation during a read fails closed, even after loading the account metadata', async () => {
  const f = fixture(); f.state.revokeAfterRead = true;
  await assert.rejects(f.read(), { code: 'workspace_shared_account_access_required' });
});
test('assignment reuses audited records atomically, without creating a campaign, changing selection or enabling delivery', async () => {
  const f = fixture(); const result = await f.read(); const before = structuredClone(f.state.setting);
  assert.deepEqual(await f.write(result), { success: true, assigned: 2, included: 2 });
  assert.equal(f.state.assignments.length, 2); assert.equal(f.state.audits.length, 2);
  assert.ok(f.state.assignments.every(row => row.clinica_id === 1 && row.grupo_clinica_id === 10 && row.approved_by_user_id === 9));
  assert.deepEqual(f.state.setting, before);
});
test('account selection stays separate: assigning an excluded campaign does not include or activate it', async () => {
  const f = fixture(); f.state.setting.accounts[0].include_future = false;
  const result = await f.read(); assert.equal(result.campaigns[0].included, false);
  assert.equal((await f.write(result)).included, 0); assert.deepEqual(f.state.setting.accounts[0].campaign_ids, []);
});
test('changed ownership, scope membership, setting or selected campaign invalidates the reviewed command', async () => {
  for (const mutate of [f => { f.state.owners[1].googleConnectionId = 99; }, f => { f.state.setting.version++; },
    f => { f.state.campaigns[0].name = 'Renamed'; }, f => { f.state.clinics[1].grupoClinicaId = 20; }]) {
    const f = fixture(); const result = await f.read(); mutate(f);
    await assert.rejects(f.write(result), /workspace_shared_account_changed|workspace_assignment_scope_changed/);
    assert.equal(f.state.assignments.length, 0);
  }
});
test('new unrelated campaigns do not invalidate the campaign identities explicitly reviewed', async () => {
  const f = fixture(); const result = await f.read(); f.state.campaigns.push({ ...f.state.campaigns[0], campaign_id: '999', name: 'New campaign' });
  assert.equal((await f.write(result)).assigned, 2);
});
test('previous assignments and failures in the audit roll back the whole batch', async () => {
  for (const fail of ['prior', 'audit']) {
    const f = fixture(); const result = await f.read();
    if (fail === 'prior') f.state.assignments.push({ id: 99, campaign_id: result.campaigns[1].campaign_id, customer_id: 'act_20', clinica_id: 3 });
    else f.state.failAudit = true;
    const before = structuredClone(f.state.assignments); await assert.rejects(f.write(result));
    assert.deepEqual(f.state.assignments, before); assert.equal(f.state.audits.length, 0); assert.equal(f.state.rollback, true);
  }
});
test('single-clinic scopes use their own eligible target, and Meta uses the same workflow', async () => {
  const f = fixture(); f.options.scope = { clinicIds: [1] }; f.state.provider = 'meta_ads';
  f.state.owners.forEach(row => { row.metaConnectionId = row.googleConnectionId; delete row.googleConnectionId; });
  f.state.campaigns.forEach(row => { row.provider = 'meta_ads'; });
  const result = await f.read(); assert.deepEqual(result.clinics.map(row => row.id), [1]);
  f.state.owners[1].metaConnectionId = 99;
  await assert.rejects(f.write(result), { code: 'workspace_shared_account_changed' });
  assert.equal(f.state.assignments.length, 0);
  await f.write(await f.read()); assert.ok(f.state.assignments.every(row => row.provider === 'meta_ads' && row.clinica_id === 1));
});
test('unknown owners, missing account grants and unmapped account IDs cannot be reviewed', async () => {
  for (const mutate of [f => { f.state.owners[1].clinicaId = null; }, f => { f.state.owners[1].clinicaId = 999; },
    f => { f.state.authorized = false; }, f => { f.state.unmapped = true; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.read()); assert.equal(f.state.broadReads, 0);
  }
});
test('commands reject extra fields, foreign clinics, duplicate identities, and altered revisions', async () => {
  const f = fixture(); const result = await f.read();
  for (const patch of [{ token: 'forged' }, { confirmed: false }, { clinic_id: 3 }, { revision: 'a'.repeat(64) },
    { campaigns: [] }, { campaigns: [result.campaigns[0], result.campaigns[0]] }]) await assert.rejects(f.write(result, patch));
  for (const options of [{ input: { provider: 'other', account_id: '20' } }, { page: -1 }, { search: 'x'.repeat(101) }]) await assert.rejects(f.read(options));
  assert.equal(f.state.assignments.length, 0);
});
