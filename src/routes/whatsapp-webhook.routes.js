'use strict';
const express = require('express');
const webhookAuthentication = require('../lib/whatsappWebhookAuthentication');
const metaScopeBlock = require('../services/metaScopeBlock.service');
const router = express.Router();
const patientDirectionService = require('../services/patientDirection.service');
const { resolveWhatsappChannelRole } = require('../lib/whatsapp-channel-role');
const db = require('../../models');
const { queues } = require('../services/queue.service');
const { Op } = require('sequelize');

const { ClinicMetaAsset, Clinica, Paciente, Conversation, Message, LeadIntake, WhatsAppWebOrigin } = db;
const positiveId = value => /^[1-9][0-9]{0,9}$/.test(String(value)) && Number(value) <= 2147483647 ? Number(value) : null;
function scopeDenied() { throw Object.assign(Error('whatsapp_webhook_scope_denied'), { status: 403 }); }

function buildPhoneCandidates(raw) {
  if (!raw) return [];
  const digits = String(raw).replace(/\D/g, '');
  const local = digits.length > 9 ? digits.slice(-9) : digits;
  return Array.from(new Set([
    digits,
    `+${digits}`,
    local,
    `+${local}`,
  ])).filter(Boolean);
}

function buildContactIdCandidates(raw) {
  const candidates = buildPhoneCandidates(raw);
  const withPlus = candidates.map((c) => (String(c).startsWith('+') ? String(c) : `+${c}`));
  return Array.from(new Set(withPlus)).filter(Boolean);
}

function buildDigitsCandidates(raw) {
  const candidates = buildPhoneCandidates(raw);
  const digits = candidates.map((c) => String(c).replace(/^\+/, ''));
  return Array.from(new Set(digits)).filter(Boolean);
}

const CC_WEB_REF_REGEX = /\[cc_ref:([a-f0-9]{8,64})\]/i;
function extractWebOriginRefFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(CC_WEB_REF_REGEX);
  return match?.[1] ? String(match[1]).toLowerCase() : null;
}

function extractWebOriginRefFromWebhookBody(body) {
  const messages = body?.entry?.[0]?.changes?.[0]?.value?.messages || [];
  for (const msg of messages) {
    const content = msg?.text?.body || msg?.button?.text || msg?.interactive?.text || '';
    const ref = extractWebOriginRefFromText(content);
    if (ref) return ref;
  }
  return null;
}

function extractPrimaryWhatsappContactFromWebhookBody(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value || {};
  const firstMessage = value?.messages?.[0];
  if (firstMessage?.from) return firstMessage.from;
  const firstEcho = value?.message_echoes?.[0];
  if (firstEcho?.to) return firstEcho.to;
  const firstHistoryThread = value?.history?.[0]?.threads?.[0];
  if (firstHistoryThread?.id) return firstHistoryThread.id;
  return null;
}

function extractWhatsappWebhookValue(body) {
  return body?.entry?.[0]?.changes?.[0]?.value || {};
}

function extractWhatsappWebhookWabaId(body) {
  return body?.entry?.[0]?.id || null;
}

function getWhatsappWebhookAssetScore(asset) {
  if (!asset) return 999;

  const typeScore =
    asset.assetType === 'whatsapp_phone_number'
      ? 0
      : asset.assetType === 'whatsapp_business_account'
        ? 100
        : 200;

  const scopeScore =
    asset.assignmentScope === 'group' && asset.grupoClinicaId
      ? 0
      : asset.assignmentScope === 'clinic' && asset.clinicaId
        ? 10
        : asset.grupoClinicaId
          ? 20
          : asset.clinicaId
            ? 30
            : 40;

  return typeScore + scopeScore;
}

