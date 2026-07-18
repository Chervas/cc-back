'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const campaignOnboardingController = require('../../controllers/campaignOnboarding.controller');

const {
  CAMPAIGN_MODES,
  guardCampaignOnboardingStartMode,
} = campaignOnboardingController.__test;

function testOnlyManagedServiceIsRedirectedToItsRequestFlow() {
  assert.equal(guardCampaignOnboardingStartMode(CAMPAIGN_MODES.MEASURE), null);
  assert.equal(guardCampaignOnboardingStartMode(CAMPAIGN_MODES.IMPROVE), null);

  const guard = guardCampaignOnboardingStartMode(CAMPAIGN_MODES.AUTOPILOT);
  assert.equal(guard.http_status, 409);
  assert.deepEqual(guard.body, {
    success: false,
    error: 'managed_service_request_required',
    message: 'Piloto automático se solicita desde su flujo específico para poder revisar presupuesto, financiación y aprobación antes de operar campañas.',
    next_action: 'request_managed_campaign',
    request_endpoint: '/api/marketing/managed-campaigns/request',
    allowed_modes: ['connect_only', 'guided_improvement'],
  });
}

async function testEndpointRejectsManagedServiceBeforeDatabaseWrites() {
  const originalFindAll = db.CampaignRequest.findAll;
  const originalCreate = db.CampaignRequest.create;
  let databaseCallCount = 0;
  db.CampaignRequest.findAll = async () => {
    databaseCallCount += 1;
    throw new Error('CampaignRequest.findAll must not run');
  };
  db.CampaignRequest.create = async () => {
    databaseCallCount += 1;
    throw new Error('CampaignRequest.create must not run');
  };

  let statusCode = 200;
  let responseBody = null;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      responseBody = payload;
      return this;
    },
  };
  let forwardedError = null;

  try {
    await campaignOnboardingController.startCampaignOnboarding({
      userData: { userId: 77 },
      body: {
        mode: CAMPAIGN_MODES.AUTOPILOT,
        mode_transition: {
          confirmed: true,
          from_mode: CAMPAIGN_MODES.MEASURE,
          to_mode: CAMPAIGN_MODES.AUTOPILOT,
        },
      },
    }, response, (error) => {
      forwardedError = error;
    });
  } finally {
    db.CampaignRequest.findAll = originalFindAll;
    db.CampaignRequest.create = originalCreate;
  }

  assert.equal(forwardedError, null);
  assert.equal(databaseCallCount, 0);
  assert.equal(statusCode, 409);
  assert.equal(responseBody.error, 'managed_service_request_required');
  assert.equal(responseBody.next_action, 'request_managed_campaign');
  assert.equal(responseBody.request_endpoint, '/api/marketing/managed-campaigns/request');
}

function testGuardPrecedesScopeAndTransitionWork() {
  const controllerPath = path.resolve(
    __dirname,
    '../../controllers/campaignOnboarding.controller.js'
  );
  const source = fs.readFileSync(controllerPath, 'utf8');
  const start = source.indexOf('exports.startCampaignOnboarding');
  const end = source.indexOf('exports.getCampaignOnboardingStatus', start);
  const section = source.slice(start, end);
  const guardIndex = section.indexOf('guardCampaignOnboardingStartMode(mode)');

  assert.ok(guardIndex >= 0);
  for (const marker of [
    'validateImprovementAuthorization(',
    'resolveScopeFromInput({',
    'assertCampaignModeTransitionSafe({',
    'CampaignRequest.create({',
  ]) {
    assert.ok(
      guardIndex < section.indexOf(marker),
      `The managed-service guard must precede ${marker}`
    );
  }
}

async function run() {
  testOnlyManagedServiceIsRedirectedToItsRequestFlow();
  await testEndpointRejectsManagedServiceBeforeDatabaseWrites();
  testGuardPrecedesScopeAndTransitionWork();
  console.log('campaign_managed_service_onboarding_guard.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
