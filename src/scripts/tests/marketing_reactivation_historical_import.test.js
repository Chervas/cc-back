'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const db = require('../../../models');
const marketingReactivationService = require('../../services/marketingReactivation.service');

async function run() {
  const {
    isPastImportedHistoricalVisit,
    shouldCreateImportedHistoricalAppointments,
  } = marketingReactivationService._test;
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

  assert.equal(
    shouldCreateImportedHistoricalAppointments({}),
    false,
    'Imports must not create appointments unless the caller opts in explicitly'
  );
  assert.equal(shouldCreateImportedHistoricalAppointments({ create_historical_appointments: false }), false);
  assert.equal(shouldCreateImportedHistoricalAppointments({ create_historical_appointments: 'true' }), false);
  assert.equal(shouldCreateImportedHistoricalAppointments({ create_historical_appointments: true }), true);
  assert.equal(shouldCreateImportedHistoricalAppointments({ createHistoricalAppointments: true }), true);

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
