'use strict';

const axios = require('axios');
const { Op } = require('sequelize');
const db = require('../../models');
const { queues } = require('./queue.service');
const jobRequestsService = require('./jobRequests.service');
const { recomposeAutomationsUsingTemplate } = require('./whatsappTemplateAutomationSync.service');
const {
  haveSameTemplateComponents,
  stringifyComparableTemplateComponents,
} = require('../lib/whatsapp-template-components');
const {
  resolveEffectiveWabaForClinic,
} = require('../lib/whatsapp-template-catalog-coverage');
const {
  DEFAULT_PENDING_THRESHOLD_MS,
  evaluatePendingTemplateAutoResubmit,
  buildPendingTemplateResubmitDedupeScope,
  shouldKeepRemoteTemplateActive,
} = require('../lib/whatsapp-template-pending-resubmission');
const {
  normalizeWhatsappLocale,
  resolveCatalogLocale,
  resolveCatalogFamilyKey,
  resolveMetaTemplateLanguage,
} = require('../lib/whatsapp-template-locale');
const {
  acquireWabaCatalogCreationLease,
} = require('../lib/waba-catalog-creation-lease');

const {
  ClinicMetaAsset,
  Clinica,
  MarketingPatientList,
  MetaConnection,
  WhatsappTemplate,
  WhatsappTemplateCatalog,
  WhatsappTemplateCatalogDiscipline,
} = db;

const META_GRAPH_BASE = process.env.META_GRAPH_BASE_URL || process.env.META_API_BASE_URL || 'https://graph.facebook.com';
const META_API_VERSION = process.env.META_API_VERSION || 'v24.0';
const META_APP_ID = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '1807844546609897';
const DEFAULT_LANGUAGE = process.env.META_WHATSAPP_TEMPLATE_LANGUAGE || 'es';
const DEFAULT_PROPAGATE_RESYNC_DELAY_MINUTES = Math.max(
  1,
  parseInt(process.env.WHATSAPP_PROPAGATE_RESYNC_DELAY_MINUTES || '12', 10) || 12,
);
const WHATSAPP_TEMPLATE_STATUS = {
  LOCAL_PENDING: 'PENDING_LOCAL',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  DISCONNECTED: 'SIN_CONECTAR',
};
const WHATSAPP_TEMPLATE_BODY_MAX_LENGTH = 1024;
const WHATSAPP_TEMPLATE_IMAGE_HEADER_MAX_BYTES = 5 * 1024 * 1024;
const AUTO_RESUBMIT_PENDING_THRESHOLD_MS = Math.max(
  1,
  Number(process.env.WHATSAPP_TEMPLATE_AUTO_RESUBMIT_PENDING_MINUTES || 60) || 60,
) * 60 * 1000;
const AUTO_RESUBMIT_ENABLED = !['0', 'false', 'no', 'off'].includes(
  String(process.env.WHATSAPP_TEMPLATE_AUTO_RESUBMIT_ENABLED ?? 'true').trim().toLowerCase(),
);

function resolveGraphBase() {
  const base = META_GRAPH_BASE.replace(/\/+$/, '');
  if (/\/v\d+\.\d+$/i.test(base)) {
    return base;
  }
  return `${base}/${META_API_VERSION}`;
}

function graphUrl(path) {
  return `${resolveGraphBase()}/${path}`;
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function normalizeTemplateComponentsForMeta(value) {
  const components = parseMaybeJson(value) || [];
  if (!Array.isArray(components)) return [];

  return components.map((component) => {
    if (!component || typeof component !== 'object') return component;
    const type = String(component.type || '').trim().toUpperCase();
    if (type !== 'BODY' || typeof component.text !== 'string') {
      return { ...component };
    }
    return {
      ...component,
      text: component.text.trim(),
    };
  });
}

function findImageHeaderComponent(components) {
  const parsed = Array.isArray(components) ? components : normalizeTemplateComponentsForMeta(components);
  return parsed.find((component) => {
    const type = String(component?.type || '').trim().toUpperCase();
    const format = String(component?.format || '').trim().toUpperCase();
    return type === 'HEADER' && format === 'IMAGE';
  }) || null;
}

function resolveConfiguredTemplateImageHeaderHandle() {
  return cleanString(
    process.env.WHATSAPP_REVIEW_TEMPLATE_HEADER_HANDLE ||
    process.env.WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE ||
    ''
  );
}

function extractImageHeaderSample(template) {
  const components = normalizeTemplateComponentsForMeta(template?.components);
  const imageHeader = findImageHeaderComponent(components);
  const headerHandle = imageHeader?.example?.header_handle;
  return cleanString(Array.isArray(headerHandle) ? headerHandle[0] : headerHandle);
}

function getImageHeaderSampleIssue(template) {
  const components = normalizeTemplateComponentsForMeta(template?.components);
  const imageHeader = findImageHeaderComponent(components);
  if (!imageHeader) return null;

  const sample = extractImageHeaderSample({ components });
  if (!sample) return 'missing_image_header_sample';
  if (/^https?:\/\//i.test(sample)) return 'image_header_sample_must_be_meta_handle';
  return null;
}

function buildImageHeaderSamplePendingReason(issue) {
  if (issue === 'image_header_sample_upload_failed') {
    return 'No se pudo preparar el media handle de ejemplo requerido por Meta para la cabecera de imagen. Revisa la URL publica de ejemplo, el token de WhatsApp y META_APP_ID antes de reenviar a revision.';
  }
  if (issue === 'image_header_sample_must_be_meta_handle') {
    return 'La plantilla tiene cabecera de imagen, pero Meta requiere un media handle de ejemplo, no una URL publica. El backend intentara generarlo automaticamente desde la URL publica; si falla, configura WHATSAPP_REVIEW_TEMPLATE_HEADER_HANDLE o WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE.';
  }
  return 'La plantilla tiene cabecera de imagen, pero falta el media handle de ejemplo requerido por Meta. Configura WHATSAPP_REVIEW_TEMPLATE_HEADER_HANDLE o WHATSAPP_TEMPLATE_IMAGE_HEADER_HANDLE antes de enviarla a revision.';
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTemplateKey(value) {
  return cleanString(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildCustomTemplateTechnicalName(displayName) {
  const base = normalizeTemplateKey(displayName).slice(0, 64) || 'plantilla_whatsapp';
  const suffix = Date.now().toString(36).slice(-8);
  return `cc_${base}_${suffix}`.slice(0, 100);
}

function isReviewRequestUsage(value) {
  return ['solicitud_resena', 'resena', 'review_request', 'reviews'].includes(normalizeTemplateKey(value));
}

function templateHasImageHeader(template) {
  const components = normalizeTemplateComponentsForMeta(template?.components);
  return components.some((component) => {
    const type = String(component?.type || '').trim().toUpperCase();
    const format = String(component?.format || '').trim().toUpperCase();
    return type === 'HEADER' && format === 'IMAGE';
  });
}

function isReviewPhotoTemplate(template, catalog = null) {
  if (!templateHasImageHeader(template)) return false;
  const searchable = [
    template?.name,
    template?.display_name,
    catalog?.name,
  ].map((value) => normalizeTemplateKey(value)).join('_');
  return searchable.includes('resena') || searchable.includes('review');
}

function isReviewRequestTemplateFamily(template, catalog = null) {
  const names = [
    template?.name,
    template?.display_name,
    catalog?.name,
    catalog?.display_name,
  ].map((value) => normalizeTemplateKey(value)).filter(Boolean);

  return names.some((name) => (
    name === 'clinicaclick_solicitar_resena'
    || name === 'clinicaclick_solicitar_resena_foto'
    || name === 'clinicaclick_recordatorio_resena_sin_respuesta'
    || isTechnicalTemplateFamilyName('clinicaclick_solicitar_resena', name)
    || isTechnicalTemplateFamilyName('clinicaclick_solicitar_resena_foto', name)
    || isTechnicalTemplateFamilyName('clinicaclick_recordatorio_resena_sin_respuesta', name)
  ));
}

function isReviewReminderTemplateFamily(template, catalog = null) {
  const names = [
    template?.name,
    template?.display_name,
    catalog?.name,
    catalog?.display_name,
  ].map((value) => normalizeTemplateKey(value)).filter(Boolean);

  return names.some((name) => (
    name === 'clinicaclick_recordatorio_resena_sin_respuesta'
    || isTechnicalTemplateFamilyName('clinicaclick_recordatorio_resena_sin_respuesta', name)
  ));
}

function reviewTemplateBodyHasSender(value) {
  const raw = cleanString(value);
  const normalized = normalizeTemplateKey(raw);
  return /soy\s+\{\{\s*3\s*\}\}/i.test(raw)
    || normalized.includes('firma_resenas')
    || normalized.includes('remitente_resena')
    || normalized.includes('nombre_remitente_resenas')
    || normalized.includes('review_sender_name');
}

function isStaleReviewRequestTemplate(template, catalog = null) {
  if (!isReviewRequestTemplateFamily(template, catalog)) return false;
  const templateBody = cleanString(extractTemplateBodyText(template?.components));
  const catalogBody = cleanString(catalog?.body_text);
  if (catalogBody && templateBody && templateBody !== catalogBody) return true;
  if (isReviewReminderTemplateFamily(template, catalog)) return false;
  return !reviewTemplateBodyHasSender(templateBody);
}

async function notifyReviewPhotoTemplateApproved(template, catalog = null) {
  if (!isReviewPhotoTemplate(template, catalog)) return;
  if (Number(template?.catalog_template_id || catalog?.id || 0) > 0) return;
  const clinicId = Number(template?.clinic_id || 0);
  if (!Number.isInteger(clinicId) || clinicId <= 0) return;

  try {
    const notificationService = require('./notifications.service');
    const clinic = await Clinica.findByPk(clinicId, {
      attributes: ['id_clinica', 'nombre_clinica'],
      raw: true,
    });
    await notificationService.dispatchEvent({
      event: 'whatsapp.review_photo_template_approved',
      clinicId,
      data: {
        clinicName: clinic?.nombre_clinica || 'tu clínica',
        templateName: template?.display_name || template?.name || catalog?.name || 'plantilla de reseñas con foto',
        link: '/marketing/campanas?objective=get_reviews&review_step=summary',
        useRouter: true,
      },
    });
  } catch (error) {
    console.warn('[whatsapp-templates] No se pudo notificar aprobación de plantilla de reseñas con foto', {
      template_id: template?.id || null,
      clinic_id: clinicId,
      error: error?.message || error,
    });
  }
}

function buildCustomTemplateExtraComponents({ templateUsage }) {
  return [];
}

function annotateTemplateVariables(variables = [], templateUsage = null) {
  const base = Array.isArray(variables) ? variables.map((variable) => ({ ...variable })) : [];
  const normalizedUsage = normalizeTemplateKey(templateUsage);
  if (!normalizedUsage) {
    return base;
  }

  return base.map((variable) => ({
    ...variable,
    template_usage: normalizedUsage,
  }));
}

function buildVariableContractFromBody(bodyText, rawVariables = []) {
  const explicit = Array.isArray(rawVariables) ? rawVariables : [];
  const explicitByKey = new Map(
    explicit
      .map((variable) => {
        const key = normalizeTemplateKey(variable?.key || variable?.name || variable?.variable);
        return key ? [key, variable] : null;
      })
      .filter(Boolean)
  );
  const variables = [];
  const seen = new Map();
  const replacedBody = cleanString(bodyText).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey) => {
    const key = normalizeTemplateKey(rawKey);
    if (!key) return '';
    if (!seen.has(key)) {
      seen.set(key, seen.size + 1);
      const source = explicitByKey.get(key) || {};
      variables.push({
        index: seen.get(key),
        position: seen.get(key),
        name: key,
        example: cleanString(source.example) || key.split('_').join(' '),
        description: cleanString(source.description || source.label) || `Variable ${key}`,
      });
    }
    return `{{${seen.get(key)}}}`;
  });
  return { body: replacedBody, variables };
}

function createTemplateValidationError(details) {
  const error = new Error('invalid_template_body');
  error.code = 'invalid_template_body';
  error.statusCode = 400;
  error.details = Array.isArray(details) ? details : [String(details || 'La plantilla no cumple las reglas de WhatsApp.')];
  return error;
}

function validateTemplateBodyForMeta(bodyText) {
  const text = cleanString(bodyText);
  const issues = [];
  if (!text) {
    issues.push('El cuerpo de la plantilla no puede estar vacío.');
    return issues;
  }
  if (text.length > WHATSAPP_TEMPLATE_BODY_MAX_LENGTH) {
    issues.push(`El mensaje tiene ${text.length} caracteres. WhatsApp permite un máximo de ${WHATSAPP_TEMPLATE_BODY_MAX_LENGTH} en el cuerpo de una plantilla.`);
  }
  if (/^\s*\{\{\d+\}\}/.test(text)) {
    issues.push('WhatsApp no permite que el cuerpo empiece por una variable. Añade texto fijo antes.');
  }
  if (/\{\{\d+\}\}\s*$/.test(text)) {
    issues.push('WhatsApp no permite que el cuerpo termine en una variable. Añade texto fijo después.');
  }
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(text)) {
    issues.push('WhatsApp no permite variables consecutivas sin texto fijo entre ellas.');
  }
  return issues;
}

function hasSameMetaFacingContent(template, instance) {
  if (!template || !instance) return false;
  return (
    String(template.category || '').trim().toUpperCase() === String(instance.category || '').trim().toUpperCase()
    && stringifyComparableTemplateComponents(template.components) === stringifyComparableTemplateComponents(instance.components)
  );
}

function hasSameMetaFacingContract(template, instance) {
  if (!template || !instance) return false;
  return (
    String(template.name || '').trim() === String(instance.name || '').trim()
    && hasSameMetaFacingContent(template, instance)
  );
}

function getCatalogTemplateLanguage(template) {
  return resolveMetaTemplateLanguage(
    resolveCatalogLocale(template, normalizeWhatsappLocale(DEFAULT_LANGUAGE, { fallback: 'es' }) || 'es')
  );
}

function getCatalogTechnicalFamilyName(template) {
  return resolveCatalogFamilyKey(template) || cleanString(template?.name);
}

function buildVersionedTechnicalTemplateName(baseName, version) {
  const safeBaseName = cleanString(baseName);
  if (!safeBaseName) return '';
  const safeVersion = Number(version);
  if (!Number.isFinite(safeVersion) || safeVersion <= 1) {
    return safeBaseName;
  }
  return `${safeBaseName}_v${safeVersion}`;
}

function extractTechnicalTemplateVersion(baseName, candidateName) {
  const safeBaseName = cleanString(baseName);
  const safeCandidate = cleanString(candidateName);
  if (!safeBaseName || !safeCandidate) return null;
  if (safeCandidate === safeBaseName) return 1;
  const match = safeCandidate.match(/^(.*)_v(\d+)$/i);
  if (!match) return null;
  if (cleanString(match[1]) !== safeBaseName) return null;
  const parsed = Number(match[2]);
  return Number.isFinite(parsed) && parsed >= 2 ? parsed : null;
}

function isTechnicalTemplateFamilyName(baseName, candidateName) {
  return Number.isFinite(extractTechnicalTemplateVersion(baseName, candidateName));
}

function resolveNextTechnicalTemplateName(baseName, familyRows = []) {
  const safeBaseName = cleanString(baseName);
  if (!safeBaseName) return '';
  if (!Array.isArray(familyRows) || !familyRows.length) {
    return safeBaseName;
  }
  const versions = familyRows
    .map((row) => extractTechnicalTemplateVersion(baseName, row?.name))
    .filter((value) => Number.isFinite(value));
  const maxVersion = versions.length ? Math.max(...versions) : 1;
  return buildVersionedTechnicalTemplateName(safeBaseName, maxVersion + 1);
}

function mapRemoteStatusToLocalStatus(remoteStatus) {
  const normalized = String(remoteStatus || '').trim().toUpperCase();
  switch (normalized) {
    case 'APPROVED':
      return WHATSAPP_TEMPLATE_STATUS.APPROVED;
    case 'PENDING':
    case 'IN_REVIEW':
      return WHATSAPP_TEMPLATE_STATUS.PENDING;
    case 'REJECTED':
    case 'DISAPPROVED':
    case 'DECLINED':
      return WHATSAPP_TEMPLATE_STATUS.REJECTED;
    case 'SIN_CONECTAR':
      return WHATSAPP_TEMPLATE_STATUS.DISCONNECTED;
    default:
      return normalized || WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING;
  }
}

async function findLatestLocalTemplateForClinic({ clinicId, template }) {
  if (!clinicId || !template) return null;
  const language = getCatalogTemplateLanguage(template);
  const familyName = getCatalogTechnicalFamilyName(template);
  const candidates = await WhatsappTemplate.findAll({
    where: {
      clinic_id: clinicId,
      waba_id: null,
      language,
      is_active: true,
      [Op.or]: [
        ...(Number.isFinite(Number(template.id)) && Number(template.id) > 0
          ? [{ catalog_template_id: Number(template.id) }]
          : []),
        { name: familyName },
        { name: { [Op.like]: `${familyName}%` } },
      ],
    },
    order: [['updatedAt', 'DESC']],
  });

  return candidates.find((row) => {
    const catalogId = Number(row?.catalog_template_id);
    if (Number.isFinite(catalogId) && catalogId > 0 && catalogId === Number(template.id)) {
      return true;
    }
    return isTechnicalTemplateFamilyName(familyName, row?.name);
  }) || null;
}

async function loadTemplateFamilyRows({ clinicId, wabaId, template }) {
  if (!template) return [];
  const language = getCatalogTemplateLanguage(template);
  const familyName = getCatalogTechnicalFamilyName(template);
  const rows = await WhatsappTemplate.findAll({
    where: {
      language,
      is_active: true,
      [Op.or]: [
        ...(Number.isFinite(Number(template.id)) && Number(template.id) > 0
          ? [{ catalog_template_id: Number(template.id) }]
          : []),
        ...(wabaId
          ? [{
              waba_id: String(wabaId),
              name: { [Op.like]: `${familyName}%` },
            }]
          : []),
        ...(clinicId
          ? [{
              clinic_id: clinicId,
              waba_id: null,
              name: { [Op.like]: `${familyName}%` },
            }]
          : []),
      ],
    },
    order: [['updatedAt', 'DESC']],
  });

  return rows.filter((row) => {
    const catalogId = Number(row?.catalog_template_id);
    if (Number.isFinite(catalogId) && catalogId > 0 && catalogId === Number(template.id)) {
      return true;
    }
    return isTechnicalTemplateFamilyName(familyName, row?.name);
  });
}

function findSameContractRemoteTemplate({ familyRows, wabaId, template }) {
  const safeWabaId = wabaId ? String(wabaId) : '';
  const matches = familyRows
    .filter((row) => {
      const status = String(row?.status || '').trim().toUpperCase();
      const hasRemoteIdentity = !!cleanString(row?.meta_template_id);
      return (
        String(row?.waba_id || '') === safeWabaId &&
        hasRemoteIdentity &&
        ![WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING, WHATSAPP_TEMPLATE_STATUS.DISCONNECTED].includes(status) &&
        hasSameMetaFacingContent(template, row)
      );
    })
    .sort((left, right) => {
      const score = (row) => {
        const status = String(row?.status || '').trim().toUpperCase();
        if (status === WHATSAPP_TEMPLATE_STATUS.APPROVED) return 3;
        if (status === WHATSAPP_TEMPLATE_STATUS.PENDING || status === 'IN_REVIEW') return 2;
        if (status === WHATSAPP_TEMPLATE_STATUS.REJECTED) return 1;
        return 0;
      };
      const diff = score(right) - score(left);
      if (diff !== 0) return diff;
      return new Date(right?.updatedAt || 0).getTime() - new Date(left?.updatedAt || 0).getTime();
    });
  return matches[0] || null;
}

function buildTemplateForTechnicalName(template, technicalName) {
  const baseTemplate = template?.toJSON ? template.toJSON() : template;
  return {
    ...baseTemplate,
    name: cleanString(technicalName) || cleanString(baseTemplate?.name),
    body_text: cleanString(baseTemplate?.body_text),
    components: normalizeTemplateComponentsForMeta(baseTemplate?.components),
  };
}

function resolveCatalogTemplateByTechnicalName(catalogs, technicalName, language = null) {
  const safeTechnicalName = cleanString(technicalName);
  if (!safeTechnicalName || !Array.isArray(catalogs) || !catalogs.length) return null;
  const locale = normalizeWhatsappLocale(language);
  const matches = catalogs.filter((catalog) => (
    (!locale || resolveCatalogLocale(catalog, 'es') === locale)
    && isTechnicalTemplateFamilyName(getCatalogTechnicalFamilyName(catalog), safeTechnicalName)
  ));
  if (!matches.length) return null;
  matches.sort((left, right) => String(getCatalogTechnicalFamilyName(right) || '').length - String(getCatalogTechnicalFamilyName(left) || '').length);
  return matches[0] || null;
}

function normalizeDisciplines(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return [];
}

function templateAppliesToDisciplines(template, disciplinas) {
  if (!template) return false;
  if (template.is_generic) return true;
  const templateDisciplines = normalizeDisciplines(
    template.disciplinas?.map((d) => d.disciplina_code)
  );
  if (!templateDisciplines.length) return false;
  const effectiveDisciplines = normalizeDisciplines(disciplinas);
  return effectiveDisciplines.some((code) => templateDisciplines.includes(code));
}

function isRetryableMetaError(err) {
  if (err?.retryable === true) return true;
  const status = err?.response?.status;
  if (status && (status >= 500 || status === 429)) {
    return true;
  }
  return false;
}

function isDuplicateTemplateNameError(err) {
  const parsed = parseMetaError(err);
  const haystack = [
    parsed?.message,
    parsed?.userTitle,
    parsed?.userMessage,
  ].map((value) => cleanString(value).toLowerCase()).filter(Boolean).join(' ');
  return (
    Number(parsed?.subcode) === 2388024
    || (haystack.includes('template') && (
      haystack.includes('already exists')
      || haystack.includes('duplicate')
      || haystack.includes('name is already')
      || haystack.includes('nombre ya existe')
    ))
  );
}

function buildMetaTemplateCheckpointPendingError(cause) {
  const error = new Error('whatsapp_template_meta_checkpoint_pending');
  error.code = 'whatsapp_template_meta_checkpoint_pending';
  error.retryable = true;
  error.cause = cause;
  return error;
}

function parseMetaError(err) {
  const base = err?.response?.data || err?.message || err;
  const nestedError = base?.error?.error || base?.error || base;
  const code = nestedError?.code || null;
  const message = nestedError?.message || String(base?.message || base || '');
  return {
    code,
    subcode: nestedError?.error_subcode || nestedError?.subcode || null,
    message,
    userTitle: nestedError?.error_user_title || null,
    userMessage: nestedError?.error_user_msg || null,
    raw: base,
  };
}

function guessFileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const lastPath = parsed.pathname.split('/').filter(Boolean).pop();
    return cleanString(lastPath) || 'template-header-image.jpg';
  } catch {
    return 'template-header-image.jpg';
  }
}

