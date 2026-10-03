'use strict';

const { Op } = require('sequelize');
const { templateFamilyKey } = require('./appointment-template-scope');
const STOP_REASON = 'automation_deactivated';
const OPEN_STATUSES = ['running', 'waiting', 'paused'];
const models = () => require('../../models');
const stopped = code => Object.assign(Error(code || STOP_REASON), {
  code: code || STOP_REASON, retryable: false, preserveFlowState: true,
});
const isStop = error => [STOP_REASON, 'automation_execution_stopped'].includes(error?.code);
const simulation = execution => execution?.context?.__simulation === true;

function familyWhere(template) {
  return {
    ...(template.public_id ? { public_id: template.public_id } : { template_key: template.template_key }),
    clinic_id: template.clinic_id ?? null,
    group_id: template.group_id ?? null,
  };
}

async function familyRows(template, transaction) {
  return models().AutomationFlowTemplateV2.findAll({
    where: familyWhere(template), order: [['id', 'ASC']], transaction,
    ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
}

function latestPublished(rows) {
  return rows.filter(row => row.published_at).sort((a, b) => Number(b.version) - Number(a.version) || Number(b.id) - Number(a.id))[0];
}

async function acceptedSelfDeactivatedEnd(execution, template, transaction) {
  if (!execution || execution.status !== 'running' || Number(template.id) !== Number(execution.template_version_id)
    || template.trigger_config?.managed_feature !== 'google_special_hours'
    || !template.trigger_config.last_executed_at) return false;
  const end = (template.nodes || []).find(node => node.id === execution.current_node_id);
  if (end?.type !== 'control/end' || Object.values(end.outputs || {}).some(Boolean)) return false;
  const accepted = (template.nodes || []).find(node => node.type === 'action/update_google_special_hours'
    && node.config?.auto_deactivate_after_execution === true && node.outputs?.on_success === end.id
    && (execution.context?.outputs?.[node.id]?.provider_status === 'synced'
      && execution.context.outputs[node.id].at === template.trigger_config.last_executed_at
      || execution.context?.outputs?.[node.id]?.auto_deactivated_at === template.trigger_config.last_executed_at));
  if (!accepted) return false;
  const log = await models().FlowExecutionLogV2.findOne({ where: {
    flow_execution_id: execution.id, node_id: accepted.id, status: 'success',
  }, order: [['id', 'DESC']], transaction });
  const audit = log?.audit_snapshot, output = execution.context.outputs[accepted.id];
  return audit?.kind === 'success' && audit.next_node_id === end.id
    && (output.provider_status === 'synced' && !!audit.node_output_after?.operation_id
      && audit.node_output_after.operation_id === output.operation_id
      || !!output.auto_deactivated_at && audit.node_output_after?.auto_deactivated_at === output.auto_deactivated_at);
}

async function assertTemplateActive(template, transaction, { terminalExecution } = {}) {
  const latest = transaction ? latestPublished(await familyRows(template, transaction))
    : await models().AutomationFlowTemplateV2.findOne({ where: { ...familyWhere(template), published_at: { [Op.ne]: null } },
      order: [['version', 'DESC'], ['id', 'DESC']] });
  // Typed GBP acceptance may disable its one-shot template atomically. Only its
  // audited, side-effect-free end may finish; manual stops still cancel the row.
  if (!latest || !latest.is_active && !await acceptedSelfDeactivatedEnd(terminalExecution, latest, transaction)) throw stopped();
  return latest;
}

// Lock order is family -> execution -> job/clinical row. No provider call is
// held inside these transactions; an already started request cannot be undone.
async function assertExecutionActive(execution, transaction, { allowCompleted = false, allowSelfDeactivatedEnd = false } = {}) {
  if (simulation(execution)) return execution;
  const db = models();
  const pinned = execution.templateVersion;
  const template = pinned?.public_id && pinned?.template_key ? pinned
    : await db.AutomationFlowTemplateV2.findByPk(execution.template_version_id, { transaction });
  if (!template) throw stopped();
  if (template.clinic_id != null && Number(template.clinic_id) !== Number(execution.clinic_id)
    || template.clinic_id == null && template.group_id != null && Number(template.group_id) !== Number(execution.group_id)) throw stopped();
  if (template.clinic_id == null && execution.clinic_id) {
    const base = templateFamilyKey(template);
    const scoped = await db.AutomationFlowTemplateV2.findAll({ where: {
      clinic_id: execution.clinic_id, template_key: { [Op.in]: [`${base}__clinic_${execution.clinic_id}`, `${base}_clinic_${execution.clinic_id}`] },
      published_at: { [Op.ne]: null },
    }, order: [['id', 'ASC']], transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    const local = latestPublished(scoped);
    if (local && !local.is_active) throw stopped();
  }
  await assertTemplateActive(template, transaction, { terminalExecution: allowSelfDeactivatedEnd ? execution : null });
  const current = await db.FlowExecutionV2.findByPk(execution.id, {
    transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!current || ![...OPEN_STATUSES, ...(allowCompleted ? ['completed'] : [])].includes(current.status)) {
    throw stopped('automation_execution_stopped');
  }
  return current;
}

async function createExecution(values, { jobClaim } = {}) {
  const db = models();
  if (values.context?.__simulation === true) return db.FlowExecutionV2.create(values);
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const template = await db.AutomationFlowTemplateV2.findByPk(values.template_version_id, { transaction });
    if (!template) throw stopped();
    await assertTemplateActive(template, transaction);
    if (jobClaim) await jobClaim.assert({ transaction });
    return db.FlowExecutionV2.create(values, { transaction });
  });
}

async function updateExecution(execution, patch, options = {}) {
  const db = models();
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const current = await assertExecutionActive(execution, transaction, options);
    if (current.status !== execution.status || current.current_node_id !== execution.current_node_id) {
      throw stopped('automation_execution_stopped');
    }
    return execution.update(patch, { transaction });
  });
}

async function assertMessageCanDispatch(messageId) {
  if (!messageId) return;
  const db = models();
  const message = await db.Message.findByPk(messageId);
  const metadata = message?.metadata || {};
  if (!['automations_v2', 'automation_v2'].includes(metadata.source) || !metadata.execution_id) return;
  if (metadata.cancelled || metadata.cancellation_reason === STOP_REASON) throw stopped();
  const execution = await db.FlowExecutionV2.findByPk(metadata.execution_id);
  if (!execution) throw stopped('automation_execution_stopped');
  await assertExecutionActive(execution, undefined, { allowCompleted: true });
}

async function cancelMessage(messageId) {
  await models().sequelize.query(`UPDATE Messages SET status='failed',
    metadata=JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.cancelled', true,
      '$.cancelled_at', :now, '$.cancellation_reason', :reason, '$.error', :reason)
    WHERE id=:id AND status IN ('pending','sending','failed')
    AND JSON_EXTRACT(metadata, '$.wamid') IS NULL AND JSON_EXTRACT(metadata, '$.provider_acceptance_at') IS NULL
    AND JSON_EXTRACT(metadata, '$.wa_response') IS NULL AND JSON_EXTRACT(metadata, '$.delivery_unknown') IS NULL
    AND JSON_EXTRACT(metadata, '$.outcome_unknown') IS NULL`,
  { replacements: { id: messageId, now: new Date(), reason: STOP_REASON } });
}

async function prepareMessageForDispatch(message, patch) {
  const db = models(), metadata = message.metadata || {};
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    if (['automations_v2', 'automation_v2'].includes(metadata.source) && metadata.execution_id) {
      const execution = await db.FlowExecutionV2.findByPk(metadata.execution_id, { transaction });
      if (!execution) throw stopped('automation_execution_stopped');
      await assertExecutionActive(execution, transaction, { allowCompleted: true });
    }
    const current = await db.Message.findByPk(message.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!current || current.metadata?.cancelled || current.metadata?.cancellation_reason === STOP_REASON) throw stopped();
    await current.update({ ...patch, metadata: { ...(current.metadata || {}), ...(patch.metadata || {}) } }, { transaction });
    await message.reload({ transaction });
  }).catch(async error => {
    if (isStop(error)) await cancelMessage(message.id);
    throw error;
  });
}

