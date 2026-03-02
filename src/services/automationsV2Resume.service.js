'use strict';

const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const jobScheduler = require('./jobScheduler.service');

const FlowExecutionV2 = db.FlowExecutionV2;
const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const JobRequest = db.JobRequest;

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

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
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

function getWaitResponseNode(execution) {
  const nodeId = cleanString(execution?.current_node_id);
  if (!nodeId) return null;

  const nodes = Array.isArray(execution?.templateVersion?.nodes)
    ? execution.templateVersion.nodes
    : [];
  const currentNode = nodes.find((n) => cleanString(n?.id) === nodeId);
  if (cleanString(currentNode?.type) !== 'delay/wait_response') {
    return null;
  }
  return currentNode;
}

function appendMultilineText(baseText, nextText) {
  const base = cleanString(baseText);
  const next = cleanString(nextText);
  if (!next) return base || '';
  if (!base) return next;
  return `${base}\n${next}`;
}

function getResponseBufferConfig(waitNode) {
  const cfg = waitNode?.config && typeof waitNode.config === 'object' ? waitNode.config : {};
  return {
    enabled: parseBool(cfg.response_buffer_enabled, true),
    delayMs: 60 * 1000,
  };
}

async function findQueuedResponseResumeJob(executionId) {
  const execution = toIntOrNull(executionId);
  if (!execution) return null;
  const rows = await db.sequelize.query(
    `
    SELECT id, status, next_run_at
    FROM JobRequests
    WHERE type = 'automations_v2_execute'
      AND status IN ('pending', 'waiting', 'running')
      AND JSON_EXTRACT(payload, '$.execution_id') = :executionId
      AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resume_mode')) = 'response'
    ORDER BY id DESC
    LIMIT 1
    `,
    {
      replacements: { executionId: execution },
      type: db.sequelize.QueryTypes.SELECT,
    }
  );
  return rows?.[0] || null;
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
    if (!getWaitResponseNode(execution)) return false;
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
      const waitNode = getWaitResponseNode(execution);
      const buffer = getResponseBufferConfig(waitNode);

      if (buffer.enabled) {
        const waitUntil = new Date(Date.now() + buffer.delayMs);
        const existingWaitingMeta = execution.waiting_meta && typeof execution.waiting_meta === 'object'
          ? execution.waiting_meta
          : {};
        const mergedText = appendMultilineText(existingWaitingMeta.pending_response_text, text);
        const pendingCount = Number(existingWaitingMeta.pending_response_count || 0) + 1;

        await execution.update({
          status: 'waiting',
          wait_until: waitUntil,
          waiting_meta: {
            ...existingWaitingMeta,
            resume_mode: 'response',
            pending_response_text: mergedText,
            pending_response_count: pendingCount,
            last_inbound_message_at: new Date().toISOString(),
            last_inbound_message_id: inboundMessageId || null,
            inbound_channel: channel,
          },
        });

        const queuedJob = await findQueuedResponseResumeJob(execution.id);
        if (queuedJob) {
          if (cleanString(queuedJob.status) === 'waiting') {
            await JobRequest.update(
              {
                next_run_at: waitUntil,
                updated_at: new Date(),
              },
              { where: { id: queuedJob.id } }
            );
          }
        } else {
          await jobRequestsService.enqueueJobRequest({
            type: 'automations_v2_execute',
            priority: 'critical',
            status: 'waiting',
            nextRunAt: waitUntil,
            origin: 'automations_v2_inbound_buffer',
            payload: {
              execution_id: execution.id,
              resume_mode: 'response',
              inbound_channel: channel,
              inbound_conversation_id: normalizedConversationId,
              inbound_message_id: inboundMessageId || null,
              inbound_patient_id: normalizedPatientId || null,
              inbound_lead_id: normalizedLeadId || null,
            },
          });
          enqueued += 1;
        }
      } else {
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
      }
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
