'use strict';

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const crypto = require('crypto');

function cleanString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function getConfig(env = process.env) {
  const provider = (cleanString(env.EMAIL_PROVIDER) || 'mock').toLowerCase();
  const region = cleanString(env.EMAIL_AWS_REGION) || cleanString(env.AWS_REGION) || 'eu-west-3';
  const accessKeyId = cleanString(env.EMAIL_AWS_ACCESS_KEY_ID);
  const secretAccessKey = cleanString(env.EMAIL_AWS_SECRET_ACCESS_KEY);
  const sessionToken = cleanString(env.EMAIL_AWS_SESSION_TOKEN);
  const defaultFrom = cleanString(env.EMAIL_DEFAULT_FROM) || 'Clinicaclick <no-contestar@clinicaclick.com>';
  const defaultReplyTo = cleanString(env.EMAIL_DEFAULT_REPLY_TO);
  const transactionalConfigurationSet = cleanString(env.EMAIL_TRANSACTIONAL_CONFIGURATION_SET)
    || 'clinicaclick-transactional';
  const marketingConfigurationSet = cleanString(env.EMAIL_MARKETING_CONFIGURATION_SET)
    || 'clinicaclick-marketing-disabled';
  const configuredTimeoutMs = Number(env.EMAIL_PROVIDER_TIMEOUT_MS || 15000);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? Math.max(1000, configuredTimeoutMs)
    : 15000;
  const recipientAllowlist = splitList(env.EMAIL_RECIPIENT_ALLOWLIST || env.EMAIL_SANDBOX_RECIPIENT_ALLOWLIST);

  return {
    provider,
    region,
    enabled: parseBool(env.EMAIL_ENABLED, provider === 'mock'),
    marketingEnabled: parseBool(env.EMAIL_MARKETING_ENABLED, false),
    sesSandboxMode: parseBool(env.EMAIL_SES_SANDBOX_MODE, true),
    requireRecipientAllowlist: parseBool(env.EMAIL_REQUIRE_RECIPIENT_ALLOWLIST, recipientAllowlist.length > 0),
    recipientAllowlist,
    accessKeyIdConfigured: Boolean(accessKeyId),
    secretAccessKeyConfigured: Boolean(secretAccessKey),
    credentials: accessKeyId && secretAccessKey
      ? {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      }
      : undefined,
    defaultFrom,
    defaultReplyTo,
    transactionalConfigurationSet,
    marketingConfigurationSet,
    timeoutMs,
  };
}

function assertRecipientAllowed(to, config) {
  const normalized = String(to || '').trim().toLowerCase();
  if (!config.requireRecipientAllowlist) return;
  if (config.recipientAllowlist.includes(normalized)) return;
  const error = new Error('email_recipient_not_allowlisted');
  error.code = 'email_recipient_not_allowlisted';
  error.retryable = false;
  throw error;
}

function assertSesCredentials(config) {
  if (config.accessKeyIdConfigured && config.secretAccessKeyConfigured && config.credentials) return;
  const error = new Error('email_ses_credentials_missing');
  error.code = 'email_ses_credentials_missing';
  error.retryable = false;
  throw error;
}

function messageTagValue(value) {
  const normalized = String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
  return normalized || null;
}

function mapStreamToConfigurationSet(stream, config) {
  if (String(stream || '').toLowerCase() === 'marketing') {
    return config.marketingConfigurationSet;
  }
  return config.transactionalConfigurationSet;
}

function buildClient(config) {
  return new SESv2Client({
    region: config.region,
    credentials: config.credentials,
    // SES SendEmail has no idempotency token. The outbox owns every safe retry.
    maxAttempts: 1,
  });
}

