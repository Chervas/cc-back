'use strict';
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const patientDirectionService = require('../services/patientDirection.service');
const db = require('../../models');
const { queues } = require('../services/queue.service');
const { Op } = require('sequelize');

const { ClinicMetaAsset, Clinica, Paciente, Conversation, LeadIntake, WhatsAppWebOrigin } = db;
const APP_SECRET = process.env.FACEBOOK_APP_SECRET || process.env.APP_SECRET;

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
  if (phoneId) {
    const assets = await ClinicMetaAsset.findAll({
      where: { phoneNumberId: phoneId, isActive: true },
      raw: true,
    });
    const asset = pickPreferredWhatsappWebhookAsset(assets);
    if (asset) return asset;
    console.warn('Webhook WA sin mapeo de phoneNumberId', phoneId);
  }

  const wabaId = extractWhatsappWebhookWabaId(body);
  if (wabaId) {
    const assets = await ClinicMetaAsset.findAll({
      where: {
        assetType: { [Op.in]: ['whatsapp_phone_number', 'whatsapp_business_account'] },
        wabaId,
        isActive: true,
      },
      raw: true,
    });
    const asset = pickPreferredWhatsappWebhookAsset(assets);
    if (asset) return asset;
  }

  const phoneNumber = value?.phone_number || value?.metadata?.display_phone_number || null;
  const phoneDigits = phoneNumber ? String(phoneNumber).replace(/\D/g, '') : '';
  if (phoneDigits) {
    const assets = await ClinicMetaAsset.findAll({
      where: {
        assetType: 'whatsapp_phone_number',
        isActive: true,
      },
      raw: true,
    });
    const localDigits = phoneDigits.length > 9 ? phoneDigits.slice(-9) : phoneDigits;
    const matches = assets.filter((asset) => {
      const haystack = JSON.stringify({
        metaAssetName: asset.metaAssetName,
        phoneNumberId: asset.phoneNumberId,
        wabaId: asset.wabaId,
        additionalData: asset.additionalData,
      }).replace(/\D/g, '');
      return haystack.includes(phoneDigits) || (localDigits && haystack.includes(localDigits));
    });
    const match = pickPreferredWhatsappWebhookAsset(matches);
    if (match) return match;
  }

  return null;
}

async function resolveClinicAndContact({ clinicId, groupId, from }) {
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
    const contactIdCandidates = buildContactIdCandidates(from);
    if (Conversation && contactIdCandidates.length) {
      const conv = await Conversation.findOne({
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

function verifySignature(req, res, buf) {
  if (!APP_SECRET) return true;
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  const elements = signature.split('=');
  const signatureHash = elements[1];
  const expectedHash = crypto
    .createHmac('sha256', APP_SECRET)
    .update(buf)
    .digest('hex');
  return signatureHash === expectedHash;
}

router.get('/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyTokens = [
    process.env.WHATSAPP_VERIFY_TOKEN,
    process.env.META_WEBHOOK_VERIFY_TOKEN,
    process.env.META_VERIFY_TOKEN,
  ].filter(Boolean);

  if (mode === 'subscribe' && token && verifyTokens.includes(token)) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

router.post('/whatsapp/webhook', async (req, res) => {
  try {
    if (!verifySignature(req, res, req.rawBody || Buffer.from(JSON.stringify(req.body || {})))) {
      return res.sendStatus(401);
    }

    // Tracking: si el usuario viene desde el widget web, el mensaje incluye un token [cc_ref:...]
    // que permite asignar el inbound a la sede correcta incluso si el número de WhatsApp es compartido por grupo.
    const webOriginRef = extractWebOriginRefFromWebhookBody(req.body);
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

    let clinicId = req.query.clinic_id || req.body?.clinic_id;
    let groupId = null;
    let webhookAsset = null;
    let patientDirectionAssignmentId = null;
    let patientDirectionFormerAssignment = false;

    // Si el token viene, priorizamos esa sede/grupo.
    if (webOrigin) {
      if (webOrigin.clinic_id) clinicId = webOrigin.clinic_id;
      if (webOrigin.group_id) groupId = webOrigin.group_id;
    }

    if (!webOrigin) {
      webhookAsset = await findWhatsappAssetForWebhook(req.body);
      if (webhookAsset) {
        clinicId = clinicId || webhookAsset.clinicaId;
        groupId = webhookAsset.grupoClinicaId;
      }
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
        clinicId = destination.clinicId;
        patientDirectionAssignmentId = destination.assignmentId || null;
        patientDirectionFormerAssignment = destination.source === 'former_assignment';
      }
    }

    if (!clinicId && groupId) {
      const resolved = await resolveClinicAndContact({ clinicId: null, groupId, from });
      clinicId = resolved.clinicId;
      req.resolvedContact = resolved;
    }

    if (!clinicId) {
      console.warn('Webhook WA sin clinic_id, descartando payload');
      return res.sendStatus(200);
    }
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
    });
    return res.sendStatus(200);
  } catch (err) {
    console.error('Error en webhook WhatsApp', err);
    return res.sendStatus(500);
  }
});

module.exports = router;
