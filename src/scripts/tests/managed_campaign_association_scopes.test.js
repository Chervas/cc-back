'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';
const db = require('../../../models');
const associationScopes = require('../../services/managedCampaignAssociationScopes.service');

function fixtures() {
  return {
    groups: [
      { id_grupo: 5, nombre_grupo: 'Clínicas Propdental', accessToken: 'GROUP_SECRET' },
      { id_grupo: 28, nombre_grupo: 'Clínica Arriaga' },
    ],
    clinics: [
      { id_clinica: 36, nombre_clinica: 'Propdental Francia', grupoClinicaId: 5, estado_clinica: true },
      { id_clinica: 60, nombre_clinica: 'Clinic test', grupoClinicaId: 5, estado_clinica: true },
      { id_clinica: 61, nombre_clinica: 'Estado desconocido', grupoClinicaId: 5, estado_clinica: null },
      { id_clinica: 74, nombre_clinica: 'Clínica Arriaga', grupoClinicaId: 28, estado_clinica: true },
    ],
    googleAccounts: [
      {
        clinicaId: 36,
        grupoClinicaId: 5,
        assignmentScope: 'group',
        googleConnectionId: 23,
        customerId: '185-121-5478',
        descriptiveName: 'Dental - Parallel Campaign',
        isActive: true,
        accessToken: 'GOOGLE_ACCESS_SECRET',
        refreshToken: 'GOOGLE_REFRESH_SECRET',
        loginCustomerId: '2863224233',
      },
      {
        clinicaId: 36,
        grupoClinicaId: 5,
        assignmentScope: 'clinic',
        googleConnectionId: 23,
        customerId: '1851215478',
        descriptiveName: 'Duplicada por clínica',
        isActive: true,
      },
      {
        clinicaId: 36,
        grupoClinicaId: 5,
        assignmentScope: 'group',
        googleConnectionId: 24,
        customerId: '9999999999',
        descriptiveName: 'Necesita reautorización',
        isActive: true,
      },
      {
        clinicaId: 36,
        grupoClinicaId: 5,
        assignmentScope: 'group',
        googleConnectionId: 25,
        customerId: '7777777777',
        descriptiveName: 'Inactiva',
        isActive: false,
      },
      {
        clinicaId: 36,
        grupoClinicaId: 5,
        assignmentScope: 'group',
        googleConnectionId: 27,
        customerId: '6666666666',
        descriptiveName: 'Revocada',
        isActive: true,
      },
      {
        clinicaId: 74,
        grupoClinicaId: 28,
        assignmentScope: 'group',
        googleConnectionId: 26,
        customerId: '8494168589',
        descriptiveName: 'CLÍNICA ARRIAGA SLP',
        isActive: true,
      },
    ],
    metaAssets: [
      {
        clinicaId: 36,
        grupoClinicaId: 5,
        assignmentScope: 'clinic',
        metaConnectionId: 158,
        assetType: 'ad_account',
        metaAssetId: 'act_1486528992022670',
        metaAssetName: 'PC - Propdental Francia',
        isActive: true,
        pageAccessToken: 'META_PAGE_SECRET',
        waAccessToken: 'META_WA_SECRET',
        additionalData: { secret: 'META_ADDITIONAL_SECRET' },
      },
      {
        clinicaId: 36,
        grupoClinicaId: 5,
        assignmentScope: 'unassigned',
        metaConnectionId: 158,
        assetType: 'ad_account',
        metaAssetId: 'act_111111111111111',
        metaAssetName: 'Residual sin scope',
        isActive: true,
      },
      {
        clinicaId: 36,
        grupoClinicaId: 5,
        assignmentScope: 'clinic',
        metaConnectionId: 158,
        assetType: 'facebook_page',
        metaAssetId: '123456',
        metaAssetName: 'No es ad account',
        isActive: true,
      },
    ],
    googleAssignments: [
      { assignmentScope: 'group', grupoClinicaId: 5, googleConnectionId: 23, status: 'active' },
      { assignmentScope: 'group', grupoClinicaId: 5, googleConnectionId: 24, status: 'reauthorization_required' },
      { assignmentScope: 'group', grupoClinicaId: 5, googleConnectionId: 25, status: 'active' },
      { assignmentScope: 'group', grupoClinicaId: 5, googleConnectionId: 27, status: 'revoked' },
      { assignmentScope: 'group', grupoClinicaId: 28, googleConnectionId: 26, status: 'active' },
    ],
    metaAssignments: [
      { assignmentScope: 'group', grupoClinicaId: 5, metaConnectionId: 158, status: 'active' },
    ],
  };
}

