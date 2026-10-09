'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const controllerPath = require.resolve('../../controllers/disponibilidad.controller');
const localRequire = createRequire(controllerPath);
const code = fs.readFileSync(controllerPath, 'utf8');
const { loadLegacyAvailabilitySnapshot, buildLegacySlots } = localRequire('../lib/availability-request-snapshot');
const { localDateTimeToUtc, buildWindowsFromHorarios, buildDoctorAvailabilityContext } = localRequire('../lib/availability-calendar');
const { addDays } = localRequire('../lib/personal-schedule-recurring');
const json = value => JSON.parse(JSON.stringify(value));
const Op = Object.fromEntries(['in', 'or', 'ne', 'lt', 'gt', 'lte'].map(key => [key, Symbol(key)]));
const horarios = Array.from({ length: 7 }, (_, dia_semana) => ({ dia_semana, activo: true, hora_inicio: '09:00', hora_fin: '18:00' }));

function fixture({ denied = false, profile = null, supportBusy = false, supportPerson = null, clinicHours = [], treatmentError = null } = {}) {
  const counts = { acl: 0, clinic: 0, clinicHours: 0, rooms: 0, doctorLinks: 0, doctorBlocks: 0,
    roomBlocks: 0, roomAppointments: 0, doctorAppointments: 0, profileContext: 0, catalog: 0, solve: 0 };
  const clinic = { id_clinica: 72, grupoClinicaId: 29, equipment_booking_enabled: true, configuracion: { timezone: 'Europe/Madrid' } };
  const rooms = [9, 10, 11].map(id => ({ id, clinica_id: 72, activo: true, horarios, allow_overlap_confirmation: true }));
  const doctors = [5, 6, 7].map(doctor_id => ({ doctor_id, clinica_id: 72, activo: true, recibe_citas: true,
    horarios, allow_overlap_confirmation: true }));
  const state = { doctorAppointments: [], roomAppointments: [], doctorBlocks: [], roomBlocks: [], profileBusy: false };
  const scoped = (rows, ids, field, from, to) => rows.filter(row => ids.includes(Number(row[field]))
    && new Date(row.inicio || row.fecha_inicio) < to && new Date(row.fin || row.fecha_fin) > from);
  const db = { Sequelize: { Op }, Clinica: { findByPk: async id => { counts.clinic++; return id === 72 ? clinic : null; } },
    ClinicaHorario: { findAll: async () => { counts.clinicHours++; return clinicHours; } },
    Instalacion: { findAll: async q => { counts.rooms++; assert.equal(q.where.clinica_id, 72); assert.equal(q.where.activo, true);
      return rooms.filter(row => q.where.id[Op.in].includes(row.id)); }, findByPk: async id => { counts.rooms++; return rooms.find(row => row.id === id) || null; } },
    DoctorClinica: { findAll: async q => { counts.doctorLinks++; assert.equal(q.where.clinica_id, 72); assert.equal(q.where.activo, true);
      return doctors.filter(row => q.where.doctor_id[Op.in].includes(row.doctor_id)); }, findOne: async q => { counts.doctorLinks++;
      return doctors.find(row => row.doctor_id === q.where.doctor_id) || null; } },
    DoctorBloqueo: { findAll: async q => { counts.doctorBlocks++; const ids = q.where.doctor_id[Op.in] || [q.where.doctor_id];
      return state.doctorBlocks.filter(row => ids.includes(row.doctor_id)); } },
  };
  const readers = {
    resourceAppointments: async args => {
      const ids = args.doctorIds?.length ? args.doctorIds : args.doctorId ? [args.doctorId] : args.installationIds?.length ? args.installationIds : [args.installationId];
      const doctor = !!(args.doctorId || args.doctorIds?.length);
      counts[doctor ? 'doctorAppointments' : 'roomAppointments']++;
      if (doctor) assert(ids.every(id => doctors.some(person => person.doctor_id === id && person.activo)), 'nonmember/archived clinicians must not reach canonical reader');
      if (!doctor) { assert.equal(args.clinic.id_clinica, 72); assert(ids.every(id => rooms.some(room => room.id === id)), 'foreign/archived rooms must not reach canonical reader'); }
      return scoped(state[doctor ? 'doctorAppointments' : 'roomAppointments'], ids, doctor ? 'doctor_id' : 'instalacion_id', args.start, args.end);
    },
    resourceInstallationBlocks: async args => { counts.roomBlocks++; return scoped(state.roomBlocks, args.installationIds, 'instalacion_id', args.start, args.end); },
    loadBookingContext: async args => {
      counts.profileContext++; assert.equal(args.occupancyEnabled, true);
      return { doctors: new Map([[8, supportPerson || { windows: [{ start: args.start, end: args.end }], busy: supportBusy
        ? [{ start: new Date('2030-01-07T08:00:00Z'), end: new Date('2030-01-07T17:00:00Z') }] : [] }]]) };
    },
  };
  const exported = {};
  vm.runInNewContext(code, { exports: exported, console: { warn() {} }, Date, Map, Set, Promise,
    require: name => {
      if (name === '../../models') return db;
      if (name === 'express-async-handler') return fn => fn;
      if (name === '../lib/access-policy') return { assertUserCanAccessFeature: async args => { counts.acl++; assert.equal(args.clinicId, 72);
        if (denied) throw Object.assign(Error('denied'), { statusCode: 403 }); } };
      if (name === '../services/appointmentResourceCalendar.service') return readers;
      if (name === '../services/appointmentBookingAvailability.service') return { ...localRequire(name), loadBookingContext: readers.loadBookingContext,
        solutionsForCalendar: args => { counts.solve++; return state.profileBusy ? [] : [{ start_local: `${args.date}T10:00`, end_local: `${args.date}T10:30` }]; } };
      if (name === '../services/treatmentBookingProfile.service') return { ...localRequire(name),
        bookingCapabilities: () => ({ simple: true, multi: true }), loadScopedTreatment: async () => {
          counts.catalog++; if (treatmentError) throw treatmentError; return {};
        }, requireOperationalProfile: () => profile };
      return localRequire(name);
    },
  }, { filename: controllerPath });
  const base = { clinica_id: '72', duracion_min: '20', granularity_min: '10', from_local: '09:00', to_local: '12:00' };
  async function call(route, query = {}) {
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = json(value); return this; } };
    await exported[route]({ userData: { userId: 1 }, query: { ...base, ...query } }, response);
    return response;
  }
  return { counts, state, db, readers, clinic, rooms, doctors, call };
}

