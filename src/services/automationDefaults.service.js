'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { queues } = require('./queue.service');
const whatsappTemplatesService = require('./whatsappTemplates.service');

const {
  Clinica,
  AutomationFlow,
  AutomationFlowCatalog,
  AutomationFlowCatalogDiscipline,
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

async function createDefaultAutomationsForClinic({ clinicId }) {
  if (!clinicId) return { automations: 0, templates: 0 };

  const disciplinas = await resolveClinicDisciplines(clinicId);
  const catalogFlows = await selectAutomationCatalogByDisciplines(disciplinas);

  let createdCount = 0;
  for (const flow of catalogFlows) {
    const existing = await AutomationFlow.findOne({
      where: {
        clinica_id: clinicId,
        catalog_flow_id: flow.id,
      },
    });
    if (existing) continue;

    const pasos = flow.steps || [];
    const disparador = resolveTriggerFromSteps(pasos) || flow.trigger_type || 'custom';

    await AutomationFlow.create({
      nombre: flow.display_name || flow.name,
      descripcion: flow.description || null,
      clinica_id: clinicId,
      estado: 'borrador',
      pasos,
      disparador,
      acciones: pasos,
      activo: false,
      catalog_flow_id: flow.id,
      origin: 'catalog',
    });
    createdCount += 1;
  }

  // Crear placeholders de plantillas (SIN_CONECTAR)
  const placeholders = await whatsappTemplatesService.createPlaceholderTemplatesForClinic({
    clinicId,
    assignmentScope: 'clinic',
    groupId: null,
  });

  return { automations: createdCount, templates: placeholders.length };
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
};