function testWhitelistedOptionsAndScopeResolution() {
  const groups = associationScopes.buildAssociationOptions(fixtures());
  assert.equal(groups.length, 2);
  const propdental = groups.find((group) => group.group_id === 5);
  assert.ok(propdental);
  assert.equal(propdental.eligible_clinic_count, 1, 'Test clinics must not make the matching scope eligible');
  assert.deepEqual(propdental.accounts.map((account) => account.account_id), [
    '1851215478',
    '9999999999',
    '1486528992022670',
  ]);

  const google = propdental.accounts.find((account) => account.account_id === '1851215478');
  assert.deepEqual(google, {
    provider: 'google_ads',
    account_id: '1851215478',
    display_id: '185-121-5478',
    account_name: 'Dental - Parallel Campaign',
    assignment_origin: 'group',
    authorization_status: 'active',
    selectable: true,
  });
  const reauthorization = propdental.accounts.find((account) => account.account_id === '9999999999');
  assert.equal(reauthorization.authorization_status, 'reauthorization_required');
  assert.equal(reauthorization.selectable, false);
  const meta = propdental.accounts.find((account) => account.provider === 'meta_ads');
  assert.equal(meta.display_id, 'act_1486528992022670');
  assert.equal(meta.assignment_origin, 'clinic');
  assert.equal(meta.selectable, true);
  assert.equal(propdental.accounts.some((account) => account.account_id === '111111111111111'), false,
    'An unassigned Meta asset must never inherit a residual clinic scope');
  assert.equal(propdental.accounts.some((account) => account.account_id === '7777777777'), false);
  assert.equal(propdental.accounts.some((account) => account.account_id === '6666666666'), false);

  const serialized = JSON.stringify(groups);
  for (const forbidden of [
    'GROUP_SECRET', 'GOOGLE_ACCESS_SECRET', 'GOOGLE_REFRESH_SECRET', '2863224233',
    'META_PAGE_SECRET', 'META_WA_SECRET', 'META_ADDITIONAL_SECRET',
    'accessToken', 'refreshToken', 'pageAccessToken', 'waAccessToken',
    'additionalData', 'connection_id', 'login_customer_id',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `Options DTO leaked ${forbidden}`);
  }

  assert.ok(associationScopes.findAssociationAccountInOptions(groups, {
    groupId: 5,
    provider: 'google_ads',
    accountId: '185-121-5478',
  }));
  assert.equal(associationScopes.findAssociationAccountInOptions(groups, {
    groupId: 28,
    provider: 'google_ads',
    accountId: '1851215478',
  }), null, 'An account must not be accepted for a different group');
  assert.equal(associationScopes.findAssociationAccountInOptions(groups, {
    groupId: 5,
    provider: 'google_ads',
    accountId: '9999999999',
  }), null, 'A connection awaiting reauthorization must not be selectable');
}

function testUnknownClinicStatusIsNeverEligible() {
  const source = fixtures();
  source.clinics = [{
    id_clinica: 61,
    nombre_clinica: 'Estado desconocido',
    grupoClinicaId: 5,
    estado_clinica: null,
  }];
  assert.deepEqual(associationScopes.buildAssociationOptions(source), [],
    'A null clinic status must fail closed and never become a matching target');
}

