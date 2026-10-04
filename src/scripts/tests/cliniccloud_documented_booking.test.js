'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePayload, bookReviewedAppointment, verifyDocumentedOccupancies } = require('../../lib/cliniccloud-import/book-reviewed-appointment');
const { occupancyForSolution } = require('../../lib/booking-profile-solver');
const { verifySourceRefreshOccupancies } = require('../../lib/cliniccloud-import/refresh-reviewed-appointment');
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
test('documented imports validate split clinician attention against canonical occupancy without shortening room or machine', () => {
  const solution = { start_at:'2030-01-07T10:00:00.000Z', end_at:'2030-01-07T10:30:00.000Z', phases:[{
    key:'appointment', installation_id:4, doctor_ids:[3],
    start_at:'2030-01-07T10:00:00.000Z', end_at:'2030-01-07T10:30:00.000Z',
    staff_intervals:[{ start_at:'2030-01-07T10:05:00.000Z', end_at:'2030-01-07T10:10:00.000Z' },
      { start_at:'2030-01-07T10:25:00.000Z', end_at:'2030-01-07T10:30:00.000Z' }],
    equipment:[{ id:7, turnaround_minutes:0 }]
  }] };
  const keys=new Map([[4,'installation:44']]), rows=occupancyForSolution(solution,keys);
  assert.equal(rows.length,4);
  assert.doesNotThrow(()=>verifyDocumentedOccupancies(rows,solution,keys));
  assert.doesNotThrow(()=>verifySourceRefreshOccupancies(rows,solution,keys));
  assert.doesNotThrow(()=>verifyDocumentedOccupancies([...rows].reverse().map(r=>({...r,start_at:new Date(r.start_at),end_at:new Date(r.end_at)})),solution,keys));
  for (const modified of [rows.slice(1),[...rows,rows[1]],
    rows.map(r=>r.resource_kind==='doctor'?{...r,start_at:solution.start_at,end_at:solution.end_at}:r),
    rows.map(r=>r.resource_kind==='equipment'?{...r,end_at:'2030-01-07T10:25:00.000Z'}:r),
    rows.map(r=>r.resource_kind==='installation'?{...r,resource_key:'installation:4'}:r)]) {
    assert.throws(()=>verifyDocumentedOccupancies(modified,solution,keys),/OCCUPANCY_MISMATCH/);
    assert.throws(()=>verifySourceRefreshOccupancies(modified,solution,keys),/SOURCE_REFRESH_OCCUPANCY_MISMATCH/);
  }
});
