'use strict';

const assert = require('assert');
const {
  buildDedupeKey,
  deriveComplianceSnapshot,
  isGroupScopedAsset,
} = require('../../lib/whatsapp-account-compliance');
const {
  buildAppealDraft,
  getStoredAccountUpdate,
  __testing: {
    buildAccountReviewSnapshot,
    buildManualReviewIncidentSpec,
    sanitizeAppealActivity,
    buildTechnicalRestrictions,
  },
} = require('../../services/whatsappAccountCompliance.service');

const webhookEntry = { id: 'waba-123', time: 1786140000 };
const webhookValue = {
  event: 'ACCOUNT_RESTRICTION',
  restriction_info: [{
    restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
    expiration: '2099-01-01T00:00:00.000Z',
  }],
};
const firstDedupeKey = buildDedupeKey({
  wabaId: webhookEntry.id,
  field: 'account_update',
  entry: webhookEntry,
  value: webhookValue,
});
const retriedDedupeKey = buildDedupeKey({
  wabaId: webhookEntry.id,
  field: 'account_update',
  entry: webhookEntry,
  value: JSON.parse(JSON.stringify(webhookValue)),
});
assert.strictEqual(firstDedupeKey, retriedDedupeKey);
assert.strictEqual(firstDedupeKey.length, 64);
assert.notStrictEqual(firstDedupeKey, buildDedupeKey({
  wabaId: webhookEntry.id,
  field: 'account_update',
  entry: { ...webhookEntry, time: webhookEntry.time + 1 },
  value: webhookValue,
}));

assert.strictEqual(isGroupScopedAsset({ assignmentScope: 'clinic', grupoClinicaId: 8 }), false);
assert.strictEqual(isGroupScopedAsset({ assignmentScope: 'group', grupoClinicaId: 8 }), true);
assert.strictEqual(isGroupScopedAsset({ assignmentScope: 'group', grupoClinicaId: null }), false);

const violation = deriveComplianceSnapshot({
  event: 'ACCOUNT_VIOLATION',
  violation_info: { violation_type: 'HEALTHCARE' },
});
assert.strictEqual(violation.status, 'warning');
assert.strictEqual(violation.violation_label, 'Productos o servicios sanitarios restringidos');
assert.match(violation.violation_description, /productos sanitarios restringidos/i);
assert.strictEqual(violation.blocks_business_initiated, false);

const restriction = deriveComplianceSnapshot({
  event: 'ACCOUNT_RESTRICTION',
  restriction_info: [{
    restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING',
    expiration: '2099-01-01T00:00:00.000Z',
  }],
});
assert.strictEqual(restriction.status, 'restricted');
assert.strictEqual(restriction.blocks_business_initiated, true);
assert.strictEqual(restriction.blocks_customer_replies, false);
assert.strictEqual(restriction.restrictions[0].restriction_label, 'No se pueden iniciar conversaciones con pacientes');

const expiredRestriction = deriveComplianceSnapshot({
  event: 'ACCOUNT_RESTRICTION',
  restriction_info: [{
    restriction_type: 'RESTRICTED_CUSTOMER_INITIATED_MESSAGING',
    expiration: '2020-01-01T00:00:00.000Z',
  }],
}, new Date('2026-08-07T00:00:00.000Z'));
assert.strictEqual(expiredRestriction.status, 'active');
assert.strictEqual(expiredRestriction.blocks_customer_replies, false);

const suspended = deriveComplianceSnapshot({
  event: 'DISABLED_UPDATE',
  ban_info: { waba_ban_state: 'DISABLE' },
});
assert.strictEqual(suspended.status, 'suspended');
assert.strictEqual(suspended.blocks_all_sending, true);

const scheduled = deriveComplianceSnapshot({
  event: 'DISABLED_UPDATE',
  ban_info: { waba_ban_state: 'SCHEDULE_FOR_DISABLE' },
});
assert.strictEqual(scheduled.status, 'scheduled_for_disable');
assert.strictEqual(scheduled.blocks_all_sending, false);

const reinstated = deriveComplianceSnapshot({
  event: 'DISABLED_UPDATE',
  ban_info: { waba_ban_state: 'REINSTATE' },
});
assert.strictEqual(reinstated.status, 'active');
assert.strictEqual(reinstated.blocks_all_sending, false);

const storedRestriction = getStoredAccountUpdate({
  wabaId: 'waba-legacy',
  updatedAt: '2026-08-06T21:37:26.619Z',
  additionalData: {
    coexistence: {
      account_update_last_at: '2026-08-06T21:37:26.617Z',
      last_account_update: {
        event: 'ACCOUNT_RESTRICTION',
        raw: webhookValue,
      },
    },
  },
});
assert.strictEqual(storedRestriction.event, 'ACCOUNT_RESTRICTION');
assert.strictEqual(storedRestriction.entry.id, 'waba-legacy');
assert.strictEqual(storedRestriction.change.field, 'account_update');
assert.strictEqual(storedRestriction.value.restriction_info[0].restriction_type, 'RESTRICTED_BIZ_INITIATED_MESSAGING');
assert.strictEqual(getStoredAccountUpdate({
  wabaId: 'waba-legacy',
  additionalData: {
    coexistence: {
      last_account_update: { event: 'ACCOUNT_RECONNECTED', raw: { event: 'ACCOUNT_RECONNECTED' } },
    },
  },
}), null);

