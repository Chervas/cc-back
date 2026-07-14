'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const clinicController = require('../../controllers/clinica.controller');
const especialidadesController = require('../../controllers/especialidades.controller');
const userClinicasRouter = require('../../routes/userclinicas.routes');
const {
  ACCESS_GUIDANCE_MAX_DIRECTIONS_LENGTH,
  filterClinicConfigurationForSettingsAccess,
  mergeClinicConfiguration,
  normalizeClinicConfigurationForRead,
} = require('../../lib/clinic-configuration');

const MEDIA_URL = 'https://media.clinicaclick.com/whatsapp/clinic-access/clinic-66/test.jpg';

function currentConfiguration() {
  return {
    disciplinas: ['capilar'],
    agenda_settings: {
      hideSaturdays: true,
      slotGranularityMin: 15,
    },
    future_server_key: {
      keep: true,
    },
  };
}

function testLegacyReadDefaultsWithoutMutatingSource() {
  const source = currentConfiguration();
  const normalized = normalizeClinicConfigurationForRead(source);
  assert.deepEqual(normalized.access_guidance, {
    enabled: false,
    directions: '',
    image_asset_id: null,
    image_url: null,
  });
  assert.equal(Object.hasOwn(source, 'access_guidance'), false);
}

function testSettingsViewDenialRedactsAccessGuidanceFromClinicList() {
  const source = {
    ...currentConfiguration(),
    access_guidance: {
      enabled: true,
      directions: 'Puerta lateral junto a la farmacia.',
      image_asset_id: 321,
      image_url: MEDIA_URL,
    },
  };
  const redacted = filterClinicConfigurationForSettingsAccess(source, false);
  assert.deepEqual(redacted, { disciplinas: ['capilar'] });
  assert.equal(Object.hasOwn(redacted, 'access_guidance'), false);
  assert.equal(Object.hasOwn(redacted, 'agenda_settings'), false);

  const visible = filterClinicConfigurationForSettingsAccess(source, true);
  assert.equal(visible.access_guidance.enabled, true);
  assert.deepEqual(visible.agenda_settings, source.agenda_settings);
}

function testUserSummaryDoesNotReExposeIncludedClinics() {
  const summary = userClinicasRouter._private.serializeUserSummary({
    id_usuario: 91,
    nombre: 'Usuario',
    apellidos: 'QA',
    email_usuario: 'qa@example.com',
    isAdmin: false,
    clinicas: [{
      id_clinica: 66,
      configuracion: { access_guidance: { directions: 'No debe filtrarse' } },
    }],
  });
  assert.equal(summary.id_usuario, 91);
  assert.equal(Object.hasOwn(summary, 'clinicas'), false);
  assert.doesNotMatch(JSON.stringify(summary), /access_guidance|No debe filtrarse/);
}

function testReadOnlyClinicResponseRedactsFiscalData() {
  const clinic = {
    id_clinica: 66,
    datos_fiscales_clinica: { nif: 'B12345678', razon_social: 'Privado SL' },
    configuracion: currentConfiguration(),
  };
  const readOnly = clinicController._private.normalizeClinicDataForResponse(clinic);
  assert.equal(Object.hasOwn(readOnly, 'datos_fiscales_clinica'), false);

  const editable = clinicController._private.normalizeClinicDataForResponse(clinic, {
    includeSensitive: true,
  });
  assert.deepEqual(editable.datos_fiscales_clinica, clinic.datos_fiscales_clinica);
}

function testPartialConfigurationPreservesEveryExistingKey() {
  const merged = mergeClinicConfiguration(currentConfiguration(), {
    disciplinas: ['capilar', 'estetica'],
  });
  assert.deepEqual(merged.disciplinas, ['capilar', 'estetica']);
  assert.deepEqual(merged.agenda_settings, {
    hideSaturdays: true,
    slotGranularityMin: 15,
  });
  assert.deepEqual(merged.future_server_key, { keep: true });
}

function testAccessGuidanceEnableAndDisablePreservesDraft() {
  const enabled = mergeClinicConfiguration(currentConfiguration(), {
    access_guidance: {
      enabled: true,
      directions: '  Entra por el pasaje lateral.  ',
      image_asset_id: 321,
      image_url: MEDIA_URL,
    },
  });
  assert.deepEqual(enabled.access_guidance, {
    enabled: true,
    directions: 'Entra por el pasaje lateral.',
    image_asset_id: 321,
    image_url: MEDIA_URL,
  });

  const disabled = mergeClinicConfiguration(enabled, {
    access_guidance: { enabled: false },
  });
  assert.deepEqual(disabled.access_guidance, {
    enabled: false,
    directions: 'Entra por el pasaje lateral.',
    image_asset_id: 321,
    image_url: MEDIA_URL,
  });
}

