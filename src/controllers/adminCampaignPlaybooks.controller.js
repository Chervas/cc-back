'use strict';

const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { isGlobalAdmin } = require('../lib/role-helpers');

const { AdminCampaignPlaybook, Tratamiento, AutomationFlowCatalog, AutomationFlowTemplateV2 } = db;

const ALLOWED_PROMOTION_KINDS = new Set(['treatment_specific', 'generic_campaign']);
const ALLOWED_STATUSES = new Set(['draft', 'active', 'archived']);
const ALLOWED_AUTOMATION_MODES = new Set(['inherit_recommendation', 'force_template', 'none']);

function assertAdmin(req, res) {
  if (!isGlobalAdmin(req.userData?.userId)) {
    res.status(403).json({ error: 'admin_only' });
    return false;
  }
  return true;
}

function toCleanString(value) {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  return clean || null;
}

function toNullableInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === 'string' ? item.trim() : null))
        .filter(Boolean)
    )
  );
}

function normalizeBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildCatalogKey(objectiveId, displayName) {
  const base = slugify(displayName);
  const objective = slugify(objectiveId);
  return objective ? `${objective}_${base}` : base;
}

async function ensureUniqueCatalogKey(baseKey, excludeId = null) {
  let candidate = baseKey || `playbook_${Date.now()}`;
  let suffix = 1;

  while (true) {
    const where = { catalog_key: candidate };
    if (excludeId) {
      where.id = { [db.Sequelize.Op.ne]: excludeId };
    }

    // eslint-disable-next-line no-await-in-loop
    const existing = await AdminCampaignPlaybook.findOne({ where, attributes: ['id'], raw: true });
    if (!existing) {
      return candidate;
    }
    suffix += 1;
    candidate = `${baseKey}_${suffix}`;
  }
}

function normalizeDestinationPolicy(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    clinic_website_default: normalizeBool(value.clinic_website_default, true),
    specific_url_allowed: normalizeBool(value.specific_url_allowed, true),
    subtree_recommended: normalizeBool(value.subtree_recommended, false),
    landing_future: normalizeBool(value.landing_future, false),
  };
}

function normalizeMeasurementProfile(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    first_party: normalizeBool(value.first_party, true),
    channel_native: normalizeBool(value.channel_native, true),
    business_outcomes: normalizeBool(value.business_outcomes, true),
    remarketing: normalizeBool(value.remarketing, true),
    ad_calls: normalizeBool(value.ad_calls, false),
  };
}

function normalizeReviewPolicy(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    managed_review_required: normalizeBool(value.managed_review_required, false),
    client_approval_required: normalizeBool(value.client_approval_required, false),
  };
}

function normalizeAutomationStrategy(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const mode = toCleanString(value.mode) || 'inherit_recommendation';
  return {
    mode: ALLOWED_AUTOMATION_MODES.has(mode) ? mode : 'inherit_recommendation',
    template_key: toCleanString(value.template_key),
    template_version: toNullableInt(value.template_version),
  };
}

async function resolveTreatment(treatmentId) {
  const normalizedId = toNullableInt(treatmentId);
  if (!normalizedId) return null;
  return Tratamiento.findOne({
    where: {
      id_tratamiento: normalizedId,
      origen: 'sistema',
    },
    attributes: ['id_tratamiento', 'nombre', 'codigo', 'disciplina', 'categoria', 'activo'],
    raw: true,
  });
}

async function resolveAutomationCatalogByTemplate(templateKey) {
  const cleanTemplateKey = toCleanString(templateKey);
  if (!cleanTemplateKey) return null;

  return AutomationFlowCatalog.findOne({
    where: {
      template_key: cleanTemplateKey,
      is_active: true,
    },
    attributes: ['id', 'name', 'display_name', 'template_key'],
    raw: true,
  });
}

