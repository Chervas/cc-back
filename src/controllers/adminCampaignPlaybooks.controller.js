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
const ALLOWED_REACTIVATION_LIST_SOURCES = new Set(['clinical_inactive', 'imported_file', 'manual_list']);
const ALLOWED_REACTIVATION_ACTIONS = new Set(['whatsapp_auto', 'send_to_leads', 'managed_calls']);
const ALLOWED_REACTIVATION_TEMPLATE_POLICIES = new Set(['approved_only', 'allow_local_draft']);
const ALLOWED_REACTIVATION_INACTIVITY_UNITS = new Set(['months', 'days']);
const ALLOWED_REACTIVATION_TREATMENT_SCOPES = new Set(['selected_treatment', 'any_treatment']);

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

function normalizeEnum(value, allowed, fallback) {
  const clean = toCleanString(value);
  return clean && allowed.has(clean) ? clean : fallback;
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

function normalizeReactivationPreset(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const threshold = raw.inactivity_threshold && typeof raw.inactivity_threshold === 'object'
    ? raw.inactivity_threshold
    : {};
  const exclusions = raw.exclusions && typeof raw.exclusions === 'object' ? raw.exclusions : {};
  const safetyGates = raw.safety_gates && typeof raw.safety_gates === 'object' ? raw.safety_gates : {};

  return {
    list_source: normalizeEnum(raw.list_source, ALLOWED_REACTIVATION_LIST_SOURCES, 'clinical_inactive'),
    inactivity_threshold: {
      value: Math.max(toNullableInt(threshold.value) || 6, 1),
      unit: normalizeEnum(threshold.unit, ALLOWED_REACTIVATION_INACTIVITY_UNITS, 'months'),
    },
    treatment_scope: normalizeEnum(raw.treatment_scope, ALLOWED_REACTIVATION_TREATMENT_SCOPES, 'selected_treatment'),
    default_action: normalizeEnum(raw.default_action, ALLOWED_REACTIVATION_ACTIONS, 'whatsapp_auto'),
    whatsapp_template_policy: normalizeEnum(raw.whatsapp_template_policy, ALLOWED_REACTIVATION_TEMPLATE_POLICIES, 'approved_only'),
    exclusions: {
      future_appointments: normalizeBool(exclusions.future_appointments, true),
      no_contact: normalizeBool(exclusions.no_contact, true),
      invalid_phone: normalizeBool(exclusions.invalid_phone, true),
      duplicates: normalizeBool(exclusions.duplicates, true),
    },
    safety_gates: {
      frozen_audience: normalizeBool(safetyGates.frozen_audience, true),
      opt_out: normalizeBool(safetyGates.opt_out, true),
      capping: normalizeBool(safetyGates.capping, true),
      approved_template: normalizeBool(safetyGates.approved_template, true),
      audit: normalizeBool(safetyGates.audit, true),
      cancelable_queue: normalizeBool(safetyGates.cancelable_queue, true),
    },
  };
}

function normalizeAutomationStrategy(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const mode = toCleanString(value.mode) || 'inherit_recommendation';
  return {
    mode: ALLOWED_AUTOMATION_MODES.has(mode) ? mode : 'inherit_recommendation',
    template_key: toCleanString(value.template_key),
    template_version: toNullableInt(value.template_version),
    reactivation_preset: normalizeReactivationPreset(value.reactivation_preset),
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
    : (partial ? toCleanString(current?.area_medica) : null);
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

  const resolvedObjectiveId = objectiveId || current?.objective_id || null;
  const isReactivationObjective = resolvedObjectiveId === 'reactivate_patients';
  const channelsSupported = source.channels_supported !== undefined
    ? normalizeStringArray(source.channels_supported)
    : (partial ? normalizeStringArray(current?.channels_supported) : []);
  const channelsDefaultRaw = source.channels_default !== undefined
    ? normalizeStringArray(source.channels_default)
    : (partial ? normalizeStringArray(current?.channels_default) : []);
  const channelsDefault = channelsDefaultRaw.filter((channel) => channelsSupported.includes(channel));
  if (!channelsSupported.length && !isReactivationObjective) {
    return { error: 'channels_supported_required', message: 'channels_supported debe incluir al menos un canal' };
  }
  const reactivationAllowedChannels = new Set(['whatsapp', 'phone']);
  const finalChannelsSupported = isReactivationObjective
    ? channelsSupported.filter((channel) => reactivationAllowedChannels.has(channel))
    : channelsSupported;
  const finalChannelsSupportedWithFallback = finalChannelsSupported.length
    ? finalChannelsSupported
    : (isReactivationObjective ? ['whatsapp', 'phone'] : finalChannelsSupported);
  const finalChannelsDefault = (isReactivationObjective
    ? channelsDefault.filter((channel) => reactivationAllowedChannels.has(channel))
    : channelsDefault)
    .filter((channel) => finalChannelsSupportedWithFallback.includes(channel));

  const destinationPolicy = source.destination_policy !== undefined
    ? normalizeDestinationPolicy(source.destination_policy)
    : (partial ? normalizeDestinationPolicy(current?.destination_policy) : normalizeDestinationPolicy({}));
  const measurementProfile = source.measurement_profile !== undefined
    ? normalizeMeasurementProfile(source.measurement_profile)
    : (partial ? normalizeMeasurementProfile(current?.measurement_profile) : normalizeMeasurementProfile({}));
  const automationStrategy = source.automation_strategy !== undefined
    ? normalizeAutomationStrategy(source.automation_strategy)
    : (partial ? normalizeAutomationStrategy(current?.automation_strategy) : normalizeAutomationStrategy({}));
  if (resolvedObjectiveId !== 'reactivate_patients') {
    automationStrategy.reactivation_preset = null;
  }
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
      area_medica: resolvedPromotionKind === 'generic_campaign' ? areaMedica : null,
      family_key: resolvedPromotionKind === 'generic_campaign' ? familyKey : null,
      status,
      channels_supported: finalChannelsSupportedWithFallback,
      channels_default: finalChannelsDefault.length ? finalChannelsDefault : [finalChannelsSupportedWithFallback[0]],
      recommended_budget_min: isReactivationObjective ? null : (source.recommended_budget_min !== undefined
        ? toNullableInt(source.recommended_budget_min)
        : (partial ? toNullableInt(current?.recommended_budget_min) : null)),
      recommended_budget_max: isReactivationObjective ? null : (source.recommended_budget_max !== undefined
        ? toNullableInt(source.recommended_budget_max)
        : (partial ? toNullableInt(current?.recommended_budget_max) : null)),
      destination_policy: isReactivationObjective
        ? {
            clinic_website_default: false,
            specific_url_allowed: false,
            subtree_recommended: false,
            landing_future: false,
          }
        : destinationPolicy,
      measurement_profile: isReactivationObjective
        ? {
            first_party: false,
            channel_native: false,
            business_outcomes: true,
            remarketing: false,
            ad_calls: false,
          }
        : measurementProfile,
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
  const isReactivationObjective = data?.objective_id === 'reactivate_patients';
  const reactivationAllowedChannels = new Set(['whatsapp', 'phone']);
  const channelsSupported = isReactivationObjective
    ? normalizeStringArray(data?.channels_supported).filter((channel) => reactivationAllowedChannels.has(channel))
    : normalizeStringArray(data?.channels_supported);
  const channelsSupportedWithFallback = channelsSupported.length
    ? channelsSupported
    : (isReactivationObjective ? ['whatsapp', 'phone'] : channelsSupported);
  const channelsDefault = (isReactivationObjective
    ? normalizeStringArray(data?.channels_default).filter((channel) => reactivationAllowedChannels.has(channel))
    : normalizeStringArray(data?.channels_default))
    .filter((channel) => channelsSupportedWithFallback.includes(channel));

  return {
    ...data,
    channels_supported: channelsSupportedWithFallback,
    channels_default: channelsDefault.length ? channelsDefault : [channelsSupportedWithFallback[0]].filter(Boolean),
    recommended_budget_min: isReactivationObjective ? null : data?.recommended_budget_min,
    recommended_budget_max: isReactivationObjective ? null : data?.recommended_budget_max,
    destination_policy: isReactivationObjective
      ? {
          clinic_website_default: false,
          specific_url_allowed: false,
          subtree_recommended: false,
          landing_future: false,
        }
      : data?.destination_policy,
    measurement_profile: isReactivationObjective
      ? {
          first_party: false,
          channel_native: false,
          business_outcomes: true,
          remarketing: false,
          ad_calls: false,
        }
      : data?.measurement_profile,
    area_medica: data?.area_medica || null,
    treatment: treatment
      ? {
          id_tratamiento: Number(treatment.id_tratamiento),
          nombre: treatment.nombre,
          codigo: treatment.codigo || null,
          area_medica: treatment.disciplina || null,
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
