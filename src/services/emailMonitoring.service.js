'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const emailProvider = require('./emailProvider.service');

const EXTERNAL_MONITORING_STATUSES = new Set([
  'not_configured',
  'deployed_pending_confirmation',
  'deployed_pending_validation',
  'active',
  'degraded',
]);

function parseIntSafe(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function serializeMessage(row) {
  return {
    id: row.id,
    publicId: row.public_id,
    stream: row.stream,
    provider: row.provider,
    providerRegion: row.provider_region,
    providerMessageId: row.provider_message_id,
    configurationSet: row.configuration_set,
    status: row.status,
    priority: row.priority,
    templateKey: row.template_key,
    recipientDomain: row.recipient_domain,
    recipientHashPrefix: String(row.recipient_hash || '').slice(0, 12),
    recipientKind: row.recipient_kind,
    clinicaId: row.clinica_id,
    pacienteId: row.paciente_id,
    usuarioId: row.usuario_id,
    relatedType: row.related_type,
    relatedId: row.related_id,
    jobRequestId: row.job_request_id,
    eventCount: row.event_count,
    lastEventType: row.last_event_type,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    queuedAt: row.queued_at,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    bouncedAt: row.bounced_at,
    complainedAt: row.complained_at,
    suppressedAt: row.suppressed_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeEvent(row) {
  return {
    id: row.id,
    emailMessageId: row.email_message_id,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    severity: row.severity,
    occurredAt: row.occurred_at,
    payloadSummary: row.payload_summary,
    createdAt: row.created_at,
  };
}

function serializeSuppression(row) {
  return {
    id: row.id,
    emailHashPrefix: String(row.email_hash || '').slice(0, 12),
    emailDomain: row.email_domain,
    stream: row.stream,
    scope: row.scope,
    status: row.status,
    reason: row.reason,
    source: row.source,
    providerEventId: row.provider_event_id,
    clinicaId: row.clinica_id,
    suppressedAt: row.suppressed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function countGrouped(model, column, where = {}) {
  return model.findAll({
    attributes: [
      column,
      [db.sequelize.fn('COUNT', db.sequelize.col(column)), 'total'],
    ],
    where,
    group: [column],
    raw: true,
  });
}

function totalFor(rows, key, value) {
  return Number(rows.find((row) => row[key] === value)?.total || 0);
}

function eventPipelineRecoveryCutoff(latestEventAt, windowStart) {
  const windowDate = windowStart instanceof Date ? windowStart : new Date(windowStart);
  const eventDate = latestEventAt instanceof Date ? latestEventAt : new Date(latestEventAt || 0);
  if (Number.isNaN(eventDate.getTime()) || eventDate <= windowDate) return windowDate;
  return eventDate;
}

function externalMonitoringConfig(env = process.env) {
  const requestedStatus = String(env.EMAIL_AWS_MONITORING_STATUS || 'not_configured').trim().toLowerCase();
  const status = EXTERNAL_MONITORING_STATUSES.has(requestedStatus) ? requestedStatus : 'not_configured';
  const lastVerified = env.EMAIL_AWS_MONITORING_LAST_VERIFIED_AT
    ? new Date(env.EMAIL_AWS_MONITORING_LAST_VERIFIED_AT)
    : null;
  return {
    status,
    configured: status !== 'not_configured',
    stackName: String(env.EMAIL_AWS_MONITORING_STACK_NAME || '').trim() || null,
    region: String(env.EMAIL_AWS_REGION || env.AWS_REGION || 'eu-west-3').trim(),
    alarmCount: parseIntSafe(env.EMAIL_AWS_MONITORING_ALARM_COUNT, 0),
    lastVerifiedAt: lastVerified && !Number.isNaN(lastVerified.getTime()) ? lastVerified.toISOString() : null,
    stateSource: 'declared',
  };
}

function buildAlerts({ provider, summary, stuckQueueCount }) {
  const alerts = [];
  const push = (severity, key, title, detail, action = null) => {
    alerts.push({ severity, key, title, detail, action });
  };

  if (!provider.enabled) {
    push('critical', 'email_provider_disabled', 'Proveedor desactivado', 'EMAIL_ENABLED no permite entregar correos.', 'Revisar runtime antes de asumir entregas.');
  }
  if (!provider.defaultFromConfigured) {
    push('critical', 'email_from_missing', 'Remitente no configurado', 'Falta EMAIL_DEFAULT_FROM para el stream transaccional.', 'Configurar remitente verificado en SES.');
  }
  if (!provider.dataEncryptionConfigured) {
    push('critical', 'email_encryption_missing', 'Cifrado no disponible', 'Falta EMAIL_DATA_ENCRYPTION_KEY o no cumple longitud minima.', 'Configurar secreto server-side y reiniciar runtime.');
  }
  if (provider.provider === 'ses' && (!provider.accessKeyIdConfigured || !provider.secretAccessKeyConfigured)) {
    push('critical', 'email_ses_credentials_missing', 'Credenciales SES incompletas', 'SES esta seleccionado pero faltan credenciales dedicadas.', 'Rotar/crear clave IAM y cargarla solo en el runtime.');
  }
  if (provider.provider === 'ses' && !provider.eventWebhookConfigured) {
    push('warning', 'email_webhook_token_missing', 'Eventos sin token local', 'Falta EMAIL_EVENT_WEBHOOK_TOKEN en este runtime.', 'Configurar el secreto antes de exponer eventos externos.');
  }

  const failed24h = totalFor(summary.byStatus24h, 'status', 'failed')
    + totalFor(summary.byStatus24h, 'status', 'rejected');
  if (failed24h > 0) {
    push('warning', 'email_failures_24h', 'Fallos recientes', `${failed24h} envio(s) fallido(s) o rechazado(s) en 24h.`, 'Revisar logs saneados y permisos/proveedor.');
  }
  if (stuckQueueCount > 0) {
    push('warning', 'email_queue_stuck', 'Cola atascada', `${stuckQueueCount} email(s) llevan mas de 15 minutos en cola/envio.`, 'Revisar scheduler y jobs email_send.');
  }
  if (summary.sentWithoutEventsCount > 0) {
    push('warning', 'email_sent_without_events', 'Envios sin eventos SES', `${summary.sentWithoutEventsCount} email(s) enviados no tienen eventos conciliados tras 15 minutos.`, 'Revisar EventBridge o mensajes anteriores a la regla.');
  }

  const complaints7d = totalFor(summary.events7d, 'eventType', 'complaint');
  const bounces7d = totalFor(summary.events7d, 'eventType', 'bounce');
  if (complaints7d > 0) {
    push('critical', 'email_complaints_7d', 'Quejas SES', `${complaints7d} queja(s) registradas en 7 dias.`, 'Pausar casos dudosos y revisar consentimiento.');
  }
  if (bounces7d > 0) {
    push(
      'warning',
      'email_bounces_7d',
      bounces7d === 1 ? 'Correo no entregado' : 'Correos no entregados',
      bounces7d === 1
        ? 'Un correo no pudo entregarse durante los últimos 7 días.'
        : `${bounces7d} correos no pudieron entregarse durante los últimos 7 días.`,
      'Comprueba que las direcciones sean correctas antes de volver a enviar.',
    );
  }
  if (summary.activeSuppressions > 0) {
    push(
      'warning',
      'email_active_suppressions',
      summary.activeSuppressions === 1
        ? 'Dirección bloqueada para nuevos envíos'
        : 'Direcciones bloqueadas para nuevos envíos',
      summary.activeSuppressions === 1
        ? 'Clinicaclick ha detenido los envíos a una dirección tras un rechazo, una queja o una baja.'
        : `Clinicaclick ha detenido los envíos a ${summary.activeSuppressions} direcciones tras rechazos, quejas o bajas.`,
      'Corrige o confirma la dirección antes de reactivar sus envíos.',
    );
  }

  return alerts;
}

async function listMessages(params = {}) {
  const limit = Math.min(200, parseIntSafe(params.limit, 50));
  const where = {};
  if (params.stream) where.stream = String(params.stream);
  if (params.status) where.status = String(params.status);
  const rows = await db.EmailMessage.findAll({
    where,
    limit,
    order: [['created_at', 'DESC']],
  });
  return rows.map(serializeMessage);
}

async function listEvents(params = {}) {
  const limit = Math.min(200, parseIntSafe(params.limit, 50));
  const where = {};
  if (params.emailMessageId) where.email_message_id = parseIntSafe(params.emailMessageId, 0);
  if (params.eventType) where.event_type = String(params.eventType);
  const rows = await db.EmailProviderEvent.findAll({
    where,
    limit,
    order: [['occurred_at', 'DESC']],
  });
  return rows.map(serializeEvent);
}

async function listSuppressions(params = {}) {
  const limit = Math.min(200, parseIntSafe(params.limit, 50));
  const where = {};
  if (params.status) where.status = String(params.status);
  if (params.stream) where.stream = String(params.stream);
  const rows = await db.EmailSuppression.findAll({
    where,
    limit,
    order: [['suppressed_at', 'DESC']],
  });
  return rows.map(serializeSuppression);
}

async function getOverview() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const staleQueueCutoff = new Date(Date.now() - 15 * 60 * 1000);
  const latestProviderEvent = await db.EmailProviderEvent.findOne({
    attributes: ['occurred_at'],
    order: [['occurred_at', 'DESC']],
    raw: true,
  });
  const eventPipelineCutoff = eventPipelineRecoveryCutoff(latestProviderEvent?.occurred_at, since24h);
  const [
    byStatus,
    byStream,
    byStatus24h,
    events24h,
    events7d,
    activeSuppressions,
    stuckQueueCount,
    sentWithoutEventsCount,
    recentMessages,
    recentEvents,
  ] = await Promise.all([
    countGrouped(db.EmailMessage, 'status'),
    countGrouped(db.EmailMessage, 'stream'),
    countGrouped(db.EmailMessage, 'status', { created_at: { [Op.gte]: since24h } }),
    countGrouped(db.EmailProviderEvent, 'event_type', { occurred_at: { [Op.gte]: since24h } }),
    countGrouped(db.EmailProviderEvent, 'event_type', { occurred_at: { [Op.gte]: since7d } }),
    db.EmailSuppression.count({ where: { status: 'active' } }),
    db.EmailMessage.count({
      where: {
        status: { [Op.in]: ['queued', 'sending'] },
        updated_at: { [Op.lt]: staleQueueCutoff },
      },
    }),
    db.EmailMessage.count({
      where: {
        provider: 'ses',
        status: 'sent',
        event_count: 0,
        provider_message_id: { [Op.ne]: null },
        sent_at: {
          [Op.gt]: eventPipelineCutoff,
          [Op.lt]: staleQueueCutoff,
        },
      },
    }),
    db.EmailMessage.findAll({ limit: 10, order: [['created_at', 'DESC']] }),
    db.EmailProviderEvent.findAll({ limit: 10, order: [['occurred_at', 'DESC']] }),
  ]);

  const provider = emailProvider.publicConfig();
  const summary = {
    byStatus: byStatus.map((row) => ({ status: row.status, total: Number(row.total || 0) })),
    byStream: byStream.map((row) => ({ stream: row.stream, total: Number(row.total || 0) })),
    byStatus24h: byStatus24h.map((row) => ({ status: row.status, total: Number(row.total || 0) })),
    events24h: events24h.map((row) => ({ eventType: row.event_type, total: Number(row.total || 0) })),
    events7d: events7d.map((row) => ({ eventType: row.event_type, total: Number(row.total || 0) })),
    activeSuppressions: Number(activeSuppressions || 0),
    stuckQueueCount: Number(stuckQueueCount || 0),
    sentWithoutEventsCount: Number(sentWithoutEventsCount || 0),
    latestProviderEventAt: latestProviderEvent?.occurred_at || null,
  };

  return {
    success: true,
    checkedAt: new Date().toISOString(),
    provider,
    externalMonitoring: externalMonitoringConfig(),
    summary,
    alerts: buildAlerts({ provider, summary, stuckQueueCount: Number(stuckQueueCount || 0) }),
    streams: [
      {
        key: 'transactional',
        label: 'Transaccional',
        enabled: true,
        configurationSet: provider.transactionalConfigurationSet,
      },
      {
        key: 'automation',
        label: 'Automatizaciones',
        enabled: true,
        configurationSet: provider.transactionalConfigurationSet,
      },
      {
        key: 'marketing',
        label: 'Marketing',
        enabled: provider.marketingEnabled,
        configurationSet: provider.marketingConfigurationSet,
      },
    ],
    roadmap: [
      { phase: 1, label: 'Núcleo transaccional durable', status: 'implemented_dev' },
      { phase: 2, label: 'Password reset seguro', status: 'implemented_dev' },
      { phase: 3, label: 'Automatizaciones action/send_email', status: 'implemented_dev_guarded' },
      { phase: 4, label: 'Marketing email', status: 'disabled_pending_consent_unsubscribe' },
      { phase: 5, label: 'Pools/IPs dedicadas por reputación', status: 'planned_after_volume' },
    ],
    recentMessages: recentMessages.map(serializeMessage),
    recentEvents: recentEvents.map(serializeEvent),
  };
}

module.exports = {
  eventPipelineRecoveryCutoff,
  externalMonitoringConfig,
  getOverview,
  listMessages,
  listEvents,
  listSuppressions,
  serializeMessage,
  serializeEvent,
  serializeSuppression,
};
