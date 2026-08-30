'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const emailProvider = require('./emailProvider.service');
const emailTemplates = require('./emailTemplates.service');
const {
  isAmbiguousProviderOutcome,
  revokePendingPasswordResetToken,
} = require('./emailRelatedState.service');
const { encryptEmailValue, decryptEmailValue } = require('../lib/emailSensitiveEnvelope');

const EMAIL_SEND_JOB_TYPE = 'email_send';
const TERMINAL_EMAIL_STATUSES = new Set([
  'sent',
  'delivered',
  'rejected',
  'bounced',
  'complained',
  'suppressed',
  'failed',
  'cancelled',
]);

function cleanString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function parseIntSafe(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizeStream(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['transactional', 'automation', 'marketing'].includes(normalized)) return normalized;
  return 'transactional';
}

function normalizePriority(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['critical', 'high', 'normal', 'low'].includes(normalized)) return normalized;
  return 'normal';
}

function normalizeEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    const error = new Error('email_recipient_invalid');
    error.code = 'email_recipient_invalid';
    error.retryable = false;
    throw error;
  }
  return normalized;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function hashEmail(email) {
  return sha256(normalizeEmail(email));
}

function emailDomain(email) {
  const normalized = normalizeEmail(email);
  return normalized.split('@').pop() || null;
}

function envelopeContext(message) {
  return `message:${message.public_id}:${message.recipient_hash}`;
}

function templateContextEnvelopeContext({ publicId, recipientHash, field }) {
  return `message:${publicId}:${recipientHash}:template_context:${field}`;
}

function normalizeTemplateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return {};
  return { ...context };
}

function sealSensitiveTemplateContext(context, { publicId, recipientHash, templateKey }) {
  const sealed = normalizeTemplateContext(context);
  if (String(templateKey || '').trim() === 'auth.password_reset' && cleanString(sealed.reset_url)) {
    sealed.reset_url_envelope = encryptEmailValue(
      sealed.reset_url,
      templateContextEnvelopeContext({ publicId, recipientHash, field: 'reset_url' })
    );
    delete sealed.reset_url;
  }
  return sealed;
}

function unsealSensitiveTemplateContext(context, message) {
  const unsealed = normalizeTemplateContext(context);
  if (!cleanString(unsealed.reset_url) && cleanString(unsealed.reset_url_envelope)) {
    unsealed.reset_url = decryptEmailValue(
      unsealed.reset_url_envelope,
      templateContextEnvelopeContext({
        publicId: message.public_id,
        recipientHash: message.recipient_hash,
        field: 'reset_url',
      })
    );
  }
  delete unsealed.reset_url_envelope;
  return unsealed;
}

function sanitizeErrorMessage(value) {
  const normalized = cleanString(value);
  if (!normalized) return null;
  return normalized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\+?\d[\s().-]?){9,}/g, '[phone]')
    .slice(0, 1000);
}

function publicId() {
  return `em_${crypto.randomUUID()}`;
}

function maxAttempts() {
  return Math.max(1, parseIntSafe(process.env.EMAIL_MAX_ATTEMPTS, 3));
}

async function findActiveSuppression({ emailHash, stream, clinicaId }, options = {}) {
  const scopeValues = ['global'];
  if (clinicaId) scopeValues.push(`clinic:${clinicaId}`);
  return db.EmailSuppression.findOne({
    where: {
      email_hash: emailHash,
      status: 'active',
      stream: { [Op.in]: ['all', stream] },
      scope: { [Op.in]: scopeValues },
    },
    order: [['created_at', 'DESC']],
    transaction: options.transaction,
  });
}