async function assertEmailCanDispatch(message) {
  if (message?.related_type !== 'flow_execution_v2') return;
  if (message.status === 'cancelled' || message.last_error_code === STOP_REASON) throw stopped();
  const execution = await models().FlowExecutionV2.findByPk(Number(message.related_id));
  if (!execution) throw stopped('automation_execution_stopped');
  await assertExecutionActive(execution, undefined, { allowCompleted: true });
}

async function stopExecution(execution) {
  await models().FlowExecutionV2.update({ status: 'cancelled',
    wait_until: null, last_error: STOP_REASON },
  { where: { id: execution.id, status: { [Op.in]: OPEN_STATUSES } } });
  await execution.reload();
  return execution;
}

async function setActive(template, active) {
  const db = models();
  const updatedStates = [];
  const summary = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const rows = await familyRows(template, transaction);
    const current = rows.find(row => Number(row.id) === Number(template.id));
    if (!current) throw Error('template_version_not_found');
    await current.update({ is_active: active === true }, { transaction });
    const latest = latestPublished(rows);
    const summary = { cancelled_executions: 0, cancelled_jobs: 0, cancelled_messages: 0, cancelled_emails: 0 };
    // Editing an older version is not a request to stop a newer active release.
    if (active || !latest || latest.is_active) return summary;
    let versionIds = rows.map(row => row.id);
    if (current.clinic_id != null) {
      const inherited = await db.AutomationFlowTemplateV2.findAll({ where: {
        template_key: templateFamilyKey(current), clinic_id: null,
        [Op.or]: [{ group_id: null }, ...(current.group_id == null ? [] : [{ group_id: current.group_id }])],
      }, attributes: ['id'], transaction });
      versionIds = [...versionIds, ...inherited.map(row => row.id)];
    }
    const [cancelled] = await db.FlowExecutionV2.update({
      status: 'cancelled', wait_until: null, last_error: STOP_REASON,
    }, { where: { template_version_id: { [Op.in]: versionIds }, status: { [Op.in]: OPEN_STATUSES },
      ...(current.clinic_id != null ? { clinic_id: current.clinic_id } : {}),
      // Explicit simulations are not operational tasks.
      [Op.and]: db.sequelize.literal("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(context, '$.__simulation')), 'false') <> 'true'") }, transaction });
    summary.cancelled_executions = cancelled;
    if (db.FlowExecutionLogV2) {
      await db.sequelize.query(`UPDATE FlowExecutionLogsV2 l JOIN FlowExecutionsV2 e ON e.id=l.flow_execution_id
        SET l.status='error', l.finished_at=:now, l.error_message=:reason
        WHERE e.template_version_id IN (:versionIds) AND e.status='cancelled' AND e.last_error=:reason
        AND (:scopeClinicId IS NULL OR e.clinic_id=:scopeClinicId) AND l.status='running'`,
      { replacements: { versionIds, now: new Date(), reason: STOP_REASON, scopeClinicId: current.clinic_id ?? null }, transaction });
    }

    const replacements = { versionIds, reason: STOP_REASON, now: new Date(), scopeClinicId: current.clinic_id ?? null };
    if (db.ConversationAutomationState) {
      const [states] = await db.sequelize.query(`SELECT s.id FROM ConversationAutomationStates s
        JOIN FlowExecutionsV2 e ON e.id=s.execution_id WHERE e.template_version_id IN (:versionIds)
        AND e.status='cancelled' AND e.last_error=:reason AND (:scopeClinicId IS NULL OR e.clinic_id=:scopeClinicId)`,
      { replacements, transaction });
      for (const state of await db.ConversationAutomationState.findAll({ where: { id: { [Op.in]: states.map(row => row.id) } }, transaction })) {
        const review = !!state.source_message_id || state.manual_action_required || state.needs_response;
        await state.update({ stage: review ? 'review' : 'completed', status: review ? 'review' : 'completed',
          manual_action_required: review, failure_code: STOP_REASON, deadline_at: null, completed_at: new Date() }, { transaction });
        updatedStates.push(state);
      }
    }
    const [jobs] = await db.sequelize.query(`UPDATE JobRequests j JOIN FlowExecutionsV2 e
      ON CAST(JSON_UNQUOTE(JSON_EXTRACT(j.payload, '$.execution_id')) AS UNSIGNED)=e.id
      SET j.status='cancelled', j.next_run_at=NULL, j.completed_at=:now, j.error_message=:reason, j.updated_at=:now
      WHERE j.type='automations_v2_execute' AND j.status IN ('pending','queued','waiting')
      AND (:scopeClinicId IS NULL OR e.clinic_id=:scopeClinicId)
      AND e.template_version_id IN (:versionIds) AND e.status='cancelled' AND e.last_error=:reason`, { replacements, transaction });
    summary.cancelled_jobs = jobs.affectedRows || 0;

    if (['appointment_before', 'appointment_reminder_window', 'appointment_after'].includes(current.trigger_type)) {
      const [scheduled] = await db.sequelize.query(`UPDATE JobRequests j JOIN CitasPacientes a
        ON CAST(JSON_UNQUOTE(JSON_EXTRACT(j.payload, '$.appointment_id')) AS UNSIGNED)=a.id_cita
        JOIN Clinicas c ON c.id_clinica=a.clinica_id
        SET j.status='cancelled', j.next_run_at=NULL, j.completed_at=:now, j.error_message=:reason, j.updated_at=:now
        WHERE j.type='appointment_automation_schedule_fire' AND j.status IN ('pending','queued','waiting','running')
        AND JSON_UNQUOTE(JSON_EXTRACT(j.payload, '$.template_key')) IN (:keys)
        AND (:scopeClinicId IS NULL OR a.clinica_id=:scopeClinicId)
        AND (:scopeClinicId IS NOT NULL OR :scopeGroupId IS NULL OR c.grupoClinicaId=:scopeGroupId)`,
      { transaction, replacements: { ...replacements, scopeGroupId: current.group_id ?? null,
        keys: [...new Set([...rows.map(row => row.template_key), ...(current.clinic_id == null ? [] : [templateFamilyKey(current)])])] } });
      summary.cancelled_jobs += scheduled.affectedRows || 0;
    }

    const [messages] = await db.sequelize.query(`UPDATE Messages m JOIN FlowExecutionsV2 e
      ON CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.execution_id')) AS UNSIGNED)=e.id
      SET m.status='failed', m.metadata=JSON_SET(COALESCE(m.metadata, JSON_OBJECT()),
        '$.cancelled', true, '$.cancelled_at', :now, '$.cancellation_reason', :reason, '$.error', :reason)
      WHERE e.template_version_id IN (:versionIds) AND m.direction='outbound' AND m.message_type<>'event'
      AND (:scopeClinicId IS NULL OR e.clinic_id=:scopeClinicId)
      AND m.status IN ('pending','sending','failed') AND JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.source')) IN ('automations_v2','automation_v2')
      AND JSON_EXTRACT(m.metadata, '$.wamid') IS NULL AND JSON_EXTRACT(m.metadata, '$.wa_response') IS NULL
      AND JSON_EXTRACT(m.metadata, '$.provider_acceptance_at') IS NULL
      AND JSON_EXTRACT(m.metadata, '$.delivery_unknown') IS NULL AND JSON_EXTRACT(m.metadata, '$.outcome_unknown') IS NULL`,
    { replacements, transaction });
    summary.cancelled_messages = messages.affectedRows || 0;
    const [quietJobs] = await db.sequelize.query(`UPDATE JobRequests j JOIN Messages m
      ON CAST(JSON_UNQUOTE(JSON_EXTRACT(j.payload, '$.message_id')) AS UNSIGNED)=m.id
      JOIN FlowExecutionsV2 e ON CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.execution_id')) AS UNSIGNED)=e.id
      SET j.status='cancelled', j.next_run_at=NULL, j.completed_at=:now, j.error_message=:reason, j.updated_at=:now
      WHERE j.type='automation_whatsapp_quiet_send' AND j.status IN ('pending','queued','waiting')
      AND e.template_version_id IN (:versionIds) AND (:scopeClinicId IS NULL OR e.clinic_id=:scopeClinicId)
      AND JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.cancellation_reason'))=:reason`, { replacements, transaction });
    summary.cancelled_jobs += quietJobs.affectedRows || 0;
    if (db.EmailMessage) {
      const [emails] = await db.sequelize.query(`UPDATE EmailMessages m JOIN FlowExecutionsV2 e
        ON CAST(m.related_id AS UNSIGNED)=e.id SET m.status='cancelled', m.completed_at=:now,
        m.last_error_code=:reason, m.last_error_message=:reason
        WHERE m.related_type='flow_execution_v2' AND e.template_version_id IN (:versionIds)
        AND (:scopeClinicId IS NULL OR e.clinic_id=:scopeClinicId)
        AND m.status IN ('queued','retrying','failed') AND m.provider_message_id IS NULL`, { replacements, transaction });
      summary.cancelled_emails = emails.affectedRows || 0;
    }
    return summary;
  });
  for (const state of updatedStates) {
    try { require('../services/conversationAutomationState.service').emitState(state); }
    catch (error) { console.warn('[automations-v2] Stop persisted; realtime refresh failed', { code: error.code || error.name }); }
  }
  return summary;
}

module.exports = { STOP_REASON, isStop, stopped, familyWhere, latestPublished,
  assertExecutionActive, assertTemplateActive, createExecution, setActive, stopExecution,
  updateExecution, cancelMessage, prepareMessageForDispatch, assertMessageCanDispatch, assertEmailCanDispatch };
