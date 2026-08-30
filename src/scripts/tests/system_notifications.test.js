'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../../../models');
const jobRequestsService = require('../../services/jobRequests.service');
const emailDelivery = require('../../services/emailDelivery.service');
const whatsappService = require('../../services/whatsapp.service');
const metaClient = require('../../lib/metaClient');
const systemNotifications = require('../../services/systemNotifications.service');

function patchProperty(object, key, value) {
  const previous = object[key];
  object[key] = value;
  return () => { object[key] = previous; };
}

function settingStub(overrides = {}) {
  return {
    id: 1,
    scope: 'global',
    enabled: true,
    panel_enabled: true,
    email_enabled: false,
    whatsapp_enabled: true,
    admin_email: null,
    admin_phone: '+34111111111',
    whatsapp_sender_asset_id: 358,
    whatsapp_template_name: 'clinicaclick_admin_alerta_sistema',
    whatsapp_template_language: 'es',
    throttle_minutes: 60,
    event_rules: systemNotifications.defaultEventRules(),
    last_checked_at: null,
    last_tested_at: null,
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
    ...overrides,
  };
}

test('normaliza reglas y declara la plantilla admin-only de WhatsApp', () => {
  const rules = systemNotifications._test.normalizeEventRules({
    'email_queue_stuck': { whatsapp: 'false', email: 'true', severity: 'warning' },
  });
  assert.equal(rules.email_queue_stuck.enabled, true);
  assert.equal(rules.email_queue_stuck.whatsapp, false);
  assert.equal(rules.email_queue_stuck.email, true);
  assert.equal(rules['users.new_registration'].whatsapp, true);

  const payload = systemNotifications._test.systemWhatsappTemplatePayload({
    name: 'clinicaclick_admin_alerta_sistema',
  });
  assert.equal(payload.category, 'UTILITY');
  assert.match(payload.components[0].text, /Alerta operativa de Clinicaclick: \{\{1\}\}/);
  assert.match(payload.components[0].text, /Revisa Monitorizacion del sistema\./);
});

