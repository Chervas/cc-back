'use strict';

const assert = require('node:assert/strict');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { occupancyForSolution } = require('../lib/booking-profile-solver');
const components = require('../lib/appointment-clinical-components');
const { PARENT_KEY, CHILDREN_KEY, ROLE, EVENT_TYPE, metadata, plain, jsonPlain, omit,
  positive, componentError, normalizeLink, reviewVersion, reservationFingerprint,
  assertPairRoles, componentContext } = components;
const fail = (suffix, message, status) => { throw componentError(suffix, message, status); };
const DEPENDENCIES = Object.freeze([['AppointmentClinicalReport', 'appointment_id'],
  ['PatientNutritionMeasurement', 'appointment_id'], ['PatientNutritionReport', 'appointment_id'],
  ['PatientConsentDocument', 'cita_id'], ['PatientVoucherMovement', 'appointment_id'], ['PatientProgramSession', 'appointment_id']]);
const permission = context => require('../lib/access-policy').canUserAccessFeature(context);
function occupancySignature(rows) {
  return hash(rows.map(raw => { const row = plain(raw); return [row.phase_key, row.resource_kind, row.resource_key,
    row.installation_id == null ? null : Number(row.installation_id), row.doctor_id == null ? null : Number(row.doctor_id),
    new Date(row.start_at).toISOString(), new Date(row.end_at).toISOString()]; }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
async function assertReservationOccupancy({ db, row, tx, clinic, resolveKeys }) {
  const actual = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: row.id_cita },
    order: [['id', 'ASC']], transaction: tx, lock: tx.LOCK.SHARE });
  const phases = metadata(row).booking.phases;
  const mapping = await resolveKeys({ db, clinic, installationIds: [...new Set(phases.map(phase => Number(phase.installation_id)))], transaction: tx, enabled: true });
  const expected = occupancyForSolution({ start_at: row.inicio, end_at: row.fin, phases }, mapping.keys);
  if (!actual.length || occupancySignature(actual) !== occupancySignature(expected)) fail('occupancy_unproven', 'La ocupación original requiere revisión; no se ha cambiado ninguna reserva.');
  return actual;
}
function unchangedAppointment(before, after) {
  return hash(jsonPlain(omit(before, ['import_metadata', 'updated_by', 'updated_at'])))
      === hash(jsonPlain(omit(after, ['import_metadata', 'updated_by', 'updated_at'])))
    && hash(omit(metadata(before), [PARENT_KEY, CHILDREN_KEY])) === hash(omit(metadata(after), [PARENT_KEY, CHILDREN_KEY]));
}
async function lockExistingReservationResources({ db, resourceKeys, transaction }) {
  if (!transaction || !db.AppointmentBookingResource) fail('resource_guard_unavailable', 'Falta la comprobación de recursos de la reserva.');
  for (const key of [...new Set(resourceKeys)].sort()) {
    if (!/^(doctor|installation|patient|equipment):[1-9]\d*$/.test(key)) fail('resource_unproven', 'Recurso de reserva no acreditado.');
    const row = await db.AppointmentBookingResource.findByPk(key, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row || row.resource_key !== key || row.resource_kind !== key.split(':')[0]) fail('resource_unproven', 'Falta el anclaje original de la reserva.');
  }
}

