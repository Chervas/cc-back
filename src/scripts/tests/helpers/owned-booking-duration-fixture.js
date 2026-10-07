'use strict';

// Scaffolding for the freshly owned MySQL launcher only. Never imports models'
// application index; actual booking factories/services use the intercepted DB.
const S = require('sequelize');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const nodeHttp = require('node:http');

const capabilities = Object.freeze({ simple: true, multi: true, relativeSteps: true, equipment: true });
const phase = (key = 'care', patch = {}) => ({ key, label: 'Paso sintético', duration_minutes: null,
  installation_ids: [101], professionals: { mode: 'any', ids: [1], preferred_id: 1 }, ...patch });
const profile = (version = 1, phases = [phase()]) => ({ version, phases: phases.map(row => ({ ...row,
  ...(version === 4 ? { start_offset_minutes: row.start_offset_minutes ?? 0 } : {}) })) });

async function createOwnedBookingDurationFixture({ sql, models: db, registerOwnedLoopbackServer, nativeCatalogModel = false }) {
  if (!sql.options.dialectOptions?.socketPath?.startsWith('/tmp/cc-campaign-opt-mysql-')) throw Error('OWNED_BOOKING_SOCKET_REQUIRED');
  const [[storage]] = await sql.query('SELECT @@skip_networking AS isolated, DATABASE() AS name');
  if (Number(storage.isolated) !== 1 || storage.name !== 'campaign_optimization_qa') throw Error('OWNED_BOOKING_DATABASE_REQUIRED');
  const D = S.DataTypes;
  db.Sequelize = S;
  const define = (name, tableName, fields) => db[name] = sql.define(name, fields, { tableName, timestamps: false });
  define('Clinica', 'Clinicas', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER,
    nombre_clinica: D.STRING, configuracion: D.JSON, equipment_booking_enabled: D.BOOLEAN });
  define('Usuario', 'Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true }, nombre: D.STRING, apellidos: D.STRING });
  define('Paciente', 'Pacientes', { id_paciente: { type: D.INTEGER, primaryKey: true } });
  if (nativeCatalogModel) db.Tratamiento = require('../../../../models/tratamiento')(sql, D);
  else define('Tratamiento', 'Tratamientos', { id_tratamiento: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER,
    grupo_clinica_id: D.INTEGER, nombre: D.STRING, origen: D.STRING, activo: D.BOOLEAN, clinical_config: D.JSON });
  for (const file of ['doctorclinica', 'doctorhorario', 'doctorhorarioexcepcion', 'doctorbloqueo', 'doctorbloqueoexcepcion',
    'instalacion', 'instalacionhorario', 'instalacionbloqueo', 'clinicahorario', 'citapaciente',
    'appointmentbookingoccupancy', 'appointmentbookingresource', 'installationphysicalalias',
    'bookingequipment', 'bookingequipmentclinic', 'bookingequipmentroompolicy']) {
    const model = require('../../../../models/' + file)(sql, D);
    db[model.name] = model;
  }
  for (const name of ['DoctorClinica', 'DoctorHorario', 'DoctorHorarioExcepcion', 'DoctorBloqueo', 'DoctorBloqueoExcepcion',
    'Instalacion', 'InstalacionHorario', 'InstalacionBloqueo', 'ClinicaHorario', 'CitaPaciente', 'AppointmentBookingOccupancy', 'BookingEquipment']) {
    db[name].associate?.(db);
  }
  if (nativeCatalogModel) db.Tratamiento.associate(db);
  // Actual factories on a fresh, private database; no production schema sync.
  await sql.sync();
  await db.Clinica.bulkCreate([100, 200].map(id => ({ id_clinica: id, grupoClinicaId: 50,
    nombre_clinica: `Clínica ficticia ${id}`, configuracion: { timezone: 'Europe/Madrid' }, equipment_booking_enabled: true })));
  await db.Usuario.bulkCreate([1, 2].map(id => ({ id_usuario: id, nombre: `Profesional ficticio ${id}`, apellidos: 'Sólo prueba' })));
  await db.Paciente.bulkCreate([1, 2, 3, 4].map(id_paciente => ({ id_paciente })));
  for (const clinica_id of [100, 200]) for (let day = 1; day <= 5; day++) {
    await db.ClinicaHorario.create({ clinica_id, dia_semana: day, activo: true, hora_inicio: '09:00', hora_fin: '20:00' });
  }
  for (const [clinica_id, doctor_id] of [[100, 1], [100, 2], [200, 1], [200, 2]]) {
    const member = await db.DoctorClinica.create({ clinica_id, doctor_id, activo: true, recibe_citas: true });
    for (let day = 1; day <= 5; day++) await db.DoctorHorario.create({ doctor_clinica_id: member.id,
      dia_semana: day, activo: true, hora_inicio: '09:00', hora_fin: '20:00' });
  }
  for (const [id, clinica_id] of [[101, 100], [102, 100], [201, 200]]) {
    await db.Instalacion.create({ id, clinica_id, nombre: `Sala ficticia ${id}`, profesionales_permitidos: [1, 2], activo: true });
    for (let day = 1; day <= 5; day++) await db.InstalacionHorario.create({ instalacion_id: id,
      dia_semana: day, activo: true, hora_inicio: '09:00', hora_fin: '20:00' });
  }
  await db.InstallationPhysicalAlias.create({ installation_id: 201, canonical_installation_id: 101, group_id: 50 });
  await db.BookingEquipment.create({ id: 401, owner_clinic_id: 100, group_id: 50, name: 'Unidad móvil sintética',
    family_key: 'owned_fixture_unit', mobility: 'mobile', status: 'available', turnaround_minutes: 10 });
  await db.BookingEquipmentClinic.bulkCreate([100, 200].map(clinic_id => ({ equipment_id: 401, clinic_id })));
  await db.BookingEquipmentRoomPolicy.bulkCreate([101, 102].map(installation_id => ({ installation_id, mode: 'selected', equipment_ids: [401] })));
  const profiles = [
    [1, 100, profile()],
    [2, 100, profile(4, [phase('one'), phase('two', { start_offset_minutes: 15, installation_ids: [102],
      professionals: { mode: 'any', ids: [2], preferred_id: 2 } })])],
    [3, 100, profile(2, [phase('machine', { equipment_requirements: [{ equipment_ids: [401] }] })])],
    [4, 100, profile(1, [phase('fixed', { duration_minutes: 30 })])],
    [5, 100, null],
    [11, 200, profile(1, [phase('peer', { installation_ids: [201], professionals: { mode: 'any', ids: [2], preferred_id: 2 } })])],
    [12, 100, profile(2, [phase('peer_machine', { installation_ids: [102], professionals: { mode: 'any', ids: [2], preferred_id: 2 },
      equipment_requirements: [{ equipment_ids: [401] }] })])],
  ];
  await db.Tratamiento.bulkCreate(profiles.map(([id_tratamiento, clinica_id, booking_profile]) => ({ id_tratamiento, clinica_id,
    grupo_clinica_id: 50, nombre: `Tratamiento sintético ${id_tratamiento}`, origen: 'clinica', activo: true,
    ...(nativeCatalogModel ? { disciplina: 'estetica', precio_base: 100 } : {}),
    clinical_config: { catalog_status: 'active', booking_profile } })));
  const { mutateAppointmentBooking } = require('../../../services/appointmentBookingCommand.service');
  const reserve = input => mutateAppointmentBooking({ db, capabilities,
    persist: ({ values, existing, transaction }) => existing ? existing.update(values, { transaction }) : db.CitaPaciente.create(values, { transaction }), ...input });
  const values = patch => ({ clinica_id: 100, paciente_id: 1, tratamiento_id: 1, doctor_id: 1, instalacion_id: 101,
    inicio: '2030-01-07T09:00:00.000Z', fin: '2030-01-07T09:45:00.000Z', estado: 'pendiente', ...patch });
  const counts = async () => Object.fromEntries(await Promise.all(['CitaPaciente', 'AppointmentBookingOccupancy', 'AppointmentBookingResource']
    .map(async name => [name, await db[name].count()])));

  // Actual HTTP availability handler chain with an explicitly synthetic ACL.
  // This tests endpoint wiring/SQL/solver, not authentication/session middleware.
  const filename = require.resolve('../../../controllers/disponibilidad.controller'), actualRequire = createRequire(filename);
  const source = fs.readFileSync(filename, 'utf8'), exported = {}, acl = [];
  const availability = actualRequire('../services/appointmentBookingAvailability.service');
  const profileService = actualRequire('../services/treatmentBookingProfile.service');
  vm.runInNewContext(source, { exports: exported, console, Date, Map, Set, Promise,
    require: name => name === '../../models' ? db : name === 'express-async-handler' ? fn => fn
      : name === '../lib/access-policy' ? { assertUserCanAccessFeature: async input => { acl.push(input); } }
        : name === '../services/treatmentBookingProfile.service' ? { ...profileService, bookingCapabilities: () => capabilities,
          requireOperationalProfile: (treatment, options) => profileService.requireOperationalProfile(treatment, { capabilities, ...options }) }
          : name === '../services/appointmentBookingAvailability.service' ? { ...availability,
            searchTreatmentSlots: input => availability.searchTreatmentSlots({ ...input, capabilities, now: new Date('2030-01-01') }),
            loadBookingContext: input => availability.loadBookingContext({ ...input, equipmentEnabled: true }) }
            : actualRequire(name),
  }, { filename });
  const queryFor = query => {
    const requestQuery = { clinica_id: '100', tratamiento_id: '1', fecha_local: '2030-01-07',
      inicio_local: '2030-01-07T10:00', duration_minutes: '45', limit: '80', ...query };
    // HTTP transport does not serialize undefined: simulate a truly absent key.
    for (const key of Object.keys(requestQuery)) if (requestQuery[key] === undefined) delete requestQuery[key];
    return requestQuery;
  };
  const http = async (handler, query = {}) => {
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
    const requestQuery = queryFor(query);
    await exported[handler]({ userData: { userId: 1 }, query: requestQuery }, response);
    return response;
  };
  // Optional actual transport. Only this server is admitted by the launcher's
  // socket guard; no Express application/bootstrap/session/provider is loaded.
  let server, transport = null;
  if (registerOwnedLoopbackServer) {
    server = nodeHttp.createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const handler = url.pathname.slice(1);
      if (!['check', 'treatmentSlots', 'slots', 'grid', 'summary'].includes(handler)) {
        response.writeHead(404); response.end(); return;
      }
      const query = {};
      for (const [key, value] of url.searchParams) {
        if (['dates', 'column_ids', 'peer_instalacion_ids'].includes(key) || key.endsWith('[]')) {
          query[key] ||= []; query[key].push(value);
        } else query[key] = value;
      }
      const result = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) {
        response.writeHead(this.statusCode, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); return this;
      } };
      try { await exported[handler]({ userData: { userId: 1 }, query }, result); }
      catch (error) { result.status(error.statusCode || 500).json(profileService.bookingErrorPayload(error)); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    registerOwnedLoopbackServer(server);
    const port = server.address().port;
    transport = (handler, query = {}) => new Promise((resolve, reject) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(queryFor(query))) {
        if (Array.isArray(value)) value.forEach(item => params.append(key, String(item)));
        else params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      const request = nodeHttp.get({ host: '127.0.0.1', port, path: '/' + handler + '?' + params, agent: false }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', value => { body += value; });
        response.on('end', () => { try { resolve({ statusCode: response.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); } });
      });
      request.once('error', reject);
    });
  }
  return { db, capabilities, reserve, values, counts, http, transport,
    close: () => server ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve(), acl, phase, profile,
    read: id => db.CitaPaciente.findByPk(id, { raw: true }),
    occupancy: id => db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: id }, order: [['id', 'ASC']], raw: true }) };
}

module.exports = { createOwnedBookingDurationFixture };
