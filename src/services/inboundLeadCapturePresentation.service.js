'use strict';

const { postTreatmentFollowUp } = require('../lib/inbound-commercial-language');

const privateKeys = [
  'inboundLeadCapture',
  'inboundLeadCaptureClassification',
  'whatsapp_campaign_attribution',
  'manual_lead_recovery',
];
const outcomes = new Set(['created', 'linked', 'discarded', 'review']);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const keyFor = (clinicId, messageId) => `inbound_capture:${clinicId}:${messageId}`;

function stripInternalCapture(message) {
  if (!message || !privateKeys.some((key) => Object.hasOwn(message.metadata || {}, key))) return message;
  const metadata = { ...message.metadata };
  for (const key of privateKeys) delete metadata[key];
  return { ...message, metadata };
}

function resultFor(message, clinicId, execution) {
  const meta = message.metadata || {};
  const key = keyFor(clinicId, message.id);
  if (execution) {
    const data = execution.context?.trigger?.data;
    if (
      execution.idempotency_key !== key ||
      execution.clinic_id !== clinicId ||
      execution.trigger_entity_id !== message.id ||
      data?.message_id !== message.id ||
      data.conversation_id !== message.conversation_id
    )
      return null;
    const mark = meta.inboundLeadCapture;
    if (mark?.key === key && mark.executionId === execution.id && typeof mark.reason === 'string') {
      if (!mark.leadId && ['review', 'intent_ambiguous'].includes(mark.reason) && postTreatmentFollowUp(message.content)) {
        return { clinicId, source: 'v2', outcome: 'discarded', reason: 'post_treatment_follow_up' };
      }
      const success = positive(mark.leadId) && mark.reason === 'interest';
      const outcome = outcomes.has(mark.outcome)
        ? mark.outcome
        : success
          ? 'captured'
          : ['review', 'lead_link_requires_review'].includes(mark.reason)
            ? 'review'
            : 'discarded';
      return {
        clinicId,
        source: 'v2',
        outcome,
        reason: mark.reason,
        leadId: success ? mark.leadId : null,
        campaignId: mark.campaignId || null,
      };
    }
    if (execution.status === 'waiting' && execution.waiting_meta?.kind === 'inbound_lead_capture_retry') {
      return { clinicId, source: 'v2', outcome: 'retrying', reason: 'capture_retry_pending' };
    }
    if (
      execution.status === 'failed' &&
      Object.values(execution.context?.outputs || {}).some(
        (node) => node?.capture_retry?.will_retry === false
      )
    ) {
      return { clinicId, source: 'v2', outcome: 'review', reason: 'capture_retry_exhausted' };
    }
    return null;
  }
  const legacy = meta.whatsapp_campaign_attribution;
  if (
    !meta.manual_lead_recovery &&
    legacy?.capture_origin === 'campaign_send_configuration' &&
    ['created', 'linked'].includes(legacy.outcome) &&
    positive(legacy.lead_id) &&
    positive(legacy.campaign_id)
  ) {
    return {
      clinicId,
      source: 'campaign',
      outcome: legacy.outcome,
      reason: 'interest',
      leadId: legacy.lead_id,
      campaignId: legacy.campaign_id,
    };
  }
  return null;
}

async function presentMessages(messages, { db, actorId, clinicId, transaction, canSeeLeads, execution }) {
  if (!messages.length) return messages;
  const safe = messages.map(stripInternalCapture);
  const inbound = messages.filter(
    (message) =>
      message.direction === 'inbound' &&
      positive(message.id) &&
      (!message.metadata?.historical || message.metadata?.inboundLeadCapture)
  );
  if (
    !inbound.length ||
    !positive(clinicId) ||
    !actorId ||
    !(await canSeeLeads({ actorId, clinicId, featureKey: 'leads.sensitive.view' }))
  )
    return safe;
  // One indexed query for a page. A SQL failure can leave a retry without a message receipt.
  const runs = execution
    ? [execution]
    : await db.FlowExecutionV2.findAll({
        where: { clinic_id: clinicId, idempotency_key: inbound.map((m) => keyFor(clinicId, m.id)) },
        attributes: [
          'id',
          'clinic_id',
          'idempotency_key',
          'trigger_entity_id',
          'status',
          'waiting_meta',
          'context',
        ],
        raw: true,
        transaction,
      });
  const byMessage = new Map(runs.map((run) => [run.trigger_entity_id, run]));
  const results = new Map(inbound.map((m) => [m.id, resultFor(m, clinicId, byMessage.get(m.id))]));
  const ids = [...new Set([...results.values()].map((view) => view?.leadId).filter(positive))];
  const visible = ids.length
    ? await db.LeadIntake.findAll({
        where: { id: ids, clinica_id: clinicId, archived_at: null },
        attributes: ['id'],
        raw: true,
        transaction,
      })
    : [];
  const activeIds = new Set(visible.map((row) => row.id));
  return safe.map((message) => {
    const view = results.get(message.id);
    if (!view) return message;
    if (view.leadId && !activeIds.has(view.leadId))
      return {
        ...message,
        capture_result: {
          clinicId,
          source: view.source,
          outcome: 'review',
          reason: 'lead_link_requires_review',
        },
      };
    return { ...message, capture_result: view };
  });
}

// Monitor users can inspect the business decision. The only navigable identity
// is resolved from the persisted, clinic-scoped receipt by presentMessages.
function withoutCaptureEntityIds(value) {
  if (Array.isArray(value)) return value.map(withoutCaptureEntityIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !['leadId', 'campaignId', 'lead_id', 'campaign_id'].includes(name))
      .map(([name, child]) => [name, withoutCaptureEntityIds(child)])
  );
}

module.exports = { presentMessages, stripInternalCapture, withoutCaptureEntityIds };
