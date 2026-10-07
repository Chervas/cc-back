'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const r = require('../../lib/voucher-booking-replay');
const fixture = () => ({ has_conflicts: false, rawVoucher: { id: 8, public_id: crypto.randomUUID(), clinic_id: 10, patient_id: 20,
  treatment_id: 30, name: 'Bono original', budget_id: 40, budget_line_key: 'purchase-line', source_system: 'clinicaclick' },
  treatment: { nombre: 'Tratamiento original' }, configuration: { count: 1, interval_days: 7, duration_minutes: 45,
    doctor_id: 5, installation_id: 6, timezone: 'Europe/Madrid' },
  bookingProfile: { version: 1, phases: [{ key: 'care', label: 'Atención', duration_minutes: 45,
    installation_ids: [6], professionals: { mode: 'any', ids: [5], preferred_id: 5 } }] },
  appointments: [{ sequence: 1, start_at: '2030-01-07T09:00:00.000Z', end_at: '2030-01-07T09:45:00.000Z',
    phases: [{ key: 'care', installation_id: 6, doctor_ids: [5], start_at: '2030-01-07T09:00:00.000Z', end_at: '2030-01-07T09:45:00.000Z' }],
    warnings: [], booking_plan_sha256: 'a'.repeat(64), requires_priority_acknowledgement: false }] });
const payload = () => ({ start_at: '2030-01-07T10:00', count: 1, interval_days: 7, duration_minutes: 45, doctor_id: 5, installation_id: 6 });
const event = (plan, prepared, stage = 'prepared') => ({ patient_id: 20, clinic_id: 10, actor_user_id: 1,
  source: r.SOURCE, event_type: r.eventType(stage, prepared.request_key), metadata: prepared });

test('voucher replay gate requires exact true, UUID is server-v4 and hash canonical/bounded', () => {
  for (const value of [undefined, null, true, 'TRUE', '1', 'false']) assert.equal(r.enabled({ VOUCHER_BOOKING_REPLAY_ENABLED: value }), false);
  assert.equal(r.enabled({ VOUCHER_BOOKING_REPLAY_ENABLED: 'true' }), true);
  assert.equal(r.hash({ z: 1, a: { q: 2, b: 3 } }), r.hash({ a: { b: 3, q: 2 }, z: 1 }));
  assert.throws(() => r.key('00000000-0000-0000-0000-000000000000'), { code: 'voucher_booking_request_invalid' });
  assert.throws(() => r.hash({ big: 'x'.repeat(1024 * 1024) }), { code: 'voucher_booking_receipt_invalid' });
});

test('prepared evidence seals exact actor, tenant, voucher, effective resources and original purchase, not mutable balance', () => {
  const plan = fixture(), prepared = r.preparedMetadata(plan, 1), original = event(plan, prepared);
  assert.equal(r.readMetadata(original, plan.rawVoucher, 'prepared', prepared.request_key).actor_id, 1);
  assert.notEqual(prepared.request_sha256, r.hash(r.intentForPlan(plan, 2)));
  const changed = { ...plan.rawVoucher, available_units: 0, status: 'cancelled' };
  assert.equal(r.readMetadata(original, changed, 'prepared', prepared.request_key).request_sha256, prepared.request_sha256);
  for (const corrupt of [{ ...original, actor_user_id: 2 }, { ...original, patient_id: 99 },
    { ...original, clinic_id: 99 }, { ...original, metadata: { ...prepared, actor_id: 2 } },
    { ...original, metadata: { ...prepared, intent: { ...prepared.intent, treatment_id: 99 } } }]) {
    assert.throws(() => r.readMetadata(corrupt, plan.rawVoucher, 'prepared', prepared.request_key), { code: 'voucher_booking_receipt_invalid' });
  }
  assert.throws(() => r.preparedMetadata(plan, null), { code: 'unauthenticated' });
  assert.equal(r.eventType('prepared', prepared.request_key).length < 96, true);
});

test('semantic payload allows timezone-equivalent start but rejects changed count, minutes, phase resource and omitted required acknowledgement', () => {
  const plan = fixture(), intent = r.intentForPlan(plan, 1);
  const normalize = value => value;
  assert.doesNotThrow(() => r.validatePayload(intent, payload(), normalize));
  assert.doesNotThrow(() => r.validatePayload(intent, { ...payload(), start_at: intent.slots[0].start_at,
    booking_selection: { care: { doctor_id: 5 } } }, normalize));
  for (const patch of [{ start_at: '2030-01-07T10:05' }, { count: 2 }, { interval_days: 14 }, { duration_minutes: 30 },
    { installation_id: 7 }, { booking_selection: { care: { doctor_id: 9 } } }]) {
    assert.throws(() => r.validatePayload(intent, { ...payload(), ...patch }, normalize), { code: 'voucher_booking_request_conflict' });
  }
  intent.slots[0].requires_priority_acknowledgement = true;
  assert.throws(() => r.validatePayload(intent, payload(), normalize), { code: 'booking_priority_confirmation_required' });
  assert.doesNotThrow(() => r.validatePayload(intent, { ...payload(), booking_priority_acknowledged: true }, normalize));
});

test('variable single phase requires explicit choice; receipt does not silently instantiate from end/start or null catalog', () => {
  const plan = fixture();
  plan.physicalTemplate = { version: 1, phases: [{ ...plan.bookingProfile.phases[0], duration_minutes: null }] };
  plan.durationSelection = { duration_minutes: 45 };
  const intent = r.intentForPlan(plan, 1);
  const missing = payload(); delete missing.duration_minutes;
  assert.throws(() => r.validatePayload(intent, missing, value => value), { code: 'booking_duration_required' });
  assert.doesNotThrow(() => r.validatePayload(intent, payload(), value => value));
  const copy = r.payloadForIntent(intent, { ...payload(), booking_selection: { care: { doctor_id: 999 } } });
  assert.deepEqual(copy.booking_selections_by_sequence, { '1': { care: { doctor_id: 5, installation_id: 6 } } });
  assert.equal(copy.booking_selection, undefined); assert.equal(copy.duration_minutes, 45);
});

test('ALL team is frozen whole, never narrowed to a lead, and corrupted/duplicate receipt cannot authorize replay', () => {
  const plan = fixture(); plan.bookingProfile.phases[0].professionals = { mode: 'all', ids: [5, 7], preferred_id: null };
  plan.appointments[0].phases[0].doctor_ids = [5, 7];
  const prepared = r.preparedMetadata(plan, 1);
  assert.deepEqual(prepared.intent.selections['1'].care, { installation_id: 6 });
  const receipt = r.receiptForAppointments([{ id_cita: 100, inicio: prepared.intent.slots[0].start_at,
    fin: prepared.intent.slots[0].end_at, titulo: 'Título congelado' }]);
  const committed = r.committedMetadata(prepared, receipt);
  assert.deepEqual(r.receiptFromMetadata(committed, prepared), receipt);
  for (const altered of [{ ...committed, actor_id: 2 }, { ...committed, receipt_sha256: '0'.repeat(64) },
    { ...committed, receipt: { created: [] } }, { ...committed, request_sha256: '0'.repeat(64) }]) {
    assert.throws(() => r.receiptFromMetadata(altered, prepared), { code: 'voucher_booking_receipt_invalid' });
  }
});
