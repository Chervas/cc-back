'use strict';
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../../models');
const { queues } = require('../services/queue.service');
const { Op, QueryTypes } = require('sequelize');

const { ClinicMetaAsset, Clinica, Paciente, Lead, Conversation } = db;
const APP_SECRET = process.env.FACEBOOK_APP_SECRET || process.env.APP_SECRET;
const INTERNAL_RELAY_TOKEN = process.env.WHATSAPP_INTERNAL_RELAY_TOKEN || '';
const RELAY_URL = process.env.WHATSAPP_WEBHOOK_RELAY_URL || '';
const RELAY_MODE = (process.env.WHATSAPP_WEBHOOK_RELAY_MODE || 'off').toLowerCase(); // off | mirror | forward
const RELAY_PHONE_IDS = (process.env.WHATSAPP_WEBHOOK_RELAY_PHONE_IDS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const RELAY_TIMEOUT_MS = Number(process.env.WHATSAPP_WEBHOOK_RELAY_TIMEOUT_MS || 4000);

function resolvedResult({
  clinicId = null,
  patientId = null,
  leadId = null,
  reason = 'unresolved',
  matchedConversationId = null,
  matchedMessageId = null,
} = {}) {
  return {
    clinicId,
    patientId,
    leadId,
    reason,
    matchedConversationId,
    matchedMessageId,
  };
}

function buildPhoneCandidates(raw) {
  if (!raw) return [];
  const digits = String(raw).replace(/\D/g, '');
  const local = digits.length > 9 ? digits.slice(-9) : digits;
  return Array.from(new Set([
    digits,
    `+${digits}`,
    local,
  ])).filter(Boolean);
}

function buildContactIdCandidates(raw) {
  if (!raw) return [];
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return [];
  const local = digits.length > 9 ? digits.slice(-9) : digits;
  // Evitar candidatos tipo +<local> (p.ej. +617...), que pueden enrutar a conversaciones erróneas.
  return Array.from(new Set([
    `+${digits}`,
    digits,
    local,
  ])).filter(Boolean);
}

async function findConversationByContextWamid({ clinicIds = [], contextWamid }) {
  if (!Array.isArray(clinicIds) || !clinicIds.length || !contextWamid) {
    return null;
  }

  const rows = await db.sequelize.query(
    `
    SELECT
      c.id AS conversation_id,
      c.clinic_id,
      c.patient_id,
      c.lead_id,
      m.id AS message_id
    FROM Messages m
    JOIN Conversations c ON c.id = m.conversation_id
    WHERE
      c.channel = 'whatsapp'
      AND c.clinic_id IN (:clinicIds)
      AND JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.wamid')) = :contextWamid
    ORDER BY m.id DESC
    LIMIT 1
    `,
    {
      replacements: { clinicIds, contextWamid },
      type: QueryTypes.SELECT,
    }
  );

  return rows?.[0] || null;
}

async function findLatestOutboundConversationByContact({ clinicIds = [], contactIds = [], phoneId = null }) {
  if (!Array.isArray(clinicIds) || !clinicIds.length || !Array.isArray(contactIds) || !contactIds.length) {
    return null;
  }

  const replacements = { clinicIds, contactIds };
  let phoneFilter = '';
  if (phoneId) {
    replacements.phoneId = String(phoneId);
    phoneFilter = `
      AND (
        JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.phoneId')) = :phoneId
        OR JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.phoneNumberId')) = :phoneId
      )
    `;
  }

  const rows = await db.sequelize.query(
    `
    SELECT
      c.id AS conversation_id,
      c.clinic_id,
      c.patient_id,
      c.lead_id,
      m.id AS message_id
    FROM Conversations c
    JOIN Messages m ON m.conversation_id = c.id
    WHERE
      c.channel = 'whatsapp'
      AND c.clinic_id IN (:clinicIds)
      AND c.contact_id IN (:contactIds)
      AND m.direction = 'outbound'
      ${phoneFilter}
    ORDER BY COALESCE(m.sent_at, m.createdAt) DESC, m.id DESC
    LIMIT 1
    `,
    {
      replacements,
      type: QueryTypes.SELECT,
    }
  );

  return rows?.[0] || null;
}

async function findLatestConversationByContact({ clinicIds = [], contactIds = [] }) {
  if (!Array.isArray(clinicIds) || !clinicIds.length || !Array.isArray(contactIds) || !contactIds.length) {
    return null;
  }

  const rows = await db.sequelize.query(
    `
    SELECT
      c.id AS conversation_id,
      c.clinic_id,
      c.patient_id,
      c.lead_id
    FROM Conversations c
    WHERE
      c.channel = 'whatsapp'
      AND c.clinic_id IN (:clinicIds)
      AND c.contact_id IN (:contactIds)
    ORDER BY COALESCE(c.last_message_at, c.updatedAt, c.createdAt) DESC, c.id DESC
    LIMIT 1
    `,
    {
      replacements: { clinicIds, contactIds },
      type: QueryTypes.SELECT,
    }
  );

  return rows?.[0] || null;
}

async function resolveClinicAndContact({
  clinicId,
  groupId,
  from,
  messageContextWamid = null,
  phoneId = null,
}) {
  const candidates = buildPhoneCandidates(from);
  if (!candidates.length) {
    if (groupId) {
      const clinics = await Clinica.findAll({
        where: { grupoClinicaId: groupId },
        attributes: ['id_clinica'],
        raw: true,
      });
      const clinicIds = clinics.map((c) => c.id_clinica);
      return resolvedResult({
        clinicId: clinicIds[0] || null,
        reason: 'group_default_no_phone',
      });
    }
    return resolvedResult({
      clinicId: clinicId || null,
      reason: clinicId ? 'direct_clinic_no_phone' : 'unresolved_no_phone',
    });
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
      return resolvedResult({
        clinicId,
        patientId: patient.id_paciente,
        reason: 'direct_clinic_patient_match',
      });
    }

    const lead = await Lead.findOne({
      where: {
        clinica_id: clinicId,
        telefono: { [Op.in]: candidates },
      },
      attributes: ['id', 'clinica_id'],
      raw: true,
    });
    if (lead) {
      return resolvedResult({
        clinicId,
        leadId: lead.id,
        reason: 'direct_clinic_lead_match',
      });
    }

    return resolvedResult({
      clinicId,
      reason: 'direct_clinic_no_contact_match',
    });
  }

  if (groupId) {
    const clinics = await Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica'],
      raw: true,
    });
    const clinicIds = clinics.map((c) => c.id_clinica);
    if (!clinicIds.length) {
      return resolvedResult({
        clinicId: null,
        reason: 'group_without_clinics',
      });
    }

    // 1) Si viene context.id (wamid del mensaje al que responde), usar esa conversación.
    if (messageContextWamid) {
      const byContext = await findConversationByContextWamid({
        clinicIds,
        contextWamid: String(messageContextWamid),
      });
      if (byContext) {
        return resolvedResult({
          clinicId: byContext.clinic_id,
          patientId: byContext.patient_id || null,
          leadId: byContext.lead_id || null,
          reason: 'group_by_context_wamid',
          matchedConversationId: byContext.conversation_id,
          matchedMessageId: byContext.message_id,
        });
      }
    }

    // 2) Sin context: usar la conversación con último outbound a este contacto.
    const contactIdCandidates = buildContactIdCandidates(from);
    if (contactIdCandidates.length) {
      let byOutbound = await findLatestOutboundConversationByContact({
        clinicIds,
        contactIds: contactIdCandidates,
        phoneId: phoneId ? String(phoneId) : null,
      });

      // Fallback si mensajes históricos no guardaban phoneId.
      if (!byOutbound && phoneId) {
        byOutbound = await findLatestOutboundConversationByContact({
          clinicIds,
          contactIds: contactIdCandidates,
          phoneId: null,
        });
      }

      if (byOutbound) {
        return resolvedResult({
          clinicId: byOutbound.clinic_id,
          patientId: byOutbound.patient_id || null,
          leadId: byOutbound.lead_id || null,
          reason: 'group_by_latest_outbound_conversation',
          matchedConversationId: byOutbound.conversation_id,
          matchedMessageId: byOutbound.message_id,
        });
      }

      const byConversation = await findLatestConversationByContact({
        clinicIds,
        contactIds: buildContactIdCandidates(from),
      });
      if (byConversation) {
        return resolvedResult({
          clinicId: byConversation.clinic_id,
          patientId: byConversation.patient_id || null,
          leadId: byConversation.lead_id || null,
          reason: 'group_by_latest_conversation',
          matchedConversationId: byConversation.conversation_id,
        });
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
      return resolvedResult({
        clinicId: patient.clinica_id,
        patientId: patient.id_paciente,
        reason: 'group_by_patient_match',
      });
    }

    const lead = await Lead.findOne({
      where: {
        clinica_id: { [Op.in]: clinicIds },
        telefono: { [Op.in]: candidates },
      },
      attributes: ['id', 'clinica_id'],
      raw: true,
    });
    if (lead) {
      return resolvedResult({
        clinicId: lead.clinica_id,
        leadId: lead.id,
        reason: 'group_by_lead_match',
      });
    }

    return resolvedResult({
      clinicId: clinicIds[0],
      reason: 'group_default_first_clinic',
    });
  }

  return resolvedResult({
    clinicId: null,
    reason: 'unresolved_without_scope',
  });
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

