'use strict';

const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const jobScheduler = require('./jobScheduler.service');
const { normalizePhoneDigits } = require('../lib/phone');

const FlowExecutionV2 = db.FlowExecutionV2;
const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const JobRequest = db.JobRequest;
const Message = db.Message;
const Op = db.Sequelize.Op;
const FORM_MATCH_MODES = new Set(['url_contains', 'url_equals', 'form_id', 'selector']);

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

function normalizeEmail(value) {
  return cleanString(value)?.toLowerCase() || null;
}

function normalizePhone(value) {
  return normalizePhoneDigits(value);
}

function detectCurrentRuntimeNamespace() {
  const explicit = cleanString(
    typeof jobRequestsService.getCurrentRuntimeNamespace === 'function'
      ? jobRequestsService.getCurrentRuntimeNamespace()
      : null
  );
  if (explicit) return explicit;

  const envNamespace = cleanString(process.env.JOB_RUNTIME_NAMESPACE) || cleanString(process.env.RUNTIME_NAMESPACE);
  if (envNamespace) return envNamespace;

  const port = cleanString(process.env.PORT);
  if (port) return `port:${port}`;

  const cwd = cleanString(process.cwd());
  if (cwd) return `cwd:${cwd}`;

  return 'runtime:unknown';
}

const CURRENT_RUNTIME_NAMESPACE = detectCurrentRuntimeNamespace();
const RUNTIME_ROLE = normalizeType(process.env.RUNTIME_ROLE);
const IS_GATEWAY_RUNTIME = RUNTIME_ROLE === 'gateway';
const FALLBACK_OWNER_RUNTIME_NAMESPACE = cleanString(process.env.AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE);

function getQueuedJobRuntimeNamespace(jobPayload = null) {
  if (!jobPayload || typeof jobPayload !== 'object' || Array.isArray(jobPayload)) return null;
  return cleanString(jobPayload.__runtime_namespace);
}

function getExecutionRuntimeNamespace(execution, queuedJob = null) {
  const waitingRuntime = cleanString(execution?.waiting_meta?.runtime_namespace);
  if (waitingRuntime) return waitingRuntime;
  return getQueuedJobRuntimeNamespace(queuedJob?.payload);
}

function isExecutionOwnedByCurrentRuntime(execution, queuedJob = null) {
  const ownerRuntime = getExecutionRuntimeNamespace(execution, queuedJob);
  if (!ownerRuntime) return true;
  return ownerRuntime === CURRENT_RUNTIME_NAMESPACE;
}