// Explicit relation creation. Permissions are checked here as well as by the
// HTTP adapter; an internal caller cannot skip clinical scope authorization.
// No solver, new appointment, treatment assignment, consent/signature, payment,
// program consumption, PatientFollowUp, notification or status event is used.
async function linkExistingComponent({ db, appointmentId, clinicId, actorId, input,
  transaction = null, canAccessFeature = permission,
  resolveKeys = args => require('./appointmentBookingAvailability.service').resolveInstallationKeys(args),
  lockResources = lockExistingReservationResources }) {
  const decision = normalizeLink(input);
  if (![appointmentId, clinicId, actorId].every(value => Number.isSafeInteger(value) && value > 0)
    || appointmentId === decision.parent_appointment_id) fail('invalid', 'Cita, clínica y usuario válidos son obligatorios.', 400);
  for (const featureKey of ['appointments.manage', 'patients.sensitive.view']) {
    if (!await canAccessFeature({ actorId, clinicId, featureKey })) fail('forbidden', 'No tienes permiso para revisar estas reservas clínicas.', 403);
  }
  const requestHash = hash({ appointment_id: appointmentId, clinic_id: clinicId, actor_id: actorId, ...decision });
  const execute = async tx => {
    if (tx.options?.isolationLevel !== 'READ COMMITTED') fail('transaction_invalid', 'La relación necesita una transacción de reserva canónica.', 409);
    const locked = new Map();
    for (const id of [appointmentId, decision.parent_appointment_id].sort((a, b) => a - b)) {
      const row = await db.CitaPaciente.findByPk(id, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!row || Number(row.clinica_id) !== clinicId) fail('not_found', 'Reserva no encontrada en esta clínica.', 404);
      locked.set(id, row);
    }
    const component = locked.get(appointmentId), parent = locked.get(decision.parent_appointment_id);
    const before = plain(component), parentBefore = plain(parent), cm = metadata(before), pm = metadata(parentBefore);
    const treatment = await db.Tratamiento.findByPk(parentBefore.tratamiento_id, { transaction: tx, lock: tx.LOCK.SHARE });
    if (cm[PARENT_KEY]) {
      const event = components.validReceipt(cm[PARENT_KEY])
        ? await db.PatientOperationalEvent.findByPk(cm[PARENT_KEY].audit_event_id, { transaction: tx, lock: tx.LOCK.SHARE }) : null;
      const context = componentContext({ component: before, parent: parentBefore, treatment, auditEvent: event });
      if (cm[PARENT_KEY].request_hash === requestHash && context?.status === 'linked') return { component, parent, relation: context, replayed: true };
      fail('already_linked', 'Esta extracción ya tiene una relación. Revisa su estado; esta acción no la reemplaza.');
    }
    if (cm[CHILDREN_KEY] != null || pm[PARENT_KEY] != null || pm[CHILDREN_KEY] != null) {
      fail('relation_exists', 'Una de las reservas ya tiene una relación clínica, incluso parcial. No se sustituye desde este recorrido.');
    }
    if (reviewVersion(before) !== decision.expected_version || reviewVersion(parentBefore) !== decision.expected_parent_version) {
      fail('changed', 'Una de las dos reservas ha cambiado. Vuelve a revisarlas antes de confirmar.');
    }
    const roles = assertPairRoles(before, parentBefore, treatment);
    if (hash(decision.source_acknowledgements.component) !== hash(roles.component)
      || hash(decision.source_acknowledgements.parent) !== hash(roles.parent)) fail('source_changed', 'Las referencias fuente ya no coinciden con las reservas.');
    for (const id of [appointmentId, decision.parent_appointment_id]) for (const [model, field] of DEPENDENCIES) {
      if (!db[model]) fail('history_guard_unavailable', 'Falta una comprobación de historia clínica o económica.');
      if (await db[model].findOne({ where: { [field]: id }, attributes: ['id'], transaction: tx, lock: tx.LOCK.SHARE })) {
        fail('history_exists', 'La reserva ya tiene historia clínica, documental o económica. Usa su recorrido de revisión.');
      }
    }
    const clinic = await db.Clinica.findByPk(clinicId, { transaction: tx, lock: tx.LOCK.SHARE });
    if (!clinic) fail('not_found', 'Clínica no encontrada.', 404);
    const ownOccupancy = await assertReservationOccupancy({ db, row: before, tx, clinic, resolveKeys });
    const parentOccupancy = await assertReservationOccupancy({ db, row: parentBefore, tx, clinic, resolveKeys });
    await lockResources({ db, resourceKeys: [...ownOccupancy, ...parentOccupancy].map(row => row.resource_key)
      .concat('patient:' + before.paciente_id), transaction: tx });
    const receipt = { version: components.SCHEMA_VERSION, role: ROLE,
      component_appointment_id: appointmentId, parent_appointment_id: decision.parent_appointment_id,
      patient_id: Number(before.paciente_id), clinic_id: clinicId, actor_id: actorId,
      reason: decision.reason, reviewed_at: new Date().toISOString(), request_hash: requestHash,
      component_fingerprint: reservationFingerprint(before), parent_fingerprint: reservationFingerprint(parentBefore),
      source_acknowledgements: { component: roles.component, parent: roles.parent }, primary_treatment_evidence: roles.treatment,
      planned_only: true, administration_inferred: false, individual_price_assigned: false,
      purchase_or_program_inferred: false, source_prices_preserved: true, primary_clinical_consent_required: true };
    const event = await db.PatientOperationalEvent.create({ patient_id: before.paciente_id, clinic_id: clinicId,
      actor_user_id: actorId, event_type: EVENT_TYPE, source: 'agenda', channel: null,
      metadata: { appointment_id: appointmentId, component_appointment_id: appointmentId, parent_appointment_id: decision.parent_appointment_id,
        role: ROLE, request_hash: requestHash, base_receipt_sha256: hash(receipt), reason: decision.reason,
        planned_only: true, administration_inferred: false, source_prices_preserved: true,
        no_booking_or_economic_effect: true }, occurred_at: new Date(receipt.reviewed_at) }, { transaction: tx });
    if (!event?.id || !/^[1-9][0-9]{0,19}$/.test(String(event.id))) fail('audit_unavailable', 'No se ha podido registrar la revisión clínica.');
    receipt.audit_event_id = String(event.id); receipt.receipt_sha256 = hash(receipt);
    await component.update({ updated_by: actorId, import_metadata: { ...cm, [PARENT_KEY]: receipt } },
      { transaction: tx, fields: ['updated_by', 'import_metadata', 'updated_at'], hooks: false });
    await parent.update({ updated_by: actorId, import_metadata: { ...pm, [CHILDREN_KEY]: [receipt] } },
      { transaction: tx, fields: ['updated_by', 'import_metadata', 'updated_at'], hooks: false });
    assert(unchangedAppointment(before, plain(component)) && unchangedAppointment(parentBefore, plain(parent)), 'clinical_component_reservation_changed');
    const context = componentContext({ component, parent, treatment, auditEvent: event });
    if (context?.status !== 'linked') fail('verification_failed', 'No se ha podido comprobar la relación recíproca.');
    return { component, parent, relation: context, replayed: false };
  };
  return transaction ? execute(transaction) : db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, execute);
}

