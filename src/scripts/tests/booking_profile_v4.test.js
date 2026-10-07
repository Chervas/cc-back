'use strict';

// Pure helpers, fictional resources and dates. No DB, environment or providers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAttentionPolicy, planStaffAttention, planStaffAttentionSteps, validStaffIntervals } = require('../../lib/booking-attention');
const { normalizeBookingProfile, bookingPhaseOffsets, bookingProfileDurationMinutes, pendingAttentionRequirements } = require('../../lib/booking-profile');
const { solveBookingProfile, occupancyForSolution } = require('../../lib/booking-profile-solver');
const { mergeClinicalConfig } = require('../../lib/treatment-catalog-contract');
const { attentionVisitOrigin, attentionVisitConflict } = require('../../lib/booking-attention-origin');

const BASE = Date.parse('2030-01-07T09:30:00Z');
const iso = minutes => new Date(BASE + minutes * 60000).toISOString();
const start = iso(0), end = iso(30);
const continuous = { mode: 'continuous', patient_preparation_minutes: 0 };
const setup = { mode: 'start_only', start_minutes: 5, start_window_minutes: 15 };
const attended = { mode: 'start_continuous', start_minutes: 5, start_window_minutes: 15 };
const oldAuto = { mode: 'start_end', start_minutes: 5, start_window_minutes: 10, end_minutes: 5, end_window_minutes: 10 };
const resource = overrides => ({ windows: [{ start: iso(-30), end: iso(630) }], busy: [], ...overrides });
const phase = (key, { offset = 0, duration = 30, room = 9, doctor = 5, machine = null, policy = null, pending = null, team = null, sharing = false } = {}) => ({
  key, start_offset_minutes: offset, duration_minutes: duration, installation_ids: [room],
  professionals: { mode: team ? 'all' : 'any', ids: team || [doctor], preferred_id: team ? null : doctor },
  ...(machine ? { equipment_requirements: [{ equipment_ids: [machine] }] } : {}),
  ...(policy ? { staff_attention: [policy] } : {}),
  ...(pending ? { attention_requirements_pending: pending } : {}),
  ...(sharing ? { preparation_sharing: { mode: 'same_start' } } : {}),
});
const profile = (...phases) => ({ version: 4, phases });
function context() {
  return { doctors: new Map([5, 6, 7].map(id => [id, resource({ name: `Fictional clinician ${id}`, clinic_id: 72, attention_visits: [] })])),
    installations: new Map([9, 10, 11, 12, 13].map(id => [id, resource({ name: `Fictional room ${id}`, resource_key: `installation:${id}` })])),
    equipment: new Map([1, 2, 3, 4].map(id => [id, { id, name: `Fictional unit ${id}`, status: 'available', turnaround_minutes: 0,
      installation_ids: new Set([9, 10, 11, 12, 13]), busy: [], attention_policy: continuous }])) };
}
function reserve(c, solution, p) {
  const id = (c.nextVisitId || 0) + 1; c.nextVisitId = id;
  const rows = occupancyForSolution(solution).map(row => ({ ...row, appointment_id: id }));
  for (const row of rows) {
    const target = row.resource_kind === 'doctor' ? c.doctors.get(row.doctor_id)
      : row.resource_kind === 'installation' ? c.installations.get(row.installation_id)
        : c.equipment.get(Number(row.resource_key.split(':')[1]));
    target.busy.push({ start: row.start_at, end: row.end_at, appointment_id: id });
  }
  if (p) {
    const frozen = normalizeBookingProfile({ ...p, phases: p.phases.map((step, index) => ({ ...step,
      ...(solution.phases[index].staff_attention ? { staff_attention: solution.phases[index].staff_attention } : {}) })) });
    const appointment = { id_cita: id, clinica_id: 72, inicio: solution.start_at, fin: solution.end_at,
      booking_attention_snapshot: { version: 1, profile: frozen, phases: solution.phases,
        capacity_fully_verified: solution.capacity_fully_verified, attention_requirements_pending: solution.attention_requirements_pending } };
    for (const doctorId of new Set(rows.map(row => row.doctor_id).filter(Boolean))) c.doctors.get(doctorId).attention_visits
      .push(attentionVisitOrigin({ appointment, doctorId, occupancies: rows }));
  }
}
const permutations = rows => rows.length ? rows.flatMap((row, index) => permutations(rows.filter((_, position) => index !== position)).map(rest => [row, ...rest])) : [[]];

