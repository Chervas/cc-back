'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { saveObservedGoogleDestination } = require('../../services/campaignWorkspaceGoogleDestination.service');
const { buildGoogleDestinationDetections } = require('../../lib/googleAdsCampaignMeasurementDiagnosis');

test('nightly URL writes lock the current cache and preserve newer interactive form proofs', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const proof = { source: 'workspace_google_ads', status: 'checked', run_id: 'newer-check' };
  const detections = buildGoogleDestinationDetections({ campaignRows: [{ campaign: { id: '30', advertisingChannelType: 'SEARCH' } }],
    landingRows: [{ campaign: { id: '30' }, landingPageView: { unexpandedFinalUrl: 'https://clinic.example/visit' }, metrics: { clicks: '5' } }], checkedAt: new Date() });
  let locked = false; const writes = [];
  const models = { sequelize: { transaction: async callback => { locked = true; try { return await callback(transaction); } finally { locked = false; } } },
    ExternalCampaignInventory: { findOne: async options => {
      assert.equal(locked, true); assert.equal(options.transaction, transaction); assert.equal(options.lock, 'UPDATE');
      assert.deepEqual(options.where, { provider: 'google_ads', customer_id: '20', campaign_id: '30' });
      return { destination_detection: { workspace_google: proof }, update: async (patch, options) => {
        assert.equal(options.transaction, transaction); assert.equal(locked, true); writes.push(patch);
      } };
    } } };
  const count = await saveObservedGoogleDestination({ models, reference: { account_id: '20', campaign_id: '30' }, detection: detections.get('30') });
  assert.equal(count, 1); assert.deepEqual(writes[0].destination_detection.workspace_google, proof);
  assert.deepEqual(writes[0].destination_detection.urls, ['https://clinic.example/visit/']);
  const source = fs.readFileSync(path.join(__dirname, '../../jobs/sync.jobs.js'), 'utf8');
  assert.match(source, /updated \+= await saveObservedGoogleDestination\(/);
});

test('the URL refresh retains earlier observed URLs, without replacing the separate form inventory', async () => {
  const current = { urls: ['https://clinic.example/old'], workspace_google: { status: 'checking', run_id: 'current' } };
  let result;
  const models = { sequelize: { transaction: async callback => callback({ LOCK: { UPDATE: 'UPDATE' } }) },
    ExternalCampaignInventory: { findOne: async () => ({ destination_detection: current, update: async value => { result = value.destination_detection; } }) } };
  await saveObservedGoogleDestination({ models, reference: { account_id: '20', campaign_id: '30' },
    detection: { urls: [], workspace_google: { status: 'checked', run_id: 'old' } } });
  assert.equal(result.status, 'observed_stale'); assert.deepEqual(result.urls, current.urls);
  assert.deepEqual(result.workspace_google, current.workspace_google);
});

test('a deleted inventory row is not recreated by the observed URL enrichment', async () => {
  const models = { sequelize: { transaction: async callback => callback({ LOCK: { UPDATE: 'UPDATE' } }) },
    ExternalCampaignInventory: { findOne: async () => null } };
  assert.equal(await saveObservedGoogleDestination({ models, reference: { account_id: '20', campaign_id: '30' }, detection: {} }), 0);
});
