'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { createMetaLeadFormEnrichment } = require('../../services/metaLeadFormEnrichment.service');
const { storeMetaLeadFormResponse } = require('../../services/metaLeadFormResponse.service');
const { parseArgs, main } = require('../meta-lead-form-enrichment');

const receiptRef = '11111111-1111-4111-8111-111111111111';
const event = { lead_id: '9007199254740993123', page_id: '200', form_id: '300', ad_id: '400' };
const identity = { account_id: '500', campaign_id: '600', adset_id: '700', ad_id: '400' };
const response = { version: 2, formId: '300', name: 'Fictitious form', fields: [
  { key: 'email', label: 'Email', type: 'EMAIL', values: ['new@example.invalid'] },
  { key: 'preferred_time', label: 'Preferred time', type: 'CUSTOM', values: ['afternoon', 'evening'] },
  { key: 'comments', label: 'Comments', type: 'CUSTOM', values: ['Line one\nLine two'] },
  { key: 'optional', label: 'Optional', type: 'CUSTOM', values: [] },
] };

function fixture({ organic = false } = {}) {
  const e = { ...event, ad_id: organic ? null : event.ad_id };
  const lead = { id: 1, clinica_id: 72, grupo_clinica_id: 29, external_source: 'meta_leadgen',
    external_id: e.lead_id, source: organic ? null : 'meta_ads', channel: organic ? 'organic' : 'paid',
    source_detail: 'leadgen_form:300', archived_at: null, nombre: 'Old fixture', telefono: '000000000',
    email: 'old@example.invalid', status_lead: 'contactado', asignado_a: 19 };
  const state = { leads: [lead], forms: [], providerReads: 0, forbiddenWrites: 0, transactionCount: 0,
    audits: [{ native_provider: null, identity: null }, { native_provider: 'meta_leadgen', native_lead_id: e.lead_id,
      native_form_id: '300', native_page_id: '200', identity: organic ? null : { version: 1, verified_by: 'meta_graph',
        provider: 'meta_ads', clinic_id: 72, ...identity, page_id: '200', form_id: '300' } }],
    jobs: [{ id: 9, payload: { ...e, receipt_ref: receiptRef, page_asset_id: 10, account_asset_id: 11,
      __runtime_namespace: 'staging' } }], response: structuredClone(response), revoked: false };
  const forbidden = () => { state.forbiddenWrites++; assert.fail('recovery attempted unrelated write'); };
  const clinic = { id_clinica: 72, grupoClinicaId: 29, estado_clinica: 1 };
  const page = { id: 10, metaAssetId: '200', metaConnectionId: 1, assignmentScope: 'group', grupoClinicaId: 29, clinicaId: null };
  const account = { id: 11, metaAssetId: '500', metaConnectionId: 1, assignmentScope: 'group', grupoClinicaId: 29, clinicaId: null };
  const models = {
    LeadIntake: { findByPk: async id => state.leads.find(row => row.id === Number(id)), create: forbidden, update: forbidden },
    JobRequest: { findAll: async options => state.jobs.filter(job => job.payload.lead_id === options.where[Op.and][0].logic), create: forbidden, update: forbidden },
    LeadAttributionAudit: { findAll: async () => state.audits, create: forbidden },
    FormSubmissionEvent: {
      findAll: async ({ where }) => state.forms.filter(row => row.lead_intake_id === where.lead_intake_id && row.source_detail === where.source_detail),
      create: async (input, options) => { assert(options.transaction); if (state.formError) throw Error('private fixture failure');
        const row = { id: state.forms.length + 1, ...input }; state.forms.push(row); return row; },
    },
    ClinicMetaAsset: { findAll: async ({ where }) => where.assetType === 'facebook_page' ? [page] : [account] },
    Clinica: { findByPk: async id => id === 72 ? clinic : null },
    ExternalCampaignAssignment: { findAll: async () => [] },
    CampaignWorkspaceSetting: { findAll: async () => [] },
    sequelize: { transaction: async fn => {
      state.transactionCount++;
      const snapshot = structuredClone({ leads: state.leads, forms: state.forms, audits: state.audits });
      try { return await fn({ LOCK: { UPDATE: 'UPDATE' } }); }
      catch (error) { Object.assign(state, snapshot); throw error; }
    } },
  };
  const reader = {
    preparePair: async (pageId, accountId) => { assert.equal(pageId, 10); assert.equal(accountId, 11); return {}; },
    assertPair: async () => {
      if (state.revoked) throw Object.assign(Error('asset_revoked'), { code: 'asset_revoked' });
      return { page: { mappingId: 10, id: '200', connectionId: 1, clinicIds: [66, 72] },
        account: { mappingId: 11, id: '500', connectionId: 1 } };
    },
    read: async (_pair, family, payload) => {
      state.providerReads++; assert.equal(family, 'receiptRead');
      assert.deepEqual(payload, { receiptRef, responseVersion: 2 });
      if (state.providerError) throw state.providerError;
      if (state.revokeAfterRead) state.revoked = true;
      return { event: e, identity: organic ? null : { ...identity, ...(state.identityPatch || {}) }, recipientClinicId: 72,
        lead: { id: e.lead_id, form_id: e.form_id, ad_id: e.ad_id, campaign_id: organic ? null : '600',
          created_time: '2026-11-08T10:00:00Z', is_organic: organic,
          field_data: [{ name: 'email', values: ['new@example.invalid'] }] }, form_response: state.response };
    },
  };
  return { state, models, reader, clinic, event: e,
    service: createMetaLeadFormEnrichment({ models, reader, runtime: 'staging' }) };
}

