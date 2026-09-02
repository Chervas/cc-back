'use strict';

const db = require('../../models');
const { getIO } = require('./socket.service');

const ACTIVE_STAGES = new Set(['collecting', 'analyzing', 'applying']);
const VALID_STAGES = new Set([...ACTIVE_STAGES, 'review', 'completed', 'failed']);

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeStage(value) {
  const stage = cleanString(value)?.toLowerCase() || null;
  return stage && VALID_STAGES.has(stage) ? stage : 'collecting';
}

function normalizeStatus(value, stage) {
  const explicit = cleanString(value)?.toLowerCase() || null;
  if (['active', 'review', 'completed', 'failed'].includes(explicit)) return explicit;
  if (stage === 'review') return 'review';
  if (stage === 'failed') return 'failed';
  if (stage === 'completed') return 'completed';
  return 'active';
}

function buildStatePatch({
  clinicId,
  stage,
  status = null,
  sourceMessageId = undefined,
  firstMessageAt = undefined,
  deadlineAt = undefined,
  executionId = undefined,
  jobRequestId = undefined,
  appointmentId = undefined,
  appointmentStatus = undefined,
  intent = undefined,
  possibleUrgency = undefined,
  needsResponse = undefined,
  manualActionRequired = undefined,
  failureCode = undefined,
  completedAt = undefined,
}) {
  const normalizedStage = normalizeStage(stage);
  return {
    clinic_id: positiveInt(clinicId),
    stage: normalizedStage,
    status: normalizeStatus(status, normalizedStage),
    ...(sourceMessageId !== undefined ? { source_message_id: positiveInt(sourceMessageId) } : {}),
    ...(firstMessageAt !== undefined ? { first_message_at: firstMessageAt || null } : {}),
    ...(deadlineAt !== undefined ? { deadline_at: deadlineAt || null } : {}),
    ...(executionId !== undefined ? { execution_id: positiveInt(executionId) } : {}),
    ...(jobRequestId !== undefined ? { job_request_id: positiveInt(jobRequestId) } : {}),
    ...(appointmentId !== undefined ? { appointment_id: positiveInt(appointmentId) } : {}),
    ...(appointmentStatus !== undefined ? { appointment_status: cleanString(appointmentStatus) } : {}),
    ...(intent !== undefined ? { intent: cleanString(intent) } : {}),
    ...(possibleUrgency !== undefined ? { possible_urgency: possibleUrgency === true } : {}),
    ...(needsResponse !== undefined ? { needs_response: needsResponse === true } : {}),
    ...(manualActionRequired !== undefined ? { manual_action_required: manualActionRequired === true } : {}),
    ...(failureCode !== undefined ? { failure_code: cleanString(failureCode)?.slice(0, 96) || null } : {}),
    ...(completedAt !== undefined ? { completed_at: completedAt || null } : {}),
  };
}

function serializeState(row) {
  const state = row?.get ? row.get({ plain: true }) : (row || {});
  const stage = normalizeStage(state.stage);
  const status = normalizeStatus(state.status, stage);
  return {
    processing: status === 'active' && ACTIVE_STAGES.has(stage),
    status,
    stage,
    source_message_id: positiveInt(state.source_message_id),
    first_message_at: state.first_message_at || null,
    deadline_at: state.deadline_at || null,
    execution_id: positiveInt(state.execution_id),
    job_request_id: positiveInt(state.job_request_id),
    appointment_id: positiveInt(state.appointment_id),
    appointment_status: cleanString(state.appointment_status),
    intent: cleanString(state.intent),
    possible_urgency: state.possible_urgency === true || state.possible_urgency === 1,
    needs_response: state.needs_response === true || state.needs_response === 1,
    manual_action_required: state.manual_action_required === true || state.manual_action_required === 1,
    failure_code: cleanString(state.failure_code),
    completed_at: state.completed_at || null,
    updated_at: state.updated_at || state.updatedAt || null,
  };
}

function emitState(row) {
  const state = row?.get ? row.get({ plain: true }) : (row || {});
  const clinicId = positiveInt(state.clinic_id);
  const conversationId = positiveInt(state.conversation_id);
  const io = getIO();
  if (!io || !clinicId || !conversationId) return false;

  const serialized = serializeState(state);
  io.to(`clinic:${clinicId}`).emit('conversation:updated', {
    id: String(conversationId),
    automation_response_processing: serialized.processing,
    automation_response_processing_message_id: serialized.source_message_id,
    automation_processing_stage: serialized.stage,
    automation_processing_status: serialized.status,
    automation_processing_started_at: serialized.first_message_at,
    automation_processing_deadline_at: serialized.deadline_at,
    automation_action_appointment_id: serialized.appointment_id,
    automation_action_appointment_status: serialized.appointment_status,
    automation_intent: serialized.intent,
    automation_possible_urgency: serialized.possible_urgency,
    automation_needs_response: serialized.needs_response,
    automation_manual_action_required: serialized.manual_action_required,
  });
  return true;
}

