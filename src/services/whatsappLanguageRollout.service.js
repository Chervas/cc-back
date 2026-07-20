'use strict';

const crypto = require('crypto');
const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const jobScheduler = require('./jobScheduler.service');
const whatsappTemplatesService = require('./whatsappTemplates.service');
const {
  buildWhatsappTemplateCatalogCoverage,
  resolveEffectiveWabaForClinic,
} = require('../lib/whatsapp-template-catalog-coverage');
const {
  normalizeWhatsappLocale,
  resolveCatalogFamilyKey,
  resolveMetaTemplateLanguage,
} = require('../lib/whatsapp-template-locale');

const { Op } = db.Sequelize;
const ROLLOUT_JOB_TYPE = 'whatsapp_language_rollout';
const TARGET_LOCALES = Object.freeze(['ca', 'en']);
const DEFAULT_APPROVAL_POLL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.WHATSAPP_LANGUAGE_ROLLOUT_POLL_MS || 15 * 60 * 1000)
);
const DEFAULT_MAX_POLL_CYCLES = Math.max(
  1,
  Number(process.env.WHATSAPP_LANGUAGE_ROLLOUT_MAX_POLL_CYCLES || 7 * 24 * 4)
);

const MANUAL_TRANSLATION_ROWS = Object.freeze([
  {
    es: '¡Muchas gracias {{paciente.nombre}}! Nos vemos ahora',
    ca: 'Moltes gràcies, {{paciente.nombre}}! Ens veiem ara',
    en: 'Thank you very much, {{paciente.nombre}}! See you shortly',
  },
  {
    es: '¡Muchas gracias {{paciente.nombre}}! Nos vemos mañana a las {{cita.hora}}',
    ca: 'Moltes gràcies, {{paciente.nombre}}! Ens veiem demà a les {{cita.hora}}',
    en: 'Thank you very much, {{paciente.nombre}}! See you tomorrow at {{cita.hora}}',
  },
  {
    es: '¡Muchas gracias {{paciente.nombre}}! ¡Nos vemos!',
    ca: 'Moltes gràcies, {{paciente.nombre}}! Fins aviat!',
    en: 'Thank you very much, {{paciente.nombre}}! See you soon!',
  },
  {
    es: 'Perdona {{paciente.nombre}}, pero la cita va a a ser ahora y necesitamos saber que sabes llegar. ¿Nos confirmas?',
    ca: 'Perdona, {{paciente.nombre}}, però la cita és d’aquí a poc i necessitem saber que saps arribar-hi. Ens ho confirmes?',
    en: 'Sorry, {{paciente.nombre}}, but your appointment is coming up shortly and we need to know that you know how to get here. Could you confirm?',
  },
  {
    es: 'Perdona {{paciente.nombre}}, pero la cita es mañana y necesitamos cerrar la agenda del doctor. ¿Nos la confirmas?',
    ca: 'Perdona, {{paciente.nombre}}, però la cita és demà i necessitem tancar l’agenda del doctor. Ens la confirmes?',
    en: 'Sorry, {{paciente.nombre}}, but your appointment is tomorrow and we need to finalize the doctor’s schedule. Could you confirm it?',
  },
  {
    es: 'Perdona {{paciente.nombre}}, pero necesitamos confirmación para cerrar la agenda del doctor. ¿Nos la confirmas?',
    ca: 'Perdona, {{paciente.nombre}}, però necessitem la teva confirmació per tancar l’agenda del doctor. Ens la confirmes?',
    en: 'Sorry, {{paciente.nombre}}, but we need your confirmation to finalize the doctor’s schedule. Could you confirm the appointment?',
  },
  {
    es: '¡Gracias {{paciente.nombre}}! Hasta mañana',
    ca: 'Gràcies, {{paciente.nombre}}! Fins demà',
    en: 'Thank you, {{paciente.nombre}}! See you tomorrow',
  },
  {
    es: '¡Hasta ahora!',
    ca: 'Fins ara!',
    en: 'See you shortly!',
  },
  {
    es: 'Gracias, queda confirmada. Te esperamos mañana a la hora prevista.',
    ca: 'Gràcies, queda confirmada. T’esperem demà a l’hora prevista.',
    en: 'Thank you, it is confirmed. We look forward to seeing you tomorrow at the scheduled time.',
  },
]);

function cleanString(value) {
  return String(value ?? '').trim();
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cloneJson(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return fallback;
  }
}