test('generic grid parity with legacy /slots in both matrix orientations, with bounded reads', async () => {
  for (const mode of ['doctor', 'installation']) {
    const f = fixture();
    const dates = ['2030-01-07', '2030-01-08'];
    const columns = mode === 'doctor' ? [5, 6] : [9, 10];
    const response = await f.call('grid', { dates, mode, column_ids: columns,
      ...(mode === 'doctor' ? { peer_instalacion_ids: [9, 10, 11] } : { peer_doctor_ids: [5, 6, 7] }) });
    assert.equal(response.statusCode, 200); assert.equal(response.body.rows.length, 4);
    assert.deepEqual(f.counts, { acl: 1, clinic: 1, clinicHours: 1, rooms: 1, doctorLinks: 1, doctorBlocks: 1,
      roomBlocks: 1, roomAppointments: 1, doctorAppointments: 1, profileContext: 0, catalog: 0, solve: 0 });
    for (const row of response.body.rows) {
      const legacy = await f.call('slots', { fecha_local: row.day_id, include_unavailable: 'true', ...(mode === 'doctor'
        ? { doctor_id: row.column_id, instalacion_ids: [9, 10, 11] } : { instalacion_id: row.column_id, doctor_ids: [5, 6, 7] }) });
      const key = mode === 'doctor' ? 'instalacion' : 'doctor';
      assert.equal(row.ok, true);
      assert.deepEqual(row[`slots_by_${key}`], legacy.body[`slots_by_${key}`]);
      assert.deepEqual(row[`unavailable_by_${key}`], legacy.body[`unavailable_by_${key}`]);
    }
  }
});

