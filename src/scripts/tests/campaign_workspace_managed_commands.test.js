'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../../controllers/managedCampaigns.controller.js');
const realRequire = createRequire(filename);

function fixture({ allowed = true, existing = null } = {}) {
  const writes = []; const access = []; const rows = existing ? [existing] : [];
  const models = {
    sequelize: { transaction: async operation => operation({ LOCK: { UPDATE: 'UPDATE' } }) },
    Clinica: { findByPk: async id => ({ id_clinica: id, nombre_clinica: 'Test clinic', grupoClinicaId: 28 }) },
    CampaignRequest: {},
    ManagedCampaign: {
      findOne: async () => rows[0] || null, findByPk: async () => rows[0] || null,
      findAll: async () => rows,
      create: async value => { writes.push({ kind: 'campaign', value }); rows.push(value); return value; },
      update: async value => { writes.push({ kind: 'update', value }); Object.assign(rows[0], value); return [1]; },
    },
    ManagedCampaignFundingAccount: { create: async value => { writes.push({ kind: 'funding', value }); return value; } },
  };
  const output = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports: output, require: name => {
    if (name === 'express-async-handler') return fn => fn;
    if (name === '../../models') return models;
    if (name === '../lib/marketingScopeAccess') return { hasMarketingClinicScopeAccess: async request => { access.push(request); return allowed; } };
    return realRequire(name);
  }, URL, console, Buffer, process }, { filename });
  async function invoke(name, { body = {}, query = {}, params = {}, user = 3 } = {}) {
    const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
      set(key, value) { this.headers[key] = value; return this; }, json(value) { this.body = value; return this; } };
    await output[name]({ body, query, params, userData: { userId: user } }, res);
    return res;
  }
  return { invoke, writes, access };
}
const input = { clinica_id: 1, global_plan: { quote_version: 'global-managed-v1', investment: 650, goal: 'Conseguir nuevas primeras visitas' } };

test('managed quote requires a session and scope access, and cannot write', async () => {
  const f = fixture();
  assert.equal((await f.invoke('getGlobalManagedQuote', { query: { clinica_id: 1, investment: 650 }, user: null })).statusCode, 401);
  const res = await f.invoke('getGlobalManagedQuote', { query: { clinica_id: 1, investment: 650 } });
  assert.equal(res.body.quote.total, 1254); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(f.access[0].access, 'read'); assert.equal(f.writes.length, 0);
  const denied = fixture({ allowed: false });
  assert.equal((await denied.invoke('getGlobalManagedQuote', { query: { clinica_id: 1, investment: 650 } })).statusCode, 403);
});
test('new workspace request stores a server quote, draft and unfunded account, not client-supplied totals', async () => {
  const f = fixture();
  const res = await f.invoke('requestAutopilot', { body: { ...input, budget: { amount: 1, currency: 'USD' } } });
  assert.equal(res.statusCode, 201); assert.equal(f.access[0].access, 'write');
  const campaign = f.writes.find(row => row.kind === 'campaign').value;
  assert.equal(campaign.budget_config.amount, 1254); assert.equal(campaign.budget_config.currency, 'EUR');
  assert.equal(campaign.budget_config.requested_quote.investment, 650);
  assert.equal(campaign.status, 'draft'); assert.equal(campaign.operation_mode, 'observe');
  assert.equal(campaign.target_config.service, 'global_managed');
  assert.equal(f.writes.find(row => row.kind === 'funding').value.status, 'unfunded');
  assert.equal(f.writes.length, 2);
});
test('malformed requests or missing permissions make no writes', async () => {
  for (const body of [{ ...input, global_plan: null }, { ...input, global_plan: { ...input.global_plan, investment: -1 } }]) {
    const f = fixture(); assert.equal((await f.invoke('requestAutopilot', { body })).statusCode, 400); assert.equal(f.writes.length, 0);
  }
  const denied = fixture({ allowed: false });
  assert.equal((await denied.invoke('requestAutopilot', { body: input })).statusCode, 403); assert.equal(denied.writes.length, 0);
});
test('approval cannot bypass the content review or approve an obsolete revision', async () => {
  const record = { id: 'test', clinica_id: 1, status: 'pending_client_review', version: 2,
    target_config: { service: 'global_managed' }, review_config: { proposal_revision: 3 }, creative_config: {} };
  const f = fixture({ existing: record });
  assert.equal((await f.invoke('approveClientProposal', { body: { proposal_revision: 2, content_approved: true } })).body.error, 'stale_proposal_revision');
  assert.equal((await f.invoke('approveClientProposal', { body: { proposal_revision: 3, content_approved: true } })).body.error, 'managed_content_review_required');
  record.creative_config = { assets_ready: true, client_preview_url: 'https://example.com/preview' };
  assert.equal((await f.invoke('approveClientProposal', { body: { proposal_revision: 3 } })).body.error, 'managed_content_review_required');
  assert.equal(f.writes.length, 0);
  const res = await f.invoke('approveClientProposal', { body: { proposal_revision: 3, content_approved: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(f.writes[0].value.status, 'pending_admin_review');
  assert.equal(f.writes[0].value.review_config.client_content_approved_revision, 3);
});
