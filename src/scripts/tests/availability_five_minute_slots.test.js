'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const controllerPath = require.resolve('../../controllers/disponibilidad.controller');
const localRequire = createRequire(controllerPath);
const { solutionsForCalendar } = localRequire('../services/appointmentBookingAvailability.service');
const { solveBookingProfile } = localRequire('../lib/booking-profile-solver');
const { resolveLocalInstant } = localRequire('../lib/voucher-schedule-calendar');
const day = '2030-01-07', zone = 'Europe/Madrid';
const instant = time => resolveLocalInstant(day, time + ':00', zone);

function fixture({ duration = 45, roomBusy = false, equipmentBusy = false, staffBusy = false, supportBusy = false } = {}) {
  const window = { start: instant('09:30'), end: instant('13:30') };
  const profile = { version: 2, phases: [{ key: 'care', label: 'Fictitious individual', duration_minutes: duration,
    professionals: { mode: 'any', ids: [5], preferred_id: 5 }, installation_ids: [9],
    equipment_requirements: [{ equipment_ids: [6] }] }] };
  const context = { timeZone: zone, clinicWindows: [window],
    doctors: new Map([[5, { windows: [window], busy: [{ start: window.start, end: instant(staffBusy ? '13:30' : '12:45') }] }],
      [8, { windows: [window], busy: supportBusy ? [window] : [] }]]),
    installations: new Map([[9, { name: 'Fictitious room', resource_key: 'installation:9', windows: [window],
      profesionales_permitidos: [5,8], busy: roomBusy ? [window] : [] }]]),
    equipment: new Map([[6, { id: 6, name: 'Fictitious equipment', status: 'available', installation_ids: new Set([9]),
      turnaround_minutes: 0, busy: equipmentBusy ? [window] : [], attention_policy: { mode: 'continuous', patient_preparation_minutes: 0 } }]]) };
  const calls = { context: 0, acl: 0 };
  const exported = {}, clinic = { id_clinica: 1, configuracion: { timezone: zone }, equipment_booking_enabled: true };
  vm.runInNewContext(fs.readFileSync(controllerPath, 'utf8'), { exports: exported, console, Date, Map, Set, Promise,
    require: name => {
      if (name === '../../models') return { Sequelize: { Op: {} }, Clinica: { findByPk: async () => clinic } };
      if (name === 'express-async-handler') return fn => fn;
      if (name === '../lib/access-policy') return { assertUserCanAccessFeature: async () => { calls.acl++; } };
      if (name === '../services/appointmentBookingAvailability.service') return {
        ...localRequire(name), loadBookingContext: async () => { calls.context++; return context; },
      };
      if (name === '../services/treatmentBookingProfile.service') return {
        ...localRequire(name), loadScopedTreatment: async () => ({}), requireOperationalProfile: () => profile,
        bookingCapabilities: () => ({ simple: true, multi: true, equipment: true }),
      };
      return localRequire(name);
    },
  }, { filename: controllerPath });
  const call = async (route, extra = {}) => {
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await exported[route]({ userData: { userId: 1 }, query: { clinica_id: '1', tratamiento_id: '10', duracion_min: String(duration),
      granularity_min: '5', from_local: '09:00', to_local: '20:00', ...extra } }, response);
    return response;
  };
  return { profile, context, call, calls };
}

test('a unique 12:45–13:30 opening is returned at five-minute precision, not at ten-minute precision', () => {
  const f = fixture();
  const slots = stepMinutes => solutionsForCalendar({ profile: f.profile, context: f.context, date: day, stepMinutes });
  assert.deepEqual(slots(5).map(s => s.start_local), [day + 'T12:45']);
  assert.deepEqual(slots(10), []);
  for (const [time, available] of [['12:40',false], ['12:45',true], ['12:50',false]]) {
    assert.equal(!!solveBookingProfile({ profile: f.profile, start: instant(time), ...f.context }), available);
  }
});

