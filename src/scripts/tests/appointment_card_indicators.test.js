'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { attach } = require('../../services/appointmentCardIndicators.service');
const Sequelize = require('sequelize');
const appointment = (id = 1) => ({ id_cita: id, paciente_id: 2, clinica_id: 3, tratamiento_id: 4 });
function fake(documents, requirements) {
  const calls = []; return { calls, Sequelize, ClinicConsentTemplate: {}, ConsentTemplateCatalog: {},
    TreatmentConsentRequirement: { findAll: async args => { calls.push(['requirements', args]); return requirements || [{ tratamiento_id: 4, clinica_id: 3, clinic_template_id: 5, clinicTemplate: { status: 'active', validity_mode: 'manual' } }]; } },
    PatientConsentDocument: { findAll: async args => { calls.push(['documents', args]); return documents; } } };
}
const signed = () => ({ paciente_id: 2, clinica_id: 3, clinic_template_id: 5, status: 'signed', signed_at: new Date(), requires_professional: false });
test('calendar consent indicators use two bounded queries regardless of card count', async () => {
  const db = fake([signed()]); const rows = Array.from({ length: 200 }, (_, i) => appointment(i + 1)); await attach(db, rows);
  assert.equal(db.calls.length, 2); assert(rows.every(r => r.consent_summary.pending_required === 0));
  assert.equal(db.calls[0][1].limit, 5001); assert.equal(db.calls[1][1].limit, 10001);
});
test('other clinic signatures and unsigned professional countersignatures do not turn cards green', async () => {
  for (const change of [{ clinica_id: 99 }, { status: 'revoked' }, { requires_professional: true }, { expires_at: '2020-01-01' }]) {
    const rows = [appointment()]; await attach(fake([{ ...signed(), ...change }]), rows); assert.equal(rows[0].consent_summary.has_pending, true);
  }
});
test('over-limit, missing treatment and program projections remain unknown', async () => {
  const rows = [appointment()]; await attach(fake([], Array(5001).fill({})), rows); assert.equal(rows[0].consent_summary, undefined);
  const db = fake([]); const others = [{ ...appointment(), tratamiento_id: null }, { ...appointment(), source_system: 'treatment_program' }]; await attach(db, others); assert.equal(db.calls.length, 0);
});