test('default recovery is DB-only and preserves 64-bit native IDs without creating data', async () => {
  const f = fixture();
  const result = await f.service.run({ leadIds: [1], clinicIds: [72] });
  assert.deepEqual(result.results, [{ leadId: 1, clinicId: 72, status: 'ready', providerRead: false }]);
  assert.equal(f.state.providerReads, 0); assert.equal(f.state.transactionCount, 0);
  assert.equal(f.state.forms.length, 0); assert.equal(f.state.forbiddenWrites, 0);
});
test('paid recovery stores one private structured event while preserving contacts, state, owner and audits', async () => {
  const f = fixture(), before = structuredClone({ leads: f.state.leads, audits: f.state.audits, jobs: f.state.jobs });
  const result = await f.service.run({ leadIds: [1], clinicIds: [72], apply: true });
  assert.equal(result.results[0].status, 'enriched'); assert.equal(result.results[0].fieldCount, 4);
  assert.deepEqual(f.state.leads, before.leads); assert.deepEqual(f.state.audits, before.audits); assert.deepEqual(f.state.jobs, before.jobs);
  assert.equal(f.state.forms.length, 1); assert.equal(f.state.forbiddenWrites, 0);
  const saved = f.state.forms[0];
  assert.deepEqual(saved.fields_json, { provider: 'meta_leadgen', version: 2, fields: response.fields });
  assert.equal(saved.page_url, null); assert.equal(saved.form_selector, null);
  assert.equal(saved.email_normalized, null); assert.equal(saved.phone_normalized, null);
  assert(!JSON.stringify(saved.payload_json).includes('afternoon'));
  assert(!JSON.stringify(result).includes('Line one')); assert(!JSON.stringify(result).includes('new@example.invalid'));
  const again = await f.service.run({ leadIds: [1], clinicIds: [72], apply: true });
  assert.equal(again.results[0].status, 'already_enriched'); assert.equal(f.state.providerReads, 1);
});
test('organic native recovery stays organic and requires a server-written native Page/form proof', async () => {
  const f = fixture({ organic: true });
  assert.equal((await f.service.run({ leadIds: [1], clinicIds: [72], apply: true })).results[0].status, 'enriched');
  assert.equal(f.state.leads[0].source, null); assert.equal(f.state.leads[0].channel, 'organic');
  assert.equal(f.state.forbiddenWrites, 0);
});
test('foreign clinic, archived lead, missing receipt and ambiguous receipt are denied without provider reads', async () => {
  for (const change of [f => { f.state.leads[0].clinica_id = 66; },
    f => { f.state.leads[0].archived_at = new Date(); }, f => { f.state.jobs = []; },
    f => { f.state.jobs.push({ id: 10, payload: { ...f.state.jobs[0].payload, receipt_ref: '22222222-2222-4222-8222-222222222222' } }); },
    f => { f.state.jobs[0].payload.__runtime_namespace = 'dev'; }]) {
    const f = fixture(); change(f);
    assert.equal((await f.service.run({ leadIds: [1], clinicIds: [72], apply: true })).results[0].status, 'unavailable');
    assert.equal(f.state.providerReads, 0); assert.equal(f.state.forms.length, 0);
  }
});
test('conflicting public identity, a changed ad set and revoked Page authority cannot enrich private data', async () => {
  const wrong = fixture(); wrong.state.audits[1].identity.clinic_id = 66;
  assert.equal((await wrong.service.run({ leadIds: [1], clinicIds: [72], apply: true })).results[0].status, 'unavailable');
  assert.equal(wrong.state.providerReads, 0);
  const changed = fixture(); changed.state.identityPatch = { adset_id: '701' };
  assert.equal((await changed.service.run({ leadIds: [1], clinicIds: [72], apply: true })).results[0].code, 'meta_lead_form_identity_mismatch');
  const revoked = fixture(); revoked.state.revokeAfterRead = true;
  assert.equal((await revoked.service.run({ leadIds: [1], clinicIds: [72], apply: true })).results[0].code, 'asset_revoked');
  for (const f of [wrong, changed, revoked]) { assert.equal(f.state.forms.length, 0); assert.equal(f.state.forbiddenWrites, 0); }
});
test('privacy storage failure rolls back and safe reports never include answers or provider exception objects', async () => {
  const f = fixture(); f.state.formError = true;
  const result = await f.service.run({ leadIds: [1], clinicIds: [72], apply: true });
  assert.equal(result.results[0].status, 'unavailable'); assert.equal(f.state.forms.length, 0);
  const p = fixture(); p.state.providerError = Object.assign(Error('patient private text'), { code: 'rate_limited', retryAfterMs: 7200000 });
  const limited = await p.service.run({ leadIds: [1, 2], clinicIds: [72], apply: true });
  assert.equal(limited.results[0].retryAfterMs, 7200000); assert.equal(limited.results[1].status, 'not_attempted');
  assert.equal(p.state.providerReads, 1); assert(!JSON.stringify(limited).includes('patient private text'));
});
test('native event comparison tolerates MySQL JSON key order and refuses a changed answer', async () => {
  const f = fixture();
  await f.service.run({ leadIds: [1], clinicIds: [72], apply: true });
  const prior = f.state.forms[0];
  prior.fields_json = JSON.stringify({ fields: prior.fields_json.fields.map(field => ({ values: field.values, type: field.type, label: field.label, key: field.key })), version: 2, provider: 'meta_leadgen' });
  prior.payload_json = JSON.stringify(Object.fromEntries(Object.entries(prior.payload_json).reverse()));
  const args = { models: f.models, event: f.event, lead: f.state.leads[0], clinic: f.clinic, formResponse: response,
    providerCreatedAt: '2026-11-08T10:00:00Z', transaction: { LOCK: { UPDATE: 'UPDATE' } } };
  assert.equal((await storeMetaLeadFormResponse(args)).stored, false);
  const other = structuredClone(response); other.fields[1].values = ['morning'];
  await assert.rejects(storeMetaLeadFormResponse({ ...args, formResponse: other }), /meta_lead_form_conflict/);
  assert.equal(f.state.forms.length, 1);
});
test('CLI is dry-run by default and requires explicit bounded IDs, clinic scope and runtime', () => {
  const parsed = parseArgs(['--lead-id', '1', '--clinic-id', '72', '--runtime', 'staging']);
  assert.equal(parsed.apply, false); assert.deepEqual(parsed.leadIds, [1]);
  for (const args of [[], ['--lead-id', '1', '--clinic-id', '72'],
    ['--lead-id', '1', '--lead-id', '1', '--clinic-id', '72', '--runtime', 'staging'],
    ['--lead-id', '1', '--clinic-id', '72', '--runtime', 'staging', '--unsafe'],
    ['--lead-id', '1', '--clinic-id', '72', '--runtime', 'staging', '--output', './public.json']])
    assert.throws(() => parseArgs(args), /meta_lead_form_cli_invalid/);
});
test('CLI rejects an existing report or symlink before loading environment, real models or provider services', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-lead-report-preflight-'));
  const report = path.join(directory, 'existing.json'), symlink = path.join(directory, 'report-link.json');
  fs.writeFileSync(report, 'existing report', { mode: 0o600 }); fs.symlinkSync(report, symlink);
  const originalLoad = Module._load; let forbiddenImports = 0;
  try {
    Module._load = function (request, ...args) {
      if (request === 'dotenv' || request === '../../models'
        || /metaMarketingLeadReader|metaLeadFormEnrichment/.test(request)) {
        forbiddenImports++; throw Error('REAL_RUNTIME_IMPORT_FORBIDDEN');
      }
      return originalLoad.call(this, request, ...args);
    };
    for (const destination of [report, symlink]) await assert.rejects(main([
      '--lead-id', '1', '--clinic-id', '72', '--runtime', 'staging', '--apply', '--output', destination,
    ]), error => error.code === 'EEXIST');
    assert.equal(forbiddenImports, 0); assert.equal(fs.readFileSync(report, 'utf8'), 'existing report');
  } finally {
    Module._load = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