function testExplicitImageRemovalKeepsDirectionsWhileDisabled() {
  const current = mergeClinicConfiguration(currentConfiguration(), {
    access_guidance: {
      enabled: true,
      directions: 'Sube a la primera planta.',
      image_asset_id: 321,
      image_url: MEDIA_URL,
    },
  });
  const merged = mergeClinicConfiguration(current, {
    access_guidance: {
      enabled: false,
      image_asset_id: null,
      image_url: null,
    },
  });
  assert.equal(merged.access_guidance.enabled, false);
  assert.equal(merged.access_guidance.directions, 'Sube a la primera planta.');
  assert.equal(merged.access_guidance.image_asset_id, null);
  assert.equal(merged.access_guidance.image_url, null);
}

function testIndependentConcurrentPatchesComposeOnLatestState() {
  const accessPatch = {
    access_guidance: {
      enabled: true,
      directions: 'Puerta lateral.',
      image_asset_id: 321,
      image_url: MEDIA_URL,
    },
  };
  const concurrentPatch = {
    agenda_settings: { hideSundays: true },
    key_added_concurrently: { keep: 'yes' },
  };

  const accessThenConcurrent = mergeClinicConfiguration(
    mergeClinicConfiguration(currentConfiguration(), accessPatch),
    concurrentPatch,
  );
  const concurrentThenAccess = mergeClinicConfiguration(
    mergeClinicConfiguration(currentConfiguration(), concurrentPatch),
    accessPatch,
  );

  for (const result of [accessThenConcurrent, concurrentThenAccess]) {
    assert.equal(result.access_guidance.enabled, true);
    assert.equal(result.agenda_settings.hideSaturdays, true);
    assert.equal(result.agenda_settings.hideSundays, true);
    assert.deepEqual(result.key_added_concurrently, { keep: 'yes' });
    assert.deepEqual(result.future_server_key, { keep: true });
  }
}

function testValidationRejectsIncompleteOrOversizedConfiguration() {
  assert.throws(
    () => mergeClinicConfiguration(currentConfiguration(), {
      access_guidance: { enabled: true, directions: 'Solo texto' },
    }),
    /clinic_access_guidance_image_required/,
  );
  assert.throws(
    () => mergeClinicConfiguration(currentConfiguration(), {
      access_guidance: {
        enabled: true,
        directions: 'x'.repeat(ACCESS_GUIDANCE_MAX_DIRECTIONS_LENGTH + 1),
        image_asset_id: 321,
        image_url: MEDIA_URL,
      },
    }),
    /clinic_access_guidance_directions_too_long/,
  );
  assert.throws(
    () => mergeClinicConfiguration(currentConfiguration(), {
      access_guidance: {
        enabled: false,
        image_asset_id: 321,
        image_url: null,
      },
    }),
    /clinic_access_guidance_image_reference_incomplete/,
  );
  assert.throws(
    () => mergeClinicConfiguration(currentConfiguration(), {
      access_guidance: {
        enabled: false,
        unsupported_field: true,
      },
    }),
    /clinic_access_guidance_unknown_fields/,
  );
  assert.throws(
    () => mergeClinicConfiguration(currentConfiguration(), {
      access_guidance: {
        enabled: false,
        image_asset_id: '321-invalid',
        image_url: MEDIA_URL,
      },
    }),
    /clinic_access_guidance_image_asset_id_invalid/,
  );
}

