'use strict';
const db = require('../../models');
const { Op } = require('sequelize');
const axios = require('axios');
const crypto = require('crypto');
const whatsappService = require('../services/whatsapp.service');
const { enqueueSyncPhonesJob, syncPhonesForWaba } = require('../services/whatsappPhones.service');
const { buildWhatsappTemplateVariableContract } = require('../lib/whatsapp-template-contract');

const {
  ClinicMetaAsset,
  UsuarioClinica,
  Clinica,
  WhatsappTemplate,
  AutomationFlowCatalog,
  AutomationFlowTemplateV2,
  Tratamiento,
  MetaConnection,
  GrupoClinica,
  WhatsappTemplateCatalog,
  WhatsappTemplateCatalogDiscipline,
} = db;

const ROLE_AGGREGATE = ['propietario', 'admin'];
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1,44').split(',').map((v) => parseInt(v.trim(), 10)).filter((n) => !Number.isNaN(n));
const META_API_VERSION = process.env.META_API_VERSION || 'v22.0';
const META_GRAPH_TOKEN = process.env.META_GRAPH_TOKEN || process.env.META_SYSTEM_USER_TOKEN || null;
const META_BUSINESS_ID = process.env.META_BUSINESS_ID || process.env.META_BM_ID || null;
const PREVERIFIED_ENABLED = String(process.env.WHATSAPP_PREVERIFIED_ENABLED || 'false').toLowerCase() === 'true';
const PHONE_SYNC_THROTTLE_MS = 5 * 60 * 1000;
const phoneSyncThrottle = new Map();

async function getUserClinics(userId) {
  const isAdmin = ADMIN_USER_IDS.includes(Number(userId));
  if (isAdmin) {
    const clinics = await Clinica.findAll({ attributes: ['id_clinica'], raw: true });
    return {
      clinicIds: clinics.map((c) => c.id_clinica),
      isAggregateAllowed: true,
    };
  }
  const memberships = await UsuarioClinica.findAll({
    where: { id_usuario: userId },
    attributes: ['id_clinica', 'rol_clinica'],
    raw: true,
  });
  const clinicIds = memberships.map((m) => m.id_clinica);
  const roles = memberships.map((m) => m.rol_clinica);
  const isAggregateAllowed = roles.some((r) => ROLE_AGGREGATE.includes(r));
  return { clinicIds, isAggregateAllowed };
}

function assertAdmin(req, res) {
  const uid = Number(req.userData?.userId);
  if (!uid || !ADMIN_USER_IDS.includes(uid)) {
    res.status(403).json({ error: 'admin_only' });
    return false;
  }
  return true;
}

function buildDuplicateDisplayName(baseDisplayName, duplicateIndex) {
  const base = String(baseDisplayName || '').trim();
  if (!base) return duplicateIndex > 1 ? `Copia ${duplicateIndex}` : 'Copia';
  return duplicateIndex > 1 ? `${base} (copia ${duplicateIndex})` : `${base} (copia)`;
}