function isInternalRelayRequest(req) {
  if (!INTERNAL_RELAY_TOKEN) return false;
  const headerToken = req.headers['x-cc-internal-relay-token'];
  return Boolean(headerToken) && String(headerToken) === INTERNAL_RELAY_TOKEN;
}

function shouldRelay(phoneId) {
  if (!RELAY_URL || RELAY_MODE === 'off') return false;
  if (!RELAY_PHONE_IDS.length) return true;
  return Boolean(phoneId) && RELAY_PHONE_IDS.includes(String(phoneId));
}

async function relayWebhookToTarget({ body, query, phoneId }) {
  if (!shouldRelay(phoneId)) return { relayed: false, reason: 'disabled_or_not_matching_phone' };
  if (!INTERNAL_RELAY_TOKEN) return { relayed: false, reason: 'missing_internal_relay_token' };

  const target = new URL(RELAY_URL);
  if (query && typeof query === 'object') {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        target.searchParams.set(key, String(value));
      }
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    const response = await fetch(target.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cc-internal-relay-token': INTERNAL_RELAY_TOKEN,
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    return { relayed: true, status: response.status };
  } catch (error) {
    return { relayed: false, reason: error?.message || 'relay_error' };
  } finally {
    clearTimeout(timer);
  }
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
    const internalRelay = isInternalRelayRequest(req);
    if (!internalRelay && !verifySignature(req, res, req.rawBody || Buffer.from(JSON.stringify(req.body || {})))) {
      return res.sendStatus(401);
    }

    const phoneId = req.body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || null;
    if (!internalRelay && shouldRelay(phoneId)) {
      const relayResult = await relayWebhookToTarget({
        body: req.body,
        query: req.query,
        phoneId,
      });
      console.info('[whatsapp-webhook] relay result', {
        mode: RELAY_MODE,
        phone_id: phoneId,
        relay_url: RELAY_URL,
        ...relayResult,
      });
      if (RELAY_MODE === 'forward') {
        return res.sendStatus(relayResult.relayed ? 200 : 202);
      }
    }

    let clinicId = req.query.clinic_id || req.body?.clinic_id;
    let groupId = null;
    let resolutionSource = clinicId ? 'explicit_clinic' : 'unknown';
    const inboundMessage = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || null;
    const from = inboundMessage?.from || null;
    const messageContextWamid = inboundMessage?.context?.id || null;
    if (!clinicId) {
      if (phoneId) {
        const asset = await ClinicMetaAsset.findOne({
          where: { phoneNumberId: phoneId, isActive: true },
          raw: true,
        });
        if (asset) {
          clinicId = asset.clinicaId;
          groupId = asset.grupoClinicaId;
          resolutionSource = 'phone_number_mapping';
        } else {
          console.warn('Webhook WA sin mapeo de phoneNumberId', phoneId);
        }
      }
    }

    let resolvedContact = resolvedResult({
      clinicId: clinicId || null,
      reason: clinicId ? 'pre_resolved_clinic' : 'pre_resolved_unset',
    });

    if (!clinicId && groupId) {
      resolvedContact = await resolveClinicAndContact({
        clinicId: null,
        groupId,
        from,
        messageContextWamid,
        phoneId,
      });
      clinicId = resolvedContact.clinicId;
    }

    if (!clinicId) {
      console.warn('Webhook WA sin clinic_id, descartando payload', {
        from,
        phone_id: phoneId,
        context_wamid: messageContextWamid,
        source: resolutionSource,
        reason: resolvedContact.reason,
      });
      return res.sendStatus(200);
    }

    if (
      (resolvedContact?.reason === 'pre_resolved_clinic' || resolvedContact?.reason === 'pre_resolved_unset') &&
      !resolvedContact?.patientId &&
      !resolvedContact?.leadId
    ) {
      resolvedContact = await resolveClinicAndContact({
        clinicId,
        groupId,
        from,
        messageContextWamid,
        phoneId,
      });
    }

    console.info('[whatsapp-webhook] inbound resolved', {
      from,
      phone_id: phoneId,
      context_wamid: messageContextWamid,
      clinic_id: clinicId,
      patient_id: resolvedContact.patientId || null,
      lead_id: resolvedContact.leadId || null,
      reason: resolvedContact.reason,
      matched_conversation_id: resolvedContact.matchedConversationId || null,
      matched_message_id: resolvedContact.matchedMessageId || null,
      source: resolutionSource,
    });

    await queues.webhookWhatsApp.add('incoming', {
      body: req.body,
      clinic_id: clinicId,
      patient_id: resolvedContact.patientId,
      lead_id: resolvedContact.leadId,
      routing: {
        source: resolutionSource,
        reason: resolvedContact.reason || null,
        matched_conversation_id: resolvedContact.matchedConversationId || null,
        matched_message_id: resolvedContact.matchedMessageId || null,
        context_wamid: messageContextWamid || null,
        phone_number_id: phoneId || null,
      },
    });
    return res.sendStatus(200);
  } catch (err) {
    console.error('Error en webhook WhatsApp', err);
    return res.sendStatus(500);
  }
});

module.exports = router;