function pickPreferredWhatsappWebhookAsset(assets = []) {
  const validAssets = Array.isArray(assets) ? assets.filter(Boolean) : [];
  if (!validAssets.length) return null;

  return [...validAssets].sort((left, right) => {
    const scoreDiff = getWhatsappWebhookAssetScore(left) - getWhatsappWebhookAssetScore(right);
    if (scoreDiff !== 0) return scoreDiff;

    const leftUpdated = new Date(left.updatedAt || left.createdAt || 0).getTime() || 0;
    const rightUpdated = new Date(right.updatedAt || right.createdAt || 0).getTime() || 0;
    if (rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;

    return Number(right.id || 0) - Number(left.id || 0);
  })[0];
}

async function findWhatsappAssetForWebhook(body) {
  const value = extractWhatsappWebhookValue(body);
  const phoneId = value?.metadata?.phone_number_id || null;
  const wabaId = extractWhatsappWebhookWabaId(body);
  const assets = await ClinicMetaAsset.findAll({
    where: { isActive: true, wabaId, assetType: phoneId ? 'whatsapp_phone_number' : 'whatsapp_business_account',
      ...(phoneId ? { phoneNumberId: phoneId } : {}) },
    attributes: ['id', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'assetType', 'phoneNumberId', 'wabaId', 'additionalData', 'updatedAt', 'createdAt'],
    raw: true,
  });
  // Never fall back from an unknown phone to another phone in the WABA, or
  // infer identity by searching display names / arbitrary metadata.
  const scopes = new Set(assets.map(asset => JSON.stringify([asset.assignmentScope, asset.clinicaId, asset.grupoClinicaId])));
  if (scopes.size !== 1) scopeDenied();
  return pickPreferredWhatsappWebhookAsset(assets);
}

async function permittedClinicIds(asset) {
  const ids = new Set();
  if (asset.assignmentScope === 'clinic' && positiveId(asset.clinicaId)) ids.add(positiveId(asset.clinicaId));
  if (asset.assignmentScope === 'group' && positiveId(asset.grupoClinicaId)) {
    const clinics = await Clinica.findAll({ where: { grupoClinicaId: asset.grupoClinicaId }, attributes: ['id_clinica'], raw: true });
    for (const clinic of clinics) { if (!positiveId(clinic.id_clinica)) scopeDenied(); ids.add(positiveId(clinic.id_clinica)); }
  }
  // A shared patient-director phone has explicit per-clinic settings.
  const settings = await db.PatientDirectionSetting.findAll({ where: { director_phone_asset_id: asset.id }, attributes: ['clinic_id'], raw: true });
  for (const setting of settings) { if (!positiveId(setting.clinic_id)) scopeDenied(); ids.add(positiveId(setting.clinic_id)); }
  if (!ids.size) scopeDenied();
  for (const clinicId of ids) {
    if (await metaScopeBlock.blocked({ assignmentScope: 'clinic', clinicId })) scopeDenied();
  }
  return ids;
}

function messageWhatsappAssetId(message) {
  let metadata = message?.metadata;
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata);
    } catch (_) {
      metadata = {};
    }
  }
  if (!metadata || typeof metadata !== 'object') metadata = {};
  return Number(
    metadata.whatsapp_sender_asset_id
    || metadata.sender_origin_id
    || metadata.whatsapp_origin_asset_id
    || 0
  ) || null;
}

