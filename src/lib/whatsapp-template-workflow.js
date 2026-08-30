'use strict';

const REVIEW_WORKFLOW_USAGES = new Set([
  'solicitud_resena',
  'resena',
  'review_request',
  'reviews',
]);

const REVIEW_CATALOG_TEMPLATE_IDS = new Set([9, 32, 34]);
const ADMIN_ONLY_TEMPLATE_USAGES = new Set([
  'system_admin_alert',
]);

function cleanKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function getWhatsappTemplateUsages(template) {
  const values = [
    ...parseArray(template?.template_usages),
    ...parseArray(template?.variables).map((variable) => variable?.template_usage),
    ...parseArray(template?.catalog?.variables).map((variable) => variable?.template_usage),
  ];
  return Array.from(new Set(values.map(cleanKey).filter(Boolean)));
}

function isReviewWorkflowWhatsappTemplate(template) {
  const catalogTemplateId = Number(template?.catalog_template_id || template?.catalog?.id || 0);
  if (REVIEW_CATALOG_TEMPLATE_IDS.has(catalogTemplateId)) return true;
  if (getWhatsappTemplateUsages(template).some((usage) => REVIEW_WORKFLOW_USAGES.has(usage))) {
    return true;
  }

  const technicalNames = [
    template?.name,
    template?.catalog?.name,
  ].map(cleanKey).filter(Boolean);
  return technicalNames.some((name) => (
    name === 'clinicaclick_solicitar_resena'
    || name.startsWith('clinicaclick_solicitar_resena_v')
    || name === 'clinicaclick_solicitar_resena_foto'
    || name.startsWith('clinicaclick_solicitar_resena_foto_v')
    || name === 'clinicaclick_recordatorio_resena_sin_respuesta'
    || name.startsWith('clinicaclick_recordatorio_resena_sin_respuesta_v')
  ));
}

function isAdminOnlyWhatsappTemplate(template) {
  if (!template || typeof template !== 'object') return false;
  if (getWhatsappTemplateUsages(template).some((usage) => ADMIN_ONLY_TEMPLATE_USAGES.has(usage))) {
    return true;
  }

  const technicalNames = [
    template?.name,
    template?.catalog?.name,
  ].map(cleanKey).filter(Boolean);
  return technicalNames.some((name) => (
    name === 'clinicaclick_admin_alerta_sistema'
    || name.startsWith('clinicaclick_admin_alerta_sistema_v')
  ));
}

module.exports = {
  getWhatsappTemplateUsages,
  isAdminOnlyWhatsappTemplate,
  isReviewWorkflowWhatsappTemplate,
};
