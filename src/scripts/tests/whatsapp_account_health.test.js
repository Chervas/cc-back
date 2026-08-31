'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyRecoveryPolicy,
  deriveHealthCandidate,
  effectiveStoredHealth,
  extractProviderErrorCode,
  normalizeWabaOperationalSnapshot,
} = require('../../lib/whatsapp-account-health');
const db = require('../../../models');
const whatsappAccountHealthService = require('../../services/whatsappAccountHealth.service');
const whatsappService = require('../../services/whatsapp.service');

function patchProperty(object, key, value) {
  const previous = object[key];
  object[key] = value;
  return () => { object[key] = previous; };
}

test('BANNED y 131031 prevalecen sobre registro y calidad GREEN', () => {
  const banned = deriveHealthCandidate({
    providerStatus: 'BANNED',
    registrationStatus: 'registered',
    complianceStatus: 'active',
    qualityRating: 'GREEN',
  });
  assert.equal(banned.state, 'blocked');
  assert.equal(banned.can_send, false);
  assert.equal(banned.reason_code, 'provider_status_banned');

  const locked = deriveHealthCandidate({
    providerStatus: 'CONNECTED',
    registrationStatus: 'registered',
    qualityRating: 'GREEN',
    providerErrorCode: 131031,
  });
  assert.equal(locked.state, 'blocked');
  assert.equal(locked.reason_code, 'meta_error_131031_account_locked');
  assert.equal(extractProviderErrorCode({ errors: [{ code: 131031 }] }), 131031);
});

test('calidad RED degrada pero no bloquea por sí sola', () => {
  const health = deriveHealthCandidate({
    providerStatus: 'CONNECTED',
    registrationStatus: 'registered',
    qualityRating: 'RED',
  });
  assert.equal(health.state, 'degraded');
  assert.equal(health.can_send, true);
  assert.equal(health.reason_code, 'quality_red');
});

test('la revisión rechazada o la salud WABA bloqueada abren el cortacircuitos', () => {
  const rejected = deriveHealthCandidate({
    providerStatus: 'CONNECTED',
    registrationStatus: 'registered',
    accountReviewStatus: 'REJECTED',
  });
  assert.equal(rejected.state, 'blocked');
  assert.equal(rejected.can_send, false);
  assert.equal(rejected.reason_code, 'waba_account_review_rejected');

  const providerBlocked = deriveHealthCandidate({
    providerStatus: 'CONNECTED',
    registrationStatus: 'registered',
    wabaCanSendMessage: 'BLOCKED',
  });
  assert.equal(providerBlocked.state, 'blocked');
  assert.equal(providerBlocked.reason_code, 'waba_health_blocked');
});

test('la verificación empresarial pendiente degrada sin bloquear el número', () => {
  const health = deriveHealthCandidate({
    providerStatus: 'CONNECTED',
    registrationStatus: 'registered',
    businessVerificationStatus: 'pending',
  });
  assert.equal(health.state, 'degraded');
  assert.equal(health.can_send, true);
  assert.equal(health.reason_code, 'business_verification_pending');
});

test('el snapshot WABA conserva solo estado operativo saneado', () => {
  const snapshot = normalizeWabaOperationalSnapshot({
    name: 'Cuenta de prueba',
    account_review_status: 'approved',
    business_verification_status: 'verified',
    health_status: {
      can_send_message: 'available',
      entities: [{
        entity_type: 'business',
        id: 'business-1',
        can_send_message: 'limited',
        errors: [{
          error_code: '141010',
          error_description: 'Verification required',
          possible_solution: 'Complete verification',
          ignored_secret: 'must-not-be-copied',
        }],
      }],
    },
  }, new Date('2026-08-31T12:00:00.000Z'));

  assert.equal(snapshot.account_review_status, 'APPROVED');
  assert.equal(snapshot.business_verification_status, 'verified');
  assert.equal(snapshot.can_send_message, 'AVAILABLE');
  assert.equal(snapshot.business_id, 'business-1');
  assert.equal(snapshot.entities[0].entity_type, 'BUSINESS');
  assert.equal(snapshot.entities[0].errors[0].error_code, 141010);
  assert.equal('ignored_secret' in snapshot.entities[0].errors[0], false);
});

test('una restricción explícita y una desconexión abren el cortacircuitos', () => {
  assert.deepEqual(
    deriveHealthCandidate({ providerEvent: 'ACCOUNT_RESTRICTION' }).state,
    'blocked'
  );
  assert.deepEqual(
    deriveHealthCandidate({ providerEvent: 'PARTNER_REMOVED' }).state,
    'disconnected'
  );
  const inactive = deriveHealthCandidate({
    assetActive: false,
    providerStatus: 'CONNECTED',
    registrationStatus: 'registered',
  });
  assert.equal(inactive.state, 'disconnected');
  assert.equal(inactive.can_send, false);
  assert.equal(inactive.reason_code, 'asset_inactive');
});

test('la recuperación por sondeo exige dos CONNECTED consecutivos', () => {
  const connected = deriveHealthCandidate({
    providerStatus: 'CONNECTED',
    registrationStatus: 'registered',
    qualityRating: 'GREEN',
  });
  const first = applyRecoveryPolicy({
    previousState: 'blocked',
    previousRecoveryCount: 0,
    candidate: connected,
  });
  assert.equal(first.recovery_pending, true);
  assert.equal(first.recovery_count, 1);
  assert.equal(first.health.state, 'blocked');
  assert.equal(first.health.can_send, false);

  const second = applyRecoveryPolicy({
    previousState: 'blocked',
    previousRecoveryCount: first.recovery_count,
    candidate: connected,
  });
  assert.equal(second.recovery_pending, false);
  assert.equal(second.health.state, 'healthy');
  assert.equal(second.health.can_send, true);

  const webhook = applyRecoveryPolicy({
    previousState: 'blocked',
    candidate: connected,
    explicitRecovery: true,
  });
  assert.equal(webhook.health.state, 'healthy');
});