async function findGroupConversation({ clinicIds, from, assetId = null }) {
  const contactIdCandidates = buildContactIdCandidates(from);
  if (!Conversation || !contactIdCandidates.length) return null;

  const conversations = await Conversation.findAll({
    where: {
      clinic_id: { [Op.in]: clinicIds },
      channel: 'whatsapp',
      contact_id: { [Op.in]: contactIdCandidates },
    },
    attributes: ['id', 'clinic_id', 'patient_id', 'lead_id', 'last_message_at', 'updatedAt'],
    order: [
      ['last_message_at', 'DESC'],
      ['updatedAt', 'DESC'],
    ],
    raw: true,
  });
  if (!conversations.length) return null;

  const normalizedAssetId = Number(assetId || 0) || null;
  if (normalizedAssetId && Message) {
    const outboundMessages = await Message.findAll({
      where: {
        conversation_id: { [Op.in]: conversations.map((conversation) => conversation.id) },
        direction: 'outbound',
        status: { [Op.in]: ['sent', 'delivered', 'read'] },
      },
      attributes: ['conversation_id', 'metadata', 'sent_at', 'createdAt'],
      order: [
        ['sent_at', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      limit: 100,
      raw: true,
    });
    const originMatch = outboundMessages.find(
      (message) => messageWhatsappAssetId(message) === normalizedAssetId
    );
    if (originMatch) {
      const conversation = conversations.find(
        (candidate) => Number(candidate.id) === Number(originMatch.conversation_id)
      );
      if (conversation) return conversation;
    }
  }

  return conversations[0];
}

async function resolveClinicAndContact({ clinicId, groupId, from, assetId = null }) {
  const candidates = buildPhoneCandidates(from);
  if (!candidates.length) {
    if (groupId) {
      const clinics = await Clinica.findAll({
        where: { grupoClinicaId: groupId },
        attributes: ['id_clinica'],
        raw: true,
      });
      const clinicIds = clinics.map((c) => c.id_clinica);
      return { clinicId: clinicIds[0] || null, patientId: null, leadId: null };
    }
    return { clinicId: clinicId || null, patientId: null, leadId: null };
  }

  if (clinicId) {
    const patient = await Paciente.findOne({
      where: {
        clinica_id: clinicId,
        [Op.or]: [
          { telefono_movil: { [Op.in]: candidates } },
          { telefono_secundario: { [Op.in]: candidates } },
        ],
      },
      attributes: ['id_paciente', 'clinica_id'],
      raw: true,
    });
    if (patient) {
      return { clinicId, patientId: patient.id_paciente, leadId: null };
    }

    const lead = await LeadIntake.findOne({
      where: {
        clinica_id: clinicId,
        telefono: { [Op.in]: candidates },
      },
      attributes: ['id', 'clinica_id'],
      raw: true,
    });
    if (lead) {
      return { clinicId, patientId: null, leadId: lead.id };
    }

    return { clinicId, patientId: null, leadId: null };
  }

  if (groupId) {
    const clinics = await Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica'],
      raw: true,
    });
    const clinicIds = clinics.map((c) => c.id_clinica);
    if (!clinicIds.length) {
      return { clinicId: null, patientId: null, leadId: null };
    }

    // 1) Evitar duplicados: si ya existe una conversación de WhatsApp para este contacto en alguna clínica del grupo,
    // reutilizamos esa clínica como destino.
    if (Conversation) {
      const conv = await findGroupConversation({ clinicIds, from, assetId });
      if (conv) {
        return { clinicId: conv.clinic_id, patientId: conv.patient_id || null, leadId: conv.lead_id || null };
      }
    }

    // 2) Si hay un LeadIntake reciente para este teléfono en el grupo, asignar la conversación a esa clínica.
    // Esto permite atribuir correctamente mensajes entrantes a la sede que originó el contacto (snippet/web/chatbot).
    const digitsCandidates = buildDigitsCandidates(from);
    if (LeadIntake && digitsCandidates.length) {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentIntake = await LeadIntake.findOne({
        where: {
          clinica_id: { [Op.in]: clinicIds },
          telefono: { [Op.in]: digitsCandidates },
          created_at: { [Op.gte]: cutoff },
        },
        attributes: ['id', 'clinica_id', 'created_at'],
        order: [['created_at', 'DESC']],
        raw: true,
      });
      if (recentIntake?.clinica_id) {
        return { clinicId: recentIntake.clinica_id, patientId: null, leadId: null };
      }
    }

    const patient = await Paciente.findOne({
      where: {
        clinica_id: { [Op.in]: clinicIds },
        [Op.or]: [
          { telefono_movil: { [Op.in]: candidates } },
          { telefono_secundario: { [Op.in]: candidates } },
        ],
      },
      attributes: ['id_paciente', 'clinica_id'],
      raw: true,
    });
    if (patient) {
      return { clinicId: patient.clinica_id, patientId: patient.id_paciente, leadId: null };
    }

    const lead = await LeadIntake.findOne({
      where: {
        clinica_id: { [Op.in]: clinicIds },
        telefono: { [Op.in]: candidates },
      },
      attributes: ['id', 'clinica_id'],
      raw: true,
    });
    if (lead) {
      return { clinicId: lead.clinica_id, patientId: null, leadId: lead.id };
    }

    return { clinicId: clinicIds[0], patientId: null, leadId: null };
  }

  return { clinicId: null, patientId: null, leadId: null };
}

router.get('/whatsapp/webhook', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const challenge = webhookAuthentication.subscription(req);
  if (challenge !== null) return res.status(200).type('text/plain').send(challenge);
  return res.sendStatus(403);
});