const rejectedReview = buildAccountReviewSnapshot({
  decision: 'REJECTED',
  rejection_reason: 'Business details could not be confirmed',
});
assert.strictEqual(rejectedReview.event, 'ACCOUNT_REVIEW_REJECTED');
assert.strictEqual(rejectedReview.status, 'restricted');
assert.strictEqual(rejectedReview.blocks_all_sending, true);
assert.match(rejectedReview.violation_label, /could not be confirmed/);
assert.strictEqual(buildAccountReviewSnapshot({ decision: 'UNKNOWN' }), null);

const technicalRestrictions = buildTechnicalRestrictions({
  business_id: 'business-1',
  business_verification_status: 'rejected',
  entities: [
    {
      id: 'waba-123',
      entity_type: 'WABA',
      errors: [{
        error_code: 141006,
        error_description: 'There is an error with the payment method.',
        possible_solution: 'Add a new payment method.',
      }],
    },
    {
      id: 'business-1',
      entity_type: 'BUSINESS',
      errors: [{
        error_code: 141010,
        error_description: 'The Business has not passed business verification.',
        possible_solution: 'Resolve business verification.',
      }],
    },
  ],
});
assert.deepStrictEqual(technicalRestrictions.map((row) => row.error_code), [141006, 141010]);
assert.match(technicalRestrictions[0].remediation, /payment method/i);

const manualSpec = buildManualReviewIncidentSpec({
  asset: {
    id: 367,
    assetType: 'whatsapp_phone_number',
    wabaId: 'waba-123',
    phoneNumberId: 'phone-456',
    metaAssetName: '+34 600 00 00 00',
    additionalData: {
      whatsappBusinessHealth: {
        can_send_message: 'BLOCKED',
        business_verification_status: 'rejected',
        entities: [{
          id: 'waba-123',
          entity_type: 'WABA',
          errors: [{ error_code: 141006, error_description: 'Payment error' }],
        }],
      },
      whatsappWebhookSubscription: {
        status: 'subscribed',
        callback_host: 'autenticacion.clinicaclick.com',
      },
      secret_token: 'must-not-be-copied',
    },
  },
  context: { clinicId: 67, groupId: null },
  health: {
    state: 'blocked',
    can_send: false,
    reason_code: 'waba_health_blocked',
    observed_at: '2026-08-31T16:06:09.000Z',
    last_blocked_at: '2026-08-31T16:06:09.000Z',
  },
  now: new Date('2026-08-31T18:00:00.000Z'),
  userId: 1,
});
assert.strictEqual(manualSpec.provider_event, 'WABA_HEALTH_BLOCKED');
assert.strictEqual(manualSpec.webhook_field, 'manual_health_review');
assert.strictEqual(manualSpec.restriction_info[0].error_code, 141006);
assert.strictEqual(JSON.stringify(manualSpec.raw_payload).includes('must-not-be-copied'), false);

const sanitizedActivity = sanitizeAppealActivity({
  last_7d: 3,
  failed_7d: 1,
  status_counts: { delivered: 2, failed: 1 },
  source_counts: { automation: 3 },
  error_counts: { 131031: 1 },
  attribution: { phone_number_id: 'sender-phone-id', exact_7d: 3, scoped_by_route: true },
  recent: [{
    id: 99,
    excerpt: 'Contenido de paciente',
    status_history: [{ recipient_id: '34600000000', status: 'failed' }],
  }],
  recent_failures: [{ recipient_id: '34600000000' }],
});
assert.strictEqual(sanitizedActivity.last_7d, 3);
assert.strictEqual(sanitizedActivity.error_counts['131031'], 1);
assert.strictEqual(sanitizedActivity.attribution.phone_number_id, 'sender-phone-id');
assert.strictEqual(Object.hasOwn(sanitizedActivity, 'recent'), false);
assert.strictEqual(Object.hasOwn(sanitizedActivity, 'recent_failures'), false);
assert.strictEqual(JSON.stringify(sanitizedActivity).includes('34600000000'), false);
assert.strictEqual(JSON.stringify(sanitizedActivity).includes('Contenido de paciente'), false);

const appealDraft = buildAppealDraft({
  incident: {
    phone_number: '+34 600 00 00 00',
    waba_id: 'waba-123',
    phone_number_id: 'phone-456',
    provider_event: 'ACCOUNT_RESTRICTION',
    operational_status: 'restricted',
    occurred_at: '2026-08-06T21:37:26.000Z',
    restriction_info: restriction.restrictions,
  },
  clinicName: 'Clínica QA',
  groupName: 'Grupo QA',
  account: {
    verified_name: 'Atención Grupo QA',
    quality_rating: 'RED',
    messaging_limit: 'TIER_1K',
  },
  activity: {
    last_7d: 120,
    accepted_7d: 116,
    confirmed_7d: 36,
    without_confirmation_7d: 80,
    failed_7d: 4,
    status_counts: { sent: 80, delivered: 20, read: 16, failed: 4 },
  },
});
assert.match(appealDraft, /WABA ID: waba-123/);
assert.match(appealDraft, /Phone Number ID: phone-456/);
assert.match(appealDraft, /Atención Grupo QA/);
assert.match(appealDraft, /RESTRICTED_BIZ_INITIATED_MESSAGING/);
assert.match(appealDraft, /120 mensajes registrados, 36 con entrega confirmada, 80 sin confirmación posterior y 4 fallidos/);

console.log('whatsapp_account_compliance.test.js OK');
process.exit(0);
