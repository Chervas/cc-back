'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const db = require('../../../models');
const accessPolicy = require('../../lib/access-policy');

async function run() {
  const catalog = accessPolicy.getAccessPolicyCatalog();
  const features = new Map(catalog.features.map((feature) => [feature.key, feature]));

  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('appointments.view'), true);
  assert.equal(features.get('appointments.view')?.kind, 'view');
  assert.equal(features.get('appointments.view')?.enforcement_status, 'route');

  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('appointments.manage'), true);
  assert.equal(features.get('appointments.manage')?.kind, 'action');
  assert.equal(features.get('appointments.manage')?.enforcement_status, 'backend');

  assert.equal(accessPolicy.defaultForFeature('appointments.view', 'unknown'), true);
  assert.equal(accessPolicy.defaultForFeature('appointments.manage', 'unknown'), false);

  console.log('access_policy.test.js OK');
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