function testAssignmentGroupBoundary() {
  const groupClinicIds = new Set([36, 58]);
  const eligibleTargetClinicIds = new Set([36]);
  assert.equal(eligibleTargetClinicIds.has(58), false);
  assert.equal(associationScopes.assignmentBelongsToGroup({
    grupo_clinica_id: 5,
    clinica_id: 36,
  }, 5, groupClinicIds), true);
  assert.equal(associationScopes.assignmentBelongsToGroup({
    grupo_clinica_id: 28,
    clinica_id: 74,
  }, 5, groupClinicIds), false);
  assert.equal(associationScopes.assignmentBelongsToGroup({
    grupo_clinica_id: 5,
    clinica_id: 74,
  }, 5, groupClinicIds), false, 'A contradictory clinic/group row must not cross the clinic boundary');
  assert.equal(associationScopes.assignmentBelongsToGroup({
    grupo_clinica_id: null,
    clinica_id: 36,
  }, 5, groupClinicIds), true,
    'Legacy rows may use any clinic that still belongs to the group, even when it is no longer an eligible target');
  assert.equal(associationScopes.assignmentBelongsToGroup({
    grupo_clinica_id: null,
    clinica_id: 74,
  }, 5, groupClinicIds), false);
}

async function testAssignmentSaveBoundary() {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const values = {
    provider: 'google_ads',
    customer_id: '1851215478',
    campaign_id: '21800484692',
    grupo_clinica_id: 5,
    clinica_id: 58,
    status: 'active',
  };
  const updates = [];
  const existing = {
    grupo_clinica_id: 5,
    clinica_id: 58,
    async update(payload, options) {
      updates.push({ payload, options });
      return this;
    },
  };
  const updated = await associationScopes.saveAssignmentWithinScope({
    assignmentModel: {
      findOne: async (options) => {
        assert.equal(options.lock, 'UPDATE');
        return existing;
      },
      create: async () => { throw new Error('Existing assignments must update, not create'); },
    },
    values,
    groupId: 5,
    groupClinicIds: new Set([58]),
    transaction,
  });
  assert.equal(updated, existing);
  assert.equal(updates.length, 1);

  let crossCreateCalls = 0;
  await assert.rejects(() => associationScopes.saveAssignmentWithinScope({
    assignmentModel: {
      findOne: async () => ({ grupo_clinica_id: 28, clinica_id: 74 }),
      create: async () => { crossCreateCalls += 1; },
    },
    values,
    groupId: 5,
    groupClinicIds: new Set([58]),
    transaction,
  }), (error) => error.code === 'matching_assignment_scope_conflict' && error.httpStatus === 409);
  assert.equal(crossCreateCalls, 0, 'A cross-group existing row must fail before any write');

  const created = { ...values, id: 99 };
  assert.equal(await associationScopes.saveAssignmentWithinScope({
    assignmentModel: {
      findOne: async () => null,
      create: async (payload, options) => {
        assert.equal(options.transaction, transaction);
        assert.deepEqual(payload, values);
        return created;
      },
    },
    values,
    groupId: 5,
    groupClinicIds: new Set([58]),
    transaction,
  }), created);

  let raceReads = 0;
  await assert.rejects(() => associationScopes.saveAssignmentWithinScope({
    assignmentModel: {
      findOne: async () => {
        raceReads += 1;
        return raceReads === 1 ? null : { grupo_clinica_id: 28, clinica_id: 74 };
      },
      create: async () => {
        const duplicate = new Error('duplicate');
        duplicate.name = 'SequelizeUniqueConstraintError';
        throw duplicate;
      },
    },
    values,
    groupId: 5,
    groupClinicIds: new Set([58]),
    transaction,
  }), (error) => error.code === 'matching_assignment_scope_conflict');
  assert.equal(raceReads, 2, 'A unique race must be reloaded under lock before deciding');
}

