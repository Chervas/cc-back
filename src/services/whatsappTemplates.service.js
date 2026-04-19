'use strict';

const axios = require('axios');
const { Op } = require('sequelize');
const db = require('../../models');
const { queues } = require('./queue.service');
const { recomposeAutomationsUsingTemplate } = require('./whatsappTemplateAutomationSync.service');

const {
  ClinicMetaAsset,
  Clinica,
  WhatsappTemplate,
  WhatsappTemplateCatalog,
  WhatsappTemplateCatalogDiscipline,
} = db;

const META_GRAPH_BASE = process.env.META_GRAPH_BASE_URL || process.env.META_API_BASE_URL || 'https://graph.facebook.com';
const META_API_VERSION = process.env.META_API_VERSION || 'v24.0';
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

function stringifyTemplateComponents(value) {
  return JSON.stringify(parseMaybeJson(value) || []);
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasSameMetaFacingContent(template, instance) {
  if (!template || !instance) return false;
  return (
    String(template.category || '').trim().toUpperCase() === String(instance.category || '').trim().toUpperCase()
    && stringifyTemplateComponents(template.components) === stringifyTemplateComponents(instance.components)
  );
}

function hasSameMetaFacingContract(template, instance) {
  if (!template || !instance) return false;
  return (
    String(template.name || '').trim() === String(instance.name || '').trim()
    && hasSameMetaFacingContent(template, instance)
  );
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
  const candidates = await WhatsappTemplate.findAll({
    where: {
      clinic_id: clinicId,
      waba_id: null,
      language: DEFAULT_LANGUAGE,
      is_active: true,
      [Op.or]: [
        ...(Number.isFinite(Number(template.id)) && Number(template.id) > 0
          ? [{ catalog_template_id: Number(template.id) }]
          : []),
        { name: template.name },
        { name: { [Op.like]: `${template.name}%` } },
      ],
    },
    order: [['updatedAt', 'DESC']],
  });

  return candidates.find((row) => {
    const catalogId = Number(row?.catalog_template_id);
    if (Number.isFinite(catalogId) && catalogId > 0 && catalogId === Number(template.id)) {
      return true;
    }
    return isTechnicalTemplateFamilyName(template.name, row?.name);
  }) || null;
}

async function loadTemplateFamilyRows({ clinicId, wabaId, template }) {
  if (!template) return [];
  const rows = await WhatsappTemplate.findAll({
    where: {
      language: DEFAULT_LANGUAGE,
      is_active: true,
      [Op.or]: [
        ...(Number.isFinite(Number(template.id)) && Number(template.id) > 0
          ? [{ catalog_template_id: Number(template.id) }]
          : []),
        ...(wabaId
          ? [{
              waba_id: String(wabaId),
              name: { [Op.like]: `${template.name}%` },
            }]
          : []),
        ...(clinicId
          ? [{
              clinic_id: clinicId,
              waba_id: null,
              name: { [Op.like]: `${template.name}%` },
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
    return isTechnicalTemplateFamilyName(template.name, row?.name);
  });
}

function findSameContractRemoteTemplate({ familyRows, wabaId, template }) {
  const safeWabaId = wabaId ? String(wabaId) : '';
  return familyRows.find((row) => String(row?.waba_id || '') === safeWabaId && hasSameMetaFacingContent(template, row)) || null;
}

function buildTemplateForTechnicalName(template, technicalName) {
  const baseTemplate = template?.toJSON ? template.toJSON() : template;
  return {
    ...baseTemplate,
    name: cleanString(technicalName) || cleanString(baseTemplate?.name),
  };
}

function resolveCatalogTemplateByTechnicalName(catalogs, technicalName) {
  const safeTechnicalName = cleanString(technicalName);
  if (!safeTechnicalName || !Array.isArray(catalogs) || !catalogs.length) return null;
  const matches = catalogs.filter((catalog) => isTechnicalTemplateFamilyName(catalog?.name, safeTechnicalName));
  if (!matches.length) return null;
  matches.sort((left, right) => String(right?.name || '').length - String(left?.name || '').length);
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
  const status = err?.response?.status;
  if (status && (status >= 500 || status === 429)) {
    return true;
  }
  return false;
}

function parseMetaError(err) {
  const base = err?.response?.data || err?.message || err;
  const nestedError = base?.error?.error || base?.error || base;
  const code = nestedError?.code || null;
  const message = nestedError?.message || String(base?.message || base || '');
  return { code, message, raw: base };
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
    const existing = await WhatsappTemplate.findOne({
      where: {
        clinic_id: clinicId,
        name: template.name,
        language: DEFAULT_LANGUAGE,
        status: 'SIN_CONECTAR',
      },
    });
    if (existing) continue;

    const row = await WhatsappTemplate.create({
      clinic_id: clinicId,
      waba_id: null,
      name: template.name,
      language: DEFAULT_LANGUAGE,
      category: template.category,
      status: 'SIN_CONECTAR',
      components: parseMaybeJson(template.components),
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
    name: template.name,
    language: DEFAULT_LANGUAGE,
    category: template.category,
    status: 'SIN_CONECTAR',
    components: parseMaybeJson(template.components),
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
    name: cleanString(technicalName) || template.name,
    language: DEFAULT_LANGUAGE,
    category: template.category,
    status,
    components: parseMaybeJson(template.components),
    catalog_template_id: template.id,
    origin: 'catalog',
    is_active: !!template.is_active,
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

  const safeTechnicalName = cleanString(technicalName) || cleanString(template.name);
  const payload = {
    waba_id: String(wabaId),
    clinic_id: null,
    name: safeTechnicalName,
    language: DEFAULT_LANGUAGE,
    category: template.category,
    status,
    components: parseMaybeJson(template.components),
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
      language: DEFAULT_LANGUAGE,
    },
    order: [['updatedAt', 'DESC']],
  });

  if (existing) {
    await existing.update(payload);
    return { action: 'updated', row: existing };
  }

  const row = await WhatsappTemplate.create(payload);
  return { action: 'created', row };
}

function buildLocalPendingReasonFromMetaError(err) {
  const parsed = parseMetaError(err);
  const detail = String(parsed?.message || '').trim();
  const code = parsed?.code ? ` [${parsed.code}]` : '';
  if (!detail) {
    return `Meta no ha aceptado abrir una revisión nueva para esta plantilla${code}.`;
  }
  return `Meta no ha aceptado abrir una revisión nueva para esta plantilla${code}: ${detail}`;
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
    },
    order: [['updatedAt', 'DESC']],
  });
}

async function createTemplateInMeta({ wabaId, accessToken, template, language }) {
  const components = parseMaybeJson(template.components);
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

async function createTemplatesFromCatalog({ wabaId, clinicId, groupId, assignmentScope }) {
  if (!wabaId) return;

  const asset = await resolveWabaAssetById(wabaId);
  if (!asset?.waAccessToken) {
    throw new Error('missing_wa_access_token');
  }

  const disciplinas = await resolveDisciplines({
    clinicId: assignmentScope === 'clinic' ? clinicId : null,
    groupId: assignmentScope === 'group' ? groupId : null,
  });

  const templates = await selectCatalogTemplatesByDisciplines(disciplinas);

  for (const template of templates) {
    const existing = await WhatsappTemplate.findOne({
      where: {
        waba_id: wabaId,
        name: template.name,
        language: DEFAULT_LANGUAGE,
      },
    });
    if (existing) {
      if (clinicId) {
        await upsertClinicOverrideTemplateForClinic({
          clinicId,
          template,
          technicalName: existing.name,
          status: mapRemoteStatusToLocalStatus(existing.status),
          metaTemplateId: existing.meta_template_id || null,
          rejectionReason: existing.rejection_reason || null,
        });
      }
      continue;
    }

    try {
      const metaResp = await createTemplateInMeta({
        wabaId,
        accessToken: asset.waAccessToken,
        template,
        language: DEFAULT_LANGUAGE,
      });

      await upsertConnectedTemplateForWaba({
        wabaId,
        template,
        technicalName: template.name,
        status: WHATSAPP_TEMPLATE_STATUS.PENDING,
        metaTemplateId: metaResp?.id || null,
        rejectionReason: null,
      });

      if (clinicId) {
        await upsertClinicOverrideTemplateForClinic({
          clinicId,
          template,
          technicalName: template.name,
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
            technicalName: template.name,
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
        name: template.name,
        error: err?.response?.data || err.message,
      });
    }
  }
}

async function propagateCatalogTemplateToAllClinics({ templateCatalogId, logger = console, sourceUpdatedAt = null }) {
  const template = await getCatalogTemplateById(templateCatalogId);
  if (!template) {
    throw new Error('catalog_not_found');
  }

  const sourceUpdatedAtTs = sourceUpdatedAt ? new Date(sourceUpdatedAt).getTime() : null;
  const canMarkCompleted = async () => {
    if (!Number.isFinite(sourceUpdatedAtTs)) return true;
    await template.reload();
    const currentUpdatedAtTs = new Date(template.updated_at || template.updatedAt || 0).getTime();
    return Number.isFinite(currentUpdatedAtTs) && currentUpdatedAtTs <= sourceUpdatedAtTs;
  };

  try {
    const clinics = await Clinica.findAll({
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
      let pendingTechnicalName = cleanString(template.name);

      if (!templateAppliesToDisciplines(template, effectiveDisciplines)) {
        summary.skipped_not_applicable += 1;
        continue;
      }

      summary.clinics_targeted += 1;

      try {
        const clinicConfig = await whatsappService.getClinicConfig(clinicId);
        const wabaId = clinicConfig?.wabaId ? String(clinicConfig.wabaId) : null;
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
          ? resolveNextTechnicalTemplateName(template.name, familyRows)
          : template.name;
        pendingTechnicalName = cleanString(technicalName) || pendingTechnicalName;
        const metaTemplate = buildTemplateForTechnicalName(template, technicalName);

        const metaResp = await createTemplateInMeta({
          wabaId,
          accessToken: clinicConfig.accessToken,
          template: metaTemplate,
          language: DEFAULT_LANGUAGE,
        });

        await upsertConnectedTemplateForWaba({
          wabaId,
          template,
          technicalName,
          status: WHATSAPP_TEMPLATE_STATUS.PENDING,
          metaTemplateId: metaResp?.id || null,
          rejectionReason: null,
        });

        const result = await upsertClinicOverrideTemplateForClinic({
          clinicId,
          template,
          technicalName,
          status: WHATSAPP_TEMPLATE_STATUS.PENDING,
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

        summary.created_in_meta += 1;
      } catch (err) {
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

    if (followupSyncs.size > 0) {
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

    if (summary.errors.length === 0) {
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
    await template.update({
      propagation_state: 'failed',
    });
    throw err;
  }
}

async function syncTemplatesForWaba({ wabaId, accessToken }) {
  if (!wabaId || !accessToken) {
    throw new Error('missing_waba_or_token');
  }

  const response = await axios.get(graphUrl(`${wabaId}/message_templates`), {
    params: { access_token: accessToken, limit: 200 },
  });
  const items = response.data?.data || [];
  const now = new Date();
  const catalogs = await WhatsappTemplateCatalog.findAll({
    attributes: ['id', 'name'],
    raw: true,
  });
  const catalogById = new Map(
    catalogs.map((catalog) => [Number(catalog.id), catalog]),
  );

  for (const tpl of items) {
    const catalog = resolveCatalogTemplateByTechnicalName(catalogs, tpl.name);
    const payload = {
      waba_id: wabaId,
      name: tpl.name,
      language: tpl.language || DEFAULT_LANGUAGE,
      category: tpl.category || null,
      status: tpl.status || null,
      rejection_reason: tpl.rejected_reason || tpl.rejection_reason || null,
      components: tpl.components || null,
      meta_template_id: tpl.id || null,
      catalog_template_id: catalog?.id || null,
      origin: 'external',
      is_active: true,
      last_synced_at: now,
    };

    const existing = await WhatsappTemplate.findOne({
      where: { waba_id: wabaId, name: payload.name, language: payload.language },
    });
    if (existing) {
      await existing.update(payload);
    } else {
      await WhatsappTemplate.create(payload);
    }
  }

  const linkedAssets = await ClinicMetaAsset.findAll({
    where: {
      isActive: true,
      wabaId,
      assetType: { [Op.in]: ['whatsapp_business_account', 'whatsapp_phone_number'] },
    },
    attributes: ['clinicaId', 'grupoClinicaId'],
    raw: true,
  });

  const clinicIds = new Set();
  const groupIds = new Set();
  linkedAssets.forEach((asset) => {
    if (asset.clinicaId) clinicIds.add(Number(asset.clinicaId));
    if (asset.grupoClinicaId) groupIds.add(Number(asset.grupoClinicaId));
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
  if (!clinicIdList.length) return;

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

    const overrideComponents = JSON.stringify(parseMaybeJson(override.components) || []);
    const remoteComponents = JSON.stringify(parseMaybeJson(remote.components) || []);
    const sameComponents = overrideComponents === remoteComponents;
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

    await override.update({
      status: nextStatus,
      meta_template_id: nextMetaTemplateId,
      rejection_reason: nextRejectionReason,
      last_synced_at: now,
    });
  }
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

  return queues.whatsappTemplateSync.add('sync', data, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 60000 },
    ...(delayMs > 0 ? { delay: delayMs } : {}),
    ...(jobId ? { jobId } : {}),
    removeOnComplete: true,
    removeOnFail: false,
  });
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
    targetWabaIds = pendingRows
      .map((row) => String(row?.waba_id || '').trim())
      .filter(Boolean);
    if (!targetWabaIds.length) {
      return { queued: 0, only_pending: true };
    }
  }

  const assets = await ClinicMetaAsset.findAll({
    where: {
      isActive: true,
      assetType: 'whatsapp_business_account',
      wabaId: targetWabaIds ? { [Op.in]: targetWabaIds } : { [Op.ne]: null },
    },
    attributes: ['wabaId', 'waAccessToken'],
    raw: true,
  });

  let queued = 0;
  for (const asset of assets) {
    if (!asset.wabaId || !asset.waAccessToken) continue;
    await enqueueSyncTemplatesJob({ wabaId: asset.wabaId, accessToken: asset.waAccessToken });
    queued += 1;
  }

  return { queued, only_pending: onlyPending };
}

module.exports = {
  createTemplatesFromCatalog,
  createPlaceholderTemplatesForClinic,
  propagateCatalogTemplateToAllClinics,
  syncTemplatesForWaba,
  enqueueCreateTemplatesJob,
  enqueuePropagateCatalogTemplateJob,
  enqueueSyncTemplatesJob,
  enqueueSyncForAllWabas,
  upsertClinicOverrideTemplateForClinic,
};