test('a legacy treatment without a booking profile (623) uses one grid snapshot/catalog read', async () => {
  const f = fixture();
  const result = await f.call('grid', { tratamiento_id: '623', dates: ['2030-01-07', '2030-01-08'], mode: 'installation', column_ids: [9, 10, 11], peer_doctor_ids: [5, 6, 7] });
  assert(result.body.rows.every(row => row.ok));
  assert.equal(f.counts.acl, 1); assert.equal(f.counts.catalog, 1); assert.equal(f.counts.clinic, 1);
  assert.equal(f.counts.doctorAppointments, 1); assert.equal(f.counts.roomAppointments, 1); assert.equal(f.counts.profileContext, 0);
});

test('mixed doctor-only columns use the same bulk snapshot without pretending every peer room belongs to them', async () => {
  const f = fixture();
  f.rooms.forEach(room => { room.profesionales_permitidos = [6]; });
  const query = { dates: ['2030-01-07'], mode: 'doctor', column_ids: [5, 6],
    peer_instalacion_ids: [9, 10, 11], doctor_only_column_ids: [5] };
  const result = await f.call('grid', query);
  assert.equal(result.statusCode, 200);
  const roomless = result.body.rows.find(row => row.column_id === '5');
  const paired = result.body.rows.find(row => row.column_id === '6');
  assert(roomless.slots.length > 0); assert.equal(roomless.slots_by_instalacion, undefined);
  assert.equal(roomless.unavailable_by_instalacion, undefined);
  assert.deepEqual(Object.keys(paired.slots_by_instalacion).sort(), ['10', '11', '9']);
  assert(Object.values(paired.slots_by_instalacion).every(slots => slots.length > 0));
  assert.deepEqual(f.counts, { acl: 1, clinic: 1, clinicHours: 1, rooms: 1, doctorLinks: 1, doctorBlocks: 1,
    roomBlocks: 1, roomAppointments: 1, doctorAppointments: 1, profileContext: 0, catalog: 0, solve: 0 });
  const legacy = await f.call('slots', { fecha_local: '2030-01-07', doctor_id: '5', include_unavailable: 'true' });
  assert.deepEqual(roomless.slots, legacy.body.slots);
  assert.deepEqual(roomless.unavailable_intervals, legacy.body.unavailable_intervals);
  assert.equal((await f.call('summary', query)).body.by_day['2030-01-07'], true);
});

test('doctor-only projection retains true clinic closure and staff occupancy diagnostics', async () => {
  const f = fixture({ clinicHours: [{ dia_semana: 1, activo: true, hora_inicio: '09:30', hora_fin: '11:00' }] });
  f.rooms.forEach(room => { room.profesionales_permitidos = [6]; });
  f.state.doctorAppointments.push({ id_cita: 1, clinica_id: 66, doctor_id: 5,
    inicio: '2030-01-07T09:00:00Z', fin: '2030-01-07T09:30:00Z' });
  const result = await f.call('grid', { dates: ['2030-01-07'], mode: 'doctor', column_ids: [5, 6],
    peer_instalacion_ids: [9, 10, 11], 'doctor_only_column_ids[]': ['5'] });
  const row = result.body.rows.find(item => item.column_id === '5');
  const codes = row.unavailable_intervals.flatMap(span => span.resource_conflicts.map(item => item.code));
  assert(codes.includes('CLINIC_OUT_OF_HOURS'));
  assert(codes.includes('STAFF_OVERLAP'));
  assert(!codes.includes('INSTALLATION_PROFESSIONAL_NOT_ALLOWED'));
  assert(row.slots.some(slot => slot.start_local === '2030-01-07T09:30'));
});

test('doctor-only field rejects partial IDs, float/nested/object inputs, invalid scope, treatment and room contexts before reading SQL', async () => {
  const base = { dates: ['2030-01-07'], mode: 'doctor', column_ids: [5, 6], doctor_only_column_ids: [5] };
  const patches = [
    ...['5oops', '5.1', '0', '-5', '9007199254740992', '5,', {}, [[5]], [], [5, {}], Array(81).fill(5)]
      .map(value => ({ doctor_only_column_ids: value })),
    { doctor_only_column_ids: [7] }, { mode: 'installation' }, { mode: 'doctors' },
    { tratamiento_id: '623' }, { context_instalacion_id: '9' }, { preferred_instalacion_id: '9' }, { instalacion_id: '9' },
    { instalacion_ids: [9, 10, 11] }, { 'instalacion_ids[]': [9] }, { doctor_ids: [6] }, { 'doctor_ids[]': [6] },
  ];
  for (const route of ['grid', 'summary']) for (const patch of patches) {
    const f = fixture(), result = await f.call(route, { ...base, ...patch });
    assert.equal(result.statusCode, 400, JSON.stringify({ route, patch, result }));
    assert(Object.values(f.counts).every(count => count === 0), 'Rejected request cannot load tenant data');
  }
});

