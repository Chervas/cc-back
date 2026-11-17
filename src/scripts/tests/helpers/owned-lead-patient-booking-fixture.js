'use strict';
// Actual controller body and patient helpers, native patient/NHC/booking models,
// SQL and solver. ACL, post-commit projections and external observers are explicit
// synthetic boundaries. No application model bootstrap, session or provider.
const fs = require('node:fs'), vm = require('node:vm'), http = require('node:http');
const crypto = require('node:crypto'), { createRequire } = require('node:module');
const S = require('sequelize');
const { createOwnedBookingDurationFixture } = require('./owned-booking-duration-fixture');

async function createOwnedLeadPatientBookingFixture(context) {
  const { sql, models: db, registerOwnedLoopbackServer } = context;
  const physical = await createOwnedBookingDurationFixture({ ...context, includePatientScope: true, nativePatientModel: true });
  const D = S.DataTypes;
  db.LeadIntake = sql.define('LeadIntake', { id: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER,
    grupo_clinica_id: D.INTEGER, campana_id: D.INTEGER, nombre: D.STRING, telefono: D.STRING,
    status_lead: D.STRING, call_outcome_appointment_id: D.INTEGER, archived_at: D.DATE,
    call_initiated: D.BOOLEAN, call_outcome: D.STRING, call_outcome_at: D.DATE, call_outcome_notes: D.STRING,
  }, { tableName: 'LeadIntakes', timestamps: false });
  await db.LeadIntake.sync();
  db.CitaPaciente.belongsTo(db.LeadIntake, { foreignKey: 'lead_intake_id', as: 'lead' });
  const file = require.resolve('../../../controllers/citas.controller'), nativeRequire = createRequire(file);
  const source = fs.readFileSync(file, 'utf8');
  const section = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    if (a < 0 || b <= a) throw Error('Controller fixture source boundary missing: ' + start);
    return source.slice(a, b);
  };
  const profileService = require('../../../services/treatmentBookingProfile.service');
  const language = require('../../../lib/patient-language');
  const identity = require('../../../lib/appointment-patient-identity');
  const command = require('../../../services/appointmentBookingCommand.service');
  const leadLink = require('../../../services/appointmentLeadLink.service');
  let allowed = true, failAfterPersist = false;
  const observers = [], controller = {};
  const sandbox = {
    exports: controller, asyncHandler: fn => fn, db, Op: S.Op, Date, Map, Set, Promise, Intl,
    console: { error() {}, warn() {}, log() {} }, DEFAULT_TIMEZONE: 'Europe/Madrid',
    ...Object.fromEntries(['Clinica', 'Paciente', 'LeadIntake', 'CitaPaciente', 'Tratamiento', 'Instalacion'].map(name => [name, db[name]])),
    Campana: null, CITA_ESTADOS_VALIDOS: new Set(require('../../../lib/status-catalog').CITA_STATUS_VALUES),
    ...language, ...identity,
    normalizePhoneDigits: require('../../../lib/phone').normalizePhoneDigits,
    normalizeHumanName: require('../../../lib/name').normalizeHumanName,
    generatePacientePublicId: () => `pac_${crypto.randomBytes(10).toString('hex')}`,
    normalizeAdditionalStaff: require('../../../lib/appointment-additional-staff').normalizeAdditionalStaff,
    bookingCapabilities: () => physical.capabilities,
    bookingErrorPayload: profileService.bookingErrorPayload,
    mutateAppointmentBooking: options => command.mutateAppointmentBooking({ ...options, capabilities: physical.capabilities }),
    loadScopedTreatment: profileService.loadScopedTreatment, requireOperationalProfile: profileService.requireOperationalProfile,
    assertTreatmentBookingVisibility: profileService.assertTreatmentBookingVisibility,
    assertAppointmentManageAccess: async () => { if (!allowed) throw Object.assign(Error('access_policy_forbidden'), { status: 403 }); },
    canUserAccessFeature: async () => allowed,
    actorCanReadPatientSensitive: async (_req, patient) => allowed && Number(patient.clinica_id) === 100,
    recordCreatedAppointmentLead: leadLink.recordCreatedAppointmentLead,
    findUniqueAppointmentLead: leadLink.findUniqueAppointmentLead,
    enqueueCreatedAppointmentCrmSignals: async ({ transaction }) => {
      assertTransaction(transaction); if (failAfterPersist) throw Error('OWNED_AFTER_PERSIST_FAILURE');
    },
    appointmentAutomationV2Runtime: { enqueueExecutionForCita: async row => observers.push(['automation', row.id_cita]), syncScheduledTriggersForCita: async () => {} },
    ensureConsentPackageAndAutomation: async () => {}, ensureQualifiedLeadConversion: async () => {},
    uploadScheduleForLinkedAppointment: async () => {}, processAppointmentLeadMilestones: async () => {},
    patientDirectionService: { handleAppointmentChange: async () => {} },
    consentimientosService: { attachConsentSummaryToCitas: async () => {} },
    attachFlowSummaryToCitas: async () => {}, attachUnreadCountsToCitas: async () => {},
    attachAppointmentProgramContexts: async () => {}, attachResolvedAppointmentPricesToCitas: () => {},
    emitAppointmentSocketEvent: (_type, row) => observers.push(['socket', row.id_cita]),
    protectAppointmentsForRequest: async (_request, row) => row.toJSON(),
    require: name => name === '../services/newPatientWhatsappConversation.service' ? { link: async () => {} }
      : name === '../services/appointmentConsentEligibility.service' ? { assertClinicalCompletion: async () => {} }
      : nativeRequire(name),
  };
  function assertTransaction(transaction) {
    if (!transaction || transaction.sequelize !== sql) throw Error('OWNED_APPOINTMENT_TRANSACTION_REQUIRED');
  }
  vm.createContext(sandbox);
  for (const [start, end] of [
    ['async function generateUniquePacientePublicId(', '\nfunction patientClinicIds('],
    ['function parsePositiveInt(', '\nasync function findHistoricalAttributedLeadForPatient('],
    ['function sendAppointmentAccessPolicyError(', '\nasync function denyAppointment'],
    ['async function ensurePacienteClinica(', '\nconst overlap ='],
    ['const parseClinicConfig =', '\nconst formatPartsInTimeZone ='],
    ['exports.createCita =', '\n/**\n * Listar citas'],
  ]) vm.runInContext(section(start, end), sandbox, { filename: file });
  const send = async body => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controller.createCita({ body, userData: { userId: 1, name: 'Actor ficticio', role: 'admin' } }, res); return res;
  };
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    try { const result = await send(JSON.parse(raw)); response.writeHead(result.statusCode, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result.body)); }
    catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ message: error.message, code: error.code })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  registerOwnedLoopbackServer(server);
  const post = body => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/citas', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json' } }, response => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', part => { raw += part; });
      response.on('end', () => { try { resolve({ statusCode: response.statusCode, body: JSON.parse(raw) }); } catch (error) { reject(error); } });
    }); request.once('error', reject); request.end(JSON.stringify(body));
  });
  const body = (patch = {}) => ({ clinica_id: '100', inicio: '2030-01-11T09:55:00Z', fin: '2030-01-11T10:11:00Z',
    doctor_id: 1, instalacion_id: 101, tipo_cita: 'primera_sin_trat', lead_intake_id: 701,
    paciente: { nombre: 'Lead Ficticio', apellidos: 'Reserva', telefono: '34600000701' }, ...patch });
  const lead = async (id = 701, patch = {}) => db.LeadIntake.create({ id, clinica_id: 100, grupo_clinica_id: 50,
    nombre: 'Lead ficticio', telefono: `34600000${id}`, status_lead: 'nuevo', ...patch });
  const snapshot = async () => {
    const out = {}; for (const name of ['Paciente', 'PacienteClinica', 'PatientHistoryCounter', 'CitaPaciente', 'AppointmentBookingOccupancy', 'LeadIntake']) {
      out[name] = await db[name].findAll({ order: [[db[name].primaryKeyAttribute, 'ASC']], raw: true });
    } return JSON.parse(JSON.stringify(out));
  };
  return { db, sql, physical, post, body, lead, snapshot, observers,
    allow: value => { allowed = value; }, failPersist: value => { failAfterPersist = value; },
    resolve: values => sandbox.findOrCreatePaciente(values),
    close: async () => { await new Promise(resolve => server.close(resolve)); await physical.close(); } };
}
module.exports = { createOwnedLeadPatientBookingFixture };
