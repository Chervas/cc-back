'use strict';
// Owned mysqld only: production catalog resolver, HTTP handlers, SQL calendar
// readers and solver. Capability flags affect this disposable process only.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createRequire } = require('node:module');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');

function scopedModule(filename, overrides) {
  const local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console, Date, Map, Set, Promise,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename });
  return module.exports;
}

function patientScopeOnly(db) {
  // Exercise the actual scope implementation without importing the economic
  // module's unrelated messaging/worker dependencies and process timers.
  const filename = require.resolve('../../services/patientEconomics.service');
  const source = fs.readFileSync(filename, 'utf8'), module = { exports: {} };
  const helpers = source.slice(source.indexOf('function positiveInteger('), source.indexOf('function dateOrNull('));
  const scope = source.slice(source.indexOf('async function resolvePatient('), source.indexOf('function normalizeProductType('));
  assert(helpers && scope);
  vm.runInNewContext(helpers + scope + '\nmodule.exports = { loadContext };', { module,
    Paciente: db.Paciente, PacienteClinica: db.PacienteClinica, Clinica: db.Clinica,
    domainError: require('../../lib/treatmentPrograms.contract').domainError }, { filename });
  return module.exports;
}

withIsolatedCampaignMysql(async owned => {
  for (const key of ['TREATMENT_PROGRAM_BOOKING_ENABLED', 'TREATMENT_PROGRAM_ECONOMICS_ENABLED', 'BOOKING_PROFILES_ENABLED',
    'BOOKING_MULTI_RESOURCE_ENABLED', 'BOOKING_PHASE_OFFSETS_ENABLED', 'BOOKING_EQUIPMENT_ENABLED']) process.env[key] = 'true';
  const f = await createOwnedBookingDurationFixture({ sql: owned.sql, models: owned.models,
    nativeCatalogModel: true, includePatientScope: true });
  const { db } = f, { sql, report } = owned, checks = [], acl = [];
  await db.Paciente.create({ id_paciente: 5, clinica_id: 200 });
  db.TreatmentProgram = require('../../../models/treatmentprogram')(sql, S.DataTypes);
  await db.TreatmentProgram.sync();
  const profile = { version: 4, phases: [
    { key: 'late', label: 'Técnica posterior', start_offset_minutes: 15, duration_minutes: 30, installation_ids: [101],
      professionals: { mode: 'any', ids: [2], preferred_id: 2 } },
    { key: 'initial', label: 'Preparación inicial', start_offset_minutes: 0, duration_minutes: 15, installation_ids: [102],
      professionals: { mode: 'any', ids: [1], preferred_id: 1 }, equipment_requirements: [{ equipment_ids: [401] }] },
  ] };
  await db.Tratamiento.create({ id_tratamiento: 30, clinica_id: 100, grupo_clinica_id: 50, origen: 'clinica', activo: true,
    nombre: 'Sesión combinada ficticia', disciplina: 'estetica', precio_base: 100,
    clinical_config: { catalog_status: 'active', booking_profile: profile } });
  const program = await db.TreatmentProgram.create({ public_id: 'owned-catalog-program', clinic_id: 100, name: 'Programa ficticio',
    kind: 'program', status: 'active', total_price: 200, version_number: 3, appointments: [
      { key: 'first', label: 'Primera sesión', offset_days: 0, treatment_ids: [30] },
      { key: 'second', label: 'Segunda sesión', offset_days: 15, treatment_ids: [4] },
    ] });
  const patientEconomics = patientScopeOnly(db);
  let deny = null;
  const controller = scopedModule(require.resolve('../../controllers/disponibilidad.controller'), {
    '../../models': db, 'express-async-handler': fn => fn,
    '../lib/access-policy': { assertUserCanAccessFeature: async args => { acl.push(args); assert.equal(args.clinicId, 100);
      if (args.featureKey === deny) throw Object.assign(Error('Forbidden synthetic permission'), { statusCode: 403 }); },
    getAccessibleClinicIdsForFeature: async () => [100, 200] },
    '../services/patientEconomics.service': patientEconomics,
  });
  const base = { clinica_id: '100', program_id: program.public_id, program_version: '3', duracion_min: '15',
    dates: ['2030-01-07'], fecha_local: '2030-01-07', mode: 'doctor', column_ids: [1], context_instalacion_id: '102',
    doctor_id: '1', instalacion_id: '102', granularity_min: '5', from_local: '10:00', to_local: '11:00', include_unavailable: 'true' };
  async function invoke(handler, extra = {}) {
    const before = await f.counts(), run = sql.query, statements = [];
    sql.query = function (...args) {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.query;
      assert.match(text, /^\s*SELECT\b/i, 'Catalog preview may issue SELECT only'); statements.push(text);
      return run.apply(this, args);
    };
    const headers = {}, response = { statusCode: 200, set(name, value) { headers[name] = value; return this; },
      status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
    const query = { ...base, ...extra };
    for (const key of Object.keys(query)) if (query[key] === undefined) delete query[key];
    try { await controller[handler]({ userData: { userId: 1 }, query }, response); return { ...response, headers, statements }; }
    finally { sql.query = run; assert.deepEqual(await f.counts(), before, 'Preview creates no appointments, occupancies or resource locks'); }
  }
  const at = (result, utc = '2030-01-07T09:00:00.000Z') => (result.body.rows?.[0].slots || result.body.slots || []).some(row => row.start_utc === utc);
  const check = async (label, work) => { await work(); checks.push(label); };
  const rawPeer = (patch = {}) => db.CitaPaciente.create(f.values({ paciente_id: 2, tratamiento_id: null, doctor_id: 2,
    instalacion_id: 101, inicio: '2030-01-07T09:30:00Z', fin: '2030-01-07T10:00:00Z', ...patch }));
  await check('catalog-HTTP-grid/slots/summary-use-45min-whole-V4-visit-and-minimum-offset-first-phase', async () => {
    for (const handler of ['grid', 'slots', 'summary']) {
      const result = await invoke(handler);
      assert.equal(result.statusCode, 200); assert.equal(result.headers['Cache-Control'], 'private, no-store');
      assert.deepEqual(JSON.parse(JSON.stringify(result.body.program_preview)), { program_id: program.public_id, program_version: 3,
        session_key: 'first', position: 1, label: 'Primera sesión', duration_minutes: 45 });
      if (handler === 'summary') assert.equal(result.body.by_day['2030-01-07'], true);
      else { assert.equal(result.body.duracion_min, 45); assert(at(result));
        const slots = result.body.rows?.[0].slots || result.body.slots;
        assert(slots.every(row => Date.parse(row.end_utc) - Date.parse(row.start_utc) === 45 * 60000)); }
    }
  });
  await check('late-phase-alias-occupancy-blocks-a-free-first-phase-and-produces-hover-diagnostics', async () => {
    const peer = await rawPeer({ clinica_id: 200, instalacion_id: 201 });
    try { const result = await invoke('grid'); assert(!at(result));
      assert(result.body.rows[0].unavailable_intervals.some(row => row.resource_conflicts.length)); }
    finally { await peer.destroy(); }
  });
  await check('visible-installation-column-cannot-inherit-another-context-room-availability', async () => {
    const result = await invoke('grid', { mode: 'installation', column_ids: [101, 102], context_doctor_id: '1',
      context_instalacion_id: '102' });
    assert.equal(result.body.rows[0].column_id, '101'); assert.equal(result.body.rows[0].slots.length, 0);
    assert(result.body.rows[0].unavailable_intervals.some(row => row.resource_conflicts.length));
    assert(result.body.rows[1].slots.some(row => row.start_utc === '2030-01-07T09:00:00.000Z'));
  });
  await check('15-minute-opening-never-advertises-full-45-minute-session-in-grid-or-summary', async () => {
    const peer = await rawPeer({ inicio: '2030-01-07T09:15:00Z', fin: '2030-01-07T11:00:00Z' });
    try { assert(!at(await invoke('grid')));
      assert.equal((await invoke('summary')).body.by_day['2030-01-07'], false); }
    finally { await peer.destroy(); }
  });
  await check('shared-machine-turnaround-is-hard-even-when-staff-and-both-rooms-are-free', async () => {
    const peer = await rawPeer({ doctor_id: null, instalacion_id: null, inicio: '2030-01-07T08:45:00Z', fin: '2030-01-07T09:00:00Z' });
    // The canonical writer persists the machine's turnaround in its occupancy,
    // independently of the patient's appointment end.
    const occupancy = await db.AppointmentBookingOccupancy.create({ appointment_id: peer.id_cita, phase_key: 'machine',
      resource_kind: 'equipment', resource_key: 'equipment:401', start_at: '2030-01-07T08:45:00Z', end_at: '2030-01-07T09:10:00Z' });
    try { const result = await invoke('grid'); assert(!at(result));
      assert(at(result, '2030-01-07T09:10:00.000Z'), 'The next start can use the machine after its ten-minute turnaround'); }
    finally { await occupancy.destroy(); await peer.destroy(); }
  });
  await check('vacation-in-late-phase-remains-unavailable-and-diagnostics-do-not-become-forceable', async () => {
    const block = await db.DoctorBloqueo.create({ doctor_id: 2, clinica_id: 100, fecha_inicio: '2030-01-07T09:15:00Z',
      fecha_fin: '2030-01-07T12:00:00Z', tipo: 'vacaciones', recurrente: 'none', motivo: 'Vacaciones ficticias' });
    try { const result = await invoke('grid'); assert(!at(result)); assert.equal((await invoke('summary')).body.by_day['2030-01-07'], false);
      assert(result.body.rows[0].unavailable_intervals.some(row => row.resource_conflicts.length)); }
    finally { await block.destroy(); }
  });
  await check('room-staff-permission-is-checked-in-late-phase', async () => {
    await db.Instalacion.update({ profesionales_permitidos: [1] }, { where: { id: 101 } });
    try { assert(!at(await invoke('grid'))); assert.equal((await invoke('summary')).body.by_day['2030-01-07'], false); }
    finally { await db.Instalacion.update({ profesionales_permitidos: [1, 2] }, { where: { id: 101 } }); }
  });
  await check('patient-is-optional-but-supplied-patient-adds-sensitive-ACL-and-real-busy-intervals', async () => {
    const peer = await rawPeer({ paciente_id: 3, doctor_id: null, instalacion_id: null });
    try { assert(at(await invoke('grid'))); assert(!at(await invoke('grid', { patient_id: '3' })));
      assert(acl.some(row => row.featureKey === 'patients.view')); assert(acl.some(row => row.featureKey === 'patients.sensitive.view'));
      await assert.rejects(invoke('grid', { patient_id: '5' }), { code: 'patient_not_in_clinic', statusCode: 404 });
      deny = 'patients.sensitive.view'; await assert.rejects(invoke('grid', { patient_id: '3' }), { statusCode: 403 });
    } finally { deny = null; await peer.destroy(); }
  });
  await check('program-clinic/version/state-and-session-key-cannot-be-forged-or-stale', async () => {
    await assert.rejects(invoke('grid', { program_version: '2' }), { code: 'program_version_conflict', statusCode: 409 });
    await assert.rejects(invoke('grid', { program_id: 'foreign-program' }), { code: 'program_not_found', statusCode: 404 });
    await assert.rejects(invoke('grid', { program_session_key: 'invented' }), { code: 'program_session_not_found', statusCode: 404 });
    await program.update({ clinic_id: 200 });
    try { await assert.rejects(invoke('grid'), { code: 'program_not_found', statusCode: 404 }); }
    finally { await program.update({ clinic_id: 100 }); }
    await program.update({ status: 'draft' });
    try { await assert.rejects(invoke('summary'), { code: 'program_not_ready', statusCode: 422 }); }
    finally { await program.update({ status: 'active' }); }
  });
  await check('normal-summary/grid-ACL-remains-mandatory-and-unsupported-check-never-falls-back-to-generic', async () => {
    deny = 'appointments.view';
    try { await assert.rejects(invoke('grid'), { statusCode: 403 }); await assert.rejects(invoke('summary'), { statusCode: 403 }); }
    finally { deny = null; }
    await assert.rejects(invoke('check'), { code: 'program_preview_use_grid', statusCode: 400 });
    for (const extra of [{ ignore_cita_id: '1' }, { tratamiento_id: '4' }, { duration_minutes: '15' }]) {
      await assert.rejects(invoke('grid', extra), { code: 'program_preview_invalid', statusCode: 400 });
    }
  });
  report.programCatalogAvailability = { passed: checks.length, checks, sqlIsReal: true, previewDmlStatements: 0,
    limits: ['Synthetic ACL principals; no provider, transport, assignment, patient mutation or actual CRM/DEV SQL'] };
  console.log(JSON.stringify(report.programCatalogAvailability));
});