function buildDuplicateTechnicalName(baseName, duplicateIndex) {
  const normalized = String(baseName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safeBase = normalized || 'plantilla';
  return duplicateIndex > 1 ? `${safeBase}_copy_${duplicateIndex}` : `${safeBase}_copy`;
}

async function resolveWhatsappCatalogDuplicateNames(itemId, { baseName, baseDisplayName }) {
  const rows = await WhatsappTemplateCatalog.findAll({
    attributes: ['id', 'name', 'display_name'],
    raw: true,
  });
  const takenNames = new Set(
    rows
      .filter((row) => Number(row.id) !== Number(itemId))
      .map((row) => String(row.name || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const takenDisplayNames = new Set(
    rows
      .filter((row) => Number(row.id) !== Number(itemId))
      .map((row) => String(row.display_name || '').trim().toLowerCase())
      .filter(Boolean)
  );

  let duplicateIndex = 1;
  let nextName = buildDuplicateTechnicalName(baseName, duplicateIndex);
  let nextDisplayName = buildDuplicateDisplayName(baseDisplayName || baseName, duplicateIndex);

  while (
    takenNames.has(String(nextName).trim().toLowerCase()) ||
    takenDisplayNames.has(String(nextDisplayName).trim().toLowerCase())
  ) {
    duplicateIndex += 1;
    nextName = buildDuplicateTechnicalName(baseName, duplicateIndex);
    nextDisplayName = buildDuplicateDisplayName(baseDisplayName || baseName, duplicateIndex);
  }

  return { name: nextName, display_name: nextDisplayName };
}

function parseIntOrNull(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function sanitizeTemplateKey(raw) {
  const base = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || null;
}

function sanitizeTemplateReference(raw) {
  const base = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || null;
}

async function getUserGroupIds({ clinicIds, isAggregateAllowed }) {
  if (isAggregateAllowed) {
    const clinics = await Clinica.findAll({
      attributes: ['grupoClinicaId'],
      raw: true,
    });
    return Array.from(
      new Set(clinics.map((c) => c.grupoClinicaId).filter((g) => !!g))
    );
  }

  if (!clinicIds.length) {
    return [];
  }

  const clinics = await Clinica.findAll({
    where: { id_clinica: { [Op.in]: clinicIds } },
    attributes: ['grupoClinicaId'],
    raw: true,
  });
  return Array.from(
    new Set(clinics.map((c) => c.grupoClinicaId).filter((g) => !!g))
  );
}

function parseWaError(err) {
  const base = err?.response?.data || err?.message || err;
  const nestedError = base?.error?.error || base?.error || base;
  const code = nestedError?.code || null;
  const message = nestedError?.message || String(base?.message || base || '');
  return { code, message, raw: base };
}

function validateCatalogTemplateBodyForMeta(bodyText) {
  const text = typeof bodyText === 'string' ? bodyText : '';
  const issues = [];

  if (!text.trim()) {
    issues.push('El cuerpo de la plantilla no puede estar vacío.');
    return issues;
  }

  if (/^\s*\{\{\d+\}\}/.test(text)) {
    issues.push('Meta no permite que el cuerpo empiece por una variable.');
  }

  if (/\{\{\d+\}\}\s*$/.test(text)) {
    issues.push('Meta no permite que el cuerpo termine en una variable; añade texto fijo después del último placeholder.');
  }

  if (/\{\{\d+\}\}\{\{\d+\}\}/.test(text)) {
    issues.push('Meta no permite variables consecutivas sin texto fijo entre ellas.');
  }

  return issues;
}

function assertValidCatalogTemplatePayload({ bodyText }, res) {
  const issues = validateCatalogTemplateBodyForMeta(bodyText);
  if (!issues.length) {
    return true;
  }

  res.status(400).json({
    error: 'invalid_template_body',
    details: issues,
  });
  return false;
}

async function fetchBusinessVerificationStatus({ businessId }) {
  if (!businessId || !META_GRAPH_TOKEN) return null;
  try {
    const resp = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/${businessId}` , {
      headers: { Authorization: `Bearer ${META_GRAPH_TOKEN}` },
      params: { fields: 'verification_status' },
    });
    return resp.data?.verification_status || null;
  } catch (err) {
    return null;
  }
}

async function resolveScopedWhatsappAssetForClinic({ clinicId, assetTypes }) {
  if (!clinicId) {
    return null;
  }

  const clinic = await Clinica.findOne({
    where: { id_clinica: clinicId },
    attributes: ['grupoClinicaId'],
    raw: true,
  });
  const groupId = clinic?.grupoClinicaId || null;

  for (const assetType of assetTypes) {
    const clinicAsset = await ClinicMetaAsset.findOne({
      where: {
        clinicaId: clinicId,
        isActive: true,
        assetType,
      },
      order: [['updatedAt', 'DESC']],
      raw: true,
    });
    if (clinicAsset) {
      return clinicAsset;
    }

    if (!groupId) {
      continue;
    }

    const groupAsset = await ClinicMetaAsset.findOne({
      where: {
        assignmentScope: 'group',
        grupoClinicaId: groupId,
        isActive: true,
        assetType,
      },
      order: [['updatedAt', 'DESC']],
      raw: true,
    });
    if (groupAsset) {
      return groupAsset;
    }
  }

  return null;
}

function getTemplateIdentityKey(templateLike) {
  const catalogTemplateId = Number(templateLike?.catalog_template_id || templateLike?.catalog?.id);
  if (Number.isFinite(catalogTemplateId) && catalogTemplateId > 0) {
    return `catalog:${catalogTemplateId}`;
  }
  const rawName = String(templateLike?.name || '').trim().toLowerCase();
  const name = rawName.replace(/_v\d+$/i, '');
  const language = String(templateLike?.language || 'es').trim().toLowerCase();
  return `${name}|${language}`;
}

function shouldHideLegacySystemTemplate(templateLike, usageLike) {
  const catalogTemplateId = Number(templateLike?.catalog_template_id || templateLike?.catalog?.id);
  if (Number.isFinite(catalogTemplateId) && catalogTemplateId > 0) {
    return false;
  }

  const origin = String(templateLike?.origin || '').trim().toLowerCase();
  const baseName = String(templateLike?.name || '').trim().toLowerCase().replace(/_v\d+$/i, '');
  if (origin !== 'external' || !baseName.startsWith('clinicaclick_')) {
    return false;
  }

  const flowCount = Array.isArray(usageLike?.flows) ? usageLike.flows.length : 0;
  const treatmentCount = Array.isArray(usageLike?.treatments) ? usageLike.treatments.length : 0;
  return flowCount === 0 && treatmentCount === 0;
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nodeUsesWhatsappTemplate(node, { templateId, templateName, catalogTemplateId }) {
  if (!node || String(node.type || '').toLowerCase() !== 'action/send_whatsapp') return false;
  const config = isObject(node.config) ? node.config : {};
  const nodeTemplateId = String(config.template_id || '').trim();
  const nodeTemplateName = String(config.template_name || '').trim().toLowerCase();
  const nodeCatalogTemplateId = Number(config.catalog_template_id);
  const nodeFallbackTemplateId = String(config.fallback_template_id || '').trim();
  const nodeFallbackTemplateName = String(config.fallback_template_name || '').trim().toLowerCase();
  const nodeFallbackCatalogTemplateId = Number(config.fallback_catalog_template_id);
  return (
    (templateId && nodeTemplateId === String(templateId))
    || (!!templateName && !!nodeTemplateName && nodeTemplateName === String(templateName).trim().toLowerCase())
    || (Number.isFinite(nodeCatalogTemplateId) && nodeCatalogTemplateId > 0 && nodeCatalogTemplateId === Number(catalogTemplateId))
    || (templateId && nodeFallbackTemplateId === String(templateId))
    || (!!templateName && !!nodeFallbackTemplateName && nodeFallbackTemplateName === String(templateName).trim().toLowerCase())
    || (Number.isFinite(nodeFallbackCatalogTemplateId) && nodeFallbackCatalogTemplateId > 0 && nodeFallbackCatalogTemplateId === Number(catalogTemplateId))
  );
}

async function loadAutomationCatalogLinkedTemplates(items) {
  const rows = Array.isArray(items) ? items : [];
  const publicIdRefs = new Set();
  const templateKeyRefs = new Set();

  rows.forEach((item) => {
    const rawRef = sanitizeTemplateReference(item?.template_key);
    if (!rawRef) return;
    publicIdRefs.add(rawRef);
    const asTemplateKey = sanitizeTemplateKey(rawRef);
    if (asTemplateKey) {
      templateKeyRefs.add(asTemplateKey);
    }
  });

  if (!publicIdRefs.size && !templateKeyRefs.size) {
    return new Map();
  }

  const linkedTemplates = await AutomationFlowTemplateV2.findAll({
    where: {
      [Op.or]: [
        publicIdRefs.size ? { public_id: { [Op.in]: Array.from(publicIdRefs) } } : null,
        templateKeyRefs.size ? { template_key: { [Op.in]: Array.from(templateKeyRefs) } } : null,
      ].filter(Boolean),
    },
    attributes: ['id', 'public_id', 'template_key', 'version', 'nodes'],
    raw: true,
  });

  const byItemId = new Map();
  rows.forEach((item) => {
    const rawRef = sanitizeTemplateReference(item?.template_key);
    const version = parseIntOrNull(item?.template_version);
    if (!rawRef) {
      byItemId.set(Number(item.id), null);
      return;
    }

    const byPublicId = linkedTemplates.filter((row) => String(row.public_id || '').trim().toLowerCase() === rawRef);
    const byTemplateKey = linkedTemplates.filter((row) => sanitizeTemplateKey(row.template_key) === sanitizeTemplateKey(rawRef));
    const familyRows = byPublicId.length ? byPublicId : byTemplateKey;
    if (!familyRows.length) {
      byItemId.set(Number(item.id), null);
      return;
    }

    let match = null;
    if (version) {
      match = familyRows.find((row) => Number(row.version) === version) || null;
    }
    if (!match) {
      match = [...familyRows].sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0] || null;
    }
    byItemId.set(Number(item.id), match);
  });

  return byItemId;
}

function pickPreferredTemplate(currentTemplate, nextTemplate, clinicId) {
  if (!currentTemplate) return nextTemplate;

  const currentClinicId = Number(currentTemplate?.clinic_id);
  const nextClinicId = Number(nextTemplate?.clinic_id);
  const currentIsClinicOverride = Number.isFinite(currentClinicId) && currentClinicId === Number(clinicId);
  const nextIsClinicOverride = Number.isFinite(nextClinicId) && nextClinicId === Number(clinicId);

  if (currentIsClinicOverride !== nextIsClinicOverride) {
    return nextIsClinicOverride ? nextTemplate : currentTemplate;
  }

  const currentUpdatedAt = new Date(currentTemplate?.updatedAt || currentTemplate?.updated_at || 0).getTime();
  const nextUpdatedAt = new Date(nextTemplate?.updatedAt || nextTemplate?.updated_at || 0).getTime();
  if (nextUpdatedAt !== currentUpdatedAt) {
    return nextUpdatedAt > currentUpdatedAt ? nextTemplate : currentTemplate;
  }

  const currentId = Number(currentTemplate?.id || 0);
  const nextId = Number(nextTemplate?.id || 0);
  return nextId > currentId ? nextTemplate : currentTemplate;
}

function extractTechnicalTemplateVersion(baseName, candidateName) {
  const safeBaseName = String(baseName || '').trim();
  const safeCandidate = String(candidateName || '').trim();
  if (!safeBaseName || !safeCandidate) return null;
  if (safeCandidate === safeBaseName) return 1;
  const match = safeCandidate.match(/^(.*)_v(\d+)$/i);
  if (!match) return null;
  if (String(match[1] || '').trim() !== safeBaseName) return null;
  const parsed = Number(match[2]);
  return Number.isFinite(parsed) && parsed >= 2 ? parsed : null;
}

async function loadEffectiveWhatsappTemplatesForClinic({ clinicId, userId, includeCatalog }) {
  const includeCatalogConfig = includeCatalog
    ? [{ model: WhatsappTemplateCatalog, as: 'catalog', attributes: ['id', 'name', 'display_name', 'body_text', 'variables'] }]
    : [];

  const overrides = await WhatsappTemplate.findAll({
    where: { clinic_id: clinicId, waba_id: null, is_active: true },
    include: includeCatalogConfig,
    order: [['updatedAt', 'DESC']],
  });

  const asset = await resolveWabaFromContext({ clinicId, userId });
  if (!asset?.wabaId) {
    return overrides;
  }

  const connectedTemplates = await WhatsappTemplate.findAll({
    where: {
      waba_id: asset.wabaId,
      is_active: true,
      [Op.or]: [
        { clinic_id: null },
        { clinic_id: clinicId },
      ],
    },
    include: includeCatalogConfig,
    order: [['updatedAt', 'DESC']],
  });

  const effective = new Map();
  connectedTemplates.forEach((template) => {
    const key = getTemplateIdentityKey(template);
    effective.set(key, pickPreferredTemplate(effective.get(key), template, clinicId));
  });
  overrides.forEach((template) => {
    const key = getTemplateIdentityKey(template);
    effective.set(key, pickPreferredTemplate(effective.get(key), template, clinicId));
  });
  return Array.from(effective.values());
}

async function buildWhatsappTemplateUsageMap({ clinicId, templates }) {
  const safeClinicId = Number(clinicId);
  if (!Number.isFinite(safeClinicId) || safeClinicId <= 0 || !Array.isArray(templates) || !templates.length) {
    return new Map();
  }

  const clinic = await Clinica.findOne({
    where: { id_clinica: safeClinicId },
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
  });
  const groupId = Number(clinic?.grupoClinicaId);

  const flowWhere = {
    is_active: true,
    published_at: { [Op.ne]: null },
    [Op.or]: [
      { clinic_id: safeClinicId },
      ...(Number.isFinite(groupId) && groupId > 0 ? [{ group_id: groupId }] : []),
      { is_system: true },
    ],
  };

  const flows = await AutomationFlowTemplateV2.findAll({
    where: flowWhere,
    attributes: ['id', 'public_id', 'template_key', 'name', 'nodes'],
    raw: true,
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
  });

  const treatments = await Tratamiento.findAll({
    where: {
      activo: true,
      appointment_automation_template_key: { [Op.ne]: null },
      [Op.or]: [
        { clinica_id: safeClinicId },
        ...(Number.isFinite(groupId) && groupId > 0 ? [{ grupo_clinica_id: groupId }] : []),
      ],
    },
    attributes: ['id_tratamiento', 'nombre', 'appointment_automation_template_key'],
    raw: true,
    order: [['nombre', 'ASC']],
  });

  const usageMap = new Map();

  templates.forEach((template) => {
    const json = template?.toJSON ? template.toJSON() : template;
    const templateId = Number(json?.id);
    const templateName = String(json?.name || '').trim();
    const catalogTemplateId = Number(json?.catalog_template_id);

    const matchedFlows = [];
    const flowKeySet = new Set();
    flows.forEach((flow) => {
      const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
      const matches = nodes.some((node) => nodeUsesWhatsappTemplate(node, { templateId, templateName, catalogTemplateId }));
      if (!matches) return;
      const uniqueKey = `${String(flow.public_id || flow.template_key || '')}|${String(flow.id)}`;
      if (flowKeySet.has(uniqueKey)) return;
      flowKeySet.add(uniqueKey);
      matchedFlows.push({
        id: flow.id,
        public_id: flow.public_id || null,
        template_key: flow.template_key || null,
        name: flow.name || null,
      });
    });

    const matchedTemplateKeys = new Set(
      matchedFlows
        .map((flow) => String(flow.template_key || '').trim())
        .filter(Boolean)
    );

    const matchedTreatments = treatments
      .filter((treatment) => matchedTemplateKeys.has(String(treatment.appointment_automation_template_key || '').trim()))
      .map((treatment) => ({
        id: treatment.id_tratamiento,
        name: treatment.nombre || null,
      }));

    usageMap.set(Number(templateId), {
      flows: matchedFlows,
      treatments: matchedTreatments,
    });
  });

  return usageMap;
}

function assertPreverifiedEnabled(req, res) {
  if (!PREVERIFIED_ENABLED) {
    res.status(403).json({ success: false, error: 'preverified_not_enabled' });
    return false;
  }
  if (!META_BUSINESS_ID || !META_GRAPH_TOKEN) {
    res.status(400).json({ success: false, error: 'preverified_not_configured' });
    return false;
  }
  return true;
}

function generateAutoPin() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

async function ensureAutoPin(asset, forceNew = false) {
  const additionalData = asset.additionalData || {};
  const registration = additionalData.registration || {};
  if (registration.autoPin && !forceNew) {
    return registration.autoPin;
  }
  const autoPin = generateAutoPin();
  additionalData.registration = {
    ...registration,
    autoPin,
  };
  asset.additionalData = additionalData;
  await asset.save();
  return autoPin;
}

async function updateRegistrationOnAsset(asset, registration) {
  const additionalData = asset.additionalData || {};
  additionalData.registration = {
    ...(additionalData.registration || {}),
    ...registration,
  };
  asset.additionalData = additionalData;
  await asset.save();
}

async function fetchPhoneStatus({ phoneNumberId, accessToken }) {
  if (!phoneNumberId || !accessToken) {
    return null;
  }
  try {
    const resp = await axios.get(
      `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          fields:
            'id,verified_name,display_phone_number,quality_rating,code_verification_status,status,platform_type',
        },
      }
    );
    return resp.data;
  } catch (err) {
    return null;
  }
}

async function attemptPhoneRegistration({ asset, pin, useAutoPin = false }) {
  const nowIso = new Date().toISOString();
  const accessToken = asset.waAccessToken;
  const phoneNumberId = asset.phoneNumberId;
  const explicitPin = pin ? String(pin).trim() : null;
  const autoPin = await ensureAutoPin(asset, useAutoPin);

  if (!accessToken || !phoneNumberId) {
    const registration = {
      status: 'error',
      requiresPin: false,
      lastAttemptAt: nowIso,
      lastErrorMessage: 'missing_access_token_or_phone_number_id',
      lastErrorCode: null,
    };
    await updateRegistrationOnAsset(asset, registration);
    return { success: false, registration };
  }

  try {
    // Si el numero ya esta conectado, no forzamos el registro ni pedimos PIN
    const currentStatus = await whatsappService.getPhoneNumberStatus({
      phoneNumberId,
      accessToken,
    });
    const codeStatus = String(currentStatus?.code_verification_status || '').toUpperCase();
    if (currentStatus?.status === 'CONNECTED' && codeStatus === 'VERIFIED') {
      const registration = {
        status: 'registered',
        requiresPin: false,
        lastAttemptAt: nowIso,
        registeredAt: nowIso,
        phoneStatus: currentStatus.status,
        codeVerificationStatus: currentStatus.code_verification_status || null,
        lastErrorCode: null,
        lastErrorMessage: null,
        autoPin: explicitPin || autoPin,
      };
      await updateRegistrationOnAsset(asset, registration);
      return { success: true, registration, status: currentStatus };
    }

    const pinToUse = explicitPin || (useAutoPin ? autoPin : null);
    if (pinToUse) {
      try {
        await whatsappService.setTwoStepVerification({
          phoneNumberId,
          accessToken,
          pin: pinToUse,
        });
      } catch (pinErr) {
        const parsed = parseWaError(pinErr);
        const registration = {
          status: 'pin_required',
          requiresPin: true,
          lastAttemptAt: nowIso,
          phoneStatus: currentStatus?.status || null,
          codeVerificationStatus: currentStatus?.code_verification_status || null,
          lastErrorCode: parsed.code,
          lastErrorMessage: parsed.message,
          lastErrorRaw: parsed.raw,
        };
        await updateRegistrationOnAsset(asset, registration);
        return { success: false, registration, error: parsed };
      }
    }

    await whatsappService.registerPhoneNumber({
      phoneNumberId,
      accessToken,
      pin: pinToUse || undefined,
    });
    const status = await whatsappService.getPhoneNumberStatus({
      phoneNumberId,
      accessToken,
    });
    const registration = {
      status: 'registered',
      requiresPin: false,
      lastAttemptAt: nowIso,
      registeredAt: nowIso,
      phoneStatus: status?.status || null,
      codeVerificationStatus: status?.code_verification_status || null,
      lastErrorCode: null,
      lastErrorMessage: null,
      autoPin: explicitPin || autoPin,
    };
    await updateRegistrationOnAsset(asset, registration);
    return { success: true, registration, status };
  } catch (err) {
    const { code, message, raw } = parseWaError(err);
    const lower = (message || '').toLowerCase();
    const pinRequired = code === 100 && lower.includes('pin');
    const alreadyRegistered = lower.includes('already registered');

    if (alreadyRegistered) {
      const status = await whatsappService.getPhoneNumberStatus({
        phoneNumberId,
        accessToken,
      });
      const registration = {
        status: 'registered',
        requiresPin: false,
        lastAttemptAt: nowIso,
        registeredAt: nowIso,
        phoneStatus: status?.status || null,
        codeVerificationStatus: status?.code_verification_status || null,
        lastErrorCode: null,
        lastErrorMessage: null,
        autoPin: explicitPin || autoPin,
      };
      await updateRegistrationOnAsset(asset, registration);
      return { success: true, registration, status };
    }

    // Intento silencioso con PIN auto-generado antes de pedir intervención humana
    if (pinRequired && !explicitPin) {
      try {
        await whatsappService.registerPhoneNumber({
          phoneNumberId,
          accessToken,
          pin: autoPin,
        });
        const status = await whatsappService.getPhoneNumberStatus({
          phoneNumberId,
          accessToken,
        });
        const registration = {
          status: 'registered',
          requiresPin: false,
          lastAttemptAt: nowIso,
          registeredAt: nowIso,
          phoneStatus: status?.status || null,
          codeVerificationStatus: status?.code_verification_status || null,
          lastErrorCode: null,
          lastErrorMessage: null,
          autoPinUsed: true,
          autoPin: explicitPin || autoPin,
        };
        await updateRegistrationOnAsset(asset, registration);
        return { success: true, registration, status };
      } catch (autoErr) {
        const autoParsed = parseWaError(autoErr);
        const autoLower = (autoParsed.message || '').toLowerCase();
        if (autoLower.includes('already registered')) {
          const status = await whatsappService.getPhoneNumberStatus({
            phoneNumberId,
            accessToken,
          });
          const registration = {
            status: 'registered',
            requiresPin: false,
            lastAttemptAt: nowIso,
            registeredAt: nowIso,
            phoneStatus: status?.status || null,
            codeVerificationStatus: status?.code_verification_status || null,
            lastErrorCode: null,
            lastErrorMessage: null,
            autoPinUsed: true,
            autoPin: explicitPin || autoPin,
          };
          await updateRegistrationOnAsset(asset, registration);
          return { success: true, registration, status };
        }
        const status = await fetchPhoneStatus({ phoneNumberId, accessToken });
        const registration = {
          status: 'pin_required',
          requiresPin: true,
          lastAttemptAt: nowIso,
          phoneStatus: status?.status || null,
          codeVerificationStatus: status?.code_verification_status || null,
          lastErrorCode: autoParsed.code,
          lastErrorMessage: autoParsed.message,
          lastErrorRaw: autoParsed.raw,
          autoPinUsed: true,
          autoPin: explicitPin || autoPin,
        };
        await updateRegistrationOnAsset(asset, registration);
        return { success: false, registration, status };
      }
    }

    const status = await fetchPhoneStatus({ phoneNumberId, accessToken });
    const registration = {
      status: pinRequired ? 'pin_required' : 'error',
      requiresPin: pinRequired,
      lastAttemptAt: nowIso,
      phoneStatus: status?.status || null,
      codeVerificationStatus: status?.code_verification_status || null,
      lastErrorCode: code,
      lastErrorMessage: message,
      lastErrorRaw: raw,
      autoPin: explicitPin || autoPin,
    };
    if (code === 133016 || String(message || '').toLowerCase().includes('too many attempts')) {
      registration.status = 'blocked';
      registration.blockedUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      registration.requiresPin = false;
    }
    await updateRegistrationOnAsset(asset, registration);
    return { success: false, registration, status };
  }
}

exports.getStatus = async (req, res) => {
  try {
    const clinicId = Number(req.query.clinic_id);
    if (!clinicId) {
      return res.status(400).json({ error: 'clinic_id requerido' });
    }

    const asset = await resolveScopedWhatsappAssetForClinic({
      clinicId,
      assetTypes: ['whatsapp_phone_number', 'whatsapp_business_account'],
    });

    if (!asset) {
      return res.json({ configured: false });
    }

    return res.json({
      configured: true,
      wabaId: asset.wabaId || null,
      phoneNumberId: asset.phoneNumberId || null,
      waVerifiedName: asset.waVerifiedName || null,
      quality_rating: asset.quality_rating || null,
      messaging_limit: asset.messaging_limit || null,
      phoneNumber: asset.metaAssetName || null,
    });
  } catch (err) {
    console.error('Error getStatus', err);
    return res.status(500).json({ error: 'Error obteniendo estado de WhatsApp' });
  }
};

exports.listAccounts = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const userGroupIds = await getUserGroupIds({ clinicIds, isAggregateAllowed });
    const clinicIdFilter = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    const groupIdFilter = req.query.group_id ? Number(req.query.group_id) : null;
    if (groupIdFilter && !isAggregateAllowed) {
      return res.status(403).json({ error: 'group_scope_not_allowed' });
    }
    const where = {
      isActive: true,
      assetType: 'whatsapp_phone_number',
    };

    if (groupIdFilter) {
      const groupClinics = await Clinica.findAll({
        where: { grupoClinicaId: groupIdFilter },
        attributes: ['id_clinica'],
        raw: true,
      });
      const groupClinicIds = groupClinics.map((c) => c.id_clinica).filter(Boolean);
      where[Op.or] = [
        { clinicaId: { [Op.in]: groupClinicIds.length ? groupClinicIds : [-1] } },
        { assignmentScope: 'group', grupoClinicaId: groupIdFilter },
      ];
    } else if (clinicIdFilter) {
      const clinic = await Clinica.findOne({
        where: { id_clinica: clinicIdFilter },
        attributes: ['grupoClinicaId'],
        raw: true,
      });
      const groupIdFromClinic = clinic?.grupoClinicaId || null;
      where[Op.or] = [
        { clinicaId: clinicIdFilter },
        { assignmentScope: 'group', grupoClinicaId: groupIdFromClinic },
      ];
    } else if (!isAggregateAllowed) {
      where[Op.or] = [
        { clinicaId: { [Op.in]: clinicIds } },
        { assignmentScope: 'group', grupoClinicaId: { [Op.in]: userGroupIds.length ? userGroupIds : [-1] } },
        { assignmentScope: 'unassigned', '$metaConnection.userId$': userId },
      ];
    }
    const assets = await ClinicMetaAsset.findAll({
      where,
      include: [
        { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] },
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
      ],
      raw: true,
    });

    const payload = assets.map((a) => ({
      clinic_id: a.clinicaId,
      clinic_name: a['clinica.nombre_clinica'] || null,
      wabaId: a.wabaId || null,
      phoneNumberId: a.phoneNumberId || null,
      waVerifiedName: a.waVerifiedName || null,
      quality_rating: a.quality_rating || null,
      messaging_limit: a.messaging_limit || null,
      assignmentScope: a.assignmentScope || 'clinic',
    }));
    return res.json(payload);
  } catch (err) {
    console.error('Error listAccounts', err);
    return res.status(500).json({ error: 'Error obteniendo cuentas WhatsApp' });
  }
};

