'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { bookingPlanHash, assertBookingPlanReceipt } = require('../../lib/booking-plan-receipt');
const { solveBookingProfile } = require('../../lib/booking-profile-solver');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const clone = value => JSON.parse(JSON.stringify(value));
const profile = () => ({ version: 4, phases: [{ key: 'care', label: 'Sintético', duration_minutes: 30, start_offset_minutes: 0,
  installation_ids: [9], professionals: { mode: 'any', ids: [5], preferred_id: 5 }, equipment_requirements: [{ equipment_ids: [20, 21] }] }] });
const solution = () => ({ start_at: '2030-01-07T10:00:00.000Z', end_at: '2030-01-07T10:30:00.000Z', capacity_fully_verified: true,
  attention_requirements_pending: [], phases: [{ key: 'care', start_at: '2030-01-07T10:00:00.000Z', end_at: '2030-01-07T10:30:00.000Z',
    installation_id: 9, doctor_ids: [5], staff_time_scope: 'phase', equipment: [{ id: 20, name: 'Ficticia', turnaround_minutes: 10 }] }] });
test('receipt ignores labels, warnings, notes and instant formatting, not the physical plan', () => {
  const p = profile(), s = solution(), hash = bookingPlanHash(p, s), other = clone(s);
  p.phases[0].label = 'Otra descripción'; other.start_at = '2030-01-07T11:00:00+01:00'; other.phases[0].equipment[0].name = 'Otra etiqueta';
  other.warnings = [{ code: 'LABEL', message: 'No es autoridad' }]; other.nota = 'Irrelevante';
  assert.equal(bookingPlanHash(p, other), hash); assertBookingPlanReceipt(hash, p, other);
  assertBookingPlanReceipt(undefined, p, other);
});
test('machine, room, ALL member, turnaround, interval or clinical policy change rejects before persistence', () => {
  for (const mutate of [s => { s.phases[0].equipment[0].id = 21; }, s => { s.phases[0].installation_id = 10; },
    s => { s.phases[0].doctor_ids = [6]; }, s => { s.phases[0].equipment[0].turnaround_minutes = 15; },
    s => { s.phases[0].staff_intervals = [{ kind: 'start', start_at: s.start_at, end_at: '2030-01-07T10:05:00Z' }]; },
    s => { s.capacity_fully_verified = false; }]) {
    const p = profile(), before = solution(), after = clone(before); mutate(after);
    assert.throws(() => assertBookingPlanReceipt(bookingPlanHash(p, before), p, after), { code: 'booking_plan_changed', statusCode: 409 });
  }
  const p = profile(), updated = profile(); updated.phases[0].staff_attention = [{ mode: 'continuous', patient_preparation_minutes: 5 }];
  assert.throws(() => assertBookingPlanReceipt(bookingPlanHash(p, solution()), updated, solution()), { code: 'booking_plan_changed' });
  for (const raw of [null, '', 'bad', 'A'.repeat(64)]) assert.throws(() => assertBookingPlanReceipt(raw, p, solution()), { code: 'booking_plan_changed' });
});
function flexibleFixture() {
  const start = '2030-01-07T10:00:00Z', end = '2030-01-07T10:30:00Z';
  const windows = [{ start: '2030-01-07T09:00:00Z', end: '2030-01-07T12:00:00Z' }];
  const profile = { version: 4, phases: [{ key: 'care', duration_minutes: 30, start_offset_minutes: 0,
    installation_ids: [9], professionals: { mode: 'any', ids: [5], preferred_id: 5 } }] };
  const doctor = { windows, busy: [{ start, end, appointment_id: 80, can_share: true, clinic_id: 72 }],
    agenda_flexible: true, clinic_id: 72, schedule_verified: true, attention_visits: [], absence_windows: [] };
  const room = { windows, busy: [], clinic_id: 72, resource_key: 'installation:9', profesionales_permitidos: [5] };
  const solve = ({ room: changedRoom = room, doctor: changedDoctor = doctor, clinicWindows = windows } = {}) => solveBookingProfile({
    profile, start, doctors: new Map([[5, changedDoctor]]), installations: new Map([[9, changedRoom]]), clinicWindows,
    selections: { care: { doctor_id: 5, installation_id: 9 } }, allowOverlap: true });
  return { profile, doctor, room, solve };
}
test('real solver cannot widen an acknowledged overlap into a new clinical schedule or room-permission exception with the old receipt', () => {
  const f = flexibleFixture(), before = f.solve();
  assert(before); assert.equal(before.requires_overlap_acknowledgement, true); assert.deepEqual(before.warnings, []);
  for (const options of [{ room: { ...f.room, profesionales_permitidos: [6] } }, { room: { ...f.room, windows: [] } },
    { doctor: { ...f.doctor, windows: [] } }, { clinicWindows: [] }]) {
    const after = f.solve(options); assert(after); assert.equal(after.requires_overlap_acknowledgement, true);
    assert(after.warnings.some(warning => warning.code === 'FLEXIBLE_AGENDA'));
    assert.deepEqual(after.phases, before.phases); // Same physical plan, different permission being confirmed.
    assert.throws(() => assertBookingPlanReceipt(bookingPlanHash(f.profile, before), f.profile, after), { code: 'booking_plan_changed', statusCode: 409 });
  }
});
test('exception codes, phases, reasons, IDs and acknowledgement flags are pinned without descriptive or ordering noise', () => {
  const f = flexibleFixture(), s = f.solve({ room: { ...f.room, profesionales_permitidos: [6], windows: [] } });
  assert(s); const hash = bookingPlanHash(f.profile, s), descriptions = clone(s);
  descriptions.warnings[0].message = 'Descripción administrativa distinta'; descriptions.warnings[0].label = 'Otra etiqueta';
  descriptions.warnings[0].doctor_name = 'Otro nombre'; descriptions.warnings[0].reasons.reverse();
  descriptions.warnings.push({ code: 'LABEL', message: 'Sólo etiquetas' });
  assert.equal(bookingPlanHash(f.profile, descriptions), hash);
  for (const mutate of [s => { s.requires_overlap_acknowledgement = false; }, s => { s.requires_priority_acknowledgement = true; },
    s => { s.warnings[0].code = 'FUTURE_CLINICAL_EXCEPTION'; }, s => { s.warnings[0].phase_key = 'other'; },
    s => { s.warnings[0].doctor_id = 6; }, s => { s.warnings[0].reasons.push('staff_schedule'); },
    s => { s.warnings[0].preferred_doctor_id = 6; }, s => { s.warnings[0].resource_id = 10; }]) {
    const changed = clone(s); mutate(changed);
    assert.throws(() => assertBookingPlanReceipt(hash, f.profile, changed), { code: 'booking_plan_changed' });
  }
  const multiple = clone(s); multiple.warnings.push({ code: 'NON_PREFERRED_PROFESSIONAL', phase_key: 'care', doctor_id: 5,
    preferred_doctor_id: 6, preferred_available: false, only_available_alternative: true, fallback_when: 'absence_only', fallback_reason: 'absence' });
  const reordered = clone(multiple); reordered.warnings.reverse(); assert.equal(bookingPlanHash(f.profile, reordered), bookingPlanHash(f.profile, multiple));
});
test('real selected substitute receipt retains the exact priority decision but not descriptive labels', () => {
  const f = flexibleFixture(); f.profile.phases[0].professionals = { mode: 'any', ids: [5, 6], preferred_id: 6, fallback_when: 'unavailable' };
  const s = f.solve(); assert(s); assert.equal(s.requires_priority_acknowledgement, true);
  assert(s.warnings.some(row => row.code === 'NON_PREFERRED_PROFESSIONAL'));
  const before = bookingPlanHash(f.profile, s), changed = clone(s);
  changed.warnings.find(row => row.code === 'NON_PREFERRED_PROFESSIONAL').preferred_available = true;
  assert.throws(() => assertBookingPlanReceipt(before, f.profile, changed), { code: 'booking_plan_changed' });
  const falseFlag = clone(s); falseFlag.requires_priority_acknowledgement = false;
  assert.throws(() => assertBookingPlanReceipt(before, f.profile, falseFlag), { code: 'booking_plan_changed' });
});
const frozenProfile = (profile, solution) => solution.phases.some(phase => phase.staff_attention)
  ? normalizeBookingProfile({ ...profile, version: profile.version === 4 ? 4 : 3,
    phases: profile.phases.map((phase, index) => ({ ...phase,
      ...(solution.phases[index].staff_attention ? { staff_attention: solution.phases[index].staff_attention } : {}) })) })
  : normalizeBookingProfile(profile);
