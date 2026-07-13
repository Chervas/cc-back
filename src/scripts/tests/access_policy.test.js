'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('consents.view'), true);
  assert.equal(features.get('consents.view')?.kind, 'view');
  assert.equal(features.get('consents.view')?.enforcement_status, 'route');

  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('consents.manage'), true);
  assert.equal(features.get('consents.manage')?.kind, 'action');
  assert.equal(features.get('consents.manage')?.enforcement_status, 'partial');

  assert.equal(accessPolicy.defaultForFeature('consents.view', 'unknown'), false);
  assert.equal(accessPolicy.defaultForFeature('consents.manage', 'unknown'), false);

  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('team.view'), true);
  assert.equal(features.get('team.view')?.kind, 'view');
  assert.equal(features.get('team.view')?.enforcement_status, 'route');
  assert.equal(accessPolicy.defaultForFeature('team.view', 'reception'), true);
  assert.equal(accessPolicy.defaultForFeature('team.view', 'doctor'), true);
  assert.equal(accessPolicy.defaultForFeature('team.view', 'unknown'), false);

  assert.equal(features.get('team.manage')?.kind, 'action');
  assert.equal(features.get('team.manage')?.enforcement_status, 'partial');
  assert.equal(accessPolicy.defaultForFeature('team.manage', 'reception'), false);

  assert.equal(features.get('quickchat.read_patients')?.kind, 'read');
  assert.equal(features.get('quickchat.read_patients')?.enforcement_status, 'backend');
  assert.equal(features.get('quickchat.read_team')?.kind, 'read');
  assert.equal(features.get('quickchat.read_team')?.enforcement_status, 'backend');
  assert.equal(features.get('quickchat.read_leads')?.kind, 'read');
  assert.equal(features.get('quickchat.read_leads')?.enforcement_status, 'backend');

  const citasController = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/citas.controller.js'),
    'utf8'
  );
  const deleteStart = citasController.indexOf('exports.deleteCita =');
  const deleteEnd = citasController.indexOf('exports.reagendarCita =', deleteStart);
  const deleteSection = citasController.slice(deleteStart, deleteEnd);
  assert.match(
    deleteSection,
    /denyAppointmentManageAccessIfNeeded\(req, res, cita\.clinica_id\)/,
    'Deleting a cancelled appointment must enforce appointments.manage after staging/dev merge'
  );

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
