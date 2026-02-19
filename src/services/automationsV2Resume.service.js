'use strict';

const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const jobScheduler = require('./jobScheduler.service');

const FlowExecutionV2 = db.FlowExecutionV2;
const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeType(value) {
  return (cleanString(value) || '').toLowerCase();
}

function toIntOrNull(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const chunks = String(path).split('.').filter(Boolean);
  let current = obj;
  for (const chunk of chunks) {
    if (current === undefined || current === null) return undefined;
    current = current[chunk];
  }
  return current;
}

function collectContextIds(execution) {
  const context = execution?.context && typeof execution.context === 'object'
    ? execution.context
    : {};

  const ids = {
    conversation_id: null,
    lead_id: null,
    patient_id: null,
  };

  const conversationCandidates = [
    getByPath(context, 'conversation.id'),
    getByPath(context, 'trigger.data.conversation_id'),
    getByPath(context, 'trigger.data.conversationId'),
  ];
  const leadCandidates = [
    getByPath(context, 'lead.id'),
    getByPath(context, 'trigger.data.lead_id'),
    getByPath(context, 'trigger.data.leadId'),
  ];
  const patientCandidates = [
    getByPath(context, 'patient.id'),
    getByPath(context, 'trigger.data.patient_id'),
    getByPath(context, 'trigger.data.patientId'),
  ];

  for (const candidate of conversationCandidates) {
    const normalized = toIntOrNull(candidate);
    if (normalized) {
      ids.conversation_id = normalized;
      break;
    }
  }

  for (const candidate of leadCandidates) {
    const normalized = toIntOrNull(candidate);
    if (normalized) {
      ids.lead_id = normalized;
      break;
    }
  }

  for (const candidate of patientCandidates) {
    const normalized = toIntOrNull(candidate);
    if (normalized) {
      ids.patient_id = normalized;
      break;
    }
  }

  return ids;
}

function isWaitResponseNode(execution) {
  const nodeId = cleanString(execution?.current_node_id);
  if (!nodeId) return false;

  const nodes = Array.isArray(execution?.templateVersion?.nodes)
    ? execution.templateVersion.nodes
    : [];
  const currentNode = nodes.find((n) => cleanString(n?.id) === nodeId);
  return cleanString(currentNode?.type) === 'delay/wait_response';
}

function matchesExecutionTarget(execution, { conversationId, patientId, leadId }) {
  const triggerType = normalizeType(execution?.trigger_entity_type);
  const triggerEntityId = toIntOrNull(execution?.trigger_entity_id);

  if (
    ['conversation', 'whatsapp_conversation', 'chat_conversation'].includes(triggerType)
    && triggerEntityId
  ) {
    return triggerEntityId === conversationId;
  }

  if (['lead', 'leadintake', 'lead_intake'].includes(triggerType) && triggerEntityId && leadId) {
    return triggerEntityId === leadId;
  }

  if (['patient', 'paciente'].includes(triggerType) && triggerEntityId && patientId) {
    return triggerEntityId === patientId;
  }

  // Fallback por contexto cuando el trigger_entity_type no esté normalizado todavía.
  const contextIds = collectContextIds(execution);
  if (contextIds.conversation_id && contextIds.conversation_id === conversationId) return true;
  if (leadId && contextIds.lead_id && contextIds.lead_id === leadId) return true;
  if (patientId && contextIds.patient_id && contextIds.patient_id === patientId) return true;

  return false;
}

async function enqueueInboundResponseResume({
  clinicId,
  conversationId,
  patientId = null,
  leadId = null,
  messageText,
  inboundMessageId = null,
  channel = 'whatsapp',
}) {
  const enabled = String(process.env.AUTOMATIONS_V2_AUTO_RESUME_INBOUND || 'true').toLowerCase();
  if (enabled === '0' || enabled === 'false' || enabled === 'off') {
    return { enabled: false, matched: 0, enqueued: 0, execution_ids: [] };
  }

  const normalizedClinicId = toIntOrNull(clinicId);
  const normalizedConversationId = toIntOrNull(conversationId);
  const normalizedPatientId = toIntOrNull(patientId);
  const normalizedLeadId = toIntOrNull(leadId);
  const text = cleanString(messageText);

  if (!normalizedClinicId || !normalizedConversationId || !text) {
    return { enabled: true, matched: 0, enqueued: 0, execution_ids: [] };
  }

  const candidates = await FlowExecutionV2.findAll({
    where: {
      status: 'waiting',
      clinic_id: normalizedClinicId,
    },
    include: [{
      model: AutomationFlowTemplateV2,
      as: 'templateVersion',
      attributes: ['id', 'nodes'],
    }],
    order: [['id', 'ASC']],
    limit: 100,
  });

  const matched = candidates.filter((execution) => {
    if (!isWaitResponseNode(execution)) return false;
    return matchesExecutionTarget(execution, {
      conversationId: normalizedConversationId,
      patientId: normalizedPatientId,
      leadId: normalizedLeadId,
    });
  });

  let enqueued = 0;
  const executionIds = [];
  const errors = [];

  for (const execution of matched) {
    executionIds.push(execution.id);
    try {
      const job = await jobRequestsService.enqueueJobRequest({
        type: 'automations_v2_execute',
        priority: 'critical',
        origin: 'automations_v2_inbound',
        payload: {
          execution_id: execution.id,
          resume_mode: 'response',
          response_text: text,
          inbound_channel: channel,
          inbound_conversation_id: normalizedConversationId,
          inbound_message_id: inboundMessageId || null,
          inbound_patient_id: normalizedPatientId || null,
          inbound_lead_id: normalizedLeadId || null,
        },
      });

      // Menor latencia: intentamos disparo inmediato además del scheduler periódico.
      jobScheduler.triggerImmediate(job.id).catch(() => {});
      enqueued += 1;
    } catch (error) {
      errors.push({
        execution_id: execution.id,
        message: cleanString(error?.message) || 'enqueue_failed',
      });
    }
  }

  return {
    enabled: true,
    matched: matched.length,
    enqueued,
    execution_ids: executionIds,
    errors,
  };
}

module.exports = {
  enqueueInboundResponseResume,
};