test('42-day matrix summary ORs the same slots as legacy, without 42×columns reads or diagnostics', async () => {
  const f = fixture(), dates = Array.from({ length: 42 }, (_, index) => addDays('2030-01-07', index));
  const result = await f.call('summary', { dates, mode: 'installation', column_ids: [9, 10, 11], peer_doctor_ids: [5, 6, 7], include_unavailable: 'true' });
  assert.equal(result.statusCode, 200); assert.equal(Object.keys(result.body.by_day).length, 42);
  assert(Object.values(result.body.by_day).every(Boolean));
  assert.equal(f.counts.clinic, 1); assert.equal(f.counts.doctorAppointments, 1); assert.equal(f.counts.roomAppointments, 1);
  assert.equal(f.counts.doctorLinks, 1); assert.equal(f.counts.doctorBlocks, 1); assert.equal(f.counts.roomBlocks, 1);
  assert.doesNotMatch(JSON.stringify(result.body), /resource_conflicts|unavailable_intervals/);
  for (const fecha_local of dates) {
    const old = await f.call('slots', { fecha_local, doctor_id: '5', instalacion_ids: [9, 10, 11], limit: '1' });
    assert.equal(result.body.by_day[fecha_local], Object.values(old.body.slots_by_instalacion).some(slots => slots.length > 0));
  }
});

test('old summary callers remain compatible and subsequent requests see new occupancy', async () => {
  const f = fixture(), query = { dates: ['2030-01-07'], doctor_id: '5', instalacion_id: '9' };
  assert.equal((await f.call('summary', query)).body.by_day['2030-01-07'], true);
  f.state.doctorAppointments.push({ id_cita: 1, clinica_id: 66, doctor_id: 5, inicio: '2030-01-07T08:00:00Z', fin: '2030-01-07T11:00:00Z' });
  assert.equal((await f.call('summary', query)).body.by_day['2030-01-07'], false);
  assert.equal(f.counts.doctorAppointments, 2); assert.equal(f.counts.roomAppointments, 2);
});

test('partial clinician attention remains partial while the room remains occupied throughout', async () => {
  const f = fixture();
  f.state.doctorAppointments = [
    { id_cita: 1, clinica_id: 72, doctor_id: 5, inicio: '2030-01-07T08:00:00Z', fin: '2030-01-07T08:05:00Z', segmented: true },
    { id_cita: 1, clinica_id: 72, doctor_id: 5, inicio: '2030-01-07T08:55:00Z', fin: '2030-01-07T09:00:00Z', segmented: true },
  ];
  f.state.roomAppointments = [{ id_cita: 1, clinica_id: 72, instalacion_id: 9, inicio: '2030-01-07T08:00:00Z', fin: '2030-01-07T09:00:00Z', segmented: true }];
  const response = await f.call('grid', { dates: ['2030-01-07'], mode: 'installation', column_ids: [9, 10], context_doctor_id: '5' });
  const room9 = response.body.rows.find(row => row.column_id === '9'), room10 = response.body.rows.find(row => row.column_id === '10');
  assert(room10.slots.some(slot => slot.start_local === '2030-01-07T09:05'));
  assert(!room9.slots.some(slot => slot.start_local < '2030-01-07T10:00'));
  const legacy = await f.call('slots', { fecha_local: '2030-01-07', doctor_id: '5', instalacion_id: '10', include_unavailable: 'true' });
  assert.deepEqual(room10.slots, legacy.body.slots); assert.deepEqual(room10.unavailable_intervals, legacy.body.unavailable_intervals);
});