test('una proyección saludable antigua no oculta un BANNED persistido', () => {
  const now = new Date('2026-08-31T12:00:00.000Z');
  const health = effectiveStoredHealth({
    updatedAt: now,
    quality_rating: 'GREEN',
    additionalData: {
      registration: { status: 'registered', phoneStatus: 'BANNED', lastAttemptAt: now.toISOString() },
      whatsappHealth: {
        state: 'healthy',
        can_send: true,
        reason_code: 'provider_connected',
        observed_at: now.toISOString(),
      },
    },
  }, { now, staleMinutes: 30 });
  assert.equal(health.state, 'blocked');
  assert.equal(health.can_send, false);
});

test('marca como stale una observación operativa fuera de ventana sin bloquear', () => {
  const health = effectiveStoredHealth({
    quality_rating: 'GREEN',
    additionalData: {
      registration: { status: 'registered', phoneStatus: 'CONNECTED' },
      whatsappHealth: {
        state: 'healthy',
        can_send: true,
        observed_at: '2026-08-31T10:00:00.000Z',
      },
    },
  }, { now: new Date('2026-08-31T12:00:00.000Z'), staleMinutes: 30 });
  assert.equal(health.state, 'stale');
  assert.equal(health.can_send, true);
  assert.equal(health.reason_code, 'monitoring_stale');
});

test('una lectura Meta reciente evita stale aunque la proyección sea anterior', () => {
  const health = effectiveStoredHealth({
    quality_rating: 'GREEN',
    additionalData: {
      registration: {
        status: 'registered',
        phoneStatus: 'CONNECTED',
        lastAttemptAt: '2026-08-31T11:58:00.000Z',
      },
      whatsappHealth: {
        state: 'healthy',
        can_send: true,
        observed_at: '2026-08-31T10:00:00.000Z',
      },
    },
  }, { now: new Date('2026-08-31T12:00:00.000Z'), staleMinutes: 30 });
  assert.equal(health.state, 'healthy');
  assert.equal(health.is_stale, false);
  assert.equal(health.observed_at, '2026-08-31T11:58:00.000Z');
  assert.equal(health.source, 'stored_provider_snapshot');
});

test('sendMessage no llama al proveedor cuando el cortacircuitos bloquea', async () => {
  let providerCalled = false;
  const error = new Error('whatsapp_sender_health_blocked');
  error.code = 'WHATSAPP_SENDER_HEALTH_BLOCKED';
  const restores = [
    patchProperty(whatsappAccountHealthService, 'assertCanSend', async () => { throw error; }),
    patchProperty(whatsappService, 'sendTextMessage', async () => {
      providerCalled = true;
      return {};
    }),
  ];
  try {
    await assert.rejects(
      whatsappService.sendMessage({ to: '+34111111111', body: 'test', clinicConfig: {} }),
      { code: 'WHATSAPP_SENDER_HEALTH_BLOCKED' }
    );
    assert.equal(providerCalled, false);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('un intento detenido no cuenta como observación de recuperación', async () => {
  let transactionCalls = 0;
  let assetSaves = 0;
  const asset = {
    id: 374,
    assetType: 'whatsapp_phone_number',
    isActive: true,
    quality_rating: 'GREEN',
    additionalData: {
      registration: {
        status: 'registered',
        phoneStatus: 'CONNECTED',
      },
      whatsappHealth: {
        state: 'blocked',
        can_send: false,
        reason_code: 'meta_error_131031_account_locked',
        observed_at: new Date().toISOString(),
        recovery_connected_observations: 0,
      },
    },
    async save() { assetSaves += 1; },
  };
  const restores = [
    patchProperty(db.ClinicMetaAsset, 'findOne', async () => asset),
    patchProperty(db.ClinicMetaAsset, 'findByPk', async () => asset),
    patchProperty(db.WhatsappAccountHealthEvent, 'findOrCreate', async () => [null, false]),
    patchProperty(db.sequelize, 'transaction', async (callback) => {
      transactionCalls += 1;
      return callback({ LOCK: { UPDATE: 'UPDATE' } });
    }),
  ];
  try {
    await assert.rejects(
      whatsappAccountHealthService.assertCanSend({
        clinicConfig: { originId: asset.id },
        source: 'unit_test_preflight',
        messageId: 99,
      }),
      { code: 'WHATSAPP_SENDER_HEALTH_BLOCKED' }
    );
    assert.equal(transactionCalls, 1);
    assert.equal(assetSaves, 0);
    assert.equal(asset.additionalData.whatsappHealth.recovery_connected_observations, 0);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test('sendMessage registra 131031 antes de propagar el error', async () => {
  let recorded = null;
  const providerError = {
    response: { data: { error: { code: 131031, message: 'Business Account locked' } } },
  };
  const restores = [
    patchProperty(whatsappAccountHealthService, 'assertCanSend', async () => ({ allowed: true })),
    patchProperty(whatsappAccountHealthService, 'recordProviderFailure', async (payload) => {
      recorded = payload;
      return { recorded: true };
    }),
    patchProperty(whatsappService, 'sendTextMessage', async () => { throw providerError; }),
  ];
  try {
    await assert.rejects(whatsappService.sendMessage({
      to: '+34111111111',
      body: 'test',
      clinicConfig: { originId: 10 },
      healthContext: { source: 'unit_test', messageId: 99 },
    }));
    assert.equal(recorded.error, providerError);
    assert.equal(recorded.messageId, 99);
    assert.equal(recorded.source, 'unit_test');
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});