for (const mode of ['doctor','installation']) test(`${mode}: grid, mini-calendar and exact check agree on the off-ten-minute opening`, async () => {
  const f = fixture(), column = mode === 'doctor' ? 5 : 9;
  const query = { dates: [day], mode, column_ids: [column], ...(mode === 'doctor' ? { peer_instalacion_ids: [9] } : { peer_doctor_ids: [5] }) };
  const grid = await f.call('grid', query);
  const row = grid.body.rows[0], slots = mode === 'doctor' ? row.slots_by_instalacion[9] : row.slots_by_doctor[5];
  assert.equal(row.ok, true); assert.deepEqual(Array.from(slots, s => s.start_local), [day + 'T12:45']);
  assert.equal(f.calls.context, 1, 'one context read for the whole matrix');
  const summary = await f.call('summary', query);
  assert.equal(summary.body.by_day[day], true);
  const exact = await f.call('check', { doctor_id: '5', instalacion_id: '9', inicio_local: day + 'T12:45', fin_local: day + 'T13:30' });
  assert.equal(exact.statusCode, 200); assert.equal(exact.body.available, true);
});

test('whole duration must fit: 20, 30, 45 and 60 minutes do not acquire fabricated end times', () => {
  for (const duration of [20,30,45,60]) {
    const f = fixture({ duration });
    const slots = solutionsForCalendar({ profile: f.profile, context: f.context, date: day, stepMinutes: 5 });
    assert.equal(slots.length, duration > 45 ? 0 : (45 - duration) / 5 + 1);
    for (const slot of slots) {
      assert.equal(new Date(slot.end_utc) - new Date(slot.start_utc), duration * 60000);
      assert(new Date(slot.end_utc) <= instant('13:30'));
    }
  }
});

for (const resource of ['roomBusy','equipmentBusy','staffBusy']) test(`${resource}: finer granularity does not bypass resource conflicts`, async () => {
  const f = fixture({ [resource]: true });
  const grid = await f.call('grid', { dates: [day], mode: 'installation', column_ids: [9], peer_doctor_ids: [5] });
  assert.equal(grid.body.rows[0].slots_by_doctor[5].length, 0);
  assert.equal((await f.call('summary', { dates: [day], doctor_id: '5', instalacion_id: '9' })).body.by_day[day], false);
  const exact = await f.call('check', { doctor_id: '5', instalacion_id: '9', inicio_local: day + 'T12:45', fin_local: day + 'T13:30' });
  assert.equal(exact.statusCode, 409); assert.equal(exact.body.can_force, false);
  assert.doesNotMatch(JSON.stringify(exact.body), /paciente_id|patient_id|appointment_id/);
});

test('the supporting clinician is still required for the whole appointment', async () => {
  for (const supportBusy of [false,true]) {
    const f = fixture({ supportBusy });
    const grid = await f.call('grid', { dates: [day], mode: 'installation', column_ids: [9], peer_doctor_ids: [5], additional_staff_ids: [8] });
    assert.equal(grid.body.rows[0].slots_by_doctor[5].length, supportBusy ? 0 : 1);
  }
});

function reasonAt(intervals, time) {
  const value = day + 'T' + time;
  return intervals.find(interval => interval.start_local <= value && value < interval.end_local)?.resource_conflicts[0]?.details;
}

