'use strict';

async function enqueueInboundExecution({
  db,
  createExecution,
  enqueueJob,
  flow,
  clinicId,
  messageId,
  idempotencyKey,
  entryNodeId,
  origin,
  context,
}) {
  const find = () => db.FlowExecutionV2.findOne({ where: { idempotency_key: idempotencyKey } });
  let execution = await find();
  if (!execution) {
    try {
      execution = await createExecution({
        idempotency_key: idempotencyKey,
        template_version_id: flow.id,
        engine_version: 'v2',
        status: 'running',
        clinic_id: clinicId,
        group_id: flow.group_id,
        created_by: flow.published_by || flow.created_by,
        current_node_id: entryNodeId,
        trigger_type: 'mensaje_recibido',
        trigger_entity_type: 'message',
        trigger_entity_id: messageId,
        context,
      });
    } catch (error) {
      if (require('../lib/automation-runtime-stop').isStop(error)) return { reason: 'social_entry_disabled' };
      if (error.name !== 'SequelizeUniqueConstraintError' || !(execution = await find())) throw error;
    }
  }
  return enqueueExistingExecution(execution, enqueueJob, origin);
}

async function enqueueExistingExecution(execution, enqueueJob, origin) {
  if (execution.status === 'running' || execution.status === 'waiting') {
    await enqueueJob({
      type: 'automations_v2_execute',
      priority: 'critical',
      origin,
      dedupeScope: 'flow_execution:' + execution.id,
      payload: { execution_id: execution.id },
      requestedBy: execution.created_by,
      requestedByRole: 'system',
    });
  }
  return { execution_id: execution.id };
}

module.exports = { enqueueInboundExecution, enqueueExistingExecution };