function resolveFallbackOwnerRuntimeNamespace() {
  if (FALLBACK_OWNER_RUNTIME_NAMESPACE) return FALLBACK_OWNER_RUNTIME_NAMESPACE;
  return IS_GATEWAY_RUNTIME ? null : CURRENT_RUNTIME_NAMESPACE;
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
  const outputs = context?.outputs && typeof context.outputs === 'object'
    ? Object.values(context.outputs).filter((value) => value && typeof value === 'object')
    : [];

  const ids = {
    conversation_id: null,
    lead_id: null,
    patient_id: null,
    appointment_id: null,
  };

  const conversationCandidates = [
    getByPath(context, 'conversation.id'),
    getByPath(context, 'trigger.data.conversation_id'),
    getByPath(context, 'trigger.data.conversationId'),
    ...outputs.map((output) => output.conversation_id),
    ...outputs.map((output) => output.chat_conversation_id),
  ];
  const leadCandidates = [
    getByPath(context, 'lead.id'),
    getByPath(context, 'lead.lead_intake_id'),
    getByPath(context, 'trigger.data.lead_id'),
    getByPath(context, 'trigger.data.leadId'),
    getByPath(context, 'trigger.data.lead_intake_id'),
    ...outputs.map((output) => output.lead_id),
    ...outputs.map((output) => output.recipient_lead_id),
  ];
  const patientCandidates = [
    getByPath(context, 'patient.id'),
    getByPath(context, 'patient.id_paciente'),
    getByPath(context, 'paciente.id'),
    getByPath(context, 'paciente.id_paciente'),
    getByPath(context, 'trigger.data.patient_id'),
    getByPath(context, 'trigger.data.patientId'),
    getByPath(context, 'trigger.data.paciente_id'),
    getByPath(context, 'appointment.paciente_id'),
    ...outputs.map((output) => output.patient_id),
    ...outputs.map((output) => output.recipient_patient_id),
  ];
  const appointmentCandidates = [
    getByPath(context, 'appointment.id'),
    getByPath(context, 'appointment.id_cita'),
    getByPath(context, 'trigger.data.appointment_id'),
    getByPath(context, 'trigger.data.cita_id'),
    ...outputs.map((output) => output.appointment_id),
    ...outputs
      .filter((output) => normalizeType(output?.target_type || output?.target_entity) === 'appointment')
      .map((output) => output.target_id),
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

  for (const candidate of appointmentCandidates) {
    const normalized = toIntOrNull(candidate);
    if (normalized) {
      ids.appointment_id = normalized;
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

function getWaitFormSubmissionNode(execution) {
  const nodeId = cleanString(execution?.current_node_id);
  if (!nodeId) return null;

  const nodes = Array.isArray(execution?.templateVersion?.nodes)
    ? execution.templateVersion.nodes
    : [];
  const currentNode = nodes.find((n) => cleanString(n?.id) === nodeId);
  if (cleanString(currentNode?.type) !== 'delay/wait_form_submission') {
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

async function getInboundMessageMediaContext(inboundMessageId) {
  const messageId = toIntOrNull(inboundMessageId);
  if (!messageId) return null;
  const message = await Message.findByPk(messageId, {
    attributes: ['id', 'metadata'],
    raw: true,
  });
  const metadata = message?.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};
  const media = metadata.media && typeof metadata.media === 'object'
    ? metadata.media
    : null;
  const kind = cleanString(media?.kind)?.toLowerCase() || null;
  if (!kind) return null;
  return {
    kind,
    id: cleanString(media?.id) || null,
    mime_type: cleanString(media?.mime_type) || null,
    sha256: cleanString(media?.sha256) || null,
    provider: cleanString(media?.provider) || null,
    playable: Boolean(media?.playable),
  };
}

function resolvePositiveInt(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseWhatsAppTimestampOrNull(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const ms = numeric > 100000000000 ? numeric : numeric * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getProviderSentAtFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const timestamps = metadata.wa_status_timestamps && typeof metadata.wa_status_timestamps === 'object'
    ? metadata.wa_status_timestamps
    : {};
  const direct = parseWhatsAppTimestampOrNull(timestamps.sent);
  if (direct) return direct;

  const history = Array.isArray(metadata.wa_status_history) ? metadata.wa_status_history : [];
  const sentEntry = history.find((entry) => normalizeType(entry?.status) === 'sent' && entry?.timestamp);
  return parseWhatsAppTimestampOrNull(sentEntry?.timestamp);
}

function resolveDurationMs(duration, unit) {
  const amount = Number.parseFloat(String(duration ?? ''));
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 60;
  const normalizedUnit = cleanString(unit) || 'minutes';
  switch (normalizedUnit) {
    case 'seconds':
    case 'second':
      return safeAmount * 1000;
    case 'minutes':
    case 'minute':
      return safeAmount * 60 * 1000;
    case 'hours':
    case 'hour':
      return safeAmount * 60 * 60 * 1000;
    case 'days':
    case 'day':
      return safeAmount * 24 * 60 * 60 * 1000;
    default:
      return safeAmount * 60 * 1000;
  }
}

function getResponseBufferConfig(waitNode) {
  const cfg = waitNode?.config && typeof waitNode.config === 'object' ? waitNode.config : {};
  const explicitDelayMs = resolvePositiveInt(cfg.response_buffer_delay_ms);
  const explicitDelaySeconds = resolvePositiveInt(cfg.response_buffer_delay_seconds);
  const envDelayMs = resolvePositiveInt(process.env.AUTOMATIONS_V2_RESPONSE_BUFFER_MS);
  const envDelaySeconds = resolvePositiveInt(process.env.AUTOMATIONS_V2_RESPONSE_BUFFER_SECONDS);
  const resolvedDelayMs = explicitDelayMs
    ?? (explicitDelaySeconds !== null ? explicitDelaySeconds * 1000 : null)
    ?? envDelayMs
    ?? (envDelaySeconds !== null ? envDelaySeconds * 1000 : null)
    ?? 90 * 1000;
  return {
    enabled: parseBool(cfg.response_buffer_enabled, true),
    delayMs: resolvedDelayMs,
  };
}

async function findQueuedResumeJob(executionId, resumeMode) {
  const execution = toIntOrNull(executionId);
  const normalizedMode = cleanString(resumeMode);
  if (!execution || !normalizedMode) return null;
  const rows = await db.sequelize.query(
    `
    SELECT id, status, next_run_at
    FROM JobRequests
    WHERE type = 'automations_v2_execute'
      AND status IN ('pending', 'waiting', 'running')
      AND (
        JSON_EXTRACT(payload, '$.execution_id') = :executionId
        OR JSON_EXTRACT(payload, '$.executionId') = :executionId
      )
      AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resume_mode')) = :resumeMode
    ORDER BY id DESC
    LIMIT 1
    `,
    {
      replacements: { executionId: execution, resumeMode: normalizedMode },
      type: db.sequelize.QueryTypes.SELECT,
    }
  );
  return rows?.[0] || null;
}

async function findQueuedResponseResumeJob(executionId) {
  return findQueuedResumeJob(executionId, 'response');
}

async function findQueuedExecutionJob(executionId) {
  const execution = toIntOrNull(executionId);
  if (!execution) return null;
  const rows = await db.sequelize.query(
    `
    SELECT id, status, next_run_at, payload
    FROM JobRequests
    WHERE type = 'automations_v2_execute'
      AND status IN ('pending', 'waiting', 'running')
      AND (
        JSON_EXTRACT(payload, '$.execution_id') = :executionId
        OR JSON_EXTRACT(payload, '$.executionId') = :executionId
      )
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

function getWaitResponseNodes(execution) {
  const nodes = Array.isArray(execution?.templateVersion?.nodes)
    ? execution.templateVersion.nodes
    : [];
  return nodes.filter((node) => cleanString(node?.type) === 'delay/wait_response');
}

async function resolveLateTimedOutWaitRecovery(execution, {
  conversationId,
  inboundAt,
}) {
  if (!Message || !conversationId || !inboundAt) return null;

  const context = execution?.context && typeof execution.context === 'object'
    ? execution.context
    : {};
  const outputs = context?.outputs && typeof context.outputs === 'object'
    ? context.outputs
    : {};
  const waitNodes = getWaitResponseNodes(execution);

  for (const waitNode of waitNodes) {
    const waitNodeId = cleanString(waitNode?.id);
    if (!waitNodeId) continue;

    const waitOutput = outputs[waitNodeId];
    if (!waitOutput || cleanString(waitOutput.status) !== 'timed_out') continue;

    const listensTo = cleanString(waitOutput.listens_to_node_id) || cleanString(waitNode?.config?.listens_to_node_id);
    const listenedOutput = listensTo ? outputs[listensTo] : null;
    if (!listenedOutput || Number(listenedOutput.conversation_id || 0) !== Number(conversationId)) continue;

    const outboundMessageId = toIntOrNull(listenedOutput.message_id);
    if (!outboundMessageId) continue;

    const outboundMessage = await Message.findByPk(outboundMessageId, {
      attributes: ['id', 'sent_at', 'createdAt', 'metadata'],
      raw: true,
    });
    if (!outboundMessage) continue;

    const actualSendAt =
      getProviderSentAtFromMetadata(outboundMessage.metadata)
      || parseDateOrNull(listenedOutput.effective_send_at)
      || parseDateOrNull(listenedOutput.scheduled_for)
      || parseDateOrNull(outboundMessage.sent_at)
      || parseDateOrNull(outboundMessage.createdAt)
      || parseDateOrNull(listenedOutput.at);
    const recordedTimeoutAt = parseDateOrNull(waitOutput.timeout_at);
    if (!actualSendAt || !recordedTimeoutAt) continue;

    // Recuperar solo el caso problemático: el proveedor marca el envío real
    // después del timeout que ya había vencido desde la creación/cola local.
    if (actualSendAt.getTime() <= recordedTimeoutAt.getTime()) continue;

    const timeoutMs = resolveDurationMs(waitNode?.config?.timeout_duration ?? 60, waitNode?.config?.timeout_unit || 'minutes');
    const allowedUntil = new Date(actualSendAt.getTime() + timeoutMs);
    if (inboundAt.getTime() < actualSendAt.getTime() || inboundAt.getTime() > allowedUntil.getTime()) continue;

    return {
      waitNode,
      waitNodeId,
      listensTo,
      runtimeNamespace: cleanString(waitOutput.runtime_namespace)
        || cleanString(execution?.waiting_meta?.runtime_namespace)
        || resolveFallbackOwnerRuntimeNamespace(),
      actualSendAt,
      allowedUntil,
      recordedTimeoutAt,
      outboundMessageId,
    };
  }

  return null;
}

async function recoverLateTimedOutResponseMatches({
  clinicId,
  conversationId,
  patientId,
  leadId,
  inboundMessageId,
}) {
  const normalizedClinicId = toIntOrNull(clinicId);
  const normalizedConversationId = toIntOrNull(conversationId);
  if (!Message || !normalizedClinicId || !normalizedConversationId || !inboundMessageId) {
    return [];
  }

  const inboundMessage = await Message.findByPk(inboundMessageId, {
    attributes: ['id', 'sent_at', 'createdAt'],
    raw: true,
  });
  const inboundAt = parseDateOrNull(inboundMessage?.sent_at) || parseDateOrNull(inboundMessage?.createdAt) || new Date();
  const since = new Date(inboundAt.getTime() - 14 * 24 * 60 * 60 * 1000);

  const candidates = await FlowExecutionV2.findAll({
    where: {
      status: 'completed',
      clinic_id: normalizedClinicId,
      updated_at: { [Op.gte]: since },
    },
    include: [{
      model: AutomationFlowTemplateV2,
      as: 'templateVersion',
      attributes: ['id', 'nodes'],
    }],
    order: [['id', 'DESC']],
    limit: 100,
  });

  const recovered = [];
  for (const execution of candidates) {
    if (!matchesExecutionTarget(execution, {
      conversationId: normalizedConversationId,
      patientId,
      leadId,
    })) {
      continue;
    }

    const recovery = await resolveLateTimedOutWaitRecovery(execution, {
      conversationId: normalizedConversationId,
      inboundAt,
    });
    if (!recovery) continue;

    await execution.update({
      status: 'waiting',
      current_node_id: recovery.waitNodeId,
      wait_until: null,
      waiting_meta: {
        type: 'delay/wait_response',
        runtime_namespace: recovery.runtimeNamespace || CURRENT_RUNTIME_NAMESPACE,
        listens_to_node_id: recovery.listensTo,
        wait_starts_at: recovery.actualSendAt.toISOString(),
        recovered_after_provider_send_at: true,
        original_timeout_at: recovery.recordedTimeoutAt.toISOString(),
        adjusted_timeout_at: recovery.allowedUntil.toISOString(),
        outbound_message_id: recovery.outboundMessageId,
        on_response: cleanString(recovery.waitNode?.outputs?.on_response) || null,
        on_timeout: cleanString(recovery.waitNode?.outputs?.on_timeout) || null,
        response_buffer_enabled: parseBool(recovery.waitNode?.config?.response_buffer_enabled, true),
      },
      last_error: null,
    });

    recovered.push(execution);
  }

  return recovered;
}

async function cancelQueuedExecutionJob(executionId, reason) {
  const queuedJob = await findQueuedExecutionJob(executionId);
  if (!queuedJob) return;
  const queuedStatus = cleanString(queuedJob.status);
  if (queuedStatus === 'waiting' || queuedStatus === 'pending' || queuedStatus === 'running') {
    await jobRequestsService.markCancelled(queuedJob.id, {
      errorMessage: reason || 'cancelled',
    });
  }
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
  // Para respuestas inbound no debemos hacer match por appointment_id: una ejecución
  // disparada por cita siempre cumple su propio trigger_entity_id y eso abriría el
  // flujo a cualquier mensaje entrante de la clínica.
  const contextIds = collectContextIds(execution);
  if (contextIds.conversation_id && contextIds.conversation_id === conversationId) return true;
  if (leadId && contextIds.lead_id && contextIds.lead_id === leadId) return true;
  if (patientId && contextIds.patient_id && contextIds.patient_id === patientId) return true;

  return false;
}

function collectExecutionContactPoints(execution) {
  const context = execution?.context && typeof execution.context === 'object'
    ? execution.context
    : {};

  const phoneCandidates = [
    getByPath(context, 'patient.telefono'),
    getByPath(context, 'patient.telefono_movil'),
    getByPath(context, 'paciente.telefono'),
    getByPath(context, 'paciente.telefono_movil'),
    getByPath(context, 'lead.telefono'),
    getByPath(context, 'appointment.telefono'),
    getByPath(context, 'trigger.data.telefono'),
  ]
    .map((value) => normalizePhone(value))
    .filter(Boolean);

  const emailCandidates = [
    getByPath(context, 'patient.email'),
    getByPath(context, 'paciente.email'),
    getByPath(context, 'lead.email'),
    getByPath(context, 'appointment.email'),
    getByPath(context, 'trigger.data.email'),
  ]
    .map((value) => normalizeEmail(value))
    .filter(Boolean);

  const leadIdCandidates = [
    getByPath(context, 'lead.id'),
    getByPath(context, 'lead.lead_intake_id'),
    getByPath(context, 'trigger.data.lead_id'),
    getByPath(context, 'trigger.data.lead_intake_id'),
  ]
    .map((value) => toIntOrNull(value))
    .filter(Boolean);

  return {
    phones: Array.from(new Set(phoneCandidates)),
    emails: Array.from(new Set(emailCandidates)),
    lead_ids: Array.from(new Set(leadIdCandidates)),
  };
}

function matchesFormSubmissionTarget(execution, { leadId, phone, email }) {
  const target = collectExecutionContactPoints(execution);
  if (leadId && target.lead_ids.includes(leadId)) return true;
  if (phone && target.phones.includes(phone)) return true;
  if (email && target.emails.includes(email)) return true;
  return false;
}

function normalizeFormMatchMode(value) {
  const normalized = normalizeType(value);
  return FORM_MATCH_MODES.has(normalized) ? normalized : null;
}

function matchesFormSubmissionRule(execution, waitNode, submission) {
  const waitingMeta = execution?.waiting_meta && typeof execution.waiting_meta === 'object'
    ? execution.waiting_meta
    : {};
  const config = waitNode?.config && typeof waitNode.config === 'object'
    ? waitNode.config
    : {};

  const matchMode = normalizeFormMatchMode(waitingMeta.match_mode || config.match_mode);
  const matchValue = cleanString(waitingMeta.match_value || config.match_value);
  if (!matchMode || !matchValue) return false;

  const pageUrl = cleanString(submission?.page_url) || '';
  const formId = cleanString(submission?.form_id) || '';
  const selector = cleanString(submission?.form_selector) || '';

  switch (matchMode) {
    case 'url_contains':
      return pageUrl.toLowerCase().includes(matchValue.toLowerCase());
    case 'url_equals':
      return pageUrl.toLowerCase() === matchValue.toLowerCase();
    case 'form_id':
      return formId.toLowerCase() === matchValue.toLowerCase();
    case 'selector':
      return selector.toLowerCase() === matchValue.toLowerCase();
    default:
      return false;
  }
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
  const inboundMedia = await getInboundMessageMediaContext(inboundMessageId);
  const hasResumableMedia = inboundMedia?.kind === 'sticker';

  if (!normalizedClinicId || !normalizedConversationId || (!text && !hasResumableMedia)) {
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

  const recoveredLateMatches = matched.length
    ? []
    : await recoverLateTimedOutResponseMatches({
        clinicId: normalizedClinicId,
        conversationId: normalizedConversationId,
        patientId: normalizedPatientId,
        leadId: normalizedLeadId,
        inboundMessageId,
      });

  let effectiveMatches = matched.length ? matched : recoveredLateMatches;
  const supersededExecutionIds = [];

  if (normalizedConversationId && effectiveMatches.length > 1) {
    const sorted = [...effectiveMatches].sort((a, b) => {
      const byId = Number(b.id || 0) - Number(a.id || 0);
      if (byId !== 0) return byId;
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });

    const newest = sorted[0];
    const staleExecutions = sorted.slice(1);

    for (const staleExecution of staleExecutions) {
      supersededExecutionIds.push(staleExecution.id);
      const existingWaitingMeta = staleExecution.waiting_meta && typeof staleExecution.waiting_meta === 'object'
        ? staleExecution.waiting_meta
        : {};

      await staleExecution.update({
        status: 'cancelled',
        current_node_id: null,
        wait_until: null,
        waiting_meta: {
          ...existingWaitingMeta,
          cancelled_reason: 'superseded_by_newer_waiting_execution',
          superseded_by_execution_id: newest.id,
          cancelled_at: new Date().toISOString(),
        },
      });

      await cancelQueuedExecutionJob(staleExecution.id, 'superseded_by_newer_waiting_execution');
    }

    effectiveMatches = newest ? [newest] : [];
  }

  let enqueued = 0;
  const executionIds = [];
  const errors = [];

  for (const execution of effectiveMatches) {
    executionIds.push(execution.id);
    try {
      const queuedJob = await findQueuedExecutionJob(execution.id);
      const waitNode = getWaitResponseNode(execution);
      const buffer = getResponseBufferConfig(waitNode);
      const ownerRuntime = getExecutionRuntimeNamespace(execution, queuedJob) || CURRENT_RUNTIME_NAMESPACE;
      if (!IS_GATEWAY_RUNTIME && ownerRuntime !== CURRENT_RUNTIME_NAMESPACE) {
        errors.push({
          execution_id: execution.id,
          message: `owned_by_other_runtime:${ownerRuntime}`,
        });
        continue;
      }

      if (buffer.enabled) {
        const waitUntil = new Date(Date.now() + buffer.delayMs);
        const existingWaitingMeta = execution.waiting_meta && typeof execution.waiting_meta === 'object'
          ? execution.waiting_meta
          : {};
        const normalizedInboundMessageId = toIntOrNull(inboundMessageId);
        const lastInboundMessageId = toIntOrNull(existingWaitingMeta.last_inbound_message_id);
        const sameInboundMessage = normalizedInboundMessageId
          && lastInboundMessageId
          && normalizedInboundMessageId === lastInboundMessageId;
        const mergedText = sameInboundMessage
          ? (cleanString(existingWaitingMeta.pending_response_text) || text)
          : appendMultilineText(existingWaitingMeta.pending_response_text, text);
        const pendingCount = sameInboundMessage
          ? Math.max(1, Number(existingWaitingMeta.pending_response_count || 1))
          : Number(existingWaitingMeta.pending_response_count || 0) + 1;

        await execution.update({
          status: 'waiting',
          wait_until: waitUntil,
          waiting_meta: {
            ...existingWaitingMeta,
            runtime_namespace: ownerRuntime,
            resume_mode: 'response',
            pending_response_text: mergedText,
            pending_response_count: pendingCount,
            last_inbound_message_at: new Date().toISOString(),
            last_inbound_message_id: inboundMessageId || null,
            last_inbound_media_kind: inboundMedia?.kind || null,
            last_inbound_media_id: inboundMedia?.id || null,
            last_inbound_media_mime_type: inboundMedia?.mime_type || null,
            inbound_channel: channel,
          },
        });

        const queuedPayload = queuedJob?.payload && typeof queuedJob.payload === 'object'
          ? queuedJob.payload
          : {};
        const responsePayload = {
          ...queuedPayload,
          execution_id: execution.id,
          executionId: execution.id,
          resume_mode: 'response',
          response_text: mergedText,
          response_media_kind: inboundMedia?.kind || null,
          response_media_id: inboundMedia?.id || null,
          response_media_mime_type: inboundMedia?.mime_type || null,
          inbound_channel: channel,
          inbound_conversation_id: normalizedConversationId,
          inbound_message_id: inboundMessageId || null,
          inbound_patient_id: normalizedPatientId || null,
          inbound_lead_id: normalizedLeadId || null,
          __runtime_namespace: ownerRuntime,
        };
        const queuedResumeJob = await findQueuedResponseResumeJob(execution.id);
        const queuedResumeStatus = cleanString(queuedResumeJob?.status);

        if (queuedResumeJob && (queuedResumeStatus === 'waiting' || queuedResumeStatus === 'pending' || queuedResumeStatus === 'running')) {
          await JobRequest.update(
            {
              status: 'waiting',
              next_run_at: waitUntil,
              payload: responsePayload,
              error_message: null,
              result_summary: null,
              updated_at: new Date(),
            },
            { where: { id: queuedResumeJob.id } }
          );
        } else {
          await jobRequestsService.enqueueJobRequest({
            type: 'automations_v2_execute',
            priority: 'critical',
            status: 'waiting',
            origin: 'automations_v2_inbound',
            nextRunAt: waitUntil,
            payload: responsePayload,
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
            executionId: execution.id,
            resume_mode: 'response',
            response_text: text,
            response_media_kind: inboundMedia?.kind || null,
            response_media_id: inboundMedia?.id || null,
            response_media_mime_type: inboundMedia?.mime_type || null,
            inbound_channel: channel,
            inbound_conversation_id: normalizedConversationId,
            inbound_message_id: inboundMessageId || null,
            inbound_patient_id: normalizedPatientId || null,
            inbound_lead_id: normalizedLeadId || null,
            __runtime_namespace: ownerRuntime,
          },
        });

        // Menor latencia: intentamos disparo inmediato además del scheduler periódico.
        if (ownerRuntime === CURRENT_RUNTIME_NAMESPACE) {
          jobScheduler.triggerImmediate(job.id).catch(() => {});
        }
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
    matched: effectiveMatches.length,
    enqueued,
    execution_ids: executionIds,
    superseded_execution_ids: supersededExecutionIds,
    errors,
  };
}

async function enqueueInboundFormSubmissionResume({
  clinicId,
  leadId = null,
  email = null,
  phone = null,
  pageUrl = null,
  formId = null,
  formName = null,
  formSelector = null,
  fields = null,
  submittedAt = null,
  formSubmissionEventId = null,
  sourceDetail = 'web_form',
  payload = null,
}) {
  const enabled = String(process.env.AUTOMATIONS_V2_AUTO_RESUME_FORM || 'true').toLowerCase();
  if (enabled === '0' || enabled === 'false' || enabled === 'off') {
    return { enabled: false, matched: 0, enqueued: 0, execution_ids: [] };
  }

  const normalizedClinicId = toIntOrNull(clinicId);
  const normalizedLeadId = toIntOrNull(leadId);
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const normalizedPageUrl = cleanString(pageUrl);
  const normalizedFormId = cleanString(formId);
  const normalizedFormName = cleanString(formName);
  const normalizedFormSelector = cleanString(formSelector);
  const normalizedSubmittedAt = cleanString(submittedAt) || new Date().toISOString();
  const normalizedFields = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};

  if (!normalizedClinicId || (!normalizedLeadId && !normalizedEmail && !normalizedPhone)) {
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

  const submission = {
    page_url: normalizedPageUrl,
    form_id: normalizedFormId,
    form_name: normalizedFormName,
    form_selector: normalizedFormSelector,
    fields: normalizedFields,
    submitted_at: normalizedSubmittedAt,
    lead_intake_id: normalizedLeadId,
    email: normalizedEmail,
    telefono: normalizedPhone,
    form_submission_event_id: toIntOrNull(formSubmissionEventId),
    source_detail: cleanString(sourceDetail) || 'web_form',
    payload: payload && typeof payload === 'object' ? payload : null,
  };

  const matched = candidates.filter((execution) => {
    const waitNode = getWaitFormSubmissionNode(execution);
    if (!waitNode) return false;
    if (!matchesFormSubmissionTarget(execution, {
      leadId: normalizedLeadId,
      phone: normalizedPhone,
      email: normalizedEmail,
    })) {
      return false;
    }
    return matchesFormSubmissionRule(execution, waitNode, submission);
  });

  let enqueued = 0;
  const executionIds = [];
  const errors = [];

  for (const execution of matched) {
    executionIds.push(execution.id);
    try {
      const queuedJob = await findQueuedExecutionJob(execution.id);
      const ownerRuntime = getExecutionRuntimeNamespace(execution, queuedJob) || CURRENT_RUNTIME_NAMESPACE;
      if (!IS_GATEWAY_RUNTIME && !isExecutionOwnedByCurrentRuntime(execution, queuedJob)) {
        errors.push({
          execution_id: execution.id,
          message: `owned_by_other_runtime:${ownerRuntime}`,
        });
        continue;
      }

      const existingWaitingMeta = execution.waiting_meta && typeof execution.waiting_meta === 'object'
        ? execution.waiting_meta
        : {};

      await execution.update({
        status: 'waiting',
        wait_until: new Date(),
        waiting_meta: {
          ...existingWaitingMeta,
          runtime_namespace: ownerRuntime,
          resume_mode: 'form_submission',
          pending_form_submission: submission,
          last_form_submission_at: normalizedSubmittedAt,
          last_form_submission_event_id: toIntOrNull(formSubmissionEventId),
        },
      });

      const queuedResumeJob = await findQueuedResumeJob(execution.id, 'form_submission');
      if (queuedResumeJob) {
        if (cleanString(queuedResumeJob.status) === 'waiting') {
          await JobRequest.update(
            {
              next_run_at: new Date(),
              updated_at: new Date(),
            },
            { where: { id: queuedResumeJob.id } }
          );
        }
      } else {
        const job = await jobRequestsService.enqueueJobRequest({
          type: 'automations_v2_execute',
          priority: 'critical',
          origin: 'automations_v2_form_submission',
          payload: {
            execution_id: execution.id,
            executionId: execution.id,
            resume_mode: 'form_submission',
            form_submission_event_id: toIntOrNull(formSubmissionEventId),
            lead_intake_id: normalizedLeadId,
            email: normalizedEmail,
            phone: normalizedPhone,
            __runtime_namespace: ownerRuntime,
          },
        });
        if (ownerRuntime === CURRENT_RUNTIME_NAMESPACE) {
          jobScheduler.triggerImmediate(job.id).catch(() => {});
        }
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
  enqueueInboundFormSubmissionResume,
};