test('v4 has explicit offsets and a span; v1–3 remain sequential without extra fields', () => {
  const p = normalizeBookingProfile(profile(phase('extraction'), phase('application', { offset: 15, doctor: 6, room: 10 })));
  assert.deepEqual(bookingPhaseOffsets(p), [0, 15]);
  assert.equal(bookingProfileDurationMinutes(p), 45);
  for (const version of [1, 2, 3]) {
    const old = { version, phases: [phase('first'), phase('second')] };
    old.phases.forEach(step => delete step.start_offset_minutes);
    const normalized = normalizeBookingProfile(old);
    assert.deepEqual(bookingPhaseOffsets(normalized), [0, 30]);
    assert.equal(bookingProfileDurationMinutes(normalized), 60);
    assert.equal(Object.hasOwn(normalized.phases[0], 'start_offset_minutes'), false);
  }
  const unfinished = normalizeBookingProfile({ version: 4, phases: [{ ...phase('unknown'), duration_minutes: null }] }, { allowIncomplete: true });
  assert.equal(bookingProfileDurationMinutes(unfinished), null, 'Unknown duration is not a zero-length visit');
});

test('v4 timing never defaults, coerces, starts before the visit or exceeds a day', () => {
  const base = profile(phase('first'));
  for (const mutation of [
    p => delete p.phases[0].start_offset_minutes,
    p => p.phases[0].start_offset_minutes = '0',
    p => p.phases[0].start_offset_minutes = -1,
    p => p.phases[0].start_offset_minutes = 0.5,
    p => p.phases[0].start_offset_minutes = 1,
    p => p.phases.push(phase('late', { offset: 1439, duration: 2 })),
    p => p.version = 3,
  ]) {
    const input = structuredClone(base); mutation(input);
    assert.throws(() => normalizeBookingProfile(input), { code: 'booking_profile_invalid' });
  }
  const boundary = normalizeBookingProfile(profile(phase('all_day', { duration: 1440 })));
  assert.equal(bookingProfileDurationMinutes(boundary), 1440);
  // Array order is editorial, not an accidental timing constraint.
  const unordered = normalizeBookingProfile(profile(phase('later', { offset: 15 }), phase('first', { doctor: 6, room: 10 })));
  assert.deepEqual(bookingPhaseOffsets(unordered), [15, 0]);
});

test('overlapping steps reserve the patient span, each room and each effective clinician', () => {
  const c = context(), p = profile(phase('extraction'), phase('application', { offset: 15, doctor: 6, room: 10 }));
  const result = solveBookingProfile({ profile: p, start, ...c });
  assert(result); assert.equal(result.end_at, iso(45));
  assert.deepEqual(result.phases.map(step => [step.start_at, step.end_at]), [[iso(0), iso(30)], [iso(15), iso(45)]]);
  assert.equal(result.capacity_fully_verified, true);
  const rows = occupancyForSolution(result);
  assert.deepEqual(rows.filter(row => row.resource_kind === 'doctor').map(row => [row.doctor_id, row.start_at, row.end_at]),
    [[5, iso(0), iso(30)], [6, iso(15), iso(45)]]);
  assert.equal(rows.filter(row => row.resource_kind === 'installation').length, 2);
  // Same person cannot deliver two concurrent acts just because they share a visit.
  p.phases[1].professionals = { mode: 'any', ids: [5], preferred_id: 5 };
  assert.equal(solveBookingProfile({ profile: p, start, ...c }), null);
});