exports.templatesSummary = async (req, res) => {
  try {
    const clinicId = Number(req.query.clinic_id);
    if (!clinicId) {
      return res.status(400).json({ error: 'clinic_id requerido' });
    }
    const totals = await loadEffectiveWhatsappTemplatesForClinic({
      clinicId,
      userId: req.userData?.userId,
      includeCatalog: false,
    });
    const summary = { total: 0, approved: 0, pending: 0, rejected: 0, sin_conectar: 0 };
    totals.forEach((row) => {
      summary.total += 1;
      const st = String(row.status || '').toLowerCase();
      if (st === 'approved' || st === 'approved_pending') summary.approved += 1;
      else if (st === 'pending' || st === 'in_review') summary.pending += 1;
      else if (st === 'rejected') summary.rejected += 1;
      else if (st === 'sin_conectar') summary.sin_conectar += 1;
    });
    return res.json(summary);
  } catch (err) {
    console.error('Error templatesSummary', err);
    return res.status(500).json({ error: 'Error obteniendo resumen de plantillas' });
  }
};

async function resolveWabaFromContext({ clinicId, phoneNumberId, userId }) {
  const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
  const where = {
    isActive: true,
    assetType: { [Op.in]: ['whatsapp_phone_number', 'whatsapp_business_account'] },
  };

  // Resolver grupo de la clinica para soportar numeros con scope de grupo
  let clinicGroupId = null;
  let userGroupIds = [];
  if (clinicId) {
    const clinic = await Clinica.findOne({
      where: { id_clinica: clinicId },
      attributes: ['grupoClinicaId'],
      raw: true,
    });
    clinicGroupId = clinic?.grupoClinicaId || null;
  }

  if (!isAggregateAllowed && clinicIds.length) {
    const clinics = await Clinica.findAll({
      where: { id_clinica: { [Op.in]: clinicIds } },
      attributes: ['grupoClinicaId'],
      raw: true,
    });
    userGroupIds = Array.from(
      new Set(clinics.map((c) => c.grupoClinicaId).filter((g) => !!g))
    );
  }

  if (phoneNumberId) {
    where.phoneNumberId = phoneNumberId;
  } else if (clinicId) {
    const clinicScope = [{ clinicaId: clinicId }];
    if (clinicGroupId) {
      clinicScope.push({ assignmentScope: 'group', grupoClinicaId: clinicGroupId });
    }
    where[Op.or] = clinicScope;
  }

  const asset = await ClinicMetaAsset.findOne({
    where,
    include: [{ model: MetaConnection, as: 'metaConnection', attributes: ['userId'] }],
    order: [['updatedAt', 'DESC']],
  });

  if (!asset || isAggregateAllowed) {
    return asset;
  }

  const hasClinicAccess = asset.clinicaId && clinicIds.includes(asset.clinicaId);
  const hasGroupAccess =
    asset.assignmentScope === 'group' &&
    asset.grupoClinicaId &&
    userGroupIds.includes(asset.grupoClinicaId);
  const isUnassignedOwner =
    asset.assignmentScope === 'unassigned' && asset.metaConnection?.userId === userId;

  if (!hasClinicAccess && !hasGroupAccess && !isUnassignedOwner) {
    return null;
  }

  return asset;
}

