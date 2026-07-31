'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const db = require('../../../models');
const marketingReactivationService = require('../../services/marketingReactivation.service');

async function run() {
  const { isPastImportedHistoricalVisit } = marketingReactivationService._test;
  const now = new Date('2026-07-31T12:00:00.000Z');

  assert.equal(
    isPastImportedHistoricalVisit('2026-07-30T12:00:00.000Z', now),
    true,
    'Past visits can be represented as imported historical appointments'
  );
  assert.equal(
    isPastImportedHistoricalVisit('2026-08-01T12:00:00.000Z', now),
    false,
    'Future visits must never be converted into completed historical appointments'
  );
  assert.equal(isPastImportedHistoricalVisit('not-a-date', now), false);

  console.log('marketing_reactivation_historical_import.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
    process.exit(process.exitCode || 0);
  });
