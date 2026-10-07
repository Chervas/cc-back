'use strict';
const { catalogError } = require('./treatment-catalog-contract');
const { requiresMultiResourceBooking, pendingAttentionRequirements } = require('./booking-profile');

async function validateCatalogResources(treatment, db, { transaction, environment = process.env } = {}) {
  const historical = require('./historical-treatment-reference');
  if (historical.isHistoricalTreatment(treatment)) { historical.validateHistoricalReference(treatment); return; }
  const commercial = require('./treatment-commercial-policy');
  const included = commercial.saleMode(treatment) === 'program_component_only';
  if (included && treatment.precio_base !== null) throw catalogError('Un componente incluido no tiene tarifa individual.', 'component_standalone_price_forbidden', 422);
  if (included && !['draft', 'obsolete'].includes(treatment.clinical_config.catalog_status) && !commercial.componentApproved(treatment)) {
    throw catalogError('Aprueba expresamente el componente incluido antes de activarlo.', 'component_approval_required', 422);
  }
  if (treatment.clinical_config?.fiscal_mapping_pending === true && !['draft', 'obsolete'].includes(treatment.clinical_config.catalog_status)
      && !(included && commercial.componentApproved(treatment))) {
    throw catalogError('El precio del archivo incluye impuestos. Completa su revisión fiscal antes de ofrecer el tratamiento; puedes conservarlo como Borrador.', 'imported_treatment_fiscal_review_pending', 422);
  }
  const suppliedProfile = treatment.clinical_config?.booking_profile;
  if (!suppliedProfile) return;
  const draft = treatment.clinical_config.catalog_status === 'draft';
  const dormant = draft || treatment.clinical_config.catalog_status === 'obsolete';
  let profile = suppliedProfile;
  const compatible = environment.BOOKING_PROFILES_ENABLED === 'true'
    && (!requiresMultiResourceBooking(profile) || environment.BOOKING_MULTI_RESOURCE_ENABLED === 'true')
    && (profile.version !== 4 || (environment.BOOKING_MULTI_RESOURCE_ENABLED === 'true' && environment.BOOKING_PHASE_OFFSETS_ENABLED === 'true'));
  if (!compatible && (!dormant || treatment.activo === true)) {
    throw catalogError('Este perfil de cabinas y profesionales todavía no puede estar operativo. Selecciona Borrador para prepararlo; su activación requiere una agenda compatible en todos los entornos.', 'booking_profile_preparation_only', 409);
  }
  // Direct service callers must meet the same authoring contract as merge,
  // after the existing rollout gate. No interval or occupancy is manufactured
  // while minutes remain pending; the booking command checks the chosen time.
  if (!dormant || treatment.activo === true) {
    profile = require('./program-booking').normalizeProgramProfile(profile, { allowMissingDuration: true });
  }
  if ((!dormant || treatment.activo === true) && pendingAttentionRequirements(profile).length) {
    throw catalogError('Completa el tiempo de las intervenciones pendientes antes de ofrecer este tratamiento. Se puede conservar su configuración como Borrador.', 'pending_attention_requirements', 409);
  }
  if ((!dormant || treatment.activo === true) && profile.version === 4
    && profile.phases.some(phase => (phase.equipment_requirements || []).length > 1)) {
    throw catalogError('Define un paso por técnica para conservar la atención de cada máquina antes de ofrecer este tratamiento.', 'booking_profile_attention_ambiguous', 409);
  }
  const { Op } = db.Sequelize;
  if (treatment.origen === 'sistema') throw catalogError('Personaliza el tratamiento para una clínica antes de asignar cabinas o profesionales concretos.');
  const clinics = treatment.origen === 'grupo'
    ? await db.Clinica.findAll({ where: { grupoClinicaId: treatment.grupo_clinica_id }, attributes: ['id_clinica'], raw: true, transaction })
    : [{ id_clinica: Number(treatment.clinica_id) }];
  const clinicIds = clinics.map(clinic => Number(clinic.id_clinica)).filter(id => Number.isSafeInteger(id) && id > 0);
  if (!clinicIds.length) throw catalogError('El perfil de agenda necesita una clínica o grupo válido.');
  const installationIds = [...new Set(profile.phases.flatMap(phase => phase.installation_ids))];
  const doctorIds = [...new Set(profile.phases.flatMap(phase => phase.professionals.ids))];
  // Drafts may refer to inactive resources in scope, but never to another tenant's resources.
  const [installations, doctors] = await Promise.all([
    installationIds.length ? db.Instalacion.findAll({ where: { id: { [Op.in]: installationIds }, clinica_id: { [Op.in]: clinicIds }, ...(dormant ? {} : { activo: true }) }, attributes: ['id'], raw: true, transaction }) : [],
    doctorIds.length ? db.DoctorClinica.findAll({ where: { doctor_id: { [Op.in]: doctorIds }, clinica_id: { [Op.in]: clinicIds }, ...(dormant ? {} : { activo: true, recibe_citas: true }) }, attributes: ['doctor_id'], raw: true, transaction }) : [],
  ]);
  if (installationIds.some(id => !installations.some(row => Number(row.id) === id))) throw catalogError('Alguna cabina no pertenece al ámbito del tratamiento o no está activa.', 'treatment_installation_scope', 403);
  if (doctorIds.some(id => !doctors.some(row => Number(row.doctor_id) === id))) throw catalogError('Algún profesional no pertenece al ámbito del tratamiento o no recibe citas.', 'treatment_professional_scope', 403);
  if (require('./booking-equipment').equipmentIds(profile).length) {
    if (treatment.origen !== 'clinica') throw catalogError('Personaliza este tratamiento para cada clínica antes de asignarle máquinas físicas.', 'booking_equipment_clinic_required', 422);
    const { loadEquipmentContext, equipmentRuntimeEnabled } = require('../services/bookingEquipmentAvailability.service');
    if (!dormant && !equipmentRuntimeEnabled(environment)) throw catalogError('Conserva el tratamiento en borrador hasta publicar la reserva de maquinaria.', 'booking_equipment_preparation_only', 409);
    const clinic = await db.Clinica.findByPk(clinicIds[0], { transaction });
    const mapping = await require('../services/appointmentBookingAvailability.service').resolveInstallationKeys({ db, clinic, installationIds, transaction, enabled: true });
    const context = await loadEquipmentContext({ db, clinic, profile, mapping, transaction, enabled: true });
    if (!dormant) {
      const { equipmentFitsRoom } = require('./booking-equipment');
      for (const phase of profile.phases) if (!phase.installation_ids.some(id => {
        const resource_key = mapping.keys.get(id);
        const room = { resource_key, equipment_policy: context.roomPolicies.get(Number(resource_key.split(':')[1])) };
        return (phase.equipment_requirements || []).every(group => group.equipment_ids.some(eid => equipmentFitsRoom(context.equipment.get(eid), room)));
      })) throw catalogError('Alguna fase no tiene una cabina compatible con sus equipos. Puedes conservar el borrador.', 'booking_equipment_room_incompatible', 422);
    }
  }
}
module.exports = { validateCatalogResources };
