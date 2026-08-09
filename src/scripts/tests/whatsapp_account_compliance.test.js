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
