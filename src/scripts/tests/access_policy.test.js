'use strict';

require('dotenv').config();

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const accessPolicy = require('../../lib/access-policy');

function testLeadAutomationAuthorizationContract() {
  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/intake.controller.js'),
    'utf8',
  );
  const start = controllerSource.indexOf('const requireLeadAutomationClinicAccess');
  const end = controllerSource.indexOf('const resolveIntakeCandidateClinicIds', start);
  assert.ok(start >= 0 && end > start, 'lead automation access guard must exist');

  const guardSource = controllerSource.slice(start, end);
  assert.match(guardSource, /featureKey:\s*'leads\.manage'/);
  assert.doesNotMatch(
    guardSource,
    /requireIntakeConfigScopeAccess/,
    'lead automation must not require generic Marketing write access in addition to leads.manage',
  );
}

async function testClinicSettingsAuthorizationMatrix() {
  const originals = {
    membershipFindOne: db.UsuarioClinica.findOne,
    clinicFindByPk: db.Clinica.findByPk,
    overrideFindAll: db.AccessPolicyOverride.findAll,
  };
  let membership = null;
  let overrides = [];

  db.UsuarioClinica.findOne = async ({ where }) => {
    assert.ok(where.id_usuario);
    assert.ok(where.id_clinica);
    assert.ok(where[db.Sequelize.Op.or], 'active invitation condition must be enforced');
    return membership;
  };
  db.Clinica.findByPk = async () => ({ id_clinica: 66, grupoClinicaId: 29 });
  db.AccessPolicyOverride.findAll = async () => overrides;

  try {
    membership = { rol_clinica: 'propietario', subrol_clinica: null };
    assert.equal(await accessPolicy.canUserAccessFeature({
      actorId: 9001,
      featureKey: 'clinic.settings.view',
      clinicId: 66,
    }), true);
    assert.equal(await accessPolicy.canUserAccessFeature({
      actorId: 9001,
      featureKey: 'clinic.settings.edit',
      clinicId: 66,
    }), true);

    membership = { rol_clinica: 'personaldeclinica', subrol_clinica: 'Doctores' };
    assert.equal(await accessPolicy.canUserAccessFeature({
      actorId: 9002,
      featureKey: 'clinic.settings.view',
      clinicId: 66,
    }), true);
    assert.equal(await accessPolicy.canUserAccessFeature({
      actorId: 9002,
      featureKey: 'clinic.settings.edit',
      clinicId: 66,
    }), false);

    overrides = [{ scope_type: 'clinic', scope_id: 66, effect: 'deny' }];
    assert.equal(await accessPolicy.canUserAccessFeature({
      actorId: 9002,
      featureKey: 'clinic.settings.view',
      clinicId: 66,
    }), false);
    overrides = [{ scope_type: 'group', scope_id: 29, effect: 'allow' }];
    assert.equal(await accessPolicy.canUserAccessFeature({
      actorId: 9002,
      featureKey: 'clinic.settings.edit',
      clinicId: 66,
    }), true);

    membership = null;
    overrides = [];
    assert.equal(await accessPolicy.canUserAccessFeature({
      actorId: 9003,
      featureKey: 'clinic.settings.view',
      clinicId: 66,
    }), false);

    membership = { rol_clinica: 'propietario', subrol_clinica: null };
    assert.equal(await accessPolicy.canUserAccessFeature({
      actorId: 9001,
      featureKey: 'marketing.web.templates.manage',
      clinicId: 66,
    }), false, 'template management must be closed by default');
    overrides = [{ scope_type: 'group', scope_id: 29, effect: 'allow' }];
    assert.equal(await accessPolicy.canUserAccessFeature({
      actorId: 9001,
      featureKey: 'marketing.web.templates.manage',
      clinicId: 66,
    }), true, 'template management may be delegated with an explicit override');
    assert.equal(await accessPolicy.canUserAccessFeature({
      actorId: 1,
      featureKey: 'marketing.web.templates.manage',
      clinicId: 66,
    }), true, 'global admins retain the explicit bypass');
  } finally {
    db.UsuarioClinica.findOne = originals.membershipFindOne;
    db.Clinica.findByPk = originals.clinicFindByPk;
    db.AccessPolicyOverride.findAll = originals.overrideFindAll;
  }
}