async function setState({
  clinicId,
  conversationId,
  stage,
  status = null,
  sourceMessageId = undefined,
  firstMessageAt = undefined,
  deadlineAt = undefined,
  executionId = undefined,
  jobRequestId = undefined,
  appointmentId = undefined,
  appointmentStatus = undefined,
  intent = undefined,
  possibleUrgency = undefined,
  needsResponse = undefined,
  manualActionRequired = undefined,
  failureCode = undefined,
  completedAt = undefined,
}, options = {}) {
  const normalizedClinicId = positiveInt(clinicId);
  const normalizedConversationId = positiveInt(conversationId);
  if (!normalizedClinicId || !normalizedConversationId || !db.ConversationAutomationState) {
    return null;
  }

  const patch = buildStatePatch({
    clinicId: normalizedClinicId,
    stage,
    status,
    sourceMessageId,
    firstMessageAt,
    deadlineAt,
    executionId,
    jobRequestId,
    appointmentId,
    appointmentStatus,
    intent,
    possibleUrgency,
    needsResponse,
    manualActionRequired,
    failureCode,
    completedAt,
  });

  const transaction = options.transaction || null;
  let row;
  let created = false;
  try {
    [row, created] = await db.ConversationAutomationState.findOrCreate({
      where: { conversation_id: normalizedConversationId },
      defaults: {
        conversation_id: normalizedConversationId,
        source_message_id: null,
        possible_urgency: false,
        needs_response: false,
        manual_action_required: false,
        ...patch,
      },
      ...(transaction ? { transaction } : {}),
    });
  } catch (error) {
    if (error?.name !== 'SequelizeUniqueConstraintError') throw error;
    row = await db.ConversationAutomationState.findOne({
      where: { conversation_id: normalizedConversationId },
      ...(transaction ? { transaction } : {}),
    });
    if (!row) throw error;
  }
  if (!created) {
    await row.update(patch, transaction ? { transaction } : undefined);
  }

  if (options.emit !== false && !transaction) emitState(row);
  return row;
}

async function updateOwnedState(params, options = {}) {
  const normalizedClinicId = positiveInt(params?.clinicId);
  const normalizedConversationId = positiveInt(params?.conversationId);
  if (!normalizedClinicId || !normalizedConversationId || !db.ConversationAutomationState) {
    return null;
  }

  const where = {
    conversation_id: normalizedConversationId,
    clinic_id: normalizedClinicId,
  };
  if (Object.prototype.hasOwnProperty.call(options, 'expectedExecutionId')) {
    where.execution_id = positiveInt(options.expectedExecutionId);
  }
  if (Object.prototype.hasOwnProperty.call(options, 'expectedJobRequestId')) {
    where.job_request_id = positiveInt(options.expectedJobRequestId);
  }
  const transaction = options.transaction || null;
  const patch = buildStatePatch({ ...params, clinicId: normalizedClinicId });
  const [affected] = await db.ConversationAutomationState.update(patch, {
    where,
    ...(transaction ? { transaction } : {}),
  });
  if (!affected) return null;

  const row = await db.ConversationAutomationState.findOne({
    where: { conversation_id: normalizedConversationId },
    ...(transaction ? { transaction } : {}),
  });
  if (row && options.emit !== false && !transaction) emitState(row);
  return row;
}

async function completeState({ clinicId, conversationId, sourceMessageId = undefined }, options = {}) {
  const update = Object.prototype.hasOwnProperty.call(options, 'expectedExecutionId')
    || Object.prototype.hasOwnProperty.call(options, 'expectedJobRequestId')
    ? updateOwnedState
    : setState;
  return update({
    clinicId,
    conversationId,
    stage: 'completed',
    status: 'completed',
    sourceMessageId,
    manualActionRequired: false,
    completedAt: new Date(),
  }, options);
}

async function failState({ clinicId, conversationId, sourceMessageId = undefined, failureCode = null }, options = {}) {
  const update = Object.prototype.hasOwnProperty.call(options, 'expectedExecutionId')
    || Object.prototype.hasOwnProperty.call(options, 'expectedJobRequestId')
    ? updateOwnedState
    : setState;
  return update({
    clinicId,
    conversationId,
    stage: 'failed',
    status: 'failed',
    sourceMessageId,
    manualActionRequired: true,
    failureCode,
    completedAt: new Date(),
  }, options);
}

module.exports = {
  ACTIVE_STAGES,
  completeState,
  emitState,
  failState,
  serializeState,
  setState,
  updateOwnedState,
};
