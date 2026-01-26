'use strict';

const db = require('../../models');
const { Op } = require('sequelize');

const {
  AutomationFlow,
  UsuarioClinica,
  ClinicMetaAsset,
  Clinica,
  WhatsappTemplate,
} = db;

const ROLE_AGGREGATE = ['propietario', 'admin'];
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1')
  .split(',')
  .map((v) => parseInt(v.trim(), 10))
  .filter((n) => !Number.isNaN(n));

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

function ensureClinicAccess({ clinicIds, isAggregateAllowed }, clinicId) {
  if (!clinicId) return false;
  if (isAggregateAllowed) return true;
  return clinicIds.includes(clinicId);
}

function extractActionSteps(pasos = []) {
  return (Array.isArray(pasos) ? pasos : []).filter((p) => p?.tipo === 'action');
}

function hasWhatsAppStep(steps) {
  return steps.some((s) => s?.config?.type === 'enviar_whatsapp');
}

function hasEmailStep(steps) {
  return steps.some((s) => s?.config?.type === 'enviar_email');
}

async function resolveWabaForClinic(clinic) {
  if (!clinic) return null;
  const where = {
    isActive: true,
    assetType: 'whatsapp_phone_number',
  };

  if (clinic.grupoClinicaId) {
    where[Op.or] = [
      { clinicaId: clinic.id_clinica },
      { assignmentScope: 'group', grupoClinicaId: clinic.grupoClinicaId },
    ];
  } else {
    where.clinicaId = clinic.id_clinica;
  }

  return ClinicMetaAsset.findOne({
    where,
    order: [['updatedAt', 'DESC']],
  });
}

function isEmailConfigured(clinic) {
  if (!clinic) return false;
  if (clinic.email) return true;
  const cfg = clinic.configuracion || {};
  if (cfg.email_config?.enabled) return true;
  if (cfg.email?.enabled) return true;
  if (cfg.smtp?.host) return true;
  return false;
}

async function validateWhatsAppTemplates(steps, wabaId) {
  const whatsappSteps = steps.filter((s) => s?.config?.type === 'enviar_whatsapp');
  if (!whatsappSteps.length) return { ok: true };

  if (!wabaId) {
    return { ok: false, error: 'waba_not_connected' };
  }

  for (const step of whatsappSteps) {
    const cfg = step.config || {};
    if (cfg.template_id) {
      const template = await WhatsappTemplate.findOne({ where: { id: cfg.template_id } });
      if (!template || template.waba_id !== wabaId) {
        return { ok: false, error: 'template_not_found' };
      }
      const status = (template.status || '').toUpperCase();
      if (status !== 'APPROVED') {
        return { ok: false, error: 'template_not_approved', details: { template_id: cfg.template_id, status } };
      }
    } else if (cfg.template_name) {
      const template = await WhatsappTemplate.findOne({
        where: { waba_id: wabaId, name: cfg.template_name },
      });
      if (!template) {
        return { ok: false, error: 'template_not_found', details: { template_name: cfg.template_name } };
      }
      const status = (template.status || '').toUpperCase();
      if (status !== 'APPROVED') {
        return { ok: false, error: 'template_not_approved', details: { template_name: cfg.template_name, status } };
      }
    }
  }

  return { ok: true };
}

exports.activateAutomation = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const automationId = req.params.id;

    const automation = await AutomationFlow.findByPk(automationId);
    if (!automation) {
      return res.status(404).json({ success: false, error: 'automation_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureClinicAccess({ clinicIds, isAggregateAllowed }, automation.clinica_id)) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    const clinic = await Clinica.findOne({
      where: { id_clinica: automation.clinica_id },
      raw: true,
    });

    const pasos = automation.pasos || automation.acciones || [];
    const actionSteps = extractActionSteps(pasos);

    if (hasWhatsAppStep(actionSteps)) {
      const wabaAsset = await resolveWabaForClinic(clinic);
      if (!wabaAsset?.wabaId) {
        return res.status(400).json({ success: false, error: 'waba_not_connected' });
      }
      const validation = await validateWhatsAppTemplates(actionSteps, wabaAsset.wabaId);
      if (!validation.ok) {
        return res.status(400).json({ success: false, ...validation });
      }
    }

    if (hasEmailStep(actionSteps)) {
      if (!isEmailConfigured(clinic)) {
        return res.status(400).json({ success: false, error: 'email_not_configured' });
      }
    }

    await automation.update({ estado: 'activo', activo: true });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error activateAutomation', err);
    return res.status(500).json({ success: false, error: 'activate_failed' });
  }
};