test('team scope is a phase only in v4; old ALL snapshots still occupy the full visit', () => {
  const c = context(); c.doctors.get(5).busy.push({ start: iso(30), end: iso(45) });
  const p = profile(phase('team', { team: [5, 7] }), phase('later', { offset: 30, duration: 15, doctor: 6, room: 10 }));
  const result = solveBookingProfile({ profile: p, start, ...c });
  assert(result); assert.equal(result.phases[0].staff_time_scope, 'phase');
  assert.equal(occupancyForSolution(result).find(row => row.doctor_id === 5).end_at, iso(30));
  const old = structuredClone(p); old.version = 1; old.phases.forEach(step => delete step.start_offset_minutes);
  assert.equal(solveBookingProfile({ profile: old, start, ...c }), null);
});

test('setup-only is explicit and cannot silently strip a configured final', () => {
  assert.deepEqual(normalizeAttentionPolicy(setup), setup);
  assert.deepEqual(normalizeAttentionPolicy(attended), attended);
  for (const input of [{ ...setup, end_minutes: 5 }, { ...setup, end_window_minutes: 10 }, { ...attended, end_minutes: 5 },
    { ...setup, start_minutes: '5' }, { ...setup, start_minutes: 15, start_window_minutes: 10 }]) {
    assert.throws(() => normalizeAttentionPolicy(input), { code: 'booking_attention_invalid' });
  }
  const available = resource({ busy: [{ start: iso(15), end: iso(30) }] });
  assert(planStaffAttention({ resource: available, start, end, policies: [setup] }));
  assert.equal(planStaffAttention({ resource: available, start, end, policies: [oldAuto] }), null);
  assert.throws(() => normalizeBookingProfile({ version: 3, phases: [{ ...phase('one', { machine: 1, policy: setup }), start_offset_minutes: undefined }] }),
    { code: 'booking_profile_invalid' });
});

test('a v4 global attention override cannot hide the needs of a second required machine', () => {
  const step = phase('two_techniques', { machine: 1, policy: setup });
  step.equipment_requirements.push({ equipment_ids: [2] });
  assert.throws(() => normalizeBookingProfile(profile(step)), { code: 'booking_profile_invalid', details: { field: 'phases.0.staff_attention' } });
  delete step.staff_attention;
  assert(normalizeBookingProfile(profile(step)), 'The unfinished definition remains readable without inventing an override');
  assert.throws(() => solveBookingProfile({ profile: profile(step), start, ...context() }), { code: 'booking_profile_attention_ambiguous' });
});

test('setup followed by attended application has no fake free gap or unattended INDIBA', () => {
  const plan = planStaffAttention({ resource: resource(), start, end, policies: [attended] });
  assert.deepEqual(plan, [{ start_at: iso(10), end_at: iso(15), kind: 'start' }, { start_at: iso(15), end_at: iso(30), kind: 'continuous' }]);
  const step = { start_at: start, end_at: end, staff_intervals: plan };
  assert(validStaffIntervals(step, [attended]));
  assert.equal(validStaffIntervals({ ...step, staff_intervals: [{ ...plan[0] }, { ...plan[1], start_at: iso(20) }] }, [attended]), false);
  assert.equal(validStaffIntervals({ ...step, staff_intervals: [{ ...plan[0] }] }, [attended]), false);
  assert.equal(planStaffAttention({ resource: resource({ busy: [{ start: iso(20), end: iso(25) }] }), start, end, policies: [attended] }), null);
  const short = planStaffAttention({ resource: resource(), start, end: iso(15), policies: [attended] });
  assert(short); assert(short.at(-1).start_at < short.at(-1).end_at);
});

