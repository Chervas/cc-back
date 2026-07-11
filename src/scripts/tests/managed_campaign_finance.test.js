'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const adminController = require('../../controllers/adminManagedCampaigns.controller');
const clientController = require('../../controllers/managedCampaigns.controller');
const { paidChannelAllocations } = require('../../services/managedCampaignProvisioning.service');

async function testManagedCampaignReferences() {
  const validRequest = {
    id: 31,
    clinica_id: 58,
    campaign_id: 77,
    solicitud: { kind: 'marketing_strategy', objective_id: 'new_patients' },
  };
  const validModel = {
    async findByPk(id) {
      return id === 31 ? validRequest : null;
    },
    async findAll(options) {
      return options.where.campaign_id === 77 && options.where.clinica_id === 58
        ? [validRequest]
        : [];
    },
  };

  assert.deepEqual(await clientController.__test.validateAutopilotReferences({
    clinicId: 58,
    campaignRequestId: 31,
    campaignRequestModel: validModel,
  }), {
    strategyCampaignId: 77,
    campaignRequestId: 31,
  });

  await assert.rejects(
    clientController.__test.validateAutopilotReferences({
      clinicId: 19,
      campaignRequestId: 31,
      campaignRequestModel: validModel,
    }),
    (error) => error?.code === 'managed_reference_scope_mismatch' && error?.httpStatus === 403
  );
  await assert.rejects(
    clientController.__test.validateAutopilotReferences({
      clinicId: 58,
      strategyCampaignId: 999,
      campaignRequestModel: validModel,
    }),
    (error) => error?.code === 'managed_reference_scope_mismatch'
  );

  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/managedCampaigns.controller.js'),
    'utf8'
  );
  const requestStart = controllerSource.indexOf('exports.requestAutopilot');
  const requestEnd = controllerSource.indexOf('exports.approveClientProposal', requestStart);
  const requestSection = controllerSource.slice(requestStart, requestEnd);
  const clinicLock = requestSection.indexOf('lock: transaction.LOCK.UPDATE');
  const duplicateLookup = requestSection.indexOf('ManagedCampaign.findOne({');
  assert.ok(clinicLock >= 0 && clinicLock < duplicateLookup,
    'Autopilot idempotency must serialize on the clinic row before checking for an existing request');

  const adminControllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/adminManagedCampaigns.controller.js'),
    'utf8'
  );
  const spendStart = adminControllerSource.indexOf('exports.recordSpend');
  const spendEnd = adminControllerSource.indexOf('exports.listMatchingProposals', spendStart);
  const spendSection = adminControllerSource.slice(spendStart, spendEnd);
  const fundingLock = spendSection.indexOf('lock: transaction.LOCK.UPDATE');
  const snapshotLookup = spendSection.indexOf('ManagedCampaignSpendSnapshot.findOne({');
  assert.match(spendSection, /db\.sequelize\.transaction\(async \(transaction\)/,
    'Spend snapshot, funding totals and ledger delta must be atomic');
  assert.ok(fundingLock >= 0 && fundingLock < snapshotLookup,
    'Spend updates must serialize on funding before reading the previous daily snapshot');
  assert.match(spendSection, /ManagedCampaignSpendSnapshot\.findOne\(\{[\s\S]*?lock: transaction\.LOCK\.UPDATE/,
    'The existing daily snapshot must be locked before deriving its delta');
  assert.match(spendSection, /ManagedCampaignSpendSnapshot\.sum\('spend_amount',[\s\S]*?transaction/,
    'Funding totals must be recomputed within the same transaction');
  assert.match(spendSection, /ManagedCampaignLedgerEntry\.create\([\s\S]*?\}, \{ transaction \}\)/,
    'The spend delta ledger entry must commit atomically with its snapshot');
}

async function run() {
  const commission = adminController.__test.commissionFor(100, 'percentage', 10);
  assert.deepEqual(commission, { type: 'percentage', value: 10, amount: 10 });

  const funding = {
    id: 'funding-test',
    currency: 'EUR',
    status: 'depleted',
    client_gross_funded: '100.00',
    commission_type: 'percentage',
    commission_value: '10.0000',
    commission_amount: '10.00',
    media_budget_net: '90.00',
    media_spend: '90.00',
    reserved_amount: '0.00',
    available_amount: '0.00',
    terms_version: 2,
  };
  const admin = adminController.__test.fundingAdminDto(funding);
  assert.equal(admin.client_gross_funded, 100);
  assert.equal(admin.commission_amount, 10);
  assert.equal(admin.media_budget_net, 90);
  assert.equal(admin.media_spend, 90);
  assert.equal(admin.provisional_margin, 10);
  assert.equal(admin.realised_margin, null);
  assert.equal(admin.margin_status, 'provisional_bank_costs_pending');

  const client = clientController.__test.publicFunding(funding, 2);
  assert.deepEqual(client, {
    currency: 'EUR',
    status: 'depleted',
    total_paid: 100,
    total_consumed: 100,
    available: 0,
    leads: 2,
    cpl: 50,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(client, 'commission_amount'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(client, 'media_budget_net'), false);

  assert.equal(adminController.__test.hasVerifiedPrepaymentEntries([]), false);
  assert.equal(adminController.__test.hasVerifiedPrepaymentEntries([
    { metadata: { source: 'manual' } },
  ]), false);
  assert.equal(adminController.__test.hasVerifiedPrepaymentEntries([
    { metadata: { source: 'manual', payment_verified: true } },
  ]), true);

  assert.deepEqual(paidChannelAllocations([
    { channel: 'google_ads', enabled: true, percentage: 60 },
    { channel: 'meta_ads', enabled: true, percentage: 40 },
  ], 100), [
    { provider: 'google_ads', amount: 60 },
    { provider: 'meta_ads', amount: 40 },
  ]);
  assert.deepEqual(paidChannelAllocations([
    { channel: 'google_ads', enabled: true, percentage: 100 },
    { channel: 'email', enabled: true, percentage: 0 },
  ], 100), [{ provider: 'google_ads', amount: 100 }]);

  await testManagedCampaignReferences();

  console.log('managed_campaign_finance.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