router.post('/whatsapp/webhook', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    req.body = webhookAuthentication.authenticate(req);
    const webhookAsset = await findWhatsappAssetForWebhook(req.body);
    const clinicIds = await permittedClinicIds(webhookAsset);

    // Tracking: si el usuario viene desde el widget web, el mensaje incluye un token [cc_ref:...]
    // que permite asignar el inbound a la sede correcta incluso si el número de WhatsApp es compartido por grupo.
    let webOriginRef = extractWebOriginRefFromWebhookBody(req.body);
    let webOrigin = null;
    if (webOriginRef && WhatsAppWebOrigin) {
      try {
        webOrigin = await WhatsAppWebOrigin.findOne({
          where: { ref: webOriginRef },
          attributes: ['id', 'ref', 'clinic_id', 'group_id', 'expires_at', 'used_at'],
          raw: true,
        });
        if (webOrigin?.expires_at && new Date(webOrigin.expires_at).getTime() < Date.now()) {
          webOrigin = null;
        }
      } catch (e) {
        webOrigin = null;
      }
    }

    // The downstream worker also reads cc_ref. Reject an unresolved/foreign
    // reference instead of letting that worker recover an unchecked scope.
    if (webOriginRef && (!webOrigin || !clinicIds.has(positiveId(webOrigin.clinic_id))
      || webOrigin.group_id && Number(webOrigin.group_id) !== Number(webhookAsset.grupoClinicaId))) scopeDenied();
    // URL parameters and extra payload fields cannot choose a clinic. The
    // signed provider identity must resolve to a registered active asset.
    let clinicId = webhookAsset.assignmentScope === 'clinic' ? positiveId(webhookAsset.clinicaId) : null;
    let groupId = webhookAsset.assignmentScope === 'group' ? positiveId(webhookAsset.grupoClinicaId) : null;
    let patientDirectionAssignmentId = null;
    let patientDirectionFormerAssignment = false;

    // Si el token viene, priorizamos esa sede/grupo.
    if (webOrigin) {
      if (webOrigin.clinic_id) clinicId = webOrigin.clinic_id;
      if (webOrigin.group_id) groupId = webOrigin.group_id;
    }

    const from = extractPrimaryWhatsappContactFromWebhookBody(req.body);
    if (!webOrigin && webhookAsset?.id && from) {
      const destination = await patientDirectionService.resolveInboundDestination({
        assetId: webhookAsset.id,
        phone: from,
      });
      if (destination?.source === 'unassigned') {
        await patientDirectionService.captureUnassignedInbound({
          assetId: webhookAsset.id,
          phone: from,
          payload: req.body,
        });
        return res.sendStatus(200);
      }
      if (destination?.clinicId) {
        if (!clinicIds.has(positiveId(destination.clinicId))) scopeDenied();
        clinicId = destination.clinicId;
        patientDirectionAssignmentId = destination.assignmentId || null;
        patientDirectionFormerAssignment = destination.source === 'former_assignment';
      }
    }

    if (!clinicId && groupId) {
      const resolved = await resolveClinicAndContact({
        clinicId: null,
        groupId,
        from,
        assetId: webhookAsset?.id,
      });
      clinicId = resolved.clinicId;
      req.resolvedContact = resolved;
    }

    if (!clinicId) {
      scopeDenied();
    }
    if (!clinicIds.has(positiveId(clinicId))) scopeDenied();
    const resolvedContact =
      req.resolvedContact ||
      (await resolveClinicAndContact({ clinicId, groupId, from }));

    await queues.webhookWhatsApp.add('incoming', {
      body: req.body,
      clinic_id: clinicId,
      patient_id: resolvedContact.patientId,
      lead_id: resolvedContact.leadId,
      web_origin_ref: webOriginRef || null,
      patient_direction_assignment_id: patientDirectionAssignmentId,
      patient_direction_former_assignment: patientDirectionFormerAssignment,
      whatsapp_origin_asset_id: webhookAsset?.id || null,
      whatsapp_channel_role: resolveWhatsappChannelRole(webhookAsset),
    });
    return res.sendStatus(200);
  } catch (err) {
    // Provider bodies, SQL details, phone numbers and configuration never go
    // into an error response or application log from this public endpoint.
    const status = [400, 401, 403, 413, 415, 503].includes(err.status) ? err.status : 503;
    return res.status(status).json({ error: status === 503 ? 'whatsapp_webhook_unavailable' : 'whatsapp_webhook_rejected' });
  }
});

module.exports = router;
