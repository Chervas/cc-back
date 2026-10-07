'use strict';

// Test-only boundary: actual production model factories, SQL, controller,
// command, runtime, flow engine, JobRequest handlers and final sender/broker.
// Synthetic ACL/ancillary UI read services, controlled queue publication and
// an in-memory broker transport are explicit fixture seams, not app bootstrap.
const fs = require('node:fs'), vm = require('node:vm'), http = require('node:http');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const S = require('sequelize');
const { createOwnedBookingDurationFixture } = require('./owned-booking-duration-fixture');
function scopedModule(filename, overrides = {}, environment = process) {
  const local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console, Date, Map, Set, Promise,
    Buffer, URL, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval, process: environment,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename });
  return module.exports;
}
async function createOwnedVisitConsumerFixture({ sql, models: db, registerOwnedLoopbackServer }) {
  require('../fixtures/security_offline_runtime.cjs');
  const physical = await createOwnedBookingDurationFixture({ sql, models: db });
  const D = S.DataTypes, qi = sql.getQueryInterface(), publication = [], attempts = [];
  const fixtureProcess = Object.create(process); fixtureProcess.env = { ...process.env, JOB_RUNTIME_NAMESPACE: 'visit_fixture' };
  const schedulerFile = require.resolve('../../../services/jobScheduler.service');
  require.cache[schedulerFile] = { id: schedulerFile, filename: schedulerFile, loaded: true, exports: { triggerImmediate: async id => publication.push(id) } };
  const jobsFile = require.resolve('../../../services/jobRequests.service');
  const define = (name, tableName, attrs) => db[name] = sql.define(name, attrs, { tableName, timestamps: false });
  define('GrupoClinica', 'GruposClinicas', { id_grupo: { type: D.INTEGER, primaryKey: true } });
  define('MetaConnection', 'MetaConnections', { id: { type: D.INTEGER, primaryKey: true } });
  define('LeadIntake', 'LeadIntakes', { id: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER });
  define('PacienteClinica', 'PacientesClinicas', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, paciente_id: D.INTEGER, clinica_id: D.INTEGER });
  db.Paciente.hasMany(db.PacienteClinica, { foreignKey: 'paciente_id', sourceKey: 'id_paciente', as: 'clinicasVinculadas' });
  db.CitaPaciente.belongsTo(db.LeadIntake, { foreignKey: 'lead_intake_id', as: 'lead' });
  for (const [model, attrs] of [[db.Paciente, { clinica_id: D.INTEGER, public_id: D.STRING, nombre: D.STRING, apellidos: D.STRING,
    telefono_movil: D.STRING, email: D.STRING, idioma_preferido: D.STRING }], [db.Usuario, { avatar: D.STRING, email_usuario: D.STRING }],
    [db.Clinica, { direccion: D.STRING, telefono: D.STRING, url_web: D.STRING, url_ficha_local: D.STRING }],
    [db.Tratamiento, { duracion_min: D.INTEGER, appointment_automation_template_key: D.STRING, automation_template_bindings: D.JSON }]]) {
    for (const [key, type] of Object.entries(attrs)) { await qi.addColumn(model.tableName, key, { type, allowNull: true }); model.rawAttributes[key] = { type, allowNull: true }; }
    model.refreshAttributes();
  }
  for (const file of ['conversation', 'message', 'automationflowtemplatev2', 'flowexecutionv2', 'flowexecutionlogv2', 'jobrequest',
    'ClinicMetaAsset', 'whatsapptemplatecatalog', 'whatsapptemplate', 'patientcustomfield', 'marketingcontactoptout', 'securitymonitoringmeasure']) {
    const model = require('../../../../models/' + file)(sql, D); db[model.name] = model;
  }
  for (const name of ['Conversation', 'FlowExecutionV2', 'AutomationFlowTemplateV2', 'WhatsappTemplate', 'PatientCustomField', 'MarketingContactOptOut']) db[name].associate?.(db);
  await sql.sync();
  const jobs = scopedModule(jobsFile, {}, fixtureProcess);
  require.cache[jobsFile] = { id: jobsFile, filename: jobsFile, loaded: true, exports: jobs };
  await db.GrupoClinica.create({ id_grupo: 50 });
  for (const id of [1, 2, 3, 4]) await db.Paciente.update({ clinica_id: 100, public_id: 'owned_visit_patient_' + id,
    nombre: 'Paciente ficticio', apellidos: String(id), telefono_movil: '3460000000' + id, idioma_preferido: 'es' }, { where: { id_paciente: id } });
  await require('../../../../migrations/20261006130000-create-appointment-visit-communications').up(qi, S);
  await require('../../../../migrations/20261007130000-add-appointment-visit-runtime-contracts').up(qi, S);
  for (const file of ['appointmentvisit', 'appointmentvisitmember', 'appointmentvisitcommunication', 'appointmentvisitbirthrequest', 'appointmentvisitdispatch']) {
    const model = require('../../../../models/' + file)(sql, D); db[model.name] = model;
  }
  for (const name of ['AppointmentVisit', 'AppointmentVisitMember', 'AppointmentVisitCommunication', 'AppointmentVisitBirthRequest', 'AppointmentVisitDispatch']) db[name].associate?.(db);
  // Fixture reviewed graph has one details stage, no response waits or clinical
  // policies. No production graph map or feature flag is changed by this test.
  const nodes = [
    { id: 'T', type: 'trigger/appointment_created', config: {}, outputs: { on_success: 'S' } },
    { id: 'S', type: 'action/send_whatsapp', config: { message_mode: 'template', template_id: 501,
      recipient_mode: 'patient', sender_mode: 'clinic', quiet_hours_enabled: false, language_code: 'es_ES', communication_scope: 'operational' }, outputs: { on_success: 'E' } },
    { id: 'E', type: 'control/end', config: {}, outputs: {} },
  ];
  const template = await db.AutomationFlowTemplateV2.create({ id: 42, public_id: 'owned_visit_details', template_key: 'owned_visit_details',
    version: 1, name: 'Owned visit fixture', engine_version: 'v2', is_active: true, is_system: false,
    clinic_id: 100, created_by: 1, published_at: new Date(), entry_node_id: 'T', trigger_type: 'appointment_created', trigger_config: {}, nodes });
  await db.Tratamiento.update({ appointment_automation_template_key: template.template_key }, { where: { id_tratamiento: 2 } });
  const catalog = await db.WhatsappTemplateCatalog.create({ name: 'owned_visit_details', family_key: 'owned_visit_details', locale: 'es',
    category: 'UTILITY', body_text: 'Reserva ficticia integrada', variables: [], components: [] });
  await db.WhatsappTemplate.create({ id: 501, clinic_id: 100, waba_id: '90002', name: 'owned_visit_details', language: 'es_ES',
    category: 'UTILITY', status: 'APPROVED', catalog_template_id: catalog.id, components: [{ type: 'BODY', text: 'Reserva ficticia integrada' }] });
  const authorizationId = randomUUID();
  await db.ClinicMetaAsset.create({ id: 701, clinicaId: 100, assignmentScope: 'clinic', assetType: 'whatsapp_phone_number',
    metaAssetId: '90001', phoneNumberId: '90001', wabaId: '90002', whatsappAuthorizationId: authorizationId, isActive: true,
    additionalData: { whatsapp: { channel_role: 'primary' } } });
  const env = { WHATSAPP_DEV_BROKER_ENABLED: 'true', DEV_SECURITY_PROFILE: 'isolated-security-v2', RUNTIME_ROLE: 'api',
    DB_NAME: 'clinicaclick_dev_isolated', DB_USERNAME: 'cc_dev_api', DB_HOST: '127.0.0.1', RUNTIME_NAMESPACE: 'dev', JOB_RUNTIME_NAMESPACE: 'dev',
    QUEUE_PREFIX: 'dev', JOBS_WORKER_ENABLED: 'false', JOBS_CRON_LEADER: 'false', JOBS_AUTO_START: 'false' };
  const binding = { connectionRef: 'owned-visit', authorizationId, clinicId: 100, assetId: 701, phoneId: '90001', wabaId: '90002', revision: 1, sendEnabled: true };
  const config = { version: 1, origin: 'https://owned-provider.invalid', keyId: 'dev-whatsapp-owned', audience: 'owned-visit',
    privateKeyFile: '/etc/clinicaclick-whatsapp-authorized/dev/private.pem', caFile: '/etc/clinicaclick-whatsapp-authorized/dev/ca.pem',
    messageNotBefore: '2020-01-01T00:00:00.000Z', bindings: [binding] };
  let providerMode = 'accept', scopeBlocked = false;
  const brokerFile = require.resolve('../../../lib/whatsappAuthorizedBrokerClient'), originalBroker = require(brokerFile);
  const receipts = new Map();
  const broker = originalBroker.createWhatsappAuthorizedBrokerClient({ environment: () => env, loadConfiguration: () => config,
    loadAsset: id => db.ClinicMetaAsset.findByPk(id, { raw: true }), loadClinic: id => db.Clinica.findByPk(id, { raw: true }),
    loadMessage: id => db.Message.findByPk(id, { raw: true }), loadConversation: id => db.Conversation.findByPk(id, { raw: true }),
    loadExecution: id => db.FlowExecutionV2.findByPk(id, { raw: true }), loadAppointment: id => db.CitaPaciente.findByPk(id, { raw: true }),
    patientHeld: id => require('../../../lib/whatsappAppointmentEligibility').patientImportHeld(id, db),
    loadReceptionState: () => ({ version: 1, observedAt: Date.now(), recoveryHold: false,
      clinics: [{ clinicId: 100, blockingReview: 0, oldestPendingAt: null }] }), isBlocked: () => scopeBlocked,
    createTransport: () => ({ async execute(command) {
      attempts.push(command);
      if (providerMode === 'unknown') throw Error('OWNED_PROVIDER_CONNECTION_LOST');
      const replayed = receipts.has(command.requestId), data = receipts.get(command.requestId) || { messages: [{ id: 'wamid.OWNED_' + command.payload.phoneId + '_' + receipts.size,
        message_status: providerMode === 'held' ? 'held_for_quality_assessment' : 'accepted' }] };
      receipts.set(command.requestId, data); return { requestId: command.requestId, data, replayed };
    } }),
  });
  require.cache[brokerFile].exports = { ...originalBroker, ...broker };
  const managedModule = require('../../../services/appointmentVisitManaged.service');
  let enabled = true, manifestsSupported = true, failPostcommitPublication = false, clock = null;
  const now = () => clock ? new Date(clock) : new Date();
  const runtime = require('../../../services/appointmentAutomationV2Runtime.service');
  const foundation = require('../../../services/appointmentVisitCommunications.service').createAppointmentVisitCommunicationService({ db, now,
    readOperationalPolicy: () => null, readLegacyPolicy: () => null });
  const manifest = { clinic_id: 100, template_version_id: template.id, graph_sha256: require('../../../lib/appointment-visit-runtime-contract').graphHash(template),
    stages: [{ key: 'details', node_ids: ['S'] }], mutations: [] };
  const buildManaged = () => managedModule.createAppointmentVisitManagedService({ db, now, enabled: () => enabled, manifests: () => manifestsSupported ? [manifest] : [],
    namespace: () => 'visit_fixture', foundation, notifyJob: async id => publication.push(id), resolveBirthTemplate: row => runtime.resolveTemplateForCitaEvent(row, 'appointment_created') });
  let managed = buildManaged();
  require.cache[require.resolve('../../../services/appointmentVisitManaged.service')].exports = { ...managedModule, current: () => managed };
  const profileService = require('../../../services/treatmentBookingProfile.service');
  const bookingCommand = require('../../../services/appointmentBookingCommand.service');
  const controller = scopedModule(require.resolve('../../../controllers/citas.controller'), {
    'express-async-handler': fn => fn,
    '../lib/access-policy': { assertUserCanAccessFeature: async () => {}, canUserAccessFeature: async () => true,
      getAccessibleClinicIdsForFeature: async ({ clinicIds }) => clinicIds },
    '../services/treatmentBookingProfile.service': { ...profileService, bookingCapabilities: () => physical.capabilities,
      requireOperationalProfile: (treatment, options) => profileService.requireOperationalProfile(treatment, { capabilities: physical.capabilities, ...options }) },
    '../services/appointmentBookingCommand.service': { ...bookingCommand,
      mutateAppointmentBooking: options => bookingCommand.mutateAppointmentBooking({ capabilities: physical.capabilities, ...options }) },
    '../services/appointmentAutomationV2Runtime.service': { ...runtime, enqueueExecutionForCita: (...args) => {
      if (failPostcommitPublication) throw Error('OWNED_CRASH_AFTER_CANONICAL_COMMIT');
      return runtime.enqueueExecutionForCita(...args);
    } },
    '../services/consentimientos.service': { ensurePackageForAppointment: async () => ({ package: null }), attachConsentSummaryToCitas: async () => {} },
    '../services/patientDirection.service': { handleAppointmentChange: async () => {} },
    '../services/appointmentProgramRead.service': { attachAppointmentProgramContexts: async () => {} },
    '../services/socket.service': { getIO: () => null },
  });
  // Actual handler table and runAutomationFlowV2Job; unrelated integration job
  // imports are never bootstrapped merely to run this manually owned handler.
  const executorFile = require.resolve('../../../services/jobExecutor.service');
  const unrelated = ['../jobs/sync.jobs', './whatsappCoexistence.service', './whatsappTemplates.service', './marketingBulkSends.service',
    './googleReviewMatch.service', './intakeQuickChatOutbox.service', './marketingAiVisibility.service', './webContentGeneration.service',
    './emailDelivery.service', './systemNotifications.service'];
  const actualClaims = require('../../../services/jobClaim.service');
  const executor = scopedModule(executorFile, { ...Object.fromEntries(unrelated.map(name => [name, {}])),
    './jobClaim.service': { ...actualClaims, createJobClaim: (job, options) => actualClaims.createJobClaim(job, { ...options, models: db, namespace: () => 'visit_fixture' }) } }, fixtureProcess);
  // No start/timer is invoked. Tests manually call the REAL existing tick and
  // settlement functions over OWNED SQL with a controlled external dispatcher.
  const scheduler = scopedModule(schedulerFile, { './jobExecutor.service': executor, './aiRuntimeMonitoring.service': {} }, fixtureProcess);
  const send = async body => {
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await controller.createCita({ userData: { userId: 1, name: 'Actor ficticio', role: 'admin' }, body }, response);
    return response;
  };
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    try { const result = await send(JSON.parse(raw)); response.writeHead(result.statusCode, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result.body)); }
    catch (error) { response.writeHead(500); response.end(JSON.stringify({ message: error.message, code: error.code })); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  registerOwnedLoopbackServer(server);
  const post = body => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/citas', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json' } }, response => { let raw = ''; response.setEncoding('utf8'); response.on('data', part => raw += part);
      response.on('end', () => { try { resolve({ statusCode: response.statusCode, body: JSON.parse(raw) }); } catch (error) { reject(error); } }); });
    request.once('error', reject); request.end(JSON.stringify(body));
  });
  const body = (patch = {}) => ({ clinica_id: 100, tratamiento_id: 2, doctor_id: 1, instalacion_id: 101,
    inicio: '2030-01-07T09:00:00.000Z', phase_durations: { one: 40, two: 20 }, estado: 'pendiente', tipo_cita: 'continuacion',
    booking_request_key: randomUUID(), booking_selection: { one: { doctor_id: 1, installation_id: 101 }, two: { doctor_id: 2, installation_id: 102 } },
    paciente: { id_paciente: 1 }, ...patch });
  const claimAndHandle = async jobId => {
    const job = await jobs.claimJobById(jobId); if (!job) return null;
    const handled = await executor.runJob(job);
    await scheduler._settleJobResult(job, handled);
    return { ...handled.result, nextRunAt: handled.nextRunAt, executorStatus: handled.status, error: handled.error };
  };
  const dispatch = require('../../../services/appointmentVisitDispatch.service').createAppointmentVisitDispatchService({ db,
    foundation, namespace: () => 'visit_fixture', rolloutEnabled: () => enabled });
  return { db, sql, physical, post, body, controller, get managed() { return managed; }, runtime, foundation, dispatch, broker, binding, publication, attempts, claimAndHandle, jobs, scheduler,
    enable: value => { enabled = value; }, provider: value => { providerMode = value; }, blocked: value => { scopeBlocked = value; },
    supported: value => { manifestsSupported = value; },
    crashPostcommit: value => { failPostcommitPublication = value; },
    clock: value => { clock = value; }, restartManaged: () => { managed = buildManaged(); },
    close: async () => { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await physical.close(); } };
}
module.exports = { createOwnedVisitConsumerFixture };