async function testInventoryWriteBoundary() {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const sequelize = { transaction: async (callback) => callback(transaction) };
  const rows = [
    { provider: 'google_ads', customer_id: '1851215478', campaign_id: '1' },
    { provider: 'google_ads', customer_id: '1851215478', campaign_id: '2' },
  ];
  const writes = [];
  let scopeChecks = 0;
  const saved = await associationScopes.upsertInventoryWithinScope({
    groupId: 5,
    provider: 'google_ads',
    accountId: '1851215478',
    rows,
    sequelize,
    inventoryModel: {
      async upsert(row, options) {
        writes.push({ row, options });
      },
    },
    accountScopeResolver: async (options) => {
      scopeChecks += 1;
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, true);
      return { account: { account_id: '1851215478' } };
    },
  });
  assert.equal(saved, 2);
  assert.equal(scopeChecks, 1, 'The batch scope must be revalidated once inside its transaction');
  assert.equal(writes.length, 2);
  assert.equal(writes.every((write) => write.options.transaction === transaction), true);

  let forbiddenWrites = 0;
  await assert.rejects(() => associationScopes.upsertInventoryWithinScope({
    groupId: 5,
    provider: 'google_ads',
    accountId: '1851215478',
    rows,
    sequelize,
    inventoryModel: {
      async upsert() {
        forbiddenWrites += 1;
      },
    },
    accountScopeResolver: async (options) => {
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, true);
      return null;
    },
  }), (error) => error.code === 'matching_account_scope_forbidden' && error.httpStatus === 403);
  assert.equal(forbiddenWrites, 0, 'A revoked scope must abort the entire inventory batch before the first write');
}

async function testDbLoaderUsesExplicitAttributes() {
  const data = fixtures();
  const calls = [];
  const model = (name, rows) => ({
    async findAll(options) {
      calls.push({ name, options });
      return rows;
    },
  });
  const models = {
    Clinica: model('Clinica', data.clinics),
    GrupoClinica: model('GrupoClinica', data.groups),
    ClinicGoogleAdsAccount: model('ClinicGoogleAdsAccount', data.googleAccounts),
    ClinicMetaAsset: model('ClinicMetaAsset', data.metaAssets),
    GoogleConnectionAssignment: model('GoogleConnectionAssignment', data.googleAssignments),
    MetaConnectionAssignment: model('MetaConnectionAssignment', data.metaAssignments),
  };
  const groups = await associationScopes.listAssociationOptions({ groupIds: [5, 28], models });
  assert.equal(groups.length, 2);
  assert.ok(await associationScopes.findAssociationAccountScope({
    groupId: 5,
    provider: 'google_ads',
    accountId: '1851215478',
    models,
  }));
  assert.equal(await associationScopes.findAssociationAccountScope({
    groupId: 5,
    provider: 'google_ads',
    accountId: '8494168589',
    models,
  }), null, 'The DB-backed guard must reject an account mapped to another group');
  const callCountBeforeLock = calls.length;
  assert.ok(await associationScopes.findAssociationAccountScope({
    groupId: 5,
    provider: 'google_ads',
    accountId: '1851215478',
    transaction: { LOCK: { UPDATE: 'UPDATE' } },
    lock: true,
    models,
  }));
  const lockedCalls = calls.slice(callCountBeforeLock);
  assert.ok(lockedCalls.length >= 6);
  assert.equal(lockedCalls.every((call) => call.options.lock === 'UPDATE'), true,
    'Clinics, groups, mappings and authorization assignments must be locked during write revalidation');
  for (const call of calls) {
    assert.ok(Array.isArray(call.options.attributes), `${call.name} must use an explicit attribute allowlist`);
    for (const forbidden of [
      'accessToken', 'refreshToken', 'pageAccessToken', 'waAccessToken',
      'additionalData', 'authorizedByEmail', 'lastErrorMessage',
    ]) {
      assert.equal(call.options.attributes.includes(forbidden), false, `${call.name} queried ${forbidden}`);
    }
  }
}