async function queueEmail(input = {}, options = {}) {
  const recipientEmail = normalizeEmail(input.recipientEmail || input.to);
  const stream = normalizeStream(input.stream);
  const recipientHash = hashEmail(recipientEmail);
  const templateKey = cleanString(input.templateKey) || 'ops.email_test';
  const dedupeKey = cleanString(input.dedupeKey)
    || sha256([
      stream,
      templateKey,
      recipientHash,
      input.relatedType || '',
      input.relatedId || '',
      JSON.stringify(input.templateContext || {}),
    ].join(':'));

  const run = async (transaction) => {
    const providerConfig = emailProvider.getConfig();
    const rowPublicId = publicId();
    const envelope = encryptEmailValue(recipientEmail, `message:${rowPublicId}:${recipientHash}`);
    const storedTemplateContext = sealSensitiveTemplateContext(input.templateContext || {}, {
      publicId: rowPublicId,
      recipientHash,
      templateKey,
    });
    const configurationSet = cleanString(input.configurationSet)
      || emailProvider.mapStreamToConfigurationSet(stream, providerConfig);
    const [message, messageCreated] = await db.EmailMessage.findOrCreate({
      where: { dedupe_key: dedupeKey },
      defaults: {
        public_id: rowPublicId,
        stream,
        provider: providerConfig.provider,
        provider_region: providerConfig.region,
        configuration_set: configurationSet,
        status: 'queued',
        priority: normalizePriority(input.priority),
        dedupe_key: dedupeKey,
        template_key: templateKey,
        template_version: cleanString(input.templateVersion) || 'v1',
        subject_key: cleanString(input.subjectKey) || templateKey,
        from_email: cleanString(input.fromEmail) || providerConfig.defaultFrom,
        reply_to: cleanString(input.replyTo) || providerConfig.defaultReplyTo,
        recipient_email_envelope: envelope,
        recipient_hash: recipientHash,
        recipient_domain: emailDomain(recipientEmail),
        recipient_kind: cleanString(input.recipientKind) || 'external',
        clinica_id: input.clinicaId || input.clinica_id || null,
        paciente_id: input.pacienteId || input.paciente_id || null,
        usuario_id: input.usuarioId || input.usuario_id || null,
        related_type: cleanString(input.relatedType),
        related_id: cleanString(input.relatedId),
        template_context: storedTemplateContext,
        metadata: input.metadata || {},
        queued_at: new Date(),
      },
      transaction,
    });
    if (!messageCreated) {
      return { emailMessage: message, created: false, job: null };
    }

    const { job, created } = await jobRequestsService.enqueueUniqueJobRequest({
      type: EMAIL_SEND_JOB_TYPE,
      payload: { email_message_id: message.id },
      priority: message.priority,
      origin: cleanString(input.origin) || 'email_outbox',
      requestedBy: input.requestedBy || null,
      requestedByName: input.requestedByName || null,
      requestedByRole: input.requestedByRole || null,
      maxAttempts: maxAttempts(),
      dedupeScope: `email:${dedupeKey}`,
    }, { transaction });

    await message.update({ job_request_id: job?.id || null }, { transaction });
    return { emailMessage: message, created: true, job, jobCreated: created };
  };

  if (options.transaction) return run(options.transaction);
  return db.sequelize.transaction(run);
}

function buildSendContext(message, decryptedRecipient) {
  const context = unsealSensitiveTemplateContext(message.template_context, message);
  return {
    ...context,
    email_message_id: message.id,
    recipient_domain: message.recipient_domain || emailDomain(decryptedRecipient),
  };
}

async function markMessageFailure(message, providerError, { retryable } = {}) {
  const now = new Date();
  const terminalStatus = retryable ? 'queued' : 'failed';
  const rejected = !retryable && /reject/i.test(String(providerError.code || ''));
  const settlement = await settleMessageIfActive(message, {
    status: terminalStatus,
    last_error_code: providerError.code || 'email_send_failed',
    last_error_message: sanitizeErrorMessage(providerError.message || providerError.code),
    rejected_at: rejected ? now : null,
    completed_at: retryable ? null : now,
  });
  if (settlement.updated && db.SystemNotificationDelivery && message.related_type === 'system_notification') {
    await db.SystemNotificationDelivery.update({
      status: retryable ? 'queued' : 'failed',
      error_code: providerError.code || 'email_send_failed',
      error_message: sanitizeErrorMessage(providerError.message || providerError.code),
      failed_at: retryable ? null : now,
      completed_at: retryable ? null : now,
    }, {
      where: {
        email_message_id: message.id,
        channel: 'email',
        status: { [Op.in]: ['queued', 'sending'] },
      },
    });
  }
  if (settlement.updated && !retryable && !isAmbiguousProviderOutcome(providerError.code)) {
    await revokePendingPasswordResetToken(message);
  }
  return settlement;
}

async function settleMessageIfActive(message, patch) {
  const [affectedRows] = await db.EmailMessage.update(patch, {
    where: {
      id: message.id,
      status: { [Op.in]: ['queued', 'sending'] },
    },
  });
  if (Number(affectedRows || 0) > 0) {
    Object.assign(message, patch);
    return { updated: true, message };
  }
  const current = await db.EmailMessage.findByPk(message.id);
  return { updated: false, message: current || message };
}