// Bounded read-only enrichment for calendar/hub/detail DTOs. Never trusts a
// scalar marker or creates/repairs a relation while answering a GET.
async function attachClinicalComponentContexts({ db, appointments, transaction = null }) {
  const list = Array.isArray(appointments) ? appointments : appointments ? [appointments] : [];
  const pending = list.filter(row => metadata(row)[PARENT_KEY] != null);
  if (pending.length > 1000) fail('read_scope_exceeded', 'Reduce el intervalo para revisar las relaciones clínicas.', 400);
  const parentIds = [...new Set(pending.map(row => Number(metadata(row)[PARENT_KEY]?.parent_appointment_id)).filter(positive))];
  const eventIds = [...new Set(pending.map(row => String(metadata(row)[PARENT_KEY]?.audit_event_id || '')).filter(value => /^[1-9][0-9]{0,19}$/.test(value)))];
  const clinicIds = [...new Set(pending.map(row => Number(plain(row)?.clinica_id)).filter(positive))];
  const patientIds = [...new Set(pending.map(row => Number(plain(row)?.paciente_id)).filter(positive))];
  const parents = parentIds.length && clinicIds.length && patientIds.length ? await db.CitaPaciente.findAll({ where: {
    id_cita: { [db.Sequelize.Op.in]: parentIds }, clinica_id: { [db.Sequelize.Op.in]: clinicIds },
    paciente_id: { [db.Sequelize.Op.in]: patientIds } }, transaction }) : [];
  const events = eventIds.length && clinicIds.length && patientIds.length ? await db.PatientOperationalEvent.findAll({ where: {
    id: { [db.Sequelize.Op.in]: eventIds }, clinic_id: { [db.Sequelize.Op.in]: clinicIds },
    patient_id: { [db.Sequelize.Op.in]: patientIds } }, transaction }) : [];
  const treatmentIds = [...new Set(parents.map(row => Number(plain(row).tratamiento_id)).filter(positive))];
  const treatments = treatmentIds.length ? await db.Tratamiento.findAll({ where: { id_tratamiento: { [db.Sequelize.Op.in]: treatmentIds } }, transaction }) : [];
  const parentMap = new Map(parents.map(row => [Number(plain(row).id_cita), row]));
  const eventMap = new Map(events.map(row => [String(plain(row).id), row]));
  const treatmentMap = new Map(treatments.map(row => [Number(plain(row).id_tratamiento), row]));
  for (const row of list) {
    const marker = metadata(row)[PARENT_KEY], parent = parentMap.get(Number(marker?.parent_appointment_id));
    const context = marker ? componentContext({ component: row, parent,
      treatment: treatmentMap.get(Number(plain(parent)?.tratamiento_id)), auditEvent: eventMap.get(String(marker.audit_event_id)) }) : null;
    if (typeof row.setDataValue === 'function') row.setDataValue('clinical_component_context', context);
    else row.clinical_component_context = context;
  }
  return appointments;
}

