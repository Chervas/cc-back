'use strict';
const clone = value => structuredClone(value);
const Op = Object.fromEntries(['in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'ne', 'or', 'and'].map(key => [key, Symbol(key)]));
function matches(row, where = {}) {
  return Reflect.ownKeys(where).every(key => {
    if (key === Op.or) return where[key].some(value => matches(row, value));
    if (key === Op.and) return where[key].every(value => matches(row, value));
    const value = where[key], actual = row[key];
    if (value && typeof value === 'object' && !(value instanceof Date)) return Reflect.ownKeys(value).every(operator => {
      const wanted = value[operator];
      if (operator === Op.in) return wanted.map(String).includes(String(actual));
      if (operator === Op.notIn) return !wanted.map(String).includes(String(actual));
      if (operator === Op.ne) return actual !== wanted;
      const date = wanted instanceof Date;
      const left = date ? new Date(actual).getTime() : actual, right = date ? wanted.getTime() : wanted;
      return operator === Op.gt ? left > right : operator === Op.gte ? left >= right
        : operator === Op.lt ? left < right : operator === Op.lte ? left <= right : false;
    });
    return String(actual) === String(value);
  });
}
function fixture() {
  let state = {
    DoctorClinica: [{ id: 201, doctor_id: 2, clinica_id: 10, activo: true, recibe_citas: true, agenda_flexible: false, allow_overlap_confirmation: false }],
    DoctorHorario: [{ id: 100, doctor_clinica_id: 201, dia_semana: 1, activo: true, hora_inicio: '09:00', hora_fin: '12:00', rrule: null,
      fecha_inicio_vigencia: null, fecha_fin_vigencia: null }],
    DoctorHorarioExcepcion: [], DoctorBloqueo: [], DoctorBloqueoExcepcion: [],
    PersonalCalendarRevision: [], PersonalCalendarUndoReceipt: [], CitaPaciente: [], AppointmentBookingOccupancy: [],
  };
  let ms = Date.parse('2027-01-01T00:00:00Z'), next = 1000;
  const tx = { options: { isolationLevel: 'READ COMMITTED' }, LOCK: { UPDATE: 'UPDATE' } };
  const db = { Sequelize: { Op }, AppointmentBookingResource: { upsert: async () => {}, findByPk: async () => ({}) },
    sequelize: { transaction: async (options, callback) => {
      const before = clone(state); try { return await callback(tx); } catch (error) { state = before; throw error; }
    } },
    Clinica: { findAll: async () => [{ id_clinica: 10, configuracion: { timezone: 'Europe/Madrid' } }] },
    ClinicaHorario: { findAll: async () => Array.from({ length: 7 }, (_, dia_semana) => ({ clinica_id: 10, dia_semana, activo: true, hora_inicio: '07:00', hora_fin: '22:00' })) },
  };
  const included = (table, row, query) => {
    const plain = clone(row);
    if (table === 'DoctorClinica' && query.include) plain.horarios = state.DoctorHorario.filter(schedule => schedule.doctor_clinica_id === row.id)
      .map(schedule => ({ ...clone(schedule), excepciones: state.DoctorHorarioExcepcion.filter(exception => exception.doctor_horario_id === schedule.id).map(clone) }));
    if (table === 'DoctorBloqueo' && query.include) plain.excepciones = state.DoctorBloqueoExcepcion.filter(exception => exception.doctor_bloqueo_id === row.id).map(clone);
    if (table === 'AppointmentBookingOccupancy' && query.include) plain.appointment = clone(state.CitaPaciente.find(appointment => appointment.id_cita === row.appointment_id));
    return query.attributes ? Object.fromEntries(query.attributes.filter(key => Object.hasOwn(plain, key)).map(key => [key, plain[key]])) : plain;
  };
  for (const table of Object.keys(state)) {
    const key = table === 'PersonalCalendarRevision' ? 'doctor_id' : table === 'CitaPaciente' ? 'id_cita' : 'id';
    const wrap = (row, query = {}) => ({ ...included(table, row, query),
      toJSON: () => included(table, row, query),
      update: async (fields, options) => { if (options.transaction !== tx) throw Error('missing owned transaction');
        Object.assign(row, clone(fields)); return wrap(row); },
    });
    db[table] = {
      findAll: async query => state[table].filter(row => matches(row, query.where)
        && (!query.include?.[0]?.where || matches(state.CitaPaciente.find(appointment => appointment.id_cita === row.appointment_id), query.include[0].where)))
        .slice(0, query.limit || Infinity).map(row => wrap(row, query)),
      findOne: async query => { const row = state[table].find(row => matches(row, query.where)); return row ? wrap(row, query) : null; },
      findByPk: async id => { const row = state[table].find(row => String(row[key]) === String(id)); return row ? wrap(row) : null; },
      findOrCreate: async query => { const old = state[table].find(row => matches(row, query.where)); if (old) return [wrap(old), false];
        const row = { ...query.where, ...query.defaults }; state[table].push(row); return [wrap(row), true]; },
      create: async (fields, options) => { if (options.transaction !== tx) throw Error('missing owned transaction');
        const row = { ...(!Object.hasOwn(fields, key) ? { [key]: next++ } : {}), ...clone(fields) }; state[table].push(row); return wrap(row); },
      update: async (fields, query) => { if (query.transaction !== tx) throw Error('missing owned transaction');
        for (const row of state[table].filter(row => matches(row, query.where))) Object.assign(row, clone(fields)); return [1]; },
      destroy: async query => { if (query.transaction !== tx) throw Error('missing owned transaction');
        const removed = state[table].filter(row => matches(row, query.where)); state[table] = state[table].filter(row => !matches(row, query.where));
        if (table === 'DoctorHorario') state.DoctorHorarioExcepcion = state.DoctorHorarioExcepcion.filter(exception => !removed.some(row => row.id === exception.doctor_horario_id));
        if (table === 'DoctorBloqueo') state.DoctorBloqueoExcepcion = state.DoctorBloqueoExcepcion.filter(exception => !removed.some(row => row.id === exception.doctor_bloqueo_id));
        return removed.length; },
    };
  }
  return { db, tx, state: () => state, now: () => new Date(ms), advance: value => { ms += value; },
    options: () => ({ db, doctorId: 2, enabled: true, protectLegacyAppointments: true, now: new Date(ms), realtimeEnabled: false, notify: async () => {} }) };
}
module.exports = { fixture, clone };
