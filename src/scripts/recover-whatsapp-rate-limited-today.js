'use strict';
// Dated, explicit operator. No historical replay or provider POST here: only
// today's sealed IDs can be handed to the existing scoped/native dispatcher.
const fs = require('node:fs'); const path = require('node:path');
const APPROVED_DAY = '2026-10-12';
const APPROVED_IDS = Object.freeze([146273, 146274, 146277, 146279, 146281, 146283, 146285, 146287]);
async function inspect(id, { transaction } = {}) {
  const db = require('../../models'); const E = require('../lib/whatsappAppointmentEligibility');
  const { Op } = db.Sequelize;
  const message = await db.Message.findByPk(id, { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  const m = message?.metadata || {};
  if (!message || E.day(message.createdAt) !== APPROVED_DAY || message.status !== 'failed' || m.error !== 'rate_limited'
    || m.dispatch_wait || require('../lib/whatsapp-dispatch-wait').accepted(message) || m.delivery_unknown || m.outbound_retry) throw Error('original_attempt_not_eligible');
  const execution = await db.FlowExecutionV2.findByPk(Number(m.execution_id), { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!execution || execution.status !== 'failed' || execution.trigger_entity_type !== 'appointment'
    || execution.trigger_type !== 'appointment_reminder_window' || !String(execution.last_error).includes('rate_limited')) throw Error('original_execution_not_eligible');
  const [template, appointment, conversation] = await Promise.all([
    db.AutomationFlowTemplateV2.findByPk(execution.template_version_id, { transaction }),
    db.CitaPaciente.findByPk(execution.trigger_entity_id, { transaction }),
    db.Conversation.findByPk(message.conversation_id, { transaction }),
  ]);
  if (!template?.is_active || !template.published_at || !appointment || !conversation
    || Number(conversation.clinic_id) !== Number(execution.clinic_id)
    || Number(conversation.patient_id) !== Number(appointment.paciente_id)
    || !template.nodes?.some(n => n.id === m.node_id && n.type === 'action/send_whatsapp')) throw Error('scope_or_recipe_changed');
  const later = await db.Message.findOne({ where: { conversation_id: conversation.id, id: { [Op.ne]: id },
    createdAt: { [Op.gt]: message.createdAt }, message_type: { [Op.ne]: 'event' },
    [Op.or]: [{ direction: 'inbound' }, { direction: 'outbound', status: { [Op.in]: ['pending', 'sent', 'delivered', 'read'] } }] }, transaction });
  if (later) throw Error('new_conversation_activity_requires_review');
  const whatsapp = require('../services/whatsapp.service');
  const config = await whatsapp.getConfigByAssetId(Number(m.sender_origin_id), { clinicId: Number(conversation.clinic_id) });
  if (!config?.authorizedBroker || String(config.phoneNumberId) !== String(m.phoneNumberId || m.phoneId)
    || String(config.wabaId) !== String(m.wabaId) || Object.hasOwn(config, 'accessToken')) throw Error('sender_changed_or_not_authorized');
  const components = whatsapp.buildTemplateComponents({ templateParams: m.template_params, templateComponents: m.template_components });
  const payload = { messaging_product: 'whatsapp', to: m.recipient, type: 'template',
    template: { name: m.template_name, language: { code: m.template_language }, ...(components ? { components } : {}) } };
  const broker = require('../lib/whatsappAuthorizedBrokerClient');
  if (await broker.isManagedMessage(message)) throw Error('managed_visit_not_supported');
  await E.assertAutomatedMessageEligibility({ message, conversation, payload,
    loadExecution: async () => execution, loadAppointment: async () => appointment,
    patientHeld: patientId => E.patientImportHeld(patientId, db) });
  await require('../services/whatsappAccountHealth.service').assertCanSend({ clinicConfig: config, source: 'explicit_rate_recovery', messageId: id });
  await whatsapp.assertRecipientCanReceive({ to: payload.to, clinicConfig: config });
  await require('../services/whatsappTemplateScope.service').assertTemplateInWaba({ wabaId: config.wabaId,
    clinicId: conversation.clinic_id, name: payload.template.name, language: payload.template.language.code });
  await require('../services/securityMonitoring.service').assertTemplateAllowed(config.wabaId, payload.template.name, payload.template.language.code);
  const intent = { messageId: String(id), clinicId: Number(conversation.clinic_id), assetId: Number(m.sender_origin_id),
    expectedBinding: config.authorizedBroker, message: payload };
  const send = { authorizationId: config.authorizedBroker.authorizationId, phoneId: config.phoneNumberId, message: payload };
  const receipt = await broker.sendReceipt(intent, send);
  if (receipt.state !== 'absent') throw Error('ledger_not_absent');
  return { message, execution, intent, send };
}
async function main({ apply = false, evidenceDir } = {}) {
  const db = require('../../models'); const E = require('../lib/whatsappAppointmentEligibility');
  if (E.day(Date.now()) !== APPROVED_DAY || require('../services/jobRequests.service').getCurrentRuntimeNamespace() !== 'staging') throw Error('operator_day_or_namespace_invalid');
  const [database] = await db.sequelize.query('SELECT DATABASE() name');
  if (database[0]?.name !== 'clinicaclick') throw Error('operator_database_invalid');
  if (apply && (!path.isAbsolute(evidenceDir || '') || !fs.statSync(evidenceDir).isDirectory()
    || fs.statSync(evidenceDir).mode & 0o077)) throw Error('private_evidence_directory_required');
  const report = { day: APPROVED_DAY, applied: apply, results: [] };
  for (const id of APPROVED_IDS) {
    try {
      const inspected = await inspect(id);
      if (!apply) { report.results.push({ messageId: id, eligible: true, ledger: 'absent' }); continue; }
      const before = inspected.message.metadata;
      const backup = { messageId: id, status: inspected.message.status,
        metadataFields: Object.fromEntries(['error','flow_error','flow_reason','flow_domain','dispatch_wait'].map(k => [k, before[k] ?? null])),
        executionId: inspected.execution.id, executionFields: Object.fromEntries(['status','current_node_id','wait_until','waiting_meta','last_error'].map(k => [k, inspected.execution[k]])) };
      fs.writeFileSync(path.join(evidenceDir, 'before-' + id + '.json'), JSON.stringify(backup), { mode: 0o600, flag: 'wx' });
      await db.sequelize.transaction(async transaction => {
        const { message, execution, intent, send } = await inspect(id, { transaction });
        const metadata = { ...message.metadata };
        for (const key of ['flow_error', 'flow_reason', 'flow_domain']) delete metadata[key];
        metadata.dispatch_wait = { created_at: new Date(message.createdAt).toISOString(),
          expires_at: new Date(new Date(message.createdAt).getTime() + 86400000).toISOString() };
        metadata.rate_recovery = { version: 1, approved_day: APPROVED_DAY, operator_at: new Date().toISOString(), original_error: 'rate_limited' };
        await message.update({ metadata }, { transaction });
        await require('../services/whatsappDispatchWait.service').defer({ dispatchDeferred: true,
          code: 'rate_limited', dispatchIntent: intent, dispatchPayload: send }, { transaction });
        await message.reload({ transaction });
        const waiting = require('../lib/whatsapp-dispatch-wait').flowWait(message);
        await execution.update({ status: 'waiting', current_node_id: metadata.node_id, last_error: null,
          wait_until: waiting.wait_until, waiting_meta: waiting.waiting_meta }, { transaction });
        await require('../services/jobRequests.service').enqueueUniqueJobRequest({ type: 'automations_v2_execute',
          payload: { execution_id: execution.id }, priority: 'low', status: 'waiting', maxAttempts: 4096,
          nextRunAt: waiting.wait_until, origin: 'rate_limited_today_recovery', dedupeScope: 'flow_execution:' + execution.id }, { transaction });
      });
      report.results.push({ messageId: id, enqueued: true, sameMessageAndExecution: true });
    } catch (error) { report.results.push({ messageId: id, eligible: false,
      reason: error.code || (/^[a-z_]+$/.test(error.message || '') ? error.message : 'operator_review_required') }); }
  }
  if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, apply ? 'apply-report.json' : 'dry-run.json'), JSON.stringify(report), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(report)); return report;
}
if (require.main === module) main({ apply: process.argv.includes('--apply'), evidenceDir: process.argv.find(a => a.startsWith('--evidence='))?.slice(11) })
  .catch(error => { console.error(JSON.stringify({ error: error.code || error.message })); process.exitCode = 1; })
  .finally(async () => { await require('../../models').sequelize.close();
    const queueModule = require.cache[require.resolve('../services/queue.service')];
    if (queueModule) await Promise.all(Object.values(queueModule.exports.queues || {}).map(q => q.disconnect())); });
module.exports = { main, inspect, APPROVED_IDS, APPROVED_DAY };