async function resolvePublishedAutomationTemplate(templateKey, templateVersion = null) {
  const cleanTemplateKey = toCleanString(templateKey);
  if (!cleanTemplateKey) return null;

  const where = {
    template_key: cleanTemplateKey,
    published_at: { [Op.ne]: null },
    is_active: true,
  };

  if (templateVersion !== null) {
    where.version = templateVersion;
  }

  return AutomationFlowTemplateV2.findOne({
    where,
    attributes: ['id', 'template_key', 'version', 'name'],
    order: [['version', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
}

async function normalizePlaybookPayload(payload, options = {}) {
  const { partial = false, current = null } = options;
  const source = payload && typeof payload === 'object' ? payload : {};

  const displayName = source.display_name !== undefined
    ? toCleanString(source.display_name)
    : (partial ? current?.display_name : null);
  const objectiveId = source.objective_id !== undefined
    ? toCleanString(source.objective_id)
    : (partial ? current?.objective_id : null);
  const promotionKind = source.promotion_kind !== undefined
    ? toCleanString(source.promotion_kind)
    : (partial ? current?.promotion_kind : null);
  const status = source.status !== undefined
    ? toCleanString(source.status)
    : (partial ? current?.status : 'draft');

  if (!partial || source.display_name !== undefined) {
    if (!displayName) {
      return { error: 'display_name_required', message: 'display_name es obligatorio' };
    }
  }
  if (!partial || source.objective_id !== undefined) {
    if (!objectiveId) {
      return { error: 'objective_id_required', message: 'objective_id es obligatorio' };
    }
  }
  if (!partial || source.promotion_kind !== undefined) {
    if (!promotionKind || !ALLOWED_PROMOTION_KINDS.has(promotionKind)) {
      return { error: 'invalid_promotion_kind', message: 'promotion_kind no válido' };
    }
  }
  if (!partial || source.status !== undefined) {
    if (!status || !ALLOWED_STATUSES.has(status)) {
      return { error: 'invalid_status', message: 'status no válido' };
    }
  }

  const resolvedPromotionKind = promotionKind || current?.promotion_kind || 'treatment_specific';
  const treatmentId = source.treatment_id !== undefined
    ? toNullableInt(source.treatment_id)
    : (partial ? toNullableInt(current?.treatment_id) : null);
  const areaMedica = source.area_medica !== undefined
    ? toCleanString(source.area_medica)
    : (source.discipline !== undefined
      ? toCleanString(source.discipline)
      : (partial ? toCleanString(current?.area_medica ?? current?.discipline) : null));
  const familyKey = source.family_key !== undefined
    ? toCleanString(source.family_key)
    : (partial ? toCleanString(current?.family_key) : null);

  let treatment = null;
  if (resolvedPromotionKind === 'treatment_specific') {
    if (!treatmentId) {
      return { error: 'treatment_id_required', message: 'treatment_id es obligatorio para treatment_specific' };
    }
    treatment = await resolveTreatment(treatmentId);
    if (!treatment) {
      return { error: 'treatment_not_found', message: 'Tratamiento admin no encontrado o no es de sistema' };
    }
  }

  const channelsSupported = source.channels_supported !== undefined
    ? normalizeStringArray(source.channels_supported)
    : (partial ? normalizeStringArray(current?.channels_supported) : []);
  const channelsDefaultRaw = source.channels_default !== undefined
    ? normalizeStringArray(source.channels_default)
    : (partial ? normalizeStringArray(current?.channels_default) : []);
  const channelsDefault = channelsDefaultRaw.filter((channel) => channelsSupported.includes(channel));
  if (!channelsSupported.length) {
    return { error: 'channels_supported_required', message: 'channels_supported debe incluir al menos un canal' };
  }

  const destinationPolicy = source.destination_policy !== undefined
    ? normalizeDestinationPolicy(source.destination_policy)
    : (partial ? normalizeDestinationPolicy(current?.destination_policy) : normalizeDestinationPolicy({}));
  const measurementProfile = source.measurement_profile !== undefined
    ? normalizeMeasurementProfile(source.measurement_profile)
    : (partial ? normalizeMeasurementProfile(current?.measurement_profile) : normalizeMeasurementProfile({}));
  const automationStrategy = source.automation_strategy !== undefined
    ? normalizeAutomationStrategy(source.automation_strategy)
    : (partial ? normalizeAutomationStrategy(current?.automation_strategy) : normalizeAutomationStrategy({}));
  if (automationStrategy.mode === 'force_template') {
    if (!automationStrategy.template_key) {
      return { error: 'automation_template_required', message: 'automation_strategy.template_key es obligatorio para force_template' };
    }

    const catalogAutomation = await resolveAutomationCatalogByTemplate(automationStrategy.template_key);
    if (!catalogAutomation) {
      return { error: 'automation_catalog_item_not_found', message: 'La automatización forzada no existe o no está activa en el catálogo' };
    }

    const publishedTemplate = await resolvePublishedAutomationTemplate(
      automationStrategy.template_key,
      automationStrategy.template_version
    );
    if (!publishedTemplate) {
      return { error: 'automation_template_not_found', message: 'La plantilla de automatización forzada no existe o no está publicada' };
    }

    automationStrategy.template_key = publishedTemplate.template_key;
    automationStrategy.template_version = Number(publishedTemplate.version);
  } else {
    automationStrategy.template_key = null;
    automationStrategy.template_version = null;
  }
  const reviewPolicy = source.review_policy !== undefined
    ? normalizeReviewPolicy(source.review_policy)
    : (partial ? normalizeReviewPolicy(current?.review_policy) : normalizeReviewPolicy({}));

  return {
    value: {
      display_name: displayName,
      objective_id: objectiveId,
      promotion_kind: resolvedPromotionKind,
      treatment_id: resolvedPromotionKind === 'treatment_specific' ? treatmentId : null,
      discipline: resolvedPromotionKind === 'generic_campaign' ? areaMedica : null,
      family_key: resolvedPromotionKind === 'generic_campaign' ? familyKey : null,
      status,
      channels_supported: channelsSupported,
      channels_default: channelsDefault.length ? channelsDefault : [channelsSupported[0]],
      recommended_budget_min: source.recommended_budget_min !== undefined
        ? toNullableInt(source.recommended_budget_min)
        : (partial ? toNullableInt(current?.recommended_budget_min) : null),
      recommended_budget_max: source.recommended_budget_max !== undefined
        ? toNullableInt(source.recommended_budget_max)
        : (partial ? toNullableInt(current?.recommended_budget_max) : null),
      destination_policy: destinationPolicy,
      measurement_profile: measurementProfile,
      automation_strategy: automationStrategy,
      template_bundle_refs: source.template_bundle_refs !== undefined
        ? normalizeStringArray(source.template_bundle_refs)
        : (partial ? normalizeStringArray(current?.template_bundle_refs) : []),
      review_policy: reviewPolicy,
      notes_internal: source.notes_internal !== undefined
        ? toCleanString(source.notes_internal)
        : (partial ? toCleanString(current?.notes_internal) : null),
    },
    treatment,
  };
}

function serializePlaybook(item) {
  const data = item?.toJSON ? item.toJSON() : item;
  const treatment = data?.treatment || null;
  return {
    ...data,
    area_medica: data?.discipline || null,
    treatment: treatment
      ? {
          id_tratamiento: Number(treatment.id_tratamiento),
          nombre: treatment.nombre,
          codigo: treatment.codigo || null,
          area_medica: treatment.disciplina || null,
          disciplina: treatment.disciplina || null,
          categoria: treatment.categoria || null,
          activo: treatment.activo !== false,
        }
      : null,
  };
}

exports.listPlaybooks = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;

  const items = await AdminCampaignPlaybook.findAll({
    include: [{
      model: Tratamiento,
      as: 'treatment',
      attributes: ['id_tratamiento', 'nombre', 'codigo', 'disciplina', 'categoria', 'activo'],
      required: false,
    }],
    order: [['display_name', 'ASC']],
  });

  return res.json(items.map(serializePlaybook));
});

exports.getPlaybookById = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;

  const item = await AdminCampaignPlaybook.findByPk(req.params.id, {
    include: [{
      model: Tratamiento,
      as: 'treatment',
      attributes: ['id_tratamiento', 'nombre', 'codigo', 'disciplina', 'categoria', 'activo'],
      required: false,
    }],
  });

  if (!item) {
    return res.status(404).json({ error: 'playbook_not_found' });
  }

  return res.json(serializePlaybook(item));
});

