#!/usr/bin/env node
'use strict';

/**
 * Offline product proposal, NOT a validation of a CRM booking or clinical rule.
 * Fictional patients, staff, machines, rooms and durations; no DB/network/env.
 * Run: node src/scripts/bs_staff_attention_simulation.js
 * Existing pure runtime functions are exercised only against in-memory data.
 * Runtime comparisons deliberately target the historical v1–3 contract.
 * The new v4 core has its own regression tests; it is not activated by this file.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { normalizeAttentionPolicy } = require('../lib/booking-attention');
const { normalizeBookingProfile } = require('../lib/booking-profile');
const { solveBookingProfile, occupancyForSolution } = require('../lib/booking-profile-solver');

const BASE = Date.parse('2030-01-07T09:00:00Z');
const MINUTE = 60000;
const COMMON_START_WINDOW = 15;
const iso = minute => new Date(BASE + minute * MINUTE).toISOString();
const minute = instant => (+new Date(instant) - BASE) / MINUTE;
const clone = value => structuredClone(value);
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function machine(id, name, overrides = {}) {
  return { id: `fictional-${name.toLowerCase()}-${id}`, patient_id: `fictional-patient-${id}`,
    staff_id: 999, room_id: 100 + id, machine_id: id, name,
    start: 0, end: 30, mode: 'start_end', setup_minutes: 5,
    final_minutes: name === 'MAGNETO' ? null : 5, final_window_minutes: 10,
    ...(name === 'MAGNETO' ? { identity_verified: false, real_third_equipment_demonstrated: false } : {}),
    ...overrides };
}
const pair = () => [machine(1, 'PRESO'), machine(2, 'EMS')];
const trio = () => [...pair(), machine(3, 'MAGNETO')];
// Proposal-only mode: final care is not configured, NOT declared unnecessary.
// Distinct fictional resource IDs do not establish a real third physical unit.
const startOnly = row => ({ ...row, mode: 'start_only', final_minutes: null,
  final_window_minutes: null, final_care: 'not_configured_not_asserted_absent' });
const startOnlyTrio = () => trio().map(startOnly);
const hypotheticalTrio = overrides => trio().map(row => ({ ...row,
  final_minutes: 5, ...overrides }));
const ondas = overrides => machine(4, 'ONDAS', { mode: 'continuous', end: 20,
  setup_minutes: null, final_minutes: null, patient_preparation_minutes: 5, ...overrides });
const exionContinuousFixture = () => machine(5, 'EXION', { mode: 'continuous',
  setup_minutes: null, final_minutes: null, patient_preparation_minutes: 0 });
const defaultEnvironment = () => ({ staff_windows: [{ start: 0, end: 180 }],
  staff_busy: [], room_busy: [], machine_busy: [] });

function runtimePolicy(row, initialWindow) {
  if (row.mode === 'continuous') return { mode: 'continuous',
    patient_preparation_minutes: row.patient_preparation_minutes || 0 };
  if (row.mode === 'start_only') return { mode: 'start_only', start_minutes: row.setup_minutes,
    start_window_minutes: initialWindow };
  return { mode: 'start_end', start_minutes: row.setup_minutes,
    start_window_minutes: initialWindow, end_minutes: row.final_minutes,
    end_window_minutes: row.final_window_minutes };
}
function runtimeProfile(row, initialWindow, frozen = false) {
  const phase = { key: 'fictional-phase', label: row.name,
    duration_minutes: row.end - row.start, installation_ids: [row.room_id],
    professionals: { mode: 'any', ids: [row.staff_id], preferred_id: row.staff_id },
    equipment_requirements: [{ equipment_ids: [row.machine_id] }] };
  if (frozen) phase.staff_attention = [runtimePolicy(row, initialWindow)];
  return { version: frozen ? 3 : 2, phases: [phase] };
}
function runtimeContext(rows, environment, initialWindow) {
  const windows = environment.staff_windows.map(row => ({ start: iso(row.start), end: iso(row.end) }));
  return {
    doctors: new Map([[999, { name: 'Profesional ficticio', windows,
      busy: environment.staff_busy.map(row => ({ ...row, start: iso(row.start), end: iso(row.end) })) }]]),
    installations: new Map(rows.map(row => [row.room_id, { name: `Sala ficticia ${row.room_id}`,
      windows: [{ start: iso(0), end: iso(180) }], resource_key: `installation:${row.room_id}`,
      busy: environment.room_busy.filter(busy => busy.id === row.room_id)
        .map(busy => ({ start: iso(busy.start), end: iso(busy.end) })) }])),
    equipment: new Map(rows.map(row => [row.machine_id, { id: row.machine_id,
      name: `Equipo ficticio ${row.name}`, status: 'available', turnaround_minutes: 0,
      installation_ids: new Set(rows.map(item => item.room_id)),
      attention_policy: runtimePolicy(row, initialWindow),
      busy: environment.machine_busy.filter(busy => busy.id === row.machine_id)
        .map(busy => ({ start: iso(busy.start), end: iso(busy.end) })) }])),
  };
}
function holdRuntime(context, solution) {
  for (const row of occupancyForSolution(solution)) {
    const target = row.resource_kind === 'doctor' ? context.doctors.get(row.doctor_id)
      : row.resource_kind === 'installation' ? context.installations.get(row.installation_id)
      : context.equipment.get(Number(row.resource_key.split(':')[1]));
    target.busy.push({ start: row.start_at, end: row.end_at });
  }
}
function runtimeIntervals(solution) {
  return solution.phases.flatMap(phase => (phase.staff_intervals || [{
    start_at: phase.start_at, end_at: phase.end_at, kind: 'continuous',
  }]).map(interval => ({ kind: interval.kind, start: minute(interval.start_at), end: minute(interval.end_at) })));
}
function simulateCurrent(rows, environment, { initialWindow = 10 } = {}) {
  const unsupported = rows.filter(row => row.mode === 'start_only');
  if (unsupported.length) {
    for (const row of unsupported) assert.throws(() => normalizeBookingProfile(runtimeProfile(row, initialWindow, true)),
      { code: 'booking_profile_invalid' });
    return { status: 'policy_not_supported', accepted_count: 0,
      reason: 'Historical version 3 cannot express start_only; it must not invent a final or upgrade a saved profile to make the fixture expressible.',
      unsupported_appointment_ids: unsupported.map(row => row.id), initial_window_minutes: initialWindow };
  }
  const incomplete = rows.filter(row => row.mode === 'start_end'
    && (row.final_minutes == null || row.final_window_minutes == null));
  if (incomplete.length) {
    // Demonstrate that a missing final is not expressible, rather than filling it.
    for (const row of incomplete) assert.throws(() => normalizeAttentionPolicy(runtimePolicy(row, initialWindow)),
      { code: 'booking_attention_invalid' });
    return { status: 'configuration_incomplete', accepted_count: 0,
      reason: 'The explicitly selected start_end fixture requires final duration and window; missing values are not filled.',
      unresolved_appointment_ids: incomplete.map(row => row.id), initial_window_minutes: initialWindow };
  }
  const context = runtimeContext(rows, environment, initialWindow), accepted = [];
  for (const row of rows) {
    const solution = solveBookingProfile({ profile: runtimeProfile(row, initialWindow),
      start: iso(row.start), ...context });
    if (!solution) return { status: 'blocked', accepted_count: accepted.length,
      rejected_appointment_id: row.id, accepted, initial_window_minutes: initialWindow };
    accepted.push({ appointment_id: row.id, staff_intervals: runtimeIntervals(solution) });
    holdRuntime(context, solution);
  }
  return { status: 'fits_fictional_fixture', accepted_count: accepted.length,
    accepted, initial_window_minutes: initialWindow };
}

function resourceConflicts(rows, environment) {
  const conflicts = [];
  for (const kind of ['room', 'machine']) {
    for (const row of rows) {
      const interval = { start: row.start, end: row.end };
      for (const busy of environment[`${kind}_busy`]) {
        if (busy.id === row[`${kind}_id`] && overlap(interval, busy)) conflicts.push({
          kind, appointment_id: row.id, resource_id: busy.id, reason: 'full_appointment_resource_occupied' });
      }
      for (const sibling of rows) {
        if (row.id < sibling.id && row[`${kind}_id`] === sibling[`${kind}_id`] && overlap(interval, sibling)) {
          conflicts.push({ kind, appointment_id: row.id, sibling_id: sibling.id,
            resource_id: row[`${kind}_id`], reason: 'two_appointments_use_same_full_appointment_resource' });
        }
      }
    }
  }
  return conflicts;
}
function assignTasks(tasks, fixed, environment) {
  // Each intervention is one uninterrupted block. Gaps BETWEEN blocks are legal.
  const selected = [], ordered = [...tasks].sort((a, b) => a.latest - b.latest
    || a.earliest - b.earliest || a.appointment_id.localeCompare(b.appointment_id));
  let explored = 0, exhausted = false;
  const isFree = interval => environment.staff_windows.some(window =>
    window.start <= interval.start && interval.end <= window.end)
    && ![...environment.staff_busy, ...fixed, ...selected].some(busy => overlap(interval, busy));
  if (fixed.some((row, index) => !environment.staff_windows.some(window =>
    window.start <= row.start && row.end <= window.end)
    || environment.staff_busy.some(busy => overlap(row, busy))
    || fixed.slice(index + 1).some(sibling => overlap(row, sibling)))) {
    return { intervals: null, explored, reason: 'continuous_attention_unavailable' };
  }
  function visit(index) {
    if (index === ordered.length) return true;
    const task = ordered[index];
    for (let start = task.earliest; start <= task.latest; start += 5) {
      if (++explored > 10000) { exhausted = true; return false; }
      const interval = { appointment_id: task.appointment_id, kind: task.kind,
        start, end: start + task.duration };
      if (!isFree(interval)) continue;
      selected.push(interval);
      if (visit(index + 1)) return true;
      selected.pop();
    }
    return false;
  }
  if (!visit(0)) return { intervals: null, explored,
    reason: exhausted ? 'search_limit_inconclusive' : 'no_nonoverlapping_staff_assignment' };
  return { intervals: [...fixed, ...selected].sort((a, b) => a.start - b.start
    || a.appointment_id.localeCompare(b.appointment_id)), explored, reason: null };
}
function assertAssignment(rows, intervals, environment) {
  for (const interval of intervals) {
    const appointment = rows.find(row => row.id === interval.appointment_id);
    assert(appointment);
    assert(interval.start >= appointment.start && interval.end <= appointment.end);
    assert(interval.start < interval.end);
    if (interval.kind === 'start') assert(interval.end <= appointment.start + COMMON_START_WINDOW);
    assert(!environment.staff_busy.some(busy => overlap(interval, busy)));
  }
  intervals.forEach((row, index) => assert(!intervals.slice(index + 1).some(other => overlap(row, other))));
}
function simulateProposal(rows, environment) {
  const holds = rows.flatMap(row => ['room', 'machine'].map(kind => ({
    kind, resource_id: row[`${kind}_id`], appointment_id: row.id, start: row.start, end: row.end })));
  const report = { model: 'PROPOSAL_ONLY_NOT_CRM_VALIDATED',
    common_initial_window_minutes: COMMON_START_WINDOW, resource_holds: holds,
    bookable_in_simulation: false, only_explicit_final_requirements_are_enforced: true,
    unconfigured_final_is_not_a_claim_of_no_care: true,
    final_requirements: rows.map(row => ({ appointment_id: row.id,
      status: row.mode === 'continuous' ? 'covered_by_continuous_attention'
        : row.mode === 'start_only' ? 'not_configured'
        : row.final_minutes == null || row.final_window_minutes == null ? 'explicitly_required_but_incomplete'
          : 'explicit_in_fictional_fixture' })) };
  if (new Set(rows.map(row => row.start)).size !== 1) return { ...report, status: 'outside_confirmed_simultaneous_rule',
    reason: 'Different appointment starts need their own rule; a common window is not inferred.' };
  const conflicts = resourceConflicts(rows, environment);
  if (conflicts.length) return { ...report, status: 'blocked', blocked_stage: 'full_room_or_machine', conflicts };
  const tasks = [], fixed = [], unresolved = [];
  for (const row of rows) {
    assert(['continuous', 'start_end', 'start_only'].includes(row.mode), 'Unknown fixture attention mode');
    if (row.mode === 'continuous') {
      fixed.push({ appointment_id: row.id, kind: 'continuous',
        start: row.start + (row.patient_preparation_minutes || 0), end: row.end });
      continue;
    }
    tasks.push({ appointment_id: row.id, kind: 'start', earliest: row.start,
      latest: Math.min(row.start + COMMON_START_WINDOW, row.end) - row.setup_minutes,
      duration: row.setup_minutes });
    if (row.mode === 'start_only') {
      assert.equal(row.final_minutes, null, 'start_only must not silently discard an explicit final duration');
      assert.equal(row.final_window_minutes, null, 'start_only must not silently discard an explicit final window');
      continue;
    }
    if (row.final_minutes == null) unresolved.push({ appointment_id: row.id,
      requirement: 'final_attention_duration_and_window', reason: 'A final is explicitly required by this fixture but its duration is unknown.' });
    else if (row.final_window_minutes == null) unresolved.push({ appointment_id: row.id,
      requirement: 'final_attention_window', reason: 'The final duration alone does not locate a slot.' });
    else tasks.push({ appointment_id: row.id, kind: 'end',
      earliest: Math.max(row.start, row.end - row.final_window_minutes),
      latest: row.end - row.final_minutes, duration: row.final_minutes });
  }
  const setup = assignTasks(tasks.filter(row => row.kind === 'start'), fixed, environment);
  if (!setup.intervals) return { ...report, status: 'blocked', blocked_stage: 'initial_or_continuous_attention',
    reason: setup.reason, explored: setup.explored, unresolved };
  const complete = assignTasks(tasks, fixed, environment);
  if (!complete.intervals) return { ...report, status: 'blocked', blocked_stage: 'final_attention',
    reason: complete.reason, initial_intervals: setup.intervals, explored: complete.explored, unresolved };
  assertAssignment(rows, complete.intervals, environment);
  return { ...report, status: unresolved.length ? 'partial_feasible_requires_confirmation' : 'fits_fictional_fixture',
    bookable_in_simulation: unresolved.length === 0, staff_intervals: complete.intervals,
    unresolved, explored: complete.explored };
}

function runCase(id, description, rows, { environment = defaultEnvironment(), currentWindow = 10,
  assumptions = [], expectedProposal, expectedCurrent } = {}) {
  const before = sha({ rows, environment });
  const current = simulateCurrent(rows, environment, { initialWindow: currentWindow });
  const proposal = simulateProposal(rows, environment);
  assert.equal(sha({ rows, environment }), before, `${id}: simulation mutated input`);
  if (expectedProposal) assert.equal(proposal.status, expectedProposal, id);
  if (expectedCurrent) assert.equal(current.status, expectedCurrent, id);
  if (proposal.unresolved?.length) assert.equal(proposal.bookable_in_simulation, false);
  return { id, description, crm_validated: false, assumptions,
    appointments: rows, environment, current, proposal };
}

function simulateSiblingEdit() {
  const initialRows = pair(), environment = defaultEnvironment();
  const baseline = simulateCurrent(initialRows, environment, { initialWindow: 15 });
  assert.equal(baseline.status, 'fits_fictional_fixture');
  const sibling = baseline.accepted.find(row => row.appointment_id === initialRows[1].id);
  const context = runtimeContext(initialRows, environment, 15);
  const siblingSolution = { start_at: iso(0), end_at: iso(30), phases: [{
    key: 'fictional-phase', start_at: iso(0), end_at: iso(30), installation_id: 102,
    doctor_ids: [999], staff_time_scope: 'phase', equipment: [{ id: 2, turnaround_minutes: 0 }],
    staff_intervals: sibling.staff_intervals.map(row => ({ start_at: iso(row.start), end_at: iso(row.end), kind: row.kind })),
  }] };
  holdRuntime(context, siblingSolution);
  const editedRows = initialRows.map(row => row.name === 'PRESO' ? { ...row, setup_minutes: 10 } : row);
  const naiveEditedInterval = { start: 0, end: 10 };
  const conflictsWithOldSibling = sibling.staff_intervals.filter(row => overlap(naiveEditedInterval, row));
  assert.equal(conflictsWithOldSibling.length, 1);
  const current = solveBookingProfile({ profile: runtimeProfile(editedRows[0], 15, true), start: iso(0), ...context });
  assert.equal(current, null, 'Existing engine must refuse an edit that conflicts with fixed sibling attention.');
  const proposal = simulateProposal(editedRows, environment);
  assert.equal(proposal.status, 'fits_fictional_fixture');
  const beforeStart = sibling.staff_intervals.find(row => row.kind === 'start');
  const afterStart = proposal.staff_intervals.find(row => row.appointment_id === initialRows[1].id && row.kind === 'start');
  assert.notDeepEqual([afterStart.start, afterStart.end], [beforeStart.start, beforeStart.end]);
  assert.deepEqual(proposal.resource_holds, simulateProposal(initialRows, environment).resource_holds);

  const receipt = { appointments: initialRows, environment, intervals: baseline.accepted };
  const revision = sha(receipt), concurrent = clone(receipt);
  concurrent.appointments[1].end += 5;
  const staleCommit = (state, expectedRevision) => sha(state) === expectedRevision
    ? { status: 'accepted_in_memory_only' } : { status: 'stale_group_revision', state_unchanged: true };
  const concurrentBefore = sha(concurrent), rejected = staleCommit(concurrent, revision);
  assert.equal(rejected.status, 'stale_group_revision');
  assert.equal(sha(concurrent), concurrentBefore);
  return { id: 'edit_invalidates_sibling_attention', crm_validated: false,
    assumptions: ['Fictional edit changes PRESO setup from 5 to 10 minutes; this is not a newly approved clinical rule.'],
    baseline, naive_edit_conflicts: conflictsWithOldSibling,
    current: { status: 'blocked_preserving_sibling_reservation' }, proposal,
    affected_sibling: { appointment_id: initialRows[1].id, previous_start: beforeStart, proposed_start: afterStart },
    proposed_requirements: ['Preview all affected attention intervals.', 'Keep original appointment, room and machine ranges.',
      'Confirm the group revision atomically; do not silently change a sibling.'],
    stale_confirmation_simulation: rejected };
}

function simulateFrozenSnapshot() {
  const row = machine(1, 'PRESO'), environment = defaultEnvironment();
  const context = runtimeContext([row], environment, 15);
  const frozenProfile = runtimeProfile(row, 15, true);
  const before = solveBookingProfile({ profile: frozenProfile, start: iso(0), ...context });
  context.equipment.get(1).attention_policy = { mode: 'continuous', patient_preparation_minutes: 0 };
  const after = solveBookingProfile({ profile: frozenProfile, start: iso(0), ...context });
  assert.deepEqual(runtimeIntervals(before), runtimeIntervals(after));
  return { id: 'equipment_default_edit_does_not_rewrite_existing_snapshot', crm_validated: false,
    status: 'existing_frozen_policy_preserved', staff_intervals: runtimeIntervals(after),
    explanation: 'A future machine default differs from changing a purchased/reserved appointment policy.' };
}

/** A coupled offline fixture, not a new runtime attention-policy implementation. */
function simulateIndibaContinuousTrio({ withEmsMiddleCheck = false } = {}) {
  const rows = [
    ...pair().map(row => ({ ...startOnly(row), id: `fictional-triple-${row.machine_id}-${row.name.toLowerCase()}` })),
    machine(3, 'INDIBA', { id: 'fictional-triple-3-indiba', mode: 'offline_flexible_setup_then_continuous',
      final_minutes: null, final_window_minutes: null,
      final_care: 'covered_by_continuous_attention_not_a_separate_final_rule' }),
  ];
  const environment = defaultEnvironment(), before = sha({ rows, environment });
  const indiba = rows[2], ems = rows[1];
  // The real document mentions an EMS midpoint check, not its duration/slot.
  // This interval is an explicit fictional constraint, not clinical timing.
  const middleCheck = withEmsMiddleCheck ? {
    appointment_id: ems.id, kind: 'middle_check', start: 20, end: 25,
  } : null;
  const tasksFor = setupStart => rows.map(row => ({ appointment_id: row.id, kind: 'start',
    earliest: row === indiba ? setupStart : row.start,
    latest: row === indiba ? setupStart : Math.min(row.start + COMMON_START_WINDOW, row.end) - row.setup_minutes,
    duration: row.setup_minutes }));
  const setupOnly = assignTasks(tasksFor(10), [], environment);
  assert(setupOnly.intervals, 'The three initial preparations must fit independently of later care.');
  const attempts = [];
  let complete = null, selectedContinuous = null;
  for (let setupStart = indiba.start;
    setupStart <= Math.min(indiba.start + COMMON_START_WINDOW, indiba.end) - indiba.setup_minutes;
    setupStart += 5) {
    const continuous = { appointment_id: indiba.id, kind: 'continuous',
      start: setupStart + indiba.setup_minutes, end: indiba.end };
    const fixed = [continuous, ...(middleCheck ? [middleCheck] : [])];
    const assignment = assignTasks(tasksFor(setupStart), fixed, environment);
    attempts.push({ indiba_setup_start: setupStart, indiba_continuous_interval: continuous,
      status: assignment.intervals ? 'fits_fictional_fixture' : 'blocked', reason: assignment.reason });
    if (assignment.intervals) { complete = assignment; selectedContinuous = continuous; break; }
  }
  const proposal = { model: 'PROPOSAL_ONLY_NOT_CRM_VALIDATED',
    common_initial_window_minutes: COMMON_START_WINDOW,
    resource_holds: rows.flatMap(row => ['room', 'machine'].map(kind => ({
      kind, resource_id: row[`${kind}_id`], appointment_id: row.id, start: row.start, end: row.end }))),
    status: complete ? 'fits_fictional_fixture' : 'blocked', bookable_in_simulation: !!complete,
    preparation_only_does_not_release_indiba_staff: true,
    indiba_continuous_attention_required_after_setup: true,
    clinical_timing_validated: false, middle_check: middleCheck,
    initial_intervals: setupOnly.intervals, coupled_assignment_attempts: attempts,
    ...(complete ? { staff_intervals: complete.intervals, indiba_staff_minutes:
      indiba.setup_minutes + selectedContinuous.end - selectedContinuous.start }
      : { blocked_stage: 'explicit_intermediate_attention',
        reason: 'The explicit fictional EMS check overlaps INDIBA continuous attention for every permitted setup start.' }),
  };
  assert.equal(resourceConflicts(rows, environment).length, 0);
  assertAssignment(rows, setupOnly.intervals, environment);
  if (complete) {
    assertAssignment(rows, complete.intervals, environment);
    assert.deepEqual(complete.intervals.filter(row => row.kind === 'start').map(row => [row.start, row.end]),
      [[0, 5], [5, 10], [10, 15]]);
    assert.deepEqual([selectedContinuous.start, selectedContinuous.end], [15, 30]);
    assert.equal(proposal.indiba_staff_minutes, 20, 'INDIBA setup 5 is not total staff occupancy 5.');
  } else {
    assert(middleCheck);
    assert(attempts.every(row => overlap(row.indiba_continuous_interval, middleCheck)));
  }
  assert.throws(() => normalizeAttentionPolicy({ mode: 'offline_flexible_setup_then_continuous',
    start_minutes: 5, start_window_minutes: 15 }), { code: 'booking_attention_invalid' });
  assert.throws(() => normalizeAttentionPolicy({ mode: 'explicit_middle_check',
    start_minutes: 20, duration_minutes: 5 }), { code: 'booking_attention_invalid' });
  assert.equal(sha({ rows, environment }), before, 'Coupled fixture must not mutate inputs.');
  return { id: withEmsMiddleCheck ? 'explicit_ems_midpoint_check_conflicts_with_indiba_continuous'
      : 'literal_trio_initial_preso_ems_indiba_then_continuous',
    description: withEmsMiddleCheck
      ? 'Three preparations fit, but an explicit EMS midpoint constraint cannot overlap continuous INDIBA care.'
      : 'PRESO and EMS prepare first; INDIBA prepares at 10-15 and needs continuous staff until its fictional end.',
    crm_validated: false,
    assumptions: ['PRESO + EMS/EMShape + INDIBA follows the latest customer wording, not a third MAG physical unit.',
      'Thirty-minute appointment ranges and INDIBA continuous care from minute 15 to 30 are analytic timing hypotheses only.',
      'PRESO/EMS start_only configures initial attention only; final care is not asserted absent.',
      ...(middleCheck ? ['EMS check at 20-25 is an explicitly required fictional interval; the source does not confirm those minutes.'] : []),
      'No runtime policy, machine setting or clinical treatment duration is changed.'],
    appointments: rows, environment,
    current: { status: 'policy_not_supported', accepted_count: 0,
      reason: 'The historical v1–3 profile contract cannot couple flexible attended setup to continuous follow-on care or express an explicit intermediate check.',
      runtime_capacity_pending: true }, proposal };
}

