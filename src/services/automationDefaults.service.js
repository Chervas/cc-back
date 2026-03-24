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

function buildCatalogTemplateKey(catalogFlowId, sourceTemplateKey, clinicId) {
  const base = sanitizeTemplateKey(sourceTemplateKey || `catalog_${catalogFlowId}`);
  return `${base}__clinic_${clinicId}`;
}

function buildPublicId() {
  return `flw_${crypto.randomBytes(8).toString('hex')}`;
}

async function resolveLinkedTemplateForCatalog(catalogFlow) {
  const templateKey = String(catalogFlow?.template_key || '').trim();

  if (!templateKey) return null;

  return AutomationFlowTemplateV2.findOne({
    where: {
      template_key: templateKey,
      published_at: { [Op.ne]: null },
      is_active: true,
    },
    order: [['version', 'DESC'], ['id', 'DESC']],
  });
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
  const latest = await AutomationFlowTemplateV2.findOne({
    where: { template_key: templateKey },
    order: [['version', 'DESC']],
  });
  const existingDraft = await AutomationFlowTemplateV2.findOne({
    where: { template_key: templateKey, published_at: null },
    order: [['version', 'DESC']],
  });

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
    nodes: linkedTemplate.nodes,
    published_at: null,
    published_by: null,
    created_by: actorUserId || linkedTemplate.created_by || 1,
  };

  if (existingDraft) {
    await existingDraft.update(payload);
    return {
      status: 'updated',
      template_key: existingDraft.template_key,
      version: existingDraft.version,
    };
  }

  const version = latest?.version ? Number(latest.version) + 1 : 1;
  const created = await AutomationFlowTemplateV2.create({
    public_id: latest?.public_id || linkedTemplate.public_id || buildPublicId(),
    template_key: templateKey,
    version,
    ...payload,
  });

  return {
    status: 'created',
    template_key: created.template_key,
    version: created.version,
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
  enqueueDefaultAutomations,
  propagateCatalogAutomationToClinics,
};