// Care callers must re-read authoritative records under their transaction,
// never reuse a calendar DTO. This only identifies the existing consent scope:
// it neither approves care nor returns/invents a signature.
async function getValidatedClinicalComponentParent({ db, appointment, transaction }) {
  const value = plain(appointment), marker = metadata(value)[PARENT_KEY];
  if (!marker) return null;
  if (!transaction) fail('transaction_required', 'Revisa la relación dentro de la transacción clínica.');
  if (!positive(value?.id_cita) || !positive(value.clinica_id) || !positive(value.paciente_id) || !components.validReceipt(marker)) {
    fail('relation_unproven', 'La relación clínica necesita revisión.');
  }
  const component = await db.CitaPaciente.findByPk(value.id_cita, { transaction, lock: transaction.LOCK.SHARE });
  const current = plain(component), receipt = metadata(current)[PARENT_KEY];
  if (!component || Number(current.clinica_id) !== Number(value.clinica_id) || Number(current.paciente_id) !== Number(value.paciente_id)
    || !components.validReceipt(receipt)) fail('relation_unproven', 'La relación clínica necesita revisión.');
  const parent = await db.CitaPaciente.findByPk(receipt.parent_appointment_id, { transaction, lock: transaction.LOCK.SHARE });
  const treatment = plain(parent)?.tratamiento_id
    ? await db.Tratamiento.findByPk(plain(parent).tratamiento_id, { transaction, lock: transaction.LOCK.SHARE }) : null;
  const event = await db.PatientOperationalEvent.findByPk(receipt.audit_event_id, { transaction, lock: transaction.LOCK.SHARE });
  const context = componentContext({ component, parent, treatment, auditEvent: event });
  if (!components.isValidatedClinicalComponentContext(context, current)) fail('relation_unproven', 'La relación clínica necesita revisión antes de atender la extracción.');
  return { parent, context, component };
}

module.exports = { DEPENDENCIES, occupancySignature, assertReservationOccupancy, unchangedAppointment,
  lockExistingReservationResources, linkExistingComponent, attachClinicalComponentContexts,
  loadClinicalComponentContexts: attachClinicalComponentContexts, getValidatedClinicalComponentParent };