async function runEmailSendJob(payload = {}, jobRequest = null) {
  const emailMessageId = parseIntSafe(payload.email_message_id || payload.emailMessageId, 0);
  if (!emailMessageId) {
    const error = new Error('email_send_job_requires_email_message_id');
    error.code = 'email_send_job_requires_email_message_id';
    throw error;
  }

  const message = await db.EmailMessage.findByPk(emailMessageId);
  if (!message) {
    return { status: 'completed', result: { skipped: true, reason: 'email_message_not_found', email_message_id: emailMessageId } };
  }

  if (TERMINAL_EMAIL_STATUSES.has(message.status)) {
    return {
      status: 'completed',
      result: {
        email_message_id: message.id,
        already_terminal: true,
        email_status: message.status,
        provider_message_id: message.provider_message_id || null,
      },
    };
  }

  const suppression = await findActiveSuppression({
    emailHash: message.recipient_hash,
    stream: message.stream,
    clinicaId: message.clinica_id,
  });
  if (suppression) {
    await message.update({
      status: 'suppressed',
      suppressed_at: new Date(),
      completed_at: new Date(),
      last_error_code: 'email_recipient_suppressed',
      last_error_message: 'El destinatario está en lista de supresión.',
    });
    await revokePendingPasswordResetToken(message);
    return {
      status: 'completed',
      result: {
        email_message_id: message.id,
        skipped: true,
        reason: 'recipient_suppressed',
      },
    };
  }

  let recipient;
  try {
    recipient = decryptEmailValue(message.recipient_email_envelope, envelopeContext(message));
  } catch (error) {
    await markMessageFailure(message, { code: error.code || 'email_decrypt_failed', message: error.message }, { retryable: false });
    return {
      status: 'failed',
      retryable: false,
      error,
      result: { email_message_id: message.id, code: error.code || 'email_decrypt_failed' },
    };
  }

  await message.update({ status: 'sending', last_error_code: null, last_error_message: null });

  let providerResult = null;
  try {
    const rendered = emailTemplates.renderTemplate(message.template_key, buildSendContext(message, recipient));
    providerResult = await emailProvider.sendEmail({
      to: recipient,
      from: message.from_email,
      replyTo: message.reply_to,
      outboxId: message.public_id,
      stream: message.stream,
      configurationSet: message.configuration_set,
      templateKey: message.template_key,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    const settlement = await settleMessageIfActive(message, {
      status: 'sent',
      provider: providerResult.provider,
      provider_message_id: providerResult.providerMessageId,
      configuration_set: providerResult.configurationSet || message.configuration_set,
      sent_at: new Date(),
      completed_at: new Date(),
      last_error_code: null,
      last_error_message: null,
    });
    if (settlement.updated && db.SystemNotificationDelivery && message.related_type === 'system_notification') {
      await db.SystemNotificationDelivery.update({
        status: 'sent',
        provider: providerResult.provider,
        provider_message_id: providerResult.providerMessageId || null,
        sent_at: new Date(),
        completed_at: null,
        error_code: null,
        error_message: null,
        failed_at: null,
      }, {
        where: {
          email_message_id: message.id,
          channel: 'email',
          status: { [Op.in]: ['queued', 'sending'] },
        },
      });
    }
    const settledMessage = settlement.message;
    return {
      status: 'completed',
      result: {
        email_message_id: message.id,
        email_status: settledMessage.status || 'sent',
        provider: providerResult.provider,
        provider_message_id: settledMessage.provider_message_id
          || providerResult.providerMessageId
          || null,
        settled_by_provider_event: !settlement.updated,
      },
    };
  } catch (error) {
    if (providerResult?.providerMessageId) {
      let current = null;
      try {
        current = await db.EmailMessage.findByPk(message.id);
      } catch (_) {
        current = null;
      }
      if (current && TERMINAL_EMAIL_STATUSES.has(current.status)) {
        return {
          status: 'completed',
          result: {
            email_message_id: message.id,
            email_status: current.status,
            provider_message_id: current.provider_message_id || providerResult.providerMessageId,
            settlement_warning: 'email_related_state_settlement_failed_after_accept',
          },
        };
      }
      return {
        status: 'failed',
        retryable: false,
        error: new Error('email_outbox_settlement_failed_after_accept'),
        result: {
          email_message_id: message.id,
          code: 'email_outbox_settlement_failed_after_accept',
          provider_message_id: providerResult.providerMessageId,
          retryable: false,
        },
      };
    }
    const providerError = emailProvider.classifyProviderError(error);
    const safeProviderMessage = sanitizeErrorMessage(providerError.message || providerError.code)
      || providerError.code
      || 'email_provider_error';
    let settlement;
    try {
      settlement = await markMessageFailure(message, providerError, { retryable: providerError.retryable });
    } catch (_) {
      return {
        status: 'failed',
        retryable: providerError.retryable,
        error: new Error('email_failure_settlement_failed'),
        result: {
          email_message_id: message.id,
          code: providerError.code,
          retryable: providerError.retryable,
          settlement_failed: true,
        },
      };
    }
    if (!settlement.updated && TERMINAL_EMAIL_STATUSES.has(settlement.message?.status)) {
      return {
        status: 'completed',
        result: {
          email_message_id: message.id,
          email_status: settlement.message.status,
          provider_message_id: settlement.message.provider_message_id || null,
          settled_by_provider_event: true,
        },
      };
    }
    return {
      status: 'failed',
      retryable: providerError.retryable,
      error: new Error(safeProviderMessage),
      result: {
        email_message_id: message.id,
        code: providerError.code,
        retryable: providerError.retryable,
      },
    };
  }
}

module.exports = {
  EMAIL_SEND_JOB_TYPE,
  queueEmail,
  runEmailSendJob,
  normalizeEmail,
  hashEmail,
  sha256,
  findActiveSuppression,
  sanitizeErrorMessage,
  sealSensitiveTemplateContext,
  unsealSensitiveTemplateContext,
};