async function run() {
  testLeadAutomationAuthorizationContract();
  const catalog = accessPolicy.getAccessPolicyCatalog();
  const features = new Map(catalog.features.map((feature) => [feature.key, feature]));
  const allowedFeatureKeys = [...accessPolicy.ALLOWED_FEATURE_KEYS].sort();
  const catalogFeatureKeys = catalog.features.map((feature) => feature.key).sort();
  const defaultFeatureKeys = Object.keys(catalog.defaults).sort();

  assert.deepEqual(
    catalogFeatureKeys,
    allowedFeatureKeys,
    'every allowlisted feature must have exactly one catalog entry',
  );
  assert.deepEqual(
    defaultFeatureKeys,
    allowedFeatureKeys,
    'every allowlisted feature must have an explicit default matrix',
  );
  assert.equal(
    new Set(catalog.features.map((feature) => feature.key)).size,
    catalog.features.length,
    'feature catalog keys must be unique',
  );
  for (const featureKey of allowedFeatureKeys) {
    assert.deepEqual(
      Object.keys(catalog.defaults[featureKey]).sort(),
      [...accessPolicy.ALLOWED_ROLE_CODES].sort(),
      `${featureKey} must define a default for every role code`,
    );
  }

  assert.equal(
    accessPolicy.defaultForFeature('allowlisted.feature.without.defaults', 'propietario'),
    false,
    'a missing default matrix must fail closed',
  );

  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('appointments.view'), true);
  assert.equal(features.get('appointments.view')?.kind, 'view');
  assert.equal(features.get('appointments.view')?.enforcement_status, 'route');

  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('appointments.manage'), true);
  assert.equal(features.get('appointments.manage')?.kind, 'action');
  assert.equal(features.get('appointments.manage')?.enforcement_status, 'backend');

  assert.equal(accessPolicy.defaultForFeature('appointments.view', 'unknown'), true);
  assert.equal(accessPolicy.defaultForFeature('appointments.manage', 'unknown'), false);
  assert.equal(accessPolicy.defaultForFeature('appointments.view', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('appointments.manage', 'agencia'), false);

  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('patients.sensitive.view'), true);
  assert.equal(features.get('patients.sensitive.view')?.kind, 'read');
  assert.equal(features.get('patients.sensitive.view')?.enforcement_status, 'backend');
  assert.equal(accessPolicy.defaultForFeature('patients.view', 'agencia'), true);
  assert.equal(accessPolicy.defaultForFeature('patients.sensitive.view', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('patients.edit', 'agencia'), false);
  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('leads.sensitive.view'), true);
  assert.equal(features.get('leads.sensitive.view')?.enforcement_status, 'backend');
  assert.equal(accessPolicy.defaultForFeature('leads.sensitive.view', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('leads.sensitive.view', 'reception'), true);
  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('leads.manage'), true);
  assert.equal(features.get('leads.manage')?.enforcement_status, 'backend');
  assert.equal(accessPolicy.defaultForFeature('leads.manage', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('leads.manage', 'reception'), true);
  assert.equal(accessPolicy.defaultForFeature('leads.manage', 'admin_staff'), true);
  assert.equal(accessPolicy.defaultForFeature('leads.manage', 'doctor'), false);
  assert.equal(accessPolicy.defaultForFeature('consents.view', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('quickchat.read_patients', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('quickchat.read_team', 'agencia'), false);

  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('clinic.settings.view'), true);
  assert.equal(features.get('clinic.settings.view')?.kind, 'view');
  assert.equal(features.get('clinic.settings.view')?.enforcement_status, 'backend');
  for (const roleCode of ['propietario', 'doctor', 'assistant', 'reception', 'admin_staff']) {
    assert.equal(
      accessPolicy.defaultForFeature('clinic.settings.view', roleCode),
      true,
      `${roleCode} must be able to view its assigned clinic by default`,
    );
  }
  assert.equal(accessPolicy.defaultForFeature('clinic.settings.view', 'agencia'), false);
  // Compatibilidad: asignaciones antiguas cuyo rol aún no normaliza deben poder
  // leer los ajustes, pero nunca editarlos.
  assert.equal(accessPolicy.defaultForFeature('clinic.settings.view', 'unknown'), true);
  assert.equal(features.get('clinic.settings.edit')?.kind, 'action');
  assert.equal(features.get('clinic.settings.edit')?.enforcement_status, 'backend');
  assert.equal(accessPolicy.defaultForFeature('clinic.settings.edit', 'propietario'), true);
  assert.equal(accessPolicy.defaultForFeature('clinic.settings.edit', 'admin_staff'), true);
  assert.equal(accessPolicy.defaultForFeature('clinic.settings.edit', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('clinic.settings.edit', 'doctor'), false);
  assert.equal(accessPolicy.defaultForFeature('clinic.settings.edit', 'assistant'), false);
  assert.equal(accessPolicy.defaultForFeature('clinic.settings.edit', 'reception'), true);
  assert.equal(accessPolicy.defaultForFeature('clinic.settings.edit', 'unknown'), false);

  // PUBLIC_MEDIA reutiliza este permiso para review_team_photo: una agencia
  // asignada al scope debe seguir pudiendo gestionar la foto de resenas.
  assert.equal(accessPolicy.defaultForFeature('marketing', 'agencia'), true);

  const webPermissionMatrix = {
    'marketing.web.view': {
      propietario: true,
      agencia: true,
      doctor: false,
      assistant: true,
      reception: true,
      admin_staff: true,
      unknown: false,
    },
    'marketing.web.edit': {
      propietario: true,
      agencia: true,
      doctor: false,
      assistant: false,
      reception: true,
      admin_staff: true,
      unknown: false,
    },
    'marketing.web.advanced_edit': {
      propietario: true,
      agencia: true,
      doctor: false,
      assistant: false,
      reception: false,
      admin_staff: true,
      unknown: false,
    },
    'marketing.web.review': {
      propietario: true,
      agencia: true,
      doctor: false,
      assistant: false,
      reception: false,
      admin_staff: true,
      unknown: false,
    },
    'marketing.web.publish': {
      propietario: true,
      agencia: false,
      doctor: false,
      assistant: false,
      reception: false,
      admin_staff: true,
      unknown: false,
    },
    'marketing.web.domains.manage': {
      propietario: true,
      agencia: false,
      doctor: false,
      assistant: false,
      reception: false,
      admin_staff: true,
      unknown: false,
    },
    'marketing.web.templates.manage': {
      propietario: false,
      agencia: false,
      doctor: false,
      assistant: false,
      reception: false,
      admin_staff: false,
      unknown: false,
    },
  };
  for (const [featureKey, roleDefaults] of Object.entries(webPermissionMatrix)) {
    assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has(featureKey), true);
    assert.ok(features.has(featureKey), `${featureKey} must be present in the catalog`);
    assert.deepEqual(catalog.defaults[featureKey], roleDefaults);
  }
  assert.equal(features.get('marketing.web.view')?.enforcement_status, 'backend');
  assert.equal(features.get('marketing.web.edit')?.enforcement_status, 'backend');
  assert.equal(features.get('marketing.web.review')?.enforcement_status, 'backend');
  assert.equal(features.get('marketing.web.publish')?.enforcement_status, 'backend');
  assert.equal(features.get('marketing.web.domains.manage')?.enforcement_status, 'backend');
  assert.equal(features.get('marketing.web.templates.manage')?.enforcement_status, 'backend');

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
  assert.equal(accessPolicy.defaultForFeature('team.view', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('team.view', 'unknown'), false);

  assert.equal(features.get('team.manage')?.kind, 'action');
  assert.equal(features.get('team.manage')?.enforcement_status, 'partial');
  assert.equal(accessPolicy.defaultForFeature('team.manage', 'reception'), true);
  assert.equal(accessPolicy.defaultForFeature('team.manage', 'admin_staff'), true);

  assert.equal(accessPolicy.ALLOWED_FEATURE_KEYS.has('team.schedule.self.manage'), true);
  assert.equal(features.get('team.schedule.self.manage')?.kind, 'action');
  assert.equal(features.get('team.schedule.self.manage')?.enforcement_status, 'backend');
  assert.equal(accessPolicy.defaultForFeature('team.schedule.self.manage', 'agencia'), false);
  assert.equal(accessPolicy.defaultForFeature('team.schedule.self.manage', 'unknown'), false);
  for (const roleCode of ['propietario', 'doctor', 'assistant', 'reception', 'admin_staff']) {
    assert.equal(
      accessPolicy.defaultForFeature('team.schedule.self.manage', roleCode),
      true,
      `${roleCode} must retain explicit control over its own schedule`,
    );
  }

  assert.equal(features.get('quickchat.read_patients')?.kind, 'read');
  assert.equal(features.get('quickchat.read_patients')?.enforcement_status, 'backend');
  assert.equal(features.get('quickchat.read_team')?.kind, 'read');
  assert.equal(features.get('quickchat.read_team')?.enforcement_status, 'backend');
  assert.equal(features.get('quickchat.read_leads')?.kind, 'read');
  assert.equal(features.get('quickchat.read_leads')?.enforcement_status, 'backend');
  assert.equal(accessPolicy.defaultForFeature('quickchat.read_leads', 'agencia'), false);

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

  await testClinicSettingsAuthorizationMatrix();

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
