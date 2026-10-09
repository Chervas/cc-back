'use strict';

// Independent, test-only composition. The OWNED launcher intercepts models
// before any production index is imported and forbids every non-owned socket.
// Routers, JWT/session/MFA, ACL, booking, consent and documentation are REAL.
// Beyond the launcher's reject-all external queue/socket guard, the only
// substituted service is the email enqueue boundary: its local SQL
// outbox participates in the actual challenge transaction, but cannot deliver.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const S = require('sequelize');
const bcrypt = require('bcryptjs');

const IDS = Object.freeze({ clinic: 100, peerClinic: 200, group: 50, assistant: 91002,
  reception: 91003, owner: 91004, outsider: 91005, doctorOne: 91010, doctorTwo: 91011,
  patient: 92001, foreignPatient: 92002, treatment: 93001, roomOne: 94001, roomTwo: 94002 });
const PASSWORD = 'OWNED_FICTITIOUS_LOGIN_NOT_A_REAL_ACCOUNT';
const CORE_MODELS = [
  'clinica', 'usuario', 'usuarioclinica', 'paciente', 'pacienteclinica', 'tratamiento', 'leadintake',
  'doctorclinica', 'doctorhorario', 'doctorhorarioexcepcion', 'doctorbloqueo', 'doctorbloqueoexcepcion',
  'instalacion', 'instalacionhorario', 'instalacionbloqueo', 'clinicahorario', 'citapaciente',
  'appointmentbookingoccupancy', 'appointmentbookingresource', 'installationphysicalalias',
  'bookingequipment', 'bookingequipmentclinic', 'bookingequipmentroompolicy',
  'conversation', 'message', 'automationflowcatalog', 'automationflowtemplatev2', 'flowexecutionv2', 'flowexecutionlogv2', 'jobrequest',
  'marketingcompetitionheatmapcache', 'marketingreportoverviewcache',
  'consenttemplatecatalog', 'consenttemplatecatalogversion', 'consenttemplatecatalogdiscipline',
  'consenttemplatecatalogtreatment', 'clinicconsenttemplate', 'clinicconsenttemplateversion',
  'treatmentconsentrequirement', 'consentsignaturepackage', 'patientconsentdocument', 'consentdeliveryevent',
  'patientintakerequest', 'appointmentcareevent', 'notification',
];
const ASSOCIATED = [
  'Clinica', 'Usuario', 'UsuarioClinica', 'Paciente', 'PacienteClinica', 'Tratamiento', 'LeadIntake',
  'DoctorClinica', 'DoctorHorario', 'DoctorHorarioExcepcion', 'DoctorBloqueo', 'DoctorBloqueoExcepcion',
  'Instalacion', 'InstalacionHorario', 'InstalacionBloqueo', 'ClinicaHorario', 'CitaPaciente',
  'AppointmentBookingOccupancy', 'BookingEquipment', 'Conversation', 'FlowExecutionV2', 'AutomationFlowTemplateV2',
  'ConsentTemplateCatalog', 'ConsentTemplateCatalogVersion', 'ConsentTemplateCatalogDiscipline',
  'ConsentTemplateCatalogTreatment', 'ClinicConsentTemplate', 'ClinicConsentTemplateVersion',
  'TreatmentConsentRequirement', 'ConsentSignaturePackage', 'PatientConsentDocument', 'ConsentDeliveryEvent',
  'PatientOperationalEvent', 'Notification',
];
const DOMAIN_TABLES = [
  'Paciente', 'PacienteClinica', 'CitaPaciente', 'AppointmentBookingOccupancy', 'AppointmentBookingResource',
  'AppointmentCareEvent', 'PatientOperationalEvent', 'TreatmentProtocol', 'TreatmentProtocolRevision',
  'TreatmentConsentRequirement', 'ConsentSignaturePackage', 'PatientConsentDocument', 'ConsentDeliveryEvent',
  'PatientIntakeRequest', 'Conversation', 'Message', 'AutomationFlowTemplateV2', 'FlowExecutionV2',
  'FlowExecutionLogV2', 'JobRequest', 'AppointmentVisit', 'AppointmentVisitMember',
  'AppointmentVisitCommunication', 'AppointmentVisitBirthRequest', 'AppointmentVisitDispatch', 'Notification',
];