test('joint attention fits three quantified preparations and INDIBA afterward in every array order', () => {
  // Fictional capacity fixture. It intentionally does NOT pretend to quantify
  // the real EMS intermediate clinical check; that pending case is below.
  const steps = [phase('preso', { room: 9, machine: 1, policy: setup }),
    phase('ems', { room: 10, machine: 2, policy: setup }),
    phase('indiba', { room: 11, machine: 3, policy: attended })];
  for (const ordered of permutations(steps)) {
    const result = solveBookingProfile({ profile: profile(...ordered), start, ...context() });
    assert(result, ordered.map(step => step.key).join(','));
    const intervals = result.phases.flatMap(step => step.staff_intervals);
    assert.equal(intervals.filter(interval => interval.kind === 'start').reduce((total, interval) => total + (+new Date(interval.end_at) - +new Date(interval.start_at)) / 60000, 0), 15);
    const ongoing = result.phases.find(step => step.key === 'indiba').staff_intervals.find(interval => interval.kind === 'continuous');
    assert.deepEqual([ongoing.start_at, ongoing.end_at], [iso(15), iso(30)]);
    const rows = occupancyForSolution(result);
    assert(rows.filter(row => ['installation', 'equipment'].includes(row.resource_kind)).every(row => row.start_at === start && row.end_at === end));
  }
});

test('a single visit jointly plans unlike finals rather than freezing a greedy earlier choice', () => {
  const policy = { mode: 'start_end', start_minutes: 5, start_window_minutes: 15, end_minutes: 5, end_window_minutes: 15 };
  const steps = [phase('long', { duration: 45, room: 9, machine: 1, policy }),
    phase('medium', { duration: 30, room: 10, machine: 2, policy }),
    phase('short', { duration: 20, room: 11, machine: 3, policy })];
  for (const ordered of permutations(steps)) {
    const result = solveBookingProfile({ profile: profile(...ordered), start, ...context() });
    assert(result, ordered.map(step => step.key).join(','));
    assert.equal(result.end_at, iso(45));
    assert(result.phases.every(step => validStaffIntervals(step, [policy])));
  }
});

test('an explicitly quantified intermediate step cannot overlap attended application', () => {
  // Five minutes at 20–25 is purely a test fixture, NOT the source EMS protocol.
  const steps = [phase('preso', { room: 9, machine: 1, policy: setup }),
    phase('ems', { room: 10, machine: 2, policy: setup }),
    phase('indiba', { room: 11, machine: 3, policy: attended }),
    phase('fictional_intermediate_check', { offset: 20, duration: 5, room: 10 })];
  assert.equal(solveBookingProfile({ profile: profile(...steps), start, ...context() }), null);
  steps[3].professionals = { mode: 'any', ids: [6], preferred_id: 6 };
  assert(solveBookingProfile({ profile: profile(...steps), start, ...context() }), 'Explicit eligible help can provide this fictional check');
});

test('separate same-start appointments use fixed saved intervals and retain capacity regardless of booking order', () => {
  const cases = [phase('preso', { room: 9, machine: 1, policy: setup, sharing: true }),
    phase('ems', { room: 10, machine: 2, policy: setup, sharing: true }),
    phase('indiba', { room: 11, machine: 3, policy: attended, sharing: true })];
  for (const ordered of permutations(cases)) {
    const c = context();
    for (const step of ordered) {
      const result = solveBookingProfile({ profile: profile(step), start, ...c });
      assert(result, `${ordered.map(row => row.key).join(',')}: ${step.key}`);
      reserve(c, result, profile(step));
    }
    assert.equal(solveBookingProfile({ profile: profile(phase('fourth', { room: 12, machine: 4, policy: setup, sharing: true })), start, ...c }), null);
    assert(c.doctors.get(5).attention_visits.every(visit => visit.verified));
    assert.equal(c.doctors.get(5).busy.reduce((minutes, interval) => minutes + (Date.parse(interval.end) - Date.parse(interval.start)) / 60000, 0), 30,
      '15 minutes of setup and 15 minutes of continuous INDIBA remain occupied');
  }
});

