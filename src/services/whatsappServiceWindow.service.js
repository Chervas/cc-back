'use strict';

const { Op } = require('sequelize');
const db = require('../../models');

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

function evaluateWhatsappServiceWindow({
  messages = [],
  activePhoneNumberId,
  conversationLastInboundAt = null,
  now = new Date(),
  windowMs = DEFAULT_WINDOW_MS,
} = {}) {
  const nowMs = timestampMs(now) || Date.now();
  const senderPhoneNumberId = cleanId(activePhoneNumberId);
  const recentInbound = (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      message,
      timestamp: messageTimestampMs(message),
      phoneNumberId: extractWhatsappPhoneNumberId(message?.metadata),
    }))
    .filter((entry) => (
      Number.isFinite(entry.timestamp)
      && nowMs - entry.timestamp >= 0
      && nowMs - entry.timestamp <= windowMs
    ))
    .sort((left, right) => right.timestamp - left.timestamp);

  if (!senderPhoneNumberId) {
    return {
      open: false,
      lastInboundAt: null,
      phoneNumberId: null,
      matchedBy: 'sender_not_configured',
      legacyFallbackUsed: false,
    };
  }

  const taggedInbound = recentInbound.filter((entry) => entry.phoneNumberId);
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

async function resolveWhatsappServiceWindow({
  conversation,
  activePhoneNumberId,
  now = new Date(),
  windowMs = DEFAULT_WINDOW_MS,
  transaction = null,
  messageModel = db.Message,
  messageLimit = DEFAULT_MESSAGE_LIMIT,
} = {}) {
  const conversationId = Number(conversation?.id);
  if (!Number.isFinite(conversationId) || conversationId <= 0) {
    return evaluateWhatsappServiceWindow({
      activePhoneNumberId,
      conversationLastInboundAt: conversation?.last_inbound_at || null,
      now,
      windowMs,
    });
  }

  const nowMs = timestampMs(now) || Date.now();
  const windowStart = new Date(nowMs - windowMs);
  const messages = await messageModel.findAll({
    where: {
      conversation_id: conversationId,
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

  return evaluateWhatsappServiceWindow({
    messages,
    activePhoneNumberId,
    conversationLastInboundAt: conversation?.last_inbound_at || null,
    now,
    windowMs,
  });
}

module.exports = {
  DEFAULT_WINDOW_MS,
  evaluateWhatsappServiceWindow,
  extractWhatsappPhoneNumberId,
  resolveWhatsappServiceWindow,
};