async function sendEmail(message, { env = process.env } = {}) {
  const config = getConfig(env);
  if (!config.enabled) {
    const error = new Error('email_provider_disabled');
    error.code = 'email_provider_disabled';
    error.retryable = false;
    throw error;
  }

  if (String(message.stream || '').trim().toLowerCase() === 'marketing' && !config.marketingEnabled) {
    const error = new Error('email_marketing_disabled');
    error.code = 'email_marketing_disabled';
    error.retryable = false;
    throw error;
  }

  const provider = String(config.provider || '').toLowerCase();
  if (provider === 'mock') {
    return {
      provider: 'mock',
      providerMessageId: `mock_${crypto.randomUUID()}`,
      accepted: true,
      configurationSet: message.configurationSet || mapStreamToConfigurationSet(message.stream, config),
    };
  }

  if (provider !== 'ses') {
    const error = new Error('email_provider_not_supported');
    error.code = 'email_provider_not_supported';
    error.retryable = false;
    throw error;
  }

  assertSesCredentials(config);
  assertRecipientAllowed(message.to, config);
  const configurationSet = cleanString(message.configurationSet) || mapStreamToConfigurationSet(message.stream, config);
  const client = buildClient(config);
  const body = {
    Text: { Data: message.text || '', Charset: 'UTF-8' },
  };
  if (message.html) {
    body.Html = { Data: message.html, Charset: 'UTF-8' };
  }
  const emailTags = [
    { Name: 'stream', Value: messageTagValue(message.stream || 'transactional') },
    { Name: 'template', Value: messageTagValue(message.templateKey || 'unknown') },
  ];
  const outboxTag = messageTagValue(message.outboxId);
  if (outboxTag) emailTags.push({ Name: 'cc_outbox', Value: outboxTag });
  const commandInput = {
    FromEmailAddress: cleanString(message.from) || config.defaultFrom,
    Destination: { ToAddresses: [message.to] },
    ConfigurationSetName: configurationSet || undefined,
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: 'UTF-8' },
        Body: body,
      },
    },
    EmailTags: emailTags,
  };
  const replyTo = cleanString(message.replyTo);
  if (replyTo) {
    commandInput.ReplyToAddresses = [replyTo];
  }
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.timeoutMs);
  try {
    const command = new SendEmailCommand(commandInput);
    const response = await client.send(command, { abortSignal: abortController.signal });
    if (!cleanString(response.MessageId)) {
      const error = new Error('email_provider_response_missing_message_id');
      error.code = 'email_provider_response_missing_message_id';
      error.retryable = false;
      throw error;
    }
    return {
      provider: 'ses',
      providerMessageId: response.MessageId,
      accepted: true,
      configurationSet,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function classifyProviderError(error) {
  const code = cleanString(error?.code) || cleanString(error?.name) || 'email_provider_error';
  const statusCode = Number(error?.$metadata?.httpStatusCode || 0);
  const errorText = `${code} ${cleanString(error?.message) || ''}`;
  const missingMessageId = code === 'email_provider_response_missing_message_id';
  const timedOut = code === 'AbortError' || /abort|timeout|timed.?out/i.test(errorText);
  const serverError = statusCode >= 500 && statusCode <= 599;
  const transportError = /econnreset|econnrefused|enotfound|eai_again|epipe|network|socket.?hang.?up|connection.?reset|broken.?pipe/i
    .test(errorText);
  if (missingMessageId || timedOut || serverError || transportError) {
    const unknownOutcomeCode = missingMessageId
      ? code
      : (serverError
        ? 'email_provider_server_error_unknown_outcome'
        : (timedOut
          ? 'email_provider_timeout_unknown_outcome'
          : 'email_provider_transport_unknown_outcome'));
    return {
      code: unknownOutcomeCode,
      retryable: false,
      message: unknownOutcomeCode,
    };
  }
  const retryable = error?.retryable === true
    || error?.$retryable?.throttling === true
    || /throttl|rate.?limit|too.?many/i.test(code)
    || statusCode === 429;
  return {
    code,
    retryable: error?.retryable === false ? false : Boolean(retryable),
    message: cleanString(error?.message) || code,
  };
}

function publicConfig(env = process.env) {
  const config = getConfig(env);
  const dataEncryptionKey = cleanString(env.EMAIL_DATA_ENCRYPTION_KEY);
  const webhookToken = cleanString(env.EMAIL_EVENT_WEBHOOK_TOKEN);
  return {
    provider: config.provider,
    enabled: config.enabled,
    marketingEnabled: config.marketingEnabled,
    region: config.region,
    defaultFromConfigured: Boolean(config.defaultFrom),
    defaultReplyToConfigured: Boolean(config.defaultReplyTo),
    transactionalConfigurationSet: config.transactionalConfigurationSet,
    marketingConfigurationSet: config.marketingConfigurationSet,
    accessKeyIdConfigured: config.accessKeyIdConfigured,
    secretAccessKeyConfigured: config.secretAccessKeyConfigured,
    sesSandboxMode: config.sesSandboxMode,
    requireRecipientAllowlist: config.requireRecipientAllowlist,
    recipientAllowlistCount: config.recipientAllowlist.length,
    dataEncryptionConfigured: Boolean(dataEncryptionKey && dataEncryptionKey.length >= 16),
    eventWebhookConfigured: Boolean(webhookToken),
    timeoutMs: config.timeoutMs,
  };
}

module.exports = {
  getConfig,
  publicConfig,
  sendEmail,
  classifyProviderError,
  mapStreamToConfigurationSet,
};
