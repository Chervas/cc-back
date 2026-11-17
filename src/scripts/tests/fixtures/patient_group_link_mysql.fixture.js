'use strict';
// Private fixture for the freshly owned MySQL launcher. Actual patient/booking
// controllers, ACL, hooks, FKs, contact event and audit capture run against SQL.
// Session verification and external post-commit observers are explicit fakes.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const S = require('sequelize');
const { createOwnedBookingDurationFixture } = require('../helpers/owned-booking-duration-fixture');
function source(file, dependencies, logs) {
  const module = { exports: {} }, original = createRequire(file);
  const req = name => Object.hasOwn(dependencies, name) ? dependencies[name]
    : name.startsWith('../lib/') || ['sequelize', 'crypto'].includes(name) ? original(name)
      : new Proxy({}, { get(_, key) { throw Error('UNEXPECTED_GROUP_LINK_DEPENDENCY:' + name + ':' + String(key)); } });
  new Function('require', 'module', 'exports', 'console', fs.readFileSync(file, 'utf8'))(req, module, module.exports,
    { log() {}, warn(...args) { logs.push(args); }, error(...args) { logs.push(args); } });
  return module.exports;
}
async function createPatientGroupLinkMysqlFixture(context) {
  const { sql, models: db, registerOwnedLoopbackServer } = context;
  sql.options.pool.max = 2; sql.connectionManager.pool._factory.max = 2;
  const physical = await createOwnedBookingDurationFixture({ ...context, includePatientScope: true, nativePatientModel: true });
  const D = S.DataTypes, logs = [], events = [], aclReads = [], state = { failEvent: false, failAudit: false, onAudit: null };
  db.LeadIntake = sql.define('LeadIntake', { id: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER,
    grupo_clinica_id: D.INTEGER, telefono: D.STRING, status_lead: D.STRING, archived_at: D.DATE }, { tableName: 'LeadIntakes', timestamps: false });
  await db.LeadIntake.sync();
  db.CitaPaciente.belongsTo(db.LeadIntake, { foreignKey: 'lead_intake_id', as: 'lead' });
  for (const name of ['usuarioclinica', 'accesspolicyoverride', 'PatientDirectionProfile', 'PatientDirectionSetting', 'patientoperationalevent']) {
    const model = require('../../../../models/' + name)(sql, D); db[model.name] = model;
    model.options.indexes.forEach((index, i) => { index.name = 'owned_group_' + model.name + '_' + i; });
  }
  db.PatientDirectionProfile.hasMany(db.PatientDirectionSetting, { as: 'clinicSettings', foreignKey: 'director_user_id', sourceKey: 'user_id' });
  db.PatientOperationalEvent.associate(db);
  for (const name of ['UsuarioClinica', 'AccessPolicyOverride', 'PatientDirectionProfile', 'PatientDirectionSetting', 'PatientOperationalEvent']) await db[name].sync();
  await db.Usuario.create({ id_usuario: 9001, nombre: 'Recepción ficticia', apellidos: 'Sólo destino' });
  await db.UsuarioClinica.create({ id_usuario: 9001, id_clinica: 100, rol_clinica: 'personaldeclinica', subrol_clinica: 'Recepción / Comercial ventas' });
  db.PatientOperationalEvent.addHook('beforeCreate', 'owned_fail_event', () => { if (state.failEvent) throw Error('OWNED_EVENT_FAILURE'); });
  for (const name of ['UsuarioClinica', 'PatientDirectionProfile', 'AccessPolicyOverride']) db[name].addHook('beforeFind', 'owned_acl_trace', options => {
    aclReads.push({ model: name, transaction: options.transaction || null });
  });
  const acl = require('../../../lib/access-policy');
  const contact = require('../../../services/patientContact.service');
  const audit = require('../../../services/platformAudit.patientReads');
  const { pack } = require('../../../../services/platform-audit/src/event');
  const capture = audit.createCapture({ enabled: () => 'true', verifySession: async () => {}, transaction: fn => sql.transaction(fn),
    repository: { health: async () => ({ pending: 0, oldestAgeSeconds: 0 }), append: async event => {
      pack(event); if (state.failAudit) throw Error('OWNED_AUDIT_FAILURE'); events.push(event); await state.onAudit?.(event);
    } } });
  const auditBoundary = { ...audit, wrap: (action, work) => async (req, res) => {
    const response = await capture.run(action, req, work); return res.status(response.status).json(response.body);
  } };
  const controller = source(require.resolve('../../../controllers/paciente.controller'), {
    '../../models': db, '../services/platformAudit.patientReads': auditBoundary, '../lib/access-policy': acl,
    '../services/patientContact.service': contact, '../services/appointmentActivity.service': {},
    '../services/marketingOptOut.service': {},
  }, logs);
  // Same controller sources and full patient-scope guard as the production
  // booking path. No permissive patient/source ACL substitute is installed.
  const file = require.resolve('../../../controllers/citas.controller'), original = createRequire(file), text = fs.readFileSync(file, 'utf8');
  const section = (start, end) => { const a = text.indexOf(start), b = text.indexOf(end, a); if (a < 0 || b <= a) throw Error(start); return text.slice(a, b); };
  const profile = require('../../../services/treatmentBookingProfile.service'), command = require('../../../services/appointmentBookingCommand.service');
  const binding = {
    db, Op: S.Op, console: { error(...args) { logs.push(args); }, warn() {}, log() {} }, DEFAULT_TIMEZONE: 'Europe/Madrid',
    ...Object.fromEntries(['Clinica', 'Paciente', 'LeadIntake', 'CitaPaciente', 'Tratamiento', 'Instalacion'].map(name => [name, db[name]])),
    Campana: null, CITA_ESTADOS_VALIDOS: new Set(require('../../../lib/status-catalog').CITA_STATUS_VALUES),
    ...require('../../../lib/patient-language'), ...require('../../../lib/appointment-patient-identity'),
    normalizePhoneDigits: require('../../../lib/phone').normalizePhoneDigits, normalizeHumanName: require('../../../lib/name').normalizeHumanName,
    generatePacientePublicId: () => 'pac_' + crypto.randomBytes(10).toString('hex'),
    normalizeAdditionalStaff: require('../../../lib/appointment-additional-staff').normalizeAdditionalStaff,
    bookingCapabilities: () => physical.capabilities, bookingErrorPayload: profile.bookingErrorPayload,
    loadScopedTreatment: profile.loadScopedTreatment, requireOperationalProfile: profile.requireOperationalProfile,
    assertTreatmentBookingVisibility: profile.assertTreatmentBookingVisibility,
    mutateAppointmentBooking: args => command.mutateAppointmentBooking({ ...args, capabilities: physical.capabilities }),
    assertAppointmentManageAccess: req => acl.assertUserCanAccessFeature({ actorId: req.userData.userId, featureKey: 'appointments.manage', clinicId: 100 }),
    canUserAccessFeature: acl.canUserAccessFeature, getAccessibleClinicIdsForFeature: acl.getAccessibleClinicIdsForFeature,
    ...require('../../../services/appointmentLeadLink.service'),
    enqueueCreatedAppointmentCrmSignals: async () => {}, appointmentAutomationV2Runtime: { enqueueExecutionForCita: async () => {}, syncScheduledTriggersForCita: async () => {} },
    ensureConsentPackageAndAutomation: async () => {}, ensureQualifiedLeadConversion: async () => {}, uploadScheduleForLinkedAppointment: async () => {}, processAppointmentLeadMilestones: async () => {},
    patientDirectionService: { handleAppointmentChange: async () => {} }, consentimientosService: { attachConsentSummaryToCitas: async () => {} },
    attachFlowSummaryToCitas: async () => {}, attachUnreadCountsToCitas: async () => {}, attachAppointmentProgramContexts: async () => {}, attachResolvedAppointmentPricesToCitas: () => {},
    emitAppointmentSocketEvent: () => {}, protectAppointmentsForRequest: async (_req, row) => row.toJSON(),
  };
  const fragments = [
    ['async function generateUniquePacientePublicId(', '\nasync function ensureConsentPackageAndAutomation('],
    ['function parsePositiveInt(', '\nasync function findHistoricalAttributedLeadForPatient('],
    ['function sendAppointmentAccessPolicyError(', '\nasync function denyAppointment'],
    ['async function ensurePacienteClinica(', '\nconst overlap ='],
    ['const parseClinicConfig =', '\nconst formatPartsInTimeZone ='],
    ['exports.createCita =', '\n/**\n * Listar citas'],
  ].map(([a, b]) => section(a, b)).join('\n');
  const appointments = {}, external = name => name === '../services/newPatientWhatsappConversation.service' ? { link: async () => {} }
    : name === '../services/appointmentConsentEligibility.service' ? { assertClinicalCompletion: async () => {} } : original(name);
  new Function(...Object.keys(binding), 'require', 'exports', 'asyncHandler', fragments)(...Object.values(binding), external, appointments, fn => fn);
  const invoke = async (name, { query = {}, body = {}, id = null } = {}) => {
    const req = { userData: { userId: 9001, role: 'personaldeclinica' }, headers: {}, query, body, params: { id },
      authSession: { id: '545aef07-91c3-4fbc-8ce4-75135575fd7e' } };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } };
    await (name === 'createCita' ? appointments : controller)[name](req, res); return { statusCode: res.statusCode, body: res.body };
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1'); let raw = ''; for await (const part of request) raw += part;
      const result = await invoke(url.pathname.slice(1), { query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : {}, id: request.headers['x-owned-patient'] });
      response.writeHead(result.statusCode, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result.body));
    } catch (error) { logs.push(error); response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ message: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); registerOwnedLoopbackServer(server);
  const request = (name, { query = {}, body, id } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/' + name + '?' + new URLSearchParams(query),
      method: body ? 'POST' : 'GET', agent: false, headers: { 'Content-Type': 'application/json', ...(id ? { 'x-owned-patient': String(id) } : {}) } }, response => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', part => { raw += part; }); response.on('end', () => {
        try { resolve({ statusCode: response.statusCode, body: JSON.parse(raw) }); } catch (error) { reject(error); }
      });
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  return { db, sql, physical, state, events, logs, aclReads, acl, request,
    async close() { await new Promise(resolve => server.close(resolve)); await physical.close(); } };
}
module.exports = { createPatientGroupLinkMysqlFixture };