function main() {
  const abstractMagneto = 'MAGNETO is an abstract source-label fixture: its identity and a distinct real third physical unit are not verified.';
  const conditionalMagneto = [abstractMagneto,
    'This start_end fixture explicitly requires a final; unknown required values leave only partial feasibility.'];
  const startOnlyAssumptions = [abstractMagneto,
    'start_only is not supported by the historical v1–3 profile contract; this offline proposal is not proof that final care is unnecessary.',
    'Only initial preparation is configured in this fixture; no final requirement is invented.'];
  const finalFixture = 'Final window 10 is a local test-fixture assumption, not a newly confirmed customer rule.';
  const cases = [
    runCase('two_known_machines_legacy_window', 'Two preparations and two 5-minute finals fit the legacy 10-minute windows.', pair(), {
      assumptions: [finalFixture], expectedCurrent: 'fits_fictional_fixture', expectedProposal: 'fits_fictional_fixture' }),
    runCase('abstract_trio_start_only_no_final_configured', 'Three abstract 5-minute preparations fit the first 15 minutes without inventing a final obligation.', startOnlyTrio(), {
      assumptions: startOnlyAssumptions, expectedCurrent: 'policy_not_supported', expectedProposal: 'fits_fictional_fixture' }),
    runCase('mixed_start_only_preserves_explicit_other_finals', 'A start-only MAG label does not erase explicitly configured PRESO and EMS finals.', [...pair(), startOnly(machine(3, 'MAGNETO'))], {
      assumptions: [...startOnlyAssumptions, finalFixture], expectedCurrent: 'policy_not_supported', expectedProposal: 'fits_fictional_fixture' }),
    runCase('explicit_trio_final_required_but_unknown', 'An explicitly required MAGNETO final is different from a start-only rule with no final configured.', trio(), {
      assumptions: [...conditionalMagneto, finalFixture], expectedCurrent: 'configuration_incomplete', expectedProposal: 'partial_feasible_requires_confirmation' }),
    runCase('explicit_final_window_unknown_remains_partial', 'A configured final duration does not invent a missing final window.', [...pair(), machine(3, 'MAGNETO', { final_minutes: 5, final_window_minutes: null })], {
      assumptions: [abstractMagneto, 'This fixture explicitly requires a final but leaves its permitted window unknown.', finalFixture],
      expectedCurrent: 'configuration_incomplete', expectedProposal: 'partial_feasible_requires_confirmation' }),
    runCase('start_only_initial_busy_still_blocks', 'No final configured does not free an occupied part of the initial preparation window.', startOnlyTrio(), {
      environment: { ...defaultEnvironment(), staff_busy: [{ start: 5, end: 10, non_interruptible: true }] },
      assumptions: startOnlyAssumptions, expectedCurrent: 'policy_not_supported', expectedProposal: 'blocked' }),
    runCase('start_only_short_appointment_still_blocks', 'Start-only preparation must remain inside each appointment, even when it ends before minute 15.', startOnlyTrio().map(row => ({ ...row, end: 10 })), {
      assumptions: [...startOnlyAssumptions, 'Ten-minute appointment ranges are fictional boundary inputs.'],
      expectedCurrent: 'policy_not_supported', expectedProposal: 'blocked' }),
    runCase('four_start_only_preparations_exceed_window', 'Removing unconfigured finals does not allow four 5-minute preparations within 15 minutes.', [...startOnlyTrio(), startOnly(machine(4, 'FOURTH'))], {
      assumptions: [...startOnlyAssumptions, 'A fourth label and distinct resource are fictional capacity inputs.'],
      expectedCurrent: 'policy_not_supported', expectedProposal: 'blocked' }),
    runCase('mag_alias_same_ems_unit_cannot_be_duplicated', 'If MAG and EMS identify the same physical unit, distinct labels cannot make a third simultaneous machine.', [
      ...pair(), startOnly(machine(3, 'MAGNETO', { machine_id: 2 }))], {
      assumptions: [...startOnlyAssumptions, 'Shared machine ID is an alias-risk hypothesis, not a verified MAG/EMS equivalence.'],
      expectedCurrent: 'policy_not_supported', expectedProposal: 'blocked' }),
    runCase('start_only_does_not_waive_explicit_ems_final', 'An explicitly configured EMS final remains blocked by staff occupancy despite another start-only machine.', [
      machine(2, 'EMS'), startOnly(machine(3, 'MAGNETO'))], {
      environment: { ...defaultEnvironment(), staff_busy: [{ start: 20, end: 30, non_interruptible: true }] },
      assumptions: [...startOnlyAssumptions, finalFixture], expectedCurrent: 'policy_not_supported', expectedProposal: 'blocked' }),
    runCase('exion_continuous_fixture_is_not_made_unattended', 'Examining EXION does not apply a universal 5-minute start-only rule or waive an explicit continuous fixture.', [
      ...startOnlyTrio(), exionContinuousFixture()], {
      assumptions: [...startOnlyAssumptions,
        'Continuous EXION is an explicitly configured technical test fixture, not a validated clinical instruction for every EXION modality.'],
      expectedCurrent: 'policy_not_supported', expectedProposal: 'blocked' }),
    runCase('three_start_window_10_vs_15', 'A 10-minute start window cannot fit three 5-minute preparations.', hypotheticalTrio({ final_window_minutes: 15 }), {
      assumptions: ['MAGNETO final 5 and final window 15 are analytic hypotheses only.'],
      expectedCurrent: 'blocked', expectedProposal: 'fits_fictional_fixture' }),
    runCase('three_equal_end_final_window_10', 'A successful start does not guarantee room for three simultaneous finals.', hypotheticalTrio(), {
      currentWindow: 15, assumptions: ['MAGNETO final 5 is a hypothesis only.', finalFixture],
      expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('three_all_windows_15_already_expressible', 'The existing pure solver already handles three independent reservations when every defined window fits.', hypotheticalTrio({ final_window_minutes: 15 }), {
      currentWindow: 15, assumptions: ['MAGNETO final 5 and final window 15 are analytic hypotheses only.'],
      expectedCurrent: 'fits_fictional_fixture', expectedProposal: 'fits_fictional_fixture' }),
    runCase('three_mixed_durations_local_plan_misses_global_solution', 'Frozen earlier finals can reject a third appointment despite a feasible coordinated assignment.',
      hypotheticalTrio({ final_window_minutes: 15 }).map(row => ({ ...row,
        end: row.name === 'PRESO' ? 45 : row.name === 'EMS' ? 30 : 20 })), {
        currentWindow: 15,
        assumptions: ['Durations 45/30/20, MAGNETO final 5 and final window 15 are analytic hypotheses only.',
          'A global proposal does not authorize silently moving previously frozen attention intervals.'],
        expectedCurrent: 'blocked', expectedProposal: 'fits_fictional_fixture' }),
    runCase('magneto_end_later_hypothetical', 'An illustrative MAGNETO end 5 minutes later changes final-slot capacity.', hypotheticalTrio().map(row => row.name === 'MAGNETO' ? { ...row, end: 35 } : row), {
      currentWindow: 15, assumptions: ['MAGNETO final 5 and duration 35 are hypothetical; appointment durations are fictional.', finalFixture],
      expectedCurrent: 'fits_fictional_fixture', expectedProposal: 'fits_fictional_fixture' }),
    runCase('trio_initial_gap_consumes_capacity', 'An occupied 5-minute block inside the first 15 leaves insufficient time for three preparations.', trio(), {
      environment: { ...defaultEnvironment(), staff_busy: [{ start: 5, end: 10, non_interruptible: true }] },
      assumptions: conditionalMagneto, expectedProposal: 'blocked' }),
    runCase('two_preparations_can_have_gap', 'Preparation need not be a continuous group block: one can be 0-5 and another 10-15.', pair(), {
      currentWindow: 15, environment: { ...defaultEnvironment(), staff_busy: [{ start: 5, end: 10, non_interruptible: true }] },
      assumptions: [finalFixture], expectedCurrent: 'fits_fictional_fixture', expectedProposal: 'fits_fictional_fixture' }),
    runCase('no_preparation_before_appointment', 'Free time before the appointment does not count toward its preparation window.', pair(), {
      environment: { ...defaultEnvironment(), staff_windows: [{ start: -15, end: 0 }] },
      expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('short_free_fragments_do_not_split_intervention', 'Several fragments shorter than 5 minutes do not make one uninterrupted 5-minute preparation.', [machine(1, 'PRESO')], {
      currentWindow: 15, environment: { ...defaultEnvironment(), staff_busy: [{ start: 2, end: 3 }, { start: 7, end: 8 }, { start: 12, end: 15 }] },
      assumptions: [finalFixture], expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('four_machines_exceed_common_initial_window', 'Four independent 5-minute preparations need 20 minutes, exceeding the confirmed 15.', [
      ...hypotheticalTrio({ final_window_minutes: 20 }), machine(4, 'FOURTH', { final_window_minutes: 20 })], {
      currentWindow: 15, assumptions: ['A fourth unattended machine and all finals are analytic fixtures, not a clinical capacity approval.'],
      expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('four_named_machines_include_continuous_ondas', 'PRESO + EMS + MAGNETO + ONDAS cannot ignore the continuous ONDAS staff interval.', [
      ...trio(), ondas({ end: 30 })], {
      currentWindow: 15, assumptions: [...conditionalMagneto, 'ONDAS has a fictional 5-minute patient-preparation gap; continuous work still blocks later setups.'],
      expectedCurrent: 'configuration_incomplete', expectedProposal: 'blocked' }),
    runCase('initial_window_never_extends_short_appointments', 'A 15-minute group window does not permit intervention after a 10-minute appointment ends.', hypotheticalTrio({ end: 10 }), {
      currentWindow: 15, assumptions: ['All durations and MAGNETO final are deliberately fictional boundary inputs.'],
      expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('ondas_continuous_plus_one_unattended', 'One setup can fit before continuous ONDAS attention, and its final after ONDAS.', [machine(1, 'EMS'), ondas()], {
      currentWindow: 15, assumptions: ['ONDAS patient preparation 5 is an explicit fixture assumption; continuous work itself cannot overlap.', finalFixture],
      expectedCurrent: 'fits_fictional_fixture', expectedProposal: 'fits_fictional_fixture' }),
    runCase('ondas_covers_final', 'Continuous ONDAS attention covering the final window blocks the other machine.', [machine(1, 'EMS'), ondas({ end: 30 })], {
      currentWindow: 15, assumptions: [finalFixture], expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('ondas_continuous_plus_two_unattended', 'A second setup cannot be interleaved through continuous ONDAS attention.', [...pair(), ondas()], {
      currentWindow: 15, assumptions: [finalFixture], expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('ondas_immediate_continuous', 'With no initial patient-preparation gap, ONDAS occupies the staff member from the start.', [machine(1, 'EMS'), ondas({ patient_preparation_minutes: 0 })], {
      currentWindow: 15, assumptions: [finalFixture], expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('non_interruptible_busy_never_waived', 'An occupied continuous interval is not removed to make preparation fit.', pair(), {
      currentWindow: 15, environment: { ...defaultEnvironment(), staff_busy: [{ start: 0, end: 15, can_share: true, non_interruptible: true }] },
      assumptions: [finalFixture], expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('room_held_for_complete_appointment', 'Room occupancy in unattended middle time still prevents booking.', [machine(1, 'PRESO')], {
      environment: { ...defaultEnvironment(), room_busy: [{ id: 101, start: 10, end: 15 }] },
      expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('machine_held_for_complete_appointment', 'A machine is occupied for the whole session, even with no staff at that moment.', [machine(1, 'PRESO')], {
      environment: { ...defaultEnvironment(), machine_busy: [{ id: 1, start: 10, end: 15 }] },
      expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('same_machine_cannot_be_duplicated', 'Two rooms cannot use the same physical machine simultaneously.', pair().map(row => ({ ...row, machine_id: 1 })), {
      currentWindow: 15, expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('same_room_cannot_be_duplicated', 'Free staff time does not allow two full room reservations in the same room.', pair().map(row => ({ ...row, room_id: 101 })), {
      currentWindow: 15, expectedCurrent: 'blocked', expectedProposal: 'blocked' }),
    runCase('different_start_not_confirmed_common_window', 'Different starts are outside the explicitly confirmed simultaneous-start group rule.', [
      machine(1, 'PRESO'), machine(2, 'EMS', { start: 5, end: 35 })], {
      currentWindow: 15, assumptions: [finalFixture], expectedProposal: 'outside_confirmed_simultaneous_rule' }),
    simulateSiblingEdit(),
    simulateFrozenSnapshot(),
  ];
  const historicalFixtureCount = cases.length;
  assert.equal(historicalFixtureCount, 35, 'Preserve the previous 35 abstract fixtures.');
  cases.push(simulateIndibaContinuousTrio(), simulateIndibaContinuousTrio({ withEmsMiddleCheck: true }));
  const startOnlyCase = cases.find(row => row.id === 'abstract_trio_start_only_no_final_configured');
  assert.deepEqual(startOnlyCase.proposal.staff_intervals.map(row => [row.start, row.end]),
    [[0, 5], [5, 10], [10, 15]]);
  assert.equal(startOnlyCase.proposal.bookable_in_simulation, true);
  assert.equal(startOnlyCase.proposal.unresolved.length, 0);
  assert(startOnlyCase.proposal.final_requirements.every(row => row.status === 'not_configured'));
  const requiredFinalCase = cases.find(row => row.id === 'explicit_trio_final_required_but_unknown');
  assert.equal(requiredFinalCase.proposal.bookable_in_simulation, false);
  assert.equal(requiredFinalCase.proposal.unresolved.length, 1);
  const mixedCase = cases.find(row => row.id === 'mixed_start_only_preserves_explicit_other_finals');
  assert.equal(mixedCase.proposal.staff_intervals.filter(row => row.kind === 'end').length, 2);
  assert(!mixedCase.proposal.staff_intervals.some(row => row.kind === 'end' && row.appointment_id.includes('magneto')));
  assert.equal(cases.find(row => row.id === 'start_only_does_not_waive_explicit_ems_final').proposal.blocked_stage, 'final_attention');
  assert.equal(cases.find(row => row.id === 'mag_alias_same_ems_unit_cannot_be_duplicated').proposal.blocked_stage, 'full_room_or_machine');
  assert.equal(cases.find(row => row.id === 'exion_continuous_fixture_is_not_made_unattended').proposal.blocked_stage, 'initial_or_continuous_attention');
  const gapCase = cases.find(row => row.id === 'two_preparations_can_have_gap');
  assert.deepEqual(gapCase.proposal.staff_intervals.filter(row => row.kind === 'start').map(row => [row.start, row.end]), [[0, 5], [10, 15]]);
  assert.equal(cases.find(row => row.id === 'three_equal_end_final_window_10').proposal.blocked_stage, 'final_attention');
  const globallyFeasible = cases.find(row => row.id === 'three_mixed_durations_local_plan_misses_global_solution');
  assert.equal(globallyFeasible.current.accepted_count, 2);
  assert.equal(globallyFeasible.proposal.bookable_in_simulation, true);
  assert(cases.every(row => row.crm_validated === false));
  const report = { label: 'DETERMINISTIC_OFFLINE_PROPOSAL_SIMULATION_NOT_CRM_VALIDATION',
    fictional_data: true, crm_read: false, crm_write: false, database_access: false, network_access: false,
    runtime_comparison_baseline: 'historical_profile_versions_1_to_3', new_version_4_runtime_activation: false,
    timezone: 'Europe/Madrid', reference_start: '2030-01-07 10:00 Europe/Madrid',
    minutes_relative_to_each_fixture_start: true, fixture_duration_minutes: '30 unless explicitly overridden; not clinical treatment durations',
    confirmed_customer_rule: { treatments: ['PRESO', 'EMS/EMShape', 'INDIBA'], same_start_required: true,
      customer_wording: 'Con una preso y una estimulacion magnetica y un indiba podemos ponerlos los3, porque son5minutos cada una y te da tiempo. Con preso y ems podemos poner lo que queramos.',
      initial_preparation_minutes: [5, 5, 5], common_initial_window_minutes: 15,
      preparation_inside_appointment: true, gaps_between_preparations_allowed: true,
      room_and_machine_held_for_complete_appointment: true,
      magnetic_stimulation_probably_means_ems_emshape: true,
      magnetic_stimulation_is_not_an_additional_machine: true,
      setup_only_is_not_total_indiba_staff_occupancy: true,
      no_universal_exion_attention_rule_inferred: true },
    historical_abstract_fixtures: { count: historicalFixtureCount,
      MAGNETO_labels_are_capacity_or_alias_hypotheses_not_the_current_customer_trio: true,
      mag_identity_verified: false, real_distinct_MAG_unit_demonstrated: false },
    current_customer_wording_fixtures: { count: 2, clinical_timing_validated: false },
    unresolved_decisions: ['Validate service-specific INDIBA continuous attention and its real duration; a five-minute setup is not five minutes total care.',
      'Validate the timing and duration of any required EMS midpoint check; no arbitrary five-minute check is promoted to clinical policy.',
      'Do not infer a MAG final requirement from the initial-only customer rule; require duration/window only when a final is explicitly configured.',
      'Final windows for all machines: the fixture uses 10; widening to 15 is only analysed.',
      'A new clinical rule for different appointment starts is not inferred.',
      'If an edit changes sibling attention, preview scope, confirmation and group concurrency protection must be specified.'],
    current_runtime_sources: ['src/lib/booking-attention.js', 'src/lib/booking-profile-solver.js', 'src/lib/booking-profile.js'],
    findings: ['The latest customer wording concerns PRESO + EMS/EMShape + INDIBA, not PRESO + EMS + a separate third MAG device.',
      'The scoped coupled fixture fits PRESO 0-5, EMS 5-10, INDIBA setup 10-15 and continuous INDIBA attention 15-30; its timing is hypothetical.',
      'An explicit hypothetical EMS check at 20-25 conflicts with that continuous INDIBA care despite three feasible initial preparations.',
      'Five-minute INDIBA preparation is not a five-minute total staff reservation; v4 rollout and integrated validation remain separate from this historical simulation.',
      'The prior 35 abstract fixtures are preserved as capacity, final-rule, alias and snapshot checks, not as current clinical customer scenarios.',
      'The abstract initial 5+5+5 fits a free 15-minute window with start_only; an unconfigured final does not by itself block that offline proposal.',
      'start_only is unsupported by historical profile versions 1–3 and is not a declaration that final care is absent or unnecessary.',
      'A final explicitly required by start_end still needs its duration and window; other configured finals are never erased.',
      'MAG identity and a real distinct third machine are not verified; an EMS/MAG alias collision remains a full-machine conflict.',
      'EXION is examined with explicit continuous fixture attention; no universal 5-minute unattended rule is applied.',
      'Existing runtime can already schedule three independent machines with complete 15-minute windows; this is a capability check, not deployed configuration.',
      'Initial success alone never bypasses explicitly configured final, continuous staff, full-room or full-machine conflicts.',
      'Changing one appointment may require a new proposal for sibling staff intervals; fixed sibling intervals can make a feasible group edit fail locally.',
      'Four 5-minute preparations do not fit within 15 minutes with one staff member.'],
    checks: { status: 'passed', case_count: cases.length, internal_assertions: true,
      start_only_unconfigured_final_does_not_block: true, explicitly_required_unknown_final_never_bookable: true,
      explicit_other_finals_preserved: true, mag_alias_risk_checked: true, no_universal_exion_rule: true,
      historical_35_fixtures_preserved: true, indiba_continuous_after_flexible_setup_checked: true,
      explicit_ems_midpoint_conflict_checked: true, indiba_setup_not_total_staff_occupancy: true,
      inputs_unchanged: true, no_runtime_files_changed: true }, cases };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) main();
module.exports = { simulateCurrent, simulateProposal, resourceConflicts, assignTasks };
