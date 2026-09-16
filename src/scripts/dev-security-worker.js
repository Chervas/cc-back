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
async function main() {
  assertRuntime();
  const db = require('../../models'); const jobs = require('../services/jobRequests.service');
  const delivery = require('../services/emailDelivery.service'); const audit = require('../services/platformAudit.delivery');
  const reader = require('../services/platformAudit.readerClient'); const relay = require('../lib/devAuditRelay');
  const session = require('../services/accessSession.service');
  // No scheduler/cron/queue worker import: this process has exactly these two jobs.
  let closing = false; let activeReads = 0;
  const server = http.createServer(async (req, res) => {
    let admitted = false;
    try {
      if (activeReads >= 2 || req.method !== 'POST' || req.url !== '/audit/read') throw Error();
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
  const stop = () => { closing = true; server.close(); server.closeIdleConnections?.(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  while (!closing) {
    try {
      const result = await audit.run();
      if (result.error) process.stderr.write('DEV_AUDIT_DELIVERY_PENDING\n');
      await require('../services/platformAudit.reconciliation').run();
      for (let i = 0; i < 5 && !closing; i++) {
        const job = await jobs.claimNextJob(['critical', 'high', 'normal', 'low'], ['email_send']);
        if (!job) break;
        const row = await db.EmailMessage.findByPk(job.payload?.email_message_id);
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
    } catch { process.stderr.write('DEV_SECURITY_WORKER_TICK_FAILED\n'); }
    if (!closing) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await db.sequelize.close();
}
if (require.main === module) main().catch(() => { process.stderr.write('DEV_SECURITY_WORKER_FAILED\n'); process.exitCode = 1; });
module.exports = { assertRuntime, allowedEmail };