for (const mode of ['doctor', 'installation']) test(`${mode}: rejected starts have compressed, specific reasons without extra context reads`, async () => {
  const f = fixture(); f.context.doctors.get(5).name = 'Fictitious clinician';
  const query = { dates: [day], mode, column_ids: mode === 'doctor' ? [5,7] : [9,10],
    ...(mode === 'doctor' ? { peer_instalacion_ids: [9,10] } : { peer_doctor_ids: [5,7] }) };
  const grid = await f.call('grid', query), allowed = grid.body.rows[0], excluded = grid.body.rows[1];
  const intervals = mode === 'doctor' ? allowed.unavailable_by_instalacion[9] : allowed.unavailable_by_doctor[5];
  assert.equal(reasonAt(intervals, '09:00').reason_key, 'clinic_schedule');
  assert.equal(reasonAt(intervals, '12:40').reason_key, 'resource_busy');
  assert.match(reasonAt(intervals, '12:40').message, /Fictitious clinician.*45 min/);
  assert.equal(reasonAt(intervals, '12:45'), undefined, 'a valid starting position is not painted unavailable');
  assert.equal(reasonAt(intervals, '12:50').reason_key, 'clinic_schedule', 'the duration crosses closing, not an invented machine collision');
  assert(intervals.length < 10, 'adjacent equal reasons are compressed, not one node per grid cell');
  const excludedIntervals = mode === 'doctor' ? excluded.unavailable_by_instalacion[9] : excluded.unavailable_by_doctor[5];
  assert.equal(reasonAt(excludedIntervals, '12:45').reason_key, mode === 'doctor' ? 'incompatible_staff' : 'incompatible_installation');
  assert.equal(f.calls.context, 1);
  assert.doesNotMatch(JSON.stringify(grid.body), /appointment_id|paciente_id|patient_id|notes|clinica_ids/);
  for (const interval of intervals) {
    assert.equal(interval.interval_kind, 'appointment_start');
    assert.equal(interval.resource_conflicts[0].can_force, false);
  }
});

for (const resource of ['roomBusy', 'equipmentBusy', 'staffBusy', 'supportBusy']) test(`${resource}: diagnostics name the actual binding resource`, async () => {
  const f = fixture({ [resource]: true });
  const query = { dates: [day], mode: 'installation', column_ids: [9], context_doctor_id: '5',
    ...(resource === 'supportBusy' ? { additional_staff_ids: [8] } : {}) };
  const grid = await f.call('grid', query), reason = reasonAt(grid.body.rows[0].unavailable_intervals, '12:45');
  assert.equal(reason.reason_key, resource === 'equipmentBusy' ? 'equipment_busy' : 'resource_busy');
  assert.match(reason.message, resource === 'equipmentBusy' ? /Fictitious equipment/ : resource === 'roomBusy' ? /Fictitious room/ : /profesional/);
  assert.equal(grid.body.rows[0].slots.length, 0);
});

test('diagnostics are opt-in, summaries remain early OR and do not change the canonical slots', async () => {
  const f = fixture(), selections = { care: { doctor_id: 5, installation_id: 9 } }, reasons = [];
  const input = { profile: f.profile, context: f.context, date: day, stepMinutes: 5, selections,
    fromLocal: '09:00', toLocal: '20:00' };
  assert.deepEqual(solutionsForCalendar(input), solutionsForCalendar({ ...input, onUnavailable: (start, conflict) => reasons.push({ start, conflict }) }));
  assert(reasons.length > 0);
  const summary = await f.call('summary', { dates: [day], doctor_id: '5', instalacion_id: '9' });
  assert.equal(summary.body.by_day[day], true);
  assert.doesNotMatch(JSON.stringify(summary.body), /resource_conflicts|unavailable_intervals/);
});

test('continuous staff rejection explains the stored reservation without claiming presotherapy is inherently continuous', async () => {
  const f = fixture({ staffBusy: true }), staff = f.context.doctors.get(5);
  staff.name = 'Piedad ficticia';
  staff.busy[0].diagnostic = { kind: 'appointment', treatment_name: 'PRESOTERAPIA FICTICIA', full_interval: true, time_range: '09:30–13:30' };
  const grid = await f.call('grid', { dates: [day], mode: 'installation', column_ids: [9], context_doctor_id: '5' });
  const reason = reasonAt(grid.body.rows[0].unavailable_intervals, '12:45');
  assert.match(reason.message, /Piedad ficticia.*PRESOTERAPIA FICTICIA.*09:30–13:30/);
  assert.match(reason.message, /Esa cita reserva al profesional.*45 min seguidos/);
  assert.doesNotMatch(reason.message, /presoterapia requiere|tratamiento que requiere todo el tiempo/i);
  assert.equal(grid.body.rows[0].slots.length, 0);
});

