'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPatientCareRequest } = require('../../lib/lead-request-purpose');
const { maybeUploadLeadLifecycleConversion } = require('../../services/googleLeadLifecycleConversion.service');
const { nativeLifecycleContext } = require('../../services/campaignWorkspaceGoogleNative.service');
const { resolveLifecycleSignal } = require('../../services/metaLeadLifecycleJob.service');
const lead = { id: 901, clinica_id: 72, status_lead: 'cualificado' };
const step = (type, request_kind) => ({ attribution_steps: { type, [type]: { version: 1, request_kind } } });
const attention = 'lead_patient_attention_v1', snapshot = 'lead_patient_context_v1';
function models(rows) {
  return { LeadIntake: { findByPk: async () => lead }, LeadAttributionAudit: {
    findAll: async query => {
      assert.equal(query.where.lead_intake_id, lead.id);
      assert(!query.attributes.includes('raw_payload'), 'do not read captured contact payloads');
      return rows;
    },
  } };
}
test('latest human purpose overrides intake while old unclassified requests remain commercial', async () => {
  for (const [rows, expected] of [
    [[], false], [[step(snapshot, 'patient_care')], true],
    [[step(attention, 'commercial'), step(attention, 'patient_care'), step(snapshot, 'commercial')], false],
    [[step(attention, 'patient_care'), step(snapshot, 'commercial')], true],
    [[{ attribution_steps: { type: 'unrelated', [attention]: { version: 1, request_kind: 'patient_care' } } }], false],
  ]) assert.equal(await isPatientCareRequest(lead, { models: models(rows) }), expected);
});
test('purpose-read errors never grant permission to upload', async () => {
  await assert.rejects(isPatientCareRequest(lead, { models: { LeadAttributionAudit: {
    findAll: async () => { throw Error('synthetic database unavailable'); },
  } } }), /unavailable/);
});
test('patient-care is rejected before Google web, Google native and Meta resolve any provider identity', async () => {
  const db = models([step(attention, 'patient_care')]);
  const result = await maybeUploadLeadLifecycleConversion({ lead, eventName: 'qualified_lead', eventId: 'lead-901-qualified',
    dependencies: { models: db, maybeUploadGoogleConversion: () => assert.fail('no provider upload') } });
  assert.equal(result.sent, false); assert.equal(result.reason, 'patient_care_request');
  await assert.rejects(nativeLifecycleContext({ leadId: 901, clinicId: 72, eventName: 'qualified_lead',
    eventId: 'lead-901-qualified', occurredAt: new Date() }, { models: db }), { code: 'workspace_patient_care_request' });
  await assert.rejects(resolveLifecycleSignal({ lead_id: 901, clinic_id: 72, event_name: 'qualified_lead',
    event_id: 'lead-901-qualified', occurred_at: new Date().toISOString() }, { models: db }), { code: 'meta_crm_patient_care_request' });
});
