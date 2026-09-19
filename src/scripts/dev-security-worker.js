#!/usr/bin/env node
'use strict';
const fs = require('node:fs'); const os = require('node:os'); const http = require('node:http');
function assertRuntime(env = process.env, username = os.userInfo().username) {
  if (username !== 'clinicaclick-dev-security' || env.DEV_SECURITY_WORKER !== 'true'
    || env.DB_NAME !== 'clinicaclick_dev_isolated' || env.DB_USERNAME !== 'cc_dev_api' || env.DB_HOST !== '127.0.0.1'
    || !['RUNTIME_NAMESPACE', 'JOB_RUNTIME_NAMESPACE', 'QUEUE_PREFIX'].every(k => env[k] === 'dev')
    || !['JOBS_WORKER_ENABLED', 'JOBS_CRON_LEADER', 'JOBS_AUTO_START', 'SYSTEM_NOTIFICATIONS_CRON_LEADER'].every(k => env[k] === 'false')
    || env.AUTH_SESSION_MODE !== 'enforce' || env.AUTH_EMAIL_MFA_MODE !== 'enforce'
    || env.PLATFORM_AUDIT_READER_TRANSPORT !== 'https') throw Error('dev_security_worker_configuration_invalid');
}
function allowedEmail(row) {
  return row && ['auth.email_verification', 'auth.password_reset'].includes(row.template_key)
    && row.recipient_kind === 'user' && row.stream === 'transactional' && !row.clinica_id && !row.paciente_id;
}
const META_TASKS = [
  ['metaRevocations', 'META_MARKETING_REVOCATION_WORKER_ENABLED', '../services/metaMarketingRevocation.service'],
  ['metaOAuth', 'META_MARKETING_OAUTH_WORKER_ENABLED', '../services/metaMarketingOAuth.service'],
  ['metaEnrollment', 'META_MARKETING_ENROLLMENT_WORKER_ENABLED', '../services/metaMarketingEnrollment.service'],
];
function createMetaPollers({ env = process.env, load = id => require(id) } = {}) {
  return Object.fromEntries(META_TASKS.map(([name, flag, module]) => [name, async (closing = () => false) => {
    // No model, transport, key or provider access while this lane is disabled.
    if (closing() || env[flag] !== 'true') return { status: 'completed', skipped: true };
    return load(module).run({ closing });
  }]));
}
function startSecurityLoops({ email, audit, reconcile, meta = {}, onError = () => {},
  wait = (ms, signal) => require('node:timers/promises').setTimeout(ms, undefined, { signal }) }) {
  const controller = new AbortController(); const { signal } = controller;
  const loop = async (name, run, interval) => {
    while (!signal.aborted) {
      try { const result = await run(() => signal.aborted); if (result?.error || result?.status === 'failed') onError(name); }
      catch { onError(name); }
      // Count from completion, without catch-up, overlap or abandoning an
      // uncertain provider call. Each lane waits independently of the others.
      if (!signal.aborted) {
        try { await wait(interval, signal); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    }
  };
  const tasks = [loop('email', email, 1000), loop('audit', audit, 10000), loop('reconcile', reconcile, 30000),
    ...META_TASKS.filter(([name]) => typeof meta[name] === 'function').map(([name]) => loop(name, meta[name], 60000))]
    .map(task => task.catch(error => { controller.abort(); throw error; }));
  const done = Promise.allSettled(tasks).then(results => {
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  });
  return { done, stop: () => controller.abort() };
}
function createEmailPoller({ jobs, model, delivery }) {
  return async (closing = () => false) => {
    for (let i = 0; i < 5 && !closing(); i++) {
      const job = await jobs.claimNextJob(['critical', 'high', 'normal', 'low'], ['email_send']);
      if (!job) break;
      const row = await model.findByPk(job.payload?.email_message_id);
      if (!allowedEmail(row) || row.job_request_id !== job.id || !['queued', 'sending'].includes(row.status)) {
        await job.update({ status: 'failed', error_message: 'dev_security_email_scope_denied', next_run_at: null }); continue;
      }
      // A send interrupted after SES acceptance is never retried blindly.
      if (row.status === 'sending') {
        await job.update({ status: 'failed', error_message: 'email_delivery_outcome_unknown', next_run_at: null }); continue;
      }
      const outcome = await delivery.runEmailSendJob(job.payload, job);
      const retry = outcome.status === 'failed' && outcome.retryable === true && job.attempts < job.max_attempts;
      await job.update({ status: retry ? 'waiting' : outcome.status === 'completed' ? 'completed' : 'failed',
        next_run_at: retry ? new Date(Date.now() + 15000) : null,
        completed_at: retry ? null : new Date(),
        result_summary: outcome.result || null, error_message: outcome.error ? 'dev_auth_email_delivery_failed' : null });
    }
  };
}
async function main() {
  assertRuntime();
  const db = require('../../models'); const jobs = require('../services/jobRequests.service');
  const delivery = require('../services/emailDelivery.service'); const audit = require('../services/platformAudit.delivery');
  const reader = require('../services/platformAudit.readerClient'); const relay = require('../lib/devAuditRelay');
  const session = require('../services/accessSession.service');
  // No scheduler/cron/business queue worker import. The unit's exclusive flock
  // remains the process owner; each lane keeps its existing durable SQL claims.
  let closing = false; let activeReads = 0; let loops; let serverClosed;
  const server = http.createServer(async (req, res) => {
    let admitted = false;
    try {
      if (closing || activeReads >= 2 || req.method !== 'POST' || req.url !== '/audit/read') throw Error();
      activeReads++; admitted = true;
      const chunks = []; let size = 0;
      for await (const b of req) { size += b.length; if (size > 65536) throw Error(); chunks.push(b); }
      const command = JSON.parse(Buffer.concat(chunks));
      await relay.authorize(command, { findEvent: digest => db.PlatformAuditEvent.findOne({ where: { digest }, raw: true }),
        verifySession: value => session.verifyReference(value) });
      const result = await reader.read(command); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(403); res.end('{"error":"audit_reader_denied"}'); }
    finally { if (admitted) activeReads--; }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  if (fs.existsSync(relay.SOCKET)) { if (!fs.lstatSync(relay.SOCKET).isSocket()) throw Error('unexpected_socket_path'); fs.unlinkSync(relay.SOCKET); }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(relay.SOCKET, resolve); });
  fs.chmodSync(relay.SOCKET, 0o660);
  const stop = () => {
    if (closing) return;
    closing = true; loops?.stop();
    serverClosed = new Promise(resolve => server.close(resolve)); server.closeIdleConnections?.();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    loops = startSecurityLoops({ email: createEmailPoller({ jobs, model: db.EmailMessage, delivery }),
      audit: () => audit.run(), reconcile: () => require('../services/platformAudit.reconciliation').run(),
      meta: createMetaPollers(),
      onError: name => process.stderr.write({ email: 'DEV_SECURITY_WORKER_TICK_FAILED\n', audit: 'DEV_AUDIT_DELIVERY_PENDING\n',
        reconcile: 'DEV_AUDIT_RECONCILIATION_PENDING\n', metaRevocations: 'DEV_META_REVOCATION_PENDING\n',
        metaOAuth: 'DEV_META_OAUTH_PENDING\n', metaEnrollment: 'DEV_META_ENROLLMENT_PENDING\n' }[name]) });
    await loops.done;
  } finally {
    stop(); await Promise.allSettled([loops?.done, serverClosed]);
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    await db.sequelize.close();
  }
}
if (require.main === module) main().catch(() => { process.stderr.write('DEV_SECURITY_WORKER_FAILED\n'); process.exitCode = 1; });
module.exports = { assertRuntime, allowedEmail, startSecurityLoops, createEmailPoller, createMetaPollers };
