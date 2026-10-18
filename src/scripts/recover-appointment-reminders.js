#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const C = require('../lib/appointment-reminder-recovery');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');

async function capture(day, jobId = null) {
  const c = await connectOperatorDatabase('crm');
  try {
    await c.query('SET TRANSACTION READ ONLY');
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const [rows] = await c.query(`SELECT j.id job_id,j.status,j.payload,
      JSON_UNQUOTE(JSON_EXTRACT(j.result_summary,'$.result.reason')) result_reason,
      a.id_cita appointment_id,a.clinica_id clinic_id,a.paciente_id patient_id,a.inicio start_at,a.estado appointment_state,
      a.es_provisional provisional,a.import_metadata,a.updated_at appointment_updated_at,
      t.id template_id,t.template_key,t.is_active active,t.published_at,t.trigger_config config,t.nodes
      FROM JobRequests j JOIN CitasPacientes a
        ON a.id_cita=CAST(JSON_UNQUOTE(JSON_EXTRACT(j.payload,'$.appointment_id')) AS UNSIGNED)
      JOIN AutomationFlowTemplatesV2 t ON t.template_key=JSON_UNQUOTE(JSON_EXTRACT(j.payload,'$.template_key'))
        AND t.clinic_id=a.clinica_id AND t.is_active=1 AND t.published_at IS NOT NULL
      WHERE j.type='appointment_automation_schedule_fire'
        AND j.status='completed' AND JSON_UNQUOTE(JSON_EXTRACT(j.result_summary,'$.result.reason'))='invalid_schedule'
        AND DATE(JSON_UNQUOTE(JSON_EXTRACT(j.payload,'$.scheduled_for')))=?
        ${jobId == null ? '' : 'AND j.id=?'} ORDER BY j.id,t.id`, jobId == null ? [day] : [day, jobId]);
    await c.rollback();
    return rows.map(row => ({ ...row, ...Object.fromEntries(['payload', 'config', 'nodes', 'import_metadata']
      .map(key => [key, typeof row[key] === 'string' ? JSON.parse(row[key]) : row[key]])) }));
  } finally { await c.end(); }
}
function append(file, value) {
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
async function reconcileOwnedPreflight(db, item, earlier, journal) {
  const e = await db.FlowExecutionV2.findByPk(earlier.executionId);
  if (!e || Number(e.trigger_entity_id) !== item.appointmentId || Number(e.clinic_id) !== item.clinicId) throw Error('recovery_execution_scope_changed');
  if (['waiting', 'completed', 'running'].includes(e.status)) return { jobId: item.jobId, executionId: e.id, alreadyDispatched: true };
  if (e.status !== 'failed' || e.last_error !== 'whatsapp_send_failed:whatsapp_authorized_message_ineligible') throw Error('recovery_failure_not_owned');
  const messages = await db.Message.findAll({ where: { direction: 'outbound', message_type: 'template',
    [db.Sequelize.Op.and]: [db.Sequelize.where(db.Sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.execution_id'))"), String(e.id))] } });
  const artifact = messages.find(m => m.metadata.recovered_by === 'explicit_reminder_recovery_20261018');
  const message = messages.find(m => m.id !== artifact?.id);
  if (messages.length !== 2 || !artifact || !message || message.status !== 'failed'
    || message.metadata.technical_failure_reason_code !== 'whatsapp_appointment_daily_sequence_owned'
    || message.metadata.error !== 'whatsapp_authorized_message_ineligible') throw Error('recovery_ownership_requires_review');
  const W = require('../lib/whatsapp-dispatch-wait');
  if (messages.some(W.accepted) || messages.some(m => m.metadata.delivery_unknown || m.metadata.outcome_unknown
    || m.metadata.network_started_at || m.metadata.dispatch_wait)) throw Error('recovery_transport_evidence_present');
  const sender = await require('../services/flowEngineV2.service').resolveScheduledWhatsappSenderConfig({
    metadata: message.metadata, clinicId: item.clinicId });
  if (!sender?.authorizedBroker?.sendEnabled) throw Error('recovery_sender_unavailable');
  const whatsapp = require('../services/whatsapp.service'), m = message.metadata;
  const components = whatsapp.buildTemplateComponents({ templateParams: m.template_params, templateComponents: m.template_components });
  const payload = { messaging_product: 'whatsapp', to: m.recipient, type: 'template',
    template: { name: m.template_name, language: { code: m.template_language }, ...(components ? { components } : {}) } };
  const intent = { messageId: String(message.id), clinicId: item.clinicId, assetId: Number(m.sender_origin_id),
    expectedBinding: sender.authorizedBroker, message: payload };
  const send = { authorizationId: sender.authorizedBroker.authorizationId, phoneId: sender.phoneNumberId, message: payload };
  const receipt = await require('../lib/whatsappAuthorizedBrokerClient').sendReceipt(intent, send);
  if (receipt.state !== 'absent') throw Error('recovery_ledger_not_absent');
  const a = await db.CitaPaciente.findByPk(item.appointmentId, { raw: true });
  const sequence = await db.AppointmentReminderSequence.findOne({ where: { clinic_id: item.clinicId,
    patient_id: item.patientId, local_date: C.localDay(C.instant(a.inicio)) } });
  if (!sequence || Number(sequence.claims?.day_before?.execution_id) !== e.id
    || Number(sequence.claims?.day_before?.message_id) !== artifact.id || !sequence.claims.day_before.adopted_history) throw Error('recovery_ownership_changed');
  await db.sequelize.transaction(async transaction => {
    await e.reload({ transaction, lock: transaction.LOCK.UPDATE });
    await sequence.reload({ transaction, lock: transaction.LOCK.UPDATE });
    await artifact.reload({ transaction, lock: transaction.LOCK.UPDATE });
    await message.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (e.status !== 'failed' || message.status !== 'failed' || messages.some(W.accepted)
      || Number(sequence.claims?.day_before?.execution_id) !== e.id
      || Number(sequence.claims?.day_before?.message_id) !== artifact.id) throw Error('recovery_ownership_changed');
    append(journal, { event: 'diagnostic_ownership_corrected', executionId: e.id, messageId: message.id,
      artifactId: artifact.id, priorClaims: sequence.claims,
      diagnosticSentAt: artifact.sent_at, messageDiagnosticSentAt: message.sent_at, ledgerState: receipt.state });
    await artifact.update({ sent_at: null, metadata: { ...artifact.metadata,
      diagnostic_sent_at: artifact.sent_at, diagnostic_timestamp_only: true } }, { transaction });
    const claims = structuredClone(sequence.claims);
    claims.day_before = { execution_id: e.id, appointment_id: item.appointmentId,
      claimed_at: claims.day_before.claimed_at, message_id: message.id, attempted: false };
    await sequence.update({ claims }, { transaction, hooks: false });
    const metadata = { ...message.metadata, recovery_original_error: message.metadata.error,
      recovery_original_sent_at: message.sent_at, recovery_ledger_absent_at: new Date().toISOString() };
    for (const key of ['error', 'flow_error', 'technical_failure_reason_code', 'fresh_realtime_status',
      'fresh_delivery_reconciled_status', 'fresh_delivery_reconciled_at']) delete metadata[key];
    await message.update({ status: 'pending', sent_at: null, metadata }, { transaction });
    await require('../services/whatsappDispatchWait.service').defer({ dispatchDeferred: true,
      code: 'explicit_preflight_recovery', dispatchIntent: intent, dispatchPayload: send }, { transaction });
    await message.reload({ transaction });
    const waiting = W.flowWait(message);
    await e.update({ status: 'waiting', current_node_id: m.node_id, last_error: null,
      wait_until: waiting.wait_until, waiting_meta: waiting.waiting_meta }, { transaction });
    await require('../services/jobRequests.service').enqueueUniqueJobRequest({ type: 'automations_v2_execute',
      payload: { execution_id: e.id }, priority: 'high', status: 'waiting', nextRunAt: waiting.wait_until,
      origin: 'explicit_reminder_preflight_recovery', dedupeScope: 'flow_execution:' + e.id }, { transaction });
  });
  return { jobId: item.jobId, executionId: e.id, sameMessageRecovered: message.id, ledgerState: 'absent' };
}
async function main(args) {
  const option = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
  const mode = option('--mode'), day = option('--day'), dir = option('--evidence');
  if (!['plan', 'apply', 'complete', 'reconcile'].includes(mode) || !/^\d{4}-\d\d-\d\d$/.test(day || '')
    || C.localDay(Date.now()) !== day || !dir?.startsWith('/home/ubuntu/secure-imports/')
    || !fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== dir || fs.statSync(dir).mode & 0o077) throw Error('recovery_arguments_invalid');
  const planFile = path.join(dir, 'plan.json'), journal = path.join(dir, 'apply.jsonl');
  if (mode === 'plan') {
    const rows = await capture(day), seen = new Set(), items = [], excluded = [];
    for (const row of rows) {
      if (seen.has(row.job_id)) throw Error('recovery_template_ambiguous');
      seen.add(row.job_id);
      try { items.push(C.validate(row, { day })); }
      catch (error) { excluded.push({ jobId: row.job_id, reason: error.message }); }
    }
    const plan = { version: 1, purpose: 'explicit_today_missed_day_before_reminders', day,
      createdAt: new Date().toISOString(), nativeSource: require('node:crypto').createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '../services/appointmentAutomationV2Runtime.service.js'))).digest('hex'),
      items, excluded };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), { mode: 0o600, flag: 'wx' });
    return { mode, candidates: items.length, excluded, planSha256: C.hash(plan), planFile };
  }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (C.hash(plan) !== option('--sha256') || plan.day !== day || plan.version !== 1
    || plan.purpose !== 'explicit_today_missed_day_before_reminders'
    || Date.now() - Date.parse(plan.createdAt) > 3600000
    || mode === 'apply' && fs.existsSync(journal) || ['complete', 'reconcile'].includes(mode) && !fs.existsSync(journal)) throw Error('recovery_plan_invalid');
  const sourceHash = require('node:crypto').createHash('sha256')
    .update(fs.readFileSync(path.join(__dirname, '../services/appointmentAutomationV2Runtime.service.js'))).digest('hex');
  if (sourceHash !== plan.nativeSource) throw Error('recovery_native_source_changed');
  const { observedEnvironment } = require('./security-email-login-metadata');
  const observed = observedEnvironment('staging');
  if (observed.root !== path.resolve(__dirname, '../..')) throw Error('recovery_staging_source_required');
  Object.assign(process.env, C.runtimeEnvironment(observed.env));
  process.chdir(observed.root);
  const db = require('../../models');
  const runtime = require('../services/appointmentAutomationV2Runtime.service');
  const results = [];
  const prior = ['complete', 'reconcile'].includes(mode) ? fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(row => row.executionId) : [];
  append(journal, { event: 'approved_recovery_started', day, planSha256: C.hash(plan), at: new Date().toISOString() });
  for (const item of plan.items) {
    try {
      const earlier = prior.find(row => row.jobId === item.jobId);
      if (mode === 'reconcile') {
        if (!earlier) throw Error('recovery_execution_not_recorded');
        const entry = await reconcileOwnedPreflight(db, item, earlier, journal);
        append(journal, entry); results.push(entry); continue;
      }
      if (earlier) {
        const e = await db.FlowExecutionV2.findByPk(earlier.executionId);
        if (!e || Number(e.trigger_entity_id) !== item.appointmentId || Number(e.clinic_id) !== item.clinicId) throw Error('recovery_execution_scope_changed');
        if (['waiting', 'completed'].includes(e.status)) {
          results.push({ jobId: item.jobId, executionId: e.id, alreadyDispatched: true }); continue;
        }
        const messages = await db.Message.findAll({ where: { direction: 'outbound', message_type: 'template',
          [db.Sequelize.Op.and]: [db.Sequelize.where(db.Sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.execution_id'))"), String(e.id))] } });
        if (messages.length !== 1 || !C.preflightArtifact(messages[0], e)) throw Error('recovery_preflight_requires_review');
        const artifact = messages[0];
        const template = await db.AutomationFlowTemplateV2.findByPk(e.template_version_id);
        if (!template?.is_active || !template.published_at
          || !template.nodes.some(n => n.id === artifact.metadata.node_id && n.type === 'action/send_whatsapp')) throw Error('recovery_template_changed');
        await db.sequelize.transaction(async transaction => {
          await e.reload({ transaction, lock: transaction.LOCK.UPDATE });
          await artifact.reload({ transaction, lock: transaction.LOCK.UPDATE });
          if (!C.preflightArtifact(artifact, e)) throw Error('recovery_preflight_changed');
          append(journal, { event: 'preflight_artifact_preserved', messageId: artifact.id, executionId: e.id,
            originalDeliveryKey: artifact.automation_delivery_key, metadataDeliveryKey: artifact.metadata.automation_delivery_key });
          // This row is a local preflight failure, not a transport intent: no
          // sender, network attempt or provider receipt exists. Preserve it as
          // evidence while the same native execution builds its first intent.
          const metadata = { ...artifact.metadata, previous_automation_delivery_key: artifact.metadata.automation_delivery_key,
            automation_delivery_key: `preflight-artifact:${artifact.id}`, recovered_by: 'explicit_reminder_recovery_20261018' };
          await artifact.update({ automation_delivery_key: `preflight-artifact:${artifact.id}`, metadata }, { transaction });
          await e.update({ status: 'running', current_node_id: artifact.metadata.node_id,
            last_error: null, wait_until: null, waiting_meta: null }, { transaction });
          await require('../services/jobRequests.service').enqueueUniqueJobRequest({ type: 'automations_v2_execute',
            payload: { execution_id: e.id }, priority: 'critical', origin: 'explicit_reminder_preflight_recovery',
            dedupeScope: 'flow_execution:' + e.id }, { transaction });
        });
        const entry = { jobId: item.jobId, executionId: e.id, preflightRecovered: true, preservedArtifact: artifact.id };
        append(journal, entry); results.push(entry); continue;
      }
      const rows = await capture(day, item.jobId);
      if (rows.length !== 1 || C.validate(rows[0], { day }).sourceDigest !== item.sourceDigest) throw Error('recovery_source_changed');
      // fireScheduledTrigger rechecks effective recipe, current appointment,
      // import/HOLD policy, first daily arrival and native delivery ownership.
      append(journal, { event: 'native_dispatch_requested', jobId: item.jobId, appointmentId: item.appointmentId });
      const result = await runtime.fireScheduledTrigger(rows[0].payload);
      const entry = { jobId: item.jobId, appointmentId: item.appointmentId, clinicId: item.clinicId,
        success: result.success, skipped: !!result.skipped, reason: result.reason || null,
        executionId: result.execution?.id || null, queueJobId: result.queue_job_id || null,
        deduplicated: !!result.deduplicated };
      append(journal, entry); results.push(entry);
    } catch (error) {
      const entry = { jobId: item.jobId, appointmentId: item.appointmentId, failed: true,
        reason: /^[a-z_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'recovery_requires_review' };
      append(journal, entry); results.push(entry);
    }
  }
  const ids = results.map(row => row.queueJobId).filter(Boolean);
  const until = Date.now() + 90000;
  while (ids.length && Date.now() < until) {
    const open = await db.JobRequest.count({ where: { id: ids, status: ['pending', 'queued', 'running'] } });
    if (!open) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { mode, day, results };
}
if (require.main === module) {
  const log = value => process.stdout.write(JSON.stringify(value) + '\n');
  console.log = console.warn = console.error = () => {};
  main(process.argv.slice(2)).then(log).catch(error => {
    log({ error: /^[A-Za-z_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'recovery_failed' });
    process.exitCode = 1;
  }).finally(async () => {
    const models = require.cache[require.resolve('../../models')];
    if (models) await models.exports.sequelize.close();
    const queues = require.cache[require.resolve('../services/queue.service')];
    if (queues) await Promise.all(Object.values(queues.exports.queues || {}).map(queue => queue.disconnect()));
  });
}
module.exports = { main, capture };
