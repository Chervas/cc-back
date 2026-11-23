'use strict';

const { Op } = require('sequelize');
const { Clinica, WhatsappTemplate } = require('../../models');
const { isApprovedTemplateInWaba, selectTemplateInWaba } = require('../lib/whatsapp-template-scope');
const { isPropdentalAvailabilityInstance, templateBelongsToClinic } = require('../lib/whatsapp-propdental-availability');

async function filterTemplatesForClinic(templates, clinicId, transaction) {
  if (!templates.some(isPropdentalAvailabilityInstance)) return templates;
  const clinic = Number(clinicId) > 0
    ? await Clinica.findByPk(clinicId, { attributes: ['grupoClinicaId'], raw: true, transaction })
    : null;
  return templates.filter(template => templateBelongsToClinic(template, clinic));
}

async function resolveTemplateInWaba({ template, wabaId, clinicId, transaction, userId }) {
  if (!(await filterTemplatesForClinic([template], clinicId, transaction)).length) return null;
  const scope = { wabaId, clinicId };
  if (isApprovedTemplateInWaba(template, scope)) return template;
  // Existing personal templates may be reused by their author across clinics
  // sharing this exact WABA. The conversation controller also applies its ACL.
  if (Number(userId) > 0 && Number(template?.created_by_user_id) === Number(userId)
    && isApprovedTemplateInWaba(template, { wabaId, clinicId: template.clinic_id })) return template;
  const customReplica = String(template?.origin || '').trim().toLowerCase() === 'custom'
    && Number(template?.clinic_id) > 0
    && Number(template?.created_by_user_id) > 0
    && String(template?.name || '').trim();
  if (!wabaId || !Number(template?.catalog_template_id) && !template?.meta_template_id && !customReplica) return null;
  const candidates = await WhatsappTemplate.findAll({
    where: {
      waba_id: String(wabaId), ...(Number(template.catalog_template_id)
        ? { catalog_template_id: Number(template.catalog_template_id) }
        : (customReplica
          ? {
              name: template.name,
              origin: 'custom',
              clinic_id: Number(template.clinic_id),
              created_by_user_id: Number(template.created_by_user_id),
            }
          : { name: template.name, meta_template_id: template.meta_template_id })),
      language: template.language, status: 'APPROVED', is_active: true,
      [Op.or]: [{ clinic_id: null }, { clinic_id: Number(clinicId) }],
    },
    transaction,
  });
  return selectTemplateInWaba(template, await filterTemplatesForClinic(candidates, clinicId, transaction), scope);
}

async function assertTemplateInWaba({ wabaId, clinicId, name, language }) {
  const row = wabaId && await WhatsappTemplate.findOne({
    where: {
      waba_id: String(wabaId), name, language, status: 'APPROVED', is_active: true,
    },
    attributes: ['id', 'name', 'waba_id', 'clinic_id', 'catalog_template_id', 'status', 'is_active', 'retired_at', 'superseded_by_template_id'],
    raw: true,
  });
  // Transport validates the provider account. Caller ACLs decide who may use
  // personal templates shared across clinics in the same WABA.
  if (!isApprovedTemplateInWaba(row, { wabaId, clinicId: row?.clinic_id })
    || !(await filterTemplatesForClinic([row], clinicId)).length) {
    throw Object.assign(new Error('whatsapp_template_waba_mismatch'), {
      code: 'whatsapp_template_waba_mismatch', retryable: false, statusCode: 409,
    });
  }
}

// Syncing/provisioning a group or secondary WABA must not overwrite the
// editor references of clinics whose primary sender belongs to another WABA.
async function filterClinicsForWaba(clinicIds, wabaId) {
  const service = require('./whatsapp.service');
  const result = [];
  for (const id of new Set(clinicIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))) {
    const config = await service.getClinicConfig(id);
    if (String(config?.wabaId || '') === String(wabaId)) result.push(id);
  }
  return result;
}

module.exports = { resolveTemplateInWaba, assertTemplateInWaba, filterClinicsForWaba, filterTemplatesForClinic };