exports.listTemplatesForClinic = async (req, res) => {
  try {
    const clinicId = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    const phoneNumberId = req.query.phone_number_id || null;
    const userId = req.userData?.userId;

    if (!clinicId && !phoneNumberId) {
      return res.status(400).json({ error: 'clinic_id o phone_number_id requerido' });
    }

    let templates = [];
    if (clinicId) {
      templates = await loadEffectiveWhatsappTemplatesForClinic({
        clinicId,
        userId,
        includeCatalog: true,
      });
    } else {
      const asset = await resolveWabaFromContext({ clinicId, phoneNumberId, userId });
      if (!asset || !asset.wabaId) {
        return res.json([]);
      }
      templates = await WhatsappTemplate.findAll({
        where: {
          waba_id: asset.wabaId,
          is_active: true,
        },
        include: [{ model: WhatsappTemplateCatalog, as: 'catalog', attributes: ['id', 'name', 'display_name', 'body_text', 'variables'] }],
        order: [['name', 'ASC']],
      });
    }

    const usageMap = clinicId
      ? await buildWhatsappTemplateUsageMap({ clinicId, templates })
      : new Map();

    return res.json(
      templates
        .map((item) => {
          const json = item.toJSON ? item.toJSON() : item;
          const usage = usageMap.get(Number(json.id)) || { flows: [], treatments: [] };
          return {
            ...json,
            variables: buildWhatsappTemplateVariableContract(json),
            usage,
          };
        })
        .filter((item) => !(clinicId && shouldHideLegacySystemTemplate(item, item.usage)))
    );
  } catch (err) {
    console.error('Error listTemplatesForClinic', err);
    return res.status(500).json({ error: 'Error obteniendo plantillas' });
  }
};

exports.syncTemplates = async (req, res) => {
  try {
    const clinicId = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    const phoneNumberId = req.query.phone_number_id || null;
    const userId = req.userData?.userId;

    if (!clinicId && !phoneNumberId) {
      return res.status(400).json({ error: 'clinic_id o phone_number_id requerido' });
    }

    const asset = await resolveWabaFromContext({ clinicId, phoneNumberId, userId });
    if (!asset || !asset.wabaId || !asset.waAccessToken) {
      return res.status(404).json({ error: 'waba_not_found' });
    }

    const { enqueueSyncTemplatesJob } = require('../services/whatsappTemplates.service');
    const job = await enqueueSyncTemplatesJob({ wabaId: asset.wabaId, accessToken: asset.waAccessToken });
    return res.json({ success: true, jobId: job?.id || null });
  } catch (err) {
    console.error('Error syncTemplates', err);
    return res.status(500).json({ error: 'Error sincronizando plantillas' });
  }
};

exports.createTemplatesFromCatalog = async (req, res) => {
  try {
    const clinicId = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    const phoneNumberId = req.query.phone_number_id || null;
    const userId = req.userData?.userId;

    if (!clinicId && !phoneNumberId) {
      return res.status(400).json({ error: 'clinic_id o phone_number_id requerido' });
    }

    const asset = await resolveWabaFromContext({ clinicId, phoneNumberId, userId });
    if (!asset || !asset.wabaId) {
      return res.status(404).json({ error: 'waba_not_found' });
    }

    const { enqueueCreateTemplatesJob } = require('../services/whatsappTemplates.service');
    const job = await enqueueCreateTemplatesJob({
      wabaId: asset.wabaId,
      clinicId: asset.clinicaId || null,
      groupId: asset.grupoClinicaId || null,
      assignmentScope: asset.assignmentScope || 'clinic',
    });
    return res.json({ success: true, jobId: job?.id || null });
  } catch (err) {
    console.error('Error createTemplatesFromCatalog', err);
    return res.status(500).json({ error: 'Error creando plantillas' });
  }
};

