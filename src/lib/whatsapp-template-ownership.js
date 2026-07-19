'use strict';

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

const LEGACY_SYSTEM_TEMPLATE_NAMES = new Set([
  'clinicaclick_cita_formulario',
  'clinicaclick_confirmacion_cita',
  'clinicaclick_confirmacion_cita_v2',
  'clinicaclick_recordatorio_mismo_dia',
]);

function isSystemWhatsappTemplate(template) {
  if (!template || typeof template !== 'object') return false;
  if (template.is_system === true) return true;
  const origin = String(template.origin || '').trim().toLowerCase();
  const technicalName = String(template.name || '').trim().toLowerCase();
  return positiveInteger(template.catalog_template_id) !== null
    || origin === 'catalog'
    || LEGACY_SYSTEM_TEMPLATE_NAMES.has(technicalName);
}

function isWhatsappTemplateOwnedByUser(template, userId) {
  if (template?.is_owned_by_current_user === true) return true;
  const actorId = positiveInteger(userId);
  const creatorId = positiveInteger(template?.created_by_user_id);
  return actorId !== null && creatorId !== null && actorId === creatorId;
}

function isLegacyUnassignedWhatsappTemplate(template) {
  if (!template || typeof template !== 'object') return false;
  return !isSystemWhatsappTemplate(template)
    && positiveInteger(template.created_by_user_id) === null;
}

function canUserSelectWhatsappTemplate(template, userId) {
  return isSystemWhatsappTemplate(template)
    || isWhatsappTemplateOwnedByUser(template, userId)
    // Las plantillas anteriores a la captura de autoría siguen disponibles
    // dentro del scope de clínica/WABA que ya valida el controller. No se
    // presentan como "mías" y permanecen de solo lectura hasta una asignación
    // administrativa respaldada por evidencia.
    || isLegacyUnassignedWhatsappTemplate(template);
}

function filterWhatsappTemplatesForUser(templates, userId) {
  if (!Array.isArray(templates)) return [];
  return templates.filter((template) => canUserSelectWhatsappTemplate(template, userId));
}

function canUserAccessWhatsappTemplateAsset({
  asset,
  userId,
  accessibleClinicIds = [],
  accessibleGroupIds = [],
  isGlobalAdmin = false,
}) {
  if (!asset) return false;
  if (isGlobalAdmin) return true;

  const actorId = positiveInteger(userId);
  const clinicIds = new Set((Array.isArray(accessibleClinicIds) ? accessibleClinicIds : [])
    .map(positiveInteger)
    .filter(Boolean));
  const groupIds = new Set((Array.isArray(accessibleGroupIds) ? accessibleGroupIds : [])
    .map(positiveInteger)
    .filter(Boolean));
  const clinicId = positiveInteger(asset.clinicaId ?? asset.clinic_id);
  const groupId = positiveInteger(asset.grupoClinicaId ?? asset.group_id);
  const assignmentScope = String(asset.assignmentScope || asset.assignment_scope || '').trim().toLowerCase();
  const connectionOwnerId = positiveInteger(
    asset.metaConnection?.userId
      ?? asset.meta_connection_user_id
      ?? asset.connection_user_id
  );

  return (clinicId !== null && clinicIds.has(clinicId))
    || (assignmentScope === 'group' && groupId !== null && groupIds.has(groupId))
    || (assignmentScope === 'unassigned' && actorId !== null && actorId === connectionOwnerId);
}

module.exports = {
  canUserAccessWhatsappTemplateAsset,
  canUserSelectWhatsappTemplate,
  filterWhatsappTemplatesForUser,
  isLegacyUnassignedWhatsappTemplate,
  isSystemWhatsappTemplate,
  isWhatsappTemplateOwnedByUser,
  positiveInteger,
};
