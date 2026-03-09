'use strict';

const axios = require('axios');
const { Op } = require('sequelize');
const db = require('../../models');
const { queues } = require('./queue.service');

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

  const existing = await WhatsappTemplate.findOne({
    where: {
      clinic_id: clinicId,
      waba_id: null,
      name: template.name,
      language: DEFAULT_LANGUAGE,
    },
    order: [['updatedAt', 'DESC']],
  });

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
  };

  if (existing) {
    await existing.update(payload);
    return { action: 'updated', row: existing };
  }

  const row = await WhatsappTemplate.create(payload);
  return { action: 'created', row };
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
    name: template.name,
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
      continue;
    }

    try {
      const metaResp = await createTemplateInMeta({
        wabaId,
        accessToken: asset.waAccessToken,
        template,
        language: DEFAULT_LANGUAGE,
      });

      const placeholder = clinicId
        ? await WhatsappTemplate.findOne({
            where: {
              clinic_id: clinicId,
              waba_id: null,
              name: template.name,
              language: DEFAULT_LANGUAGE,
              status: 'SIN_CONECTAR',
            },
          })
        : null;

      if (placeholder) {
        await placeholder.update({
          waba_id: wabaId,
          status: 'PENDING',
          components: parseMaybeJson(template.components),
          meta_template_id: metaResp?.id || null,
          catalog_template_id: template.id,
          origin: 'catalog',
          is_active: true,
        });
        continue;
      }

      await WhatsappTemplate.create({
        waba_id: wabaId,
        clinic_id: clinicId || null,
        name: template.name,
        language: DEFAULT_LANGUAGE,
        category: template.category,
        status: 'PENDING',
        components: parseMaybeJson(template.components),
        meta_template_id: metaResp?.id || null,
        catalog_template_id: template.id,
        origin: 'catalog',
        is_active: true,
      });
    } catch (err) {
      if (isRetryableMetaError(err)) {
        throw err;
      }
      console.error('Error creando plantilla en Meta', {
        wabaId,
        name: template.name,
        error: err?.response?.data || err.message,
      });
    }
  }
}

async function propagateCatalogTemplateToAllClinics({ templateCatalogId, logger = console }) {
  const template = await getCatalogTemplateById(templateCatalogId);
  if (!template) {
    throw new Error('catalog_not_found');
  }

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

  for (const clinic of clinics) {
    const clinicId = Number(clinic.id_clinica);
    const clinicDisciplines = normalizeDisciplines(clinic?.configuracion?.disciplinas);
    const effectiveDisciplines = clinicDisciplines.length ? clinicDisciplines : ['dental'];

    if (!templateAppliesToDisciplines(template, effectiveDisciplines)) {
      summary.skipped_not_applicable += 1;
      continue;
    }

    summary.clinics_targeted += 1;

    try {
      const clinicConfig = await whatsappService.getClinicConfig(clinicId);
      const placeholder = await WhatsappTemplate.findOne({
        where: {
          clinic_id: clinicId,
          waba_id: null,
          name: template.name,
          language: DEFAULT_LANGUAGE,
        },
        order: [['updatedAt', 'DESC']],
      });

      const wabaId = clinicConfig?.wabaId ? String(clinicConfig.wabaId) : null;
      if (!wabaId) {
        const result = await upsertPlaceholderTemplateForClinic({ clinicId, template });
        if (result.action === 'created') summary.placeholders_created += 1;
        if (result.action === 'updated') summary.placeholders_updated += 1;
        continue;
      }

      const existingWabaTemplate = await WhatsappTemplate.findOne({
        where: {
          waba_id: wabaId,
          name: template.name,
          language: DEFAULT_LANGUAGE,
        },
        order: [['updatedAt', 'DESC']],
      });

      if (existingWabaTemplate) {
        await existingWabaTemplate.update({
          category: template.category,
          components: parseMaybeJson(template.components),
          catalog_template_id: template.id,
          origin: 'catalog',
          is_active: !!template.is_active,
        });
        summary.waba_templates_updated += 1;

        if (placeholder?.is_active) {
          await placeholder.update({ is_active: false });
          summary.placeholders_deactivated += 1;
        }
        continue;
      }

      if (!syncedWabas.has(wabaId) && clinicConfig.accessToken) {
        await syncTemplatesForWaba({ wabaId, accessToken: clinicConfig.accessToken });
        syncedWabas.add(wabaId);

        const syncedTemplate = await WhatsappTemplate.findOne({
          where: {
            waba_id: wabaId,
            name: template.name,
            language: DEFAULT_LANGUAGE,
          },
          order: [['updatedAt', 'DESC']],
        });

        if (syncedTemplate) {
          await syncedTemplate.update({
            category: template.category,
            components: parseMaybeJson(template.components),
            catalog_template_id: template.id,
            origin: 'catalog',
            is_active: !!template.is_active,
          });
          summary.waba_templates_updated += 1;

          if (placeholder?.is_active) {
            await placeholder.update({ is_active: false });
            summary.placeholders_deactivated += 1;
          }
          continue;
        }
      }

      if (!template.is_active) {
        const result = await upsertPlaceholderTemplateForClinic({ clinicId, template });
        if (result.action === 'created') summary.placeholders_created += 1;
        if (result.action === 'updated') summary.placeholders_updated += 1;
        continue;
      }

      const metaResp = await createTemplateInMeta({
        wabaId,
        accessToken: clinicConfig.accessToken,
        template,
        language: DEFAULT_LANGUAGE,
      });

      if (placeholder) {
        await placeholder.update({
          waba_id: wabaId,
          status: 'PENDING',
          components: parseMaybeJson(template.components),
          meta_template_id: metaResp?.id || null,
          catalog_template_id: template.id,
          origin: 'catalog',
          is_active: !!template.is_active,
        });
        summary.placeholders_updated += 1;
      } else {
        await WhatsappTemplate.create({
          waba_id: wabaId,
          clinic_id: clinicId,
          name: template.name,
          language: DEFAULT_LANGUAGE,
          category: template.category,
          status: 'PENDING',
          components: parseMaybeJson(template.components),
          meta_template_id: metaResp?.id || null,
          catalog_template_id: template.id,
          origin: 'catalog',
          is_active: !!template.is_active,
        });
      }

      summary.created_in_meta += 1;
    } catch (err) {
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

  return summary;
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

  for (const tpl of items) {
    const payload = {
      waba_id: wabaId,
      name: tpl.name,
      language: tpl.language || DEFAULT_LANGUAGE,
      category: tpl.category || null,
      status: tpl.status || null,
      rejection_reason: tpl.rejected_reason || tpl.rejection_reason || null,
      components: tpl.components || null,
      meta_template_id: tpl.id || null,
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

async function enqueueSyncTemplatesJob(data) {
  return queues.whatsappTemplateSync.add('sync', data, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 60000 },
    removeOnComplete: true,
    removeOnFail: false,
  });
}

async function enqueueSyncForAllWabas() {
  const assets = await ClinicMetaAsset.findAll({
    where: {
      isActive: true,
      assetType: 'whatsapp_business_account',
      wabaId: { [Op.ne]: null },
    },
    attributes: ['wabaId', 'waAccessToken'],
    raw: true,
  });

  for (const asset of assets) {
    if (!asset.wabaId || !asset.waAccessToken) continue;
    await enqueueSyncTemplatesJob({ wabaId: asset.wabaId, accessToken: asset.waAccessToken });
  }
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
};