function normalizeManualFingerprint(value) {
  return cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const MANUAL_TRANSLATIONS = new Map(
  MANUAL_TRANSLATION_ROWS.map((row) => [normalizeManualFingerprint(row.es), row])
);

function translateManualMessage(text, locale) {
  const normalizedLocale = normalizeWhatsappLocale(locale);
  if (!TARGET_LOCALES.includes(normalizedLocale)) return null;
  return MANUAL_TRANSLATIONS.get(normalizeManualFingerprint(text))?.[normalizedLocale] || null;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function whatsappConfigFingerprint(config) {
  const safe = cloneJson(config, {}) || {};
  delete safe.language_routing;
  return crypto.createHash('sha256').update(stableSerialize(safe)).digest('hex');
}

function canonicalizeConfigForFingerprint(config, slotFamilies = {}) {
  const safe = cloneJson(config, {}) || {};
  delete safe.language_routing;
  delete safe.sender_origin_id;
  const stripReference = (target, prefix, familyKey) => {
    if (!target || typeof target !== 'object') return;
    delete target[`${prefix}template_id`];
    delete target[`${prefix}template_name`];
    delete target[`${prefix}template_display_name`];
    delete target[`${prefix}catalog_template_id`];
    delete target[`${prefix}catalog_family_key`];
    if (familyKey) target[`${prefix}template_family`] = familyKey;
  };
  stripReference(safe, '', slotFamilies.primary);
  stripReference(safe, 'fallback_', slotFamilies.fallback);
  if (safe.access_guidance_variant && typeof safe.access_guidance_variant === 'object') {
    stripReference(
      safe.access_guidance_variant,
      '',
      slotFamilies['access_guidance.primary']
    );
    stripReference(
      safe.access_guidance_variant,
      'fallback_',
      slotFamilies['access_guidance.fallback']
    );
  }
  return safe;
}

function templateReference(config, prefix = '') {
  const templateId = toPositiveInt(config?.[`${prefix}template_id`]);
  const templateName = cleanString(config?.[`${prefix}template_name`]);
  const catalogTemplateId = toPositiveInt(config?.[`${prefix}catalog_template_id`]);
  return {
    template_id: templateId,
    template_name: templateName || null,
    catalog_template_id: catalogTemplateId,
    present: !!(templateId || templateName || catalogTemplateId),
  };
}

function referenceSlotsForNode(config) {
  const slots = [];
  const messageMode = cleanString(config?.message_mode || 'template').toLowerCase() === 'manual'
    ? 'manual'
    : 'template';
  if (messageMode === 'template') {
    slots.push({ key: 'primary', config, prefix: '' });
  }
  if (templateReference(config, 'fallback_').present) {
    slots.push({ key: 'fallback', config, prefix: 'fallback_' });
  }
  const accessConfig = config?.access_guidance_variant;
  if (accessConfig && typeof accessConfig === 'object' && !Array.isArray(accessConfig)) {
    if (templateReference(accessConfig).present) {
      slots.push({ key: 'access_guidance.primary', config: accessConfig, prefix: '' });
    }
    if (templateReference(accessConfig, 'fallback_').present) {
      slots.push({ key: 'access_guidance.fallback', config: accessConfig, prefix: 'fallback_' });
    }
  }
  return slots;
}

function buildIndexes(inventory) {
  const catalogs = Array.isArray(inventory?.catalogs) ? inventory.catalogs : [];
  const instances = Array.isArray(inventory?.instances) ? inventory.instances : [];
  const catalogById = new Map(catalogs.map((row) => [Number(row.id), row]));
  const instancesById = new Map(instances.map((row) => [Number(row.id), row]));
  const instancesByName = new Map();
  const instancesByCatalogId = new Map();
  for (const row of instances) {
    const name = cleanString(row.name).toLowerCase();
    if (name) {
      if (!instancesByName.has(name)) instancesByName.set(name, []);
      instancesByName.get(name).push(row);
    }
    const catalogId = toPositiveInt(row.catalog_template_id);
    if (catalogId) {
      if (!instancesByCatalogId.has(catalogId)) instancesByCatalogId.set(catalogId, []);
      instancesByCatalogId.get(catalogId).push(row);
    }
  }
  const catalogsByFamilyLocale = new Map();
  for (const catalog of catalogs) {
    const family = resolveCatalogFamilyKey(catalog);
    const locale = normalizeWhatsappLocale(catalog.locale, { fallback: 'es' });
    if (family && locale) catalogsByFamilyLocale.set(`${family}:${locale}`, catalog);
  }
  return {
    catalogById,
    instancesById,
    instancesByName,
    instancesByCatalogId,
    catalogsByFamilyLocale,
  };
}

function getSpanishReferenceCandidates(slot, indexes) {
  const reference = templateReference(slot.config, slot.prefix);
  let candidates = [];
  if (reference.template_id && indexes.instancesById.has(reference.template_id)) {
    candidates = [indexes.instancesById.get(reference.template_id)];
  } else if (reference.template_name) {
    candidates = indexes.instancesByName.get(reference.template_name.toLowerCase()) || [];
  } else if (reference.catalog_template_id) {
    candidates = indexes.instancesByCatalogId.get(reference.catalog_template_id) || [];
  }
  return candidates.filter((row) => {
    const catalog = indexes.catalogById.get(Number(row.catalog_template_id));
    return (
      row.is_active !== false
      && Number(row.is_active) !== 0
      && normalizeWhatsappLocale(row.language || catalog?.locale, { fallback: 'es' }) === 'es'
    );
  });
}

function scoreInstanceForFlow(row, flow, preferredWabaId = null) {
  let score = 0;
  const flowClinicId = toPositiveInt(flow?.clinic_id);
  const rowClinicId = toPositiveInt(row?.clinic_id);
  if (flowClinicId && rowClinicId === flowClinicId) score += 100;
  if (preferredWabaId && cleanString(row?.waba_id) === cleanString(preferredWabaId)) score += 80;
  if (!rowClinicId) score += 10;
  if (cleanString(row?.status).toUpperCase() === 'APPROVED') score += 30;
  score += Number(row?.id || 0) / 1000000;
  return score;
}

function selectSpanishReferenceInstance(slot, flow, indexes) {
  return getSpanishReferenceCandidates(slot, indexes)
    .sort((left, right) => scoreInstanceForFlow(right, flow) - scoreInstanceForFlow(left, flow))[0] || null;
}

function mergeFamilyTargets(target, source) {
  const clinicIds = new Set([...(target?.clinic_ids || []), ...(source?.clinic_ids || [])].map(Number));
  const wabaIds = new Set([...(target?.waba_ids || []), ...(source?.waba_ids || [])].map(cleanString));
  return {
    clinic_ids: Array.from(clinicIds).filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b),
    waba_ids: Array.from(wabaIds).filter(Boolean).sort(),
  };
}

function resolveReferenceTargets({ flow, slot, inventory, indexes }) {
  const clinics = Array.isArray(inventory?.clinics) ? inventory.clinics : [];
  const assets = Array.isArray(inventory?.assets) ? inventory.assets : [];
  const clinicsById = new Map(clinics.map((clinic) => [Number(clinic.id_clinica), clinic]));
  const candidateClinicIds = new Set();
  const candidateWabaIds = new Set();
  const flowClinicId = toPositiveInt(flow?.clinic_id);
  const flowGroupId = toPositiveInt(flow?.group_id);
  const referenceCandidates = getSpanishReferenceCandidates(slot, indexes);

  if (flowClinicId) {
    candidateClinicIds.add(flowClinicId);
  } else if (flowGroupId) {
    for (const clinic of clinics) {
      if (toPositiveInt(clinic?.grupoClinicaId) === flowGroupId) {
        candidateClinicIds.add(Number(clinic.id_clinica));
      }
    }
  } else {
    // Los flujos globales heredados no abren el catálogo a todas las clínicas.
    // Su alcance sale únicamente de las instancias españolas que ya referencian.
    for (const instance of referenceCandidates) {
      const instanceClinicId = toPositiveInt(instance?.clinic_id);
      const instanceWabaId = cleanString(instance?.waba_id);
      if (instanceClinicId) candidateClinicIds.add(instanceClinicId);
      if (instanceWabaId) candidateWabaIds.add(instanceWabaId);
    }
  }

  // Una instancia global ligada a WABA puede no tener clinic_id. Recuperamos
  // solo las clínicas que efectivamente heredan/usan ese WABA.
  for (const clinic of clinics) {
    const wabaId = resolveEffectiveWabaForClinic({ clinic, assets });
    if (wabaId && candidateWabaIds.has(wabaId)) {
      candidateClinicIds.add(Number(clinic.id_clinica));
    }
  }

  const clinicIds = [];
  const wabaIds = new Set();
  for (const clinicId of candidateClinicIds) {
    const clinic = clinicsById.get(Number(clinicId));
    if (!clinic) continue;
    const wabaId = resolveEffectiveWabaForClinic({ clinic, assets });
    // Los flujos de clínicas aún desconectadas se localizan al publicar, pero
    // no forman parte del envío/auditoría Meta de este rollout.
    if (!wabaId) continue;
    clinicIds.push(Number(clinicId));
    wabaIds.add(wabaId);
  }

  const activeCredentialWabas = new Set(assets.filter((asset) => (
    !!cleanString(asset?.wabaId)
    && (asset?.hasCredentials === true || !!cleanString(asset?.waAccessToken))
  )).map((asset) => cleanString(asset.wabaId)));
  for (const wabaId of candidateWabaIds) {
    if (activeCredentialWabas.has(wabaId)) wabaIds.add(wabaId);
  }

  return {
    clinic_ids: Array.from(new Set(clinicIds)).sort((a, b) => a - b),
    waba_ids: Array.from(wabaIds).sort(),
    reference_candidates: referenceCandidates.length,
    scope_source: flowClinicId ? 'clinic' : (flowGroupId ? 'group' : 'referenced_instances'),
  };
}

function clinicForFlow(flow, inventory) {
  const clinicId = toPositiveInt(flow?.clinic_id);
  return clinicId
    ? (inventory.clinics || []).find((clinic) => Number(clinic.id_clinica) === clinicId) || null
    : null;
}

function preferredWabaForReference(baseInstance, flow, inventory) {
  const direct = cleanString(baseInstance?.waba_id);
  if (direct) return direct;
  const clinicId = toPositiveInt(baseInstance?.clinic_id) || toPositiveInt(flow?.clinic_id);
  const clinic = clinicId
    ? (inventory.clinics || []).find((row) => Number(row.id_clinica) === clinicId)
    : clinicForFlow(flow, inventory);
  return clinic
    ? resolveEffectiveWabaForClinic({ clinic, assets: inventory.assets || [] })
    : null;
}

function selectLocalizedInstance({ familyKey, locale, baseInstance, flow, inventory, indexes }) {
  const catalog = indexes.catalogsByFamilyLocale.get(`${familyKey}:${locale}`);
  if (!catalog) return { catalog: null, instance: null };
  const preferredWabaId = preferredWabaForReference(baseInstance, flow, inventory);
  const candidates = (indexes.instancesByCatalogId.get(Number(catalog.id)) || [])
    .filter((row) => (
      row.is_active !== false
      && Number(row.is_active) !== 0
      && cleanString(row.status).toUpperCase() === 'APPROVED'
      && !!cleanString(row.meta_template_id)
      && normalizeWhatsappLocale(row.language || catalog.locale) === locale
      && (!preferredWabaId || cleanString(row.waba_id) === preferredWabaId || !cleanString(row.waba_id))
    ))
    .sort((left, right) => (
      scoreInstanceForFlow(right, flow, preferredWabaId)
      - scoreInstanceForFlow(left, flow, preferredWabaId)
    ));
  return { catalog, instance: candidates[0] || null };
}

function copyReferenceBindings(target, source, prefix) {
  const positionalKey = `${prefix}variables`;
  const namedKey = `${prefix}variables_named`;
  if (source?.[positionalKey] !== undefined) target[positionalKey] = cloneJson(source[positionalKey], {});
  if (source?.[namedKey] !== undefined) target[namedKey] = cloneJson(source[namedKey], {});
  const contractKey = `${prefix}require_current_catalog_body`;
  if (source?.[contractKey] !== undefined) target[contractKey] = source[contractKey];
}

function writeLocalizedReference(target, source, prefix, familyKey, localized) {
  target[`${prefix}template_id`] = String(localized.instance.id);
  target[`${prefix}template_name`] = localized.instance.name;
  target[`${prefix}catalog_template_id`] = Number(localized.catalog.id);
  target[`${prefix}catalog_family_key`] = familyKey;
  copyReferenceBindings(target, source, prefix);
}

function buildLocalizedVariant({ config, locale, flow, inventory, indexes }) {
  const variant = {
    language_code: resolveMetaTemplateLanguage(locale),
  };
  const messageMode = cleanString(config?.message_mode || 'template').toLowerCase() === 'manual'
    ? 'manual'
    : 'template';
  if (messageMode === 'manual') {
    const translated = translateManualMessage(config?.manual_message_text, locale);
    if (!translated) {
      throw new Error(`whatsapp_language_manual_translation_missing:${whatsappConfigFingerprint(config)}`);
    }
    variant.manual_message_text = translated;
  }

  for (const slot of referenceSlotsForNode(config)) {
    const baseInstance = selectSpanishReferenceInstance(slot, flow, indexes);
    const baseCatalog = baseInstance
      ? indexes.catalogById.get(Number(baseInstance.catalog_template_id))
      : null;
    const familyKey = resolveCatalogFamilyKey(baseCatalog);
    if (!baseInstance || !baseCatalog || !familyKey) {
      throw new Error(`whatsapp_language_base_family_unresolved:${flow.id}:${slot.key}`);
    }
    const localized = selectLocalizedInstance({
      familyKey,
      locale,
      baseInstance,
      flow,
      inventory,
      indexes,
    });
    if (!localized.catalog || !localized.instance) {
      throw new Error(`whatsapp_language_approved_instance_missing:${familyKey}:${locale}`);
    }

    if (slot.key.startsWith('access_guidance.')) {
      const nested = variant.access_guidance_variant || cloneJson(config.access_guidance_variant, {}) || {};
      writeLocalizedReference(nested, slot.config, slot.prefix, familyKey, localized);
      variant.access_guidance_variant = nested;
    } else {
      writeLocalizedReference(variant, slot.config, slot.prefix, familyKey, localized);
    }
  }
  return variant;
}

function collectFlowRequirements(flow, inventory, indexes) {
  const errors = [];
  const families = new Set();
  const targetsByFamily = {};
  const fingerprints = new Set();
  let whatsappNodes = 0;
  let alreadyRouted = 0;

  for (const node of Array.isArray(flow?.nodes) ? flow.nodes : []) {
    if (cleanString(node?.type) !== 'action/send_whatsapp') continue;
    whatsappNodes += 1;
    const config = node?.config && typeof node.config === 'object' ? node.config : {};
    const isAlreadyRouted = config?.language_routing?.enabled === true;
    if (isAlreadyRouted) alreadyRouted += 1;
    const messageMode = cleanString(config.message_mode || 'template').toLowerCase() === 'manual'
      ? 'manual'
      : 'template';
    if (messageMode === 'manual' && !isAlreadyRouted) {
      for (const locale of TARGET_LOCALES) {
        if (!translateManualMessage(config.manual_message_text, locale)) {
          errors.push(`manual_translation_missing:${flow.id}:${node.id}:${locale}`);
        }
      }
    }
    const slotFamilies = {};
    for (const slot of referenceSlotsForNode(config)) {
      const instance = selectSpanishReferenceInstance(slot, flow, indexes);
      const catalog = instance ? indexes.catalogById.get(Number(instance.catalog_template_id)) : null;
      const familyKey = resolveCatalogFamilyKey(catalog);
      if (!instance || !catalog || !familyKey) {
        errors.push(`base_family_unresolved:${flow.id}:${node.id}:${slot.key}`);
        continue;
      }
      families.add(familyKey);
      slotFamilies[slot.key] = familyKey;
      const targetScope = resolveReferenceTargets({
        flow,
        slot,
        inventory,
        indexes,
      });
      targetsByFamily[familyKey] = mergeFamilyTargets(
        targetsByFamily[familyKey],
        targetScope
      );
      if (
        !toPositiveInt(flow?.clinic_id)
        && !toPositiveInt(flow?.group_id)
        && targetScope.reference_candidates === 0
      ) {
        errors.push(`global_reference_scope_unresolved:${flow.id}:${node.id}:${slot.key}`);
      }
    }
    fingerprints.add(crypto.createHash('sha256')
      .update(stableSerialize(canonicalizeConfigForFingerprint(config, slotFamilies)))
      .digest('hex'));
  }
  return {
    flow_id: Number(flow.id),
    whatsapp_nodes: whatsappNodes,
    already_routed: alreadyRouted,
    families: Array.from(families).sort(),
    targets_by_family: targetsByFamily,
    fingerprints: Array.from(fingerprints).sort(),
    errors,
  };
}

function transformFlowNodes(flow, inventory, indexes) {
  let changed = 0;
  const nodes = (Array.isArray(flow?.nodes) ? flow.nodes : []).map((node) => {
    if (cleanString(node?.type) !== 'action/send_whatsapp') return node;
    const config = node?.config && typeof node.config === 'object' ? node.config : {};
    if (config?.language_routing?.enabled === true) return node;
    const variants = {};
    for (const locale of TARGET_LOCALES) {
      variants[locale] = buildLocalizedVariant({ config, locale, flow, inventory, indexes });
    }
    changed += 1;
    return {
      ...node,
      config: {
        ...config,
        language_routing: {
          enabled: true,
          source: 'patient_preferred_language',
          variants,
        },
      },
    };
  });
  return { nodes, changed };
}

async function loadInventory() {
  const [catalogModels, instanceModels, clinicModels, assetModels, flowModels] = await Promise.all([
    db.WhatsappTemplateCatalog.findAll({
      include: [{
        model: db.WhatsappTemplateCatalogDiscipline,
        as: 'disciplinas',
        attributes: ['disciplina_code'],
        required: false,
      }],
      order: [['id', 'ASC']],
    }),
    db.WhatsappTemplate.findAll({
      where: { is_active: true },
      order: [['id', 'ASC']],
    }),
    db.Clinica.findAll({
      attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica', 'configuracion'],
      order: [['id_clinica', 'ASC']],
    }),
    db.ClinicMetaAsset.findAll({
      where: {
        isActive: true,
        assetType: { [Op.in]: ['whatsapp_phone_number', 'whatsapp_business_account'] },
      },
      attributes: [
        'id', 'assetType', 'assignmentScope', 'clinicaId', 'grupoClinicaId',
        'wabaId', 'phoneNumberId', 'waAccessToken', 'isActive', 'updatedAt',
      ],
      order: [['updatedAt', 'DESC'], ['id', 'DESC']],
    }),
    db.AutomationFlowTemplateV2.findAll({
      where: {
        published_at: { [Op.ne]: null },
        is_active: true,
      },
      order: [['version', 'DESC'], ['id', 'DESC']],
    }),
  ]);

  const catalogs = catalogModels.map((row) => row.toJSON ? row.toJSON() : row);
  const instances = instanceModels.map((row) => row.toJSON ? row.toJSON() : row);
  const clinics = clinicModels.map((row) => row.toJSON ? row.toJSON() : row);
  const assets = assetModels.map((row) => {
    const item = row.toJSON ? row.toJSON() : row;
    return { ...item, hasCredentials: !!cleanString(item.waAccessToken) };
  });
  const newestByFamily = new Map();
  for (const model of flowModels) {
    const row = model.toJSON ? model.toJSON() : model;
    const family = cleanString(row.public_id) || cleanString(row.template_key);
    if (!family || newestByFamily.has(family)) continue;
    newestByFamily.set(family, row);
  }
  return {
    catalogs,
    instances,
    clinics,
    assets,
    flows: Array.from(newestByFamily.values()),
  };
}

function buildPreflight(inventory) {
  const indexes = buildIndexes(inventory);
  const plans = inventory.flows.map((flow) => collectFlowRequirements(flow, inventory, indexes));
  const errors = plans.flatMap((plan) => plan.errors);
  const familyKeys = Array.from(new Set(plans.flatMap((plan) => plan.families))).sort();
  const fingerprints = Array.from(new Set(plans.flatMap((plan) => plan.fingerprints))).sort();
  const catalogIds = [];
  const targetsByFamily = {};
  const targetsByCatalog = {};
  for (const plan of plans) {
    for (const [familyKey, targets] of Object.entries(plan.targets_by_family || {})) {
      targetsByFamily[familyKey] = mergeFamilyTargets(targetsByFamily[familyKey], targets);
    }
  }
  for (const familyKey of familyKeys) {
    const familyTargets = targetsByFamily[familyKey] || { clinic_ids: [], waba_ids: [] };
    if (!familyTargets.waba_ids.length || !familyTargets.clinic_ids.length) {
      errors.push(`family_effective_scope_missing:${familyKey}`);
    }
    for (const locale of TARGET_LOCALES) {
      const catalog = indexes.catalogsByFamilyLocale.get(`${familyKey}:${locale}`);
      if (!catalog) {
        errors.push(`catalog_translation_missing:${familyKey}:${locale}`);
      } else {
        catalogIds.push(Number(catalog.id));
        targetsByCatalog[String(catalog.id)] = familyTargets;
      }
    }
  }
  const targetClinicIds = Array.from(new Set(
    Object.values(targetsByFamily).flatMap((target) => target.clinic_ids || []).map(Number)
  )).filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
  const targetWabaIds = Array.from(new Set(
    Object.values(targetsByFamily).flatMap((target) => target.waba_ids || []).map(cleanString)
  )).filter(Boolean).sort();
  return {
    ok: errors.length === 0,
    errors,
    family_keys: familyKeys,
    catalog_ids: Array.from(new Set(catalogIds)),
    targets_by_family: targetsByFamily,
    targets_by_catalog: targetsByCatalog,
    target_clinic_ids: targetClinicIds,
    target_waba_ids: targetWabaIds,
    flow_count: plans.length,
    whatsapp_node_count: plans.reduce((sum, plan) => sum + plan.whatsapp_nodes, 0),
    config_fingerprint_count: fingerprints.length,
    fingerprints,
    plans,
  };
}

async function activateRequiredCatalogTranslations(catalogIds) {
  await db.sequelize.transaction(async (transaction) => {
    await db.WhatsappTemplateCatalog.update(
      { is_active: true },
      { where: { id: { [Op.in]: catalogIds } }, transaction }
    );
  });
}

async function loadWabaSyncTargets(wabaIds = null) {
  const scopedWabaIds = Array.isArray(wabaIds)
    ? Array.from(new Set(wabaIds.map(cleanString).filter(Boolean)))
    : null;
  const rows = await db.ClinicMetaAsset.findAll({
    where: {
      isActive: true,
      assetType: { [Op.in]: ['whatsapp_phone_number', 'whatsapp_business_account'] },
      wabaId: scopedWabaIds ? { [Op.in]: scopedWabaIds } : { [Op.ne]: null },
      waAccessToken: { [Op.ne]: null },
    },
    attributes: ['id', 'wabaId', 'waAccessToken', 'updatedAt'],
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
  const byWaba = new Map();
  for (const row of rows) {
    const wabaId = cleanString(row.wabaId);
    if (wabaId && !byWaba.has(wabaId) && cleanString(row.waAccessToken)) byWaba.set(wabaId, row);
  }
  return Array.from(byWaba.values());
}

function auditCatalogApprovals(inventory, catalogIds, targetsByCatalog = {}) {
  const selected = new Set((catalogIds || []).map(Number));
  const rows = [];
  let rejected = false;
  for (const catalog of inventory.catalogs.filter((row) => selected.has(Number(row.id)))) {
    const target = targetsByCatalog?.[String(catalog.id)] || { clinic_ids: [], waba_ids: [] };
    const clinicIdSet = new Set((target.clinic_ids || []).map(Number));
    const wabaIdSet = new Set((target.waba_ids || []).map(cleanString));
    const scopedClinics = inventory.clinics.filter((clinic) => (
      clinicIdSet.has(Number(clinic.id_clinica))
    ));
    const familyRows = inventory.instances.filter((row) => (
      Number(row.catalog_template_id) === Number(catalog.id)
      && (!wabaIdSet.size || !cleanString(row.waba_id) || wabaIdSet.has(cleanString(row.waba_id)))
    ));
    const coverage = buildWhatsappTemplateCatalogCoverage({
      catalog,
      familyRows,
      clinics: scopedClinics,
      assets: inventory.assets,
    });
    const failedClinics = coverage.unapproved_clinics.filter((clinic) => (
      ['REJECTED', 'DISAPPROVED', 'DECLINED'].includes(cleanString(clinic.status).toUpperCase())
    ));
    if (failedClinics.length || cleanString(catalog.propagation_state).toLowerCase() === 'failed') rejected = true;
    rows.push({
      catalog_template_id: Number(catalog.id),
      family_key: resolveCatalogFamilyKey(catalog),
      locale: normalizeWhatsappLocale(catalog.locale),
      target_clinic_ids: Array.from(clinicIdSet).sort((a, b) => a - b),
      target_waba_ids: Array.from(wabaIdSet).sort(),
      approved: coverage.approved_by_coverage,
      approved_count: coverage.approved_count,
      approved_total: coverage.approved_total,
      unapproved_clinics: coverage.unapproved_clinics,
      propagation_state: catalog.propagation_state || null,
    });
  }
  return {
    approved: rows.length === selected.size && rows.every((row) => row.approved),
    rejected,
    catalogs_total: selected.size,
    catalogs_approved: rows.filter((row) => row.approved).length,
    rows,
  };
}

async function publishLocalizedFlowVersionsAtomically(expectedPreflight, approvedInventory) {
  return db.sequelize.transaction(async (transaction) => {
    const lockedModels = await db.AutomationFlowTemplateV2.findAll({
      where: {
        published_at: { [Op.ne]: null },
        is_active: true,
      },
      order: [['version', 'DESC'], ['id', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const newestByFamily = new Map();
    for (const model of lockedModels) {
      const family = cleanString(model.public_id) || cleanString(model.template_key);
      if (family && !newestByFamily.has(family)) newestByFamily.set(family, model);
    }
    const activeModels = Array.from(newestByFamily.values());
    const activeIds = activeModels.map((row) => Number(row.id)).sort((a, b) => a - b);
    const expectedIds = (expectedPreflight.plans || []).map((row) => Number(row.flow_id)).sort((a, b) => a - b);
    if (JSON.stringify(activeIds) !== JSON.stringify(expectedIds)) {
      throw new Error('whatsapp_language_rollout_active_flows_changed');
    }

    const publicIds = activeModels.map((row) => cleanString(row.public_id)).filter(Boolean);
    const templateKeys = activeModels.map((row) => cleanString(row.template_key)).filter(Boolean);
    const familyRows = await db.AutomationFlowTemplateV2.findAll({
      where: {
        [Op.or]: [
          ...(publicIds.length ? [{ public_id: { [Op.in]: publicIds } }] : []),
          ...(templateKeys.length ? [{ template_key: { [Op.in]: templateKeys } }] : []),
        ],
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const existingDraft = familyRows.find((row) => !row.published_at);
    if (existingDraft) {
      throw new Error(`whatsapp_language_rollout_draft_conflict:${existingDraft.id}`);
    }
    const maxVersionByFamily = new Map();
    for (const row of familyRows) {
      const family = cleanString(row.public_id) || cleanString(row.template_key);
      maxVersionByFamily.set(
        family,
        Math.max(Number(maxVersionByFamily.get(family) || 0), Number(row.version || 0))
      );
    }

    const inventory = {
      ...approvedInventory,
    };
    // Dentro de la transacción fijamos las versiones bloqueadas; catálogo e
    // instancias se vuelven a leer con lock para que aprobación y publicación
    // formen una única frontera atómica en nuestra base de datos.
    const requiredCatalogIds = (expectedPreflight.catalog_ids || []).map(Number);
    const [lockedCatalogs, lockedInstances] = await Promise.all([
      db.WhatsappTemplateCatalog.findAll({
        where: { id: { [Op.in]: requiredCatalogIds } },
        include: [{
          model: db.WhatsappTemplateCatalogDiscipline,
          as: 'disciplinas',
          attributes: ['disciplina_code'],
          required: false,
        }],
        transaction,
        lock: transaction.LOCK.UPDATE,
      }),
      db.WhatsappTemplate.findAll({
        where: {
          catalog_template_id: { [Op.in]: requiredCatalogIds },
          is_active: true,
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      }),
    ]);
    const nonRequiredCatalogs = (approvedInventory.catalogs || []).filter((catalog) => (
      !requiredCatalogIds.includes(Number(catalog.id))
    ));
    const nonRequiredInstances = (approvedInventory.instances || []).filter((instance) => (
      !requiredCatalogIds.includes(Number(instance.catalog_template_id))
    ));
    inventory.catalogs = [
      ...nonRequiredCatalogs,
      ...lockedCatalogs.map((row) => row.toJSON ? row.toJSON() : row),
    ];
    inventory.instances = [
      ...nonRequiredInstances,
      ...lockedInstances.map((row) => row.toJSON ? row.toJSON() : row),
    ];
    const lockedApproval = auditCatalogApprovals(
      inventory,
      requiredCatalogIds,
      expectedPreflight.targets_by_catalog || {}
    );
    if (!lockedApproval.approved) {
      throw new Error('whatsapp_language_rollout_approval_changed');
    }
    inventory.flows = activeModels.map((row) => row.toJSON ? row.toJSON() : row);
    const indexes = buildIndexes(inventory);
    const currentPreflight = buildPreflight(inventory);
    if (!currentPreflight.ok) {
      throw new Error(`whatsapp_language_rollout_preflight_changed:${currentPreflight.errors.join('|')}`);
    }

    const createdIds = [];
    let nodesChanged = 0;
    const publishedAt = new Date();
    for (const model of activeModels) {
      const flow = model.toJSON ? model.toJSON() : model;
      const family = cleanString(model.public_id) || cleanString(model.template_key);
      const transformed = transformFlowNodes(flow, inventory, indexes);
      if (!transformed.changed) continue;
      const created = await db.AutomationFlowTemplateV2.create({
        public_id: model.public_id,
        template_key: model.template_key,
        version: Number(maxVersionByFamily.get(family) || model.version || 0) + 1,
        engine_version: model.engine_version || 'v2',
        name: model.name,
        description: model.description,
        trigger_type: model.trigger_type,
        trigger_config: cloneJson(model.trigger_config, null),
        is_active: true,
        is_system: !!model.is_system,
        clinic_id: model.clinic_id || null,
        group_id: model.group_id || null,
        entry_node_id: model.entry_node_id,
        nodes: transformed.nodes,
        published_at: publishedAt,
        published_by: expectedPreflight.requested_by || model.published_by || model.created_by,
        created_by: expectedPreflight.requested_by || model.created_by || 1,
      }, { transaction });
      await model.update({ is_active: false }, { transaction });
      createdIds.push(Number(created.id));
      nodesChanged += transformed.changed;
    }
    return {
      flow_versions_published: createdIds.length,
      whatsapp_nodes_localized: nodesChanged,
      created_version_ids: createdIds,
    };
  });
}

async function persistJobPayload(jobRequest, patch) {
  if (!jobRequest?.id) return;
  const payload = {
    ...(jobRequest.payload && typeof jobRequest.payload === 'object' ? jobRequest.payload : {}),
    ...patch,
  };
  await jobRequest.update({ payload });
  jobRequest.payload = payload;
}

function waitingResult(progress, delayMs = 1000) {
  return {
    status: 'waiting',
    nextAllowedAt: new Date(Date.now() + delayMs),
    result: progress,
  };
}

async function runRolloutJob(payload = {}, jobRequest = null) {
  if (!jobRequest?.id) throw new Error('whatsapp_language_rollout_job_request_required');
  const phase = cleanString(payload.phase) || 'prepare';

  if (phase === 'prepare') {
    const inventory = await loadInventory();
    const preflight = buildPreflight(inventory);
    if (!preflight.ok) {
      return {
        status: 'failed',
        retryable: false,
        error_message: 'whatsapp_language_rollout_preflight_failed',
        result: { phase, ...preflight, retryable: false },
      };
    }
    await activateRequiredCatalogTranslations(preflight.catalog_ids);
    const compactPreflight = {
      ok: true,
      errors: [],
      family_keys: preflight.family_keys,
      catalog_ids: preflight.catalog_ids,
      flow_count: preflight.flow_count,
      whatsapp_node_count: preflight.whatsapp_node_count,
      config_fingerprint_count: preflight.config_fingerprint_count,
      targets_by_family: preflight.targets_by_family,
      targets_by_catalog: preflight.targets_by_catalog,
      target_clinic_ids: preflight.target_clinic_ids,
      target_waba_ids: preflight.target_waba_ids,
      plans: preflight.plans.map((plan) => ({ flow_id: plan.flow_id })),
      requested_by: jobRequest.requested_by || null,
    };
    const nextPayload = {
      phase: 'propagate',
      catalog_ids: preflight.catalog_ids,
      catalog_cursor: 0,
      preflight: compactPreflight,
      targets_by_catalog: preflight.targets_by_catalog,
      target_clinic_ids: preflight.target_clinic_ids,
      target_waba_ids: preflight.target_waba_ids,
      progress: {
        phase: 'prepare',
        state: 'prepared',
        catalogs_total: preflight.catalog_ids.length,
        flows_total: preflight.flow_count,
        whatsapp_nodes_total: preflight.whatsapp_node_count,
        config_fingerprint_count: preflight.config_fingerprint_count,
        clinics_targeted: preflight.target_clinic_ids.length,
        wabas_targeted: preflight.target_waba_ids.length,
      },
    };
    await persistJobPayload(jobRequest, nextPayload);
    return waitingResult({
      phase: 'prepare',
      state: 'prepared',
      catalogs_total: preflight.catalog_ids.length,
      flows_total: preflight.flow_count,
      whatsapp_nodes_total: preflight.whatsapp_node_count,
      config_fingerprint_count: preflight.config_fingerprint_count,
      clinics_targeted: preflight.target_clinic_ids.length,
      wabas_targeted: preflight.target_waba_ids.length,
    });
  }

  if (phase === 'propagate') {
    const catalogIds = Array.isArray(payload.catalog_ids) ? payload.catalog_ids.map(Number) : [];
    const cursor = Math.max(0, Number(payload.catalog_cursor || 0));
    if (cursor >= catalogIds.length) {
      const syncTargets = await loadWabaSyncTargets(payload.target_waba_ids || []);
      await persistJobPayload(jobRequest, {
        phase: 'sync',
        sync_waba_ids: Array.isArray(payload.target_waba_ids)
          ? payload.target_waba_ids.map(cleanString).filter(Boolean)
          : syncTargets.map((row) => row.wabaId),
        sync_cursor: 0,
        propagation_inflight: null,
        progress: {
          phase: 'sync',
          state: 'ready_to_sync_meta',
          catalogs_processed: catalogIds.length,
          catalogs_total: catalogIds.length,
          wabas_total: syncTargets.length,
        },
      });
      return waitingResult({
        phase: 'propagate',
        state: 'submitted_to_meta',
        catalogs_processed: catalogIds.length,
        catalogs_total: catalogIds.length,
      });
    }
    const catalogId = catalogIds[cursor];
    const target = payload.targets_by_catalog?.[String(catalogId)] || null;
    if (!target?.clinic_ids?.length || !target?.waba_ids?.length) {
      return {
        status: 'failed',
        retryable: false,
        error_message: `whatsapp_language_rollout_catalog_scope_missing:${catalogId}`,
        result: { phase, catalog_template_id: catalogId, retryable: false },
      };
    }
    await persistJobPayload(jobRequest, {
      propagation_inflight: {
        catalog_template_id: catalogId,
        cursor,
        started_at: new Date().toISOString(),
      },
      progress: {
        phase,
        state: 'submitting_catalog_to_meta',
        catalog_template_id: catalogId,
        catalogs_processed: cursor,
        catalogs_total: catalogIds.length,
      },
    });
    const summary = await whatsappTemplatesService.propagateCatalogTemplateToAllClinics({
      templateCatalogId: catalogId,
      logger: console,
      clinicIds: target.clinic_ids,
      wabaIds: target.waba_ids,
      updateCatalogPropagationState: false,
      enqueueFollowupSync: false,
    });
    if (Array.isArray(summary?.errors) && summary.errors.length) {
      return {
        status: 'failed',
        retryable: false,
        error_message: `whatsapp_language_rollout_propagation_failed:${catalogId}`,
        result: {
          phase,
          catalog_template_id: catalogId,
          catalogs_processed: cursor,
          catalogs_total: catalogIds.length,
          errors: summary.errors,
          retryable: false,
        },
      };
    }
    await persistJobPayload(jobRequest, {
      catalog_cursor: cursor + 1,
      propagation_inflight: null,
      progress: {
        phase,
        state: 'propagating',
        catalog_template_id: catalogId,
        catalogs_processed: cursor + 1,
        catalogs_total: catalogIds.length,
      },
    });
    return waitingResult({
      phase,
      state: 'propagating',
      catalog_template_id: catalogId,
      catalogs_processed: cursor + 1,
      catalogs_total: catalogIds.length,
    });
  }

  if (phase === 'sync') {
    const targets = await loadWabaSyncTargets(payload.target_waba_ids || payload.sync_waba_ids || []);
    const requestedWabas = Array.isArray(payload.sync_waba_ids) ? payload.sync_waba_ids.map(cleanString) : [];
    const byWaba = new Map(targets.map((row) => [cleanString(row.wabaId), row]));
    const wabaIds = requestedWabas.length ? requestedWabas : Array.from(byWaba.keys());
    const missingWabas = wabaIds.filter((wabaId) => !byWaba.get(wabaId)?.waAccessToken);
    if (missingWabas.length) {
      return {
        status: 'failed',
        retryable: false,
        error_message: 'whatsapp_language_rollout_waba_credentials_missing',
        result: { phase, missing_waba_ids: missingWabas, retryable: false },
      };
    }
    const cursor = Math.max(0, Number(payload.sync_cursor || 0));
    if (cursor < wabaIds.length) {
      const wabaId = wabaIds[cursor];
      const target = byWaba.get(wabaId);
      if (!target?.waAccessToken) {
        return {
          status: 'failed',
          retryable: false,
          error_message: `whatsapp_language_rollout_waba_credentials_missing:${wabaId}`,
          result: { phase, waba_id: wabaId, retryable: false },
        };
      }
      await whatsappTemplatesService.syncTemplatesForWaba({
        wabaId,
        accessToken: target.waAccessToken,
      });
      await persistJobPayload(jobRequest, {
        sync_cursor: cursor + 1,
        progress: {
          phase,
          state: 'syncing_meta',
          wabas_processed: cursor + 1,
          wabas_total: wabaIds.length,
        },
      });
      return waitingResult({
        phase,
        state: 'syncing_meta',
        wabas_processed: cursor + 1,
        wabas_total: wabaIds.length,
      });
    }
    await persistJobPayload(jobRequest, {
      phase: 'audit',
      sync_cursor: 0,
      progress: { phase: 'audit', state: 'auditing_meta', wabas_total: wabaIds.length },
    });
    return waitingResult({ phase, state: 'meta_synced', wabas_total: wabaIds.length });
  }

  if (phase === 'audit') {
    const inventory = await loadInventory();
    const audit = auditCatalogApprovals(
      inventory,
      payload.catalog_ids || [],
      payload.targets_by_catalog || {}
    );
    if (audit.rejected) {
      return {
        status: 'failed',
        retryable: false,
        error_message: 'whatsapp_language_rollout_meta_rejected',
        result: { phase, ...audit, retryable: false },
      };
    }
    if (!audit.approved) {
      const pollCycles = Number(payload.poll_cycles || 0) + 1;
      if (pollCycles >= DEFAULT_MAX_POLL_CYCLES) {
        return {
          status: 'failed',
          retryable: false,
          error_message: 'whatsapp_language_rollout_approval_timeout',
          result: { phase, ...audit, poll_cycles: pollCycles, retryable: false },
        };
      }
      await persistJobPayload(jobRequest, {
        phase: 'sync',
        sync_cursor: 0,
        poll_cycles: pollCycles,
        progress: {
          phase,
          state: 'waiting_meta_approval',
          catalogs_approved: audit.catalogs_approved,
          catalogs_total: audit.catalogs_total,
          poll_cycles: pollCycles,
        },
      });
      return waitingResult({
        phase,
        state: 'waiting_meta_approval',
        ...audit,
        poll_cycles: pollCycles,
      }, DEFAULT_APPROVAL_POLL_MS);
    }
    await persistJobPayload(jobRequest, {
      phase: 'publish',
      progress: {
        phase: 'publish',
        state: 'ready_to_publish',
        catalogs_approved: audit.catalogs_approved,
        catalogs_total: audit.catalogs_total,
      },
    });
    return waitingResult({ phase, state: 'approval_complete', ...audit });
  }

  if (phase === 'publish') {
    const inventory = await loadInventory();
    const audit = auditCatalogApprovals(
      inventory,
      payload.catalog_ids || [],
      payload.targets_by_catalog || {}
    );
    if (!audit.approved) {
      return {
        status: 'failed',
        retryable: false,
        error_message: 'whatsapp_language_rollout_approval_changed',
        result: { phase, ...audit, retryable: false },
      };
    }
    const currentPreflight = buildPreflight(inventory);
    const alreadyLocalized = currentPreflight.plans.every((plan) => (
      plan.whatsapp_nodes === plan.already_routed
    ));
    if (alreadyLocalized) {
      return {
        status: 'completed',
        result: {
          phase,
          state: 'completed',
          already_localized: true,
          ...audit,
          flow_versions_published: 0,
          whatsapp_nodes_localized: 0,
          created_version_ids: [],
        },
      };
    }
    const preflight = {
      ...(payload.preflight || {}),
      requested_by: jobRequest.requested_by || payload.preflight?.requested_by || null,
    };
    const published = await publishLocalizedFlowVersionsAtomically(preflight, inventory);
    return {
      status: 'completed',
      result: {
        phase,
        state: 'completed',
        ...audit,
        ...published,
      },
    };
  }

  return {
    status: 'failed',
    retryable: false,
    error_message: `whatsapp_language_rollout_phase_invalid:${phase}`,
    result: { phase, retryable: false },
  };
}

async function enqueueRollout({ requestedBy = null, requestedByName = null } = {}) {
  const { job, created } = await jobRequestsService.enqueueUniqueJobRequest({
    type: ROLLOUT_JOB_TYPE,
    priority: 'high',
    origin: 'whatsapp_language_rollout',
    payload: { phase: 'prepare' },
    requestedBy,
    requestedByName,
    requestedByRole: 'admin',
    maxAttempts: 10000,
    dedupeScope: 'whatsapp_language_rollout:v1',
  });
  if (created) jobScheduler.triggerImmediate(job.id).catch(() => {});
  return { job, created };
}

async function getLatestRollout() {
  return db.JobRequest.findOne({
    where: { type: ROLLOUT_JOB_TYPE },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
  });
}

function unwrapRolloutResultSummary(value) {
  let current = value && typeof value === 'object' ? value : null;
  for (let depth = 0; current && depth < 3; depth += 1) {
    if (!['waiting', 'completed', 'failed'].includes(cleanString(current.status))) break;
    if (!current.result || typeof current.result !== 'object') break;
    current = current.result;
  }
  return current;
}

function buildRolloutJobView(job) {
  if (!job) return null;
  const plain = job.toJSON ? job.toJSON() : job;
  const payload = plain.payload && typeof plain.payload === 'object' ? plain.payload : {};
  const settledProgress = unwrapRolloutResultSummary(plain.result_summary);
  const runningProgress = payload.progress && typeof payload.progress === 'object'
    ? payload.progress
    : null;
  const terminal = ['completed', 'failed', 'cancelled'].includes(cleanString(plain.status));
  return {
    id: Number(plain.id),
    type: plain.type,
    status: plain.status,
    phase: terminal
      ? (settledProgress?.phase || payload.phase || null)
      : (runningProgress?.phase || payload.phase || settledProgress?.phase || null),
    progress: terminal
      ? (settledProgress || runningProgress)
      : ({ ...(settledProgress || {}), ...(runningProgress || {}) }),
    error: plain.error_message || settledProgress?.error_message || null,
    attempts: Number(plain.attempts || 0),
    next_run_at: plain.next_run_at || null,
    completed_at: plain.completed_at || null,
    created_at: plain.created_at || plain.createdAt || null,
    updated_at: plain.updated_at || plain.updatedAt || null,
  };
}

module.exports = {
  ROLLOUT_JOB_TYPE,
  enqueueRollout,
  getLatestRollout,
  buildRolloutJobView,
  runRolloutJob,
  _test: {
    MANUAL_TRANSLATION_ROWS,
    normalizeManualFingerprint,
    translateManualMessage,
    whatsappConfigFingerprint,
    referenceSlotsForNode,
    buildIndexes,
    collectFlowRequirements,
    buildPreflight,
    transformFlowNodes,
    auditCatalogApprovals,
    resolveReferenceTargets,
    mergeFamilyTargets,
    unwrapRolloutResultSummary,
    loadInventory,
  },
};
