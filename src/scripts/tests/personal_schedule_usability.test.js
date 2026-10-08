'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const recurring = require('../../lib/personal-schedule-recurring');
const calendar = require('../../lib/availability-calendar');
const plain = value => JSON.parse(JSON.stringify(value));
const Op = Object.fromEntries(['in', 'notIn', 'ne', 'gt', 'gte', 'lt', 'lte', 'or', 'and'].map(key => [key, Symbol(key)]));
function matches(value, where = {}) {
  return Reflect.ownKeys(where).every(key => {
    if (key === Op.or) return where[key].some(condition => matches(value, condition));
    if (key === Op.and) return where[key].every(condition => matches(value, condition));
    const wanted = where[key], actual = value[key];
    if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) return Reflect.ownKeys(wanted).every(operator => {
      const argument = wanted[operator];
      if (operator === Op.in) return argument.map(String).includes(String(actual));
      if (operator === Op.notIn) return !argument.map(String).includes(String(actual));
      if (operator === Op.ne) return actual !== argument;
      const left = actual instanceof Date || /^(\d{4}-\d{2}-\d{2})T/.test(String(actual)) ? new Date(actual).getTime() : actual;
      const right = argument instanceof Date ? argument.getTime() : argument;
      if (operator === Op.gt) return left > right;
      if (operator === Op.gte) return left >= right;
      if (operator === Op.lt) return left < right;
      if (operator === Op.lte) return left <= right;
      return true;
    });
    return actual === wanted || String(actual) === String(wanted);
  });
}
function fixture({ bookingEnabled = true, deniedClinic = null, realCoverageGuard = false, emitUndoReceipt = false } = {}) {
  let state = {
    links: [{ id: 201, doctor_id: 2, clinica_id: 10, activo: true, recibe_citas: true },
      { id: 202, doctor_id: 2, clinica_id: 20, activo: true, recibe_citas: true },
      { id: 301, doctor_id: 3, clinica_id: 10, activo: true, recibe_citas: true },
      { id: 302, doctor_id: 3, clinica_id: 20, activo: true, recibe_citas: true }],
    schedules: [{ id: 100, doctor_clinica_id: 201, dia_semana: 1, hora_inicio: '09:00', hora_fin: '13:00', activo: true,
      rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=3', fecha_inicio_vigencia: '2027-01-04', fecha_fin_vigencia: '2027-02-01' },
      { id: 101, doctor_clinica_id: 201, dia_semana: 3, hora_inicio: '14:00', hora_fin: '18:00', activo: true,
        rrule: null, fecha_inicio_vigencia: '2027-01-06', fecha_fin_vigencia: '2027-02-03' }],
    exceptions: [{ id: 900, doctor_horario_id: 100, fecha: '2027-01-18', cancelado: true,
      hora_inicio_override: null, hora_fin_override: null },
      { id: 901, doctor_horario_id: 100, fecha: '2027-02-01', cancelado: false,
        hora_inicio_override: '10:00', hora_fin_override: '12:00' }],
    appointments: [], phases: [], blocks: [], nextId: 1000,
  };
  const calls = { transactions: 0, scopes: [], rollback: 0, writes: 0, reads: [] };
  const tx = { options: { isolationLevel: 'READ COMMITTED' }, LOCK: { UPDATE: 'UPDATE' } };
  const wrapSchedule = data => Object.assign(Object.create(null), data, {
    get excepciones() { return state.exceptions.filter(row => row.doctor_horario_id === data.id); },
    async update(fields, options) { assert.equal(options.transaction, tx); calls.writes++; Object.assign(data, fields); Object.assign(this, fields); return this; },
    async destroy(options) { return models.DoctorHorario.destroy({ where: { id: data.id }, ...options }); },
  });
  // Object.assign evaluates getters. Define this accessor after wrapping.
  const schedule = data => {
    const wrapped = wrapSchedule(data);
    Object.defineProperty(wrapped, 'excepciones', { configurable: true, get: () => state.exceptions.filter(row => row.doctor_horario_id === data.id),
      set: rows => { state.exceptions = state.exceptions.filter(row => row.doctor_horario_id !== data.id).concat(rows); } });
    return wrapped;
  };
  const scoped = (row, query) => {
    const source = query.include?.find(include => include.as === 'doctorClinica');
    return !source || state.links.some(link => link.id === row.doctor_clinica_id && matches(link, source.where));
  };
  const models = {
    DoctorHorario: {
      findAll: async query => state.schedules.filter(row => matches(row, query.where) && scoped(row, query)).map(schedule),
      findOne: async query => { const row = state.schedules.find(row => matches(row, query.where) && scoped(row, query)); return row ? schedule(row) : null; },
      create: async (fields, options) => { assert.equal(options.transaction, tx); calls.writes++; const row = { id: state.nextId++, ...plain(fields) }; state.schedules.push(row); return schedule(row); },
      destroy: async query => { assert.equal(query.transaction, tx); calls.writes++; const removed = state.schedules.filter(row => matches(row, query.where));
        state.schedules = state.schedules.filter(row => !matches(row, query.where)); state.exceptions = state.exceptions.filter(row => !removed.some(old => old.id === row.doctor_horario_id)); return removed.length; },
    },
    DoctorHorarioExcepcion: {
      bulkCreate: async (rows, options) => { assert.equal(options.transaction, tx); const created = rows.map(row => ({ id: state.nextId++, ...plain(row) })); state.exceptions.push(...created); return created; },
      upsert: async (fields, options) => { assert.equal(options.transaction, tx); calls.writes++; const original = state.exceptions.find(row => row.doctor_horario_id === fields.doctor_horario_id && row.fecha === fields.fecha);
        if (original) Object.assign(original, plain(fields)); else state.exceptions.push({ id: state.nextId++, ...plain(fields) }); return []; },
    },
    DoctorClinica: {
      findOne: async query => state.links.find(row => matches(row, query.where)) || null,
      findAll: async query => state.links.filter(row => matches(row, query.where)).map(row => ({ ...row,
        clinica: { id_clinica: row.clinica_id, nombre_clinica: `Clínica ${row.clinica_id}` },
        horarios: state.schedules.filter(h => h.doctor_clinica_id === row.id).map(schedule) })),
    },
    Clinica: { findByPk: async id => ({ id_clinica: Number(id), configuracion: { timezone: Number(id) === 20 ? 'Atlantic/Canary' : 'Europe/Madrid' } }),
      findAll: async () => [10, 20].map(id => ({ id_clinica: id, configuracion: { timezone: id === 20 ? 'Atlantic/Canary' : 'Europe/Madrid' } })) },
    ClinicaHorario: { findAll: async query => [10, 20].filter(id => !query.where?.clinica_id || matches({ clinica_id: id }, query.where))
      .flatMap(id => [0, 1, 2, 3, 4, 5, 6].map(dia_semana => ({ clinica_id: id, dia_semana, hora_inicio: '07:00', hora_fin: '22:00', activo: true }))) },
    Usuario: { findByPk: async id => ({ id_usuario: Number(id), nombre: 'Profesional ficticio', estado_cuenta: 'activa', es_provisional: false }) },
    UsuarioClinica: {
      findOne: async query => query.where.rol_clinica === 'propietario' || (query.where.rol_clinica?.[Op.in] && !query.where.rol_clinica[Op.in].includes('doctor')) ? null : { id_usuario: query.where.id_usuario, id_clinica: query.where.id_clinica, subrol_clinica: 'doctor' },
      findAll: async query => state.links.filter(row => row.doctor_id === Number(query.where.id_usuario)).map(row => ({ id_clinica: row.clinica_id, rol_clinica: 'doctor',
        subrol_clinica: 'doctor', Clinica: { id_clinica: row.clinica_id, nombre_clinica: 'Clínica ficticia' } })),
    },
    DoctorBloqueo: { findAll: async () => state.blocks, findOne: async query => { const row = state.blocks.find(value => matches(value, query.where)); return row ? { ...row, update: async function(fields, options) { assert.equal(options.transaction, tx); Object.assign(row, fields); Object.assign(this, fields); return this; } } : null; }, create: async (fields, options) => { assert.equal(options.transaction, tx); const row = { id: state.nextId++, ...fields }; state.blocks.push(row); return row; } },
    CitaPaciente: { findAll: async query => { calls.reads.push(query); return state.appointments.filter(row => matches(row, query.where)).slice(0, query.limit || Infinity); } },
    AppointmentBookingOccupancy: { findAll: async query => state.phases.filter(row => matches(row, query.where)
      && (!query.include?.[0]?.where || matches(state.appointments.find(appointment => appointment.id_cita === row.appointment_id), query.include[0].where)))
      .slice(0, query.limit || Infinity).map(row => ({ ...row, appointment: state.appointments.find(appointment => appointment.id_cita === row.appointment_id) })) },
    DoctorBloqueoExcepcion: {}, Paciente: {}, Instalacion: {}, Tratamiento: {},
  };
  const withCalendarMutation = async options => {
    calls.transactions++; assert.equal(options.protectLegacyAppointments, true); calls.scopes.push(options.doctorIds || [options.doctorId]);
    const before = structuredClone(state);
    try {
      if (realCoverageGuard) {
        const actual = require('../../services/appointmentCalendarMutation.service');
        models.Sequelize = { Op };
        models.AppointmentBookingResource = { upsert: async () => {}, findByPk: async () => ({}) };
        return await actual.withCalendarMutation({ ...options, enabled: bookingEnabled, transaction: tx,
          now: new Date('2027-01-01T00:00:00Z'), realtimeEnabled: false, notify: async () => {} });
      }
      const value = await options.mutate(tx);
      return emitUndoReceipt ? { value, undo: { token: 'A'.repeat(43), expires_at: '2027-01-01T00:00:20.000Z', label: 'Cambio de disponibilidad' } } : value;
    }
    catch (error) { state = before; calls.rollback++; throw error; }
  };
  const imports = {
    sequelize: { Op, fn: () => {}, col: () => {}, where: () => {} }, '../../models': models, bcryptjs: {},
    '../lib/role-helpers': { ADMIN_USER_IDS: [1], STAFF_ROLES: ['doctor', 'propietario'], ADMIN_ROLES: ['propietario'], INVITABLE_ROLES: ['doctor'],
      ROLES_CLINICA: ['doctor', 'propietario'], SUBROLES_CLINICA: ['doctor'], ESTADO_CUENTA: ['activa'], ESTADO_INVITACION: ['aceptada'],
      isGlobalAdmin: id => Number(id) === 1, isStaffRole: () => true, isAdminRole: () => true, canManagePersonal: () => true },
    '../lib/access-policy': { canUserAccessFeature: async ({ clinicId }) => Number(clinicId) !== deniedClinic,
      getAccessibleClinicIdsForFeature: async () => [10, 20] },
    '../services/personalPresence.service': {},
    '../services/appointmentCalendarMutation.service': { withCalendarMutation,
      sendCalendarMutationError: (error, res) => { if (!/^booking_calendar_/.test(error?.code || '')) return false;
        res.status(error.status || 409).json({ code: error.code, message: error.message }); return true; } },
    '../lib/personal-schedule-recurring': recurring, '../lib/availability-calendar': calendar,
    '../services/personalCalendarUndo.service': require('../../services/personalCalendarUndo.service'),
    '../services/treatmentBookingProfile.service': { bookingCapabilities: () => ({ simple: bookingEnabled }) },
    '../services/appointmentResourceCalendar.service': { resourceAppointments: async ({ doctorId, start, end }) => bookingEnabled
      ? state.phases.filter(row => row.doctor_id === doctorId && new Date(row.start_at) < end && new Date(row.end_at) > start)
        .map(row => ({ id_cita: row.appointment_id, clinica_id: state.appointments.find(a => a.id_cita === row.appointment_id).clinica_id,
          doctor_id: row.doctor_id, inicio: row.start_at, fin: row.end_at, segmented: true }))
      : state.appointments.filter(row => row.doctor_id === doctorId && new Date(row.inicio) < end && new Date(row.fin) > start) },
    crypto: require('node:crypto'),
  };
  const sandbox = vm.createContext({ exports: {}, require: id => { if (!Object.hasOwn(imports, id)) throw Error(`Unexpected import ${id}`); return imports[id]; },
    process: { env: {} }, console: { error: (...args) => { calls.errors = (calls.errors || []).concat(args.map(String)); } }, Buffer, URL, Date });
  const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/personal.controller.js'), 'utf8');
  vm.runInContext(source + '\nexports.helpers = { buildPersonalBlockRange, buildDateTime, buildImpactIntervalsFromBody, findAppointmentsForImpact, expandBloqueoForRange };', sandbox);
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = plain(body); return this; } });
  return { state: () => state, models, calls, helpers: sandbox.exports.helpers,
    call: async (handler, body, params = { id: '3', clinicaId: '20' }, actor = 1) => {
      const res = response(); await sandbox.exports[handler]({ userData: { userId: actor }, params, body, query: { from: '2027-01-04', to: '2027-02-03' } }, res); return res;
    } };
}
const copyBody = { source_doctor_id: 2, source_horario_id: 100, source_clinica_id: 10, to_clinica_id: 20 };
const moveBody = { horario_id: 100, from_clinica_id: 10, to_clinica_id: 20, to_doctor_id: 3 };