test('preparation sharing is an exact local v4 opt-in, never inferred for old versions or unknown initial work', () => {
  const p = profile(phase('care', { policy: setup, sharing: true }));
  assert.deepEqual(normalizeBookingProfile(p).phases[0].preparation_sharing, { mode: 'same_start' });
  for (const mutation of [value => { value.version = 3; delete value.phases[0].start_offset_minutes; },
    value => { value.phases[0].preparation_sharing = null; },
    value => { value.phases[0].preparation_sharing.mode = 'any_start'; },
    value => { value.phases[0].preparation_sharing.minutes = 15; },
    value => { value.phases[0].staff_attention = [continuous]; },
    value => { value.phases[0].staff_attention.push(setup); },
    value => { delete value.phases[0].staff_attention; },
    value => { value.phases[0].professionals.mode = 'all'; },
    value => { value.phases.push(phase('first', { doctor: 6, room: 10 })); value.phases[0].start_offset_minutes = 5; }]) {
    const source = structuredClone(p); mutation(source);
    assert.throws(() => normalizeBookingProfile(source), { code: 'booking_profile_invalid' });
  }
  assert.equal(Object.hasOwn(normalizeBookingProfile(profile(phase('care', { policy: setup }))).phases[0], 'preparation_sharing'), false);
  // Different initial windows inside ONE visit are still explicit, quantified
  // tasks. The cross-patient equality rule is not applied internally.
  const mixed = profile(phase('one', { policy: { ...setup, start_window_minutes: 10 }, sharing: true }),
    phase('two', { policy: setup, sharing: true, room: 10 }));
  assert(solveBookingProfile({ profile: mixed, start, ...context() }));
});

test('different visit starts or initial windows cannot use another patient partial-attention gap', () => {
  const source = profile(phase('preso', { policy: setup, sharing: true })), c = context();
  reserve(c, solveBookingProfile({ profile: source, start, ...c }), source);
  const target = profile(phase('ems', { policy: setup, sharing: true, room: 10 }));
  assert(solveBookingProfile({ profile: target, start, ...c }));
  for (const offset of [5, 15, 25]) assert.equal(solveBookingProfile({ profile: target, start: iso(offset), ...c }), null);
  const changedWindow = structuredClone(target); changedWindow.phases[0].staff_attention[0].start_window_minutes = 10;
  assert.equal(solveBookingProfile({ profile: changedWindow, start, ...c }), null);
  const noPermission = structuredClone(target); delete noPermission.phases[0].preparation_sharing;
  assert.equal(solveBookingProfile({ profile: noPermission, start, ...c }), null);
  const rule = attentionVisitConflict(c.doctors.get(5), { phase: target.phases[0], visitStart: iso(5), start: iso(5), end: iso(35), policies: [setup] });
  assert.equal(rule.code, 'preparation_start_mismatch'); assert.deepEqual(Object.keys(rule).sort(), ['code', 'message']);
  assert(solveBookingProfile({ profile: target, start: end, ...c }), 'No overlap after the source visit ends');
});

test('missing source evidence, source opt-in or foreign clinic never authorizes partial sharing', () => {
  const source = profile(phase('preso', { policy: setup, sharing: true }));
  const target = profile(phase('ems', { policy: setup, sharing: true, room: 10 }));
  for (const change of [c => { c.doctors.get(5).attention_visits[0].verified = false; },
    c => { c.doctors.get(5).attention_visits[0].version = null; c.doctors.get(5).attention_visits[0].verified = false; },
    c => { delete c.doctors.get(5).attention_visits[0].phases[0].preparation_sharing; },
    c => { c.doctors.get(5).attention_visits[0].clinic_id = 73; }]) {
    const c = context(); reserve(c, solveBookingProfile({ profile: source, start, ...c }), source); change(c);
    assert.equal(solveBookingProfile({ profile: target, start, ...c }), null);
  }
  const c = context(); reserve(c, solveBookingProfile({ profile: source, start, ...c }));
  assert.equal(solveBookingProfile({ profile: target, start, ...c }), null, 'Bare appointment occupancy is not source evidence');
  const unknown = context(); unknown.doctors.get(5).attention_visits.push({ appointment_id: 1, start, end,
    verified: false, version: null, partial: true, phases: [] });
  assert.equal(solveBookingProfile({ profile: target, start: iso(15), ...unknown }), null, 'Unknown visit origin protects even time after its recorded preparation');
});