test('real v4 effective default attention makes raw preview and frozen snapshot receipts identical without changing the source', () => {
  const f = flexibleFixture(), before = clone(f.profile), s = f.solve(), frozen = frozenProfile(f.profile, s);
  assert.equal(frozen.version, 4); assert.deepEqual(frozen.phases[0].staff_attention, [{ mode: 'continuous', patient_preparation_minutes: 0 }]);
  assert.equal(f.profile.phases[0].staff_attention, undefined); assert.deepEqual(f.profile, before);
  assert.equal(bookingPlanHash(f.profile, s), bookingPlanHash(frozen, s));
  assertBookingPlanReceipt(bookingPlanHash(f.profile, s), frozen, s);
});
test('real inherited machine attention upgrades only the effective legacy profile v2→v3 and reproduces its frozen receipt', () => {
  const windows = [{ start: '2030-01-07T09:00:00Z', end: '2030-01-07T12:00:00Z' }];
  const p = { version: 2, phases: [{ key: 'machine', duration_minutes: 30, installation_ids: [9],
    professionals: { mode: 'any', ids: [5], preferred_id: 5 }, equipment_requirements: [{ equipment_ids: [20] }] }] };
  const before = clone(p), policies = { mode: 'start_end', start_minutes: 5, start_window_minutes: 15, end_minutes: 5, end_window_minutes: 15 };
  const solve = attention_policy => solveBookingProfile({ profile: p, start: '2030-01-07T10:00:00Z',
    doctors: new Map([[5, { windows, busy: [] }]]), installations: new Map([[9, { windows, busy: [], resource_key: 'installation:9' }]]),
    equipment: new Map([[20, { id: 20, status: 'available', installation_ids: new Set([9]), busy: [], turnaround_minutes: 10, attention_policy }]]) });
  const s = solve(policies); assert(s); const frozen = frozenProfile(p, s);
  assert.equal(frozen.version, 3); assert.deepEqual(frozen.phases[0].staff_attention, [policies]);
  assert.equal(bookingPlanHash(p, s), bookingPlanHash(frozen, s)); assert.deepEqual(p, before);
  assertBookingPlanReceipt(bookingPlanHash(p, s), frozen, s);
  const changed = solve({ ...policies, start_minutes: 10 }); assert(changed);
  assert.throws(() => assertBookingPlanReceipt(bookingPlanHash(p, s), p, changed), { code: 'booking_plan_changed' });
  const continuous = solve({ mode: 'continuous', patient_preparation_minutes: 0 }); assert(continuous);
  assert.equal(frozenProfile(p, continuous).version, 2); // No segmentation, no automatic legacy upgrade.
  assert.notEqual(bookingPlanHash(p, continuous), bookingPlanHash({ ...p, version: 3 }, continuous));
});
test('effective canonicalization rejects contradictory explicit policies instead of discarding them', () => {
  const f = flexibleFixture(), s = f.solve(), frozen = frozenProfile(f.profile, s), receipt = bookingPlanHash(f.profile, s);
  const changed = clone(frozen); changed.phases[0].staff_attention[0].patient_preparation_minutes = 5;
  assert.throws(() => assertBookingPlanReceipt(receipt, changed, s), { code: 'booking_plan_changed' });
  const changedResolved = clone(s); changedResolved.phases[0].staff_attention[0].patient_preparation_minutes = 5;
  assert.throws(() => assertBookingPlanReceipt(receipt, frozen, changedResolved), { code: 'booking_plan_changed' });
  const formattingOnly = clone(s); formattingOnly.phases[0].staff_attention = [{ mode: 'continuous' }];
  assertBookingPlanReceipt(receipt, frozen, formattingOnly); // Explicit zero and normalized default are the same rule.
  const changedRoom = clone(s); changedRoom.phases[0].installation_id = 10;
  assert.throws(() => assertBookingPlanReceipt(receipt, frozen, changedRoom), { code: 'booking_plan_changed' });
  const changedFlag = clone(s); changedFlag.requires_overlap_acknowledgement = false;
  assert.throws(() => assertBookingPlanReceipt(receipt, frozen, changedFlag), { code: 'booking_plan_changed' });
});
