'use strict';
const db = require('./fixtures/email_models.fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { SESv2Client } = require('@aws-sdk/client-sesv2');
const policy = require('../../services/authEmailRecipientPolicy.service');
const provider = require('../../services/emailProvider.service');
const delivery = require('../../services/emailDelivery.service');
const templates = require('../../services/emailTemplates.service');
const sessions = require('../../services/accessSession.service');
const C = require('../../services/authEmailChallenge.contract');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-email-policy-'));
const keyFile = path.join(directory, 'mfa.key');
const key = Buffer.alloc(32, 9);
fs.writeFileSync(keyFile, key, { mode: 0o600 });
process.env.EMAIL_DATA_ENCRYPTION_KEY = 'FICTITIOUS_EMAIL_ENVELOPE_KEY';
db.AuthEmailChallenge = { findByPk: async () => { throw Error('UNEXPECTED_CHALLENGE_READ'); } };
test.after(() => fs.rmSync(directory, { recursive: true }));
const env = {
  EMAIL_PROVIDER: 'ses', EMAIL_ENABLED: 'true', EMAIL_MARKETING_ENABLED: 'false',
  EMAIL_AWS_ACCESS_KEY_ID: 'FICTITIOUS_ACCESS_KEY', EMAIL_AWS_SECRET_ACCESS_KEY: 'FICTITIOUS_SECRET',
  EMAIL_REQUIRE_RECIPIENT_ALLOWLIST: 'true', EMAIL_RECIPIENT_ALLOWLIST: 'old-allowlist@example.invalid',
  EMAIL_AUTHENTICATION_RECIPIENT_POLICY: 'registered-account', EMAIL_PUBLIC_APP_URL: 'https://crm.example.invalid',
  AUTH_EMAIL_MFA_MODE: 'enforce', AUTH_SESSION_MODE: 'enforce',
  AUTH_EMAIL_MFA_KEY_FILE: keyFile, JWT_SECRET: 'FICTITIOUS_JWT_SECRET',
  PLATFORM_AUDIT_AUTH_ENABLED: 'true', PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1',
  RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: 'staging', QUEUE_PREFIX: 'staging', JOBS_WORKER_ENABLED: 'true',
};
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t, kind = 'code') {
  const user = { id_usuario: 123, email_usuario: 'registered@example.invalid', password_usuario: 'FICTITIOUS_PASSWORD_HASH',
    estado_cuenta: 'activo', es_provisional: false };
  const id = randomUUID();
  const rawToken = 'R'.repeat(43);
  const context = kind === 'code' ? { auth_email_challenge_id: id, verification_code: '123456', expires_minutes: 5 }
    : { password_reset_token_id: 456, reset_url: env.EMAIL_PUBLIC_APP_URL + '/reset-password?token=' + rawToken, expires_minutes: 30 };
  const row = { id: 789, public_id: 'em_' + randomUUID(), status: 'sending', template_version: 'v1',
    stream: 'transactional', template_key: kind === 'code' ? 'auth.email_verification' : 'auth.password_reset',
    usuario_id: user.id_usuario, recipient_kind: 'user', recipient_hash: hash(user.email_usuario), recipient_domain: 'example.invalid',
    from_email: 'no-contestar@example.invalid', reply_to: null, configuration_set: 'clinicaclick-transactional',
    related_type: kind === 'code' ? 'auth_email_challenge' : 'password_reset_token', related_id: kind === 'code' ? id : '456' };
  row.template_context = delivery.sealSensitiveTemplateContext(context, {
    publicId: row.public_id, recipientHash: row.recipient_hash, templateKey: row.template_key,
  });
  const proof = kind === 'code' ? { challenge_id: id, user_id: user.id_usuario, state: 'pending',
    email_message_id: row.id, expires_at: new Date(Date.now() + 300000), absolute_expires_at: new Date(Date.now() + 600000),
    attempts: 0, email_hash: row.recipient_hash, code_hash: C.codeHash(key, id, context.verification_code),
    credential_binding: sessions.binding(user, env.JWT_SECRET) }
    : { id: 456, user_id: user.id_usuario, status: 'pending', email_message_id: row.id, email_hash: row.recipient_hash,
      expires_at: new Date(Date.now() + 1800000), token_hash: hash(rawToken) };
  t.mock.method(db.EmailMessage, 'findOne', async () => row);
  t.mock.method(db.Usuario, 'findByPk', async () => user);
  t.mock.method(db.EmailSuppression, 'findOne', async () => null);
  t.mock.method(kind === 'code' ? db.AuthEmailChallenge : db.PasswordResetToken, 'findByPk', async () => proof);
  const message = { to: user.email_usuario, outboxId: row.public_id, templateKey: row.template_key, stream: row.stream,
    from: row.from_email, replyTo: row.reply_to, configurationSet: row.configuration_set,
    ...templates.renderTemplate(row.template_key, { ...context, email_message_id: row.id, recipient_domain: row.recipient_domain }) };
  return { message, row, user, proof, context };
}

for (const kind of ['code', 'reset']) test('current registered account ' + kind + ' reaches SES with the general allowlist still enforced', async t => {
  const f = fixture(t, kind); let sends = 0;
  t.mock.method(SESv2Client.prototype, 'send', async command => {
    sends++; assert.deepEqual(command.input.Destination.ToAddresses, [f.user.email_usuario]);
    return { MessageId: 'FICTITIOUS_SES_RECEIPT' };
  });
  assert.equal(await policy.maySend(f.message, { env, models: db }), true);
  assert.equal((await provider.sendEmail(f.message, { env })).providerMessageId, 'FICTITIOUS_SES_RECEIPT');
  assert.equal(sends, 1);
  assert.equal(provider.getConfig(env).requireRecipientAllowlist, true);
  assert.equal(provider.getConfig(env).recipientAllowlist.includes(f.user.email_usuario), false);
});

