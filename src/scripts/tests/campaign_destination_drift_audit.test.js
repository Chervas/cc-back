'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { auditActiveDestinations } = require('../../services/campaignDestinationBindings.service');

function row(values) {
  return {
    ...values,
    async update(patch) { Object.assign(this, patch); return this; },
    get({ plain } = {}) { return plain ? { ...this, update: undefined, get: undefined } : this; },
  };
}

function fixture({ verified }) {
  const account = row({
    id: '11111111-1111-4111-8111-111111111111', bindingId: '22222222-2222-4222-8222-222222222222',
    provider: 'google_ads', customerId: '123', campaignId: '456', family: 'google_search', state: 'active',
    desiredState: { final_urls: ['https://example.com/cita/'] }, observedState: null, readbackAt: null,
  });
  const binding = row({
    id: account.bindingId, publicationStatus: 'verified', destinationStatus: 'active',
    destinationUrl: 'https://example.com/cita/', version: 2,
  });
  const events = [];
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    CampaignDestinationBindingAccount: {
      async findAll() { return [account]; },
      async findByPk() { return account; },
    },
    CampaignDestinationBinding: { async findByPk() { return binding; } },
    CampaignDestinationBindingEvent: {
      async findOne() { return null; },
      async create(values) { const event = row(values); events.push(event); return event; },
    },
  };
  const adapter = {
    async inspect() { return { final_urls: verified ? ['https://example.com/cita/'] : ['https://other.example/'] }; },
    verifyState({ state }) { return { verified, observed: state, mismatches: verified ? [] : ['final_urls'] }; },
  };
  return {
    account,
    binding,
    events,
    dependencies: {
      models,
      sequelize: { async transaction(callback) { return callback(transaction); } },
      adapterFor: () => adapter,
    },
  };
}

async function main() {
  const healthy = fixture({ verified: true });
  const healthyResult = await auditActiveDestinations({}, healthy.dependencies);
  assert.equal(healthyResult.status, 'completed');
  assert.equal(healthyResult.report.healthy, 1);
  assert.equal(healthy.account.state, 'active');
  assert.deepEqual(healthy.account.observedState, { final_urls: ['https://example.com/cita/'] });
  assert.equal(healthy.events.length, 0);

  const drift = fixture({ verified: false });
  const driftResult = await auditActiveDestinations({}, drift.dependencies);
  assert.equal(driftResult.report.drifted, 1);
  assert.equal(drift.account.state, 'drifted');
  assert.equal(drift.binding.destinationStatus, 'drifted');
  assert.equal(drift.binding.lastErrorCode, 'campaign_destination_periodic_drift_detected');
  assert.equal(drift.events[0].eventType, 'drift_detected');

  const catalog = fs.readFileSync(path.join(__dirname, '../../config/scheduledJobCatalog.js'), 'utf8');
  const jobs = fs.readFileSync(path.join(__dirname, '../../jobs/sync.jobs.js'), 'utf8');
  assert.match(catalog, /campaignDestinationDriftAudit:[\s\S]*marketing_campaign\.destination_drift_audit\.v1/);
  assert.match(jobs, /JOBS_CAMPAIGN_DESTINATION_DRIFT_AUDIT_SCHEDULE \|\| '5 3 \* \* \*'/);
  assert.match(jobs, /executeCampaignDestinationDriftAudit[\s\S]*auditActiveDestinations/);
  console.log('campaign destination drift audit: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
