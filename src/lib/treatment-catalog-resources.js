'use strict';
const { catalogError } = require('./treatment-catalog-contract');
const { requiresMultiResourceBooking } = require('./booking-profile');

async function validateCatalogResources(treatment, db, { transaction, environment = process.env } = {}) {
  const profile = treatment.clinical_config?.booking_profile;
  if (!profile) return;
  const draft = treatment.clinical_config.catalog_status === 'draft';
  const dormant = draft || treatment.clinical_config.catalog_status === 'obsolete';
  const compatible = environment.BOOKING_PROFILES_ENABLED === 'true'
    && (!requiresMultiResourceBooking(profile) || environment.BOOKING_MULTI_RESOURCE_ENABLED === 'true');
  if (!compatible && (!dormant || treatment.activo === true)) {
    throw catalogError('Este perfil de cabinas y profesionales todavía no puede estar operativo. Selecciona Borrador para prepararlo; su activación requiere una agenda compatible en todos los entornos.', 'booking_profile_preparation_only', 409);
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
}
module.exports = { validateCatalogResources };
