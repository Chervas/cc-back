'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeAttentionPolicy, planStaffAttention, resourceForConfirmedOverlap } = require('../../lib/booking-attention');
const { solveBookingProfile, occupancyForSolution } = require('../../lib/booking-profile-solver');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { mergeClinicalConfig } = require('../../lib/treatment-catalog-contract');
const { bookingSegments } = require('../../lib/appointment-booking-segments');
const auto = { mode: 'start_end', start_minutes: 5, start_window_minutes: 10, end_minutes: 5, end_window_minutes: 10 };
const waves = { mode: 'continuous', patient_preparation_minutes: 5 };
const start = '2030-01-07T09:30:00Z', end = '2030-01-07T10:00:00Z';
const resource = () => ({ windows: [{ start: '2030-01-07T09:00:00Z', end: '2030-01-07T20:00:00Z' }], busy: [] });
const phase = (room, machine, duration = 30) => ({ key: 'one', duration_minutes: duration, installation_ids: [room], professionals: { mode: 'any', ids: [5], preferred_id: 5 }, equipment_requirements: [{ equipment_ids: [machine] }] });
const profile = (room, machine, duration) => ({ version: 2, phases: [phase(room, machine, duration)] });
function context() {
  return { doctors: new Map([[5, resource()]]), installations: new Map([9,10,11].map(id => [id, { ...resource(), resource_key: `installation:${id}` }])),
    equipment: new Map([[1, auto], [2, waves], [3, auto]].map(([id, policy]) => [id, { id, name: `Unit ${id}`, status: 'available', turnaround_minutes: 0, installation_ids: new Set([9,10,11]), busy: [], attention_policy: policy }])) };
}
function reserve(c, solution) {
  for (const row of occupancyForSolution(solution)) {
    const target = row.resource_kind === 'doctor' ? c.doctors.get(row.doctor_id) : row.resource_kind === 'installation' ? c.installations.get(row.installation_id) : c.equipment.get(Number(row.resource_key.split(':')[1]));
    target.busy.push({ start: row.start_at, end: row.end_at });
  }
}
test('policies are conservative, bounded and reject coercions or hidden timing fields', () => {
  assert.deepEqual(normalizeAttentionPolicy(null), { mode: 'continuous', patient_preparation_minutes: 0 });
  assert.deepEqual(normalizeAttentionPolicy(auto), auto);
  for (const policy of [{ ...auto, start_minutes: '5' }, { ...auto, start_window_minutes: 4 }, { ...auto, end_minutes: 15 }, { ...waves, start_minutes: 5 }, { ...waves, patient_preparation_minutes: 31 }]) assert.throws(() => normalizeAttentionPolicy(policy));
});
test('EMS and shockwaves can coexist; a third presotherapy start cannot fit', () => {
  const c = context(), ems = solveBookingProfile({ profile: profile(9,1), start, ...c });
  assert(ems); reserve(c, ems);
  const wave = solveBookingProfile({ profile: profile(10,2,20), start, ...c });
  assert(wave); reserve(c, wave);
  assert.equal(solveBookingProfile({ profile: profile(11,3), start, ...c }), null);
  assert.equal(occupancyForSolution(ems).filter(row => row.resource_kind === 'doctor').length, 2);
  assert.equal(occupancyForSolution(ems).find(row => row.resource_kind === 'equipment').end_at, end.replace('Z','.000Z'));
});
test('booking waves first still allows EMS in the initial patient-preparation interval', () => {
  const c = context(); reserve(c, solveBookingProfile({ profile: profile(10,2,20), start, ...c }));
  assert(solveBookingProfile({ profile: profile(9,1), start, ...c }));
});
test('a valid start never bypasses a conflicting final removal', () => {
  const c = context(); reserve(c, solveBookingProfile({ profile: profile(10,2,30), start, ...c }));
  assert.equal(solveBookingProfile({ profile: profile(9,1), start, ...c }), null);
});
test('two unattended machines fit with sequential starts and sequential removals', () => {
  const c = context(); reserve(c, solveBookingProfile({ profile: profile(9,1), start, ...c }));
  const preso = solveBookingProfile({ profile: profile(11,3), start, ...c }); assert(preso);
  assert.equal(preso.phases[0].staff_intervals[0].start_at, '2030-01-07T09:35:00.000Z');
  assert.equal(preso.phases[0].staff_intervals[1].start_at, '2030-01-07T09:55:00.000Z');
});
test('no staff interval can be put before/after the appointment or across a blocked shift', () => {
  const r = resource();
  r.busy.push({ start, end: '2030-01-07T09:40:00Z' });
  assert.equal(planStaffAttention({ resource:r, start, end, policies:[auto] }), null);
  assert.equal(planStaffAttention({ resource:resource(), start, end:'2030-01-07T09:35:00Z', policies:[auto] }), null);
  assert.equal(planStaffAttention({ resource:{ windows:[{start:'2030-01-07T09:40:00Z',end}],busy:[] }, start, end, policies:[auto] }), null);
});
test('an unattended interval may span a break while both real interventions stay within working hours', () => {
  const r={ windows:[{start,end:'2030-01-07T09:40:00Z'},{start:'2030-01-07T09:50:00Z',end}],busy:[] };
  assert(planStaffAttention({resource:r,start,end,policies:[auto]}));
});
test('a running machine is not duplicated even when the clinician is free', () => {
  const c = context(); reserve(c, solveBookingProfile({ profile: profile(9,1), start, ...c }));
  assert.equal(solveBookingProfile({ profile: profile(10,1), start, ...c, allowOverlap:true }), null);
});
test('old attention snapshots retain their rules after equipment defaults change', () => {
  const c = context(), initial = solveBookingProfile({ profile:profile(9,1),start,...c });
  const frozen = normalizeBookingProfile({ version:3,phases:[{ ...phase(9,1),staff_attention:initial.phases[0].staff_attention }] });
  c.equipment.get(1).attention_policy = {mode:'continuous',patient_preparation_minutes:0};
  assert.deepEqual(solveBookingProfile({profile:frozen,start,...c}).phases[0].staff_intervals,initial.phases[0].staff_intervals);
  assert.throws(()=>mergeClinicalConfig({booking_profile:frozen},{booking_profile:profile(9,1)}),{code:'booking_equipment_client_outdated'});
  assert.throws(()=>normalizeBookingProfile({...frozen,version:2}),{code:'booking_profile_invalid'});
});
test('confirmed overlap requires both professional and room policy and respects room capacity', () => {
  const c = context(), p = {version:1,phases:[{...phase(9,1),equipment_requirements:[]}]};
  const busy = {start,end,appointment_id:1,can_share:true};
  c.doctors.get(5).busy=[busy];c.installations.get(9).busy=[busy];
  assert.equal(solveBookingProfile({profile:p,start,...c,allowOverlap:true}),null);
  c.doctors.get(5).allow_overlap_confirmation=true;
  assert.equal(solveBookingProfile({profile:p,start,...c,allowOverlap:true}),null);
  Object.assign(c.installations.get(9),{allow_overlap_confirmation:true,overlap_capacity:2});
  assert(solveBookingProfile({profile:p,start,...c,allowOverlap:true}).requires_overlap_acknowledgement);
  assert.equal(solveBookingProfile({profile:p,start,...c}),null);
  c.installations.get(9).busy.push({...busy,appointment_id:2});
  assert.equal(solveBookingProfile({profile:p,start,...c,allowOverlap:true}),null);
});
test('capacity counts distinct patients at each instant, not all phase rows in a range', () => {
  const r={...resource(),allow_overlap_confirmation:true,overlap_capacity:2};
  r.busy=[{start,end:'2030-01-07T09:45:00Z',appointment_id:1,can_share:true},{start:'2030-01-07T09:45:00Z',end,appointment_id:2,can_share:true}];
  assert.equal(resourceForConfirmedOverlap(r,new Date(start),new Date(end),true).busy.length,0);
  r.busy.push({...r.busy[0]});
  assert.equal(resourceForConfirmedOverlap(r,new Date(start),new Date(end),true).busy.length,0);
});
test('no confirmation overrides an absence, a foreign appointment or a protected intervention', () => {
  for(const busy of [{start,end},{start,end,can_share:false}]) {
    const r={...resource(),allow_overlap_confirmation:true,busy:[busy]};
    assert.strictEqual(resourceForConfirmedOverlap(r,new Date(start),new Date(end),true),r);
  }
});

