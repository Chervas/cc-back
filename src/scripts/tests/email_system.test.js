'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SESv2Client } = require('@aws-sdk/client-sesv2');

const db = require('../../../models');
const jobRequestsService = require('../../services/jobRequests.service');
const { encryptEmailValue, decryptEmailValue } = require('../../lib/emailSensitiveEnvelope');
const emailDelivery = require('../../services/emailDelivery.service');
const emailEvents = require('../../services/emailEvents.service');
const emailMonitoring = require('../../services/emailMonitoring.service');
const emailProvider = require('../../services/emailProvider.service');
const emailTemplates = require('../../services/emailTemplates.service');
const emailController = require('../../controllers/email.controller');
const passwordReset = require('../../services/passwordReset.service');

const TEST_KEY = 'email-test-key-32-bytes-minimum';

function withEnv(patch, fn) {
  const previous = {};
  Object.keys(patch).forEach((key) => {
    previous[key] = process.env[key];
    process.env[key] = patch[key];
  });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Object.keys(patch).forEach((key) => {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      });
    });
}

function patchProperty(object, key, value) {
  const previous = object[key];
  object[key] = value;
  return () => { object[key] = previous; };
}

function patchConditionalEmailMessageUpdate(messageOrGetter, beforeUpdate = null) {
  return patchProperty(db.EmailMessage, 'update', async (patch, options = {}) => {
    const message = typeof messageOrGetter === 'function' ? messageOrGetter() : messageOrGetter;
    assert.ok(message, 'email message fixture must exist before settlement');
    if (beforeUpdate) await beforeUpdate(patch, options);
    const statusValues = options.where?.status
      ? Reflect.ownKeys(options.where.status)
        .map((key) => options.where.status[key])
        .find(Array.isArray)
      : null;
    if (options.where?.id && Number(options.where.id) !== Number(message.id)) return [0];
    if (statusValues && !statusValues.includes(message.status)) return [0];
    Object.assign(message, patch);
    return [1];
  });
}

test('email envelope cifra destinatarios y autentica contexto', async () => {
  await withEnv({ EMAIL_DATA_ENCRYPTION_KEY: TEST_KEY }, async () => {
    const sealed = encryptEmailValue('persona@example.test', 'message:1');
    assert.doesNotMatch(sealed, /persona@example\.test/);
    assert.equal(decryptEmailValue(sealed, 'message:1'), 'persona@example.test');
    assert.throws(
      () => decryptEmailValue(sealed, 'message:2'),
      (error) => error.code === 'email_envelope_decrypt_failed'
    );
  });
});

test('queueEmail crea EmailMessage y JobRequest con payload mínimo', async () => {
  await withEnv({
    EMAIL_DATA_ENCRYPTION_KEY: TEST_KEY,
    EMAIL_PROVIDER: 'mock',
    EMAIL_ENABLED: 'true',
  }, async () => {
    let capturedJob = null;
    const restores = [
      patchProperty(db.sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } })),
      patchProperty(db.EmailMessage, 'findOrCreate', async ({ defaults }) => ([{
        id: 101,
        ...defaults,
        async update(patch) {
          Object.assign(this, patch);
          return this;
        },
      }, true])),
      patchProperty(jobRequestsService, 'enqueueUniqueJobRequest', async (input) => {
        capturedJob = input;
        return { created: true, job: { id: 202 } };
      }),
    ];
    try {
      const result = await emailDelivery.queueEmail({
        recipientEmail: 'Persona@Example.Test',
        templateKey: 'ops.email_test',
        dedupeKey: 'test:email:1',
      });
      assert.equal(result.emailMessage.id, 101);
      assert.equal(result.emailMessage.job_request_id, 202);
      assert.deepEqual(capturedJob.payload, { email_message_id: 101 });
      assert.equal(capturedJob.maxAttempts, 3);
      assert.doesNotMatch(JSON.stringify(capturedJob), /Persona|example\.test/i);
      assert.doesNotMatch(result.emailMessage.recipient_email_envelope, /persona@example\.test/i);
      assert.equal(result.emailMessage.recipient_domain, 'example.test');
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  });
});