exports.listPhones = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const userGroupIds = await getUserGroupIds({ clinicIds, isAggregateAllowed });
    const clinicIdFilter = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    const groupIdFilter = req.query.group_id ? Number(req.query.group_id) : null;
    if (groupIdFilter && !isAggregateAllowed) {
      return res.status(403).json({ error: 'group_scope_not_allowed' });
    }
    let groupIdFromClinic = null;
    if (clinicIdFilter) {
      const clinic = await Clinica.findOne({ where: { id_clinica: clinicIdFilter }, attributes: ['grupoClinicaId'], raw: true });
      groupIdFromClinic = clinic?.grupoClinicaId || null;
    }

    const where = {
      isActive: true,
      assetType: 'whatsapp_phone_number',
    };

    if (groupIdFilter) {
      const groupClinics = await Clinica.findAll({
        where: { grupoClinicaId: groupIdFilter },
        attributes: ['id_clinica'],
        raw: true,
      });
      const groupClinicIds = groupClinics.map((c) => c.id_clinica).filter(Boolean);
      where[Op.or] = [
        { clinicaId: { [Op.in]: groupClinicIds.length ? groupClinicIds : [-1] } },
        { assignmentScope: 'group', grupoClinicaId: groupIdFilter },
      ];
    } else if (clinicIdFilter) {
      where[Op.or] = [
        { clinicaId: clinicIdFilter },
        { assignmentScope: 'group', grupoClinicaId: groupIdFromClinic },
      ];
    } else if (!isAggregateAllowed) {
      where[Op.or] = [
        { clinicaId: { [Op.in]: clinicIds } },
        { assignmentScope: 'group', grupoClinicaId: { [Op.in]: userGroupIds.length ? userGroupIds : [-1] } },
        { assignmentScope: 'unassigned', '$metaConnection.userId$': userId },
      ];
    }

    const phones = await ClinicMetaAsset.findAll({
      where,
      include: [
        { 
          model: Clinica, 
          as: 'clinica', 
          attributes: ['id_clinica', 'nombre_clinica', 'url_avatar', 'grupoClinicaId'],
          include: [{
            model: GrupoClinica,
            as: 'grupoClinica',
            attributes: ['id_grupo', 'nombre_grupo']
          }]
        },
        {
          // Necesario cuando el scope es "group" y no hay clinicaId
          model: GrupoClinica,
          as: 'grupoClinica',
          attributes: ['id_grupo', 'nombre_grupo'],
        },
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
      ],
      order: [['createdAt', 'DESC']],
    });

    const wabaIds = Array.from(
      new Set(
        phones
          .map((p) => p.wabaId)
          .filter((id) => id && String(id).trim().length > 0)
      )
    );
    const wabaBusinessMap = new Map();
    if (wabaIds.length) {
      const wabaAssets = await ClinicMetaAsset.findAll({
        where: {
          assetType: 'whatsapp_business_account',
          wabaId: { [Op.in]: wabaIds },
        },
        attributes: ['wabaId', 'additionalData'],
      });
      for (const wa of wabaAssets) {
        const businessId = wa.additionalData?.businessId || null;
        if (businessId) {
          wabaBusinessMap.set(wa.wabaId, businessId);
        }
      }
    }

    // Resolver estado de verificación de empresas (si hay token disponible)
    const businessIds = new Set();
    for (const p of phones) {
      if (p.additionalData?.businessId) {
        businessIds.add(p.additionalData.businessId);
      }
      const mapped = p.wabaId ? wabaBusinessMap.get(p.wabaId) : null;
      if (mapped) businessIds.add(mapped);
    }
    const businessStatusMap = new Map();
    if (META_GRAPH_TOKEN && businessIds.size) {
      for (const businessId of businessIds.values()) {
        const status = await fetchBusinessVerificationStatus({ businessId });
        if (status) {
          businessStatusMap.set(businessId, status);
        }
      }
    }

    // Disparar sync on-demand con throttling para reducir estados stale
    const now = Date.now();
    const wabaTokens = new Map();
    for (const p of phones) {
      if (p.wabaId && p.waAccessToken && !wabaTokens.has(p.wabaId)) {
        wabaTokens.set(p.wabaId, p.waAccessToken);
      }
    }
    for (const [wabaId, accessToken] of wabaTokens.entries()) {
      const lastTriggered = phoneSyncThrottle.get(wabaId) || 0;
      if (now - lastTriggered < PHONE_SYNC_THROTTLE_MS) {
        continue;
      }
      phoneSyncThrottle.set(wabaId, now);
      enqueueSyncPhonesJob({ wabaId, accessToken }).catch((err) => {
        console.warn('[whatsapp] No se pudo encolar sync de phones', err?.message || err);
      });
    }

    const payload = [];

    for (const p of phones) {
      const clinica = p.clinica || {};
      const grupoDirecto = p.grupoClinica || {};
      const grupoClinica = clinica.grupoClinica || {};
      const grupo = grupoDirecto.id_grupo ? grupoDirecto : grupoClinica;
      let registration = p.additionalData?.registration || null;

      // Normaliza el estado si el numero ya aparece como CONNECTED en Meta
      if (
        registration?.status !== 'registered' &&
        p.phoneNumberId &&
        p.waAccessToken
      ) {
        const liveStatus = await fetchPhoneStatus({
          phoneNumberId: p.phoneNumberId,
          accessToken: p.waAccessToken,
        });
        const codeStatus = String(liveStatus?.code_verification_status || '').toUpperCase();
        if (liveStatus?.status === 'CONNECTED' && codeStatus === 'VERIFIED') {
          const nowIso = new Date().toISOString();
          registration = {
            status: 'registered',
            requiresPin: false,
            lastAttemptAt: nowIso,
            registeredAt: registration?.registeredAt || nowIso,
            phoneStatus: liveStatus.status,
            codeVerificationStatus: liveStatus.code_verification_status || null,
            lastErrorCode: null,
            lastErrorMessage: null,
          };
          await updateRegistrationOnAsset(p, registration);
        } else if (liveStatus?.status === 'CONNECTED' && codeStatus && registration?.status !== 'registered') {
          const nowIso = new Date().toISOString();
          registration = {
            status: 'not_registered',
            requiresPin: true,
            lastAttemptAt: nowIso,
            registeredAt: registration?.registeredAt || null,
            phoneStatus: liveStatus.status,
            codeVerificationStatus: liveStatus.code_verification_status || null,
            lastErrorCode: null,
            lastErrorMessage: registration?.lastErrorMessage || null,
          };
          await updateRegistrationOnAsset(p, registration);
        }
      }

      const usage = await whatsappService.getOutboundUsageForPhone({
        clinicConfig: {
          assignmentScope: p.assignmentScope,
          clinicaId: p.clinicaId,
          grupoClinicaId: p.grupoClinicaId,
          additionalData: p.additionalData || {},
        },
        displayPhoneNumber: p.metaAssetName || null,
      });

      const managerBusinessId =
        p.additionalData?.businessId || wabaBusinessMap.get(p.wabaId) || null;
      const businessVerificationStatus =
        p.additionalData?.businessVerificationStatus ||
        (managerBusinessId ? businessStatusMap.get(managerBusinessId) : null) ||
        null;

      const additionalData = p.additionalData || {};

      if (businessVerificationStatus && additionalData.businessVerificationStatus !== businessVerificationStatus) {
        additionalData.businessVerificationStatus = businessVerificationStatus;
        p.additionalData = additionalData;
        await p.save();
      }

      payload.push({
        id: p.id,
        phoneNumberId: p.phoneNumberId,
        wabaId: p.wabaId,
        phoneNumber: p.metaAssetName || null,
        waVerifiedName: p.waVerifiedName || null,
        quality_rating: p.quality_rating || null,
        messaging_limit: p.messaging_limit || null,
        assignmentScope: p.assignmentScope,
        clinic_id: p.clinicaId || null,
        clinic_name: clinica.nombre_clinica || null,
        clinic_avatar: clinica.url_avatar || null,
        group_id: grupo.id_grupo || p.grupoClinicaId || clinica.grupoClinicaId || null,
        group_name: grupo.nombre_grupo || null,
        manager_business_id: managerBusinessId,
        business_verification_status: businessVerificationStatus,
        name_status: additionalData.nameStatus || null,
        name_status_reason: additionalData.nameStatusReason || null,
        requested_display_name: additionalData.requestedDisplayName || null,
        profile_picture_url: additionalData.profilePictureUrl || null,
        profile_description: additionalData.profileDescription || null,
        profile_category: additionalData.profileCategory || null,
        profile_email: additionalData.profileEmail || null,
        profile_website: additionalData.profileWebsite || null,
        profile_address: additionalData.profileAddress || null,
        registration_status: registration?.status || null,
        registration_requires_pin: registration?.requiresPin || false,
        registration_phone_status: registration?.phoneStatus || null,
        registration_code_verification_status: registration?.codeVerificationStatus || null,
        registration_blocked_until: registration?.blockedUntil || null,
        registration_last_error: registration?.lastErrorMessage || null,
        limited_mode: usage?.limitedMode || false,
        limited_mode_count: usage?.limitedMode ? usage.count : null,
        limited_mode_limit: usage?.limitedMode ? usage.limit : null,
        is_test_number: !!additionalData.isTestNumber,
        account_mode: additionalData.accountMode || null,
        platform_type: additionalData.platformType || null,
        is_preverified: !!additionalData.isPreverified,
        verification_expiry_time: additionalData.verificationExpiryTime || null,
        createdAt: p.createdAt,
      });
    }

    return res.json({ phones: payload, preverified_enabled: PREVERIFIED_ENABLED });
  } catch (err) {
    console.error('Error listPhones', err);
    return res.status(500).json({ error: 'Error obteniendo números WhatsApp' });
  }
};

// =======================
// Catálogo de plantillas
// =======================