function normalizeImageContentType(value, fallbackName = '') {
  const raw = cleanString(value).split(';')[0].trim().toLowerCase();
  if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(raw)) {
    return raw === 'image/jpg' ? 'image/jpeg' : raw;
  }
  const name = cleanString(fallbackName).toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

async function downloadTemplateHeaderImage(sampleUrl) {
  if (!/^https:\/\//i.test(sampleUrl)) {
    throw new Error('template_image_header_sample_must_be_https');
  }

  const response = await axios.get(sampleUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxBodyLength: WHATSAPP_TEMPLATE_IMAGE_HEADER_MAX_BYTES,
    maxContentLength: WHATSAPP_TEMPLATE_IMAGE_HEADER_MAX_BYTES,
  });
  const buffer = Buffer.from(response.data || []);
  if (!buffer.length) {
    throw new Error('template_image_header_sample_empty');
  }
  if (buffer.length > WHATSAPP_TEMPLATE_IMAGE_HEADER_MAX_BYTES) {
    throw new Error('template_image_header_sample_too_large');
  }

  const fileName = guessFileNameFromUrl(sampleUrl);
  return {
    buffer,
    fileName,
    contentType: normalizeImageContentType(response.headers?.['content-type'], fileName),
  };
}

async function uploadTemplateHeaderImageHandleToMeta({ accessToken, sampleUrl, logger = console }) {
  const safeAccessToken = cleanString(accessToken);
  if (!safeAccessToken) {
    throw new Error('whatsapp_template_header_upload_missing_access_token');
  }
  if (!META_APP_ID) {
    throw new Error('whatsapp_template_header_upload_missing_meta_app_id');
  }

  const image = await downloadTemplateHeaderImage(sampleUrl);
  const uploadSession = await axios.post(
    graphUrl(`${META_APP_ID}/uploads`),
    null,
    {
      params: {
        file_name: image.fileName,
        file_length: image.buffer.length,
        file_type: image.contentType,
        access_token: safeAccessToken,
      },
      timeout: 30000,
    }
  );

  const uploadSessionId = cleanString(uploadSession?.data?.id);
  if (!uploadSessionId) {
    throw new Error('whatsapp_template_header_upload_session_missing');
  }

  const uploadResponse = await axios.post(
    graphUrl(uploadSessionId),
    image.buffer,
    {
      headers: {
        Authorization: `OAuth ${safeAccessToken}`,
        file_offset: '0',
        'Content-Type': image.contentType,
      },
      timeout: 30000,
      maxBodyLength: WHATSAPP_TEMPLATE_IMAGE_HEADER_MAX_BYTES,
      maxContentLength: WHATSAPP_TEMPLATE_IMAGE_HEADER_MAX_BYTES,
    }
  );

  const mediaHandle = cleanString(uploadResponse?.data?.h || uploadResponse?.data?.handle || uploadResponse?.data?.id);
  if (!mediaHandle) {
    throw new Error('whatsapp_template_header_media_handle_missing');
  }

  logger.info?.('[whatsapp-templates] Media handle de cabecera generado para revision de plantilla', {
    fileName: image.fileName,
    contentType: image.contentType,
    bytes: image.buffer.length,
  });

  return mediaHandle;
}

function replaceImageHeaderHandleInComponents(components, mediaHandle) {
  const safeHandle = cleanString(mediaHandle);
  if (!safeHandle) return components;
  return normalizeTemplateComponentsForMeta(components).map((component) => {
    const type = String(component?.type || '').trim().toUpperCase();
    const format = String(component?.format || '').trim().toUpperCase();
    if (type !== 'HEADER' || format !== 'IMAGE') {
      return component;
    }
    return {
      ...component,
      example: {
        ...(component.example || {}),
        header_handle: [safeHandle],
      },
    };
  });
}

async function prepareTemplateImageHeaderForMeta({ template, accessToken, logger = console }) {
  const components = normalizeTemplateComponentsForMeta(template?.components);
  if (!findImageHeaderComponent(components)) {
    return { template: { ...template, components }, issue: null };
  }

  const currentSample = extractImageHeaderSample({ components });
  if (currentSample && !/^https?:\/\//i.test(currentSample)) {
    return { template: { ...template, components }, issue: null };
  }

  const configuredHandle = resolveConfiguredTemplateImageHeaderHandle();
  if (configuredHandle) {
    return {
      template: {
        ...template,
        components: replaceImageHeaderHandleInComponents(components, configuredHandle),
      },
      issue: null,
      source: 'env',
    };
  }

  if (!currentSample) {
    return { template: { ...template, components }, issue: 'missing_image_header_sample' };
  }

  try {
    const mediaHandle = await uploadTemplateHeaderImageHandleToMeta({
      accessToken,
      sampleUrl: currentSample,
      logger,
    });
    return {
      template: {
        ...template,
        components: replaceImageHeaderHandleInComponents(components, mediaHandle),
      },
      issue: null,
      source: 'meta_upload',
    };
  } catch (err) {
    logger.warn?.('[whatsapp-templates] No se pudo generar media handle para cabecera de plantilla', {
      reason: err?.response?.data || err?.message || err,
    });
    return { template: { ...template, components }, issue: 'image_header_sample_upload_failed', error: err };
  }
}

async function selectCatalogTemplatesByDisciplines(disciplinas) {
  const generic = await WhatsappTemplateCatalog.findAll({
    where: { is_active: true, is_generic: true },
  });

  let disciplineTemplates = [];
  if (disciplinas.length) {
    const links = await WhatsappTemplateCatalogDiscipline.findAll({
      where: { disciplina_code: { [Op.in]: disciplinas } },
      attributes: ['template_catalog_id'],
      raw: true,
    });
    const ids = Array.from(new Set(links.map((l) => l.template_catalog_id)));
    if (ids.length) {
      disciplineTemplates = await WhatsappTemplateCatalog.findAll({
        where: { id: { [Op.in]: ids }, is_active: true },
      });
    }
  }

  const templatesById = new Map();
  [...generic, ...disciplineTemplates].forEach((t) => templatesById.set(t.id, t));
  return Array.from(templatesById.values());
}