test('SQL object-key ordering never hides a valid attention segment; malformed intervals fail closed', () => {
  const solution = solveBookingProfile({profile:profile(9,1),start,...context()});
  const frozen = normalizeBookingProfile({version:3,phases:[{...phase(9,1),staff_attention:[auto]}]});
  const appointment={id_cita:1,inicio:solution.start_at,fin:solution.end_at,import_metadata:{booking:{version:1,profile:frozen,phases:solution.phases}}};
  function reorder(value) {
    if(Array.isArray(value))return value.map(reorder);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,reorder(value[key])]));
    return value;
  }
  const reloaded=reorder(appointment);
  assert.equal(bookingSegments(reloaded).length,1);
  reloaded.import_metadata.booking.phases[0].staff_intervals[0].start_at='2030-01-07T09:20:00.000Z';
  assert.deepEqual(bookingSegments(reloaded),[]);
});

test('partial staff attention cannot remove mandatory full-team reservations', () => {
  assert.throws(()=>normalizeBookingProfile({version:3,phases:[{...phase(9,1),professionals:{mode:'all',ids:[5]},staff_attention:[auto]}]}),{code:'booking_profile_invalid'});
  assert.throws(()=>normalizeBookingProfile({version:3,phases:[{...phase(9,1),equipment_requirements:[],staff_attention:[auto]}]}),{code:'booking_profile_invalid'});
});
