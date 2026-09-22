'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installationAllowsStaff: allows, normalizeInstallationProfessionals: normalize } = require('../../lib/installation-professionals');
const { solveBookingProfile } = require('../../lib/booking-profile-solver');
const { agendaVisibility, visibilityDates } = require('../../services/agendaVisibility.service');
const free = (ids) => ({ windows: [{ start: '2030-01-07T08:00Z', end: '2030-01-07T18:00Z' }],
  busy: [], profesionales_permitidos: ids });
const profile = (mode = 'any') => ({ version: 1, phases: [{ key: 'one', duration_minutes: 30,
  installation_ids: [9, 10], professionals: { mode, ids: [5, 6], preferred_id: mode === 'any' ? 5 : null } }] });
test('unrestricted compatibility, strict IDs and no anonymous use of restricted rooms', () => {
  assert(allows({}, [])); assert(allows({ profesionales_permitidos: null }, [5]));
  assert.deepEqual(normalize([6, 5, 5]), [5, 6]);
  for (const value of ['5', [0], [-2], ['5'], {}, [NaN]]) assert.throws(() => normalize(value));
  assert(!allows({ profesionales_permitidos: [5] }, []));
  assert(!allows({ profesionales_permitidos: [5] }, [5, 6]));
  assert(!allows({ profesionales_permitidos: 'bad' }, [5]));
});
test('solver finds a compatible cabin/professional pair preserving priority, not first cabin first', () => {
  const args = { profile: profile(), start: '2030-01-07T09:00Z', doctors: new Map([[5, free()], [6, free()]]),
    installations: new Map([[9, free([6])], [10, free([5])]]) };
  const result = solveBookingProfile(args);
  assert.equal(result.phases[0].installation_id, 10); assert.deepEqual(result.phases[0].doctor_ids, [5]);
  const alternative = solveBookingProfile({ ...args, selections: { one: { installation_id: 9 } } });
  assert.deepEqual(alternative.phases[0].doctor_ids, [6]);
  assert.equal(alternative.warnings[0].preferred_available, false);
  assert.equal(alternative.warnings[0].only_available_alternative, true);
  assert.equal(solveBookingProfile({ ...args, profile: profile('all') }), null);
  args.installations.set(10, free([5, 6]));
  assert.equal(solveBookingProfile({ ...args, profile: profile('all') }).phases[0].installation_id, 10);
});
test('visibility dates are strict, deduplicated and bounded', () => {
  assert.deepEqual(visibilityDates('2030-01-08,2030-01-07,2030-01-07'), ['2030-01-07', '2030-01-08']);
  for (const value of ['', '2030-02-31', 'x', Array.from({ length: 15 }, (_, i) => `2030-01-${String(i + 1).padStart(2, '0')}`).join(',')]) {
    assert.throws(() => visibilityDates(value), { status: 400 });
  }
});
test('visibility uses shifts before absences, retains blocks, resolves clinic-room relation in bounded bulk', async () => {
  let queries = 0;
  const read = rows => async () => { queries++; return rows; };
  const db = { Sequelize: { Op: Object.fromEntries(['in', 'and', 'or', 'ne', 'lt', 'gt'].map(key => [key, Symbol(key)])) },
    DoctorClinica: { findAll: read([
      { doctor_id: 5, clinica_id: 72, horarios: [{ dia_semana: 1, activo: true, hora_inicio: '09:00', hora_fin: '17:00' }] },
      { doctor_id: 6, clinica_id: 72, horarios: [] }, { doctor_id: 7, clinica_id: 73, horarios: [] },
    ]) }, DoctorHorario: {}, DoctorHorarioExcepcion: {}, DoctorBloqueoExcepcion: {},
    Clinica: { findAll: read([{ id_clinica: 72, configuracion: { timezone: 'Europe/Madrid' } }]) },
    Instalacion: { findAll: read([{ id: 9, clinica_id: 72, nombre: 'Room', activo: true, profesionales_permitidos: [5] },
      { id: 10, clinica_id: 72, nombre: 'Open', activo: true }]) },
    DoctorBloqueo: { findAll: read([{ id: 1, doctor_id: 6, clinica_id: 72, recurrente: 'none',
      fecha_inicio: new Date('2030-01-07T08:00:00Z'), fecha_fin: new Date('2030-01-07T18:00:00Z') }]) },
  };
  const result = await agendaVisibility({ db, clinicIds: [72, 73], dates: ['2030-01-07', '2030-01-08'] });
  assert.equal(queries, 4);
  assert.deepEqual(result.professionals.map(row => row.visible_dates), [['2030-01-07'], ['2030-01-07'], []]);
  assert.deepEqual(result.installations.map(row => row.professional_ids), [['5'], ['5', '6']]);
  assert.doesNotMatch(JSON.stringify(result), /paciente|email|motivo|horarios|fecha_inicio/);
});