test('same/other-clinic and force/nonforce conflicts cannot merge and disclose no appointment identity', async () => {
  const f = fixture();
  f.state.doctorAppointments = [
    { id_cita: 1, clinica_id: 72, doctor_id: 5, inicio: '2030-01-07T08:00:00Z', fin: '2030-01-07T09:00:00Z', can_share: true },
    { id_cita: 2, clinica_id: 72, doctor_id: 5, inicio: '2030-01-07T09:00:00Z', fin: '2030-01-07T10:00:00Z', can_share: false },
    { id_cita: 3, clinica_id: 66, doctor_id: 5, inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T11:00:00Z', can_share: true },
  ];
  const result = await f.call('grid', { dates: ['2030-01-07'], mode: 'doctor', column_ids: [5], context_instalacion_id: '9', duracion_min: '10' });
  const intervals = result.body.rows[0].unavailable_intervals;
  const conflicts = intervals.flatMap(row => row.resource_conflicts).filter(row => row.code === 'STAFF_OVERLAP');
  assert(conflicts.some(c => c.details.clinica_id === 72 && c.can_force === true));
  assert(conflicts.some(c => c.details.clinica_id === 72 && c.can_force === false));
  assert(conflicts.some(c => c.details.clinica_id === 66 && c.can_force === false));
  assert(intervals.every(row => row.interval_kind === 'unavailable_candidate_span'));
  assert.doesNotMatch(JSON.stringify(result.body), /id_cita|paciente_id|patient_id|source_reference/);
});

test('ordinary legacy grid conflicts remain forceable with professional and consultation permissions off', async () => {
  const f=fixture();
  for(const row of [...f.doctors,...f.rooms])Object.assign(row,{allow_overlap_confirmation:false,overlap_capacity_unlimited:false,capacidad:1});
  const row={id_cita:1,clinica_id:72,doctor_id:5,instalacion_id:9,inicio:'2030-01-07T09:00:00Z',fin:'2030-01-07T10:00:00Z',can_share:true};
  f.state.doctorAppointments=[row];f.state.roomAppointments=[row];
  const result=await f.call('grid',{dates:['2030-01-07'],mode:'doctor',column_ids:[5],context_instalacion_id:'9',duracion_min:'10'});
  const conflicts=result.body.rows[0].unavailable_intervals.flatMap(row=>row.resource_conflicts).filter(row=>/OVERLAP$/.test(row.code));
  assert(conflicts.some(row=>row.code==='STAFF_OVERLAP'));
  assert(conflicts.some(row=>row.code==='INSTALLATION_OVERLAP'));
  assert(conflicts.every(row=>row.can_force===true));
});

test('permission denial precedes resource reads and foreign/archived columns never reach alias readers', async () => {
  const f = fixture({ denied: true });
  for (const route of ['grid', 'summary']) await assert.rejects(f.call(route, { dates: ['2030-01-07'], column_ids: [9], mode: 'installation' }), { statusCode: 403 });
  assert.equal(f.counts.clinic, 0); assert.equal(f.counts.roomAppointments, 0); assert.equal(f.counts.doctorAppointments, 0);
  const g = fixture();
  const result = await g.call('grid', { dates: ['2030-01-07'], column_ids: [9, 999], mode: 'installation', context_doctor_id: '5' });
  assert.equal(result.body.rows[0].ok, true); assert.equal(result.body.rows[1].ok, false);
  assert.equal((await g.call('summary', { dates: ['2030-01-07'], instalacion_ids: [9, 999], doctor_id: '5' })).body.by_day['2030-01-07'], null);
});

test('unassigned and archived doctors are unavailable without reading their other-clinic occupations', async () => {
  const f = fixture(); f.doctors[1].activo = false;
  const result = await f.call('grid', { dates: ['2030-01-07'], column_ids: [5, 6, 999], mode: 'doctor', context_instalacion_id: '9' });
  assert(result.body.rows[0].slots.length > 0);
  for (const row of result.body.rows.slice(1)) {
    assert.equal(row.ok, true); assert.equal(row.slots.length, 0);
    assert(row.unavailable_intervals.every(interval => interval.resource_conflicts.some(conflict => conflict.code === 'STAFF_OUT_OF_HOURS')));
  }
  assert.equal(f.counts.doctorAppointments, 1);
  const g = fixture(); await g.call('summary', { dates: ['2030-01-07'], doctor_id: '999', instalacion_id: '9' });
  assert.equal(g.counts.doctorAppointments, 0); assert.equal(g.counts.doctorBlocks, 0);
});

test('invalid duration and granularity fail before all resource reads, including zero/negative step', async () => {
  for (const route of ['grid', 'summary']) for (const granularity_min of ['0', '-5', '121', 'nonsense']) {
    const f = fixture(); const response = await f.call(route, { dates: ['2030-01-07'], column_ids: [9], mode: 'installation', granularity_min });
    assert.equal(response.statusCode, 400); assert.equal(f.counts.clinic, 0); assert.equal(f.counts.doctorAppointments, 0);
  }
  for (const duracion_min of ['0', '-10']) {
    const f = fixture(); const response = await f.call('grid', { dates: ['2030-01-07'], column_ids: [9], duracion_min });
    assert.equal(response.statusCode, 400); assert.equal(f.counts.clinic, 0);
  }
  const f = fixture(); assert.equal((await f.call('grid', { dates: ['2030-01-07'], column_ids: [9], granularity_min: '1' })).statusCode, 200);
});

test('scoped-treatment 404 keeps its canonical error code for the booking middleware', async () => {
  const { bookingError } = localRequire('../services/treatmentBookingProfile.service');
  for (const route of ['grid', 'summary']) {
    const f = fixture({ treatmentError: bookingError('treatment_not_found', 'Tratamiento no encontrado.', null, 404) });
    await assert.rejects(f.call(route, { dates: ['2030-01-07'], column_ids: [9], mode: 'installation', tratamiento_id: '999' }),
      { statusCode: 404, code: 'treatment_not_found' });
    assert.equal(f.counts.acl, 1); assert.equal(f.counts.catalog, 1); assert.equal(f.counts.roomAppointments, 0);
  }
});

test('DST change on 2026-10-25 preserves local windows and profile summary does one context with early OR', async () => {
  const f = fixture(), dates = ['2026-10-24', '2026-10-25', '2026-10-26'];
  const result = await f.call('grid', { dates, column_ids: [9], mode: 'installation', context_doctor_id: '5', from_local: '09:00', to_local: '10:00' });
  assert.deepEqual(result.body.rows.map(row => row.slots[0].start_utc), ['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z']);
  const profile = { phases: [{ key: 'care', duration_minutes: 30, installation_ids: [9, 10], professionals: { mode: 'any', ids: [5, 6] } }] };
  const g = fixture({ profile });
  const summary = await g.call('summary', { tratamiento_id: '10', dates: Array.from({ length: 42 }, (_, index) => addDays('2026-10-04', index)),
    column_ids: [5, 6], mode: 'doctor', peer_instalacion_ids: [9, 10] });
  assert.equal(summary.statusCode, 200); assert.equal(g.counts.profileContext, 1); assert.equal(g.counts.solve, 42);
  assert.equal(g.counts.catalog, 1); assert.equal(g.counts.acl, 1); assert.equal(g.counts.roomAppointments, 0);
});

test('support windows/busy are read once for a range and restrict slots consistently with legacy', async () => {
  const f = fixture({ supportBusy: true });
  const result = await f.call('grid', { dates: ['2030-01-07', '2030-01-08'], column_ids: [9, 10], mode: 'installation', context_doctor_id: '5', additional_staff_ids: [8] });
  assert.equal(f.counts.profileContext, 1);
  assert(result.body.rows.filter(row => row.day_id === '2030-01-07').every(row => row.slots.length === 0));
  assert(result.body.rows.filter(row => row.day_id === '2030-01-08').every(row => row.slots.length > 0));
  const legacy = await f.call('slots', { fecha_local: '2030-01-07', doctor_id: '5', instalacion_id: '9', additional_staff_ids: [8] });
  assert.deepEqual(result.body.rows[0].slots, legacy.body.slots);
});

test('Oct 14 support + C2 permission report real reasons inside opening hours, in both orientations and legacy', async () => {
  const date = '2026-10-14', tz = 'Europe/Madrid';
  const at = hm => localDateTimeToUtc(date, hm, tz);
  for (const mode of ['doctor', 'installation']) {
    const f = fixture({ clinicHours: [{ dia_semana: 3, activo: true, hora_inicio: '09:30', hora_fin: '20:00' }],
      supportPerson: { name: 'Celia', windows: [{ start: at('09:30'), end: at('17:30') }], busy: [{
        start: at('11:00'), end: at('11:45'), appointment_id: 77811,
        diagnostic: { kind: 'other_clinic', time_range: '11:00–11:45' },
      }] } });
    f.rooms[0].nombre = 'C2'; f.rooms[0].profesionales_permitidos = [5];
    const context = mode === 'doctor' ? { column_ids: [5], context_instalacion_id: '9' }
      : { column_ids: [9], context_doctor_id: '5' };
    const base = { dates: [date], mode, ...context, duracion_min: '5', granularity_min: '5', from_local: '09:00', to_local: '18:00' };
    const free = await f.call('grid', base);
    assert(free.body.rows[0].slots.some(slot => slot.start_local === date + 'T11:00'));
    const result = await f.call('grid', { ...base, additional_staff_ids: [8] });
    assert.equal(result.body.rows[0].slots.length, 0);
    assert.equal(f.counts.profileContext, 1, 'one support snapshot per matrix');
    const intervals = result.body.rows[0].unavailable_intervals;
    const conflictsAt = hm => intervals.filter(i => i.start_local <= date + 'T' + hm && i.end_local > date + 'T' + hm)
      .flatMap(i => i.resource_conflicts);
    assert(conflictsAt('09:00').some(c => c.code === 'CLINIC_OUT_OF_HOURS'));
    const eleven = conflictsAt('11:00');
    assert(!eleven.some(c => c.code === 'CLINIC_OUT_OF_HOURS'));
    assert(eleven.some(c => c.code === 'INSTALLATION_PROFESSIONAL_NOT_ALLOWED' && /Celia.*C2/.test(c.details.message)));
    assert(eleven.some(c => c.code === 'STAFF_OVERLAP' && c.details.other_clinic === true && /11:00.*11:45/.test(c.details.message)));
    assert(!conflictsAt('12:00').some(c => c.code === 'STAFF_OVERLAP'));
    assert(!conflictsAt('12:00').some(c => c.code === 'CLINIC_OUT_OF_HOURS'));
    assert.doesNotMatch(JSON.stringify(result.body), /77811|patient_id|paciente_id|treatment_name|appointment_id/);
    const legacy = await f.call('slots', { fecha_local: date, doctor_id: '5', instalacion_id: '9',
      additional_staff_ids: [8], include_unavailable: 'true', duracion_min: '5', granularity_min: '5', from_local: '09:00', to_local: '18:00' });
    assert.deepEqual(intervals, legacy.body.unavailable_intervals);
  }
});

test('snapshot windows memoize per date, not globally, and slot alignment matches the legacy free-span rule', async () => {
  const f = fixture();
  const snapshot = await loadLegacyAvailabilitySnapshot({ db: f.db, clinic: f.clinic, dates: ['2030-01-07'], doctorIds: [5], installationIds: [9],
    readers: f.readers, fetchClinicHorarios: async () => [] });
  assert.equal(snapshot.day('2030-01-07'), snapshot.day('2030-01-07'));
  assert.throws(() => snapshot.day('2030-01-08'), /OUT_OF_SCOPE/);
  const date = '2030-01-07', timeZone = 'Europe/Madrid', inst = f.rooms[0];
  const slots = buildLegacySlots({ baseStart: localDateTimeToUtc(date, '09:00', timeZone), baseEnd: localDateTimeToUtc(date, '10:00', timeZone),
    clinicHasSchedule: false, clinicWins: [], inst, instWins: buildWindowsFromHorarios(inst.horarios, 1, date, timeZone),
    doctorCtx: buildDoctorAvailabilityContext({ doctorId: 5, clinicaId: 72, dc: f.doctors[0], dow: 1, fechaLocal: date, timeZone }),
    timeZone, durMin: 20, stepMin: 10, maxSlots: 1, docCitasRows: [{ inicio: '2030-01-07T08:00:00Z', fin: '2030-01-07T08:07:00Z' }] });
  assert.equal(slots.length, 1); assert.equal(slots[0].start_local, '2030-01-07T09:07');
});