function testControllerWiringUsesCapabilitiesAndRowLock() {
  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/clinica.controller.js'),
    'utf8',
  );
  const routesSource = fs.readFileSync(
    path.resolve(__dirname, '../../routes/clinica.routes.js'),
    'utf8',
  );
  const specialtiesSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/especialidades.controller.js'),
    'utf8',
  );
  const specialtiesRoutesSource = fs.readFileSync(
    path.resolve(__dirname, '../../routes/especialidades.routes.js'),
    'utf8',
  );
  const updateStart = controllerSource.indexOf('exports.updateClinica =');
  const updateEnd = controllerSource.indexOf('// Eliminar una clínica', updateStart);
  const updateSource = controllerSource.slice(updateStart, updateEnd);

  assert.match(updateSource, /CLINIC_EDIT_FEATURE/);
  assert.match(updateSource, /Clinica\.sequelize\.transaction/);
  assert.match(updateSource, /lock:\s*transaction\.LOCK\.UPDATE/);
  assert.match(updateSource, /mergeClinicConfiguration/);
  assert.match(updateSource, /assertAccessGuidanceAsset/);
  assert.match(controllerSource, /exports\.createClinica[\s\S]*?isGlobalAdmin\(req\.userData\?\.userId\)/);
  assert.match(controllerSource, /exports\.deleteClinica[\s\S]*?Solo un administrador global puede eliminar clínicas/);
  assert.match(routesSource, /router\.get\('\/'\s*,\s*authMiddleware/);
  assert.match(routesSource, /router\.get\('\/:id'\s*,\s*authMiddleware/);
  assert.match(routesSource, /router\.patch\('\/:id'\s*,\s*authMiddleware/);
  assert.match(routesSource, /router\.get\('\/:id_clinica\/servicios'\s*,\s*clinicaController/);
  assert.match(specialtiesSource, /Clinica\.sequelize\.transaction/);
  assert.match(specialtiesSource, /lock:\s*transaction\.LOCK\.UPDATE/);
  assert.match(specialtiesSource, /mergeClinicConfiguration\(currentConfig/);
  assert.match(specialtiesSource, /clinic\.settings\.edit/);
  assert.match(specialtiesRoutesSource, /router\.post\('\/clinica'\s*,\s*authMiddleware/);
  assert.match(specialtiesRoutesSource, /router\.post\('\/clinica\/sistema'\s*,\s*authMiddleware/);
}

async function testGroupAssignmentRequiresOwnershipOfWholeTargetGroup() {
  const originals = {
    groupFindByPk: db.GrupoClinica.findByPk,
    clinicFindAll: db.Clinica.findAll,
    userClinicFindAll: db.UsuarioClinica.findAll,
  };
  db.GrupoClinica.findByPk = async () => ({ id_grupo: 29 });
  db.Clinica.findAll = async () => [{ id_clinica: 66 }, { id_clinica: 67 }];

  try {
    db.UsuarioClinica.findAll = async () => [
      { id_clinica: 66 },
      { id_clinica: 67 },
    ];
    await clinicController._private.assertUserCanAssignClinicToGroup(99001, 29);

    db.UsuarioClinica.findAll = async () => [{ id_clinica: 66 }];
    await assert.rejects(
      () => clinicController._private.assertUserCanAssignClinicToGroup(99001, 29),
      /clinic_group_assignment_scope_forbidden/
    );
  } finally {
    db.GrupoClinica.findByPk = originals.groupFindByPk;
    db.Clinica.findAll = originals.clinicFindAll;
    db.UsuarioClinica.findAll = originals.userClinicFindAll;
  }
}

async function testGroupTransitionRequiresAuthorityOverOriginAndTarget() {
  const originals = {
    groupFindByPk: db.GrupoClinica.findByPk,
    clinicFindAll: db.Clinica.findAll,
    userClinicFindAll: db.UsuarioClinica.findAll,
  };
  const visited = [];
  let currentGroupId = null;
  db.GrupoClinica.findByPk = async (groupId) => {
    currentGroupId = Number(groupId);
    visited.push(currentGroupId);
    return { id_grupo: currentGroupId };
  };
  db.Clinica.findAll = async () => [{ id_clinica: currentGroupId }];
  db.UsuarioClinica.findAll = async () => [{ id_clinica: currentGroupId }];

  try {
    await clinicController._private.assertUserCanChangeClinicGroup(99001, 29, 30);
    assert.deepEqual(visited, [29, 30]);
    visited.length = 0;
    await clinicController._private.assertUserCanChangeClinicGroup(99001, 29, null);
    assert.deepEqual(visited, [29]);
  } finally {
    db.GrupoClinica.findByPk = originals.groupFindByPk;
    db.Clinica.findAll = originals.clinicFindAll;
    db.UsuarioClinica.findAll = originals.userClinicFindAll;
  }
}

async function testSpecialtyWriterUsesLatestLockedConfiguration() {
  const originals = {
    findByPk: db.Clinica.findByPk,
    transaction: db.Clinica.sequelize.transaction,
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  let persisted = {
    ...currentConfiguration(),
    access_guidance: {
      enabled: true,
      directions: 'Entrada por el pasaje.',
      image_asset_id: 321,
      image_url: MEDIA_URL,
    },
    key_added_concurrently: { keep: 'latest' },
  };
  let lockSeen = false;

  db.Clinica.sequelize.transaction = async (callback) => callback(transaction);
  db.Clinica.findByPk = async (_clinicId, options) => {
    lockSeen = options?.transaction === transaction && options?.lock === 'UPDATE';
    return {
      configuracion: persisted,
      update: async (values, updateOptions) => {
        assert.equal(updateOptions.transaction, transaction);
        persisted = values.configuracion;
      },
    };
  };

  try {
    const disciplinas = await especialidadesController._private.ensureDisciplinaEnClinica(66, 'estetica');
    assert.equal(lockSeen, true);
    assert.deepEqual(disciplinas, ['capilar', 'estetica']);
    assert.equal(persisted.access_guidance.enabled, true);
    assert.deepEqual(persisted.agenda_settings, currentConfiguration().agenda_settings);
    assert.deepEqual(persisted.key_added_concurrently, { keep: 'latest' });
  } finally {
    db.Clinica.findByPk = originals.findByPk;
    db.Clinica.sequelize.transaction = originals.transaction;
  }
}

async function testPatchControllerPersistsMergedConfigurationUnderRowLock() {
  const originals = {
    accessOverrideFindAll: db.AccessPolicyOverride.findAll,
    clinicFindByPk: db.Clinica.findByPk,
    clinicMetaAssetFindOne: db.ClinicMetaAsset.findOne,
    publicMediaFindOne: db.PublicMediaAsset.findOne,
    transaction: db.Clinica.sequelize.transaction,
    userClinicFindOne: db.UsuarioClinica.findOne,
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  let persisted = currentConfiguration();
  let rowLockSeen = false;
  let assetScopeSeen = false;

  db.UsuarioClinica.findOne = async () => ({
    rol_clinica: 'propietario',
    subrol_clinica: null,
  });
  db.AccessPolicyOverride.findAll = async () => [];
  db.ClinicMetaAsset.findOne = async () => null;
  db.PublicMediaAsset.findOne = async ({ where, transaction: queryTransaction }) => {
    assetScopeSeen = queryTransaction === transaction
      && where.id === 321
      && where.clinica_id === 66
      && where.purpose === 'clinic_access_image';
    return { id: 321, public_url: MEDIA_URL };
  };
  db.Clinica.sequelize.transaction = async (callback) => callback(transaction);
  db.Clinica.findByPk = async (clinicId, options = {}) => {
    assert.equal(Number(clinicId), 66);
    if (options.raw) {
      return { id_clinica: 66, grupoClinicaId: 29 };
    }
    if (options.transaction) {
      rowLockSeen = options.transaction === transaction && options.lock === 'UPDATE';
      return {
        configuracion: persisted,
        grupoClinicaId: 29,
        update: async (values, updateOptions) => {
          assert.equal(updateOptions.transaction, transaction);
          persisted = values.configuracion;
        },
      };
    }
    return {
      id_clinica: 66,
      grupoClinicaId: 29,
      toJSON: () => ({
        id_clinica: 66,
        grupoClinicaId: 29,
        configuracion: persisted,
      }),
    };
  };

  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };

  try {
    await clinicController.updateClinica({
      params: { id: '66' },
      body: {
        configuracion: {
          access_guidance: {
            enabled: true,
            directions: 'Entra por el pasaje lateral.',
            image_asset_id: 321,
            image_url: MEDIA_URL,
          },
        },
      },
      userData: { userId: 99001 },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(rowLockSeen, true);
    assert.equal(assetScopeSeen, true);
    assert.deepEqual(persisted.agenda_settings, {
      hideSaturdays: true,
      slotGranularityMin: 15,
    });
    assert.deepEqual(persisted.disciplinas, ['capilar']);
    assert.deepEqual(persisted.future_server_key, { keep: true });
    assert.equal(persisted.access_guidance.enabled, true);
  } finally {
    db.AccessPolicyOverride.findAll = originals.accessOverrideFindAll;
    db.Clinica.findByPk = originals.clinicFindByPk;
    db.ClinicMetaAsset.findOne = originals.clinicMetaAssetFindOne;
    db.PublicMediaAsset.findOne = originals.publicMediaFindOne;
    db.Clinica.sequelize.transaction = originals.transaction;
    db.UsuarioClinica.findOne = originals.userClinicFindOne;
  }
}

async function run() {
  testLegacyReadDefaultsWithoutMutatingSource();
  testSettingsViewDenialRedactsAccessGuidanceFromClinicList();
  testUserSummaryDoesNotReExposeIncludedClinics();
  testReadOnlyClinicResponseRedactsFiscalData();
  testPartialConfigurationPreservesEveryExistingKey();
  testAccessGuidanceEnableAndDisablePreservesDraft();
  testExplicitImageRemovalKeepsDirectionsWhileDisabled();
  testIndependentConcurrentPatchesComposeOnLatestState();
  testValidationRejectsIncompleteOrOversizedConfiguration();
  testControllerWiringUsesCapabilitiesAndRowLock();
  await testSpecialtyWriterUsesLatestLockedConfiguration();
  await testGroupAssignmentRequiresOwnershipOfWholeTargetGroup();
  await testGroupTransitionRequiresAuthorityOverOriginAndTarget();
  await testPatchControllerPersistsMergedConfigurationUnderRowLock();
  console.log('clinic_access_configuration.test.js: OK');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