test('partial staff rejection spells out the initial and final machine windows', async () => {
  const f = fixture({ staffBusy: true });
  f.context.equipment.get(6).attention_policy = { mode: 'start_end', start_minutes: 5, start_window_minutes: 10, end_minutes: 5, end_window_minutes: 10 };
  const grid = await f.call('grid', { dates: [day], mode: 'installation', column_ids: [9], context_doctor_id: '5' });
  const reason = reasonAt(grid.body.rows[0].unavailable_intervals, '12:45');
  assert.equal(reason.reason_key, 'staff_intervention');
  assert.match(reason.message, /5 min de puesta en marcha.*primeros 10 min.*5 min de retirada.*últimos 10 min.*Fictitious equipment/);
  assert.equal(grid.body.rows[0].slots.length, 0);
});

test('equipment rejection spells out visit duration and turnaround separately from staff attention', async () => {
  const f = fixture({ equipmentBusy: true });
  f.context.equipment.get(6).turnaround_minutes = 10;
  const grid = await f.call('grid', { dates: [day], mode: 'installation', column_ids: [9], context_doctor_id: '5' });
  const reason = reasonAt(grid.body.rows[0].unavailable_intervals, '12:45');
  assert.equal(reason.reason_key, 'equipment_busy');
  assert.match(reason.message, /Fictitious equipment.*45 min.*preparación.*10 min/);
});

test('ordinary profile grid, mini-calendar and exact check agree on overlap with no configured permissions', async () => {
  const f=fixture({staffBusy:true}),phase=f.profile.phases[0];
  f.profile.version=1;delete phase.equipment_requirements;
  const busy={start:instant('12:45'),end:instant('13:30'),appointment_id:1,can_share:true};
  for(const target of [f.context.doctors.get(5),f.context.installations.get(9)]) {
    Object.assign(target,{allow_overlap_confirmation:false,overlap_capacity:1,busy:[busy]});
  }
  const exact=await f.call('check',{doctor_id:'5',instalacion_id:'9',inicio_local:day+'T12:45',fin_local:day+'T13:30'});
  assert.equal(exact.statusCode,409);assert.equal(exact.body.can_force,true);
  assert.equal(exact.body.available,false,'no silent overlap on the exact check');
  const summary=await f.call('summary',{dates:[day],doctor_id:'5',instalacion_id:'9'});
  assert.equal(summary.body.by_day[day],true);
  for(const mode of ['doctor','installation']) {
    const query={dates:[day],mode,column_ids:mode==='doctor'?[5]:[9],...(mode==='doctor'?{peer_instalacion_ids:[9]}:{peer_doctor_ids:[5]})};
    const grid=await f.call('grid',query),row=grid.body.rows[0];
    const slots=mode==='doctor'?row.slots_by_instalacion[9]:row.slots_by_doctor[5];
    const overlap=slots.find(slot=>slot.start_local===day+'T12:45');
    assert(overlap);assert.equal(overlap.requires_overlap_acknowledgement,true);
    assert.doesNotMatch(JSON.stringify(grid.body),/appointment_id|patient_id|paciente_id/);
  }
});

test('foreign reservations never disclose their catalog name or other private fields in explanations', async () => {
  const f = fixture({ staffBusy: true });
  f.context.doctors.get(5).busy[0].diagnostic = { kind: 'other_clinic', treatment_name: 'Foreign treatment', time_range: '09:30–13:30', patient_name: 'Private patient' };
  const grid = await f.call('grid', { dates: [day], mode: 'installation', column_ids: [9], context_doctor_id: '5' });
  assert.match(reasonAt(grid.body.rows[0].unavailable_intervals, '12:45').message, /ocupado en otra clínica/);
  assert.doesNotMatch(JSON.stringify(grid.body), /Foreign treatment|Private patient|diagnostic|appointment_id/);
});