async function getCatalogTemplateById(templateCatalogId) {
  return WhatsappTemplateCatalog.findByPk(templateCatalogId, {
    include: [
      {
        model: WhatsappTemplateCatalogDiscipline,
        as: 'disciplinas',
        attributes: ['id', 'disciplina_code'],
      },
    ],
  });
}

async function createPlaceholderTemplatesForClinic({ clinicId, assignmentScope, groupId }) {
  if (!clinicId) return [];

  const disciplinas = await resolveDisciplines({
    clinicId: assignmentScope === 'clinic' ? clinicId : null,
    groupId: assignmentScope === 'group' ? groupId : null,
  });

  const templates = await selectCatalogTemplatesByDisciplines(disciplinas);
  const created = [];

  for (const template of templates) {
    const language = getCatalogTemplateLanguage(template);
    const familyName = getCatalogTechnicalFamilyName(template);
    const existing = await WhatsappTemplate.findOne({
      where: {
        clinic_id: clinicId,
        name: familyName,
        language,
        status: 'SIN_CONECTAR',
      },
    });
    if (existing) continue;

    const row = await WhatsappTemplate.create({
      clinic_id: clinicId,
      waba_id: null,
      name: familyName,
      language,
      category: template.category,
      status: 'SIN_CONECTAR',
      components: normalizeTemplateComponentsForMeta(template.components),
      variables: parseMaybeJson(template.variables) || [],
      catalog_template_id: template.id,
      origin: 'catalog',
      is_active: true,
    });
    created.push(row);
  }

  return created;
}

async function upsertPlaceholderTemplateForClinic({ clinicId, template }) {
  if (!clinicId || !template) return { action: 'skipped' };

  const existing = await findLatestLocalTemplateForClinic({ clinicId, template });

  const payload = {
    clinic_id: clinicId,
    waba_id: null,
    name: getCatalogTechnicalFamilyName(template),
    language: getCatalogTemplateLanguage(template),
    category: template.category,
    status: 'SIN_CONECTAR',
    components: normalizeTemplateComponentsForMeta(template.components),
    variables: parseMaybeJson(template.variables) || [],
    catalog_template_id: template.id,
    origin: 'catalog',
    is_active: !!template.is_active,
    rejection_reason: null,
  };

  if (existing) {
    await existing.update(payload);
    return { action: 'updated', row: existing };
  }

  const row = await WhatsappTemplate.create(payload);
  return { action: 'created', row };
}

async function upsertClinicOverrideTemplateForClinic({
  clinicId,
  template,
  technicalName,
  status = WHATSAPP_TEMPLATE_STATUS.PENDING,
  metaTemplateId,
  rejectionReason,
  logger = console,
}) {
  if (!clinicId || !template) return { action: 'skipped' };

  const existing = await findLatestLocalTemplateForClinic({ clinicId, template });

  const payload = {
    clinic_id: clinicId,
    waba_id: null,
    name: cleanString(technicalName) || getCatalogTechnicalFamilyName(template),
    language: getCatalogTemplateLanguage(template),
    category: template.category,
    status,
    components: normalizeTemplateComponentsForMeta(template.components),
    variables: parseMaybeJson(template.variables) || [],
    catalog_template_id: template.id,
    origin: 'catalog',
    is_active: !!template.is_active,
    pending_since_at: [WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'].includes(
      cleanString(status).toUpperCase(),
    ) ? (existing?.pending_since_at || new Date()) : null,
  };

  if (metaTemplateId !== undefined) {
    payload.meta_template_id = metaTemplateId;
  }

  if (rejectionReason !== undefined) {
    payload.rejection_reason = rejectionReason;
  }

  if (existing) {
    await existing.update(payload);
    return { action: 'updated', row: existing };
  }

  const row = await WhatsappTemplate.create(payload);
  logger.info?.('Creado override local de plantilla WhatsApp para clínica', {
    clinicId,
    templateCatalogId: template.id,
    templateName: template.name,
    status,
  });
  return { action: 'created', row };
}

async function upsertConnectedTemplateForWaba({
  wabaId,
  template,
  technicalName,
  status = WHATSAPP_TEMPLATE_STATUS.PENDING,
  metaTemplateId,
  rejectionReason,
}) {
  if (!wabaId || !template) return { action: 'skipped' };

  const safeTechnicalName = cleanString(technicalName) || getCatalogTechnicalFamilyName(template);
  const payload = {
    waba_id: String(wabaId),
    clinic_id: null,
    name: safeTechnicalName,
    language: getCatalogTemplateLanguage(template),
    category: template.category,
    status,
    components: normalizeTemplateComponentsForMeta(template.components),
    variables: parseMaybeJson(template.variables) || [],
    meta_template_id: metaTemplateId || null,
    catalog_template_id: template.id,
    origin: 'catalog',
    is_active: true,
    rejection_reason: rejectionReason !== undefined ? rejectionReason : null,
    last_synced_at: new Date(),
  };

  const existing = await WhatsappTemplate.findOne({
    where: {
      waba_id: String(wabaId),
      name: safeTechnicalName,
      language: getCatalogTemplateLanguage(template),
    },
    order: [['updatedAt', 'DESC']],
  });

  payload.pending_since_at = [WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'].includes(
    cleanString(status).toUpperCase(),
  ) ? (existing?.pending_since_at || payload.last_synced_at) : null;

  if (existing) {
    await existing.update(payload);
    return { action: 'updated', row: existing };
  }

  const row = await WhatsappTemplate.create(payload);
  return { action: 'created', row };
}

function buildLocalPendingReasonFromMetaError(err) {
  const parsed = parseMetaError(err);
  const detail = [
    parsed?.userTitle,
    parsed?.userMessage,
    parsed?.message,
  ].map((value) => String(value || '').trim()).filter(Boolean).join(' - ');
  const code = parsed?.code ? ` [${parsed.code}]` : '';
  if (!detail) {
    return `Meta no ha aceptado abrir una revisión nueva para esta plantilla${code}.`;
  }
  return `Meta no ha aceptado abrir una revisión nueva para esta plantilla${code}: ${detail}`;
}

function createMetaTemplateSubmissionError(parsed) {
  const error = new Error('meta_template_submission_failed');
  error.code = 'meta_template_submission_failed';
  error.statusCode = 400;
  error.details = [
    'Meta no aceptó abrir la revisión de esta plantilla por un problema técnico de formato. No la hemos guardado como pendiente para evitar confusión; revisa longitud, variables y formato, o avisa a soporte.',
  ];
  error.metaError = parsed || null;
  return error;
}

async function notifyBulkSendsTemplateApproval(templateRow, logger = console) {
  const plain = templateRow?.get ? templateRow.get({ plain: true }) : templateRow;
  if (String(plain?.status || '').toUpperCase() !== WHATSAPP_TEMPLATE_STATUS.APPROVED) return;
  try {
    const marketingBulkSendsService = require('./marketingBulkSends.service');
    if (typeof marketingBulkSendsService.enqueueAutoDispatchForApprovedTemplate === 'function') {
      await marketingBulkSendsService.enqueueAutoDispatchForApprovedTemplate(templateRow, logger);
    }
  } catch (error) {
    logger.warn?.('[whatsapp-templates] No se pudo notificar aprobación a envíos masivos', {
      template_id: plain?.id || null,
      name: plain?.name || null,
      error: error?.message || error,
    });
  }
}

async function resolveDisciplines({ clinicId, groupId }) {
  if (clinicId) {
    const clinic = await Clinica.findOne({ where: { id_clinica: clinicId }, raw: true });
    const cfg = clinic?.configuracion || {};
    const disciplinas = normalizeDisciplines(cfg.disciplinas);
    return disciplinas.length ? disciplinas : ['dental'];
  }

  if (groupId) {
    const clinics = await Clinica.findAll({ where: { grupoClinicaId: groupId }, raw: true });
    const set = new Set();
    clinics.forEach((c) => {
      const cfg = c?.configuracion || {};
      const list = normalizeDisciplines(cfg.disciplinas);
      (list.length ? list : ['dental']).forEach((d) => set.add(d));
    });
    return Array.from(set);
  }

  return [];
}

async function resolveWabaAssetById(wabaId) {
  return ClinicMetaAsset.findOne({
    where: {
      isActive: true,
      wabaId,
      assetType: { [Op.in]: ['whatsapp_business_account', 'whatsapp_phone_number'] },
      waAccessToken: {
        [Op.and]: [
          { [Op.ne]: null },
          { [Op.ne]: '' },
        ],
      },
    },
    include: MetaConnection ? [{
      model: MetaConnection,
      as: 'metaConnection',
      attributes: ['id', 'accessToken'],
      required: false,
    }] : [],
    order: [['updatedAt', 'DESC']],
  });
}

async function createTemplateInMeta({ wabaId, accessToken, template, language }) {
  const components = normalizeTemplateComponentsForMeta(template.components);
  const payload = {
    name: cleanString(template.name),
    language,
    category: template.category,
    components: components || [],
  };

  const response = await axios.post(
    graphUrl(`${wabaId}/message_templates`),
    payload,
    { params: { access_token: accessToken } }
  );
  return response.data;
}