test('unknown EMS intermediate care is visible in preview and rejects strict clinical validation', () => {
  const pending = [{ key: 'mid_check', label: 'Comprobación a mitad de EMS: duración y ventana pendientes.' }];
  const p = profile(phase('ems', { machine: 1, policy: setup, pending })), c = context();
  const normalized = normalizeBookingProfile(p);
  assert.deepEqual(pendingAttentionRequirements(normalized), [{ phase_key: 'ems', ...pending[0] }]);
  assert.throws(() => solveBookingProfile({ profile: p, start, ...c }), { code: 'pending_attention_requirements', statusCode: 409 });
  const preview = solveBookingProfile({ profile: p, start, ...c, attentionValidation: 'preview' });
  assert(preview); assert.equal(preview.capacity_fully_verified, false);
  assert.deepEqual(preview.attention_requirements_pending, pendingAttentionRequirements(normalized));
  assert(preview.warnings.some(warning => warning.code === 'PENDING_ATTENTION_REQUIREMENTS'));
  assert.equal(preview.phases[0].staff_intervals.length, 1, 'No fictional duration is introduced for a pending check');
  for (const requirement of [{ ...pending[0], minutes: 0 }, { ...pending[0], label: '' }, { ...pending[0], key: 'bad key' }]) {
    assert.throws(() => normalizeBookingProfile(profile(phase('ems', { pending: [requirement] }))), { code: 'booking_profile_invalid' });
  }
  assert.throws(() => normalizeBookingProfile(profile(phase('ems', { pending: [...pending, ...pending] }))), { code: 'booking_profile_invalid' });
});

test('room aliases and one physical machine do not create concurrent capacity', () => {
  const c = context();
  c.installations.get(10).resource_key = c.installations.get(9).resource_key;
  c.installations.get(10).busy.push({ start, end });
  assert.equal(solveBookingProfile({ profile: profile(phase('blocked', { room: 9 })), start, ...c }), null);
  c.installations.get(10).busy.length = 0;
  assert.equal(solveBookingProfile({ profile: profile(phase('one', { machine: 1 }), phase('two', { room: 11, doctor: 6, machine: 1 })), start, ...c }), null);
  c.equipment.get(1).busy.push({ start, end });
  assert.equal(solveBookingProfile({ profile: profile(phase('taken', { machine: 1, policy: setup })), start, ...c, allowOverlap: true }), null);
});

test('machine turnaround is preserved across relative steps and reusable within the same physical room', () => {
  const c = context(); c.equipment.get(1).turnaround_minutes = 10;
  const first = phase('first', { duration: 20, machine: 1, policy: setup });
  const second = phase('second', { offset: 20, duration: 20, room: 10, machine: 1, policy: setup });
  assert.equal(solveBookingProfile({ profile: profile(first, second), start, ...c }), null);
  second.start_offset_minutes = 30;
  assert(solveBookingProfile({ profile: profile(first, second), start, ...c }));
  second.start_offset_minutes = 20; second.installation_ids = [9];
  assert(solveBookingProfile({ profile: profile(first, second), start, ...c }));
});

test('v4 searches resource alternatives and joint attention rather than committing greedy phases', () => {
  const c = context(), first = phase('first', { duration: 20 }), second = phase('second', { duration: 20, room: 10 });
  first.professionals = { mode: 'any', ids: [5, 6], preferred_id: 5, fallback_when: 'unavailable' };
  const result = solveBookingProfile({ profile: profile(first, second), start, ...c });
  assert(result); assert.deepEqual(result.phases.map(step => step.doctor_ids), [[6], [5]]);
  assert(result.warnings.some(warning => warning.code === 'NON_PREFERRED_PROFESSIONAL' && warning.only_available_alternative));
  assert.equal(result.requires_priority_acknowledgement, true);
  const unitFirst = phase('machine_first', { duration: 20, machine: 1, room: 9 });
  unitFirst.equipment_requirements = [{ equipment_ids: [1, 2] }];
  const unitSecond = phase('machine_second', { duration: 20, machine: 1, room: 10, doctor: 6 });
  const machineResult = solveBookingProfile({ profile: profile(unitFirst, unitSecond), start, ...c });
  assert(machineResult); assert.deepEqual(machineResult.phases.map(step => step.equipment[0].id), [2, 1]);
});

