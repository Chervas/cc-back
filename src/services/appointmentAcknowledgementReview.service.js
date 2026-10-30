'use strict';
const db = require('../../models');
const { FLAG, pendingReason } = require('../lib/day-before-acknowledgement-review');

async function inspect(execution, context, transaction) {
  if (!execution?.id || !execution.clinic_id || !context?.conversation?.id
    || !(context?.appointment?.id_cita || context?.appointment?.id)) return 'review_scope_missing';
  const options = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
  const appointment = await db.CitaPaciente.findByPk(context?.appointment?.id_cita || context?.appointment?.id, options);
  const state = await db.ConversationAutomationState.findOne({ where: { conversation_id: context?.conversation?.id }, ...options });
  return pendingReason({ appointment, state, execution, context });
}

async function withPending(node, context, runtime, work) {
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const reason = await inspect(runtime.execution, context, transaction);
    if (reason) return { kind: 'success', output: { status: 'suppressed', suppressed: true,
      suppression_reason: reason, notifications_created: 0 }, next_node_id: node.outputs?.on_success || null };
    return work({ transaction });
  });
}

function observed(context) {
  return Object.values(context?.outputs || {}).some(output => output?.appointment_confirmation_review_required === true);
}

module.exports = { FLAG, inspect, withPending, observed };