function testRouteAndControllerContract() {
  const routeSource = fs.readFileSync(
    path.resolve(__dirname, '../../routes/adminManagedCampaigns.routes.js'),
    'utf8'
  );
  const optionsRoute = routeSource.indexOf("router.get('/matching/options'");
  const dynamicRoute = routeSource.indexOf("router.get('/:id'");
  assert.ok(optionsRoute >= 0 && optionsRoute < dynamicRoute);

  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/adminManagedCampaigns.controller.js'),
    'utf8'
  );
  const sections = [
    ['exports.listMatchingProposals', 'exports.confirmMatching'],
    ['exports.confirmMatching', 'exports.archiveMatching'],
    ['exports.listExternalInventory', 'exports.upsertExternalInventory'],
  ];
  for (const [startToken, endToken] of sections) {
    const start = controllerSource.indexOf(startToken);
    const end = controllerSource.indexOf(endToken, start + startToken.length);
    assert.ok(start >= 0 && end > start, `Missing controller section ${startToken}`);
    assert.match(controllerSource.slice(start, end), /requireAssociationAccountScope/,
      `${startToken} must validate provider account scope server-side`);
  }
  const confirmStart = controllerSource.indexOf('exports.confirmMatching');
  const archiveStart = controllerSource.indexOf('exports.archiveMatching');
  const confirmSource = controllerSource.slice(confirmStart, archiveStart);
  assert.match(confirmSource, /findAssociationAccountScope\([\s\S]*transaction,[\s\S]*lock: true/,
    'Confirm must revalidate and lock provider-account authorization inside its transaction');
  assert.match(confirmSource, /Clinica\.findAll\([\s\S]*transaction,[\s\S]*lock: transaction\.LOCK\.UPDATE/,
    'Confirm must re-read and lock eligible clinics inside the same transaction');
  assert.doesNotMatch(confirmSource, /ExternalCampaignAssignment\.upsert/,
    'A provider campaign must not be moved by a cross-scope ON DUPLICATE UPDATE race');
  assert.match(confirmSource, /saveAssignmentWithinScope/);

  const archiveHelperStart = controllerSource.indexOf('async function archiveMatchingAssignment');
  const archiveHelperEnd = controllerSource.indexOf('function explicitTrue', archiveHelperStart);
  const archiveHelperSource = controllerSource.slice(archiveHelperStart, archiveHelperEnd);
  assert.match(archiveHelperSource, /clinicModel\.findAll\([\s\S]*transaction,[\s\S]*lock: transaction\.LOCK\.UPDATE/);
  assert.match(archiveHelperSource, /accountScopeResolver\([\s\S]*transaction,[\s\S]*lock: true/);
  assert.match(archiveHelperSource, /assignmentModel\.findOne\([\s\S]*lock: transaction\.LOCK\.UPDATE/);

  const inventoryUpsertStart = controllerSource.indexOf('exports.upsertExternalInventory');
  const inventoryUpsertEnd = controllerSource.indexOf('// Funciones puras', inventoryUpsertStart);
  const inventoryUpsertSource = controllerSource.slice(inventoryUpsertStart, inventoryUpsertEnd);
  assert.match(inventoryUpsertSource, /upsertInventoryWithinScope/);
  assert.doesNotMatch(inventoryUpsertSource, /ExternalCampaignInventory\.upsert/,
    'Inventory mutations must stay inside the locked service transaction');

  const serviceSource = fs.readFileSync(
    path.resolve(__dirname, '../../services/managedCampaignAssociationScopes.service.js'),
    'utf8'
  );
  assert.doesNotMatch(serviceSource, /axios|\bfetch\s*\(|googleAdsRequest|metaGet|accessToken|refreshToken|pageAccessToken|waAccessToken/,
    'Association options must be DB-local and must not query or serialize provider credentials');
  assert.match(serviceSource, /lock: transaction\.LOCK\.UPDATE/);
  assert.match(serviceSource, /matching_assignment_scope_conflict/);
  assert.match(serviceSource, /assignmentModel\.create/);
  assert.doesNotMatch(serviceSource, /assignmentModel\.upsert/);
  assert.match(serviceSource, /upsertInventoryWithinScope[\s\S]*accountScopeResolver\([\s\S]*transaction,[\s\S]*lock: true/);
  assert.match(serviceSource, /inventoryModel\.upsert\(row, \{ transaction \}\)/);
}

async function run() {
  testWhitelistedOptionsAndScopeResolution();
  testUnknownClinicStatusIsNeverEligible();
  testAssignmentGroupBoundary();
  await testAssignmentSaveBoundary();
  await testInventoryWriteBoundary();
  await testDbLoaderUsesExplicitAttributes();
  testRouteAndControllerContract();
  console.log('managed_campaign_association_scopes.test.js OK');
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