test('profile configuration does not mutate context, reorder phases, invent resources or degrade snapshots', () => {
  const c = context(), p = profile(phase('one', { machine: 1, policy: setup }));
  const before = structuredClone({ c, p });
  const first = solveBookingProfile({ profile: p, start, ...c });
  const second = solveBookingProfile({ profile: p, start, ...c });
  assert.deepEqual(second, first);
  assert.deepEqual({ c, p }, before);
  const frozen = normalizeBookingProfile(p);
  c.equipment.get(1).attention_policy = oldAuto;
  assert.deepEqual(solveBookingProfile({ profile: frozen, start, ...c }).phases[0].staff_intervals, first.phases[0].staff_intervals);
  for (const version of [1, 2, 3]) {
    const downgraded = structuredClone(frozen); downgraded.version = version;
    assert.throws(() => mergeClinicalConfig({ booking_profile: frozen }, { booking_profile: downgraded }), { code: 'booking_equipment_client_outdated' });
  }
  const old = { version: 2, phases: [{ ...phase('old', { machine: 1 }), start_offset_minutes: undefined }] };
  delete old.phases[0].start_offset_minutes;
  c.equipment.get(1).attention_policy = setup;
  assert.throws(() => solveBookingProfile({ profile: old, start, ...c }), { code: 'booking_profile_invalid' });
});

test('no intervention escapes a shift, a clinical block, an explicit final or the reserved window', () => {
  const c = context(); c.doctors.get(5).busy.push({ start: iso(0), end: iso(15) });
  assert.equal(solveBookingProfile({ profile: profile(phase('setup', { machine: 1, policy: setup })), start, ...c }), null);
  const r = resource({ windows: [{ start: iso(15), end }] });
  assert.equal(planStaffAttention({ resource: r, start, end, policies: [setup] }), null);
  assert.equal(planStaffAttention({ resource: resource(), start, end: iso(10), policies: [setup] }), null);
  assert.equal(planStaffAttention({ resource: resource(), start, end, policies: [{ ...oldAuto, end_window_minutes: 40 }] }), null);
  const pair = planStaffAttentionSteps({ resource: resource(), steps: [
    { key: 'a', start, end, policies: [oldAuto] }, { key: 'b', start, end, policies: [oldAuto] },
  ] });
  assert(pair); assert(pair.every(row => row.staff_intervals.some(interval => interval.kind === 'end')));
  assert.equal(planStaffAttentionSteps({ resource: resource(), steps: [
    { key: 'duplicate', start, end, policies: [setup] }, { key: 'duplicate', start, end, policies: [setup] },
  ] }), null);
});

test('ordinary sharing remains explicit, while v4 technical work cannot be forced over protected occupancy', () => {
  const c = context(), busy = { start, end, can_share: true, appointment_id: 1 };
  c.doctors.get(5).busy.push(busy); c.installations.get(9).busy.push(busy);
  const ordinary = profile(phase('consultation'));
  assert.equal(solveBookingProfile({ profile: ordinary, start, ...c }), null);
  assert(solveBookingProfile({ profile: ordinary, start, ...c, allowOverlap: true }).requires_overlap_acknowledgement);
  assert.equal(solveBookingProfile({ profile: profile(phase('technical', { machine: 1, policy: setup })), start, ...c, allowOverlap: true }), null);
  c.installations.get(9).busy = []; c.doctors.get(5).busy = [{ start, end, can_share: false }];
  assert.equal(solveBookingProfile({ profile: ordinary, start, ...c, allowOverlap: true }), null);
});
