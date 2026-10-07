'use strict';

// Test-only: real consent/care model factories and services over the launcher's
// newly owned SQL socket. Only ancillary patient/clinic/treatment tables are
// reduced scaffolds. No application bootstrap, employee ACL mock, send or PDF.
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const S = require('sequelize');
const bcrypt = require('bcryptjs');

function consentModuleWithFictitiousSecrets(filename) {
  const local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: local, __dirname: require('node:path').dirname(filename),
    console, Date, Buffer, Map, Set, Promise, URL, setTimeout, clearTimeout,
    process: { env: { CONSENT_PUBLIC_TOKEN_SECRET: 'OWNED_SQL_ONLY_PUBLIC_SECRET_NOT_A_REAL_ACCOUNT',
      CONSENT_KIOSK_TOKEN_SECRET: 'OWNED_SQL_ONLY_KIOSK_SECRET_NOT_A_REAL_ACCOUNT' } },
  }, { filename });
  return module.exports;
}

async function createOwnedConsentConsistencyFixture({ sql, models: db }) {
  const D = S.DataTypes;
  db.Sequelize = S;
  const define = (name, tableName, attrs) => db[name] = sql.define(name, attrs, { tableName, timestamps: false });
  define('Clinica', 'Clinicas', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER,
    nombre_clinica: D.STRING, url_avatar: D.STRING, datos_fiscales_clinica: D.JSON });
  define('Paciente', 'Pacientes', { id_paciente: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER,
    public_id: D.STRING, nombre: D.STRING, apellidos: D.STRING, fecha_nacimiento: D.DATEONLY,
    dni: D.STRING, telefono_movil: D.STRING, email: D.STRING });
  define('Usuario', 'Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true }, nombre: D.STRING, apellidos: D.STRING });
  define('Tratamiento', 'Tratamientos', { id_tratamiento: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER,
    nombre: D.STRING, disciplina: D.STRING, origen: D.STRING, grupo_clinica_id: D.INTEGER,
    eliminado_por_clinica: { type: D.JSON, defaultValue: [] }, activo: D.BOOLEAN, precio_base: D.DECIMAL(10, 2),
    clinical_config: D.JSON, appointment_automation_template_key: D.STRING, automation_template_bindings: D.JSON });
  for (const file of ['citapaciente', 'treatmentconsentrequirement', 'clinicconsenttemplate', 'clinicconsenttemplateversion',
    'consenttemplatecatalog', 'consenttemplatecatalogversion', 'consentsignaturepackage', 'patientconsentdocument',
    'consentdeliveryevent', 'clinictabletkiosk', 'appointmentcareevent', 'patientoperationalevent', 'patientintakerequest',
    'treatmentprotocol', 'treatmentprotocolrevision']) {
    const model = require('../../../../models/' + file)(sql, D); db[model.name] = model;
  }
  // Only catalog associations actually used by this chain; no discipline or
  // catalog-assignment fake is injected into any production service.
  db.ConsentTemplateCatalog.hasMany(db.ConsentTemplateCatalogVersion, { foreignKey: 'catalog_id', as: 'versions' });
  for (const name of ['CitaPaciente', 'TreatmentConsentRequirement', 'ClinicConsentTemplate', 'ClinicConsentTemplateVersion',
    'ConsentTemplateCatalogVersion', 'ConsentSignaturePackage', 'PatientConsentDocument', 'ConsentDeliveryEvent',
    'ClinicTabletKiosk', 'PatientOperationalEvent']) db[name].associate?.(db);
  // Production migration supplies these exact, bounded index names. Factory
  // sync's auto-generated first name exceeds MySQL's 64-character limit.
  ['idx_patient_operational_events_patient_type_at', 'idx_patient_operational_events_clinic_type_at',
    'idx_patient_operational_events_actor_at'].forEach((name, index) => { db.PatientOperationalEvent.options.indexes[index].name = name; });
  await sql.sync();
  await db.Clinica.bulkCreate([{ id_clinica: 100, nombre_clinica: 'Clínica ficticia A' }, { id_clinica: 200, nombre_clinica: 'Clínica ficticia B' }]);
  await db.Paciente.bulkCreate([{ id_paciente: 1, clinica_id: 100, public_id: 'owned_consent_patient_1', nombre: 'Paciente',
    apellidos: 'Ficticio A', fecha_nacimiento: '1990-01-01' }, { id_paciente: 2, clinica_id: 200,
    public_id: 'owned_consent_patient_2', nombre: 'Paciente', apellidos: 'Ficticio B', fecha_nacimiento: '1991-01-01' }]);
  await db.Usuario.bulkCreate([{ id_usuario: 7, nombre: 'Profesional', apellidos: 'Ficticio A' }, { id_usuario: 8, nombre: 'Profesional', apellidos: 'Ficticio B' }]);
  await db.Tratamiento.bulkCreate([11, 12, 13, 14, 15, 16].map(id => ({ id_tratamiento: id, clinica_id: 100,
    nombre: 'Técnica ficticia ' + id, disciplina: 'Ficticia', origen: 'clinica', eliminado_por_clinica: [], activo: true, precio_base: 10 })));
  // Protocol tables intentionally remain EMPTY. This consent fixture never
  // fabricates approval or asserts frozen protocol coverage; a separate test
  // owns that contract when clinical start integration is added.
  for (const [id, needsProfessional] of [[101, true], [102, false], [103, false], [104, false]]) {
    await db.ClinicConsentTemplate.create({ id, public_id: 'owned_consent_template_' + id, clinic_id: 100,
      name: 'Documento ficticio ' + id, purpose: 'clinical', status: 'active', validity_mode: id === 104 ? 'manual' : 'single_act',
      blocking_policy: 'hard', requires_professional_signature: needsProfessional });
    if (id !== 103) await db.ClinicConsentTemplateVersion.create({ id: id + 100, clinic_template_id: id, version: 1,
      title: 'Versión ficticia ' + id, body_html: '<p>Documento ficticio {{paciente.nombre_completo}}: {{tratamiento.nombre}}</p>',
      status: 'published', published_at: new Date() });
  }
  await db.TreatmentConsentRequirement.bulkCreate([{ tratamiento_id: 11, clinica_id: 100, clinic_template_id: 101 },
    { tratamiento_id: 12, clinica_id: 100, clinic_template_id: 102 }, { tratamiento_id: 13, clinica_id: 100, clinic_template_id: 101 },
    { tratamiento_id: 13, clinica_id: 100, clinic_template_id: 103 }, { tratamiento_id: 14, clinica_id: 100, clinic_template_id: 101 },
    { tratamiento_id: 14, clinica_id: 100, clinic_template_id: 102 }, { tratamiento_id: 15, clinica_id: 100, clinic_template_id: 104 },
    { tratamiento_id: 16, clinica_id: 100, clinic_template_id: 104 }]);
  const password = 'OWNED-FICTITIOUS-TABLET-PASSWORD';
  const passwordHash = await bcrypt.hash(password, 4);
  await db.ClinicTabletKiosk.bulkCreate([{ id: 1, public_id: 'owned_kiosk_a', clinic_id: 100, username: 'owned-tablet-a', password_hash: passwordHash },
    { id: 2, public_id: 'owned_kiosk_b', clinic_id: 200, username: 'owned-tablet-b', password_hash: passwordHash }]);
  const consents = consentModuleWithFictitiousSecrets(require.resolve('../../../services/consentimientos.service'));
  const care = require('../../../services/appointmentCare.service');
  let serial = 0;
  const appointment = async (treatmentId = 11, patch = {}) => db.CitaPaciente.create({
    clinica_id: 100, paciente_id: 1, doctor_id: 7, tratamiento_id: treatmentId, estado: 'info_confirmada',
    titulo: 'Cita ficticia ' + (++serial), inicio: new Date(Date.now() - 600000), fin: new Date(Date.now() + 1200000), ...patch });
  const prepare = async (treatmentId = 11) => {
    const cita = await appointment(treatmentId);
    const pkg = await consents.createPackageForAppointment(cita.id_cita, { createdBy: 7 });
    return { cita, pkg, doc: pkg.documents[0] };
  };
  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64');
  const signature = device => ({ accepted_statement: true, signer_name: 'Paciente ficticio', signer_role: 'patient',
    signature_data_url: png, method: 'tablet_signature', device_label: device });
  const arrive = cita => care.record({ appointmentId: cita.id_cita, clinicId: cita.clinica_id, actorId: 7, action: 'arrive' });
  const start = cita => care.record({ appointmentId: cita.id_cita, clinicId: cita.clinica_id, actorId: 7, action: 'start' });
  const signatureEvents = async doc => (await db.ConsentDeliveryEvent.findAll({ where: { patient_consent_document_id: doc.id }, raw: true }))
    .filter(row => ['document_signed', 'professional_signed_document'].includes(row.event_payload?.event));
  return { db, consents, care, appointment, prepare, signature, arrive, start, password, signatureEvents };
}

module.exports = { createOwnedConsentConsistencyFixture };
