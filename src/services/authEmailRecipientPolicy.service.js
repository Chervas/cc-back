'use strict';

// An exception for a persisted, current authentication email, never for a
// caller-supplied template name or an arbitrary recipient/body.
const { createHash } = require('node:crypto');
const { Op } = require('sequelize');
const C = require('./authEmailChallenge.contract');
const sessions = require('./accessSession.service');
const TEMPLATES = new Set(['auth.email_verification', 'auth.password_reset']);
const hash = value => createHash('sha256').update(value).digest('hex');
const nullable = value => value || null;

function enabled(env = process.env) {
  return env.EMAIL_AUTHENTICATION_RECIPIENT_POLICY === 'registered-account'
    && C.mode(env) === 'enforce';
}

function jobPayload(templateKey, emailMessageId, env = process.env) {
  const payload = { email_message_id: emailMessageId };
  // Gateway produces public login/reset emails; only staging consumes them.
  // DEV cannot redirect a job to the public lane by setting this policy.
  if (TEMPLATES.has(templateKey) && enabled(env) && env.RUNTIME_ROLE === 'gateway'
    && env.JOB_RUNTIME_NAMESPACE === 'gateway' && env.QUEUE_PREFIX === 'gateway') {
    payload.__runtime_namespace = 'staging';
  }
  return payload;
}

async function maySend(delivery, { env = process.env, models, now = () => new Date() } = {}) {
  const devWorker = env.DEV_SECURITY_WORKER === 'true' && env.RUNTIME_NAMESPACE === 'dev'
    && env.JOB_RUNTIME_NAMESPACE === 'dev' && env.QUEUE_PREFIX === 'dev'
    && env.DB_NAME === 'clinicaclick_dev_isolated' && env.JOBS_WORKER_ENABLED === 'false';
  const publicWorker = env.JOB_RUNTIME_NAMESPACE === 'staging' && env.QUEUE_PREFIX === 'staging'
    && env.JOBS_WORKER_ENABLED === 'true';
  if (!enabled(env) || env.RUNTIME_ROLE !== 'api' || (!devWorker && !publicWorker)
    || !TEMPLATES.has(delivery?.templateKey) || delivery.stream !== 'transactional'
    || typeof delivery.outboxId !== 'string' || !/^em_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(delivery.outboxId)
    || typeof delivery.to !== 'string' || delivery.to !== delivery.to.trim().toLowerCase()) return false;
  const db = models || require('../../models');
  const row = await db.EmailMessage.findOne({ where: { public_id: delivery.outboxId }, raw: true, logging: false });
  if (!row || row.status !== 'sending' || row.public_id !== delivery.outboxId
    || row.stream !== 'transactional' || row.template_key !== delivery.templateKey
    || row.template_version !== 'v1' || row.recipient_kind !== 'user'
    || !Number.isSafeInteger(Number(row.usuario_id)) || Number(row.usuario_id) <= 0
    || row.clinica_id != null || row.paciente_id != null || row.recipient_hash !== hash(delivery.to)
    || nullable(row.from_email) !== nullable(delivery.from)
    || nullable(row.reply_to) !== nullable(delivery.replyTo)
    || row.configuration_set !== delivery.configurationSet
    || row.configuration_set !== (env.EMAIL_TRANSACTIONAL_CONFIGURATION_SET || 'clinicaclick-transactional')) return false;

  const user = await db.Usuario.findByPk(row.usuario_id, {
    attributes: ['id_usuario', 'email_usuario', 'password_usuario', 'estado_cuenta', 'es_provisional'], raw: true, logging: false,
  });
  if (!sessions.activeUser(user) || String(user.email_usuario).trim().toLowerCase() !== delivery.to) return false;
  const suppressed = await db.EmailSuppression.findOne({ where: {
    email_hash: row.recipient_hash, status: 'active', stream: { [Op.in]: ['all', 'transactional'] }, scope: 'global',
  }, raw: true, logging: false });
  if (suppressed) return false;

  let context;
  try {
    // Legacy plaintext reset contexts remain subject to the ordinary allowlist.
    if (row.template_key === 'auth.password_reset' && (!row.template_context
      || Object.hasOwn(row.template_context, 'reset_url')
      || typeof row.template_context.reset_url_envelope !== 'string'
      || !row.template_context.reset_url_envelope)) return false;
    context = require('./emailDelivery.service').unsealSensitiveTemplateContext(row.template_context, row);
  } catch { return false; }
  if (row.template_key === 'auth.email_verification') {
    if (context.auth_email_challenge_id !== row.related_id) return false;
    const challenge = await db.AuthEmailChallenge.findByPk(row.related_id, { raw: true, logging: false });
    if (!challenge || Number(challenge.user_id) !== Number(row.usuario_id)) return false;
    if (!await require('./authEmailDeliveryGuard.service').mayDeliver(row, delivery.to, context, {
      models: db, now, config: () => C.settings(env),
      sessionService: { credentialBinding: value => sessions.binding(value, env.JWT_SECRET) },
    })) return false;
  } else {
    if (row.related_type !== 'password_reset_token' || String(context.password_reset_token_id) !== String(row.related_id)) return false;
    const token = await db.PasswordResetToken.findByPk(row.related_id, { raw: true, logging: false });
    if (!token || token.status !== 'pending' || Number(token.user_id) !== Number(row.usuario_id)
      || Number(token.email_message_id) !== Number(row.id) || token.email_hash !== row.recipient_hash
      || !(new Date(token.expires_at).getTime() > now().getTime())) return false;
    try {
      const base = String(env.EMAIL_PUBLIC_APP_URL || env.FRONTEND_PUBLIC_URL || '').replace(/\/+$/, '');
      const url = new URL(context.reset_url);
      const raw = url.searchParams.get('token');
      const localDev = devWorker && ['http://localhost:4200', 'http://localhost:4203'].includes(base)
        && url.origin === base;
      if ((!localDev && url.protocol !== 'https:') || !C.challengeToken(raw)
        || context.reset_url !== base + '/reset-password?token=' + encodeURIComponent(raw)
        || !C.equalHash(hash(raw), token.token_hash)) return false;
    } catch { return false; }
  }

  // The registered-account policy cannot authorize custom email content, even
  // if another internal caller knows the public outbox ID.
  const rendered = require('./emailTemplates.service').renderTemplate(row.template_key, {
    ...context, email_message_id: row.id, recipient_domain: row.recipient_domain,
  });
  return ['subject', 'html', 'text'].every(key => nullable(delivery[key]) === nullable(rendered[key]));
}

module.exports = { enabled, jobPayload, maySend };