test('a template label, alternate recipient/body or stale outbox cannot authorize a send', async t => {
  const f = fixture(t);
  t.mock.method(SESv2Client.prototype, 'send', async () => { throw Error('MUST_NOT_SEND'); });
  for (const change of [{ templateKey: 'ops.email_test' }, { stream: 'automation' }, { outboxId: undefined },
    { to: 'other@example.invalid' }, { text: 'arbitrary body' }, { html: '<p>arbitrary</p>' }, { subject: 'custom' },
    { configurationSet: 'other' }, { from: 'other@example.invalid' }, { replyTo: 'other@example.invalid' }]) {
    await assert.rejects(provider.sendEmail({ ...f.message, ...change }, { env }), { code: 'email_recipient_not_allowlisted' });
  }
  for (const status of ['queued', 'sent', 'delivered', 'failed', 'cancelled']) {
    f.row.status = status;
    assert.equal(await policy.maySend(f.message, { env, models: db }), false);
  }
});

test('changed credentials, another user, exhausted or superseded code cannot bypass recipient restrictions', async t => {
  const f = fixture(t); const original = { ...f.proof };
  for (const change of [{ user_id: 999 }, { state: 'used' }, { attempts: 5 }, { email_message_id: 999 },
    { expires_at: new Date(0) }, { code_hash: '0'.repeat(64) }, { credential_binding: '0'.repeat(64) }]) {
    Object.assign(f.proof, original, change);
    assert.equal(await policy.maySend(f.message, { env, models: db }), false);
  }
  Object.assign(f.proof, original);
  f.user.password_usuario = 'ROTATED_FICTITIOUS_HASH';
  assert.equal(await policy.maySend(f.message, { env, models: db }), false);
});

test('used, expired, replaced or redirected password recovery is not an authorized authentication email', async t => {
  const f = fixture(t, 'reset'); const original = { ...f.proof };
  for (const change of [{ status: 'used' }, { user_id: 999 }, { email_message_id: 999 }, { expires_at: new Date(0) },
    { token_hash: '0'.repeat(64) }, { email_hash: '0'.repeat(64) }]) {
    Object.assign(f.proof, original, change);
    assert.equal(await policy.maySend(f.message, { env, models: db }), false);
  }
  Object.assign(f.proof, original);
  assert.equal(await policy.maySend(f.message, { env: { ...env, EMAIL_PUBLIC_APP_URL: 'https://other.example.invalid' }, models: db }), false);
  f.row.template_context = f.context;
  assert.equal(await policy.maySend(f.message, { env, models: db }), false);
});

test('suppressed or inactive recipients remain blocked', async t => {
  const f = fixture(t);
  for (const change of [{ estado_cuenta: 'suspendido' }, { es_provisional: true }, { email_usuario: 'changed@example.invalid' }]) {
    const before = { ...f.user }; Object.assign(f.user, change);
    assert.equal(await policy.maySend(f.message, { env, models: db }), false); Object.assign(f.user, before);
  }
  t.mock.method(db.EmailSuppression, 'findOne', async () => ({ status: 'active' }));
  assert.equal(await policy.maySend(f.message, { env, models: db }), false);
});

test('DEV, gateway, paused workers and disabled policy cannot use the registered-account exception', async t => {
  const f = fixture(t);
  for (const change of [{ EMAIL_AUTHENTICATION_RECIPIENT_POLICY: undefined }, { AUTH_EMAIL_MFA_MODE: 'off' },
    { JOB_RUNTIME_NAMESPACE: 'dev' }, { RUNTIME_ROLE: 'gateway' }, { QUEUE_PREFIX: 'dev' }, { JOBS_WORKER_ENABLED: 'false' }]) {
    assert.equal(await policy.maySend(f.message, { env: { ...env, ...change }, models: db }), false);
  }
});

test('only public gateway authentication emails receive the staging job namespace', () => {
  const gateway = { ...env, RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'gateway', QUEUE_PREFIX: 'gateway', JOBS_WORKER_ENABLED: 'false' };
  for (const key of ['auth.email_verification', 'auth.password_reset']) {
    assert.deepEqual(policy.jobPayload(key, 789, gateway), { email_message_id: 789, __runtime_namespace: 'staging' });
    assert.deepEqual(policy.jobPayload(key, 789, { ...gateway, JOB_RUNTIME_NAMESPACE: 'dev' }), { email_message_id: 789 });
    assert.deepEqual(policy.jobPayload(key, 789, { ...gateway, EMAIL_AUTHENTICATION_RECIPIENT_POLICY: undefined }), { email_message_id: 789 });
  }
  assert.deepEqual(policy.jobPayload('ops.email_test', 789, gateway), { email_message_id: 789 });
});

test('database failure cannot cause SES send and exposes only a bounded retryable error', async t => {
  const f = fixture(t);
  t.mock.method(db.EmailMessage, 'findOne', async () => { throw Error('FICTITIOUS_DATABASE_SECRET'); });
  t.mock.method(SESv2Client.prototype, 'send', async () => { throw Error('MUST_NOT_SEND'); });
  await assert.rejects(provider.sendEmail(f.message, { env }), error => {
    assert.equal(error.code, 'email_authentication_policy_unavailable'); assert.equal(error.retryable, true);
    assert(!error.message.includes('FICTITIOUS_DATABASE_SECRET')); return true;
  });
});