exports.listCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const items = await WhatsappTemplateCatalog.findAll({
      include: [
        {
          model: WhatsappTemplateCatalogDiscipline,
          as: 'disciplinas',
          attributes: ['id', 'disciplina_code'],
        },
      ],
      order: [['name', 'ASC']],
    });

    const catalogIds = items
      .map((item) => Number(item?.id))
      .filter((value) => Number.isFinite(value) && value > 0);

    const instances = catalogIds.length
      ? await WhatsappTemplate.findAll({
          where: {
            catalog_template_id: { [Op.in]: catalogIds },
            is_active: true,
          },
          attributes: ['catalog_template_id', 'name', 'status', 'waba_id', 'clinic_id'],
          raw: true,
        })
      : [];

    const clinicIds = Array.from(
      new Set(
        instances
          .map((instance) => Number(instance?.clinic_id))
          .filter((value) => Number.isFinite(value) && value > 0)
      )
    );

    const clinics = clinicIds.length
      ? await Clinica.findAll({
          where: { id_clinica: { [Op.in]: clinicIds } },
          attributes: ['id_clinica', 'nombre_clinica'],
          raw: true,
        })
      : [];

    const clinicNameById = new Map(
      clinics.map((clinic) => [Number(clinic.id_clinica), String(clinic.nombre_clinica || '').trim() || `Clínica ${clinic.id_clinica}`])
    );

    const automationCatalogItems = await AutomationFlowCatalog.findAll({
      attributes: ['id', 'name', 'display_name', 'template_key', 'template_version', 'is_active'],
      raw: true,
    });
    const automationLinkedTemplatesByCatalogId = await loadAutomationCatalogLinkedTemplates(automationCatalogItems);

    const instancesByCatalogId = new Map();
    instances.forEach((instance) => {
      const catalogId = Number(instance.catalog_template_id);
      if (!Number.isFinite(catalogId) || catalogId <= 0) return;
      if (!instancesByCatalogId.has(catalogId)) {
        instancesByCatalogId.set(catalogId, []);
      }
      instancesByCatalogId.get(catalogId).push(instance);
    });

    return res.json(
      items.map((item) => {
        const data = item?.toJSON ? item.toJSON() : item;
        const lastPropagatedAt = data?.last_propagated_at ? new Date(data.last_propagated_at) : null;
        const updatedAt = data?.updatedAt || data?.updated_at ? new Date(data.updatedAt || data.updated_at) : null;
        const createdAt = data?.createdAt || data?.created_at ? new Date(data.createdAt || data.created_at) : null;
        const rawPropagationState = String(data?.propagation_state || '').trim().toLowerCase();
        const isPending = rawPropagationState === 'pending';
        const propagated = !isPending && !!lastPropagatedAt && (!updatedAt || updatedAt.getTime() <= lastPropagatedAt.getTime());
        const familyRows = instancesByCatalogId.get(Number(data?.id)) || [];
        const versions = familyRows
          .map((row) => extractTechnicalTemplateVersion(data?.name, row?.name))
          .filter((value) => Number.isFinite(value));
        const latestVersion = versions.length ? Math.max(...versions) : null;
        const latestRows = latestVersion
          ? familyRows.filter((row) => extractTechnicalTemplateVersion(data?.name, row?.name) === latestVersion)
          : [];
        const latestRemoteRows = latestRows.filter((row) => !!String(row?.waba_id || '').trim());
        const latestClinicRows = latestRows.filter((row) => {
          const clinicId = Number(row?.clinic_id);
          if (!Number.isFinite(clinicId) || clinicId <= 0) return false;
          return String(row?.status || '').trim().toUpperCase() !== 'SIN_CONECTAR';
        });
        const approvedClinicRows = latestClinicRows.filter((row) => String(row?.status || '').trim().toUpperCase() === 'APPROVED');
        const approvalStale =
          !isPending &&
          (
            (!!lastPropagatedAt && !!updatedAt && updatedAt.getTime() > lastPropagatedAt.getTime()) ||
            (!lastPropagatedAt &&
              latestRows.length > 0 &&
              !!createdAt &&
              !!updatedAt &&
              updatedAt.getTime() > createdAt.getTime())
          );
        const unapprovedClinics = latestClinicRows
          .filter((row) => String(row?.status || '').trim().toUpperCase() !== 'APPROVED')
          .map((row) => {
            const clinicId = Number(row?.clinic_id);
            return {
              clinic_id: clinicId,
              clinic_name: clinicNameById.get(clinicId) || `Clínica ${clinicId}`,
              status: String(row?.status || '').trim().toUpperCase() || null,
            };
          });
        const approvedByCoverage =
          latestClinicRows.length > 0
            ? approvedClinicRows.length === latestClinicRows.length
            : (latestRemoteRows.length > 0 &&
              latestRemoteRows.every((row) => String(row?.status || '').trim().toUpperCase() === 'APPROVED'));
        const approved = !isPending && !approvalStale && approvedByCoverage;
        const approvalTotal = latestClinicRows.length > 0 ? latestClinicRows.length : latestRemoteRows.length;
        const associatedAutomations = automationCatalogItems
          .filter((automationItem) => {
            const linkedTemplate = automationLinkedTemplatesByCatalogId.get(Number(automationItem.id));
            const nodes = Array.isArray(linkedTemplate?.nodes) ? linkedTemplate.nodes : [];
            return nodes.some((node) => nodeUsesWhatsappTemplate(node, {
              templateId: null,
              templateName: data?.name,
              catalogTemplateId: Number(data?.id),
            }));
          })
          .map((automationItem) => ({
            id: Number(automationItem.id),
            name: String(automationItem.display_name || automationItem.name || '').trim() || `Automatización ${automationItem.id}`,
            is_active: Boolean(Number(automationItem.is_active)),
          }));
        return {
          ...data,
          propagated,
          approved,
          approved_count: approved ? (latestClinicRows.length > 0 ? approvedClinicRows.length : latestRemoteRows.length) : 0,
          approved_total: approvalTotal,
          unapproved_clinics: unapprovedClinics,
          automation_count: associatedAutomations.length,
          automations: associatedAutomations,
          approval_state: isPending
            ? 'pending_propagation'
            : (approvalStale ? 'stale_local_changes' : (approved ? 'approved' : 'unapproved')),
          propagation_state: isPending ? 'pending' : (propagated ? 'completed' : 'idle'),
        };
      })
    );
  } catch (err) {
    console.error('Error listCatalog', err);
    return res.status(500).json({ error: 'Error obteniendo catálogo' });
  }
};

exports.createCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { name, display_name, category, body_text, variables, components, is_generic = false, is_active = true } = req.body || {};
    if (!name || !category || !body_text) {
      return res.status(400).json({ error: 'name, category y body_text son obligatorios' });
    }
    if (!assertValidCatalogTemplatePayload({ bodyText: body_text }, res)) {
      return;
    }
    const item = await WhatsappTemplateCatalog.create({
      name,
      display_name: display_name || null,
      category,
      body_text,
      variables: variables || null,
      components: components || null,
      propagation_state: null,
      is_generic: !!is_generic,
      is_active: !!is_active,
    });
    return res.status(201).json(item);
  } catch (err) {
    console.error('Error createCatalog', err);
    return res.status(500).json({ error: 'Error creando catálogo' });
  }
};

exports.updateCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });

    const { display_name, category, body_text, variables, components, is_generic, is_active, name } = req.body || {};
    const nextBodyText = body_text || item.body_text;
    if (!assertValidCatalogTemplatePayload({ bodyText: nextBodyText }, res)) {
      return;
    }
    await item.update({
      name: name || item.name,
      display_name: display_name !== undefined ? display_name : item.display_name,
      category: category || item.category,
      body_text: nextBodyText,
      variables: variables !== undefined ? variables : item.variables,
      components: components !== undefined ? components : item.components,
      propagation_state: null,
      is_generic: is_generic !== undefined ? !!is_generic : item.is_generic,
      is_active: is_active !== undefined ? !!is_active : item.is_active,
    });
    return res.json(item);
  } catch (err) {
    console.error('Error updateCatalog', err);
    return res.status(500).json({ error: 'Error actualizando catálogo' });
  }
};

exports.deleteCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });

    // El FK de WhatsappTemplates.catalog_template_id está en SET NULL, por lo que
    // se permite borrar plantillas del catálogo aunque estén referenciadas.
    await WhatsappTemplateCatalog.destroy({ where: { id } });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleteCatalog', err);
    return res.status(500).json({ error: 'Error eliminando catálogo' });
  }
};

exports.toggleCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });
    const newState = req.body?.is_active;
    if (newState === undefined) {
      item.is_active = !item.is_active;
    } else {
      item.is_active = !!newState;
    }
    item.propagation_state = null;
    await item.save();
    return res.json(item);
  } catch (err) {
    console.error('Error toggleCatalog', err);
    return res.status(500).json({ error: 'Error actualizando estado' });
  }
};

exports.duplicateCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id, {
      include: [
        {
          model: WhatsappTemplateCatalogDiscipline,
          as: 'disciplinas',
          attributes: ['id', 'disciplina_code'],
        },
      ],
    });
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });

    const names = await resolveWhatsappCatalogDuplicateNames(item.id, {
      baseName: item.name,
      baseDisplayName: item.display_name || item.name,
    });

    const duplicated = await WhatsappTemplateCatalog.create({
      name: names.name,
      display_name: names.display_name,
      category: item.category,
      body_text: item.body_text,
      variables: item.variables || null,
      components: item.components || null,
      propagation_state: null,
      is_generic: !!item.is_generic,
      is_active: false,
    });

    const disciplinaCodes = Array.isArray(item.disciplinas)
      ? item.disciplinas
          .map((disc) => (typeof disc?.disciplina_code === 'string' ? disc.disciplina_code.trim() : null))
          .filter(Boolean)
      : [];

    if (!duplicated.is_generic && disciplinaCodes.length) {
      await WhatsappTemplateCatalogDiscipline.bulkCreate(
        disciplinaCodes.map((code) => ({
          template_catalog_id: duplicated.id,
          disciplina_code: code,
          created_at: new Date(),
          updated_at: new Date(),
        }))
      );
    }

    const created = await WhatsappTemplateCatalog.findByPk(duplicated.id, {
      include: [
        {
          model: WhatsappTemplateCatalogDiscipline,
          as: 'disciplinas',
          attributes: ['id', 'disciplina_code'],
        },
      ],
    });
    return res.status(201).json(created);
  } catch (err) {
    console.error('Error duplicateCatalog', err);
    return res.status(500).json({ error: 'Error duplicando catálogo' });
  }
};

exports.setCatalogDisciplines = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });

    const disciplinaCodes = Array.isArray(req.body?.disciplina_codes) ? req.body.disciplina_codes : [];
    await WhatsappTemplateCatalogDiscipline.destroy({ where: { template_catalog_id: id } });

    if (disciplinaCodes.length) {
      const rows = disciplinaCodes.map((code) => ({
        template_catalog_id: id,
        disciplina_code: code,
        created_at: new Date(),
        updated_at: new Date(),
      }));
      await WhatsappTemplateCatalogDiscipline.bulkCreate(rows);
    }
    await item.update({ propagation_state: null });
    const updated = await WhatsappTemplateCatalog.findByPk(id, {
      include: [{ model: WhatsappTemplateCatalogDiscipline, as: 'disciplinas', attributes: ['id', 'disciplina_code'] }],
    });
    return res.json(updated);
  } catch (err) {
    console.error('Error setCatalogDisciplines', err);
    return res.status(500).json({ error: 'Error actualizando disciplinas' });
  }
};