async function createOwnedVisitAuthAclFixture({ sql, models: db, report, registerOwnedLoopbackServer,
  includeConsentRoutes = false, includeProgramLedger = false }) {
  assert(sql.options.dialectOptions?.socketPath?.startsWith('/tmp/cc-campaign-opt-mysql-'));
  const [[owned]] = await sql.query('SELECT @@skip_networking AS isolated, DATABASE() AS name');
  assert.equal(Number(owned.isolated), 1); assert.equal(owned.name, 'campaign_optimization_qa');
  require('../fixtures/security_offline_runtime.cjs');
  let externalFetchAttempts = 0;
  const rejectedFetch = global.fetch;
  global.fetch = (...args) => { externalFetchAttempts++; return rejectedFetch(...args); };
  // These switches exist ONLY in this short-lived, network-isolated process.
  Object.assign(process.env, {
    AUTH_SESSION_MODE: 'enforce', AUTH_EMAIL_MFA_MODE: 'enforce', PLATFORM_AUDIT_AUTH_ENABLED: 'true',
    PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1', AUTH_ACCESS_TOKEN_TTL_SECONDS: '3600',
    BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', BOOKING_PHASE_OFFSETS_ENABLED: 'true',
    APPOINTMENT_VISIT_COMMUNICATIONS_V1_ENABLED: 'false', WHATSAPP_DEV_BROKER_ENABLED: 'false',
    JOB_RUNTIME_NAMESPACE: 'owned_auth_acl', JOBS_WORKER_ENABLED: 'false', JOBS_CRON_LEADER: 'false', JOBS_AUTO_START: 'false',
  });
  if (includeConsentRoutes) Object.assign(process.env, {
    CONSENT_PUBLIC_TOKEN_SECRET: crypto.randomBytes(32).toString('hex'),
    CONSENT_KIOSK_TOKEN_SECRET: crypto.randomBytes(32).toString('hex'),
  });
  if (includeProgramLedger) Object.assign(process.env, {
    TREATMENT_PROGRAM_BOOKING_ENABLED: 'true', TREATMENT_PROGRAM_ECONOMICS_ENABLED: 'true',
  });
  const keyFile = path.join(report.root, 'owned-auth-email-key');
  fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
  process.env.AUTH_EMAIL_MFA_KEY_FILE = keyFile;
  db.Sequelize = S;
  // Only the group metadata table is reduced: no external asset/billing FKs
  // are needed to exercise the actual native group/clinic ACL precedence.
  db.GrupoClinica = sql.define('GrupoClinica', { id_grupo: { type: S.DataTypes.INTEGER, primaryKey: true },
    nombre: S.DataTypes.STRING }, { tableName: 'GruposClinicas', timestamps: false });
  const modelFiles = includeProgramLedger
    ? [...CORE_MODELS, 'patientvoucher', 'patientvouchermovement', 'patientprogramsession'] : CORE_MODELS;
  for (const file of modelFiles) {
    const model = require('../../../../models/' + file)(sql, S.DataTypes); db[model.name] = model;
  }
  if (includeConsentRoutes) {
    db.ClinicTabletKiosk = require('../../../../models/clinictabletkiosk')(sql, S.DataTypes);
    db.ClinicTabletKiosk.associate(db);
  }
  for (const name of ASSOCIATED) db[name]?.associate?.(db);
  await sql.sync();
  const qi = sql.getQueryInterface();
  // Use additive native DDL for append-only history/protocol revision indexes,
  // including MySQL-safe named indexes and the exact revision UNIQUE key.
  await require('../../../../migrations/20260731150000-create-patient-operational-events').up(qi, S);
  await require('../../../../migrations/20260907001500-create-treatment-protocols').up(qi, S.DataTypes);
  await require('../../../../migrations/20260907020000-allow-system-import-protocol-actors').up(qi, S.DataTypes);
  for (const file of ['patientoperationalevent', 'treatmentprotocol', 'treatmentprotocolrevision']) {
    const model = require('../../../../models/' + file)(sql, S.DataTypes); db[model.name] = model;
  }
  db.PatientOperationalEvent.associate(db);
  await require('../../../../migrations/20260211023000-create-access-policy-overrides').up(qi, S);
  db.AccessPolicyOverride = require('../../../../models/accesspolicyoverride')(sql, S.DataTypes);
  await require('../../../../migrations/20260912210000-create-platform-audit-events').up(qi, S.DataTypes);
  await require('../../../../migrations/20260913003000-add-platform-audit-result-part').up(qi);
  await require('../../../../migrations/20260912220000-create-auth-sessions').up(qi, S.DataTypes);
  await require('../../../../migrations/20260913130000-create-auth-email-challenges').up(qi);
  await require('../../../../migrations/20260914220000-create-auth-trusted-devices').up(qi);
  for (const file of ['authsession', 'authemailchallenge', 'authtrusteddevice', 'platformauditevent']) {
    const model = require('../../../../models/' + file)(sql, S.DataTypes); db[model.name] = model;
  }
  await require('../../../../migrations/20261006130000-create-appointment-visit-communications').up(qi, S);
  await require('../../../../migrations/20261007130000-add-appointment-visit-runtime-contracts').up(qi, S);
  for (const file of ['appointmentvisit', 'appointmentvisitmember', 'appointmentvisitcommunication',
    'appointmentvisitbirthrequest', 'appointmentvisitdispatch']) {
    const model = require('../../../../models/' + file)(sql, S.DataTypes); db[model.name] = model;
  }
  for (const name of ['AppointmentVisit', 'AppointmentVisitMember', 'AppointmentVisitCommunication',
    'AppointmentVisitBirthRequest', 'AppointmentVisitDispatch']) db[name].associate?.(db);

  db.OwnedAuthOutbox = sql.define('OwnedAuthOutbox', {
    id: { type: S.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    challenge_id: { type: S.DataTypes.STRING(36), allowNull: false }, user_id: { type: S.DataTypes.INTEGER, allowNull: false },
    dedupe_key: { type: S.DataTypes.STRING, allowNull: false, unique: true },
    recipient_hash: { type: S.DataTypes.STRING(64), allowNull: false },
    code_sha256: { type: S.DataTypes.STRING(64), allowNull: false }, status: { type: S.DataTypes.STRING, allowNull: false },
  }, { tableName: 'OwnedAuthOutbox', timestamps: false });
  await db.OwnedAuthOutbox.sync();
  const outbox = new Map();
  const challengeApi = require('../../../services/authEmailChallenge.service');
  const challenges = challengeApi.createService({ models: db, queueEmail: async (input, { transaction }) => {
    assert(transaction && !transaction.finished, 'Email enqueue belongs to the actual pending challenge transaction');
    assert.equal(input.templateKey, 'auth.email_verification'); assert.match(input.recipientEmail, /@example\.invalid$/);
    const code = input.templateContext.verification_code;
    const row = await db.OwnedAuthOutbox.create({ challenge_id: input.relatedId, user_id: input.usuarioId,
      dedupe_key: input.dedupeKey, recipient_hash: crypto.createHash('sha256').update(input.recipientEmail).digest('hex'),
      code_sha256: crypto.createHash('sha256').update(code).digest('hex'), status: 'queued' }, { transaction });
    transaction.afterCommit(() => outbox.set(input.relatedId, { id: row.id, userId: input.usuarioId, code }));
    return { emailMessage: { id: row.id, status: row.status } };
  } });
  const challengeFile = require.resolve('../../../services/authEmailChallenge.service');
  require.cache[challengeFile].exports = { ...challengeApi, ...challenges };

  await db.GrupoClinica.create({ id_grupo: IDS.group, nombre: 'OWNED fictitious group' });
  await db.Clinica.bulkCreate([IDS.clinic, IDS.peerClinic].map(id => ({ id_clinica: id, grupoClinicaId: IDS.group,
    nombre_clinica: 'OWNED fictitious clinic ' + id, equipment_booking_enabled: true, configuracion: { timezone: 'Europe/Madrid' } })));
  const users = [IDS.assistant, IDS.reception, IDS.owner, IDS.outsider, IDS.doctorOne, IDS.doctorTwo];
  await db.Usuario.bulkCreate(users.map(id => ({ id_usuario: id, nombre: 'OWNED fictitious employee', apellidos: String(id),
    email_usuario: 'owned-' + id + '@example.invalid', password_usuario: bcrypt.hashSync(PASSWORD, 4), estado_cuenta: 'activo' })));
  await db.UsuarioClinica.bulkCreate([
    { id_usuario: IDS.assistant, id_clinica: IDS.clinic, rol_clinica: 'personaldeclinica', subrol_clinica: 'Auxiliares y enfermeros' },
    { id_usuario: IDS.reception, id_clinica: IDS.clinic, rol_clinica: 'personaldeclinica', subrol_clinica: 'Recepción / Comercial ventas' },
    { id_usuario: IDS.owner, id_clinica: IDS.clinic, rol_clinica: 'propietario' },
    { id_usuario: IDS.outsider, id_clinica: IDS.peerClinic, rol_clinica: 'personaldeclinica', subrol_clinica: 'Auxiliares y enfermeros' },
  ].map(row => ({ ...row, estado_invitacion: 'aceptada' })));
  await db.Paciente.bulkCreate([[IDS.patient, IDS.clinic], [IDS.foreignPatient, IDS.peerClinic]].map(([id, clinic]) => ({
    id_paciente: id, clinica_id: clinic, public_id: 'owned_auth_patient_' + id, nombre: 'OWNED fictitious patient', apellidos: String(id),
    numero_historia: String(id), historia_scope: 'clinic:' + clinic, idioma_preferido: 'es' })));
  await db.PacienteClinica.bulkCreate([[IDS.patient, IDS.clinic], [IDS.foreignPatient, IDS.peerClinic]].map(([paciente_id, clinica_id]) => ({
    paciente_id, clinica_id, es_principal: true })));
  for (const clinicId of [IDS.clinic, IDS.peerClinic]) for (let day = 0; day <= 6; day++) {
    await db.ClinicaHorario.create({ clinica_id: clinicId, dia_semana: day, hora_inicio: '00:00', hora_fin: '23:59' });
  }
  for (const doctor of [IDS.doctorOne, IDS.doctorTwo]) {
    const membership = await db.DoctorClinica.create({ clinica_id: IDS.clinic, doctor_id: doctor, activo: true, recibe_citas: true });
    for (let day = 0; day <= 6; day++) await db.DoctorHorario.create({ doctor_clinica_id: membership.id,
      dia_semana: day, hora_inicio: '00:00', hora_fin: '23:59', activo: true });
  }
  for (const room of [IDS.roomOne, IDS.roomTwo]) {
    await db.Instalacion.create({ id: room, clinica_id: IDS.clinic, nombre: 'OWNED fictitious room ' + room,
      profesionales_permitidos: [IDS.doctorOne, IDS.doctorTwo], activo: true });
    for (let day = 0; day <= 6; day++) await db.InstalacionHorario.create({ instalacion_id: room,
      dia_semana: day, hora_inicio: '00:00', hora_fin: '23:59', activo: true });
  }
  await db.Tratamiento.create({ id_tratamiento: IDS.treatment, clinica_id: IDS.clinic, grupo_clinica_id: IDS.group,
    nombre: 'OWNED fictitious v4 treatment', disciplina: 'medicina', origen: 'clinica', activo: true, precio_base: 0,
    eliminado_por_clinica: [], clinical_config: { catalog_status: 'active', booking_profile: { version: 4, phases: [
      { key: 'one', label: 'OWNED phase one', duration_minutes: null, start_offset_minutes: 0, installation_ids: [IDS.roomOne],
        professionals: { mode: 'any', ids: [IDS.doctorOne], preferred_id: IDS.doctorOne } },
      { key: 'two', label: 'OWNED phase two', duration_minutes: null, start_offset_minutes: 15, installation_ids: [IDS.roomTwo],
        professionals: { mode: 'any', ids: [IDS.doctorTwo], preferred_id: IDS.doctorTwo } },
    ] } } });

  // No auth/controller/ACL module override. Each module captures the native
  // models above, as in app.js, but app bootstrap/workers are never imported.
  const app = require('express')(); app.use(require('express').json());
  app.use('/api/auth', require('../../../routes/auth.routes'));
  app.use('/api/citas', require('../../../routes/citas.routes'));
  app.use('/api/treatment-documentation', require('../../../routes/treatmentDocumentation.routes'));
  if (includeConsentRoutes) app.use('/api/consentimientos', require('../../../routes/consentimientos.routes'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.statusCode || error.status || 500).json({ code: error.code || 'owned_unhandled_error', message: error.message });
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  registerOwnedLoopbackServer(server);
  let requests = 0;
  const request = (method, target, body, token, extraHeaders = {}) => new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body); requests++;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: target, method, agent: false,
      headers: { ...(raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...extraHeaders } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }); }
        catch { reject(Error('OWNED non-JSON response status ' + res.statusCode)); } });
    }); req.once('error', reject); req.end(raw);
  });
  const fingerprint = async () => {
    const snapshots = {};
    const tables = includeProgramLedger
      ? [...DOMAIN_TABLES, 'PatientVoucher', 'PatientVoucherMovement', 'PatientProgramSession'] : DOMAIN_TABLES;
    for (const name of tables) snapshots[name] = await db[name].findAll({ order: db[name].primaryKeyAttributes.map(key => [key, 'ASC']), raw: true });
    return { sha256: crypto.createHash('sha256').update(JSON.stringify(snapshots)).digest('hex'),
      counts: Object.fromEntries(Object.entries(snapshots).map(([name, rows]) => [name, rows.length])) };
  };
  const clock = new Date(); const start = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate() - 1, 10));
  const body = (patch = {}) => ({ clinica_id: IDS.clinic, tratamiento_id: IDS.treatment, doctor_id: IDS.doctorOne,
    instalacion_id: IDS.roomOne, inicio: start.toISOString(), phase_durations: { one: 40, two: 20 },
    estado: 'pendiente', tipo_cita: 'continuacion', booking_request_key: crypto.randomUUID(),
    booking_selection: { one: { doctor_id: IDS.doctorOne, installation_id: IDS.roomOne },
      two: { doctor_id: IDS.doctorTwo, installation_id: IDS.roomTwo } }, paciente: { id_paciente: IDS.patient }, ...patch });
  return { db, sql, ids: IDS, password: PASSWORD, request, body, fingerprint,
    codeFor: challengeId => outbox.get(challengeId)?.code, get requests() { return requests; },
    get externalFetchAttempts() { return externalFetchAttempts; },
    async close() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); },
    boundaries: { auth: 'Actual bcrypt, email challenge, HS256 managed JWT, HMAC credential binding, SQL session and audit',
      acl: 'Actual UsuarioClinica memberships, role defaults and native group/clinic AccessPolicyOverrides',
      email: 'OWNED SQL transactional outbox with private captured code; no delivery, SMTP or personal mailbox',
      appointment: 'Actual routers/controller/native v4 command and care/docs/consent; appointment start already reached',
      communications: 'Closed rollout, unchanged empty review registry, no templates or started workers; inherited reject-all external queue/socket guard',
      group: 'Reduced native group metadata only; no external asset/billing relations',
      excluded: 'No future managed enrollment, email delivery, browser/visual, live tenant, or all application routes claimed' } };
}

module.exports = { createOwnedVisitAuthAclFixture, IDS };
