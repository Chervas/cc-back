'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { queues } = require('./queue.service');
const whatsappTemplatesService = require('./whatsappTemplates.service');

const {
  Clinica,
  AutomationFlowCatalog,
  AutomationFlowCatalogDiscipline,
  AutomationFlowTemplateV2,
  WhatsappTemplateCatalog,
} = db;

const MAX_TEMPLATE_KEY_LENGTH = 120;

function normalizeDisciplines(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return [];
}

async function resolveClinicDisciplines(clinicId) {
  const clinic = await Clinica.findOne({ where: { id_clinica: clinicId }, raw: true });
  const cfg = clinic?.configuracion || {};
  const disciplinas = normalizeDisciplines(cfg.disciplinas);
  return disciplinas.length ? disciplinas : ['dental'];
}

async function resolveClinicScope(clinicId) {
  const clinic = await Clinica.findOne({
    where: { id_clinica: clinicId },
    attributes: ['id_clinica', 'grupoClinicaId', 'configuracion'],
    raw: true,
  });
  if (!clinic) return null;
  return {
    clinic_id: clinic.id_clinica,
    group_id: clinic.grupoClinicaId || null,
    disciplinas: normalizeDisciplines(clinic?.configuracion?.disciplinas).length
      ? normalizeDisciplines(clinic?.configuracion?.disciplinas)
      : ['dental'],
  };
}

async function selectAutomationCatalogByDisciplines(disciplinas) {
  const generic = await AutomationFlowCatalog.findAll({
    where: { is_active: true, is_generic: true },
  });

  let disciplineFlows = [];
  if (disciplinas.length) {
    const links = await AutomationFlowCatalogDiscipline.findAll({
      where: { disciplina_code: { [Op.in]: disciplinas } },
      attributes: ['flow_catalog_id'],
      raw: true,
    });
    const ids = Array.from(new Set(links.map((l) => l.flow_catalog_id)));
    if (ids.length) {
      disciplineFlows = await AutomationFlowCatalog.findAll({
        where: { id: { [Op.in]: ids }, is_active: true },
      });
    }
  }

  const byId = new Map();
  [...generic, ...disciplineFlows].forEach((f) => byId.set(f.id, f));
  return Array.from(byId.values());
}

function resolveTriggerFromSteps(steps) {
  if (!Array.isArray(steps)) return null;
  const trigger = steps.find((s) => s?.tipo === 'trigger');
  return trigger?.config?.type || null;
}

function sanitizeTemplateKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sanitizeTemplateReference(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseIntOrNull(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function stripClinicScopeSuffixes(value) {
  const normalized = sanitizeTemplateKey(value);
  if (!normalized) return null;
  return normalized.replace(/(?:_+clinic_\d+)+$/g, '') || null;
}

function normalizeCatalogSourceTemplateKey(catalogFlowId, sourceTemplateKey) {
  return stripClinicScopeSuffixes(sourceTemplateKey) || sanitizeTemplateKey(`catalog_${catalogFlowId}`);
}

function buildCatalogTemplateKey(catalogFlowId, sourceTemplateKey, clinicId) {
  const suffix = `__clinic_${clinicId}`;
  const base = normalizeCatalogSourceTemplateKey(catalogFlowId, sourceTemplateKey);
  const room = Math.max(1, MAX_TEMPLATE_KEY_LENGTH - suffix.length);
  return `${base.slice(0, room)}${suffix}`;
}

function buildPublicId() {
  return `flw_${crypto.randomBytes(8).toString('hex')}`;
}

function cloneJson(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function getNodesArray(templateOrNodes) {
  const raw = Array.isArray(templateOrNodes)
    ? templateOrNodes
    : templateOrNodes?.nodes;
  return Array.isArray(raw) ? raw : [];
}

function mergeLocalReviewConfigIntoCatalogNodes(sourceNodes, latestPublishedTemplate) {
  const nodes = cloneJson(sourceNodes) || [];
  const localNodes = getNodesArray(latestPublishedTemplate);
  if (!nodes.length || !localNodes.length) return nodes;

  const localById = new Map(localNodes.map((node) => [String(node?.id || ''), node]));
  const localByType = new Map();
  localNodes.forEach((node) => {
    const type = String(node?.type || '');
    if (type && !localByType.has(type)) {
      localByType.set(type, node);
    }
  });

  const preserveByType = {
    'action/request_review': [
      'whatsapp_template_id',
      'template_name',
      'review_gift_enabled',
      'review_gift_description',
      'review_display_clinic_name',
      'review_team_photo_url',
    ],
  };

  return nodes.map((node) => {
    const type = String(node?.type || '');
    const preserveKeys = preserveByType[type];
    if (!preserveKeys?.length) return node;

    const localNode = localById.get(String(node?.id || '')) || localByType.get(type);
    const localConfig = localNode?.config && typeof localNode.config === 'object'
      ? localNode.config
      : null;
    if (!localConfig) return node;

    const config = { ...(node.config || {}) };
    preserveKeys.forEach((key) => {
      if (localConfig[key] !== undefined) {
        config[key] = cloneJson(localConfig[key]);
      }
    });
    return { ...node, config };
  });
}

async function generateUniquePublicId() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = buildPublicId();
    const existing = await AutomationFlowTemplateV2.findOne({
      where: { public_id: candidate },
      attributes: ['id'],
      raw: true,
    });
    if (!existing) return candidate;
  }
  throw new Error('public_id_generation_failed');
}

async function publishClinicTemplateVersion({ row, actorUserId = null, transaction, isActive = true }) {
  const normalizedPublicId = sanitizeTemplateReference(row?.public_id);
  const familyWhere = normalizedPublicId
    ? { public_id: normalizedPublicId }
    : { template_key: row.template_key };

  await AutomationFlowTemplateV2.update(
    { is_active: false },
    {
      where: {
        ...familyWhere,
        published_at: { [Op.ne]: null },
        id: { [Op.ne]: row.id },
      },
      transaction,
    }
  );

  await row.update({
    published_at: new Date(),
    published_by: actorUserId || row.published_by || row.created_by || 1,
    is_active: isActive !== false,
  }, { transaction });
}

async function backfillScheduledTriggersForPublishedTemplate(row, { actorUserId = null } = {}) {
  const triggerType = String(row?.trigger_type || '').trim();
  if (!['appointment_reminder_window', 'appointment_after'].includes(triggerType)) {
    return null;
  }

  try {
    // Lazy require: the runtime imports this service indirectly through normal appointment flows.
    const appointmentAutomationV2Runtime = require('./appointmentAutomationV2Runtime.service');
    return await appointmentAutomationV2Runtime.backfillScheduledTriggersForTemplate(row, {
      user_id: actorUserId || row?.published_by || row?.created_by || null,
      user_role: 'system',
      user_name: 'Catalog propagation',
      limit: 5000,
    });
  } catch (err) {
    console.error('Error backfilling scheduled automation after catalog propagation', {
      template_key: row?.template_key,
      version: row?.version,
      error: err?.message || String(err),
    });
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}

function getCatalogSourceScopeScore(template) {
  const clinicId = parseIntOrNull(template?.clinic_id);
  const groupId = parseIntOrNull(template?.group_id);
  if (!clinicId && !groupId) return 100;
  if (!clinicId && groupId) return 50;
  return 0;
}

async function resolveLinkedTemplateForCatalog(catalogFlow) {
  const rawReference = String(catalogFlow?.template_key || '').trim();
  if (!rawReference) return null;

  const normalizedRef = sanitizeTemplateReference(rawReference);
  if (!normalizedRef) return null;

  const byPublicId = await AutomationFlowTemplateV2.findOne({
    where: { public_id: normalizedRef },
    attributes: ['id'],
    raw: true,
  });

  const familyWhere = byPublicId
    ? { public_id: normalizedRef }
    : { template_key: sanitizeTemplateKey(normalizedRef) };

  const version = parseIntOrNull(catalogFlow?.template_version);
  const where = { ...familyWhere };
  if (version) {
    where.version = version;
  }

  const candidates = await AutomationFlowTemplateV2.findAll({
    where,
    order: [['version', 'DESC'], ['id', 'DESC']],
  });

  if (!Array.isArray(candidates) || !candidates.length) {
    return null;
  }

  return [...candidates].sort((a, b) => {
    const scopeDiff = getCatalogSourceScopeScore(b) - getCatalogSourceScopeScore(a);
    if (scopeDiff) return scopeDiff;
    const versionDiff = Number(b?.version || 0) - Number(a?.version || 0);
    if (versionDiff) return versionDiff;
    return Number(b?.id || 0) - Number(a?.id || 0);
  })[0] || null;
}

async function repairClinicDraftFamily({ clinicId, expectedTemplateKey, sourcePublicId }) {
  const normalizedClinicId = parseIntOrNull(clinicId);
  const normalizedExpectedKey = sanitizeTemplateKey(expectedTemplateKey);
  const normalizedSourcePublicId = sanitizeTemplateReference(sourcePublicId);
  if (!normalizedClinicId || !normalizedExpectedKey) {
    return;
  }

  const expectedBaseKey = stripClinicScopeSuffixes(normalizedExpectedKey);
  const legacyKeyCandidates = Array.from(
    new Set(
      [
        expectedBaseKey ? `${expectedBaseKey}_clinic_${normalizedClinicId}` : null,
        expectedBaseKey ? `${expectedBaseKey}__clinic_${normalizedClinicId}` : null,
      ]
        .map((value) => sanitizeTemplateKey(value))
        .filter((value) => value && value !== normalizedExpectedKey)
    )
  );

  const expectedFamilyRows = await AutomationFlowTemplateV2.findAll({
    where: {
      clinic_id: normalizedClinicId,
      template_key: normalizedExpectedKey,
    },
    attributes: ['id'],
    raw: true,
  });

  const currentFamilyRows = await AutomationFlowTemplateV2.findAll({
    where: {
      clinic_id: normalizedClinicId,
      template_key: normalizedExpectedKey,
      published_at: null,
    },
    attributes: ['id', 'public_id'],
    raw: true,
  });

  const legacyConditions = [];
  if (normalizedSourcePublicId) {
    legacyConditions.push({ public_id: normalizedSourcePublicId });
  }
  if (legacyKeyCandidates.length) {
    legacyConditions.push({ template_key: { [Op.in]: legacyKeyCandidates } });
  }

  if (!legacyConditions.length && !currentFamilyRows.length) {
    return;
  }

  const legacyRows = legacyConditions.length
    ? await AutomationFlowTemplateV2.findAll({
        where: {
          clinic_id: normalizedClinicId,
          published_at: null,
          template_key: { [Op.ne]: normalizedExpectedKey },
          [Op.or]: legacyConditions,
        },
        attributes: ['id', 'template_key'],
        raw: true,
      })
    : [];

  const currentFamilyNeedsIsolation = currentFamilyRows.some(
    (row) => sanitizeTemplateReference(row?.public_id) === normalizedSourcePublicId
  );

  if (!currentFamilyRows.length && !legacyRows.length) {
    return;
  }

  if (expectedFamilyRows.length && legacyRows.length) {
    await AutomationFlowTemplateV2.destroy({
      where: {
        id: { [Op.in]: legacyRows.map((row) => row.id) },
      },
    });
    return;
  }

  const isolatedPublicId = await generateUniquePublicId();

  if (currentFamilyRows.length) {
    if (currentFamilyNeedsIsolation) {
      await AutomationFlowTemplateV2.update(
        { public_id: isolatedPublicId },
        {
          where: {
            id: { [Op.in]: currentFamilyRows.map((row) => row.id) },
          },
        }
      );
    }

    if (legacyRows.length) {
      await AutomationFlowTemplateV2.destroy({
        where: {
          id: { [Op.in]: legacyRows.map((row) => row.id) },
        },
      });
    }
    return;
  }

  await AutomationFlowTemplateV2.update(
    {
      template_key: normalizedExpectedKey,
      public_id: isolatedPublicId,
    },
    {
      where: {
        id: { [Op.in]: legacyRows.map((row) => row.id) },
      },
    }
  );
}

async function ensureCatalogTemplateForClinic({ clinicId, catalogFlow, actorUserId = null }) {
  const clinicScope = await resolveClinicScope(clinicId);
  if (!clinicScope) {
    return { status: 'failed', reason: 'clinic_not_found' };
  }

  const linkedTemplate = await resolveLinkedTemplateForCatalog(catalogFlow);
  if (!linkedTemplate) {
    return { status: 'failed', reason: 'linked_template_not_found' };
  }

  const templateKey = buildCatalogTemplateKey(catalogFlow.id, linkedTemplate.template_key, clinicId);
  await repairClinicDraftFamily({
    clinicId: clinicScope.clinic_id,
    expectedTemplateKey: templateKey,
    sourcePublicId: linkedTemplate.public_id,
  });
  const latest = await AutomationFlowTemplateV2.findOne({
    where: { template_key: templateKey },
    order: [['version', 'DESC']],
  });
  const familyExists = !!latest;
  let existingDraft = await AutomationFlowTemplateV2.findOne({
    where: { template_key: templateKey, published_at: null },
    order: [['version', 'DESC']],
  });
  const latestPublished = await AutomationFlowTemplateV2.findOne({
    where: {
      template_key: templateKey,
      published_at: { [Op.ne]: null },
    },
    order: [['version', 'DESC']],
  });
  if (
    existingDraft &&
    latestPublished &&
    Number(existingDraft.version || 0) <= Number(latestPublished.version || 0)
  ) {
    await existingDraft.destroy();
    existingDraft = null;
  }

  const targetActive = latestPublished
    ? latestPublished.is_active !== false
    : true;
  const nodes = mergeLocalReviewConfigIntoCatalogNodes(linkedTemplate.nodes, latestPublished);

  const payload = {
    engine_version: 'v2',
    name: catalogFlow.display_name || linkedTemplate.name,
    description: catalogFlow.description || linkedTemplate.description || null,
    trigger_type: linkedTemplate.trigger_type,
    is_active: false,
    is_system: false,
    clinic_id: clinicScope.clinic_id,
    group_id: clinicScope.group_id,
    entry_node_id: linkedTemplate.entry_node_id,
    nodes,
    trigger_config: linkedTemplate.trigger_config ?? null,
    published_at: null,
    published_by: null,
    created_by: actorUserId || linkedTemplate.created_by || 1,
  };

  if (existingDraft) {
    await db.sequelize.transaction(async (transaction) => {
      await existingDraft.update(payload, { transaction });
      await publishClinicTemplateVersion({
        row: existingDraft,
        actorUserId,
        transaction,
        isActive: targetActive,
      });
    });
    const scheduledBackfill = await backfillScheduledTriggersForPublishedTemplate(existingDraft, { actorUserId });
    return {
      status: familyExists ? 'updated' : 'created',
      template_key: existingDraft.template_key,
      version: existingDraft.version,
      scheduled_backfill: scheduledBackfill,
    };
  }

  const version = latest?.version ? Number(latest.version) + 1 : 1;
  const created = await db.sequelize.transaction(async (transaction) => {
    const row = await AutomationFlowTemplateV2.create({
      public_id: latest?.public_id || await generateUniquePublicId(),
      template_key: templateKey,
      version,
      ...payload,
    }, { transaction });

    await publishClinicTemplateVersion({
      row,
      actorUserId,
      transaction,
      isActive: targetActive,
    });

    return row;
  });

  const scheduledBackfill = await backfillScheduledTriggersForPublishedTemplate(created, { actorUserId });
  return {
    status: familyExists ? 'updated' : 'created',
    template_key: created.template_key,
    version: created.version,
    scheduled_backfill: scheduledBackfill,
  };
}

async function createDefaultAutomationsForClinic({ clinicId }) {
  if (!clinicId) return { automations: 0, templates: 0 };

  const disciplinas = await resolveClinicDisciplines(clinicId);
  const catalogFlows = await selectAutomationCatalogByDisciplines(disciplinas);

  let createdCount = 0;
  let updatedCount = 0;
  for (const flow of catalogFlows) {
    const result = await ensureCatalogTemplateForClinic({ clinicId, catalogFlow: flow });
    if (result.status === 'created') createdCount += 1;
    if (result.status === 'updated') updatedCount += 1;
  }

  // Crear placeholders de plantillas (SIN_CONECTAR)
  const placeholders = await whatsappTemplatesService.createPlaceholderTemplatesForClinic({
    clinicId,
    assignmentScope: 'clinic',
    groupId: null,
  });

  return { automations: createdCount, updated_automations: updatedCount, templates: placeholders.length };
}

async function propagateCatalogAutomationToClinics({ catalogId, actorUserId = null }) {
  const item = await AutomationFlowCatalog.findByPk(catalogId, {
    include: [{ model: AutomationFlowCatalogDiscipline, as: 'disciplinas' }],
  });
  if (!item) {
    return { success: false, error: 'catalog_not_found' };
  }

  const disciplineCodes = Array.isArray(item.disciplinas)
    ? item.disciplinas.map((d) => d.disciplina_code).filter(Boolean)
    : [];
  const clinics = await Clinica.findAll({
    attributes: ['id_clinica', 'configuracion'],
    raw: true,
  });

  const eligibleClinics = clinics.filter((clinic) => {
    if (item.is_generic) return true;
    const clinicDisciplines = normalizeDisciplines(clinic?.configuracion?.disciplinas);
    const normalizedClinicDisciplines = clinicDisciplines.length ? clinicDisciplines : ['dental'];
    return disciplineCodes.some((code) => normalizedClinicDisciplines.includes(code));
  });

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const clinic of eligibleClinics) {
    const result = await ensureCatalogTemplateForClinic({
      clinicId: clinic.id_clinica,
      catalogFlow: item,
      actorUserId,
    });
    if (result.status === 'created') created += 1;
    else if (result.status === 'updated') updated += 1;
    else if (result.status === 'failed') failed += 1;
  }

  return {
    success: true,
    catalog_id: item.id,
    created,
    updated,
    failed,
    clinics_total: eligibleClinics.length,
  };
}

async function enqueueDefaultAutomations(data) {
  return queues.automationDefaults.add('create', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 },
    removeOnComplete: true,
    removeOnFail: false,
  });
}

module.exports = {
  createDefaultAutomationsForClinic,
  ensureCatalogTemplateForClinic,
  enqueueDefaultAutomations,
  propagateCatalogAutomationToClinics,
};