exports.createPlaybook = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;

  const normalized = await normalizePlaybookPayload(req.body, { partial: false });
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error, message: normalized.message });
  }

  const payload = normalized.value;
  const catalogKey = await ensureUniqueCatalogKey(
    buildCatalogKey(payload.objective_id, payload.display_name)
  );

  const item = await AdminCampaignPlaybook.create({
    id: crypto.randomUUID(),
    catalog_key: catalogKey,
    ...payload,
  });

  const created = await AdminCampaignPlaybook.findByPk(item.id, {
    include: [{
      model: Tratamiento,
      as: 'treatment',
      attributes: ['id_tratamiento', 'nombre', 'codigo', 'disciplina', 'categoria', 'activo'],
      required: false,
    }],
  });

  return res.status(201).json(serializePlaybook(created));
});

exports.updatePlaybook = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;

  const item = await AdminCampaignPlaybook.findByPk(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'playbook_not_found' });
  }

  const normalized = await normalizePlaybookPayload(req.body, {
    partial: true,
    current: item.toJSON(),
  });
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error, message: normalized.message });
  }

  const updatePayload = { ...normalized.value };
  if (
    normalized.value.display_name !== item.display_name ||
    normalized.value.objective_id !== item.objective_id
  ) {
    updatePayload.catalog_key = await ensureUniqueCatalogKey(
      buildCatalogKey(normalized.value.objective_id, normalized.value.display_name),
      item.id
    );
  }

  await item.update(updatePayload);

  const updated = await AdminCampaignPlaybook.findByPk(item.id, {
    include: [{
      model: Tratamiento,
      as: 'treatment',
      attributes: ['id_tratamiento', 'nombre', 'codigo', 'disciplina', 'categoria', 'activo'],
      required: false,
    }],
  });

  return res.json(serializePlaybook(updated));
});

exports.deletePlaybook = asyncHandler(async (req, res) => {
  if (!assertAdmin(req, res)) return;

  const item = await AdminCampaignPlaybook.findByPk(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'playbook_not_found' });
  }

  await item.destroy();
  return res.status(204).send();
});
