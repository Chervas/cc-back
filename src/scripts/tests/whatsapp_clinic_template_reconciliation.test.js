'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const rules = require('../../lib/whatsapp-clinic-template-reconciliation');
const { templateAssetsForClinic } = require('../../lib/whatsapp-template-clinic-routing');
function source(extra = {}) {
  return { id: 1, clinic_id: 58, waba_id: 'old', name: 'testonly_moved', display_name: 'TESTONLY relocation',
    category: 'UTILITY', language: 'es', origin: 'custom', is_active: true, created_by_user_id: 76,
    status: 'APPROVED', meta_template_id: 'TESTONLY-meta', components: [{ type: 'BODY', text: 'TESTONLY clinic-specific address {{1}}' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'TESTONLY map', url: 'https://example.com/testonly' }] }],
    variables: [{ name: 'nombre', example: 'TESTONLY' }], ...extra };
}
function nativeFunction(name, deps, service = 'whatsappTemplates') {
  const text = fs.readFileSync(require.resolve('../../services/' + service + '.service'), 'utf8');
  const asyncStart = text.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : text.indexOf('function ' + name + '('); assert(start >= 0);
  const end = ['\nasync function ', '\nfunction ', '\nmodule.exports'].map(mark => text.indexOf(mark, start + 15)).filter(at => at >= 0);
  return vm.runInNewContext('(' + text.slice(start, Math.min(...end)).trim().replace(/;$/, '') + ')', {
    require: name => { assert.equal(name, '../lib/whatsapp-clinic-template-reconciliation'); return rules; },
    console, structuredClone, ...deps,
  });
}
function runtime() {
  const original = source(), rows = [original], calls = [], f = { sourceValid: true, routed: true, fail: null, jobsFail: false };
  const wrap = row => ({ ...row, async update(patch) { Object.assign(row, patch); Object.assign(this, patch); } });
  const model = {
    findAll: async ({ where }) => rows.filter(row => where.clinic_id ? row.clinic_id === where.clinic_id && row.origin === 'custom' : row.waba_id === where.waba_id),
    findByPk: async (id, opts) => {
      const row = rows.find(row => row.id === id);
      if (id === 1 && !f.sourceValid) return { ...row, is_active: false };
      return opts?.raw ? row : wrap(row);
    },
    create: async data => { const row = { id: rows.length + 1, ...structuredClone(data) }; rows.push(row); return wrap(row); },
  };
  const deps = { WhatsappTemplate: model, customTemplateTargetClinics: async () => f.routed ? [58] : [],
    resolveWabaAssetById: async () => ({}), prepareTemplateImageHeaderForMeta: async ({ template }) => ({ template }),
    enqueueCustomSubmissionSync: async row => { if (f.jobsFail) throw Error('TESTONLY_JOB_FAILURE'); calls.push(['sync', row.id]); },
    createTemplateInMeta: async input => { calls.push(['provider', input]); if (f.fail) throw f.fail; return { id: 'TESTONLY-new-id' }; },
    WHATSAPP_TEMPLATE_STATUS: { LOCAL_PENDING: 'PENDING_LOCAL', PENDING: 'PENDING', REJECTED: 'REJECTED' },
    templateSyncState: { blockedCode: () => null }, buildLocalPendingReasonFromMetaError: () => 'TESTONLY rejected',
  };
  f.run = nativeFunction('reconcileClinicCustomTemplatesWithLease', deps);
  return Object.assign(f, { rows, calls, original, deps, input: { wabaId: 'new', clinicId: 58, assignmentScope: 'clinic' } });
}

