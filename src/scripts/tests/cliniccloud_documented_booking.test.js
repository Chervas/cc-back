'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePayload, bookReviewedAppointment } = require('../../lib/cliniccloud-import/book-reviewed-appointment');
function payload() {
  return { clinica_id: 1, paciente_id: 2, doctor_id: 3, instalacion_id: 4, tratamiento_id: null,
    titulo: 'Synthetic source consultation', nota: null, motivo: 'Synthetic import', tipo_cita: 'primera_sin_trat',
    estado: 'pendiente', inicio: '2030-01-07T10:00:00.000Z', fin: '2030-01-07T10:30:00.000Z',
    source_system: 'cliniccloud', source_reference: 'delta:synthetic', es_provisional: 0,
    created_at: '2026-09-27T00:00:00.000Z', updated_at: '2026-09-27T00:00:00.000Z',
    import_metadata: { source_account: 'cliniccloud-5880', source_contact_id: '999999',
      notification_suppression: { appointment_details: true, day_before: true, same_day: true },
      cliniccloud_delta: { pending_assignment: ['treatment_id'], source: { service_key: 'Synthetic source consultation' } },
      cliniccloud_reconciliation: { automation_policy: 'hold' } } };
}
test('documented appointment keeps explicit unresolved treatment and accepts zero or concrete equipment', () => {
  for (const ids of [[], [1], [3, 7]]) assert.doesNotThrow(() => validatePayload(payload(), ids, 'a'.repeat(64)));
});
test('cannot import missing resources, a provisional booking, completed care, or arbitrary fields', () => {
  for (const mutate of [p => { p.doctor_id = null; }, p => { p.instalacion_id = null; },
    p => { p.voucher_id = 1; }, p => { p.estado = 'completada'; }, p => { p.es_provisional = 1; },
    p => { p.source_system = null; }, p => { p.tratamiento_id = 0; }]) {
    const p = payload(); mutate(p); assert.throws(() => validatePayload(p, [], 'a'.repeat(64)), /PAYLOAD_INVALID/);
  }
});
test('all HOLD flags and unresolved treatment provenance are mandatory; clinical approvals cannot be forged', () => {
  for (const mutate of [p => { p.import_metadata.notification_suppression.day_before = false; },
    p => { p.import_metadata.cliniccloud_reconciliation.automation_policy = 'normal'; },
    p => { p.import_metadata.cliniccloud_delta.pending_assignment = []; },
    p => { p.import_metadata.cliniccloud_delta.pending_assignment.push('doctor_id'); },
    ...['booking','program_session','additional_staff','import_resource_resolution','import_treatment_resolution'].map(k => p => { p.import_metadata[k] = {}; })]) {
    const p = payload(); mutate(p); assert.throws(() => validatePayload(p, [], 'a'.repeat(64)), /HOLD_AND_REVIEW_REQUIRED/);
  }
});
test('equipment is bounded, concrete, unique and tied to immutable source evidence', () => {
  for (const ids of [null, [1,1], [0], ['1'], Array.from({ length: 9 }, (_,i) => i+1)]) {
    assert.throws(() => validatePayload(payload(), ids, 'a'.repeat(64)), /EVIDENCE_INVALID/);
  }
  assert.throws(() => validatePayload(payload(), [], 'source name'), /EVIDENCE_INVALID/);
});
test('no DB access without the explicit caller transaction and identity revalidation', async () => {
  const db = new Proxy({}, { get() { throw Error('DB must not be accessed'); } });
  for (const overrides of [{}, { transaction: { options: { isolationLevel: 'REPEATABLE READ' } }, beforeInsert: () => {} },
    { transaction: { options: { isolationLevel: 'READ COMMITTED' } } }]) {
    await assert.rejects(bookReviewedAppointment({ db, payload: payload(), sourceSha256: 'a'.repeat(64), ...overrides }), /TRANSACTION_AND_IDENTITY_GUARD_REQUIRED/);
  }
});
module.exports = { payload };