exports.propagateCatalogToClinics = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'catalog_id_required' });
    }

    const item = await WhatsappTemplateCatalog.findByPk(id, {
      attributes: ['id', 'name', 'display_name', 'body_text', 'is_active', 'updated_at', 'propagation_state'],
    });
    if (!item) {
      return res.status(404).json({ error: 'catalog_not_found' });
    }

    if (!item.is_active) {
      return res.status(400).json({
        error: 'catalog_template_inactive',
        message: 'Activa la plantilla antes de propagarla. Las plantillas inactivas no se envían a revisión de Meta.',
      });
    }

    if (!assertValidCatalogTemplatePayload({ bodyText: item.body_text }, res)) {
      return;
    }

    await item.update({ propagation_state: 'pending' });

    const { enqueuePropagateCatalogTemplateJob } = require('../services/whatsappTemplates.service');
    const job = await enqueuePropagateCatalogTemplateJob({
      templateCatalogId: id,
      requestedBy: req.userData?.userId || null,
      sourceUpdatedAt: item.updated_at || item.updatedAt || new Date(),
    });

    return res.json({
      success: true,
      jobId: job?.id || null,
      catalog_template_id: id,
      template_name: item.display_name || item.name,
      is_active: !!item.is_active,
      propagation_state: 'pending',
    });
  } catch (err) {
    console.error('Error propagateCatalogToClinics', err);
    return res.status(500).json({ error: 'Error propagando plantilla a clínicas' });
  }
};