test('copies are planned only from the original clinic and author, preserving body, buttons, language and variables', () => {
  const own = source(), foreign = source({ id: 2, clinic_id: 59 });
  const result = rules.planClinicTemplates({ clinicId: 58, wabaId: 'new', sources: [own, foreign], targets: [] });
  assert.equal(result.plan.length, 1); assert.deepEqual(result.plan[0].source, own);
  for (const patch of [{ created_by_user_id: null }, { origin: 'external' }, { is_active: false },
    { retired_at: new Date() }, { superseded_by_template_id: 2 }, { status: 'REJECTED' }, { meta_template_id: null }]) {
    assert.equal(rules.planClinicTemplates({ clinicId: 58, wabaId: 'new', sources: [source(patch)], targets: [] }).plan.length, 0);
  }
});
test('same WABA, reconnection and an equivalent manually-created copy do not duplicate templates', () => {
  for (const target of [source({ id: 3, waba_id: 'new' }), source({ id: 3, waba_id: 'new', name: 'testonly_manual_copy' })]) {
    assert.equal(rules.planClinicTemplates({ clinicId: 58, wabaId: 'new', sources: [source()], targets: [target] }).plan.length, 0);
  }
  assert.equal(rules.planClinicTemplates({ clinicId: 58, wabaId: 'old', sources: [source()], targets: [] }).plan.length, 0);
});
test('incompatible copies and a foreign or retired target go to review, never overwrite or adopt ownership', () => {
  for (const target of [source({ id: 2, waba_id: 'new', created_by_user_id: 2 }), source({ id: 2, waba_id: 'new', clinic_id: 59 }),
    source({ id: 2, waba_id: 'new', is_active: false })]) {
    const result = rules.planClinicTemplates({ clinicId: 58, wabaId: 'new', sources: [source()], targets: [target] });
    assert.equal(result.plan.length, 0); assert.equal(result.reviews[0].reason, 'clinic_template_target_conflict');
  }
  const changed = source({ id: 2, waba_id: 'second', components: [{ type: 'BODY', text: 'TESTONLY changed address' }] });
  const diverged = rules.planClinicTemplates({ clinicId: 58, wabaId: 'new', sources: [source(), changed], targets: [] });
  assert.equal(diverged.plan.length, 0); assert.equal(diverged.reviews[0].reason, 'clinic_template_copies_diverged');
});
test('equal visible titles do not merge distinct identities or resurrect a predecessor retired on another WABA', () => {
  const other = source({ id: 3, name: 'testonly_distinct', components: [{ type: 'BODY', text: 'TESTONLY independent template' }] });
  const distinct = rules.planClinicTemplates({ clinicId: 58, wabaId: 'new', sources: [source(), other], targets: [] });
  assert.equal(distinct.plan.length, 2); assert.equal(distinct.reviews.length, 0);
  const retired = source({ id: 4, waba_id: 'second', is_active: false, superseded_by_template_id: 5 });
  const result = rules.planClinicTemplates({ clinicId: 58, wabaId: 'new', sources: [source(), retired, other], targets: [] });
  assert.equal(result.plan.length, 1); assert.equal(result.plan[0].source.name, other.name);
  assert.equal(result.reviews[0].reason, 'clinic_template_identity_retired_elsewhere');
});
test('native reconciliation checkpoints before POST, preserves author/content and does not repeat on restart', async () => {
  const f = runtime();
  assert.equal((await f.run(f.input)).copied, 1);
  const copy = f.rows[1]; assert.equal(copy.clinic_id, 58); assert.equal(copy.created_by_user_id, 76);
  assert.equal(copy.name, f.original.name); assert.deepEqual(copy.components, f.original.components);
  assert.deepEqual(copy.variables, f.original.variables); assert.equal(copy.status, 'PENDING');
  assert.equal(f.calls[0][0], 'sync'); assert.equal(f.calls[1][0], 'provider');
  await f.run(f.input); assert.equal(f.calls.filter(row => row[0] === 'provider').length, 1);
});
test('unknown provider results never retry POST, but a failure before POST resumes the same durable row', async () => {
  const f = runtime(); f.fail = Error('TESTONLY timeout');
  assert.equal((await f.run(f.input)).pending, 1); await f.run(f.input);
  assert.equal(f.calls.filter(row => row[0] === 'provider').length, 1); assert.equal(f.rows.length, 2);
  const g = runtime(); g.jobsFail = true;
  await assert.rejects(g.run(g.input), /TESTONLY_JOB_FAILURE/); assert.equal(g.calls.length, 0);
  assert.equal(g.rows[1].rejection_reason, 'custom_submission_not_started');
  g.jobsFail = false; await g.run(g.input); assert.equal(g.rows.length, 2);
  assert.equal(g.calls.filter(row => row[0] === 'provider').length, 1);
});
test('source changes, routing changes and missing image evidence stop copies without affecting other clinics', async () => {
  for (const mode of ['source', 'routing', 'image']) {
    const f = runtime();
    if (mode === 'source') f.sourceValid = false;
    if (mode === 'routing') f.routed = false;
    if (mode === 'image') {
      f.deps.prepareTemplateImageHeaderForMeta = async () => ({ issue: 'image_sample_required' });
      f.run = nativeFunction('reconcileClinicCustomTemplatesWithLease', f.deps);
    }
    await f.run(f.input); assert.equal(f.calls.length, 0); assert.equal(f.rows.length, 1);
  }
});
test('provider rejection is not approval and a proven rate limit retries only the existing not-started row', async () => {
  const f = runtime(); f.fail = { response: { status: 400 } };
  assert.equal((await f.run(f.input)).reviews[0].reason, 'clinic_template_provider_rejected');
  assert.equal(f.rows[1].status, 'REJECTED'); await f.run(f.input);
  assert.equal(f.calls.filter(row => row[0] === 'provider').length, 1);
  const g = runtime(); g.fail = { code: 'rate_limited' };
  await assert.rejects(g.run(g.input)); assert.equal(g.rows[1].rejection_reason, 'custom_submission_not_started');
  g.fail = null; await g.run(g.input); assert.equal(g.rows.length, 2); assert.equal(g.rows[1].status, 'PENDING');
});

test('routing uses the current primary and secondary with exact broker grants, not a group-wide or historical phone', () => {
  const clinic = { id_clinica: 58, grupoClinicaId: 5 };
  const assets = [1, 2, 3].map(id => ({ id, assetType: 'whatsapp_phone_number', assignmentScope: id === 2 ? 'group' : 'clinic',
    clinicaId: id === 2 ? null : 58, grupoClinicaId: 5, phoneNumberId: 'phone-' + id, wabaId: 'waba-' + id, isActive: true, additionalData: {} }));
  const channelBindings = [{ id: 1, clinic_id: 58, asset_id: 1, role: 'primary', is_active: true },
    { id: 2, clinic_id: 58, asset_id: 2, role: 'secondary', purposes: ['bulk_campaigns'], is_active: true }];
  const authorizedBindings = assets.map(row => ({ clinicId: 58, assetId: row.id, phoneId: row.phoneNumberId, wabaId: row.wabaId, sendEnabled: true }));
  const input = { clinic, assets, channelBindings, authorizedBindings };
  assert.deepEqual(templateAssetsForClinic(input).map(row => row.id), [1, 2]);
  assets[0].isActive = false; assert.deepEqual(templateAssetsForClinic(input).map(row => row.id), [2]);
  assert.equal(templateAssetsForClinic({ ...input, authorizedBindings: [] }).length, 0);
  assert.equal(templateAssetsForClinic({ ...input, clinic: { id_clinica: 59, grupoClinicaId: 5 } }).length, 0);
});

module.exports = { nativeFunction, source };