test('runEmailSendJob envía por mock de forma idempotente y sin proveedor real', async () => {
  await withEnv({
    EMAIL_DATA_ENCRYPTION_KEY: TEST_KEY,
    EMAIL_PROVIDER: 'mock',
    EMAIL_ENABLED: 'true',
  }, async () => {
    const recipientHash = emailDelivery.hashEmail('persona@example.test');
    const message = {
      id: 303,
      public_id: 'em-test',
      stream: 'transactional',
      provider: 'mock',
      provider_region: 'eu-west-3',
      status: 'queued',
      priority: 'normal',
      template_key: 'ops.email_test',
      template_context: {},
      recipient_hash: recipientHash,
      recipient_domain: 'example.test',
      recipient_email_envelope: encryptEmailValue('persona@example.test', `message:em-test:${recipientHash}`),
      async update(patch) {
        Object.assign(this, patch);
        return this;
      },
    };
    const restores = [
      patchProperty(db.EmailMessage, 'findByPk', async () => message),
      patchConditionalEmailMessageUpdate(message),
      patchProperty(db.EmailSuppression, 'findOne', async () => null),
    ];
    try {
      const result = await emailDelivery.runEmailSendJob({ email_message_id: 303 });
      assert.equal(result.status, 'completed');
      assert.equal(message.status, 'sent');
      assert.match(message.provider_message_id, /^mock_/);
      assert.equal(result.result.email_message_id, 303);
      const firstProviderMessageId = message.provider_message_id;
      const duplicateResult = await emailDelivery.runEmailSendJob({ email_message_id: 303 });
      assert.equal(duplicateResult.status, 'completed');
      assert.equal(duplicateResult.result.already_terminal, true);
      assert.equal(duplicateResult.result.provider_message_id, firstProviderMessageId);
      assert.equal(message.provider_message_id, firstProviderMessageId);
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  });
});

test('runEmailSendJob revoca el token si una supresión impide enviar el reset', async () => {
  await withEnv({
    EMAIL_DATA_ENCRYPTION_KEY: TEST_KEY,
    EMAIL_PROVIDER: 'mock',
    EMAIL_ENABLED: 'true',
  }, async () => {
    const recipientHash = emailDelivery.hashEmail('persona@example.test');
    const message = {
      id: 304,
      public_id: 'em-suppressed-reset',
      stream: 'transactional',
      related_type: 'password_reset_token',
      status: 'queued',
      recipient_hash: recipientHash,
      async update(patch) {
        Object.assign(this, patch);
        return this;
      },
    };
    let revokedTokens = 0;
    const restores = [
      patchProperty(db.EmailMessage, 'findByPk', async () => message),
      patchProperty(db.EmailSuppression, 'findOne', async () => ({ id: 1 })),
      patchProperty(db.PasswordResetToken, 'update', async ({ status }, { where }) => {
        assert.equal(status, 'revoked');
        assert.deepEqual(where, { email_message_id: 304, status: 'pending' });
        revokedTokens += 1;
        return [1];
      }),
      patchProperty(emailProvider, 'sendEmail', async () => {
        throw new Error('provider must not be called for suppressed recipient');
      }),
    ];
    try {
      const result = await emailDelivery.runEmailSendJob({ email_message_id: 304 });
      assert.equal(result.status, 'completed');
      assert.equal(result.result.reason, 'recipient_suppressed');
      assert.equal(message.status, 'suppressed');
      assert.equal(revokedTokens, 1);
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  });
});

test('runEmailSendJob falla sin reintento cuando SES está desactivado', async () => {
  await withEnv({
    EMAIL_DATA_ENCRYPTION_KEY: TEST_KEY,
    EMAIL_PROVIDER: 'ses',
    EMAIL_ENABLED: 'false',
  }, async () => {
    const recipientHash = emailDelivery.hashEmail('persona@example.test');
    const message = {
      id: 404,
      public_id: 'em-disabled',
      stream: 'transactional',
      provider: 'ses',
      provider_region: 'eu-west-3',
      status: 'queued',
      template_key: 'ops.email_test',
      template_context: {},
      recipient_hash: recipientHash,
      recipient_domain: 'example.test',
      recipient_email_envelope: encryptEmailValue('persona@example.test', `message:em-disabled:${recipientHash}`),
      async update(patch) {
        Object.assign(this, patch);
        return this;
      },
    };
    const restores = [
      patchProperty(db.EmailMessage, 'findByPk', async () => message),
      patchConditionalEmailMessageUpdate(message),
      patchProperty(db.EmailSuppression, 'findOne', async () => null),
    ];
    try {
      const result = await emailDelivery.runEmailSendJob({ email_message_id: 404 });
      assert.equal(result.status, 'failed');
      assert.equal(result.retryable, false);
      assert.equal(message.status, 'failed');
      assert.equal(message.last_error_code, 'email_provider_disabled');
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  });
});

test('SES falla cerrado cuando faltan credenciales dedicadas', async () => {
  await assert.rejects(
    () => emailProvider.sendEmail({
      to: 'persona@example.test',
      stream: 'transactional',
      subject: 'Prueba controlada',
      text: 'Contenido de prueba',
    }, {
      env: {
        EMAIL_PROVIDER: 'ses',
        EMAIL_ENABLED: 'true',
        EMAIL_REQUIRE_RECIPIENT_ALLOWLIST: 'false',
        EMAIL_AWS_REGION: 'eu-west-3',
      },
    }),
    (error) => error.code === 'email_ses_credentials_missing' && error.retryable === false
  );
});

test('SES etiqueta el outbox opaco y exige MessageId sin realizar red', async () => {
  const originalSend = SESv2Client.prototype.send;
  let capturedInput = null;
  let capturedMaxAttempts = null;
  let response = { MessageId: 'ses-controlled-message' };
  SESv2Client.prototype.send = async function sendWithoutNetwork(command) {
    capturedInput = command.input;
    capturedMaxAttempts = await this.config.maxAttempts();
    return response;
  };
  const env = {
    EMAIL_PROVIDER: 'ses',
    EMAIL_ENABLED: 'true',
    EMAIL_REQUIRE_RECIPIENT_ALLOWLIST: 'false',
    EMAIL_AWS_REGION: 'eu-west-3',
    EMAIL_AWS_ACCESS_KEY_ID: 'TESTACCESSKEY',
    EMAIL_AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
    EMAIL_TRANSACTIONAL_CONFIGURATION_SET: 'clinicaclick-transactional',
  };
  try {
    const result = await emailProvider.sendEmail({
      to: 'persona@example.test',
      outboxId: 'em_12345678-1234-1234-1234-123456789abc',
      stream: 'transactional',
      templateKey: 'ops.email_test',
      subject: 'Prueba controlada',
      text: 'Contenido de prueba',
    }, { env });
    assert.equal(result.providerMessageId, 'ses-controlled-message');
    assert.equal(capturedMaxAttempts, 1);
    assert.deepEqual(capturedInput.EmailTags, [
      { Name: 'stream', Value: 'transactional' },
      { Name: 'template', Value: 'ops_email_test' },
      { Name: 'cc_outbox', Value: 'em_12345678-1234-1234-1234-123456789abc' },
    ]);
    assert.doesNotMatch(JSON.stringify(capturedInput.EmailTags), /persona@example\.test/i);

    response = {};
    await assert.rejects(
      () => emailProvider.sendEmail({
        to: 'persona@example.test',
        outboxId: 'em_12345678-1234-1234-1234-123456789abc',
        stream: 'transactional',
        subject: 'Prueba controlada',
        text: 'Contenido de prueba',
      }, { env }),
      (error) => error.code === 'email_provider_response_missing_message_id'
        && error.retryable === false
    );
  } finally {
    SESv2Client.prototype.send = originalSend;
  }
});

test('timeout SES de resultado ambiguo falla sin reenvío automático', async () => {
  await withEnv({
    EMAIL_DATA_ENCRYPTION_KEY: TEST_KEY,
    EMAIL_PROVIDER: 'ses',
    EMAIL_ENABLED: 'true',
  }, async () => {
    const recipientHash = emailDelivery.hashEmail('persona@example.test');
    const message = {
      id: 405,
      public_id: 'em_timeout',
      stream: 'transactional',
      related_type: 'password_reset_token',
      status: 'queued',
      template_key: 'ops.email_test',
      template_context: {},
      recipient_hash: recipientHash,
      recipient_domain: 'example.test',
      recipient_email_envelope: encryptEmailValue('persona@example.test', `message:em_timeout:${recipientHash}`),
      async update(patch) {
        Object.assign(this, patch);
        return this;
      },
    };
    let revokedTokens = 0;
    const restores = [
      patchProperty(db.EmailMessage, 'findByPk', async () => message),
      patchConditionalEmailMessageUpdate(message),
      patchProperty(db.EmailSuppression, 'findOne', async () => null),
      patchProperty(db.PasswordResetToken, 'update', async () => {
        revokedTokens += 1;
        return [1];
      }),
      patchProperty(emailProvider, 'sendEmail', async () => {
        const error = new Error('request timed out');
        error.name = 'AbortError';
        throw error;
      }),
    ];
    try {
      const result = await emailDelivery.runEmailSendJob({ email_message_id: 405 });
      assert.equal(result.status, 'failed');
      assert.equal(result.retryable, false);
      assert.equal(result.result.code, 'email_provider_timeout_unknown_outcome');
      assert.equal(message.status, 'failed');
      assert.equal(message.last_error_code, 'email_provider_timeout_unknown_outcome');
      assert.equal(message.rejected_at, null);
      assert.equal(revokedTokens, 0);
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  });
});

test('errores 5xx y de transporte SES ambiguos fallan sin reenvío automático', () => {
  const error = new Error('internal server error');
  error.name = 'InternalServerError';
  error.$metadata = { httpStatusCode: 500 };
  assert.deepEqual(emailProvider.classifyProviderError(error), {
    code: 'email_provider_server_error_unknown_outcome',
    retryable: false,
    message: 'email_provider_server_error_unknown_outcome',
  });

  const transportError = new Error('socket hang up');
  transportError.code = 'ECONNRESET';
  transportError.$retryable = {};
  assert.deepEqual(emailProvider.classifyProviderError(transportError), {
    code: 'email_provider_transport_unknown_outcome',
    retryable: false,
    message: 'email_provider_transport_unknown_outcome',
  });
});

test('un evento concurrente no se degrada al asentar éxito o timeout del worker', async () => {
  await withEnv({
    EMAIL_DATA_ENCRYPTION_KEY: TEST_KEY,
    EMAIL_PROVIDER: 'ses',
    EMAIL_ENABLED: 'true',
  }, async () => {
    async function runScenario({ id, providerAction, workerSettlementStatus }) {
      const recipientHash = emailDelivery.hashEmail('persona@example.test');
      const message = {
        id,
        public_id: `em_race_${id}`,
        stream: 'transactional',
        status: 'queued',
        template_key: 'ops.email_test',
        template_context: {},
        recipient_hash: recipientHash,
        recipient_domain: 'example.test',
        recipient_email_envelope: encryptEmailValue(
          'persona@example.test',
          `message:em_race_${id}:${recipientHash}`,
        ),
        async update(patch) {
          Object.assign(this, patch);
          return this;
        },
      };
      const restores = [
        patchProperty(db.EmailMessage, 'findByPk', async () => message),
        patchConditionalEmailMessageUpdate(message, async (patch) => {
          if (patch.status !== workerSettlementStatus) return;
          Object.assign(message, {
            status: 'delivered',
            provider_message_id: `ses_event_${id}`,
            delivered_at: new Date('2026-08-30T15:25:00Z'),
            completed_at: new Date('2026-08-30T15:25:00Z'),
            last_error_code: null,
            last_error_message: null,
          });
        }),
        patchProperty(db.EmailSuppression, 'findOne', async () => null),
        patchProperty(emailProvider, 'sendEmail', providerAction),
      ];
      try {
        return { message, result: await emailDelivery.runEmailSendJob({ email_message_id: id }) };
      } finally {
        restores.reverse().forEach((restore) => restore());
      }
    }

    const accepted = await runScenario({
      id: 408,
      workerSettlementStatus: 'sent',
      providerAction: async () => ({
        provider: 'ses',
        providerMessageId: 'ses_response_408',
        configurationSet: 'clinicaclick-transactional',
      }),
    });
    assert.equal(accepted.result.status, 'completed');
    assert.equal(accepted.result.result.email_status, 'delivered');
    assert.equal(accepted.result.result.settled_by_provider_event, true);
    assert.equal(accepted.message.provider_message_id, 'ses_event_408');

    const timedOut = await runScenario({
      id: 409,
      workerSettlementStatus: 'failed',
      providerAction: async () => {
        const error = new Error('request timed out');
        error.name = 'AbortError';
        throw error;
      },
    });
    assert.equal(timedOut.result.status, 'completed');
    assert.equal(timedOut.result.result.email_status, 'delivered');
    assert.equal(timedOut.result.result.settled_by_provider_event, true);
    assert.equal(timedOut.message.last_error_code, null);
  });
});

test('un fallo al persistir el resultado no reenvía una aceptación o timeout ambiguo', async () => {
  await withEnv({
    EMAIL_DATA_ENCRYPTION_KEY: TEST_KEY,
    EMAIL_PROVIDER: 'ses',
    EMAIL_ENABLED: 'true',
  }, async () => {
    async function runScenario(id, providerAction) {
      const recipientHash = emailDelivery.hashEmail('persona@example.test');
      const message = {
        id,
        public_id: `em_settlement_${id}`,
        stream: 'transactional',
        status: 'queued',
        template_key: 'ops.email_test',
        template_context: {},
        recipient_hash: recipientHash,
        recipient_domain: 'example.test',
        recipient_email_envelope: encryptEmailValue(
          'persona@example.test',
          `message:em_settlement_${id}:${recipientHash}`,
        ),
        async update(patch) {
          Object.assign(this, patch);
          return this;
        },
      };
      const restores = [
        patchProperty(db.EmailMessage, 'findByPk', async () => message),
        patchProperty(db.EmailMessage, 'update', async () => {
          throw new Error('database unavailable');
        }),
        patchProperty(db.EmailSuppression, 'findOne', async () => null),
        patchProperty(emailProvider, 'sendEmail', providerAction),
      ];
      try {
        return await emailDelivery.runEmailSendJob({ email_message_id: id });
      } finally {
        restores.reverse().forEach((restore) => restore());
      }
    }

    const accepted = await runScenario(410, async () => ({
      provider: 'ses',
      providerMessageId: 'ses_response_410',
      configurationSet: 'clinicaclick-transactional',
    }));
    assert.equal(accepted.status, 'failed');
    assert.equal(accepted.retryable, false);
    assert.equal(accepted.result.code, 'email_outbox_settlement_failed_after_accept');

    const timedOut = await runScenario(411, async () => {
      const error = new Error('request timed out');
      error.name = 'AbortError';
      throw error;
    });
    assert.equal(timedOut.status, 'failed');
    assert.equal(timedOut.retryable, false);
    assert.equal(timedOut.result.code, 'email_provider_timeout_unknown_outcome');
    assert.equal(timedOut.result.settlement_failed, true);
  });
});

test('throttling SES queda retryable y devuelve el mensaje a la cola', async () => {
  await withEnv({
    EMAIL_DATA_ENCRYPTION_KEY: TEST_KEY,
    EMAIL_PROVIDER: 'ses',
    EMAIL_ENABLED: 'true',
  }, async () => {
    const recipientHash = emailDelivery.hashEmail('persona@example.test');
    const message = {
      id: 406,
      public_id: 'em_throttle',
      stream: 'transactional',
      status: 'queued',
      template_key: 'ops.email_test',
      template_context: {},
      recipient_hash: recipientHash,
      recipient_domain: 'example.test',
      recipient_email_envelope: encryptEmailValue('persona@example.test', `message:em_throttle:${recipientHash}`),
      async update(patch) {
        Object.assign(this, patch);
        return this;
      },
    };
    const restores = [
      patchProperty(db.EmailMessage, 'findByPk', async () => message),
      patchConditionalEmailMessageUpdate(message),
      patchProperty(db.EmailSuppression, 'findOne', async () => null),
      patchProperty(emailProvider, 'sendEmail', async () => {
        const error = new Error('throttled');
        error.name = 'ThrottlingException';
        error.$metadata = { httpStatusCode: 429 };
        throw error;
      }),
    ];
    try {
      const result = await emailDelivery.runEmailSendJob({ email_message_id: 406 });
      assert.equal(result.status, 'failed');
      assert.equal(result.retryable, true);
      assert.equal(result.result.code, 'ThrottlingException');
      assert.equal(message.status, 'queued');
      assert.equal(message.completed_at, null);
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  });
});

test('rechazo explícito SES es terminal y no se reintenta', async () => {
  await withEnv({
    EMAIL_DATA_ENCRYPTION_KEY: TEST_KEY,
    EMAIL_PROVIDER: 'ses',
    EMAIL_ENABLED: 'true',
  }, async () => {
    const recipientHash = emailDelivery.hashEmail('persona@example.test');
    const message = {
      id: 407,
      public_id: 'em_rejected',
      stream: 'transactional',
      related_type: 'password_reset_token',
      status: 'queued',
      template_key: 'ops.email_test',
      template_context: {},
      recipient_hash: recipientHash,
      recipient_domain: 'example.test',
      recipient_email_envelope: encryptEmailValue('persona@example.test', `message:em_rejected:${recipientHash}`),
      async update(patch) {
        Object.assign(this, patch);
        return this;
      },
    };
    let revokedTokens = 0;
    const restores = [
      patchProperty(db.EmailMessage, 'findByPk', async () => message),
      patchConditionalEmailMessageUpdate(message),
      patchProperty(db.EmailSuppression, 'findOne', async () => null),
      patchProperty(db.PasswordResetToken, 'update', async ({ status }, { where }) => {
        assert.equal(status, 'revoked');
        assert.deepEqual(where, { email_message_id: 407, status: 'pending' });
        revokedTokens += 1;
        return [1];
      }),
      patchProperty(emailProvider, 'sendEmail', async () => {
        const error = new Error('message rejected');
        error.name = 'MessageRejected';
        error.$metadata = { httpStatusCode: 400 };
        throw error;
      }),
    ];
    try {
      const result = await emailDelivery.runEmailSendJob({ email_message_id: 407 });
      assert.equal(result.status, 'failed');
      assert.equal(result.retryable, false);
      assert.equal(result.result.code, 'MessageRejected');
      assert.equal(message.status, 'failed');
      assert.ok(message.rejected_at instanceof Date);
      assert.equal(revokedTokens, 1);
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  });
});

test('el stream marketing queda bloqueado aunque el proveedor mock esté activo', async () => {
  await withEnv({
    EMAIL_PROVIDER: 'mock',
    EMAIL_ENABLED: 'true',
    EMAIL_MARKETING_ENABLED: 'false',
  }, async () => {
    await assert.rejects(
      () => emailProvider.sendEmail({
        to: 'persona@example.test',
        stream: 'marketing',
        subject: 'Mensaje',
        text: 'Contenido',
      }),
      (error) => error.code === 'email_marketing_disabled' && error.retryable === false
    );
  });
});

test('password reset cifra el enlace en outbox y solo lo abre para renderizar', async () => {
  await withEnv({
    EMAIL_DATA_ENCRYPTION_KEY: TEST_KEY,
    EMAIL_PROVIDER: 'mock',
    EMAIL_ENABLED: 'true',
  }, async () => {
    const resetUrl = 'http://localhost:4203/reset-password?token=reset-token-secret';
    let createdMessage = null;
    let capturedRenderContext = null;
    const restores = [
      patchProperty(db.sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } })),
      patchProperty(db.EmailMessage, 'findOrCreate', async ({ defaults }) => {
        createdMessage = {
          id: 450,
          ...defaults,
          async update(patch) {
            Object.assign(this, patch);
            return this;
          },
        };
        return [createdMessage, true];
      }),
      patchProperty(jobRequestsService, 'enqueueUniqueJobRequest', async () => ({ created: true, job: { id: 451 } })),
      patchProperty(db.EmailMessage, 'findByPk', async () => createdMessage),
      patchConditionalEmailMessageUpdate(() => createdMessage),
      patchProperty(db.EmailSuppression, 'findOne', async () => null),
      patchProperty(emailTemplates, 'renderTemplate', (templateKey, context) => {
        capturedRenderContext = context;
        assert.equal(templateKey, 'auth.password_reset');
        return {
          subject: 'Restablece tu contraseña de ClinicaClick',
          html: '<p>ok</p>',
          text: 'ok',
        };
      }),
    ];
    try {
      await emailDelivery.queueEmail({
        recipientEmail: 'persona@example.test',
        templateKey: 'auth.password_reset',
        templateContext: {
          reset_url: resetUrl,
          expires_minutes: 30,
        },
        dedupeKey: 'password-reset:test',
      });

      assert.ok(createdMessage.template_context.reset_url_envelope);
      assert.equal(createdMessage.template_context.reset_url, undefined);
      assert.doesNotMatch(JSON.stringify(createdMessage.template_context), /reset-token-secret/);

      await emailDelivery.runEmailSendJob({ email_message_id: 450 });

      assert.equal(capturedRenderContext.reset_url, resetUrl);
      assert.equal(capturedRenderContext.reset_url_envelope, undefined);
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  });
});

test('recordProviderEvent concilia rebote y crea supresión sin persistir destinatario raw', async () => {
  const message = {
    id: 505,
    provider_message_id: 'ses-message-1',
    stream: 'transactional',
    related_type: 'password_reset_token',
    clinica_id: 66,
    recipient_hash: emailDelivery.hashEmail('persona@example.test'),
    recipient_domain: 'example.test',
    event_count: 0,
    status: 'sent',
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
  };
  let suppressionRequest = null;
  let passwordResetUpdate = null;
  const restores = [
    patchProperty(db.sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } })),
    patchProperty(db.EmailMessage, 'findOne', async () => message),
    patchProperty(db.EmailProviderEvent, 'findOrCreate', async ({ defaults }) => ([
      { id: 606, ...defaults },
      true,
    ])),
    patchProperty(db.EmailSuppression, 'findOrCreate', async (request) => {
      suppressionRequest = request;
      return [{ id: 707, ...request.where, ...request.defaults }, true];
    }),
    patchProperty(db.SystemNotificationDelivery, 'findOne', async () => null),
    patchProperty(db.PasswordResetToken, 'update', async (patch, options) => {
      passwordResetUpdate = { patch, options };
      return [1];
    }),
  ];
  try {
    const result = await emailEvents.recordProviderEvent({
      id: 'event-1',
      source: 'aws.ses',
      detail: {
        eventType: 'Bounce',
        mail: {
          messageId: 'ses-message-1',
          timestamp: '2026-08-29T10:00:00Z',
          destination: ['persona@example.test'],
        },
        bounce: { bounceType: 'Permanent', bounceSubType: 'General' },
      },
    });
    assert.equal(result.created, true);
    assert.equal(result.suppression_id, 707);
    assert.equal(message.status, 'bounced');
    assert.equal(suppressionRequest.where.scope, 'clinic:66');
    assert.deepEqual(passwordResetUpdate.patch, { status: 'revoked' });
    assert.deepEqual(passwordResetUpdate.options.where, {
      email_message_id: 505,
      status: 'pending',
    });
    assert.doesNotMatch(JSON.stringify(result), /persona@example\.test/i);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('evento SES recupera un timeout ambiguo correlacionando por tag de outbox', async () => {
  const outboxPublicId = 'em_87654321-4321-4321-4321-cba987654321';
  const message = {
    id: 506,
    public_id: outboxPublicId,
    provider_message_id: null,
    stream: 'transactional',
    related_type: 'password_reset_token',
    event_count: 0,
    status: 'failed',
    last_error_code: 'email_provider_timeout_unknown_outcome',
    last_error_message: 'email_provider_timeout_unknown_outcome',
    completed_at: new Date('2026-08-30T15:25:00Z'),
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
  };
  const lookups = [];
  let revokedTokens = 0;
  const restores = [
    patchProperty(db.sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } })),
    patchProperty(db.EmailMessage, 'findOne', async ({ where }) => {
      lookups.push(where);
      if (where.public_id === outboxPublicId) return message;
      return null;
    }),
    patchProperty(db.EmailProviderEvent, 'findOrCreate', async ({ defaults }) => ([
      { id: 607, ...defaults },
      true,
    ])),
    patchProperty(db.PasswordResetToken, 'update', async () => {
      revokedTokens += 1;
      return [1];
    }),
  ];
  try {
    const result = await emailEvents.recordProviderEvent({
      id: 'event-timeout-recovery',
      source: 'aws.ses',
      detail: {
        eventType: 'Delivery',
        mail: {
          messageId: 'ses-message-after-timeout',
          timestamp: '2026-08-30T15:26:00Z',
          destination: ['persona@example.test'],
          tags: { cc_outbox: [outboxPublicId] },
        },
        delivery: { processingTimeMillis: 500 },
      },
    });
    assert.equal(result.created, true);
    assert.equal(result.email_message_id, 506);
    assert.deepEqual(lookups, [
      { provider_message_id: 'ses-message-after-timeout' },
      { public_id: outboxPublicId },
    ]);
    assert.equal(message.status, 'delivered');
    assert.equal(message.provider_message_id, 'ses-message-after-timeout');
    assert.equal(message.last_error_code, null);
    assert.equal(message.last_error_message, null);
    assert.equal(revokedTokens, 0);
    assert.equal(result.event.payload_summary.outbox_public_id, outboxPublicId);
    assert.doesNotMatch(JSON.stringify(result.event.payload_summary), /persona@example\.test/i);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('eventos SES fuera de orden no degradan estado ni último evento', async () => {
  const message = {
    status: 'delivered',
    last_event_type: 'delivery',
    event_count: 1,
    delivered_at: new Date('2026-08-30T10:00:00Z'),
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
  };
  await emailEvents.applyEventToMessage(message, {
    eventType: 'send',
    occurredAt: new Date('2026-08-30T09:59:00Z'),
  });
  assert.equal(message.status, 'delivered');
  assert.equal(message.last_event_type, 'delivery');
  assert.equal(message.event_count, 2);

  message.status = 'complained';
  message.last_event_type = 'complaint';
  await emailEvents.applyEventToMessage(message, {
    eventType: 'delivery',
    occurredAt: new Date('2026-08-30T10:01:00Z'),
  });
  assert.equal(message.status, 'complained');
  assert.equal(message.last_event_type, 'complaint');
});

test('password reset limita solicitudes repetidas antes de crear token o email', async () => {
  let tokenCreated = false;
  let emailQueued = false;
  const restores = [
    patchProperty(db.sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } })),
    patchProperty(db.Usuario, 'findOne', async () => ({
      id_usuario: 77,
      email_usuario: 'persona@example.test',
      estado_cuenta: 'activo',
    })),
    patchProperty(db.PasswordResetToken, 'count', async () => 1),
    patchProperty(db.PasswordResetToken, 'create', async () => {
      tokenCreated = true;
      return null;
    }),
    patchProperty(emailDelivery, 'queueEmail', async () => {
      emailQueued = true;
      return null;
    }),
  ];
  try {
    const result = await passwordReset.requestPasswordReset({
      email: 'persona@example.test',
      requestIp: '192.0.2.10',
      userAgent: 'test',
    });
    assert.deepEqual(result, { queued: false, reason: 'rate_limited' });
    assert.equal(tokenCreated, false);
    assert.equal(emailQueued, false);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('normalizeSesEvent acepta eventos directos de EventBridge y sanea resumen', () => {
  const event = emailEvents.normalizeSesEvent({
    version: '0',
    id: 'aws-event-1',
    source: 'aws.ses',
    'detail-type': 'Email Delivered',
    time: '2026-08-30T07:30:00Z',
    detail: {
      mail: {
        messageId: 'ses-message-2',
        timestamp: '2026-08-30T07:30:00Z',
        destination: ['persona@example.test'],
      },
      delivery: {
        processingTimeMillis: 321,
        smtpResponse: '250 OK persona@example.test +34 600 111 222',
      },
    },
  });

  assert.equal(event.provider, 'ses');
  assert.equal(event.providerEventId, 'aws-event-1');
  assert.equal(event.providerMessageId, 'ses-message-2');
  assert.equal(event.eventType, 'delivery');
  assert.equal(event.summary.destination_count, 1);
  assert.equal(event.summary.delivery_processing_time_millis, 321);
  assert.doesNotMatch(JSON.stringify(event.summary), /persona@example\.test/i);
  assert.doesNotMatch(JSON.stringify(event.summary), /600 111 222/);
});

test('normalizeSesEvent acepta payload transformado minimo de EventBridge', () => {
  const event = emailEvents.normalizeSesEvent({
    event_id: 'aws-event-2',
    event_type: 'Email Bounced',
    provider_message_id: 'ses-message-3',
    occurred_at: '2026-08-30T07:31:00Z',
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
    },
  });

  assert.equal(event.providerEventId, 'aws-event-2');
  assert.equal(event.providerMessageId, 'ses-message-3');
  assert.equal(event.eventType, 'bounce');
  assert.equal(event.severity, 'error');
  assert.equal(event.summary.bounce_type, 'Permanent');
});

test('valida los siete tipos SES configurados en EventBridge', () => {
  const cases = [
    ['Email Sent', 'Send', 'send'],
    ['Email Delivered', 'Delivery', 'delivery'],
    ['Email Bounced', 'Bounce', 'bounce'],
    ['Email Complaint Received', 'Complaint', 'complaint'],
    ['Email Rejected', 'Reject', 'reject'],
    ['Email Rendering Failed', 'RenderingFailure', 'rendering_failure'],
    ['Email Delivery Delayed', 'DeliveryDelay', 'delivery_delay'],
  ];
  cases.forEach(([detailType, providerType, expectedType], index) => {
    const event = emailEvents.assertValidEvent(emailEvents.normalizeSesEvent({
      id: `event-contract-${index}`,
      source: 'aws.ses',
      'detail-type': detailType,
      time: '2026-08-30T15:26:49Z',
      detail: {
        eventType: providerType,
        mail: { messageId: `ses-contract-${index}` },
      },
    }));
    assert.equal(event.eventType, expectedType);
    assert.equal(event.providerEventId, `event-contract-${index}`);
  });
  assert.throws(
    () => emailEvents.assertValidEvent(emailEvents.normalizeSesEvent({ id: 'unsupported-event' })),
    (error) => error.code === 'email_provider_event_invalid',
  );
});

test('dry-run del webhook valida formato y no persiste el evento', async () => {
  await withEnv({ EMAIL_EVENT_WEBHOOK_TOKEN: 'controlled-webhook-token' }, async () => {
    let persisted = 0;
    let statusCode = null;
    let responseBody = null;
    const restore = patchProperty(emailEvents, 'recordProviderEvent', async () => {
      persisted += 1;
      throw new Error('dry run must not persist');
    });
    try {
      await emailController.receiveProviderEvent({
        query: {},
        body: {
          id: 'event-dry-run-1',
          source: 'aws.ses',
          'detail-type': 'Email Delivered',
          time: '2026-08-30T15:26:49Z',
          detail: {
            eventType: 'Delivery',
            mail: { messageId: 'ses-dry-run-message' },
          },
        },
        get(name) {
          const normalized = String(name).toLowerCase();
          if (normalized === 'x-cc-email-webhook-token') return 'controlled-webhook-token';
          if (normalized === 'x-cc-email-webhook-dry-run') return 'true';
          return '';
        },
      }, {
        set() {
          return this;
        },
        status(code) {
          statusCode = code;
          return this;
        },
        json(body) {
          responseBody = body;
          return this;
        },
      });
      assert.equal(statusCode, 200);
      assert.equal(persisted, 0);
      assert.deepEqual(responseBody, {
        success: true,
        dryRun: true,
        provider: 'ses',
        eventType: 'delivery',
        hasProviderEventId: true,
        hasProviderMessageId: true,
        hasOutboxPublicId: false,
      });
    } finally {
      restore();
    }
  });
});

test('health del webhook exige token y no expone secretos', async () => {
  await withEnv({
    EMAIL_EVENT_WEBHOOK_TOKEN: 'controlled-webhook-token',
    RUNTIME_ROLE: 'gateway',
  }, async () => {
    const headers = {};
    let responseBody = null;
    await emailController.providerHealth({
      get(name) {
        return String(name).toLowerCase() === 'x-cc-email-webhook-token'
          ? 'controlled-webhook-token'
          : '';
      },
    }, {
      set(name, value) {
        headers[name] = value;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    });

    assert.equal(headers['Cache-Control'], 'no-store');
    assert.deepEqual(responseBody, {
      success: true,
      endpoint: 'email_provider_events',
      runtimeRole: 'gateway',
    });
    assert.doesNotMatch(JSON.stringify(responseBody), /controlled-webhook-token/);
  });
});

test('webhook rechaza payloads mayores de 80 KiB antes de persistir', async () => {
  await withEnv({ EMAIL_EVENT_WEBHOOK_TOKEN: 'controlled-webhook-token' }, async () => {
    let persisted = 0;
    let statusCode = null;
    let responseBody = null;
    const restore = patchProperty(emailEvents, 'recordProviderEvent', async () => {
      persisted += 1;
      return { created: true };
    });
    try {
      await emailController.receiveProviderEvent({
        query: {},
        body: {},
        rawBody: Buffer.alloc((80 * 1024) + 1),
        get(name) {
          return String(name).toLowerCase() === 'x-cc-email-webhook-token'
            ? 'controlled-webhook-token'
            : '';
        },
      }, {
        set() {
          return this;
        },
        status(code) {
          statusCode = code;
          return this;
        },
        json(body) {
          responseBody = body;
          return this;
        },
      });
      assert.equal(statusCode, 413);
      assert.equal(persisted, 0);
      assert.deepEqual(responseBody, { error: 'email_provider_event_too_large' });
    } finally {
      restore();
    }
  });
});

test('una entrega SES posterior resuelve alertas antiguas sin evento', () => {
  const windowStart = new Date('2026-08-29T15:00:00.000Z');
  const recoveredAt = new Date('2026-08-30T12:00:00.000Z');
  assert.equal(
    emailMonitoring.eventPipelineRecoveryCutoff(recoveredAt, windowStart).toISOString(),
    recoveredAt.toISOString()
  );
  assert.equal(
    emailMonitoring.eventPipelineRecoveryCutoff(null, windowStart).toISOString(),
    windowStart.toISOString()
  );
});

test('expone estado declarativo de alarmas AWS sin credenciales ni ARNs', async () => {
  await withEnv({
    EMAIL_AWS_REGION: 'eu-west-3',
    EMAIL_AWS_MONITORING_STATUS: 'active',
    EMAIL_AWS_MONITORING_STACK_NAME: 'clinicaclick-email-monitoring',
    EMAIL_AWS_MONITORING_ALARM_COUNT: '13',
    EMAIL_AWS_MONITORING_LAST_VERIFIED_AT: '2026-08-30T15:26:49Z',
  }, async () => {
    const monitoring = emailMonitoring.externalMonitoringConfig(process.env);
    assert.deepEqual(monitoring, {
      status: 'active',
      configured: true,
      stackName: 'clinicaclick-email-monitoring',
      region: 'eu-west-3',
      alarmCount: 13,
      lastVerifiedAt: '2026-08-30T15:26:49.000Z',
      stateSource: 'declared',
    });
    assert.doesNotMatch(JSON.stringify(monitoring), /access.?key|secret|token|arn:aws/i);
  });
});

test('automatizaciones declara action/send_email real y mantiene template_id legacy', () => {
  const controllerSource = fs.readFileSync(
    path.join(__dirname, '../../controllers/automationsV2.controller.js'),
    'utf8'
  );
  const sendEmailBlock = controllerSource.slice(
    controllerSource.indexOf("type: 'action/send_email'"),
    controllerSource.indexOf("type: 'action/api_call'")
  );
  assert.match(sendEmailBlock, /runtime_status:\s*'real'/);
  assert.match(sendEmailBlock, /template_key/);

  const engineSource = fs.readFileSync(
    path.join(__dirname, '../../services/flowEngineV2.service.js'),
    'utf8'
  );
  assert.match(engineSource, /config\?\.template_id/);
});