async function fetchTemplatesFromMeta({ wabaId, accessToken }) {
  const items = [];
  const seenCursors = new Set();
  let after = null;

  // Meta pagina incluso con limit=200. Usar el cursor (en vez de paging.next,
  // que contiene el token en la URL) evita perder versiones técnicas antiguas
  // y evita propagar credenciales a logs de errores HTTP.
  for (let page = 0; page < 50; page += 1) {
    const response = await axios.get(graphUrl(`${wabaId}/message_templates`), {
      params: {
        access_token: accessToken,
        limit: 200,
        ...(after ? { after } : {}),
      },
    });
    const pageItems = Array.isArray(response.data?.data) ? response.data.data : [];
    items.push(...pageItems);

    const nextUrl = cleanString(response.data?.paging?.next);
    const nextCursor = cleanString(response.data?.paging?.cursors?.after);
    if (!nextUrl || !nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    after = nextCursor;
  }
  return items;
}

function findRemoteTemplate(items, { name, metaTemplateId, language = null } = {}) {
  const safeName = cleanString(name).toLowerCase();
  const safeMetaTemplateId = cleanString(metaTemplateId);
  const locale = normalizeWhatsappLocale(language);
  const rows = (Array.isArray(items) ? items : []).filter((item) => (
    !locale || normalizeWhatsappLocale(item?.language, { fallback: 'es' }) === locale
  ));
  if (safeMetaTemplateId) {
    const byId = rows.find((item) => cleanString(item?.id) === safeMetaTemplateId);
    if (byId) return byId;
  }
  if (!safeName) return null;
  return rows.find((item) => cleanString(item?.name).toLowerCase() === safeName) || null;
}

async function deleteTemplateInMeta({ wabaId, accessToken, name, metaTemplateId }) {
  if (!wabaId || !accessToken || !name || !metaTemplateId) {
    throw new Error('missing_meta_template_delete_identity');
  }
  const response = await axios.delete(graphUrl(`${wabaId}/message_templates`), {
    params: {
      access_token: accessToken,
      name,
      hsm_id: metaTemplateId,
    },
  });
  return response.data;
}

async function deleteTemplateInMetaWithAssetCredentials({ asset, wabaId, name, metaTemplateId }) {
  const tokens = Array.from(new Set([
    cleanString(asset?.metaConnection?.accessToken),
    cleanString(asset?.waAccessToken),
  ].filter(Boolean)));
  if (!tokens.length) throw new Error('missing_meta_template_delete_credentials');

  let lastError = null;
  for (const accessToken of tokens) {
    try {
      return await deleteTemplateInMeta({ wabaId, accessToken, name, metaTemplateId });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('meta_template_delete_failed');
}

function compactMetaError(error) {
  const parsed = parseMetaError(error);
  const message = [
    parsed?.code ? `Meta ${parsed.code}` : null,
    parsed?.userTitle,
    parsed?.userMessage,
    parsed?.message,
    error?.message,
  ].map((value) => cleanString(value)).filter(Boolean).join(' - ');
  return (message || 'whatsapp_template_auto_resubmit_failed').slice(0, 4000);
}

async function recordAutoResubmitError(templateId, error) {
  const safeTemplateId = Number(templateId || 0);
  if (!Number.isInteger(safeTemplateId) || safeTemplateId <= 0) return;
  await WhatsappTemplate.update({
    auto_resubmit_error: compactMetaError(error),
  }, {
    where: { id: safeTemplateId },
  }).catch(() => null);
}

function isApprovedCurrentCatalogSibling(row, catalog, sourceId = null) {
  if (!row || Number(row.id) === Number(sourceId)) return false;
  return !!(
    row.is_active
    && cleanString(row.status).toUpperCase() === WHATSAPP_TEMPLATE_STATUS.APPROVED
    && cleanString(row.meta_template_id)
    && normalizeWhatsappLocale(row.language, { fallback: 'es' }) === normalizeWhatsappLocale(getCatalogTemplateLanguage(catalog), { fallback: 'es' })
    && isTechnicalTemplateFamilyName(getCatalogTechnicalFamilyName(catalog), row.name)
    && hasSameMetaFacingContent(catalog, row)
  );
}

async function loadWabaCatalogFamily({ wabaId, catalog, language = DEFAULT_LANGUAGE }) {
  if (!wabaId || !catalog) return [];
  return WhatsappTemplate.findAll({
    where: {
      waba_id: String(wabaId),
      clinic_id: null,
      language: cleanString(language) || DEFAULT_LANGUAGE,
      [Op.or]: [
        { catalog_template_id: Number(catalog.id) },
        { name: { [Op.like]: `${getCatalogTechnicalFamilyName(catalog)}%` } },
      ],
    },
    order: [['id', 'ASC']],
  });
}

async function resolveClinicOverrideIdsForWaba({ source, catalog }) {
  const overrides = await WhatsappTemplate.findAll({
    where: {
      waba_id: null,
      clinic_id: { [Op.ne]: null },
      catalog_template_id: Number(catalog.id),
      is_active: true,
      [Op.or]: [
        { meta_template_id: source.meta_template_id },
        { name: source.name },
      ],
    },
    attributes: ['id', 'clinic_id'],
    raw: true,
  });
  const clinicIds = Array.from(new Set(
    overrides.map((row) => Number(row.clinic_id)).filter((id) => Number.isInteger(id) && id > 0),
  ));
  if (!clinicIds.length) return [];

  const [clinics, assets] = await Promise.all([
    Clinica.findAll({
      where: { id_clinica: { [Op.in]: clinicIds } },
      attributes: ['id_clinica', 'grupoClinicaId'],
      raw: true,
    }),
    ClinicMetaAsset.findAll({
      where: {
        isActive: true,
        assetType: { [Op.in]: ['whatsapp_phone_number', 'whatsapp_business_account'] },
        wabaId: { [Op.ne]: null },
      },
      attributes: [
        'id',
        'assetType',
        'assignmentScope',
        'clinicaId',
        'grupoClinicaId',
        'wabaId',
        'phoneNumberId',
        'waAccessToken',
        'isActive',
        'updatedAt',
      ],
      raw: true,
    }),
  ]);
  const clinicById = new Map(clinics.map((clinic) => [Number(clinic.id_clinica), clinic]));

  return overrides
    .filter((override) => {
      const clinic = clinicById.get(Number(override.clinic_id));
      return clinic && String(resolveEffectiveWabaForClinic({ clinic, assets }) || '') === String(source.waba_id);
    })
    .map((override) => Number(override.id));
}

async function enqueueStalePendingTemplateResubmissions({ wabaId, now = new Date(), logger = console }) {
  if (!AUTO_RESUBMIT_ENABLED || !wabaId) return { queued: 0, candidates: 0 };

  const rows = await WhatsappTemplate.findAll({
    where: {
      waba_id: String(wabaId),
      clinic_id: null,
      is_active: true,
      status: { [Op.in]: [WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'] },
      catalog_template_id: { [Op.ne]: null },
    },
    include: [{
      model: WhatsappTemplateCatalog,
      as: 'catalog',
      required: true,
    }],
    order: [['id', 'ASC']],
  });

  let queued = 0;
  let candidates = 0;
  for (const row of rows) {
    const catalog = row.catalog;
    const familyRows = await loadWabaCatalogFamily({ wabaId, catalog, language: row.language });
    const approvedSiblingExists = familyRows.some((sibling) => (
      isApprovedCurrentCatalogSibling(sibling, catalog, row.id)
    ));
    const decision = evaluatePendingTemplateAutoResubmit({
      row,
      catalog,
      now,
      approvedSiblingExists,
      pendingThresholdMs: AUTO_RESUBMIT_PENDING_THRESHOLD_MS || DEFAULT_PENDING_THRESHOLD_MS,
      featureEnabled: AUTO_RESUBMIT_ENABLED,
    });
    if (!decision.eligible) continue;
    candidates += 1;

    const replacementName = resolveNextTechnicalTemplateName(getCatalogTechnicalFamilyName(catalog), familyRows);
    const dedupeScope = buildPendingTemplateResubmitDedupeScope(row);
    if (!replacementName || !dedupeScope) continue;

    const job = await db.sequelize.transaction(async (transaction) => {
      const cutoff = new Date(now.getTime() - AUTO_RESUBMIT_PENDING_THRESHOLD_MS);
      const [claimed] = await WhatsappTemplate.update({
        auto_resubmit_attempt_count: 1,
        auto_resubmit_attempted_at: now,
        auto_resubmit_error: null,
      }, {
        where: {
          id: row.id,
          waba_id: String(wabaId),
          is_active: true,
          status: { [Op.in]: [WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'] },
          auto_resubmit_attempt_count: 0,
          superseded_by_template_id: null,
          pending_since_at: { [Op.lt]: cutoff },
        },
        transaction,
      });
      if (!claimed) return null;

      let plannedReplacement = await WhatsappTemplate.findOne({
        where: {
          waba_id: String(wabaId),
          name: replacementName,
          language: row.language || DEFAULT_LANGUAGE,
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const plannedPayload = {
        waba_id: String(wabaId),
        clinic_id: null,
        name: replacementName,
        language: row.language || DEFAULT_LANGUAGE,
        category: catalog.category,
        status: WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING,
        components: normalizeTemplateComponentsForMeta(catalog.components),
        variables: parseMaybeJson(catalog.variables) || [],
        meta_template_id: null,
        catalog_template_id: catalog.id,
        origin: 'catalog',
        rejection_reason: 'Reenvío automático preparado; pendiente de apertura en Meta.',
        is_active: false,
        pending_since_at: null,
        auto_resubmit_attempt_count: 1,
        auto_resubmit_attempted_at: now,
        resubmitted_from_template_id: row.id,
        superseded_by_template_id: null,
        auto_resubmit_error: null,
      };
      if (plannedReplacement) {
        if (!hasSameMetaFacingContent(catalog, plannedReplacement)) {
          throw new Error('stale_pending_replacement_name_contract_conflict');
        }
        await plannedReplacement.update({
          catalog_template_id: catalog.id,
          auto_resubmit_attempt_count: 1,
          auto_resubmit_attempted_at: now,
          resubmitted_from_template_id: row.id,
          superseded_by_template_id: null,
          auto_resubmit_error: null,
        }, { transaction });
      } else {
        plannedReplacement = await WhatsappTemplate.create(plannedPayload, { transaction });
      }

      return jobRequestsService.enqueueJobRequest({
        type: 'whatsapp_template_create',
        priority: 'high',
        origin: 'whatsapp_template_auto_resubmit',
        maxAttempts: 3,
        payload: {
          mode: 'resubmit_stale_pending',
          source_template_id: row.id,
          replacement_template_id: plannedReplacement.id,
          wabaId: String(wabaId),
          replacement_name: replacementName,
          __dedupe_scope: dedupeScope,
        },
      }, { transaction });
    });

    if (job) {
      queued += 1;
      logger.info?.('[whatsapp-templates] Reenvío automático encolado para plantilla pendiente', {
        source_template_id: row.id,
        waba_id: String(wabaId),
        replacement_name: replacementName,
        pending_since_at: row.pending_since_at,
        job_request_id: job.id,
      });
    }
  }

  return { queued, candidates };
}

async function recoverSourceApprovedDuringCleanup({ source, replacement, remoteSource }) {
  const catalog = await WhatsappTemplateCatalog.findByPk(source.catalog_template_id);
  if (!catalog || !replacement) {
    throw new Error('approved_source_recovery_missing_catalog_or_replacement');
  }
  const overrideIds = await resolveClinicOverrideIdsForWaba({ source: replacement, catalog });
  const now = new Date();

  await db.sequelize.transaction(async (transaction) => {
    const lockedSource = await WhatsappTemplate.findByPk(source.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const lockedReplacement = await WhatsappTemplate.findByPk(replacement.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!lockedSource || !lockedReplacement) {
      throw new Error('approved_source_recovery_rows_missing');
    }
    await lockedSource.update({
      status: WHATSAPP_TEMPLATE_STATUS.APPROVED,
      category: remoteSource.category || catalog.category,
      components: remoteSource.components || catalog.components,
      meta_template_id: remoteSource.id || source.meta_template_id,
      rejection_reason: null,
      is_active: true,
      pending_since_at: null,
      superseded_by_template_id: null,
      auto_resubmit_error: null,
      last_synced_at: now,
    }, { transaction });
    await lockedReplacement.update({
      is_active: false,
      superseded_by_template_id: source.id,
      auto_resubmit_error: null,
      rejection_reason: 'Reenvío automático retirado: Meta aprobó la plantilla original antes de eliminarla.',
      last_synced_at: now,
    }, { transaction });
    if (overrideIds.length) {
      await WhatsappTemplate.update({
        name: source.name,
        language: source.language || DEFAULT_LANGUAGE,
        category: remoteSource.category || catalog.category,
        status: WHATSAPP_TEMPLATE_STATUS.APPROVED,
        components: normalizeTemplateComponentsForMeta(catalog.components),
        variables: parseMaybeJson(catalog.variables) || [],
        meta_template_id: remoteSource.id || source.meta_template_id,
        rejection_reason: null,
        pending_since_at: null,
        resubmitted_from_template_id: null,
        superseded_by_template_id: null,
        auto_resubmit_error: null,
        last_synced_at: now,
      }, {
        where: { id: { [Op.in]: overrideIds }, is_active: true },
        transaction,
      });
    }
  });

  return {
    source_reactivated_after_approval_race: true,
    recovered_override_count: overrideIds.length,
  };
}

async function cleanupSupersededRemoteTemplate({ source, replacement, asset }) {
  const remoteItems = await fetchTemplatesFromMeta({
    wabaId: source.waba_id,
    accessToken: asset.waAccessToken,
  });
  const remoteSource = findRemoteTemplate(remoteItems, {
    name: source.name,
    metaTemplateId: source.meta_template_id,
    language: source.language,
  });
  if (!remoteSource) {
    await source.update({ auto_resubmit_error: null });
    return { deleted_old_remote: false, old_remote_already_absent: true };
  }

  if (cleanString(remoteSource.status).toUpperCase() === WHATSAPP_TEMPLATE_STATUS.APPROVED) {
    const recovery = await recoverSourceApprovedDuringCleanup({
      source,
      replacement,
      remoteSource,
    });
    const cancelledReplacement = await cancelPlannedReplacement({
      source,
      replacementTemplateId: replacement?.id,
      replacementName: replacement?.name,
      asset,
      reason: 'source_approved_during_cleanup',
    });
    return {
      deleted_old_remote: false,
      old_remote_already_absent: false,
      old_remote_became_approved: true,
      ...recovery,
      ...cancelledReplacement,
    };
  }

  try {
    await deleteTemplateInMetaWithAssetCredentials({
      asset,
      wabaId: source.waba_id,
      name: source.name,
      metaTemplateId: source.meta_template_id,
    });
    await source.update({ auto_resubmit_error: null });
    return { deleted_old_remote: true, old_remote_already_absent: false };
  } catch (error) {
    await recordAutoResubmitError(source.id, error);
    error.autoResubmitCleanupOnly = true;
    error.replacementTemplateId = replacement?.id || source.superseded_by_template_id || null;
    throw error;
  }
}

async function findPlannedReplacement({ source, replacementTemplateId, replacementName }) {
  const safeReplacementTemplateId = Number(replacementTemplateId || 0);
  if (Number.isInteger(safeReplacementTemplateId) && safeReplacementTemplateId > 0) {
    const byId = await WhatsappTemplate.findByPk(safeReplacementTemplateId);
    if (
      byId
      && String(byId.waba_id || '') === String(source.waba_id || '')
      && Number(byId.resubmitted_from_template_id || 0) === Number(source.id)
    ) {
      return byId;
    }
  }
  return WhatsappTemplate.findOne({
    where: {
      waba_id: String(source.waba_id),
      name: replacementName,
      resubmitted_from_template_id: source.id,
      auto_resubmit_attempt_count: { [Op.gte]: 1 },
    },
    order: [['id', 'DESC']],
  });
}

async function cancelPlannedReplacement({
  source,
  replacementTemplateId,
  replacementName,
  asset,
  reason,
}) {
  const planned = await findPlannedReplacement({
    source,
    replacementTemplateId,
    replacementName,
  });
  if (!planned) return { cancelled_replacement: false, replacement_not_found: true };

  const cancellationReason = cleanString(reason) || 'source_no_longer_requires_resubmit';
  const markCancelled = async (error = null) => planned.update({
    is_active: false,
    superseded_by_template_id: source.id,
    auto_resubmit_error: error ? compactMetaError(error) : null,
    rejection_reason: `Reenvío automático cancelado: ${cancellationReason}.`,
  });

  const remoteItems = await fetchTemplatesFromMeta({
    wabaId: source.waba_id,
    accessToken: asset.waAccessToken,
  });
  const remotePlanned = findRemoteTemplate(remoteItems, {
    name: planned.name,
    metaTemplateId: planned.meta_template_id,
    language: planned.language || source.language,
  });
  if (!remotePlanned) {
    await markCancelled();
    return {
      cancelled_replacement: true,
      replacement_template_id: planned.id,
      replacement_remote_deleted: false,
      replacement_remote_already_absent: true,
    };
  }

  try {
    await deleteTemplateInMetaWithAssetCredentials({
      asset,
      wabaId: source.waba_id,
      name: remotePlanned.name || planned.name,
      metaTemplateId: remotePlanned.id || planned.meta_template_id,
    });
    await markCancelled();
    return {
      cancelled_replacement: true,
      replacement_template_id: planned.id,
      replacement_remote_deleted: true,
      replacement_remote_already_absent: false,
    };
  } catch (error) {
    await markCancelled(error).catch(() => null);
    await recordAutoResubmitError(source.id, error);
    error.autoResubmitCleanupOnly = true;
    error.replacementTemplateId = planned.id;
    throw error;
  }
}

async function runStalePendingTemplateResubmission(payload = {}) {
  const sourceTemplateId = Number(payload.source_template_id || payload.sourceTemplateId || 0);
  const plannedReplacementTemplateId = Number(
    payload.replacement_template_id || payload.replacementTemplateId || 0,
  ) || null;
  const expectedWabaId = cleanString(payload.wabaId || payload.waba_id);
  const replacementName = cleanString(payload.replacement_name || payload.replacementName);
  if (!Number.isInteger(sourceTemplateId) || sourceTemplateId <= 0 || !expectedWabaId || !replacementName) {
    throw new Error('invalid_stale_pending_resubmit_payload');
  }

  let source = await WhatsappTemplate.findByPk(sourceTemplateId);
  if (!source || String(source.waba_id || '') !== expectedWabaId) {
    return { skipped: true, reason: 'source_template_not_found', source_template_id: sourceTemplateId };
  }
  const asset = await resolveWabaAssetById(expectedWabaId);
  if (!AUTO_RESUBMIT_ENABLED) {
    let cancellation = {};
    let canReleaseClaim = false;
    if (asset?.waAccessToken) {
      cancellation = await cancelPlannedReplacement({
        source,
        replacementTemplateId: plannedReplacementTemplateId,
        replacementName,
        asset,
        reason: 'feature_disabled',
      });
      canReleaseClaim = true;
    } else {
      const planned = await findPlannedReplacement({
        source,
        replacementTemplateId: plannedReplacementTemplateId,
        replacementName,
      });
      if (planned) {
        await planned.update({
          is_active: false,
          superseded_by_template_id: source.id,
          rejection_reason: 'Reenvío automático cancelado: feature_disabled.',
        });
      }
    }
    if (canReleaseClaim) {
      await WhatsappTemplate.update({
        auto_resubmit_attempt_count: 0,
        auto_resubmit_attempted_at: null,
        auto_resubmit_error: null,
      }, {
        where: {
          id: source.id,
          superseded_by_template_id: null,
          status: { [Op.in]: [WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'] },
        },
      });
    }
    return {
      skipped: true,
      reason: 'feature_disabled',
      source_template_id: sourceTemplateId,
      claim_released: canReleaseClaim,
      ...cancellation,
    };
  }

  if (!asset?.waAccessToken) {
    throw new Error('stale_pending_resubmit_missing_active_waba_credentials');
  }

  if (source.superseded_by_template_id) {
    const replacement = await WhatsappTemplate.findByPk(source.superseded_by_template_id);
    const cleanup = await cleanupSupersededRemoteTemplate({ source, replacement, asset });
    return {
      source_template_id: source.id,
      replacement_template_id: replacement?.id || source.superseded_by_template_id,
      resumed_cleanup_only: true,
      ...cleanup,
    };
  }

  // Releer Meta antes de crear evita sustituir una plantilla que haya sido
  // aprobada mientras el JobRequest esperaba turno.
  await syncTemplatesForWaba({ wabaId: expectedWabaId, accessToken: asset.waAccessToken });
  source = await WhatsappTemplate.findByPk(sourceTemplateId);
  if (!source) {
    return { skipped: true, reason: 'source_template_not_found_after_sync', source_template_id: sourceTemplateId };
  }
  if (source.superseded_by_template_id) {
    const replacement = await WhatsappTemplate.findByPk(source.superseded_by_template_id);
    const cleanup = await cleanupSupersededRemoteTemplate({ source, replacement, asset });
    return {
      source_template_id: source.id,
      replacement_template_id: replacement?.id || source.superseded_by_template_id,
      resumed_cleanup_only: true,
      ...cleanup,
    };
  }

  const sourceStatus = cleanString(source.status).toUpperCase();
  if (![WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'].includes(sourceStatus) || !source.is_active) {
    const reason = sourceStatus === WHATSAPP_TEMPLATE_STATUS.APPROVED
      ? 'source_approved_before_resubmit'
      : 'source_no_longer_pending';
    const cancellation = await cancelPlannedReplacement({
      source,
      replacementTemplateId: plannedReplacementTemplateId,
      replacementName,
      asset,
      reason,
    });
    return {
      skipped: true,
      reason,
      source_template_id: source.id,
      source_status: sourceStatus,
      ...cancellation,
    };
  }

  const catalog = await WhatsappTemplateCatalog.findByPk(source.catalog_template_id);
  if (!catalog || !catalog.is_active || !hasSameMetaFacingContent(catalog, source)) {
    const cancellation = await cancelPlannedReplacement({
      source,
      replacementTemplateId: plannedReplacementTemplateId,
      replacementName,
      asset,
      reason: 'catalog_contract_no_longer_current',
    });
    return {
      skipped: true,
      reason: 'catalog_contract_no_longer_current',
      source_template_id: source.id,
      ...cancellation,
    };
  }
  const familyRows = await loadWabaCatalogFamily({
    wabaId: expectedWabaId,
    catalog,
    language: source.language,
  });
  if (familyRows.some((sibling) => isApprovedCurrentCatalogSibling(sibling, catalog, source.id))) {
    const cancellation = await cancelPlannedReplacement({
      source,
      replacementTemplateId: plannedReplacementTemplateId,
      replacementName,
      asset,
      reason: 'approved_sibling_exists',
    });
    return {
      skipped: true,
      reason: 'approved_sibling_exists',
      source_template_id: source.id,
      ...cancellation,
    };
  }
  if (!isTechnicalTemplateFamilyName(getCatalogTechnicalFamilyName(catalog), replacementName) || replacementName === source.name) {
    throw new Error('invalid_stale_pending_replacement_name');
  }

  let remoteItems = await fetchTemplatesFromMeta({
    wabaId: expectedWabaId,
    accessToken: asset.waAccessToken,
  });
  let remoteReplacement = findRemoteTemplate(remoteItems, {
    name: replacementName,
    language: source.language,
  });
  const remoteApprovedSibling = remoteItems.find((item) => (
    cleanString(item?.status).toUpperCase() === WHATSAPP_TEMPLATE_STATUS.APPROVED
    && normalizeWhatsappLocale(item?.language, { fallback: 'es' }) === normalizeWhatsappLocale(getCatalogTemplateLanguage(catalog), { fallback: 'es' })
    && isTechnicalTemplateFamilyName(getCatalogTechnicalFamilyName(catalog), item?.name)
    && hasSameMetaFacingContent(catalog, item)
    && cleanString(item?.id) !== cleanString(remoteReplacement?.id)
  ));
  if (remoteApprovedSibling) {
    await syncTemplatesForWaba({ wabaId: expectedWabaId, accessToken: asset.waAccessToken });
    source = await WhatsappTemplate.findByPk(source.id);
    const cancellation = await cancelPlannedReplacement({
      source,
      replacementTemplateId: plannedReplacementTemplateId,
      replacementName,
      asset,
      reason: cleanString(remoteApprovedSibling.id) === cleanString(source.meta_template_id)
        ? 'source_approved_before_resubmit'
        : 'approved_sibling_exists',
    });
    return {
      skipped: true,
      reason: cleanString(remoteApprovedSibling.id) === cleanString(source.meta_template_id)
        ? 'source_approved_before_resubmit'
        : 'approved_sibling_exists',
      source_template_id: source.id,
      approved_meta_template_id: remoteApprovedSibling.id || null,
      ...cancellation,
    };
  }
  let preparedTemplate = null;
  if (remoteReplacement && !hasSameMetaFacingContent(catalog, remoteReplacement)) {
    const error = new Error('stale_pending_replacement_name_contract_conflict');
    await recordAutoResubmitError(source.id, error);
    throw error;
  }
  if (!remoteReplacement) {
    preparedTemplate = await prepareTemplateImageHeaderForMeta({
      template: buildTemplateForTechnicalName(catalog, replacementName),
      accessToken: asset.waAccessToken,
      logger: console,
    });
    const imageIssue = preparedTemplate.issue || getImageHeaderSampleIssue(preparedTemplate.template);
    if (imageIssue) {
      const error = new Error(`stale_pending_resubmit_${imageIssue}`);
      await recordAutoResubmitError(source.id, error);
      throw error;
    }
    try {
      const metaResponse = await createTemplateInMeta({
        wabaId: expectedWabaId,
        accessToken: asset.waAccessToken,
        template: preparedTemplate.template,
        language: source.language || DEFAULT_LANGUAGE,
      });
      remoteReplacement = {
        id: metaResponse?.id || null,
        name: replacementName,
        language: source.language || DEFAULT_LANGUAGE,
        category: catalog.category,
        status: metaResponse?.status || WHATSAPP_TEMPLATE_STATUS.PENDING,
        components: preparedTemplate.template.components,
      };
    } catch (error) {
      await recordAutoResubmitError(source.id, error);
      throw error;
    }
  }
  if (!cleanString(remoteReplacement?.id)) {
    const error = new Error('stale_pending_resubmit_missing_meta_template_id');
    await recordAutoResubmitError(source.id, error);
    throw error;
  }

  // Cierra la carrera entre la preparación/creación de la cabecera y la
  // aprobación del source. Nunca degradar una cobertura que Meta acaba de
  // aprobar sustituyéndola por otra versión todavía pendiente.
  const latestRemoteItems = await fetchTemplatesFromMeta({
    wabaId: expectedWabaId,
    accessToken: asset.waAccessToken,
  });
  const latestRemoteReplacement = findRemoteTemplate(latestRemoteItems, {
    name: replacementName,
    metaTemplateId: remoteReplacement.id,
    language: source.language,
  });
  if (latestRemoteReplacement) {
    remoteReplacement = latestRemoteReplacement;
  }
  const lateApprovedSibling = latestRemoteItems.find((item) => (
    cleanString(item?.status).toUpperCase() === WHATSAPP_TEMPLATE_STATUS.APPROVED
    && normalizeWhatsappLocale(item?.language, { fallback: 'es' }) === normalizeWhatsappLocale(getCatalogTemplateLanguage(catalog), { fallback: 'es' })
    && isTechnicalTemplateFamilyName(getCatalogTechnicalFamilyName(catalog), item?.name)
    && hasSameMetaFacingContent(catalog, item)
    && cleanString(item?.id) !== cleanString(remoteReplacement.id)
  ));
  if (lateApprovedSibling) {
    await syncTemplatesForWaba({ wabaId: expectedWabaId, accessToken: asset.waAccessToken });
    source = await WhatsappTemplate.findByPk(source.id);
    const reason = cleanString(lateApprovedSibling.id) === cleanString(source.meta_template_id)
      ? 'source_approved_during_resubmit'
      : 'approved_sibling_during_resubmit';
    const cancellation = await cancelPlannedReplacement({
      source,
      replacementTemplateId: plannedReplacementTemplateId,
      replacementName,
      asset,
      reason,
    });
    return {
      skipped: true,
      reason,
      source_template_id: source.id,
      approved_meta_template_id: lateApprovedSibling.id || null,
      ...cancellation,
    };
  }

  const now = new Date();
  const replacementStatus = mapRemoteStatusToLocalStatus(remoteReplacement.status);
  const overrideIds = await resolveClinicOverrideIdsForWaba({ source, catalog });
  const replacement = await db.sequelize.transaction(async (transaction) => {
    const lockedSource = await WhatsappTemplate.findByPk(source.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (lockedSource.superseded_by_template_id) {
      return WhatsappTemplate.findByPk(lockedSource.superseded_by_template_id, { transaction });
    }
    const lockedStatus = cleanString(lockedSource.status).toUpperCase();
    if (![WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'].includes(lockedStatus) || !lockedSource.is_active) {
      return null;
    }

    let next = await WhatsappTemplate.findOne({
      where: {
        waba_id: expectedWabaId,
        name: replacementName,
        language: remoteReplacement.language || source.language || DEFAULT_LANGUAGE,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const replacementPayload = {
      waba_id: expectedWabaId,
      clinic_id: null,
      name: replacementName,
      language: remoteReplacement.language || source.language || DEFAULT_LANGUAGE,
      category: remoteReplacement.category || catalog.category,
      status: replacementStatus,
      components: remoteReplacement.components || preparedTemplate?.template?.components || catalog.components,
      variables: parseMaybeJson(catalog.variables) || [],
      meta_template_id: remoteReplacement.id,
      catalog_template_id: catalog.id,
      origin: 'catalog',
      rejection_reason: remoteReplacement.rejected_reason || remoteReplacement.rejection_reason || null,
      is_active: true,
      pending_since_at: [WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'].includes(replacementStatus) ? now : null,
      auto_resubmit_attempt_count: 1,
      auto_resubmit_attempted_at: lockedSource.auto_resubmit_attempted_at || now,
      resubmitted_from_template_id: lockedSource.id,
      superseded_by_template_id: null,
      auto_resubmit_error: null,
      last_synced_at: now,
    };
    if (next) {
      await next.update(replacementPayload, { transaction });
    } else {
      next = await WhatsappTemplate.create(replacementPayload, { transaction });
    }

    await lockedSource.update({
      is_active: false,
      superseded_by_template_id: next.id,
      auto_resubmit_error: null,
    }, { transaction });

    if (overrideIds.length) {
      await WhatsappTemplate.update({
        name: replacementName,
        language: replacementPayload.language,
        category: replacementPayload.category,
        status: replacementStatus,
        components: normalizeTemplateComponentsForMeta(catalog.components),
        variables: parseMaybeJson(catalog.variables) || [],
        meta_template_id: remoteReplacement.id,
        rejection_reason: replacementPayload.rejection_reason,
        pending_since_at: replacementPayload.pending_since_at,
        auto_resubmit_attempt_count: 1,
        auto_resubmit_attempted_at: replacementPayload.auto_resubmit_attempted_at,
        resubmitted_from_template_id: lockedSource.id,
        auto_resubmit_error: null,
        last_synced_at: now,
      }, {
        where: {
          id: { [Op.in]: overrideIds },
          is_active: true,
          status: { [Op.in]: [WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'] },
        },
        transaction,
      });
    }
    return next;
  });

  if (!replacement) {
    source = await WhatsappTemplate.findByPk(source.id);
    const cancellation = await cancelPlannedReplacement({
      source,
      replacementTemplateId: plannedReplacementTemplateId,
      replacementName,
      asset,
      reason: 'source_changed_during_resubmit',
    });
    return {
      skipped: true,
      reason: 'source_changed_during_resubmit',
      source_template_id: source.id,
      ...cancellation,
    };
  }

  source = await WhatsappTemplate.findByPk(source.id);
  const cleanup = await cleanupSupersededRemoteTemplate({ source, replacement, asset });
  return {
    source_template_id: source.id,
    replacement_template_id: replacement.id,
    replacement_meta_template_id: replacement.meta_template_id,
    replacement_name: replacement.name,
    replacement_status: replacement.status,
    overrides_updated: overrideIds.length,
    ...cleanup,
  };
}

function extractTemplateBodyText(components) {
  const parsed = parseMaybeJson(components) || [];
  const body = Array.isArray(parsed)
    ? parsed.find((component) => String(component?.type || '').toUpperCase() === 'BODY')
    : null;
  return body?.text || '';
}

function buildTemplateSnapshot(template) {
  if (!template) return null;
  const plain = template.get ? template.get({ plain: true }) : template;
  return {
    id: plain.id,
    name: plain.name,
    display_name: plain.catalog?.display_name || plain.display_name || plain.name,
    status: plain.status,
    rejection_reason: plain.rejection_reason || null,
    language: plain.language || DEFAULT_LANGUAGE,
    body: extractTemplateBodyText(plain.components),
    variables: Array.isArray(plain.variables) ? plain.variables : [],
    captured_at: new Date().toISOString(),
  };
}

async function replaceTemplateInEditableBulkSends({ oldTemplateId, newTemplate }) {
  const oldId = Number(oldTemplateId || 0);
  if (!oldId || !MarketingPatientList || !newTemplate) return true;

  const snapshot = buildTemplateSnapshot(newTemplate);
  const newId = Number(snapshot?.id || 0);
  if (!newId) return true;

  const lists = await MarketingPatientList.findAll({
    where: {
      objective_id: 'mass_sends',
      status: { [Op.in]: ['draft', 'prepared'] },
      [Op.or]: [
        db.sequelize.where(
          db.sequelize.cast(db.sequelize.json('criteria.whatsapp_template_id'), 'UNSIGNED'),
          oldId
        ),
        db.sequelize.where(
          db.sequelize.cast(db.sequelize.json('template_snapshot.id'), 'UNSIGNED'),
          oldId
        ),
      ],
    },
  });

  for (const list of lists) {
    await list.update({
      template_snapshot: snapshot,
      criteria: {
        ...(list.criteria || {}),
        whatsapp_template_id: newId,
      },
      safety_gates: {
        ...(list.safety_gates || {}),
        approved_template: false,
      },
    });
  }
  return true;
}

async function deactivateReplacedTemplateFamily({
  wabaId,
  clinicId,
  displayName,
  keepTemplateId,
  replacedTemplateId,
  createdByUserId,
}) {
  const safeWabaId = cleanString(wabaId);
  const safeClinicId = Number(clinicId || 0) || null;
  const safeDisplayName = cleanString(displayName);
  const safeKeepTemplateId = Number(keepTemplateId || 0);
  const safeReplacedTemplateId = Number(replacedTemplateId || 0);
  const safeCreatedByUserId = Number(createdByUserId || 0);
  if (
    !safeWabaId
    || !safeKeepTemplateId
    || !safeReplacedTemplateId
    || !Number.isInteger(safeCreatedByUserId)
    || safeCreatedByUserId <= 0
  ) return;

  // El id elegido debe retirarse aunque sea una fila WABA compartida
  // (`clinic_id=NULL`) y la edición se haya iniciado desde una clínica. El
  // barrido adicional por nombre sí queda limitado a esa clínica para no
  // retirar por accidente plantillas homónimas de otras sedes.
  const replacedFamily = [{ id: safeReplacedTemplateId }];
  if (safeDisplayName) {
    replacedFamily.push({
      display_name: safeDisplayName,
      ...(safeClinicId ? { clinic_id: safeClinicId } : {}),
    });
  }

  await WhatsappTemplate.update(
    {
      is_active: false,
      superseded_by_template_id: safeKeepTemplateId,
    },
    {
      where: {
        waba_id: safeWabaId,
        created_by_user_id: safeCreatedByUserId,
        is_active: true,
        id: { [Op.ne]: safeKeepTemplateId },
        [Op.or]: replacedFamily,
      },
    }
  );
}

async function createCustomTemplateForClinic({
  clinicId,
  wabaId,
  accessToken,
  displayName,
  bodyText,
  headerImageUrl = null,
  category = 'UTILITY',
  language = DEFAULT_LANGUAGE,
  variables = [],
  templateUsage = null,
  replaceTemplateId = null,
  createdByUserId = null,
}) {
  const safeClinicId = Number(clinicId || 0) || null;
  const safeWabaId = cleanString(wabaId);
  const safeAccessToken = cleanString(accessToken);
  const safeDisplayName = cleanString(displayName) || 'Plantilla WhatsApp';
  const safeBodyText = cleanString(bodyText);
  const safeHeaderImageUrl = cleanString(headerImageUrl);
  const safeCategory = String(category || '').trim().toUpperCase() === 'MARKETING' ? 'MARKETING' : 'UTILITY';
  const safeTemplateUsage = cleanString(templateUsage).toLowerCase();
  if (!safeWabaId || !safeAccessToken) {
    throw new Error('missing_waba_credentials');
  }
  if (!safeBodyText) {
    throw new Error('template_body_required');
  }
  const safeReplaceTemplateId = Number(replaceTemplateId || 0) || null;
  const parsedCreatedByUserId = Number(createdByUserId || 0);
  const safeCreatedByUserId = Number.isInteger(parsedCreatedByUserId) && parsedCreatedByUserId > 0
    ? parsedCreatedByUserId
    : null;
  if (!safeCreatedByUserId) {
    const error = new Error('template_creator_required');
    error.code = 'template_creator_required';
    error.statusCode = 401;
    throw error;
  }

  let replacedTemplate = null;
  if (safeReplaceTemplateId) {
    replacedTemplate = await WhatsappTemplate.findByPk(safeReplaceTemplateId);
    if (!replacedTemplate || replacedTemplate.is_active === false) {
      const error = new Error('template_not_found');
      error.code = 'template_not_found';
      error.statusCode = 404;
      throw error;
    }
    if (
      Number(replacedTemplate.created_by_user_id || 0) !== safeCreatedByUserId
      || String(replacedTemplate.waba_id || '') !== safeWabaId
    ) {
      const error = new Error('template_owner_forbidden');
      error.code = 'template_owner_forbidden';
      error.statusCode = 403;
      throw error;
    }
  }

  const contract = buildVariableContractFromBody(safeBodyText, variables);
  const validationIssues = validateTemplateBodyForMeta(contract.body);
  if (validationIssues.length) {
    throw createTemplateValidationError(validationIssues);
  }
  const bodyComponent = {
    type: 'BODY',
    text: contract.body,
    ...(contract.variables.length ? {
      example: {
        body_text: [contract.variables.map((variable) => variable.example || variable.name)],
      },
    } : {}),
  };
  const extraComponents = buildCustomTemplateExtraComponents({ templateUsage: safeTemplateUsage });
  const technicalName = buildCustomTemplateTechnicalName(safeDisplayName);
  if (safeHeaderImageUrl && !/^https:\/\//i.test(safeHeaderImageUrl)) {
    const error = new Error('La imagen de cabecera debe usar una URL HTTPS publica.');
    error.code = 'invalid_template_header_image_url';
    error.statusCode = 400;
    throw error;
  }
  const imageHeaderComponents = safeHeaderImageUrl ? [{
    type: 'HEADER',
    format: 'IMAGE',
    example: {
      header_handle: [safeHeaderImageUrl],
    },
  }] : [];
  const draftTemplate = {
    name: technicalName,
    category: safeCategory,
    components: [...imageHeaderComponents, bodyComponent, ...extraComponents],
  };
  const preparedTemplate = await prepareTemplateImageHeaderForMeta({
    template: draftTemplate,
    accessToken: safeAccessToken,
  });
  if (preparedTemplate.issue) {
    const error = new Error(buildImageHeaderSamplePendingReason(preparedTemplate.issue));
    error.code = preparedTemplate.issue;
    error.statusCode = 400;
    error.details = [error.message];
    throw error;
  }
  const template = preparedTemplate.template;

  let metaTemplateId = null;
  try {
    const metaResp = await createTemplateInMeta({
      wabaId: safeWabaId,
      accessToken: safeAccessToken,
      template,
      language,
    });
    metaTemplateId = metaResp?.id || null;
  } catch (err) {
    const parsed = parseMetaError(err);
    if (Number(parsed?.code) === 100 || /invalid parameter/i.test(String(parsed?.message || ''))) {
      throw createMetaTemplateSubmissionError(parsed);
    }
    const row = await WhatsappTemplate.create({
      waba_id: safeWabaId,
      clinic_id: safeClinicId,
      name: technicalName,
      display_name: safeDisplayName,
      language,
      category: safeCategory,
      status: WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING,
      components: template.components,
      variables: annotateTemplateVariables(contract.variables, safeTemplateUsage),
      created_by_user_id: safeCreatedByUserId,
      origin: 'custom',
      rejection_reason: buildLocalPendingReasonFromMetaError(err),
      is_active: true,
    });
    row.meta_submission_error = parsed;
    return { row, submitted: false, error: parsed || err.message };
  }

  const row = await WhatsappTemplate.create({
    waba_id: safeWabaId,
    clinic_id: safeClinicId,
    name: technicalName,
    display_name: safeDisplayName,
    language,
    category: safeCategory,
    status: WHATSAPP_TEMPLATE_STATUS.PENDING,
    components: template.components,
    variables: annotateTemplateVariables(contract.variables, safeTemplateUsage),
    created_by_user_id: safeCreatedByUserId,
    meta_template_id: metaTemplateId,
    origin: 'custom',
    rejection_reason: null,
    is_active: true,
  });

  if (safeReplaceTemplateId) {
    const replaced = await replaceTemplateInEditableBulkSends({
      oldTemplateId: safeReplaceTemplateId,
      newTemplate: row,
    }).catch((err) => {
      console.error('Error actualizando borradores con nueva plantilla WhatsApp', {
        oldTemplateId: safeReplaceTemplateId,
        newTemplateId: row.id,
        error: err?.message || err,
      });
      return false;
    });

    if (replaced) {
      await deactivateReplacedTemplateFamily({
        wabaId: safeWabaId,
        clinicId: safeClinicId,
        displayName: replacedTemplate?.display_name || safeDisplayName,
        keepTemplateId: row.id,
        replacedTemplateId: safeReplaceTemplateId,
        createdByUserId: safeCreatedByUserId,
      });
    }
  }

  await enqueueSyncTemplatesJob({
    wabaId: safeWabaId,
    accessToken: safeAccessToken,
  }, { delayMs: 15 * 60 * 1000 }).catch(() => null);

  return { row, submitted: true, meta_template_id: metaTemplateId };
}

async function createTemplatesFromCatalog({ wabaId, clinicId, groupId, assignmentScope }) {
  if (!wabaId) return;

  const asset = await resolveWabaAssetById(wabaId);
  if (!asset?.waAccessToken) {
    throw new Error('missing_wa_access_token');
  }

  const lease = await acquireWabaCatalogCreationLease(wabaId, {
    sequelizeInstance: db.sequelize,
  });
  if (!lease.acquired) {
    return {
      skipped: true,
      reason: 'waba_catalog_creation_in_progress',
      lock_name: lease.lockName || null,
    };
  }

  try {
    // Refresh remote state under the same WABA lease before calculating the
    // next technical version.
    await syncTemplatesForWaba({ wabaId, accessToken: asset.waAccessToken });
    return await createTemplatesFromCatalogWithLease({
      wabaId,
      clinicId,
      groupId,
      assignmentScope,
      asset,
    });
  } finally {
    await lease.release();
  }
}

async function createTemplatesFromCatalogWithLease({
  wabaId,
  clinicId,
  groupId,
  assignmentScope,
  asset,
}) {
  const disciplinas = await resolveDisciplines({
    clinicId: assignmentScope === 'clinic' ? clinicId : null,
    groupId: assignmentScope === 'group' ? groupId : null,
  });

  const templates = await selectCatalogTemplatesByDisciplines(disciplinas);

  for (const template of templates) {
    const familyRows = await loadTemplateFamilyRows({ clinicId, wabaId, template });
    const sameContractRemoteTemplate = findSameContractRemoteTemplate({ familyRows, wabaId, template });

    if (sameContractRemoteTemplate) {
      if (Number(sameContractRemoteTemplate.catalog_template_id || 0) !== Number(template.id || 0)) {
        await sameContractRemoteTemplate.update({
          catalog_template_id: template.id,
          category: sameContractRemoteTemplate.category || template.category,
          origin: sameContractRemoteTemplate.origin || 'catalog',
          is_active: true,
        });
      }
      if (clinicId) {
        await upsertClinicOverrideTemplateForClinic({
          clinicId,
          template,
          technicalName: sameContractRemoteTemplate.name,
          status: mapRemoteStatusToLocalStatus(sameContractRemoteTemplate.status),
          metaTemplateId: sameContractRemoteTemplate.meta_template_id || null,
          rejectionReason: sameContractRemoteTemplate.rejection_reason || null,
        });
      }
      continue;
    }

    const familyName = getCatalogTechnicalFamilyName(template);
    const language = getCatalogTemplateLanguage(template);
    const technicalName = familyRows.length
      ? resolveNextTechnicalTemplateName(familyName, familyRows)
      : familyName;
    const preparedTemplate = await prepareTemplateImageHeaderForMeta({
      template: buildTemplateForTechnicalName(template, technicalName),
      accessToken: asset.waAccessToken,
      logger: console,
    });
    const metaTemplate = preparedTemplate.template;
    const imageHeaderSampleIssue = preparedTemplate.issue || getImageHeaderSampleIssue(metaTemplate);
    if (imageHeaderSampleIssue) {
      const rejectionReason = buildImageHeaderSamplePendingReason(imageHeaderSampleIssue);
      await upsertConnectedTemplateForWaba({
        wabaId,
        template,
        technicalName,
        status: WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING,
        metaTemplateId: null,
        rejectionReason,
      });
      if (clinicId) {
        await upsertClinicOverrideTemplateForClinic({
          clinicId,
          template,
          technicalName,
          status: WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING,
          metaTemplateId: null,
          rejectionReason,
        });
      }
      console.warn('Plantilla WhatsApp con cabecera de imagen no enviada a Meta por falta de media handle de ejemplo', {
        wabaId,
        name: technicalName,
        reason: imageHeaderSampleIssue,
      });
      continue;
    }

    try {
      const metaResp = await createTemplateInMeta({
        wabaId,
        accessToken: asset.waAccessToken,
        template: metaTemplate,
        language,
      });

      await upsertConnectedTemplateForWaba({
        wabaId,
        template,
        technicalName,
        status: WHATSAPP_TEMPLATE_STATUS.PENDING,
        metaTemplateId: metaResp?.id || null,
        rejectionReason: null,
      });

      if (clinicId) {
        await upsertClinicOverrideTemplateForClinic({
          clinicId,
          template,
          technicalName,
          status: WHATSAPP_TEMPLATE_STATUS.PENDING,
          metaTemplateId: metaResp?.id || null,
          rejectionReason: null,
        });
      }
    } catch (err) {
      if (isRetryableMetaError(err)) {
        throw err;
      }
      if (clinicId) {
        try {
          await upsertClinicOverrideTemplateForClinic({
            clinicId,
            template,
            technicalName,
            status: WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING,
            metaTemplateId: null,
            rejectionReason: buildLocalPendingReasonFromMetaError(err),
          });
        } catch (updateErr) {
          console.error('Error guardando rechazo local de plantilla WhatsApp', {
            clinicId,
            name: template.name,
            error: updateErr?.message || updateErr,
          });
        }
      }
      console.error('Error creando plantilla en Meta', {
        wabaId,
        name: technicalName,
        error: err?.response?.data || err.message,
      });
    }
  }
}

async function propagateCatalogTemplateToAllClinics({
  templateCatalogId,
  logger = console,
  sourceUpdatedAt = null,
  clinicIds = null,
  wabaIds = null,
  updateCatalogPropagationState = true,
  enqueueFollowupSync = true,
} = {}) {
  const template = await getCatalogTemplateById(templateCatalogId);
  if (!template) {
    throw new Error('catalog_not_found');
  }

  const sourceUpdatedAtTs = sourceUpdatedAt ? new Date(sourceUpdatedAt).getTime() : null;
  const scopedClinicIds = Array.isArray(clinicIds)
    ? Array.from(new Set(clinicIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)))
    : null;
  const scopedWabaIds = Array.isArray(wabaIds)
    ? new Set(wabaIds.map((value) => cleanString(String(value || ''))).filter(Boolean))
    : null;
  const canMarkCompleted = async () => {
    if (!updateCatalogPropagationState) return false;
    if (!Number.isFinite(sourceUpdatedAtTs)) return true;
    await template.reload();
    const currentUpdatedAtTs = new Date(template.updated_at || template.updatedAt || 0).getTime();
    return Number.isFinite(currentUpdatedAtTs) && currentUpdatedAtTs <= sourceUpdatedAtTs;
  };

  try {
    const clinics = await Clinica.findAll({
      ...(scopedClinicIds
        ? { where: { id_clinica: { [Op.in]: scopedClinicIds } } }
        : {}),
      attributes: ['id_clinica', 'configuracion'],
      order: [['id_clinica', 'ASC']],
      raw: true,
    });

    const whatsappService = require('./whatsapp.service');
    const summary = {
      catalog_template_id: template.id,
      clinics_total: clinics.length,
      clinics_targeted: 0,
      skipped_not_applicable: 0,
      placeholders_created: 0,
      placeholders_updated: 0,
      placeholders_deactivated: 0,
      waba_templates_updated: 0,
      created_in_meta: 0,
      errors: [],
    };
    const syncedWabas = new Set();
    const followupSyncs = new Map();
    const affectedTemplateInstances = new Map();

    for (const clinic of clinics) {
      const clinicId = Number(clinic.id_clinica);
      const clinicDisciplines = normalizeDisciplines(clinic?.configuracion?.disciplinas);
      const effectiveDisciplines = clinicDisciplines.length ? clinicDisciplines : ['dental'];
      const familyName = getCatalogTechnicalFamilyName(template);
      const language = getCatalogTemplateLanguage(template);
      let pendingTechnicalName = familyName;

      if (!templateAppliesToDisciplines(template, effectiveDisciplines)) {
        summary.skipped_not_applicable += 1;
        continue;
      }

      summary.clinics_targeted += 1;

      try {
        const clinicConfig = await whatsappService.getClinicConfig(clinicId);
        const wabaId = clinicConfig?.wabaId ? String(clinicConfig.wabaId) : null;
        if (scopedWabaIds && (!wabaId || !scopedWabaIds.has(wabaId))) {
          summary.skipped_outside_scope = (summary.skipped_outside_scope || 0) + 1;
          continue;
        }
        if (!wabaId) {
          const result = await upsertPlaceholderTemplateForClinic({ clinicId, template });
          if (result.action === 'created') summary.placeholders_created += 1;
          if (result.action === 'updated') summary.placeholders_updated += 1;
          if (result?.row?.id) affectedTemplateInstances.set(Number(result.row.id), result.row);
          continue;
        }

        if (!syncedWabas.has(wabaId) && clinicConfig.accessToken) {
          await syncTemplatesForWaba({ wabaId, accessToken: clinicConfig.accessToken });
          syncedWabas.add(wabaId);
        }

        if (template.is_active && wabaId && clinicConfig.accessToken) {
          followupSyncs.set(wabaId, clinicConfig.accessToken);
        }

        if (!template.is_active) {
          const result = await upsertPlaceholderTemplateForClinic({ clinicId, template });
          if (result.action === 'created') summary.placeholders_created += 1;
          if (result.action === 'updated') summary.placeholders_updated += 1;
          if (result?.row?.id) affectedTemplateInstances.set(Number(result.row.id), result.row);
          continue;
        }

        const familyRows = await loadTemplateFamilyRows({ clinicId, wabaId, template });
        const sameContractRemoteTemplate = findSameContractRemoteTemplate({ familyRows, wabaId, template });

        if (sameContractRemoteTemplate) {
          const result = await upsertClinicOverrideTemplateForClinic({
            clinicId,
            template,
            technicalName: sameContractRemoteTemplate.name,
            status: mapRemoteStatusToLocalStatus(sameContractRemoteTemplate.status),
            metaTemplateId: sameContractRemoteTemplate.meta_template_id || null,
            rejectionReason: sameContractRemoteTemplate.rejection_reason || null,
            logger,
          });
          if (result.action === 'created') summary.placeholders_created += 1;
          if (result.action === 'updated') summary.placeholders_updated += 1;
          if (result?.row?.id) affectedTemplateInstances.set(Number(result.row.id), result.row);
          logger.info?.('Propagación reutiliza versión técnica ya existente en Meta', {
            clinicId,
            templateCatalogId,
            templateName: template.name,
            technicalName: sameContractRemoteTemplate.name,
            remoteStatus: sameContractRemoteTemplate.status,
          });
          continue;
        }

        const technicalName = familyRows.length
          ? resolveNextTechnicalTemplateName(familyName, familyRows)
          : familyName;
        pendingTechnicalName = cleanString(technicalName) || pendingTechnicalName;
        const preparedTemplate = await prepareTemplateImageHeaderForMeta({
          template: buildTemplateForTechnicalName(template, technicalName),
          accessToken: clinicConfig.accessToken,
          logger,
        });
        const metaTemplate = preparedTemplate.template;
        const imageHeaderSampleIssue = preparedTemplate.issue || getImageHeaderSampleIssue(metaTemplate);
        if (imageHeaderSampleIssue) {
          const rejectionReason = buildImageHeaderSamplePendingReason(imageHeaderSampleIssue);
          await upsertConnectedTemplateForWaba({
            wabaId,
            template,
            technicalName,
            status: WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING,
            metaTemplateId: null,
            rejectionReason,
          });
          const result = await upsertClinicOverrideTemplateForClinic({
            clinicId,
            template,
            technicalName,
            status: WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING,
            metaTemplateId: null,
            rejectionReason,
            logger,
          });
          if (result.action === 'created') summary.placeholders_created += 1;
          if (result.action === 'updated') summary.placeholders_updated += 1;
          if (result?.row?.id) affectedTemplateInstances.set(Number(result.row.id), result.row);
          summary.waba_templates_updated += 1;
          logger.warn?.('Plantilla WhatsApp con cabecera de imagen no enviada a Meta por falta de media handle de ejemplo', {
            clinicId,
            wabaId,
            templateCatalogId,
            technicalName,
            reason: imageHeaderSampleIssue,
          });
          continue;
        }

        let metaResp;
        try {
          metaResp = await createTemplateInMeta({
            wabaId,
            accessToken: clinicConfig.accessToken,
            template: metaTemplate,
            language,
          });
        } catch (createError) {
          // Meta no ofrece una clave de idempotencia para esta operación. La
          // identidad estable es nombre técnico + idioma. Si el proceso cae
          // después del HTTP 200 y antes del checkpoint local, el reintento
          // recibe "already exists": resincronizamos y reutilizamos ese mismo
          // contrato; nunca generamos otro nombre por este borde de caída.
          if (!isDuplicateTemplateNameError(createError)) throw createError;
          await syncTemplatesForWaba({ wabaId, accessToken: clinicConfig.accessToken });
          const recoveredRows = await loadTemplateFamilyRows({ clinicId, wabaId, template });
          const recovered = findSameContractRemoteTemplate({
            familyRows: recoveredRows,
            wabaId,
            template,
          });
          if (!recovered || cleanString(recovered.name) !== cleanString(technicalName)) {
            throw buildMetaTemplateCheckpointPendingError(createError);
          }
          metaResp = {
            id: recovered.meta_template_id,
            status: recovered.status,
            recovered_after_duplicate: true,
          };
        }

        const submittedStatus = mapRemoteStatusToLocalStatus(
          metaResp?.status || WHATSAPP_TEMPLATE_STATUS.PENDING
        );

        await upsertConnectedTemplateForWaba({
          wabaId,
          template,
          technicalName,
          status: submittedStatus,
          metaTemplateId: metaResp?.id || null,
          rejectionReason: null,
        });

        const result = await upsertClinicOverrideTemplateForClinic({
          clinicId,
          template,
          technicalName,
          status: submittedStatus,
          metaTemplateId: metaResp?.id || null,
          rejectionReason: null,
          logger,
        });
        if (result.action === 'created') summary.placeholders_created += 1;
        if (result.action === 'updated') summary.placeholders_updated += 1;
        if (result?.row?.id) {
          await result.row.update({ meta_template_id: metaResp?.id || result.row.meta_template_id || null });
          affectedTemplateInstances.set(Number(result.row.id), result.row);
        }

        if (metaResp?.recovered_after_duplicate) {
          summary.recovered_after_meta_checkpoint = (summary.recovered_after_meta_checkpoint || 0) + 1;
        } else {
          summary.created_in_meta += 1;
        }
      } catch (err) {
        if (isRetryableMetaError(err)) throw err;
        const parsedMetaError = parseMetaError(err);
        const hasMetaResponse = !!(err?.response?.data || parsedMetaError?.message);
        if (hasMetaResponse && !isRetryableMetaError(err)) {
          const reason = buildLocalPendingReasonFromMetaError(err);
          try {
            const failedResult = await upsertClinicOverrideTemplateForClinic({
              clinicId,
              template,
              technicalName: pendingTechnicalName,
              status: WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING,
              metaTemplateId: null,
              rejectionReason: reason,
              logger,
            });
            if (failedResult.action === 'created') summary.placeholders_created += 1;
            if (failedResult.action === 'updated') summary.placeholders_updated += 1;
            if (failedResult?.row?.id) affectedTemplateInstances.set(Number(failedResult.row.id), failedResult.row);
          } catch (updateErr) {
            logger.error('Error guardando rechazo local de plantilla WhatsApp', {
              clinicId,
              templateCatalogId,
              error: updateErr?.message || updateErr,
            });
          }
          if (summary.errors.length < 25) {
            summary.errors.push({
              clinic_id: clinicId,
              error: `meta_submission_rejected:${reason}`,
            });
          }
          continue;
        }

        const errorMessage = err?.response?.data || err?.message || 'unknown_error';
        logger.error('Error propagando plantilla de catálogo a clínica', {
          clinicId,
          templateCatalogId,
          error: errorMessage,
        });
        if (summary.errors.length < 25) {
          summary.errors.push({
            clinic_id: clinicId,
            error: typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage),
          });
        }
      }
    }

    for (const templateInstance of affectedTemplateInstances.values()) {
      try {
        const syncResult = await recomposeAutomationsUsingTemplate({ templateInstance, logger });
        if (syncResult?.template_versions_touched) {
          summary.automation_templates_updated = (summary.automation_templates_updated || 0) + Number(syncResult.template_versions_touched || 0);
          summary.automation_nodes_updated = (summary.automation_nodes_updated || 0) + Number(syncResult.nodes_touched || 0);
        }
      } catch (syncErr) {
        const syncMessage = syncErr?.message || 'automation_recompose_failed';
        logger.error('Error recomponiendo automatizaciones ligadas a plantilla de catálogo', {
          templateCatalogId,
          templateInstanceId: templateInstance?.id || null,
          error: syncMessage,
        });
        if (summary.errors.length < 25) {
          summary.errors.push({
            clinic_id: templateInstance?.clinic_id || null,
            error: `automation_recompose_failed:${syncMessage}`,
          });
        }
      }
    }

    if (enqueueFollowupSync && followupSyncs.size > 0) {
      const delayMs = DEFAULT_PROPAGATE_RESYNC_DELAY_MINUTES * 60 * 1000;
      await Promise.all(
        Array.from(followupSyncs.entries()).map(([wabaId, accessToken]) =>
          enqueueSyncTemplatesJob(
            { wabaId, accessToken, trigger: 'propagate_followup' },
            { delayMs, dedupeWindowMs: delayMs }
          )
        )
      );
      summary.followup_sync_delay_minutes = DEFAULT_PROPAGATE_RESYNC_DELAY_MINUTES;
      summary.followup_sync_wabas = Array.from(followupSyncs.keys());
    }

    if (!updateCatalogPropagationState) {
      // Un rollout acotado no equivale a la propagación global del catálogo.
      // Conservamos sus marcadores globales sin cambios.
    } else if (summary.errors.length === 0) {
      if (await canMarkCompleted()) {
        await template.update({
          last_propagated_at: new Date(),
          propagation_state: 'completed',
        });
      } else {
        await template.update({
          propagation_state: null,
        });
      }
    } else {
      await template.update({
        propagation_state: 'failed',
      });
    }

    return summary;
  } catch (err) {
    if (updateCatalogPropagationState) {
      await template.update({
        propagation_state: 'failed',
      });
    }
    throw err;
  }
}

async function syncTemplatesForWaba({ wabaId, accessToken }) {
  if (!wabaId || !accessToken) {
    throw new Error('missing_waba_or_token');
  }

  const items = await fetchTemplatesFromMeta({ wabaId, accessToken });
  const now = new Date();
  const catalogs = await WhatsappTemplateCatalog.findAll({
    attributes: ['id', 'name', 'family_key', 'locale', 'display_name', 'body_text', 'is_active'],
    raw: true,
  });
  const catalogById = new Map(
    catalogs.map((catalog) => [Number(catalog.id), catalog]),
  );

  for (const tpl of items) {
    const catalog = resolveCatalogTemplateByTechnicalName(catalogs, tpl.name, tpl.language);
    const catalogIsActive = !catalog || (catalog.is_active !== false && Number(catalog.is_active) !== 0);
    const isStaleReviewTemplate = isStaleReviewRequestTemplate(tpl, catalog);
    const remoteRejectionReason = tpl.rejected_reason || tpl.rejection_reason || null;
    const rejectionReason = isStaleReviewTemplate
      ? [
          remoteRejectionReason,
          'Retirada localmente: version antigua de plantilla de resenas.',
        ].filter(Boolean).join(' | ')
      : remoteRejectionReason;
    const remoteQuality = cleanString(
      tpl?.quality_score?.score
      || tpl?.quality_score
      || tpl?.quality_rating
    ).toUpperCase() || null;
    const payload = {
      waba_id: wabaId,
      name: tpl.name,
      language: tpl.language || DEFAULT_LANGUAGE,
      category: tpl.category || null,
      status: tpl.status || null,
      rejection_reason: rejectionReason,
      components: tpl.components || null,
      meta_template_id: tpl.id || null,
      catalog_template_id: catalog?.id || null,
      origin: 'external',
      last_synced_at: now,
    };

    const existing = await WhatsappTemplate.findOne({
      where: { waba_id: wabaId, name: payload.name, language: payload.language },
    });
    const remoteStatus = cleanString(tpl.status).toUpperCase();
    if (remoteQuality) {
      payload.quality_score = remoteQuality;
      if (existing && remoteQuality !== cleanString(existing.quality_score).toUpperCase()) {
        payload.previous_quality_score = existing.quality_score || null;
        payload.quality_updated_at = now;
      } else if (!existing) {
        payload.quality_updated_at = now;
      }
    }
    if (!existing || remoteStatus !== cleanString(existing.status).toUpperCase()) {
      payload.provider_status_updated_at = now;
      if (remoteStatus === 'PAUSED') {
        payload.pause_count = Number(existing?.pause_count || 0) + 1;
        payload.last_paused_at = now;
      }
      if (['ACTIVE', 'APPROVED'].includes(remoteStatus)
        && ['PAUSED', 'DISABLED'].includes(cleanString(existing?.status).toUpperCase())) {
        payload.last_unpaused_at = now;
      }
    }
    const remoteIsPending = [WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'].includes(remoteStatus);
    payload.is_active = shouldKeepRemoteTemplateActive({
      existing,
      catalogIsActive,
      isStaleReviewTemplate,
    });
    payload.pending_since_at = remoteIsPending
      ? (existing?.pending_since_at || now)
      : null;
    let syncedRow = null;
    if (existing) {
      await existing.update(payload);
      syncedRow = existing;
    } else {
      syncedRow = await WhatsappTemplate.create(payload);
    }
    if (payload.is_active) {
      await notifyBulkSendsTemplateApproval(syncedRow);
    }
  }

  const linkedAssets = await ClinicMetaAsset.findAll({
    where: {
      isActive: true,
      wabaId,
      assetType: { [Op.in]: ['whatsapp_business_account', 'whatsapp_phone_number'] },
    },
    attributes: ['clinicaId', 'grupoClinicaId', 'assignmentScope'],
    raw: true,
  });

  const clinicIds = new Set();
  const groupIds = new Set();
  linkedAssets.forEach((asset) => {
    const assignmentScope = String(asset.assignmentScope || '').trim().toLowerCase();
    const clinicId = Number(asset.clinicaId || 0);
    const groupId = Number(asset.grupoClinicaId || 0);

    if (assignmentScope === 'clinic') {
      if (Number.isInteger(clinicId) && clinicId > 0) clinicIds.add(clinicId);
      return;
    }

    if (assignmentScope === 'group') {
      if (Number.isInteger(groupId) && groupId > 0) groupIds.add(groupId);
      return;
    }

    if (Number.isInteger(clinicId) && clinicId > 0) {
      clinicIds.add(clinicId);
    } else if (Number.isInteger(groupId) && groupId > 0) {
      groupIds.add(groupId);
    }
  });

  if (groupIds.size) {
    const groupClinics = await Clinica.findAll({
      where: { grupoClinicaId: { [Op.in]: Array.from(groupIds) } },
      attributes: ['id_clinica'],
      raw: true,
    });
    groupClinics.forEach((clinic) => {
      if (clinic.id_clinica) clinicIds.add(Number(clinic.id_clinica));
    });
  }

  const clinicIdList = Array.from(clinicIds).filter(Number.isFinite);
  if (!clinicIdList.length) {
    await enqueueStalePendingTemplateResubmissions({ wabaId, now });
    return;
  }

  const overrides = await WhatsappTemplate.findAll({
    where: {
      clinic_id: { [Op.in]: clinicIdList },
      waba_id: null,
      is_active: true,
    },
  });

  const remoteByKey = new Map();
  items.forEach((tpl) => {
    const key = `${String(tpl.name || '').trim().toLowerCase()}|${String(tpl.language || DEFAULT_LANGUAGE).trim().toLowerCase()}`;
    if (!remoteByKey.has(key)) {
      remoteByKey.set(key, tpl);
    }
  });

  for (const override of overrides) {
    const key = `${String(override.name || '').trim().toLowerCase()}|${String(override.language || DEFAULT_LANGUAGE).trim().toLowerCase()}`;
    const remote = remoteByKey.get(key);
    if (!remote) continue;

    const sameComponents = haveSameTemplateComponents(override.components, remote.components);
    const remoteStatus = String(remote.status || '').trim().toUpperCase();
    const catalog = catalogById.get(Number(override.catalog_template_id));
    const technicalVersion = extractTechnicalTemplateVersion(catalog?.name, override.name);
    const isVersionedTechnicalOverride = Number.isFinite(technicalVersion) && technicalVersion > 1;
    const sameTrackedMetaTemplate =
      !!override.meta_template_id
      && String(override.meta_template_id || '') === String(remote.id || '');
    const sameTrackedVersionedName =
      isVersionedTechnicalOverride
      && String(override.name || '').trim().toLowerCase() === String(remote.name || '').trim().toLowerCase();

    let nextStatus = override.status;
    let nextMetaTemplateId = override.meta_template_id || null;
    let nextRejectionReason = override.rejection_reason || null;
    if (sameTrackedMetaTemplate || sameTrackedVersionedName) {
      nextStatus = remoteStatus || override.status;
      nextMetaTemplateId = remote.id || override.meta_template_id || null;
      nextRejectionReason = remote.rejected_reason || remote.rejection_reason || null;
    } else if (sameComponents) {
      nextStatus = remoteStatus || override.status;
      nextMetaTemplateId = remote.id || override.meta_template_id || null;
      nextRejectionReason = remote.rejected_reason || remote.rejection_reason || null;
    } else if (['REJECTED', 'DISAPPROVED', 'DECLINED'].includes(remoteStatus)) {
      nextStatus = WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING;
      nextMetaTemplateId =
        String(override.meta_template_id || '') === String(remote.id || '')
          ? null
          : (override.meta_template_id || null);
      nextRejectionReason = override.rejection_reason || null;
    } else if (['PENDING', 'IN_REVIEW', 'APPROVED'].includes(remoteStatus)) {
      nextStatus = WHATSAPP_TEMPLATE_STATUS.LOCAL_PENDING;
      nextMetaTemplateId =
        String(override.meta_template_id || '') === String(remote.id || '')
          ? null
          : (override.meta_template_id || null);
      nextRejectionReason = override.rejection_reason || null;
    }

    const wasApproved = String(override.status || '').trim().toUpperCase() === WHATSAPP_TEMPLATE_STATUS.APPROVED;
    await override.update({
      status: nextStatus,
      meta_template_id: nextMetaTemplateId,
      rejection_reason: nextRejectionReason,
      pending_since_at: [WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'].includes(
        cleanString(nextStatus).toUpperCase(),
      ) ? (override.pending_since_at || now) : null,
      last_synced_at: now,
    });

    const isNowApproved = String(nextStatus || '').trim().toUpperCase() === WHATSAPP_TEMPLATE_STATUS.APPROVED;
    if (!wasApproved && isNowApproved) {
      await notifyReviewPhotoTemplateApproved(override, catalog);
    }
  }

  await enqueueStalePendingTemplateResubmissions({ wabaId, now });
}

async function enqueueCreateTemplatesJob(data) {
  return queues.whatsappTemplateCreate.add('create', data, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 60000 },
    removeOnComplete: true,
    removeOnFail: false,
  });
}

async function enqueuePropagateCatalogTemplateJob(data) {
  return queues.whatsappTemplateCreate.add('propagate_catalog_item', data, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 60000 },
    removeOnComplete: true,
    removeOnFail: false,
  });
}

function buildDelayedSyncJobId({ wabaId, delayMs, dedupeWindowMs }) {
  const safeWabaId = String(wabaId || '').trim();
  if (!safeWabaId || !delayMs || delayMs <= 0) {
    return null;
  }

  const windowMs = Math.max(delayMs, dedupeWindowMs || delayMs);
  const bucket = Math.floor((Date.now() + delayMs) / windowMs);
  const normalizedWabaId = safeWabaId.replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `sync-${normalizedWabaId}-followup-${bucket}`;
}

async function enqueueSyncTemplatesJob(data, options = {}) {
  const delayMs = Math.max(0, Number(options.delayMs || 0));
  const jobId = buildDelayedSyncJobId({
    wabaId: data?.wabaId,
    delayMs,
    dedupeWindowMs: options.dedupeWindowMs,
  });

  if (delayMs > 0) {
    const wabaId = String(data?.wabaId || data?.waba_id || '').trim();
    if (!wabaId) {
      throw new Error('whatsapp_template_sync_delayed requires data.wabaId');
    }
    const nextRunAt = new Date(Date.now() + delayMs);
    const { job } = await jobRequestsService.enqueueUniqueJobRequest({
      type: 'whatsapp_template_sync_delayed',
      priority: 'normal',
      status: 'waiting',
      origin: 'whatsapp_template_followup',
      maxAttempts: 5,
      nextRunAt,
      dedupeScope: jobId || `waba:${wabaId}:${nextRunAt.toISOString()}`,
      // Nunca persistir accessToken en JobRequests: el handler resuelve el
      // asset activo y sus credenciales justo antes de consultar Meta.
      payload: {
        wabaId,
        trigger: String(data?.trigger || 'template_followup').trim() || 'template_followup',
        scheduled_for: nextRunAt.toISOString(),
      },
    });
    return job;
  }

  return queues.whatsappTemplateSync.add('sync', data, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 60000 },
    removeOnComplete: true,
    removeOnFail: false,
  });
}

async function runDelayedSyncTemplatesJob(payload = {}) {
  const wabaId = String(payload.wabaId || payload.waba_id || '').trim();
  if (!wabaId) {
    throw new Error('whatsapp_template_sync_delayed requires payload.wabaId');
  }

  const scheduledFor = new Date(payload.scheduled_for || '');
  if (Number.isFinite(scheduledFor.getTime()) && scheduledFor.getTime() > Date.now() + 1000) {
    return {
      status: 'waiting',
      nextAllowedAt: scheduledFor,
      result: { waiting: true, wabaId, scheduled_for: scheduledFor.toISOString() },
    };
  }

  const asset = await resolveWabaAssetById(wabaId);
  if (!asset?.waAccessToken) {
    throw new Error('whatsapp_template_sync_delayed missing active WABA credentials');
  }

  await syncTemplatesForWaba({ wabaId, accessToken: asset.waAccessToken });
  return {
    status: 'completed',
    result: {
      wabaId,
      trigger: String(payload.trigger || 'template_followup').trim() || 'template_followup',
    },
  };
}

async function enqueueSyncForAllWabas(options = {}) {
  const onlyPending = options?.onlyPending === true;
  let targetWabaIds = null;

  if (onlyPending) {
    const pendingRows = await WhatsappTemplate.findAll({
      where: {
        is_active: true,
        waba_id: { [Op.ne]: null },
        status: { [Op.in]: [WHATSAPP_TEMPLATE_STATUS.PENDING, 'IN_REVIEW'] },
      },
      attributes: ['waba_id'],
      raw: true,
      group: ['waba_id'],
    });
    const pendingWabaIds = pendingRows
      .map((row) => String(row?.waba_id || '').trim())
      .filter(Boolean);

    const liveLists = await MarketingPatientList.findAll({
      where: {
        objective_id: 'mass_sends',
        status: { [Op.in]: ['prepared', 'queued', 'sending', 'scheduled', 'waiting_template_approval', 'paused'] },
      },
      attributes: ['criteria', 'template_snapshot'],
      raw: true,
    });
    const liveTemplateIds = Array.from(new Set(liveLists
      .filter((row) => String(parseMaybeJson(row?.criteria)?.dispatch?.status || '').toLowerCase() !== 'paused_review')
      .map((row) => Number(
        parseMaybeJson(row?.criteria)?.dispatch?.whatsapp_template_id
        || parseMaybeJson(row?.criteria)?.whatsapp_template_id
        || parseMaybeJson(row?.template_snapshot)?.id
        || 0
      ))
      .filter((id) => Number.isInteger(id) && id > 0)));
    const liveTemplateRows = liveTemplateIds.length
      ? await WhatsappTemplate.findAll({
        where: { id: { [Op.in]: liveTemplateIds }, is_active: true, waba_id: { [Op.ne]: null } },
        attributes: ['waba_id'],
        raw: true,
      })
      : [];
    targetWabaIds = Array.from(new Set([
      ...pendingWabaIds,
      ...liveTemplateRows.map((row) => String(row?.waba_id || '').trim()).filter(Boolean),
    ]));
    if (!targetWabaIds.length) {
      return { queued: 0, only_pending: true };
    }
  }

  const assets = await ClinicMetaAsset.findAll({
    where: {
      isActive: true,
      assetType: { [Op.in]: ['whatsapp_phone_number', 'whatsapp_business_account'] },
      wabaId: targetWabaIds ? { [Op.in]: targetWabaIds } : { [Op.ne]: null },
    },
    attributes: ['id', 'assetType', 'assignmentScope', 'wabaId', 'waAccessToken', 'updatedAt'],
    order: [
      [db.sequelize.literal("CASE WHEN assetType = 'whatsapp_phone_number' THEN 0 ELSE 1 END"), 'ASC'],
      [db.sequelize.literal("CASE WHEN assignmentScope = 'group' THEN 0 ELSE 1 END"), 'ASC'],
      ['updatedAt', 'DESC'],
      ['id', 'DESC'],
    ],
    raw: true,
  });

  let queued = 0;
  const seenWabas = new Set();
  for (const asset of assets) {
    if (!asset.wabaId || !asset.waAccessToken) continue;
    if (seenWabas.has(asset.wabaId)) continue;
    seenWabas.add(asset.wabaId);
    await enqueueSyncTemplatesJob({ wabaId: asset.wabaId, accessToken: asset.waAccessToken });
    queued += 1;
  }

  return { queued, only_pending: onlyPending, relevant_wabas: targetWabaIds?.length || null };
}

module.exports = {
  createTemplatesFromCatalog,
  createCustomTemplateForClinic,
  createPlaceholderTemplatesForClinic,
  propagateCatalogTemplateToAllClinics,
  syncTemplatesForWaba,
  enqueueStalePendingTemplateResubmissions,
  runStalePendingTemplateResubmission,
  enqueueCreateTemplatesJob,
  enqueuePropagateCatalogTemplateJob,
  enqueueSyncTemplatesJob,
  runDelayedSyncTemplatesJob,
  enqueueSyncForAllWabas,
  upsertClinicOverrideTemplateForClinic,
  _test: {
    findSameContractRemoteTemplate,
    isDuplicateTemplateNameError,
    buildMetaTemplateCheckpointPendingError,
  },
};