test('updateSettings permite desactivar WhatsApp y borrar explicitamente el remitente', async () => {
  const setting = settingStub();
  const restores = [
    patchProperty(db.SystemNotificationSetting, 'findOrCreate', async () => [setting, false]),
    patchProperty(db.ClinicMetaAsset, 'findAll', async () => []),
    patchProperty(db.SystemNotificationDelivery, 'findAll', async () => []),
  ];

  try {
    const overview = await systemNotifications.updateSettings({
      whatsappEnabled: false,
      whatsappSenderAssetId: null,
    });

    assert.equal(setting.whatsapp_enabled, false);
    assert.equal(setting.whatsapp_sender_asset_id, null);
    assert.equal(overview.settings.whatsappEnabled, false);
    assert.equal(overview.settings.whatsappSenderAssetId, null);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('consulta el estado de plantilla mediante el cliente Meta protegido', async () => {
  let request = null;
  const restore = patchProperty(metaClient, 'metaGet', async (url, options) => {
    request = { url, options };
    return {
      data: {
        data: [
          { id: 'template-1', name: 'clinicaclick_admin_alerta_sistema', language: 'es', status: 'APPROVED' },
          { id: 'template-2', name: 'otra_plantilla', language: 'es', status: 'APPROVED' },
        ],
      },
    };
  });

  try {
    const template = await systemNotifications._test.fetchRemoteTemplate({
      wabaId: '12345',
      accessToken: 'test-token-not-sent-in-params',
      name: 'clinicaclick_admin_alerta_sistema',
      language: 'es',
    });

    assert.equal(template.id, 'template-1');
    assert.equal(request.url, '12345/message_templates');
    assert.equal(request.options.source, 'system_notifications');
    assert.equal(request.options.operation, 'whatsapp_template_status');
    assert.equal(request.options.accessToken, 'test-token-not-sent-in-params');
    assert.equal(Object.hasOwn(request.options.params, 'access_token'), false);
  } finally {
    restore();
  }
});

test('reduce el sondeo automatico de plantillas aprobadas', () => {
  const now = Date.now();
  assert.equal(systemNotifications._test.shouldRefreshRemoteTemplate({
    status: 'APPROVED',
    last_synced_at: new Date(now - (5 * 60 * 60 * 1000)),
  }), false);
  assert.equal(systemNotifications._test.shouldRefreshRemoteTemplate({
    status: 'APPROVED',
    last_synced_at: new Date(now - (7 * 60 * 60 * 1000)),
  }), true);
  assert.equal(systemNotifications._test.shouldRefreshRemoteTemplate({
    status: 'PENDING',
    last_synced_at: new Date(now - (2 * 60 * 1000)),
  }), false);
});

test('distingue calidad del numero y restriccion activa de mensajeria empresarial', () => {
  const active = systemNotifications._test.senderComplianceState({
    id: 31,
    operational_status: 'restricted',
    status: 'draft_ready',
    restriction_info: [{
      active: true,
      restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
      expiration: '2026-09-05T21:21:20.000Z',
    }],
  }, new Date('2026-08-30T12:00:00.000Z'));
  assert.equal(active.blocked, true);
  assert.equal(active.blockReason, 'business_initiated_messaging_restricted');
  assert.equal(active.restrictionExpiresAt, '2026-09-05T21:21:20.000Z');

  const expired = systemNotifications._test.senderComplianceState({
    id: 31,
    operational_status: 'restricted',
    restriction_info: [{
      active: true,
      restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
      expiration: '2026-08-29T21:21:20.000Z',
    }],
  }, new Date('2026-08-30T12:00:00.000Z'));
  assert.equal(expired.blocked, false);
});

test('nuevo registro usa contenido mínimo y no expone email completo', () => {
  const content = systemNotifications.buildNotificationContent('users.new_registration', {
    userId: 77,
    email: 'persona@example.test',
    origin: 'auth.sign_up',
  });

  assert.equal(content.title, 'Nuevo registro de usuario');
  assert.match(content.message, /Usuario #77/);
  assert.match(content.message, /dominio example\.test/);
  assert.doesNotMatch(content.message, /persona@example\.test/i);
  assert.doesNotMatch(content.message, /persona/i);
});

test('queueNotification crea delivery y JobRequest con payload mínimo', async () => {
  let capturedDelivery = null;
  let capturedJob = null;
  const setting = settingStub();
  const restores = [
    patchProperty(db.sequelize, 'transaction', async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } })),
    patchProperty(db.SystemNotificationSetting, 'findOrCreate', async () => [setting, false]),
    patchProperty(db.WhatsappAccountComplianceIncident, 'findOne', async () => null),
    patchProperty(db.SystemNotificationDelivery, 'count', async () => 0),
    patchProperty(db.SystemNotificationDelivery, 'create', async (values) => {
      capturedDelivery = {
        id: 901,
        ...values,
        async update(patch) {
          Object.assign(this, patch);
          return this;
        },
      };
      return capturedDelivery;
    }),
    patchProperty(jobRequestsService, 'enqueueJobRequest', async (values) => {
      capturedJob = values;
      return { id: 902, ...values };
    }),
  ];

  try {
    const result = await systemNotifications.queueNotification({
      eventKey: 'users.new_registration',
      payload: { userId: 77, email: 'persona@example.test', origin: 'auth.sign_up' },
      force: true,
      channelsOverride: { whatsapp: true, panel: false, email: false },
      metadata: { source: 'unit_test' },
    });

    assert.deepEqual(result.created, [{ deliveryId: 901, jobRequestId: 902, channel: 'whatsapp' }]);
    assert.equal(capturedDelivery.recipient_label, '***1111');
    assert.equal(capturedDelivery.recipient_hash.length, 64);
    assert.equal(capturedJob.type, 'system_notification_dispatch');
    assert.deepEqual(capturedJob.payload, { system_notification_delivery_id: 901 });
    assert.doesNotMatch(JSON.stringify(capturedJob), /persona@example\.test|\+34111111111/i);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('queueNotification omite WhatsApp restringido sin crear job ni llamar al proveedor', async () => {
  let capturedDelivery = null;
  let jobCreated = false;
  const setting = settingStub();
  const restores = [
    patchProperty(db.SystemNotificationSetting, 'findOrCreate', async () => [setting, false]),
    patchProperty(db.WhatsappAccountComplianceIncident, 'findOne', async () => ({
      id: 44,
      operational_status: 'restricted',
      status: 'draft_ready',
      restriction_info: [{
        active: true,
        restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
        expiration: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }],
    })),
    patchProperty(db.SystemNotificationDelivery, 'create', async (values) => {
      capturedDelivery = { id: 907, ...values };
      return capturedDelivery;
    }),
    patchProperty(jobRequestsService, 'enqueueJobRequest', async () => {
      jobCreated = true;
      return { id: 908 };
    }),
  ];

  try {
    const result = await systemNotifications.queueNotification({
      eventKey: 'system.notification_test',
      force: true,
      channelsOverride: { whatsapp: true, panel: false, email: false },
      metadata: { source: 'unit_test' },
    });

    assert.deepEqual(result.created, []);
    assert.deepEqual(result.skipped, [{
      channel: 'whatsapp',
      reason: 'whatsapp_sender_account_restricted',
      deliveryId: 907,
    }]);
    assert.equal(jobCreated, false);
    assert.equal(capturedDelivery.status, 'skipped');
    assert.equal(capturedDelivery.error_code, 'whatsapp_sender_account_restricted');
    assert.equal(capturedDelivery.metadata.whatsapp_sender_blocked, true);
    assert.equal(capturedDelivery.metadata.compliance_incident_id, 44);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('queueNotification aplica throttle al remitente restringido en barridos periódicos', async () => {
  let deliveryCreated = false;
  let jobCreated = false;
  const setting = settingStub();
  const restores = [
    patchProperty(db.SystemNotificationSetting, 'findOrCreate', async () => [setting, false]),
    patchProperty(db.WhatsappAccountComplianceIncident, 'findOne', async () => ({
      id: 44,
      operational_status: 'restricted',
      status: 'draft_ready',
      restriction_info: [{
        active: true,
        restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
        expiration: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }],
    })),
    patchProperty(db.SystemNotificationDelivery, 'count', async () => 1),
    patchProperty(db.SystemNotificationDelivery, 'create', async () => {
      deliveryCreated = true;
      return { id: 909 };
    }),
    patchProperty(jobRequestsService, 'enqueueJobRequest', async () => {
      jobCreated = true;
      return { id: 910 };
    }),
  ];

  try {
    const result = await systemNotifications.queueNotification({
      eventKey: 'email_sent_without_events',
      channelsOverride: { whatsapp: true, panel: false, email: false },
      metadata: { source: 'unit_test' },
    });

    assert.deepEqual(result.created, []);
    assert.deepEqual(result.skipped, [{
      channel: 'whatsapp',
      reason: 'throttled_sender_restriction',
      deliveryId: null,
    }]);
    assert.equal(deliveryCreated, false);
    assert.equal(jobCreated, false);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('runDispatchJob completa WhatsApp dry-run sin llamar al proveedor', async () => {
  const delivery = {
    id: 903,
    event_key: 'system.notification_test',
    severity: 'info',
    channel: 'whatsapp',
    status: 'queued',
    title: 'Prueba',
    message: 'Mensaje controlado',
    action: 'Sin acción',
    metadata: { dry_run: true },
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
  };
  const restores = [
    patchProperty(db.SystemNotificationDelivery, 'findByPk', async () => delivery),
  ];

  try {
    const result = await systemNotifications.runDispatchJob({ system_notification_delivery_id: 903 });
    assert.equal(result.status, 'completed');
    assert.equal(delivery.status, 'sent');
    assert.equal(delivery.provider, 'whatsapp_dry_run');
    assert.equal(delivery.provider_message_id, 'dry_run_903');
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('runDispatchJob bloquea WhatsApp antes de Meta si la cuenta tiene restriccion activa', async () => {
  let providerCalled = false;
  const delivery = {
    id: 906,
    event_key: 'system.notification_test',
    severity: 'info',
    channel: 'whatsapp',
    status: 'queued',
    title: 'Prueba',
    message: 'Mensaje controlado',
    action: 'Sin acción',
    metadata: { dry_run: false },
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
  };
  const setting = settingStub();
  const restores = [
    patchProperty(db.SystemNotificationDelivery, 'findByPk', async () => delivery),
    patchProperty(db.SystemNotificationSetting, 'findOrCreate', async () => [setting, false]),
    patchProperty(db.ClinicMetaAsset, 'findOne', async () => ({
      id: 358,
      assetType: 'whatsapp_phone_number',
      isActive: true,
      phoneNumberId: 'phone-id',
      wabaId: 'waba-id',
      waAccessToken: 'test-token',
    })),
    patchProperty(db.WhatsappAccountComplianceIncident, 'findOne', async () => ({
      id: 44,
      operational_status: 'restricted',
      status: 'draft_ready',
      restriction_info: [{
        active: true,
        restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
        expiration: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }],
    })),
    patchProperty(whatsappService, 'sendMessage', async () => {
      providerCalled = true;
      return { messages: [{ id: 'should-not-exist' }] };
    }),
  ];

  try {
    const result = await systemNotifications.runDispatchJob({ system_notification_delivery_id: 906 });
    assert.equal(result.status, 'completed');
    assert.equal(result.retryable, false);
    assert.equal(providerCalled, false);
    assert.equal(delivery.status, 'failed');
    assert.equal(delivery.error_code, 'whatsapp_sender_account_restricted');
    assert.ok(delivery.failed_at instanceof Date);
    assert.ok(delivery.completed_at instanceof Date);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('materializa el fallo asincrono de Meta en la notificacion de sistema', async () => {
  let eventDefaults = null;
  const delivery = {
    id: 12,
    channel: 'whatsapp',
    provider: 'whatsapp_cloud_api',
    provider_message_id: 'wamid.test',
    whatsapp_sender_asset_id: 358,
    whatsapp_template_name: 'clinicaclick_admin_alerta_sistema',
    status: 'sent',
    metadata: { source: 'unit_test' },
    sent_at: new Date('2026-08-30T12:23:58.000Z'),
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
  };
  const restores = [
    patchProperty(db.SystemNotificationDelivery, 'findOne', async () => delivery),
    patchProperty(db.ClinicMetaAsset, 'findByPk', async () => ({
      wabaId: 'waba-id',
      phoneNumberId: 'phone-id',
    })),
    patchProperty(db.WhatsappDeliveryEvent, 'findOrCreate', async ({ defaults }) => {
      eventDefaults = defaults;
      return [defaults, true];
    }),
  ];

  try {
    const result = await systemNotifications.materializeWhatsappProviderStatus({
      providerMessageId: 'wamid.test',
      providerStatus: 'failed',
      providerTimestamp: '1788092638',
      errors: [{
        code: 131031,
        title: 'Business Account locked',
        message: 'Business Account locked',
        error_data: { details: 'Business account has been locked.' },
      }],
    });

    assert.equal(result.matched, true);
    assert.equal(delivery.status, 'failed');
    assert.equal(delivery.error_code, 'whatsapp_provider_131031');
    assert.match(delivery.error_message, /Business Account locked/);
    assert.equal(delivery.metadata.whatsapp_provider_status, 'failed');
    assert.equal(delivery.failed_at.toISOString(), '2026-08-30T12:23:58.000Z');
    assert.equal(eventDefaults.event_type, 'message_failed');
    assert.equal(eventDefaults.reason_code, '131031');
    assert.equal(eventDefaults.payload.system_notification_delivery_id, 12);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('ignora callbacks WhatsApp sin WAMID o estado reconocido', async () => {
  const missingStatus = await systemNotifications.materializeWhatsappProviderStatus({
    providerMessageId: 'wamid.test',
  });
  const missingMessage = await systemNotifications.materializeWhatsappProviderStatus({
    providerStatus: 'failed',
  });
  assert.deepEqual(missingStatus, { matched: false, reason: 'invalid_provider_status' });
  assert.deepEqual(missingMessage, { matched: false, reason: 'invalid_provider_status' });
});

test('runDispatchJob de email queda queued hasta la entrega real del outbox', async () => {
  const delivery = {
    id: 904,
    event_key: 'email_queue_stuck',
    severity: 'warning',
    channel: 'email',
    status: 'queued',
    title: 'Cola email',
    message: 'Hay mensajes pendientes.',
    action: 'Revisar monitorización.',
    email_message_id: null,
    metadata: {},
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
  };
  const setting = settingStub({
    email_enabled: true,
    admin_email: 'admin@example.test',
  });
  const emailMessage = { id: 905, status: 'queued' };
  const restores = [
    patchProperty(db.SystemNotificationDelivery, 'findByPk', async () => delivery),
    patchProperty(db.SystemNotificationSetting, 'findOrCreate', async () => [setting, false]),
    patchProperty(emailDelivery, 'queueEmail', async () => ({ emailMessage })),
  ];
  try {
    const result = await systemNotifications.runDispatchJob({ system_notification_delivery_id: 904 });
    assert.equal(result.status, 'completed');
    assert.equal(delivery.status, 'queued');
    assert.equal(delivery.email_message_id, 905);
    assert.equal(delivery.provider, 'email_outbox');
    assert.equal(delivery.sent_at, null);
    assert.equal(delivery.completed_at, null);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});
