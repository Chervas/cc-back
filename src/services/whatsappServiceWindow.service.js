'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { isWhatsappRoutingConfigAvailable } = require('../lib/whatsapp-channel-role');

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MESSAGE_LIMIT = 200;

function cleanId(value) {
  return String(value || '').trim();
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function extractWhatsappPhoneNumberId(metadataValue) {
  const metadata = parseMetadata(metadataValue);
  return cleanId(
    metadata.phoneNumberId
    || metadata.phoneId
    || metadata.phone_number_id
    || metadata.phone_id
    || metadata.whatsapp?.phoneNumberId
    || metadata.whatsapp?.phone_number_id
  );
}

function timestampMs(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function messageTimestampMs(message) {
  return timestampMs(
    message?.sent_at
    || message?.sentAt
    || message?.createdAt
    || message?.created_at
  );
}

function isInsideWindow(value, { nowMs, windowMs }) {
  const parsed = timestampMs(value);
  if (!Number.isFinite(parsed)) return false;
  const ageMs = nowMs - parsed;
  return ageMs >= 0 && ageMs <= windowMs;
}

function recentWhatsappInbound(messages, { nowMs, windowMs }) {
  return (Array.isArray(messages) ? messages : [])
    .map(message => ({
      timestamp: messageTimestampMs(message),
      phoneNumberId: extractWhatsappPhoneNumberId(message?.metadata),
    }))
    .filter((entry) => (
      Number.isFinite(entry.timestamp)
      && nowMs - entry.timestamp >= 0
      && nowMs - entry.timestamp <= windowMs
    ))
    .sort((left, right) => right.timestamp - left.timestamp);
}

function evaluateWhatsappServiceWindow({
  messages = [],
  activePhoneNumberId,
  conversationLastInboundAt = null,
  now = new Date(),
  windowMs = DEFAULT_WINDOW_MS,
} = {}) {
  const nowMs = timestampMs(now) || Date.now();
  const senderPhoneNumberId = cleanId(activePhoneNumberId);
  if (!senderPhoneNumberId) {
    return {
      open: false,
      lastInboundAt: null,
      phoneNumberId: null,
      matchedBy: 'sender_not_configured',
      legacyFallbackUsed: false,
    };
  }

  const taggedInbound = recentWhatsappInbound(messages, { nowMs, windowMs })
    .filter(entry => entry.phoneNumberId);
  const senderInbound = taggedInbound.find(
    (entry) => entry.phoneNumberId === senderPhoneNumberId
  );
  if (senderInbound) {
    return {
      open: true,
      lastInboundAt: new Date(senderInbound.timestamp).toISOString(),
      phoneNumberId: senderPhoneNumberId,
      matchedBy: 'message_phone_number_id',
      legacyFallbackUsed: false,
    };
  }

  if (taggedInbound.length) {
    return {
      open: false,
      lastInboundAt: null,
      phoneNumberId: senderPhoneNumberId,
      matchedBy: 'different_phone_number_id',
      legacyFallbackUsed: false,
    };
  }

  if (isInsideWindow(conversationLastInboundAt, { nowMs, windowMs })) {
    return {
      open: true,
      lastInboundAt: new Date(conversationLastInboundAt).toISOString(),
      phoneNumberId: senderPhoneNumberId,
      matchedBy: 'legacy_conversation_timestamp',
      legacyFallbackUsed: true,
    };
  }

  return {
    open: false,
    lastInboundAt: null,
    phoneNumberId: senderPhoneNumberId,
    matchedBy: 'no_recent_inbound',
    legacyFallbackUsed: false,
  };
}

async function loadWhatsappServiceWindowEvidence({
  conversation,
  now = new Date(),
  windowMs = DEFAULT_WINDOW_MS,
  transaction = null,
  messageModel = db.Message,
  messageLimit = DEFAULT_MESSAGE_LIMIT,
} = {}) {
  const conversationId = Number(conversation?.id);
  if (!Number.isFinite(conversationId) || conversationId <= 0) {
    return {
      conversationLastInboundAt: conversation?.last_inbound_at || null,
      now,
      windowMs,
    };
  }

  const nowMs = timestampMs(now) || Date.now();
  const identityWindow=await require('./whatsappContactIdentity.service').windowContext(conversation,{transaction});
  const windowStart = new Date(Math.max(nowMs-windowMs,identityWindow.notBefore ? +new Date(identityWindow.notBefore) : 0));
  const messages = await messageModel.findAll({
    where: {
      conversation_id: { [Op.in]: identityWindow.ids },
      direction: 'inbound',
      [Op.or]: [
        { sent_at: { [Op.gte]: windowStart } },
        { createdAt: { [Op.gte]: windowStart } },
      ],
    },
    attributes: ['id', 'metadata', 'sent_at', 'createdAt'],
    order: [
      ['sent_at', 'DESC'],
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: Math.max(1, Number(messageLimit) || DEFAULT_MESSAGE_LIMIT),
    raw: true,
    transaction,
  });

  return {
    messages,
    conversationLastInboundAt: identityWindow.allowLegacy ? conversation?.last_inbound_at || null : null,
    now,
    windowMs,
  };
}

async function resolveWhatsappServiceWindow({ activePhoneNumberId, ...options } = {}) {
  const evidence = await loadWhatsappServiceWindowEvidence(options);
  return evaluateWhatsappServiceWindow({ ...evidence, activePhoneNumberId });
}

async function resolveWhatsappReplySender({ clinicConfig, getSecondaryConfig, ...options }) {
  const evidence = await loadWhatsappServiceWindowEvidence(options);
  const window = { nowMs: timestampMs(evidence.now) || Date.now(), windowMs: evidence.windowMs };
  const receivedBy = getSecondaryConfig
    && recentWhatsappInbound(evidence.messages, window).find(entry => entry.phoneNumberId)?.phoneNumberId;

  // Switch only to the effective secondary of this clinic, based on verified
  // inbound metadata. A foreign or previously disconnected number is ineligible.
  if (receivedBy && receivedBy !== cleanId(clinicConfig?.phoneNumberId)) {
    const secondary = await getSecondaryConfig();
    if (cleanId(secondary?.phoneNumberId) === receivedBy) clinicConfig = secondary;
  }
  const serviceWindow = evaluateWhatsappServiceWindow({
    ...evidence,
    activePhoneNumberId: clinicConfig?.phoneNumberId,
  });
  if (!isWhatsappRoutingConfigAvailable(clinicConfig)) serviceWindow.open = false;
  return { clinicConfig, serviceWindow };
}

module.exports = {
  DEFAULT_WINDOW_MS,
  evaluateWhatsappServiceWindow,
  extractWhatsappPhoneNumberId,
  resolveWhatsappReplySender,
  resolveWhatsappServiceWindow,
};
