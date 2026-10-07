'use strict';

// This fixture owns all rows in the launcher's NEW, socket-only MySQL. The
// component verifier, audit, occupancy, consent/signature and care services are
// real. Patient/clinic/treatment scaffolds, feature permissions and physical
// alias resolution are explicitly synthetic; this is not employee-ACL E2E.
const assert = require('node:assert/strict');
const { createOwnedConsentConsistencyFixture } = require('./owned-consent-consistency-fixture');
const { hash } = require('../../../lib/cliniccloud-import/adapter');
const components = require('../../../lib/appointment-clinical-components');
const componentService = require('../../../services/appointmentClinicalComponents.service');
const { occupancyForSolution } = require('../../../lib/booking-profile-solver');

async function createOwnedDocumentationComponentFixture(context) {
  const f = await createOwnedConsentConsistencyFixture(context), { db } = f;
  for (const file of ['appointmentclinicalreport', 'patientnutritionmeasurement', 'patientnutritionreport',
    'patientvouchermovement', 'patientprogramsession', 'appointmentbookingoccupancy', 'appointmentbookingresource']) {
    const model = require('../../../../models/' + file)(context.sql, db.Sequelize.DataTypes);
    db[model.name] = model;
    await model.sync();
  }
  await db.Clinica.create({ id_clinica: 66, nombre_clinica: 'Clínica OWNED ficticia PRP' });
  await db.Paciente.create({ id_paciente: 8, clinica_id: 66, public_id: 'owned_component_patient_8',
    nombre: 'Paciente', apellidos: 'Ficticio Componente', fecha_nacimiento: '1990-01-01' });
  await db.Usuario.bulkCreate([{ id_usuario: 50, nombre: 'Profesional', apellidos: 'Ficticio Principal' },
    { id_usuario: 53, nombre: 'Profesional', apellidos: 'Ficticio Extracción' }]);
  await db.Tratamiento.bulkCreate([{ id_tratamiento: 688, clinica_id: 66, nombre: 'PRP OWNED ficticio', origen: 'clinica',
    activo: true, precio_base: 120, eliminado_por_clinica: [],
    clinical_config: { catalog_status: 'active', source_reference: 'service:2798745' } },
  { id_tratamiento: 1688, clinica_id: 66, nombre: 'IM antiguo OWNED ficticio', origen: 'clinica',
    activo: true, precio_base: 80, eliminado_por_clinica: [] }]);
  await db.ClinicConsentTemplate.create({ id: 1001, public_id: 'owned_component_consent_1001', clinic_id: 66,
    name: 'Consentimiento PRP OWNED ficticio', purpose: 'clinical', status: 'active', validity_mode: 'single_act',
    blocking_policy: 'hard', requires_patient_signature: true, requires_professional_signature: true });
  await db.ClinicConsentTemplateVersion.create({ id: 2001, clinic_template_id: 1001, version: 1,
    title: 'Versión OWNED ficticia PRP', body_html: '<p>Texto OWNED ficticio {{paciente.nombre_completo}}.</p>',
    status: 'published', published_at: new Date() });
  await db.TreatmentConsentRequirement.create({ tratamiento_id: 688, clinica_id: 66,
    clinic_template_id: 1001, required: true, blocking_policy: 'hard' });

  const keys = new Map([[79, 'installation:80'], [75, 'installation:75']]);
  const resourceKeys = ['doctor:50', 'doctor:53', 'installation:75', 'installation:80', 'patient:8'];
  await db.AppointmentBookingResource.bulkCreate(resourceKeys.map(resource_key => ({ resource_key,
    resource_kind: resource_key.split(':')[0] })));
  const permissionCalls = [], resolverCalls = [];
  const canAccessFeature = async context => { permissionCalls.push(context); return true; };
  const resolveKeys = async ({ db: actualDb, clinic, installationIds, transaction, enabled }) => {
    assert.equal(actualDb, db); assert.equal(Number(clinic.id_clinica), 66); assert(transaction); assert.equal(enabled, true);
    assert(installationIds.every(id => keys.has(id)));
    resolverCalls.push({ installation_ids: installationIds, transaction: transaction.id });
    return { keys };
  };
  let serial = 0;
  const pair = async ({ childTreatmentId = null } = {}) => {
    const order = ++serial, sourceContactId = '800';
    const beginning = Math.floor((Date.now() - 30 * 60000) / 60000) * 60000;
    const create = async component => {
      const doctorId = component ? 53 : 50, installationId = component ? 79 : 75;
      const start = new Date(beginning + (component ? 0 : 15 * 60000)).toISOString();
      const end = new Date(Date.parse(start) + 30 * 60000).toISOString();
      const sourceId = String(10000 + order * 10 + (component ? 1 : 2));
      const receipt = { version: 'cliniccloud-source-booking/1', source_account: 'cliniccloud-5880',
        source_appointment_id: sourceId, source_contact_id: sourceContactId,
        preserved_start_at: start, preserved_end_at: end, automation_policy: 'hold',
        policy: 'preserve_source_interval_report_conflicts' };
      receipt.receipt_sha256 = hash(receipt);
      const row = await db.CitaPaciente.create({ clinica_id: 66, paciente_id: 8, doctor_id: doctorId,
        instalacion_id: installationId, tratamiento_id: component ? childTreatmentId : 688,
        created_by: doctorId, updated_by: doctorId, titulo: 'Cita fuente OWNED ficticia',
        nota: 'PRP OWNED ficticio; no datos ni instrucciones clínicas reales.', tipo_cita: 'continuacion', estado: 'info_confirmada',
        inicio: start, fin: end, source_system: 'cliniccloud', source_reference: 'delta:owned-component:' + sourceId,
        import_metadata: { source_account: 'cliniccloud-5880', source_appointment_id: sourceId,
          source_contact_id: sourceContactId, cliniccloud_source_booking: receipt,
          cliniccloud_reconciliation: { automation_policy: 'hold' },
          notification_suppression: { appointment_details: true, day_before: true, same_day: true },
          cliniccloud_delta: { pending_assignment: component && childTreatmentId == null ? ['treatment_id'] : [],
            source: { kind: 'appointment', source_external_id: sourceId, service_key: 'PRP OWNED ficticio',
              details: 'PRP OWNED ficticio', price: '120.00', start_utc: start, end_utc: end } },
          booking: { version: 1, profile: { version: 2, phases: [{ key: 'appointment', duration_minutes: 30,
            installation_ids: [installationId], professionals: { mode: 'any', ids: [doctorId], preferred_id: doctorId } }] },
          phases: [{ key: 'appointment', installation_id: installationId, doctor_ids: [doctorId],
            start_at: start, end_at: end, staff_time_scope: 'phase' }] } } });
      const occupancy = occupancyForSolution({ start_at: start, end_at: end, phases: row.import_metadata.booking.phases }, keys);
      await db.AppointmentBookingOccupancy.bulkCreate(occupancy.map(value => ({ ...value, appointment_id: row.id_cita })));
      return row;
    };
    return { child: await create(true), parent: await create(false) };
  };
  const request = async ({ child, parent }) => {
    await child.reload(); await parent.reload();
    return { parent_appointment_id: parent.id_cita, expected_version: components.reviewVersion(child),
      expected_parent_version: components.reviewVersion(parent),
      reason: 'Revisión OWNED ficticia de extracción y cita principal PRP fuente', confirm_source_roles: true,
      source_acknowledgements: { component: components.sourceAcknowledgement(child), parent: components.sourceAcknowledgement(parent) } };
  };
  const link = async rows => componentService.linkExistingComponent({ db, appointmentId: rows.child.id_cita,
    clinicId: 66, actorId: 53, input: await request(rows), canAccessFeature, resolveKeys });
  const validatedParent = async child => db.sequelize.transaction(async transaction => {
    const current = await db.CitaPaciente.findByPk(child.id_cita, { transaction, lock: transaction.LOCK.UPDATE });
    return componentService.getValidatedClinicalComponentParent({ db, appointment: current, transaction });
  });
  const prepareParent = rows => f.consents.createPackageForAppointment(rows.parent.id_cita, { createdBy: 50 });
  const signParent = async pkg => {
    for (const doc of pkg.documents) {
      await f.consents.signConsentDocument(doc.id, f.signature('OWNED-PRP-PATIENT'));
      await f.consents.signProfessionalConsentDocument(doc.id, { accepted_statement: true }, 50);
    }
  };
  const arrive = child => f.care.record({ appointmentId: child.id_cita, clinicId: 66, actorId: 53, action: 'arrive' });
  const start = child => f.care.record({ appointmentId: child.id_cita, clinicId: 66, actorId: 53, action: 'start' });
  const physicalSnapshot = async rows => {
    const appointments = [];
    for (const row of [rows.child, rows.parent]) appointments.push((await db.CitaPaciente.findByPk(row.id_cita)).toJSON());
    return { appointments, occupancy: await db.AppointmentBookingOccupancy.findAll({
      where: { appointment_id: { [db.Sequelize.Op.in]: appointments.map(row => row.id_cita) } }, order: [['id', 'ASC']], raw: true }),
    anchors: await db.AppointmentBookingResource.findAll({ order: [['resource_key', 'ASC']], raw: true }) };
  };
  return { ...f, pair, link, request, validatedParent, prepareParent, signParent, arrive, start, physicalSnapshot,
    permissionCalls, resolverCalls, components, componentService };
}

module.exports = { createOwnedDocumentationComponentFixture };
