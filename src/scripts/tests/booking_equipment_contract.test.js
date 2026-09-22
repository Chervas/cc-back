'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { normalizeEquipmentRequirements, normalizeRoomEquipmentPolicy, normalizeEquipmentUnit } = require('../../lib/booking-equipment');
const { equipmentRuntimeEnabled } = require('../../services/bookingEquipmentAvailability.service');
const { mergeClinicalConfig } = require('../../lib/treatment-catalog-contract');
const { solveBookingProfile, occupancyForSolution } = require('../../lib/booking-profile-solver');
const { composeAppointmentProfile } = require('../../lib/program-booking');
const { addVirtualBusy } = require('../../services/patientProgramBooking.service');
const phase = { key: 'one', duration_minutes: 30, installation_ids: [9], professionals: { mode: 'any', ids: [5], preferred_id: 5 }, equipment_requirements: [{ equipment_ids: [1] }] };
const profile = { version: 2, phases: [phase] };
const start = '2030-01-07T09:00:00Z';
const free = { windows: [{ start: '2030-01-07T07:00:00Z', end: '2030-01-07T20:00:00Z' }], busy: [], resource_key: 'installation:9' };
function context() { return { doctors: new Map([[5, { ...free, busy: [] }]]), installations: new Map([[9, { ...free, busy: [] }], [10, { ...free, resource_key: 'installation:10', busy: [] }]]), installationKeys: new Map([[9, 'installation:9'], [10, 'installation:10']]), patientBusy: [],
  equipment: new Map([[1, { id: 1, name: 'EXION', status: 'available', turnaround_minutes: 10, installation_ids: new Set([9, 10]), busy: [] }]]) }; }

test('machine requirements are explicit v2 and old clients cannot downgrade a configured profile', () => {
  assert.deepEqual(normalizeBookingProfile(profile), { version: 2, phases: [{ ...phase, label: '' }] });
  assert.throws(() => normalizeBookingProfile({ ...profile, version: 1 }), { code: 'booking_profile_invalid' });
  assert.throws(() => mergeClinicalConfig({ booking_profile: profile }, { booking_profile: { version: 1, phases: [phase] } }), { code: 'booking_equipment_client_outdated' });
  assert.throws(() => mergeClinicalConfig({ booking_profile: profile }, { booking_profile: null }), { code: 'booking_equipment_client_outdated' });
});
test('empty, duplicate and unbounded machine requirements are rejected', () => {
  for (const value of [[{ equipment_ids: [] }], [{ equipment_ids: [true] }], [{ equipment_ids: [1] }, { equipment_ids: [1, 2] }], Array(9).fill({ equipment_ids: [1] })]) {
    assert.throws(() => normalizeEquipmentRequirements(value));
  }
  assert.deepEqual(normalizeEquipmentRequirements(undefined), []);
});
test('optional rollout needs all three gates; no default activation', () => {
  assert.equal(equipmentRuntimeEnabled({}), false);
  assert.equal(equipmentRuntimeEnabled({ BOOKING_EQUIPMENT_ENABLED: 'true' }), false);
  assert.equal(equipmentRuntimeEnabled({ BOOKING_EQUIPMENT_ENABLED: 'true', BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true' }), true);
});
test('room policy cannot be both all and a hidden restrictive list', () => {
  assert.deepEqual(normalizeRoomEquipmentPolicy({ mode: 'none' }), { mode: 'none', equipment_ids: [] });
  assert.throws(() => normalizeRoomEquipmentPolicy({ mode: 'all', equipment_ids: [1] }));
  assert.throws(() => normalizeRoomEquipmentPolicy({ mode: 'selected' }));
});
test('fixed equipment needs a home; one record is one unit, aliases do not create units', () => {
  const input = { name: 'EMShape', family_key: 'emshape', aliases: ['EMS', 'EMShape'], mobility: 'mobile', status: 'available' };
  assert.equal(normalizeEquipmentUnit(input).aliases.length, 2);
  assert.throws(() => normalizeEquipmentUnit({ ...input, mobility: 'fixed' }));
  assert.throws(() => normalizeEquipmentUnit({ ...input, turnaround_minutes: -1 }));
});
test('same room permits sequential uses; movement to another room needs the configured margin', () => {
  const c = context();
  const two = { version: 2, phases: [phase, { ...phase, key: 'two' }] };
  assert(solveBookingProfile({ profile: two, start, ...c }));
  two.phases[1].installation_ids = [10];
  assert.equal(solveBookingProfile({ profile: two, start, ...c }), null);
  two.phases.splice(1, 0, { ...phase, key: 'transfer', duration_minutes: 10, equipment_requirements: [] });
  assert(solveBookingProfile({ profile: two, start, ...c }));
});
test('second equivalent physical unit can be used when the first is occupied', () => {
  const c = context();
  c.equipment.set(2, { ...c.equipment.get(1), id: 2, name: 'EXION 2', busy: [] });
  c.equipment.get(1).busy.push({ start, end: '2030-01-07T12:00:00Z' });
  const p = { version: 2, phases: [{ ...phase, equipment_requirements: [{ equipment_ids: [1, 2] }] }] };
  assert.deepEqual(solveBookingProfile({ profile: p, start, ...c }).phases[0].equipment.map(u => u.id), [2]);
});
test('program snapshots and virtual series preserve independent equipment occupancy', () => {
  const composed = composeAppointmentProfile({ treatments: [{ id: 1, name: 'EXION', booking_profile: profile }] });
  assert.equal(composed.profile.version, 2);
  const c = context(), solution = solveBookingProfile({ profile: composed.profile, start, ...c });
  assert.equal(occupancyForSolution(solution).filter(r => r.resource_kind === 'equipment').length, 1);
  addVirtualBusy(c, solution);
  assert.equal(c.equipment.get(1).busy.length, 1);
  assert.equal(c.equipment.get(1).busy[0].end, '2030-01-07T09:40:00.000Z');
});
test('segment projection validates equipment snapshots and respects label redaction', () => {
  const { bookingSegments } = require('../../lib/appointment-booking-segments');
  const c = context(), solution = solveBookingProfile({ profile, start, ...c });
  const appointment = { id_cita: 1, import_metadata: { booking: { version: 1, profile, phases: solution.phases } } };
  assert.equal(bookingSegments(appointment, { includeClinicalLabels: false })[0].equipment[0].name, '');
  appointment.import_metadata.booking.phases[0].equipment = [null];
  assert.deepEqual(bookingSegments(appointment), []);
  appointment.import_metadata.booking.phases[0].equipment = [{ id: 42, turnaround_minutes: 0 }];
  assert.deepEqual(bookingSegments(appointment), []);
});
