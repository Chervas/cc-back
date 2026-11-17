'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { persistedLeadPatientId, assertAppointmentLeadPatientConsistency, findUniqueAppointmentLead } = require('../../services/appointmentLeadLink.service');
const { LEAD_PATIENT_CONTEXT_TYPE } = require('../../lib/lead-patient-context');
const snapshot = patch => ({ version: 1, relationship: 'existing_patient', patient_id: 11, clinic_id: 100,
  clinic_name: 'Clínica ficticia', same_clinic: true, captured_at: '2026-01-01T00:00:00Z',
  reason: 'prior_attended_appointment', request_kind: 'commercial', ...patch });
const row = value => ({ attribution_steps: { type: LEAD_PATIENT_CONTEXT_TYPE, [LEAD_PATIENT_CONTEXT_TYPE]: value } });
const transaction = { LOCK: { UPDATE: 'UPDATE' } };
function fixture({ captured = snapshot(), conversations = [], fresh = {} } = {}) {
  const reads = [], models = {
    Paciente: { async findByPk(id, opts) { reads.push(['patient', opts]); assert.equal(id, 11); return { id_paciente: id }; } },
    Conversation: { async findAll(opts) { reads.push(['conversations', opts]); assert.equal(opts.where.clinic_id, 100); assert.equal(opts.where.lead_id, 701); return conversations; },
      async findOne() { return null; } },
    LeadIntake: { async findByPk(id, opts) { reads.push(['lead', opts]); return { id, clinica_id: 100, ...fresh }; },
      async findAll() { return [{ id: 701, telefono: '34600000011' }]; } },
    LeadAttributionAudit: { async findAll(opts) { reads.push(['audit', opts]); assert.equal(opts.limit, 1); assert.deepEqual(opts.order, [['id', 'ASC']]);
      assert.equal(opts.where['attribution_steps.type'], LEAD_PATIENT_CONTEXT_TYPE); return captured == null ? [] : [row(captured)]; } },
    CitaPaciente: { async findOne() { return null; } },
  };
  return { models, reads, input: { models, transaction, lead: { id: 701 }, appointment: { clinica_id: 100, paciente_id: 11 } } };
}
test('patient consistency does no read for an appointment without a lead', async () => {
  await assertAppointmentLeadPatientConsistency({ models: {}, lead: null, appointment: {} });
});
test('patient identity checks require the caller transaction before reading any source', async () => {
  const f = fixture(); await assert.rejects(assertAppointmentLeadPatientConsistency({ ...f.input, transaction: null }), /transaction_required/);
  assert.equal(f.reads.length, 0);
});
test('the existing identity uses patient → conversation → lead locks and all reads reuse one transaction', async () => {
  const f = fixture({ conversations: [{ id: 3, patient_id: 11 }, { id: 4, patient_id: null }] });
  await assertAppointmentLeadPatientConsistency(f.input);
  assert.deepEqual(f.reads.map(r => r[0]), ['patient', 'conversations', 'lead', 'audit']);
  assert(f.reads.every(([, opts]) => opts.transaction === transaction));
  assert(f.reads.slice(0, 3).every(([, opts]) => opts.lock === transaction.LOCK.UPDATE));
});
for (const [label, config] of [
  ['captured canonical identity differs', { captured: snapshot({ patient_id: 22 }) }],
  ['phone chat owner differs', { conversations: [{ id: 3, patient_id: 22 }] }],
  ['multiple existing chat owners conflict', { conversations: [{ id: 3, patient_id: 11 }, { id: 4, patient_id: 22 }] }],
  ['bounded evidence is exceeded', { conversations: Array.from({ length: 21 }, (_, id) => ({ id, patient_id: 11 })) }],
]) test('a conflict fails closed without disclosing identities: ' + label, async () => {
  const f = fixture(config);
  await assert.rejects(assertAppointmentLeadPatientConsistency(f.input), error => {
    assert.equal(error.status, 409); assert.equal(error.code, 'appointment_lead_patient_mismatch');
    assert(!error.message.includes('22')); assert(!error.message.includes('11')); return true;
  });
});
for (const [label, value] of [
  ['missing', null], ['invalid version', snapshot({ version: 2 })], ['untrusted possible patient', snapshot({ relationship: 'possible_patient', patient_id: 22 })],
  ['new contact with incidental ID', snapshot({ relationship: 'new_contact', patient_id: 22 })], ['invalid capture time', snapshot({ captured_at: 'bad-time' })],
  ['missing reason', snapshot({ reason: undefined })],
]) test('only a validated persisted existing-patient snapshot is authoritative: ' + label, async () => {
  const f = fixture({ captured: value }); assert.equal(await persistedLeadPatientId({ models: f.models, leadId: 701, transaction }), null);
  await assertAppointmentLeadPatientConsistency(f.input);
});
test('auto-linking does not claim a lead captured for a different explicit household member', async () => {
  const f = fixture({ captured: snapshot({ patient_id: 22 }) });
  assert.equal(await findUniqueAppointmentLead({ models: f.models, clinicId: 100, patientId: 11, phone: '+34 600 000 011', transaction }), null);
});
test('complete normalized phone equality is required to auto-link despite an indexed suffix match', async () => {
  const f = fixture(); f.models.LeadIntake.findAll = async () => [{ id: 701, telefono: '+1 6000000011' }];
  assert.equal(await findUniqueAppointmentLead({ models: f.models, clinicId: 100, patientId: 11, phone: '+34 600000011', transaction }), null);
  assert.equal(f.reads.length, 0);
});
for (const fresh of [{ archived_at: new Date() }, { clinica_id: 200 }]) test('fresh lead membership and archival state are rechecked under its lock: ' + JSON.stringify(fresh), async () => {
  const f = fixture({ fresh });
  await assert.rejects(assertAppointmentLeadPatientConsistency(f.input), e => e.status === 409 && e.code === 'appointment_lead_link_changed');
});