exports.assignPhone = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;
    const { assignmentScope, clinic_id } = req.body || {};

    if (!['group', 'clinic'].includes(assignmentScope)) {
      return res.status(400).json({ success: false, error: 'invalid_assignment_scope' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_phone_number',
        phoneNumberId: phoneNumberId,
        isActive: true,
      },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        // Ajustar a columna grupoClinicaId (no id_grupo)
        { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'] },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const isOwner = phone.metaConnection?.userId === userId;
    const canManage =
      isOwner ||
      isAggregateAllowed ||
      (phone.clinicaId && clinicIds.includes(phone.clinicaId)) ||
      assignmentScope === 'clinic';

    if (!canManage) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    let targetClinicId = null;
    let targetGroupId = null;

    if (assignmentScope === 'clinic') {
      if (!clinic_id) {
        return res.status(400).json({ success: false, error: 'clinic_id_required' });
      }
      const clinic = await Clinica.findOne({
        where: { id_clinica: clinic_id },
        attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
        raw: true,
      });
      if (!clinic) {
        return res.status(404).json({ success: false, error: 'invalid_clinic' });
      }
      if (!isAggregateAllowed && !clinicIds.includes(clinic_id)) {
        return res.status(403).json({ success: false, error: 'forbidden' });
      }
      targetClinicId = clinic_id;
      targetGroupId = clinic.grupoClinicaId || null;
    } else if (assignmentScope === 'group') {
      if (!clinic_id) {
        return res.status(400).json({ success: false, error: 'clinic_id_required_for_group' });
      }
      const clinic = await Clinica.findOne({
        where: { id_clinica: clinic_id },
        attributes: ['grupoClinicaId'],
        raw: true,
      });
      if (!clinic) {
        return res.status(404).json({ success: false, error: 'invalid_clinic' });
      }
      if (!isAggregateAllowed && !clinicIds.includes(clinic_id)) {
        return res.status(403).json({ success: false, error: 'forbidden' });
      }
      targetGroupId = clinic.grupoClinicaId || null;
    }

    await phone.update({
      assignmentScope,
      clinicaId: targetClinicId,
      grupoClinicaId: targetGroupId,
    });

    // Encolar creación automática de plantillas al asignar
    const { enqueueCreateTemplatesJob } = require('../services/whatsappTemplates.service');
    if (phone.wabaId && assignmentScope !== 'unassigned') {
      enqueueCreateTemplatesJob({
        wabaId: phone.wabaId,
        clinicId: targetClinicId,
        groupId: targetGroupId,
        assignmentScope,
      }).catch((err) => {
        console.error('Error encolando plantillas al asignar número', err?.message || err);
      });
    }

    // Intentar registrar automaticamente el numero en la Cloud API
    let registrationResult = null;
    try {
      registrationResult = await attemptPhoneRegistration({ asset: phone });
    } catch (regErr) {
      console.warn('No se pudo registrar el numero automaticamente', regErr?.message || regErr);
    }

    return res.json({
      success: true,
      phoneNumberId,
      assignmentScope,
      clinic_id: targetClinicId,
      clinic_name: phone.clinica?.nombre_clinica || null,
      registration: registrationResult?.registration || null,
    });
  } catch (err) {
    console.error('Error assignPhone', err);
    return res.status(500).json({ success: false, error: 'assign_failed' });
  }
};

exports.registerPhone = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;
    const pin = req.body?.pin;
    const useAutoPin = Boolean(req.body?.use_auto_pin || req.body?.reset_pin);

    if (!phoneNumberId) {
      return res
        .status(400)
        .json({ success: false, error: 'phone_number_id_required' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_phone_number',
        phoneNumberId,
        isActive: true,
      },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        {
          model: Clinica,
          as: 'clinica',
          attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
        },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const userGroupIds = await getUserGroupIds({ clinicIds, isAggregateAllowed });
    const isOwner = phone.metaConnection?.userId === userId;
    const hasClinicAccess = phone.clinicaId && clinicIds.includes(phone.clinicaId);
    const hasGroupAccess =
      phone.assignmentScope === 'group' &&
      phone.grupoClinicaId &&
      userGroupIds.includes(phone.grupoClinicaId);

    if (!isOwner && !isAggregateAllowed && !hasClinicAccess && !hasGroupAccess) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    const result = await attemptPhoneRegistration({ asset: phone, pin, useAutoPin });
    const error =
      result.success
        ? null
        : result.registration?.requiresPin
        ? 'pin_required'
        : 'registration_failed';

    return res.json({
      success: result.success,
      phoneNumberId,
      registration: result.registration,
      status: result.status || null,
      error,
    });
  } catch (err) {
    console.error('Error registerPhone', err);
    return res.status(500).json({ success: false, error: 'register_failed' });
  }
};

exports.refreshPhoneStatus = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;

    if (!phoneNumberId) {
      return res.status(400).json({ success: false, error: 'phone_number_id_required' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_phone_number',
        phoneNumberId,
        isActive: true,
      },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        {
          model: Clinica,
          as: 'clinica',
          attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
        },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const userGroupIds = await getUserGroupIds({ clinicIds, isAggregateAllowed });
    const isOwner = phone.metaConnection?.userId === userId;
    const hasClinicAccess = phone.clinicaId && clinicIds.includes(phone.clinicaId);
    const hasGroupAccess =
      phone.assignmentScope === 'group' &&
      phone.grupoClinicaId &&
      userGroupIds.includes(phone.grupoClinicaId);

    if (!isOwner && !isAggregateAllowed && !hasClinicAccess && !hasGroupAccess) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    if (!phone.wabaId || !phone.waAccessToken) {
      return res.status(400).json({ success: false, error: 'missing_waba_or_token' });
    }

    await syncPhonesForWaba({ wabaId: phone.wabaId, accessToken: phone.waAccessToken });

    return res.json({ success: true });
  } catch (err) {
    console.error('Error refreshPhoneStatus', err);
    return res.status(500).json({ success: false, error: 'refresh_failed' });
  }
};

exports.updatePhoneDisplayName = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;
    const displayName =
      req.body?.display_name ||
      req.body?.displayName ||
      req.body?.name ||
      null;

    if (!phoneNumberId) {
      return res
        .status(400)
        .json({ success: false, error: 'phone_number_id_required' });
    }
    if (!displayName) {
      return res
        .status(400)
        .json({ success: false, error: 'display_name_required' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_phone_number',
        phoneNumberId,
        isActive: true,
      },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        {
          model: Clinica,
          as: 'clinica',
          attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
        },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const userGroupIds = await getUserGroupIds({ clinicIds, isAggregateAllowed });
    const isOwner = phone.metaConnection?.userId === userId;
    const hasClinicAccess = phone.clinicaId && clinicIds.includes(phone.clinicaId);
    const hasGroupAccess =
      phone.assignmentScope === 'group' &&
      phone.grupoClinicaId &&
      userGroupIds.includes(phone.grupoClinicaId);

    if (!isOwner && !isAggregateAllowed && !hasClinicAccess && !hasGroupAccess) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    if (!phone.waAccessToken) {
      return res.status(400).json({ success: false, error: 'missing_access_token' });
    }

    const trimmedName = String(displayName).trim();
    const additionalData = phone.additionalData || {};

    // Intentar actualizar el nombre en Meta
    try {
      await axios.post(
        `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}`,
        { verified_name: trimmedName },
        { headers: { Authorization: `Bearer ${phone.waAccessToken}` } }
      );
      // Obtener estado actualizado
      const statusResp = await axios.get(
        `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}`,
        {
          headers: { Authorization: `Bearer ${phone.waAccessToken}` },
          params: { fields: 'id,name_status' },
        }
      );
      additionalData.nameStatus = statusResp.data?.name_status || additionalData.nameStatus || null;
      additionalData.nameStatusReason = null;
    } catch (err) {
      const parsed = parseWaError(err);
      // Guardamos el motivo por si Meta rechaza inmediatamente
      additionalData.nameStatusReason = parsed.message || null;
    }

    additionalData.requestedDisplayName = trimmedName;
    additionalData.requestedDisplayNameAt = new Date().toISOString();
    phone.additionalData = additionalData;
    await phone.save();

    return res.json({
      success: true,
      phoneNumberId,
      requestedDisplayName: additionalData.requestedDisplayName,
      nameStatus: additionalData.nameStatus || null,
      manualRequired: false,
      managerUrl: 'https://business.facebook.com/wa/manage/phone-numbers/',
    });
  } catch (err) {
    console.error('Error updatePhoneDisplayName', err);
    return res
      .status(500)
      .json({ success: false, error: 'display_name_update_failed' });
  }
};

exports.updatePhoneProfile = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;
    const category = req.body?.category || req.body?.vertical || null;
    const description = req.body?.description || null;
    const address = req.body?.address || null;
    const email = req.body?.email || null;
    const website = req.body?.website || null;
    const profilePictureUrl = req.body?.profile_picture_url || req.body?.profilePictureUrl || null;

    if (!phoneNumberId) {
      return res
        .status(400)
        .json({ success: false, error: 'phone_number_id_required' });
    }

    if (!category && !description && !address && !email && !website && !profilePictureUrl) {
      return res
        .status(400)
        .json({ success: false, error: 'profile_fields_required' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_phone_number',
        phoneNumberId,
        isActive: true,
      },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        {
          model: Clinica,
          as: 'clinica',
          attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
        },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const userGroupIds = await getUserGroupIds({ clinicIds, isAggregateAllowed });
    const isOwner = phone.metaConnection?.userId === userId;
    const hasClinicAccess = phone.clinicaId && clinicIds.includes(phone.clinicaId);
    const hasGroupAccess =
      phone.assignmentScope === 'group' &&
      phone.grupoClinicaId &&
      userGroupIds.includes(phone.grupoClinicaId);

    if (!isOwner && !isAggregateAllowed && !hasClinicAccess && !hasGroupAccess) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    if (!phone.wabaId || !phone.waAccessToken) {
      return res.status(400).json({ success: false, error: 'missing_waba_or_token' });
    }

    const payload = {
      messaging_product: 'whatsapp',
    };
    if (category) payload.vertical = String(category).trim();
    if (description) {
      const desc = String(description).trim();
      payload.description = desc;
      payload.about = desc; // algunos perfiles devuelven/guardan en about
    }
    if (address) payload.address = String(address).trim();
    if (email) payload.email = String(email).trim();
    if (website) payload.websites = [String(website).trim()];
    if (profilePictureUrl) payload.profile_picture_url = String(profilePictureUrl).trim();

    await axios.post(
      `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}/whatsapp_business_profile`,
      payload,
      { headers: { Authorization: `Bearer ${phone.waAccessToken}` } }
    );

    // Obtener estado real tras el update para guardar lo que Meta devuelve
    let profileRemote = null;
    try {
      const resp = await axios.get(
        `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}/whatsapp_business_profile`,
        {
          headers: { Authorization: `Bearer ${phone.waAccessToken}` },
          params: { fields: 'about,description,profile_picture_url,vertical,email,websites,address' },
        }
      );
      profileRemote = resp.data || null;
    } catch (e) {
      profileRemote = null;
    }

    const additionalData = phone.additionalData || {};
    additionalData.profileCategory =
      profileRemote?.vertical ||
      payload.vertical ||
      additionalData.profileCategory ||
      null;
    additionalData.profileDescription =
      profileRemote?.description ||
      profileRemote?.about ||
      payload.description ||
      payload.about ||
      additionalData.profileDescription ||
      null;
    additionalData.profilePictureUrl =
      profileRemote?.profile_picture_url ||
      payload.profile_picture_url ||
      additionalData.profilePictureUrl ||
      null;
    additionalData.profileEmail =
      profileRemote?.email ||
      payload.email ||
      additionalData.profileEmail ||
      null;
    additionalData.profileWebsite =
      profileRemote?.websites?.[0] ||
      payload.websites?.[0] ||
      additionalData.profileWebsite ||
      null;
    additionalData.profileAddress =
      profileRemote?.address ||
      payload.address ||
      additionalData.profileAddress ||
      null;
    phone.additionalData = additionalData;
    await phone.save();

    return res.json({ success: true, profile: additionalData });
  } catch (err) {
    console.error('Error updatePhoneProfile', err);
    return res.status(500).json({ success: false, error: 'profile_update_failed' });
  }
};

// =======================
// Pre-verified numbers API
// =======================

exports.preverifiedStart = async (req, res) => {
  try {
    if (!assertPreverifiedEnabled(req, res)) return;

    const rawNumber =
      req.body?.phone_number ||
      req.body?.phoneNumber ||
      req.body?.number ||
      null;
    const codeMethod = (req.body?.code_method || req.body?.codeMethod || 'SMS').toUpperCase();
    const language = req.body?.language || 'es_ES';

    if (!rawNumber) {
      return res.status(400).json({ success: false, error: 'phone_number_required' });
    }

    const digits = String(rawNumber).replace(/\D/g, '');
    if (!digits || digits.length < 8) {
      return res.status(400).json({ success: false, error: 'invalid_phone_number' });
    }

    // 1) Crear número verificado previamente
    const createResp = await axios.post(
      `https://graph.facebook.com/${META_API_VERSION}/${META_BUSINESS_ID}/add_phone_numbers`,
      null,
      {
        headers: { Authorization: `Bearer ${META_GRAPH_TOKEN}` },
        params: { phone_number: digits },
      }
    );

    const preverifiedId = createResp.data?.id;
    if (!preverifiedId) {
      return res.status(500).json({ success: false, error: 'preverified_id_missing' });
    }

    // 2) Solicitar código OTP
    await axios.post(
      `https://graph.facebook.com/${META_API_VERSION}/${preverifiedId}/request_code`,
      null,
      {
        headers: { Authorization: `Bearer ${META_GRAPH_TOKEN}` },
        params: { code_method: codeMethod, language },
      }
    );

    return res.json({
      success: true,
      preverified_id: preverifiedId,
      phone_number: digits,
      code_method: codeMethod,
      language,
    });
  } catch (err) {
    const { code, message, raw } = parseWaError(err);
    console.error('Error preverifiedStart', message || err);
    return res.status(500).json({
      success: false,
      error: 'preverified_start_failed',
      meta_error: { code, message, raw },
    });
  }
};

exports.preverifiedVerify = async (req, res) => {
  try {
    if (!assertPreverifiedEnabled(req, res)) return;

    const preverifiedId =
      req.body?.preverified_id ||
      req.body?.preverifiedId ||
      req.body?.phone_id ||
      null;
    const code = req.body?.code || req.body?.otp || null;

    if (!preverifiedId || !code) {
      return res.status(400).json({ success: false, error: 'preverified_id_and_code_required' });
    }

    const resp = await axios.post(
      `https://graph.facebook.com/${META_API_VERSION}/${preverifiedId}/verify_code`,
      null,
      {
        headers: { Authorization: `Bearer ${META_GRAPH_TOKEN}` },
        params: { code: String(code).trim() },
      }
    );

    return res.json({ success: true, response: resp.data || null });
  } catch (err) {
    const { code, message, raw } = parseWaError(err);
    console.error('Error preverifiedVerify', message || err);
    return res.status(500).json({
      success: false,
      error: 'preverified_verify_failed',
      meta_error: { code, message, raw },
    });
  }
};

exports.preverifiedProfile = async (req, res) => {
  try {
    if (!assertPreverifiedEnabled(req, res)) return;

    const phoneNumberId =
      req.body?.phone_number_id ||
      req.body?.phoneNumberId ||
      null;
    const displayName =
      req.body?.display_name ||
      req.body?.displayName ||
      null;
    const category = req.body?.category || req.body?.vertical || null;
    const description = req.body?.description || null;

    if (!phoneNumberId) {
      return res.json({
        success: true,
        stored: false,
        message: 'profile_data_should_be_sent_via_embedded_signup_extras',
      });
    }

    const asset = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_phone_number',
        phoneNumberId,
      },
    });

    if (asset) {
      const additionalData = { ...(asset.additionalData || {}) };
      if (displayName) additionalData.requestedDisplayName = displayName;
      additionalData.preverifiedProfile = {
        ...(additionalData.preverifiedProfile || {}),
        displayName: displayName || additionalData.preverifiedProfile?.displayName || null,
        category: category || additionalData.preverifiedProfile?.category || null,
        description: description || additionalData.preverifiedProfile?.description || null,
      };
      asset.additionalData = additionalData;
      await asset.save();
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Error preverifiedProfile', err);
    return res.status(500).json({ success: false, error: 'preverified_profile_failed' });
  }
};

exports.deletePhone = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;
    if (!phoneNumberId) {
      return res.status(400).json({ success: false, error: 'phone_number_id_required' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: { assetType: 'whatsapp_phone_number', phoneNumberId, isActive: true },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'] },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const isOwner = phone.metaConnection?.userId === userId;
    const hasClinicAccess = phone.clinicaId ? clinicIds.includes(phone.clinicaId) : false;
    const canManage = isOwner || isAggregateAllowed || hasClinicAccess;
    if (!canManage) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    await phone.update({
      isActive: false,
      assignmentScope: 'unassigned',
      clinicaId: null,
      grupoClinicaId: null,
    });

    if (phone.wabaId) {
      await ClinicMetaAsset.update(
        {
          isActive: false,
          assignmentScope: 'unassigned',
          clinicaId: null,
          grupoClinicaId: null,
        },
        { where: { assetType: 'whatsapp_business_account', wabaId: phone.wabaId } }
      );
    }

    return res.json({ success: true, phoneNumberId });
  } catch (err) {
    console.error('Error deletePhone', err);
    return res.status(500).json({ success: false, error: 'delete_failed' });
  }
};
