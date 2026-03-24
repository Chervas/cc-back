'use strict';

const { Op } = require('sequelize');

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function formatDateTimeEs(rawDate) {
  if (!rawDate) return null;
  const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function getMadridDateParts(rawDate) {
  const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
  };
}

function sameMadridDay(a, b) {
  const pa = getMadridDateParts(a);
  const pb = getMadridDateParts(b);
  return !!pa && !!pb && pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

function sameMadridYear(a, b) {
  const pa = getMadridDateParts(a);
  const pb = getMadridDateParts(b);
  return !!pa && !!pb && pa.year === pb.year;
}

function resolveMessageMoment(message) {
  const candidate = message?.sent_at || message?.createdAt || message?.created_at || null;
  if (!candidate) return null;
  const parsed = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function resolveMessageAuthor(message) {
  const direction = cleanString(message?.direction)?.toLowerCase();
  if (direction === 'inbound') return 'Paciente';
  if (direction === 'outbound') return 'Clínica';
  return 'Sistema';
}

function extractMessageText(message) {
  const content = cleanString(message?.content);
  if (content) return content;

  const metadata = message?.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};
  const templateName = cleanString(metadata?.template_name || metadata?.templateName || metadata?.template);
  if (templateName) {
    return `[Plantilla WhatsApp] ${templateName}`;
  }

  const eventLabel = cleanString(metadata?.label || metadata?.description || metadata?.event);
  if (eventLabel) {
    return `[Evento] ${eventLabel}`;
  }

  return null;
}

function formatConversationLine(message) {
  const text = extractMessageText(message);
  if (!text) return null;
  const timestamp = formatDateTimeEs(resolveMessageMoment(message)) || 'Sin fecha';
  return `[${timestamp}] ${resolveMessageAuthor(message)}: ${text}`;
}

function trimConversationLines(lines, { maxLines, maxChars }) {
  const effectiveLines = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (!effectiveLines.length) return null;

  let truncatedCount = 0;
  let output = effectiveLines;

  if (Number.isInteger(maxLines) && maxLines > 0 && output.length > maxLines) {
    truncatedCount = output.length - maxLines;
    output = output.slice(output.length - maxLines);
  }

  if (Number.isInteger(maxChars) && maxChars > 0) {
    while (output.length > 1 && output.join('\n').length > maxChars) {
      output.shift();
      truncatedCount += 1;
    }
    if (output.join('\n').length > maxChars) {
      output = [output.join('\n').slice(-maxChars)];
    }
  }

  const prefix = truncatedCount > 0
    ? [`[Histórico truncado: mostrando ${output.length} mensajes recientes, ${truncatedCount} omitidos]`]
    : [];

  return [...prefix, ...output].join('\n');
}

async function resolveConversationRecord({
  Conversation,
  conversationId,
  clinicId,
  leadId,
  patientId,
}) {
  const normalizedConversationId = toIntOrNull(conversationId);
  if (normalizedConversationId) {
    return Conversation.findByPk(normalizedConversationId, {
      attributes: ['id', 'clinic_id', 'channel', 'contact_id', 'patient_id', 'lead_id', 'last_message_at', 'last_inbound_at', 'unread_count'],
      raw: true,
    });
  }

  const where = {};
  const and = [];
  const normalizedClinicId = toIntOrNull(clinicId);
  const normalizedLeadId = toIntOrNull(leadId);
  const normalizedPatientId = toIntOrNull(patientId);

  if (normalizedClinicId) {
    where.clinic_id = normalizedClinicId;
  }

  if (normalizedLeadId) {
    and.push({ lead_id: normalizedLeadId });
  }
  if (normalizedPatientId) {
    and.push({ patient_id: normalizedPatientId });
  }

  if (!and.length) {
    return null;
  }

  where[Op.or] = and;

  return Conversation.findOne({
    where,
    attributes: ['id', 'clinic_id', 'channel', 'contact_id', 'patient_id', 'lead_id', 'last_message_at', 'last_inbound_at', 'unread_count'],
    order: [['last_message_at', 'DESC'], ['updatedAt', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
}

async function buildConversationContext({
  Conversation,
  Message,
  conversationId = null,
  clinicId = null,
  leadId = null,
  patientId = null,
  now = new Date(),
}) {
  const conversation = await resolveConversationRecord({
    Conversation,
    conversationId,
    clinicId,
    leadId,
    patientId,
  });

  if (!conversation?.id) {
    return null;
  }

  const messages = await Message.findAll({
    where: {
      conversation_id: conversation.id,
      message_type: { [Op.notIn]: ['event', 'reaction'] },
    },
    attributes: ['id', 'direction', 'content', 'message_type', 'metadata', 'sent_at', 'createdAt'],
    order: [['sent_at', 'ASC'], ['createdAt', 'ASC'], ['id', 'ASC']],
    raw: true,
  });

  const normalizedMessages = messages
    .map((message) => {
      const moment = resolveMessageMoment(message);
      const line = formatConversationLine(message);
      return {
        id: toIntOrNull(message?.id),
        direction: cleanString(message?.direction),
        message_type: cleanString(message?.message_type),
        author: resolveMessageAuthor(message),
        sent_at: moment ? moment.toISOString() : null,
        text: extractMessageText(message),
        line,
        _moment: moment,
      };
    })
    .filter((message) => message.text && message.line);

  const todayLines = normalizedMessages
    .filter((message) => message._moment && sameMadridDay(message._moment, now))
    .map((message) => message.line);
  const thisYearLines = normalizedMessages
    .filter((message) => message._moment && sameMadridYear(message._moment, now))
    .map((message) => message.line);
  const allTimeLines = normalizedMessages.map((message) => message.line);

  return {
    conversation: {
      id: toIntOrNull(conversation.id),
      clinic_id: toIntOrNull(conversation.clinic_id),
      patient_id: toIntOrNull(conversation.patient_id),
      lead_id: toIntOrNull(conversation.lead_id),
      channel: cleanString(conversation.channel),
      contact_id: cleanString(conversation.contact_id),
      last_message_at: conversation.last_message_at || null,
      last_inbound_at: conversation.last_inbound_at || null,
      unread_count: toIntOrNull(conversation.unread_count) || 0,
      message_count: normalizedMessages.length,
    },
    conversation_today: trimConversationLines(todayLines, { maxLines: 60, maxChars: 12000 }),
    conversation_this_year: trimConversationLines(thisYearLines, { maxLines: 160, maxChars: 24000 }),
    conversation_all_time: trimConversationLines(allTimeLines, { maxLines: 240, maxChars: 36000 }),
  };
}

module.exports = {
  buildConversationContext,
};