test('copy preserves bounded recurrence and both canceled and overridden exceptions', async () => {
  const f = fixture(); const result = await f.call('copyHorarioClinica', copyBody);
  assert.equal(result.statusCode, 201, JSON.stringify(result));
  const row = result.body.copied.horario;
  assert.equal(row.rrule, f.state().schedules[0].rrule); assert.equal(row.fecha_inicio_vigencia, '2027-01-04');
  assert.equal(row.fecha_fin_vigencia, '2027-02-01'); assert.equal(row.excepciones.length, 2);
  const map = recurring.buildHorarioExceptionMap(row.excepciones);
  assert.equal(recurring.expandHorariosForDate([row], '2027-01-18', map).length, 0);
  assert.equal(recurring.expandHorariosForDate([row], '2027-02-01', map)[0].hora_inicio, '10:00');
  assert.equal(recurring.matchesHorarioOnDate(row, '2027-01-11'), false);
  assert.equal(recurring.matchesHorarioOnDate(row, '2027-02-08'), false);
  assert.equal(f.calls.transactions, 1); assert.deepEqual(plain(f.calls.scopes), [[2, 3]]);
});
test('bulk copies every real source ID once and rolls back all copies on a later conflict', async () => {
  const f = fixture(); const body = { ...copyBody, source_horario_ids: [100, 101] }; delete body.source_horario_id;
  let result = await f.call('copyHorarioClinica', body); assert.equal(result.statusCode, 201, JSON.stringify(result));
  assert.equal(result.body.copied.horarios.length, 2); assert.deepEqual(result.body.copied.source_horario_ids, [100, 101]);
  assert.equal(f.calls.transactions, 1);
  const failing = fixture(); failing.state().schedules.push({ id: 120, doctor_clinica_id: 302, dia_semana: 3,
    hora_inicio: '15:00', hora_fin: '17:00', activo: true, rrule: null, fecha_inicio_vigencia: null, fecha_fin_vigencia: null });
  const before = plain(failing.state()); result = await failing.call('copyHorarioClinica', body);
  assert.equal(result.statusCode, 409, JSON.stringify(result)); assert.equal(result.body.code, 'STAFF_SCHEDULE_OVERLAP_SAME_CLINIC');
  assert.deepEqual(plain(failing.state()), before); assert.equal(failing.calls.rollback, 1);
});
test('bulk cannot smuggle a source ID from another clinic and invalid ID zero fails before a transaction', async () => {
  const f = fixture(); const before = plain(f.state());
  let result = await f.call('copyHorarioClinica', { ...copyBody, source_horario_ids: [100, 999] });
  assert.equal(result.statusCode, 404); assert.deepEqual(plain(f.state()), before);
  result = await f.call('copyHorarioClinica', { ...copyBody, source_horario_id: 0 }); assert.equal(result.statusCode, 400);
});
test('pattern move across professionals updates the same ID and retains every exception in one transaction', async () => {
  const f = fixture(); const result = await f.call('moveHorarioClinica', moveBody, { id: '2' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.moved.scope, 'pattern');
  assert.equal(result.body.moved.horario.id, 100); assert.equal(result.body.moved.horario.doctor_clinica_id, 302);
  assert.equal(result.body.moved.horario.excepciones.length, 2); assert.equal(f.state().schedules.length, 2);
  assert.deepEqual(plain(f.calls.scopes), [[2, 3]]); assert.equal(f.calls.transactions, 1);
});
test('occurrence move cancels only its source date and creates a single dated target', async () => {
  const f = fixture(); const result = await f.call('moveHorarioClinica', { ...moveBody, source_fecha: '2027-01-04', target_fecha: '2027-01-05' }, { id: '2' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); const target = result.body.moved.horario;
  assert.equal(target.rrule, null); assert.equal(target.fecha_inicio_vigencia, '2027-01-05'); assert.equal(target.fecha_fin_vigencia, '2027-01-05');
  assert.equal(target.dia_semana, 2); assert.equal(f.state().schedules.find(row => row.id === 100).doctor_clinica_id, 201);
  assert.equal(f.state().exceptions.find(row => row.doctor_horario_id === 100 && row.fecha === '2027-01-04').cancelado, true);
  assert.equal(recurring.matchesHorarioOnDate(target, '2027-01-12'), false);
});
test('a conflicting occurrence target rolls back the source cancellation and rejects expired/canceled source dates', async () => {
  const f = fixture(); f.state().schedules.push({ id: 120, doctor_clinica_id: 302, dia_semana: 2, hora_inicio: '10:00', hora_fin: '12:00', activo: true,
    rrule: null, fecha_inicio_vigencia: null, fecha_fin_vigencia: null }); const before = plain(f.state());
  let result = await f.call('moveHorarioClinica', { ...moveBody, source_fecha: '2027-01-04', target_fecha: '2027-01-05' }, { id: '2' });
  assert.equal(result.statusCode, 409, JSON.stringify(result)); assert.deepEqual(plain(f.state()), before);
  for (const source_fecha of ['2027-01-18', '2027-02-08']) {
    result = await f.call('moveHorarioClinica', { ...moveBody, source_fecha, target_fecha: '2027-01-05' }, { id: '2' });
    assert.equal(result.statusCode, 422); assert.equal(result.body.code, 'INVALID_SOURCE_SCHEDULE_OCCURRENCE');
  }
});
test('transfers require destination permissions and paired dates', async () => {
  const f = fixture({ deniedClinic: 20 }); let result = await f.call('moveHorarioClinica', moveBody, { id: '2' }, 99);
  assert.equal(result.statusCode, 403); assert.equal(f.calls.transactions, 0);
  result = await f.call('moveHorarioClinica', { ...moveBody, source_fecha: '2027-01-04' }, { id: '2' }); assert.equal(result.statusCode, 400);
});
test('PUT retains IDs and exceptions, creates new rows, and deletes only omitted rows', async () => {
  const f = fixture(); const result = await f.call('updateHorariosClinica', [{ id: 100, hora_fin: '14:00' },
    { dia_semana: 2, hora_inicio: '09:00', hora_fin: '13:00' }], { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); const retained = result.body.find(row => row.id === 100);
  assert.equal(retained.excepciones.length, 2); assert.equal(retained.rrule, 'FREQ=WEEKLY;INTERVAL=2;COUNT=3');
  assert.equal(retained.hora_fin, '14:00'); assert.equal(f.state().schedules.some(row => row.id === 101), false); assert.equal(f.state().schedules.length, 2);
});
test('PUT rejects IDs outside its own pivot and rolls back the complete set on a conflict', async () => {
  const f = fixture(); const before = plain(f.state()); let result = await f.call('updateHorariosClinica', [{ id: 100 }], { id: '3', clinicaId: '20' });
  assert.equal(result.statusCode, 404); assert.deepEqual(plain(f.state()), before);
  result = await f.call('updateHorariosClinica', [{ id: 100 }, { dia_semana: 1, hora_inicio: '10:00', hora_fin: '12:00' }], { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 409, JSON.stringify(result)); assert.deepEqual(plain(f.state()), before);
});
test('removed intervals never extend outside the original or duplicate disjoint movement', () => {
  assert.deepEqual(recurring.removedHorarioIntervals('09:00', '13:00', '15:00', '18:00'), [{ start: '09:00', end: '13:00' }]);
  assert.deepEqual(recurring.removedHorarioIntervals('09:00', '13:00', '06:00', '08:00'), [{ start: '09:00', end: '13:00' }]);
  assert.deepEqual(recurring.removedHorarioIntervals('09:00', '13:00', '10:00', '12:00'), [{ start: '09:00', end: '10:00' }, { start: '12:00', end: '13:00' }]);
  assert.deepEqual(recurring.removedHorarioIntervals('09:00', '13:00', '08:00', '14:00'), []);
});
test('all-day and multiday dates persist exclusive local midnight across DST and Canary timezone', () => {
  const f = fixture(); let range = f.helpers.buildPersonalBlockRange({ all_day: true, fecha_inicio: '2026-10-25', fecha_fin: '2026-10-25' }, 'Europe/Madrid');
  assert.equal(range.start.toISOString(), '2026-10-24T22:00:00.000Z'); assert.equal(range.end.toISOString(), '2026-10-25T23:00:00.000Z');
  assert.equal((range.end - range.start) / 3600000, 25);
  const legacy = f.helpers.buildPersonalBlockRange({ fecha_inicio: '2026-10-25', fecha_fin: '2026-10-25', hora_inicio: null, hora_fin: null }, 'Europe/Madrid');
  assert.equal(legacy.start.toISOString(), range.start.toISOString()); assert.equal(legacy.end.toISOString(), range.end.toISOString());
  range = f.helpers.buildPersonalBlockRange({ all_day: true, fecha_inicio: '2026-10-24', fecha_fin: '2026-10-26' }, 'Atlantic/Canary');
  assert.equal(range.start.toISOString(), '2026-10-23T23:00:00.000Z'); assert.equal(range.end.toISOString(), '2026-10-27T00:00:00.000Z');
  assert.equal(f.helpers.buildDateTime('2026-10-25', null, '23:59', 'Europe/Madrid').toISOString(), '2026-10-25T22:59:00.000Z');
  assert.equal(recurring.normalizeDateOnly('2026-02-30'), null);
});
test('daily projection covers the final minute of full-day and multiday blocks', () => {
  const rows = calendar.buildDoctorBloqueoRowsForDate([{ fecha_inicio: new Date('2026-10-24T22:00:00Z'), fecha_fin: new Date('2026-10-26T23:00:00Z'), recurrente: 'none' }], '2026-10-25', 'Europe/Madrid');
  assert.equal(rows[0].fecha_inicio.toISOString(), '2026-10-24T22:00:00.000Z'); assert.equal(rows[0].fecha_fin.toISOString(), '2026-10-25T23:00:00.000Z');
  assert.equal(calendar.buildDoctorBloqueoRowsForDate([{ fecha_inicio: new Date('2026-10-24T22:00:00Z'), fecha_fin: new Date('2026-10-25T23:00:00Z'), recurrente: 'none' }], '2026-10-26', 'Europe/Madrid').length, 0);
});
function appointment(f) {
  f.state().appointments.push({ id_cita: 500, clinica_id: 10, doctor_id: 3, inicio: '2027-01-04T09:00:00Z', fin: '2027-01-04T10:00:00Z', estado: 'confirmada' });
  f.state().phases.push({ appointment_id: 500, resource_key: 'doctor:2', doctor_id: 2, start_at: '2027-01-04T09:00:00Z', end_at: '2027-01-04T09:20:00Z' });
}
test('impact returns full 60-minute appointment bounds and separate affected 20-minute phase', async () => {
  const f = fixture(); appointment(f); const result = await f.call('previewHorarioImpact', { action: 'resize_shift', fecha: '2027-01-04', original_start: '09:00', original_end: '13:00', next_start: '11:00', next_end: '13:00' }, { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.clinic_timezone, 'Europe/Madrid');
  const row = result.body.appointments[0]; assert.equal(row.duration_minutes, 60); assert.equal(row.inicio, '2027-01-04T09:00:00Z'); assert.equal(row.fin, '2027-01-04T10:00:00Z');
  assert.equal(row.hora_inicio, '10:00'); assert.equal(row.hora_fin, '11:00'); assert.equal(row.affected_phases[0].fin, '2027-01-04T09:20:00Z');
});
test('impact extension has no affected appointments and disjoint move cannot include a booking outside the old shift', async () => {
  const f = fixture(); appointment(f); const result = await f.call('previewHorarioImpact', { action: 'resize_shift', fecha: '2027-01-04', original_start: '09:00', original_end: '13:00', next_start: '08:00', next_end: '14:00' }, { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.affected_count, 0);
  assert.deepEqual(plain(f.helpers.buildImpactIntervalsFromBody({ action: 'move_shift', fecha: '2027-01-04', original_start: '09:00', original_end: '13:00', next_start: '15:00', next_end: '18:00' })),
    [{ fecha: '2027-01-04', start: '09:00', end: '13:00', reason: 'removed_shift_time' }]);
});
test('row deletion preview reviews future resource phases beyond the visible week and exposes clinic timezone', async () => {
  const f = fixture(); appointment(f); const result = await f.call('previewHorarioImpact', { action: 'delete_row' }, { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.scope, 'row'); assert.equal(result.body.affected_count, 1);
  assert.equal(result.body.appointments[0].duration_minutes, 60); assert.equal(result.body.appointments[0].affected_phases[0].doctor_id, 2);
  assert.equal(result.body.clinic_timezone, 'Europe/Madrid');
});
test('row deletion preview rejects more than 2000 rows with bounded review instead of truncating', async () => {
  const f = fixture({ bookingEnabled: false }); f.state().appointments = Array.from({ length: 2001 }, (_, i) => ({ id_cita: i + 1, clinica_id: 10, doctor_id: 2,
    inicio: '2027-01-04T09:00:00Z', fin: '2027-01-04T10:00:00Z', estado: 'confirmada' }));
  const result = await f.call('previewHorarioImpact', { action: 'delete_row' }, { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 409); assert.equal(result.body.code, 'booking_calendar_review_required'); assert.equal(result.body.review_required, true);
});
test('schedule response exposes the exact timezone for each clinic', async () => {
  const f = fixture(); const result = await f.call('getScheduleForPersonal', {}, { id: '2' });
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(result.body.clinicas.find(row => row.clinica_id === 10).timezone, 'Europe/Madrid');
  assert.equal(result.body.clinicas.find(row => row.clinica_id === 20).timezone, 'Atlantic/Canary');
});

test('copy validates exception override hours against destination opening and rolls back every copied row', async () => {
  const f = fixture(); const override = f.state().exceptions.find(row => row.id === 901);
  override.hora_inicio_override = '21:00'; override.hora_fin_override = '23:30'; const before = plain(f.state());
  const result = await f.call('copyHorarioClinica', copyBody);
  assert.equal(result.statusCode, 422, JSON.stringify(result)); assert.equal(result.body.code, 'SCHEDULE_OUT_OF_EFFECTIVE_AVAILABILITY');
  assert.deepEqual(plain(f.state()), before);
});

test('all-day create and edit expose inclusive dates without extending a reopened block', async () => {
  const f = fixture(); const body = { clinica_id: 20, all_day: true, fecha_inicio: '2026-10-25', fecha_fin: '2026-10-26', tipo: 'vacaciones' };
  let result = await f.call('createPersonalBloqueo', body, { id: '2' });
  assert.equal(result.statusCode, 201, JSON.stringify(result)); assert.equal(result.body.timezone, 'Atlantic/Canary');
  assert.equal(result.body.all_day, true); assert.equal(result.body.fecha_fin_dia, '2026-10-26');
  const blockId = result.body.id, originalEnd = result.body.fecha_fin;
  result = await f.call('updatePersonalBloqueo', body, { id: '2', bloqueoId: String(blockId) });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.fecha_fin, originalEnd);
  assert.equal(result.body.fecha_fin_dia, '2026-10-26');
});
test('clinic-scoped blocking ignores another clinic phase, while a global block still rejects it', async () => {
  const f = fixture(); appointment(f); const body = { clinica_id: 20, all_day: true, fecha_inicio: '2027-01-04', fecha_fin: '2027-01-04', tipo: 'vacaciones' };
  let result = await f.call('createPersonalBloqueo', body, { id: '2' }); assert.equal(result.statusCode, 201, JSON.stringify(result));
  delete body.clinica_id;
  result = await f.call('createPersonalBloqueo', body, { id: '2' }); assert.equal(result.statusCode, 409); assert.equal(result.body.reason, 'STAFF_HAS_APPOINTMENTS');
});

test('recurring all-day and multi-day blocks agree across calendar and Personal projections', () => {
  const f = fixture();
  const make = (start, end, recurrente) => ({ id: 7, doctor_id: 2, clinica_id: 10,
    fecha_inicio: calendar.localDateTimeToUtc(start, '00:00', 'Europe/Madrid'),
    fecha_fin: calendar.localDateTimeToUtc(end, '00:00', 'Europe/Madrid'), recurrente });
  for (const recurrence of ['daily', 'weekly', 'monthly']) {
    const block = make('2027-01-04', '2027-01-06', recurrence);
    const anchor = recurrence === 'monthly' ? '2027-02-04' : '2027-01-11';
    for (const date of [anchor, recurring.addDays(anchor, 1)]) {
      const projected = calendar.buildDoctorBloqueoRowsForDate([block], date, 'Europe/Madrid');
      assert.equal(projected.length, 1, `${recurrence} ${date}`);
      assert.equal(calendar.formatLocal(projected[0].fecha_inicio, 'Europe/Madrid'), `${date}T00:00`);
      assert.equal(calendar.formatLocal(projected[0].fecha_fin, 'Europe/Madrid'), `${recurring.addDays(date, 1)}T00:00`);
      const personal = f.helpers.expandBloqueoForRange(block, date, date, 'Europe/Madrid');
      assert.equal(personal.length, 1); assert.equal(personal[0].hora_inicio, '00:00'); assert.equal(personal[0].hora_fin, '24:00');
    }
  }
  const weekly = make('2027-01-04', '2027-01-06', 'weekly');
  assert.equal(calendar.buildDoctorBloqueoRowsForDate([weekly], '2027-01-13', 'Europe/Madrid').length, 0);
  weekly.excepciones = [{ fecha: '2027-01-12', cancelado: true }];
  assert.equal(calendar.buildDoctorBloqueoRowsForDate([weekly], '2027-01-12', 'Europe/Madrid').length, 0);
  const dst = make('2026-10-18', '2026-10-19', 'weekly');
  const sunday = calendar.buildDoctorBloqueoRowsForDate([dst], '2026-10-25', 'Europe/Madrid');
  assert.equal(sunday[0].fecha_fin - sunday[0].fecha_inicio, 25 * 3600000);
});
test('recurring partial multi-day blocks clip interior days and skip impossible monthly anchors', () => {
  const block = { id: 8, doctor_id: 2, fecha_inicio: calendar.localDateTimeToUtc('2027-01-31', '22:00', 'Europe/Madrid'),
    fecha_fin: calendar.localDateTimeToUtc('2027-02-02', '03:00', 'Europe/Madrid'), recurrente: 'monthly' };
  assert.equal(calendar.buildDoctorBloqueoRowsForDate([block], '2027-02-28', 'Europe/Madrid').length, 0);
  const march = calendar.buildDoctorBloqueoRowsForDate([block], '2027-04-01', 'Europe/Madrid');
  assert.equal(calendar.formatLocal(march[0].fecha_inicio, 'Europe/Madrid'), '2027-04-01T00:00');
  assert.equal(calendar.formatLocal(march[0].fecha_fin, 'Europe/Madrid'), '2027-04-02T00:00');
  const end = calendar.buildDoctorBloqueoRowsForDate([block], '2027-04-02', 'Europe/Madrid');
  assert.equal(calendar.formatLocal(end[0].fecha_fin, 'Europe/Madrid'), '2027-04-02T03:00');
});

test('recurring multiday block preview reviews future interior-day phases beyond the first occurrence', async () => {
  const f = fixture();
  f.state().appointments.push({ id_cita: 77, doctor_id: 3, clinica_id: 10, estado: 'confirmada',
    inicio: '2027-02-09T09:00:00Z', fin: '2027-02-09T10:00:00Z', Paciente: { nombre: 'Paciente ficticio' } });
  f.state().phases.push({ appointment_id: 77, resource_key: 'doctor:2', doctor_id: 2,
    start_at: '2027-02-09T09:20:00Z', end_at: '2027-02-09T09:40:00Z' });
  const result = await f.call('previewHorarioImpact', { action: 'block', all_day: true,
    fecha_inicio: '2027-01-04', fecha_fin: '2027-01-05', recurrente: 'weekly' }, { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.affected_count, 1);
  assert.equal(new Date(result.body.appointments[0].inicio).toISOString(), '2027-02-09T09:00:00.000Z');
  assert.equal(new Date(result.body.appointments[0].affected_phases[0].inicio).toISOString(), '2027-02-09T09:20:00.000Z');
});

const mergeBody = { keep_horario_id: 100, delete_horario_id: 102, clinica_id: 10, hora_inicio: '09:00', hora_fin: '15:00' };
function addMergePartner(f, { differentRecurrence = false } = {}) {
  f.state().schedules.push({ ...f.state().schedules[0], id: 102, hora_inicio: '13:00', hora_fin: '15:00',
    ...(differentRecurrence ? { rrule: null } : {}) });
}
function addMergeBooking(f, { date = '2027-01-04', ledger = true } = {}) {
  f.state().appointments.push({ id_cita: 88, doctor_id: 2, clinica_id: 10, estado: 'confirmada',
    inicio: `${date}T11:30:00Z`, fin: `${date}T13:30:00Z` });
  if (ledger) f.state().phases.push({ appointment_id: 88, resource_key: 'doctor:2', doctor_id: 2,
    start_at: `${date}T12:30:00Z`, end_at: `${date}T13:00:00Z` });
}
test('atomic pattern merge preserves ledger and legacy appointment coverage without an intermediate deletion', async () => {
  for (const bookingEnabled of [true, false]) {
    const f = fixture({ realCoverageGuard: true, bookingEnabled }); addMergePartner(f); addMergeBooking(f, { ledger: bookingEnabled });
    f.state().exceptions.push(...f.state().exceptions.map(row => ({ ...row, id: row.id + 10, doctor_horario_id: 102 })));
    const result = await f.call('mergeHorariosClinica', mergeBody, { id: '2' });
    assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.merged.scope, 'pattern');
    assert.equal(f.state().schedules.find(row => row.id === 100).hora_fin, '15:00');
    assert.equal(f.state().schedules.some(row => row.id === 102), false);
    assert.equal(f.state().appointments[0].inicio, '2027-01-04T11:30:00Z');
    assert.equal(f.state().appointments[0].fin, '2027-01-04T13:30:00Z'); assert.equal(f.calls.transactions, 1);
  }
});
test('dated merge uses effective exception ranges and preserves RRULE, every other date and booked visits', async () => {
  const f = fixture({ realCoverageGuard: true }); addMergePartner(f, { differentRecurrence: true });
  f.state().exceptions.push({ id: 902, doctor_horario_id: 102, fecha: '2027-02-01', cancelado: false,
    hora_inicio_override: '12:00', hora_fin_override: '15:00' });
  addMergeBooking(f, { date: '2027-02-01' }); const before = plain(f.state().schedules);
  const result = await f.call('mergeHorariosClinica', { ...mergeBody, fecha: '2027-02-01', hora_inicio: '10:00' }, { id: '2' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.merged.scope, 'occurrence');
  assert.deepEqual(plain(f.state().schedules), before);
  const map = recurring.buildHorarioExceptionMap(f.state().exceptions);
  const merged = recurring.expandHorariosForDate(f.state().schedules, '2027-02-01', map);
  assert.deepEqual(merged.filter(row => row.horario_id === 100 || row.horario_id === 102).map(row =>
    [row.horario_id, row.hora_inicio, row.hora_fin]), [[100, '10:00', '15:00']]);
  assert.equal(recurring.expandHorariosForDate(f.state().schedules, '2027-01-04', map).filter(row => row.horario_id === 100 || row.horario_id === 102).length, 2);
  assert.equal(f.state().appointments[0].fin, '2027-02-01T13:30:00Z'); assert.equal(f.calls.transactions, 1);
});
test('a failed second merge write rolls back the kept override and every source exception', async () => {
  const f = fixture({ realCoverageGuard: true }); addMergePartner(f); const before = plain(f.state());
  const upsert = f.models.DoctorHorarioExcepcion.upsert;
  f.models.DoctorHorarioExcepcion.upsert = async (fields, options) => {
    if (fields.doctor_horario_id === 102) throw Error('synthetic second write failed');
    return upsert(fields, options);
  };
  const result = await f.call('mergeHorariosClinica', { ...mergeBody, fecha: '2027-01-04' }, { id: '2' });
  assert.equal(result.statusCode, 500); assert.deepEqual(plain(f.state()), before); assert.equal(f.calls.rollback, 1);
});
test('merge rejects gaps, recuts, incompatible patterns, canceled dates, foreign scope and permissions without a write', async () => {
  const cases = [
    { change: f => { addMergePartner(f); f.state().schedules.find(row => row.id === 102).hora_inicio = '14:00'; }, body: { ...mergeBody, fecha: '2027-01-04' }, code: 'INVALID_SCHEDULE_MERGE_RANGE', status: 422 },
    { change: f => addMergePartner(f), body: { ...mergeBody, fecha: '2027-01-04', hora_fin: '14:00' }, code: 'INVALID_SCHEDULE_MERGE_RANGE', status: 422 },
    { change: f => addMergePartner(f, { differentRecurrence: true }), body: mergeBody, code: 'INCOMPATIBLE_SCHEDULE_MERGE_PATTERNS', status: 422 },
    { change: f => addMergePartner(f), body: { ...mergeBody, fecha: '2027-01-18' }, code: 'INVALID_SOURCE_SCHEDULE_OCCURRENCE', status: 422 },
    { change: f => { addMergePartner(f); f.state().schedules.find(row => row.id === 102).doctor_clinica_id = 202; }, body: mergeBody, status: 404 },
  ];
  for (const item of cases) {
    const f = fixture(); item.change(f); const before = plain(f.state());
    const result = await f.call('mergeHorariosClinica', item.body, { id: '2' });
    assert.equal(result.statusCode, item.status, JSON.stringify(result)); if (item.code) assert.equal(result.body.code, item.code);
    assert.deepEqual(plain(f.state()), before); assert.equal(f.calls.writes, 0);
  }
  const denied = fixture({ deniedClinic: 10 }); addMergePartner(denied);
  const result = await denied.call('mergeHorariosClinica', { ...mergeBody, fecha: '2027-01-04' }, { id: '2' }, 2);
  assert.equal(result.statusCode, 403); assert.equal(denied.calls.transactions, 0);
});
test('final candidate overlap rejects an atomic merge while preserving both source schedules', async () => {
  const f = fixture({ realCoverageGuard: true }); addMergePartner(f);
  f.state().schedules.push({ ...f.state().schedules[0], id: 103, doctor_clinica_id: 202, hora_inicio: '14:00', hora_fin: '16:00' });
  const before = plain(f.state()); const result = await f.call('mergeHorariosClinica', { ...mergeBody, fecha: '2027-01-04' }, { id: '2' });
  assert.equal(result.statusCode, 409, JSON.stringify(result)); assert.equal(result.body.code, 'STAFF_SCHEDULE_OVERLAP_OTHER_CLINIC');
  assert.deepEqual(plain(f.state()), before); assert.equal(f.calls.writes, 0);
});

test('block recurrence until is validated, serialized, preserved by PATCH and explicit null clears it', async () => {
  const f = fixture();
  const body = { clinica_id: 10, fecha_inicio: '2027-01-04', fecha_fin: '2027-01-04', all_day: true,
    tipo: 'ausencia', recurrente: 'weekly', recurrente_hasta: '2027-01-18' };
  let result = await f.call('createPersonalBloqueo', body, { id: '2' });
  assert.equal(result.statusCode, 201, JSON.stringify(result)); assert.equal(result.body.recurrente_hasta, '2027-01-18');
  const id = result.body.id;
  result = await f.call('updatePersonalBloqueo', { motivo: 'Ficticio' }, { id: '2', bloqueoId: String(id) });
  assert.equal(result.statusCode, 200); assert.equal(result.body.recurrente_hasta, '2027-01-18');
  result = await f.call('updatePersonalBloqueo', { recurrente_hasta: null }, { id: '2', bloqueoId: String(id) });
  assert.equal(result.statusCode, 200); assert.equal(result.body.recurrente_hasta, null);
  for (const until of ['2027-01-03', '2027-02-30']) {
    const before = plain(f.state()); result = await f.call('createPersonalBloqueo', { ...body, recurrente_hasta: until }, { id: '2' });
    assert.equal(result.statusCode, 400); assert.deepEqual(plain(f.state()), before);
  }
});
test('inclusive recurrence anchor limits apply to daily, weekly, monthly and full duration of the final multi-day block', () => {
  const f = fixture();
  for (const recurrente of ['daily', 'weekly', 'monthly']) {
    const last = recurrente === 'monthly' ? '2027-02-04' : '2027-01-11';
    const block = { id: 40, doctor_id: 2, clinica_id: 10, recurrente, recurrente_hasta: last,
      fecha_inicio: calendar.localDateTimeToUtc('2027-01-04', '00:00', 'Europe/Madrid'),
      fecha_fin: calendar.localDateTimeToUtc('2027-01-06', '00:00', 'Europe/Madrid') };
    assert.equal(calendar.buildDoctorBloqueoRowsForDate([block], last, 'Europe/Madrid').length, 1);
    assert.equal(calendar.buildDoctorBloqueoRowsForDate([block], recurring.addDays(last, 1), 'Europe/Madrid').length, 1);
    assert.equal(calendar.buildDoctorBloqueoRowsForDate([block], recurring.addDays(last, 2), 'Europe/Madrid').length, 0);
    assert.equal(f.helpers.expandBloqueoForRange(block, recurring.addDays(last, 2), recurring.addDays(last, 9), 'Europe/Madrid').length, 0);
  }
});
test('bounded recurring preview ignores appointments after until and still sees the inclusive last occurrence', async () => {
  const f = fixture();
  for (const [id, date] of [[70, '2027-01-11'], [71, '2027-01-18']]) {
    f.state().appointments.push({ id_cita: id, doctor_id: 2, clinica_id: 10, estado: 'confirmada', inicio: `${date}T09:00:00Z`, fin: `${date}T10:00:00Z` });
    f.state().phases.push({ appointment_id: id, doctor_id: 2, resource_key: 'doctor:2', start_at: `${date}T09:00:00Z`, end_at: `${date}T10:00:00Z` });
  }
  const body = { action: 'block', fecha_inicio: '2027-01-04', fecha_fin: '2027-01-04', all_day: true,
    recurrente: 'weekly', recurrente_hasta: '2027-01-11' };
  let result = await f.call('previewHorarioImpact', body, { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.deepEqual(result.body.appointments.map(row => row.id_cita), [70]);
  result = await f.call('previewHorarioImpact', { ...body, recurrente_hasta: '2027-01-01' }, { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 400);
});
test('canonical PUT returns its undo envelope and DELETE returns receipt instead of 204', async () => {
  const f = fixture({ emitUndoReceipt: true });
  let result = await f.call('updateHorariosClinica', { horarios: f.state().schedules.filter(row => row.doctor_clinica_id === 201) }, { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.horarios.length, 2); assert.equal(result.body.undo.token.length, 43);
  result = await f.call('deleteHorarioClinica', {}, { id: '2', clinicaId: '10', horarioId: '100' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.undo.token.length, 43);
});
test('one append-only PUT accepts 366 dated additions and retains existing IDs and their exceptions', async () => {
  const f = fixture();
  const additions = Array.from({ length: 366 }, (_, offset) => {
    const date = recurring.addDays('2028-01-01', offset);
    return { dia_semana: recurring.dayIndexFromDate(date), hora_inicio: '16:00', hora_fin: '17:00', activo: true,
      rrule: null, fecha_inicio_vigencia: date, fecha_fin_vigencia: date };
  });
  const result = await f.call('updateHorariosClinica', { horarios: additions, append_only: true }, { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.length, 368);
  assert.equal(result.body.find(row => row.id === 100).excepciones.length, 2); assert.equal(f.calls.transactions, 1);
});

test('append-only reads the current locked row and preserves a previously committed concurrent addition', async () => {
  const f = fixture({ emitUndoReceipt: true });
  const original = plain(f.state().schedules), exceptions = plain(f.state().exceptions);
  // This row was absent when the client copied its source; it exists by PUT time.
  const concurrent = { id: 999, doctor_clinica_id: 201, dia_semana: 5, activo: true, hora_inicio: '16:00', hora_fin: '17:00', rrule: null };
  f.state().schedules.push(concurrent);
  const result = await f.call('updateHorariosClinica', { append_only: true, horarios: [{ dia_semana: 1, activo: true,
    hora_inicio: '13:00', hora_fin: '14:00', fecha_inicio_vigencia: '2027-01-04', fecha_fin_vigencia: '2027-01-04' }] }, { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.horarios.length, 4);
  assert.ok(result.body.undo?.token); assert.equal(f.calls.transactions, 1);
  assert.deepEqual(plain(f.state().schedules.slice(0, 2)), original);
  assert.deepEqual(plain(f.state().schedules.find(row => row.id === 999)), concurrent);
  assert.deepEqual(plain(f.state().exceptions), exceptions);
});

test('append-only rejects conflicts with the current row and between additions without a partial write', async () => {
  for (const betweenIncoming of [false, true]) {
    const f = fixture(); const before = plain(f.state());
    const first = { dia_semana: 1, activo: true, hora_inicio: '13:00', hora_fin: '14:00', fecha_inicio_vigencia: '2027-01-04', fecha_fin_vigencia: '2027-01-04' };
    const second = betweenIncoming ? { ...first } : { ...first, hora_inicio: '09:00', hora_fin: '10:00' };
    const result = await f.call('updateHorariosClinica', { append_only: true, horarios: [first, second] }, { id: '2', clinicaId: '10' });
    assert.equal(result.statusCode, 409, JSON.stringify(result)); assert.equal(f.calls.rollback, 1);
    assert.deepEqual(plain(f.state()), before);
  }
});

test('append-only rejects supplied IDs, empty additions and non-boolean mode before a transaction', async () => {
  for (const body of [{ append_only: true, horarios: [{ id: 100, dia_semana: 1, hora_inicio: '09:00', hora_fin: '10:00' }] },
    { append_only: true, horarios: [] }, { append_only: 'true', horarios: [] }]) {
    const f = fixture(); const result = await f.call('updateHorariosClinica', body, { id: '2', clinicaId: '10' });
    assert.equal(result.statusCode, 400, JSON.stringify(result)); assert.equal(f.calls.transactions, 0);
  }
});

test('the dedicated append endpoint always appends even when the caller requests replacement', async () => {
  const f = fixture({ emitUndoReceipt: true });
  const result = await f.call('appendHorariosClinica', { append_only: false, horarios: [{ dia_semana: 1, activo: true,
    hora_inicio: '13:00', hora_fin: '14:00', fecha_inicio_vigencia: '2027-01-04', fecha_fin_vigencia: '2027-01-04' }] }, { id: '2', clinicaId: '10' });
  assert.equal(result.statusCode, 200, JSON.stringify(result)); assert.equal(result.body.horarios.length, 3);
  assert.ok(result.body.horarios.find(row => row.id === 100)); assert.equal(result.body.horarios.find(row => row.id === 100).excepciones.length, 2);
  assert.equal(f.calls.transactions, 1);
});
