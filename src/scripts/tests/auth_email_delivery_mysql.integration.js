'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DataTypes: D } = require('sequelize');
const { SESv2Client } = require('@aws-sdk/client-sesv2');
// No real .env, models, provider sockets or shared SQL during this integration.
const dotenv = require.resolve('dotenv');
require.cache[dotenv] = { id: dotenv, filename: dotenv, loaded: true, exports: { config: () => ({ parsed: {} }) } };
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const keyFile = path.join(report.root, 'mfa.key');
  fs.writeFileSync(keyFile, Buffer.alloc(32, 9), { mode: 0o600 });
  Object.assign(process.env, {
    JWT_SECRET: 'FICTITIOUS_JWT_SIGNING_KEY', EMAIL_DATA_ENCRYPTION_KEY: 'FICTITIOUS_EMAIL_ENVELOPE_KEY',
    EMAIL_PROVIDER: 'ses', EMAIL_ENABLED: 'true', EMAIL_REQUIRE_RECIPIENT_ALLOWLIST: 'true',
    EMAIL_RECIPIENT_ALLOWLIST: 'old-allowlist@example.invalid', EMAIL_AUTHENTICATION_RECIPIENT_POLICY: 'registered-account',
    EMAIL_AWS_ACCESS_KEY_ID: 'FICTITIOUS_ACCESS_KEY', EMAIL_AWS_SECRET_ACCESS_KEY: 'FICTITIOUS_SECRET',
    EMAIL_PUBLIC_APP_URL: 'https://crm.example.invalid', AUTH_EMAIL_MFA_KEY_FILE: keyFile,
    AUTH_EMAIL_MFA_MODE: 'enforce', AUTH_SESSION_MODE: 'enforce',
    PLATFORM_AUDIT_AUTH_ENABLED: 'true', PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1',
    RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'gateway', QUEUE_PREFIX: 'gateway', JOBS_WORKER_ENABLED: 'false',
  });
  models.Sequelize = require('sequelize');
  for (const [name, filename] of [['Usuario', 'usuario'], ['EmailMessage', 'emailmessage'],
    ['EmailSuppression', 'emailsuppression'], ['PasswordResetToken', 'passwordresettoken'], ['JobRequest', 'jobrequest']]) {
    models[name] = require('../../../models/' + filename)(sql, D);
    await models[name].sync();
  }
  const qi = sql.getQueryInterface();
  for (const name of ['20260912210000-create-platform-audit-events', '20260912213000-create-platform-audit-delivery-states',
    '20260912220000-create-auth-sessions', '20260913003000-add-platform-audit-result-part', '20260913130000-create-auth-email-challenges']) {
    await require('../../../migrations/' + name).up(qi, D);
  }
  for (const [name, filename] of [['AuthSession', 'authsession'], ['AuthEmailChallenge', 'authemailchallenge'], ['PlatformAuditEvent', 'platformauditevent']]) {
    models[name] = require('../../../models/' + filename)(sql, D);
  }
  const challenges = require('../../services/authEmailChallenge.service');
  const C = require('../../services/authEmailChallenge.contract');
  const email = require('../../services/emailDelivery.service');
  const reset = require('../../services/passwordReset.service');
  const sessions = require('../../services/accessSession.service');
  const originalSend = SESv2Client.prototype.send;
  let sends = 0;
  SESv2Client.prototype.send = async () => ({ MessageId: 'FICTITIOUS_SES_RECEIPT_' + (++sends) });
  const gateway = () => Object.assign(process.env, { RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'gateway', QUEUE_PREFIX: 'gateway', JOBS_WORKER_ENABLED: 'false' });
  const staging = () => Object.assign(process.env, { RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: 'staging', QUEUE_PREFIX: 'staging', JOBS_WORKER_ENABLED: 'true' });
  try {
    const user = await models.Usuario.create({ nombre: 'Fictitious', email_usuario: 'registered@example.invalid', password_usuario: 'FICTITIOUS_HASH' });
    const challenge = await challenges.begin(user);
    const proof = await models.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(challenge.challengeToken) } });
    const message = await models.EmailMessage.findByPk(proof.email_message_id);
    const job = await models.JobRequest.findByPk(message.job_request_id);
    assert.equal(message.status, 'queued'); assert.equal(job.payload.__runtime_namespace, 'staging');
    assert.equal(job.priority, 'critical'); assert.equal(await models.AuthSession.count(), 0);
    const context = email.unsealSensitiveTemplateContext(message.template_context, message);
    assert(!JSON.stringify(message.template_context).includes(context.verification_code));
    report.checks.push('Real challenge, encrypted email outbox and JobRequest commit together; gateway targets only the staging authentication lane');

    staging();
    const sent = await email.runEmailSendJob(job.payload, job);
    assert.equal(sent.status, 'completed'); assert.equal(sent.result.email_status, 'sent'); assert.equal(sends, 1);
    const accepted = await challenges.verify(challenge.challengeToken, context.verification_code);
    assert.equal((await sessions.verify(accepted.token)).userId, user.id_usuario);
    await email.runEmailSendJob(job.payload, job); assert.equal(sends, 1);
    report.checks.push('A registered recipient outside the general allowlist receives the code via the actual worker; it yields one session and terminal outbox replay never resends');

    gateway();
    const recovery = await reset.requestPasswordReset({ email: user.email_usuario });
    const resetMessage = await models.EmailMessage.findByPk(recovery.emailMessageId);
    const resetJob = await models.JobRequest.findByPk(recovery.jobRequestId);
    assert.equal(resetJob.payload.__runtime_namespace, 'staging');
    staging();
    assert.equal((await email.runEmailSendJob(resetJob.payload, resetJob)).result.email_status, 'sent');
    assert.equal(sends, 2);
    const raw = new URL(email.unsealSensitiveTemplateContext(resetMessage.template_context, resetMessage).reset_url).searchParams.get('token');
    await reset.consumePasswordResetToken({ token: raw, password: 'FICTITIOUS_NEW_PASSWORD' });
    await assert.rejects(sessions.verify(accepted.token));
    report.checks.push('Actual password recovery outside the allowlist uses staging, consumes once and invalidates the previously issued MFA session');

    const ops = await email.queueEmail({ recipientEmail: user.email_usuario, stream: 'transactional', templateKey: 'ops.email_test',
      templateContext: { body: 'Fictitious operation message' } });
    const blocked = await email.runEmailSendJob({ email_message_id: ops.emailMessage.id });
    assert.equal(blocked.status, 'failed'); assert.equal(blocked.result.code, 'email_recipient_not_allowlisted'); assert.equal(sends, 2);
    report.checks.push('The same recipient still cannot receive an unrelated operational email; no global allowlist or marketing restriction is removed');

    const second = await models.Usuario.create({ nombre: 'Fictitious', email_usuario: 'second@example.invalid', password_usuario: 'FICTITIOUS_HASH' });
    gateway(); const pendingReset = await reset.requestPasswordReset({ email: second.email_usuario });
    await models.PasswordResetToken.update({ status: 'revoked' }, { where: { id: pendingReset.tokenId } });
    staging(); const revoked = await email.runEmailSendJob({ email_message_id: pendingReset.emailMessageId });
    assert.equal(revoked.status, 'failed'); assert.equal(sends, 2);
    report.checks.push('Recovery revoked between queuing and worker execution cannot use the registered-account recipient exception');
  } finally { SESv2Client.prototype.send = originalSend; }
}).catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
