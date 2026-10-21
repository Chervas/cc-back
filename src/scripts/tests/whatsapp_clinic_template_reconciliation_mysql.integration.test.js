'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { acquireWabaCatalogCreationLease } = require('../../lib/waba-catalog-creation-lease');
const { nativeFunction, source } = require('./whatsapp_clinic_template_reconciliation.test');

test('native custom reconciliation serializes copies with the real SQL WABA lease and durable checkpoints', {
  skip: process.env.WHATSAPP_CLINIC_TEMPLATE_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const Template = models.WhatsappTemplate = require('../../../models/whatsapptemplate')(sql, S.DataTypes);
  await Template.sync();
  await sql.getQueryInterface().addIndex('WhatsappTemplates', ['waba_id', 'name', 'language'], { unique: true, name: 'testonly_waba_name_language' });
  await Template.create(source());
  let creates = 0, routed = true, dropResponse = false;
  const remote = new Map();
  const deps = { WhatsappTemplate: Template, customTemplateTargetClinics: async () => routed ? [58] : [],
    resolveWabaAssetById: async () => ({}), prepareTemplateImageHeaderForMeta: async ({ template }) => ({ template }),
    enqueueCustomSubmissionSync: async () => {},
    createTemplateInMeta: async ({ wabaId, template }) => {
      creates++; assert.deepEqual(template.components, source().components);
      remote.set(wabaId, { name: template.name, id: 'TESTONLY-provider-' + creates });
      if (dropResponse) throw Error('TESTONLY_RESPONSE_LOST');
      return { id: remote.get(wabaId).id };
    },
    WHATSAPP_TEMPLATE_STATUS: { LOCAL_PENDING: 'PENDING_LOCAL', PENDING: 'PENDING', REJECTED: 'REJECTED' },
    templateSyncState: { blockedCode: () => null }, buildLocalPendingReasonFromMetaError: () => 'TESTONLY rejection',
  };
  const copy = nativeFunction('reconcileClinicCustomTemplatesWithLease', deps);
  const run = nativeFunction('reconcileClinicCustomTemplates', { ...deps, db: { sequelize: sql }, acquireWabaCatalogCreationLease,
    reconcileClinicCustomTemplatesWithLease: copy,
    syncTemplatesForWaba: async ({ wabaId }) => {
      const accepted = remote.get(wabaId);
      if (accepted) await Template.update({ meta_template_id: accepted.id, status: 'APPROVED', rejection_reason: null },
        { where: { waba_id: wabaId, name: accepted.name, clinic_id: 58, created_by_user_id: 76 } });
    },
  });
  const input = { wabaId: 'TESTONLY-new', clinicId: 58, assignmentScope: 'clinic' };
  await Promise.all(Array.from({ length: 6 }, () => run(input)));
  assert.equal(creates, 1); assert.equal(await Template.count(), 2);
  const row = await Template.findOne({ where: { waba_id: input.wabaId }, raw: true });
  assert.equal(row.created_by_user_id, 76); assert.equal(row.clinic_id, 58); assert.equal(row.name, source().name);
  assert.deepEqual(row.variables, source().variables);
  report.checks.push('Six concurrent native jobs and restarts: one SQL row and one simulated provider create; clinic, author and complete content preserved.');
  dropResponse = true; await run({ ...input, wabaId: 'TESTONLY-lost-response' });
  assert.equal(creates, 2); dropResponse = false; await run({ ...input, wabaId: 'TESTONLY-lost-response' });
  assert.equal(creates, 2);
  report.checks.push('Provider acceptance with lost response is reconciled on the pinned identity, without a second POST.');
  routed = false; await run({ ...input, wabaId: 'TESTONLY-unrouted' }); assert.equal(creates, 2);
  assert.equal(await Template.count({ where: { waba_id: 'TESTONLY-unrouted' } }), 0);
  report.checks.push('Removed routing causes no copy, no send and no legacy fallback; owned MySQL only, no provider or patient sockets.');
  const Asset = sql.define('TestOnlyProbeAsset', { id: { type: S.INTEGER, primaryKey: true }, assetType: S.STRING,
    isActive: S.BOOLEAN, additionalData: S.JSON }, { tableName: 'testonly_probe_assets' });
  const Message = sql.define('TestOnlyProbeMessage', { id: { type: S.INTEGER, primaryKey: true }, direction: S.STRING,
    status: S.STRING, metadata: S.JSON }, { tableName: 'testonly_probe_messages' });
  const Event = sql.define('TestOnlyProbeAudit', { asset_id: S.INTEGER }, { tableName: 'testonly_probe_audit' });
  await Asset.sync(); await Message.sync(); await Event.sync();
  const now = new Date('2030-01-02T10:00:00Z');
  for (const id of [1, 2]) await Asset.create({ id, assetType: 'whatsapp_phone_number', isActive: true,
    additionalData: { payment: { status: 'missing_payment_method', last_error_code: 131042, last_detected_at: '2030-01-02T09:00:00Z' } } });
  for (const id of [1, 2, 3]) await Message.create({ id, direction: 'outbound', status: 'pending', createdAt: now,
    metadata: { kind: 'mass_campaign_test', payment_recovery_probe: true, sender_origin_id: id === 3 ? 2 : 1 } });
  const shared = { paymentProbe: require('../../lib/whatsapp-payment-recovery-probe'), safeObject: value => value || {} };
  const eligibility = nativeFunction('paymentRecoveryProbeEligibility', shared, 'whatsappAccountHealth');
  const claim = nativeFunction('claimPaymentRecoveryProbe', { ...shared, db: { sequelize: sql }, ClinicMetaAsset: Asset, Message,
    clean: value => String(value || '').trim(), paymentRecoveryProbeEligibility: eligibility,
    summarizeAssetHealth: () => ({ state: 'blocked', reason_code: 'meta_error_131042_payment_missing', provider_status: 'CONNECTED' }),
    healthEventDetails: () => ({}), createEvent: (input, transaction) => Event.create({ asset_id: input.asset.id }, { transaction }),
  }, 'whatsappAccountHealth');
  const results = await Promise.all([1, 2].map(messageId => claim({ assetId: 1, messageId, now,
    source: 'marketing_bulk_send_test_payment_recovery_probe' })));
  assert.equal(results.filter(row => row.allowed).length, 1); assert.equal(results.filter(row => row.reason === 'payment_probe_cooldown').length, 1);
  assert.equal(await Event.count(), 1);
  assert.equal((await claim({ assetId: 2, messageId: 3, now, source: 'marketing_bulk_send_test_payment_recovery_probe' })).allowed, true);
  assert.equal(await Event.count(), 2);
  assert.equal((await claim({ assetId: 2, messageId: 3, now, source: 'ordinary_automation' })).allowed, false);
  report.checks.push('Actual payment claim transaction: two concurrent attempts on one sender produce one audit/probe; another sender remains independent; ordinary automation cannot claim a probe. No provider sends.');
}));
