'use strict';

const crypto = require('crypto');
const { isGlobalAdmin } = require('../lib/role-helpers');
const emailMonitoring = require('../services/emailMonitoring.service');
const emailDelivery = require('../services/emailDelivery.service');
const emailEvents = require('../services/emailEvents.service');

const MAX_PROVIDER_EVENT_BYTES = 80 * 1024;

function assertGlobalAdmin(req, res) {
  if (!isGlobalAdmin(req.userData?.userId)) {
    res.status(403).json({ error: 'admin_only' });
    return false;
  }
  return true;
}

function cleanString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorizeProviderWebhook(req, res) {
  const expected = cleanString(process.env.EMAIL_EVENT_WEBHOOK_TOKEN);
  if (!expected) {
    res.status(503).json({ error: 'email_event_webhook_not_configured' });
    return false;
  }
  const bearer = cleanString(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const header = cleanString(req.get('x-cc-email-webhook-token'));
  if (safeEqual(header, expected) || safeEqual(bearer, expected)) return true;
  res.status(401).json({ error: 'email_event_webhook_unauthorized' });
  return false;
}

function assertProviderEventSize(req, res) {
  const length = Buffer.isBuffer(req.rawBody)
    ? req.rawBody.length
    : Number.parseInt(String(req.get('content-length') || '0'), 10);
  if (Number.isFinite(length) && length > MAX_PROVIDER_EVENT_BYTES) {
    res.status(413).json({ error: 'email_provider_event_too_large' });
    return false;
  }
  return true;
}

function isDryRun(req) {
  const queryValue = String(req.query?.dry_run ?? req.query?.dryRun ?? '').trim().toLowerCase();
  const headerValue = String(req.get('x-cc-email-webhook-dry-run') || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(queryValue)
    || ['1', 'true', 'yes', 'on'].includes(headerValue);
}

exports.providerHealth = async (req, res) => {
  if (!authorizeProviderWebhook(req, res)) return;
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    endpoint: 'email_provider_events',
    runtimeRole: process.env.RUNTIME_ROLE || null,
  });
};

exports.overview = async (req, res) => {
  try {
    if (!assertGlobalAdmin(req, res)) return;
    const overview = await emailMonitoring.getOverview();
    res.json(overview);
  } catch (error) {
    console.error('[Email] Error obteniendo overview:', error?.code || error?.message || error);
    res.status(500).json({ message: 'Error obteniendo estado de email' });
  }
};

exports.messages = async (req, res) => {
  try {
    if (!assertGlobalAdmin(req, res)) return;
    const data = await emailMonitoring.listMessages(req.query || {});
    res.json({ data });
  } catch (error) {
    console.error('[Email] Error listando mensajes:', error?.code || error?.message || error);
    res.status(500).json({ message: 'Error obteniendo mensajes de email' });
  }
};

exports.events = async (req, res) => {
  try {
    if (!assertGlobalAdmin(req, res)) return;
    const data = await emailMonitoring.listEvents(req.query || {});
    res.json({ data });
  } catch (error) {
    console.error('[Email] Error listando eventos:', error?.code || error?.message || error);
    res.status(500).json({ message: 'Error obteniendo eventos de email' });
  }
};

exports.suppressions = async (req, res) => {
  try {
    if (!assertGlobalAdmin(req, res)) return;
    const data = await emailMonitoring.listSuppressions(req.query || {});
    res.json({ data });
  } catch (error) {
    console.error('[Email] Error listando supresiones:', error?.code || error?.message || error);
    res.status(500).json({ message: 'Error obteniendo supresiones de email' });
  }
};

exports.queueTestMessage = async (req, res) => {
  try {
    if (!assertGlobalAdmin(req, res)) return;
    const recipientEmail = cleanString(req.body?.recipientEmail || req.body?.email);
    if (!recipientEmail) {
      return res.status(400).json({ message: 'recipientEmail is required' });
    }
    const result = await emailDelivery.queueEmail({
      stream: 'transactional',
      templateKey: 'ops.email_test',
      templateVersion: 'v1',
      subjectKey: 'ops.email_test',
      recipientEmail,
      recipientKind: 'admin_test',
      relatedType: 'email_test',
      relatedId: new Date().toISOString(),
      dedupeKey: `ops.email_test:${Date.now()}:${crypto.randomUUID()}`,
      priority: 'normal',
      origin: 'email.admin_test',
      requestedBy: req.userData?.userId || null,
      templateContext: {
        subject: cleanString(req.body?.subject) || undefined,
        body: cleanString(req.body?.body) || undefined,
      },
      metadata: {
        contains_clinical_data: false,
        use_case: 'admin_test',
      },
    });
    res.status(202).json({
      message: 'Email de prueba encolado',
      emailMessage: emailMonitoring.serializeMessage(result.emailMessage),
      jobRequestId: result.job?.id || result.emailMessage.job_request_id || null,
    });
  } catch (error) {
    const status = error?.code === 'email_recipient_invalid' ? 400 : 500;
    console.error('[Email] Error encolando prueba:', error?.code || error?.message || error);
    res.status(status).json({ message: status === 400 ? error.message : 'Error encolando email de prueba' });
  }
};

exports.receiveProviderEvent = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!authorizeProviderWebhook(req, res)) return;
    if (!assertProviderEventSize(req, res)) return;
    if (isDryRun(req)) {
      const event = emailEvents.assertValidEvent(emailEvents.normalizeSesEvent(req.body || {}));
      return res.status(200).json({
        success: true,
        dryRun: true,
        provider: event.provider,
        eventType: event.eventType,
        hasProviderEventId: Boolean(event.providerEventId),
        hasProviderMessageId: Boolean(event.providerMessageId),
        hasOutboxPublicId: Boolean(event.outboxPublicId),
      });
    }
    const result = await emailEvents.recordProviderEvent(req.body || {});
    res.status(result.created ? 201 : 200).json({
      success: true,
      created: result.created,
      emailMessageId: result.email_message_id || null,
      suppressionId: result.suppression_id || null,
    });
  } catch (error) {
    console.error('[Email] Error procesando evento de proveedor:', error?.code || error?.message || error);
    res.status(400).json({ success: false, error: 'email_provider_event_invalid' });
  }
};
