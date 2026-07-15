'use strict';

const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const db = require('../../../models');
const {
  buildConnectionResolutionPlan,
  buildSharedConnectionScope,
  resolveGoogleConnectionForScope,
  resolveMetaConnectionForScope,
} = require('../../services/scopeConnectionResolver.service');

function statusesFromWhere(where) {
  return where?.status?.[Op.in] || [];
}

async function withGoogleResolverStubs(run) {
  const originals = {
    clinicFindByPk: db.Clinica.findByPk,
    assignmentFindOne: db.GoogleConnectionAssignment.findOne,
    assignmentCreate: db.GoogleConnectionAssignment.create,
    adsFindAll: db.ClinicGoogleAdsAccount.findAll,
    webFindAll: db.ClinicWebAsset.findAll,
    analyticsFindAll: db.ClinicAnalyticsProperty.findAll,
    localFindAll: db.ClinicBusinessLocation.findAll,
    connectionFindOne: db.GoogleConnection.findOne,
    connectionFindAll: db.GoogleConnection.findAll,
    connectionFindByPk: db.GoogleConnection.findByPk,
  };
  try {
    await run();
  } finally {
    db.Clinica.findByPk = originals.clinicFindByPk;
    db.GoogleConnectionAssignment.findOne = originals.assignmentFindOne;
    db.GoogleConnectionAssignment.create = originals.assignmentCreate;
    db.ClinicGoogleAdsAccount.findAll = originals.adsFindAll;
    db.ClinicWebAsset.findAll = originals.webFindAll;
    db.ClinicAnalyticsProperty.findAll = originals.analyticsFindAll;
    db.ClinicBusinessLocation.findAll = originals.localFindAll;
    db.GoogleConnection.findOne = originals.connectionFindOne;
    db.GoogleConnection.findAll = originals.connectionFindAll;
    db.GoogleConnection.findByPk = originals.connectionFindByPk;
  }
}

function testExplicitScopePlanning() {
  const clinicRequest = { clinicId: 55, groupId: 9, assignmentScope: 'clinic' };
  assert.equal(buildSharedConnectionScope(clinicRequest).scopeKey, 'clinic:55');
  assert.deepEqual(
    buildConnectionResolutionPlan(clinicRequest).map((scope) => scope.scopeKey),
    ['clinic:55', 'group:9'],
    'clinic scope must prefer its override and inherit the group only as fallback'
  );

  const groupRequest = { clinicId: 55, groupId: 9, assignmentScope: 'group' };
  assert.equal(buildSharedConnectionScope(groupRequest).scopeKey, 'group:9');
  assert.deepEqual(
    buildConnectionResolutionPlan(groupRequest).map((scope) => scope.scopeKey),
    ['group:9'],
    'explicit group scope must never inspect a clinic assignment'
  );
}

async function testClinicOverrideBeforeGroupFallback() {
  await withGoogleResolverStubs(async () => {
    db.Clinica.findByPk = async () => ({ id_clinica: 55, grupoClinicaId: 9 });
    const lookedUp = [];
    db.GoogleConnectionAssignment.findOne = async ({ where }) => {
      lookedUp.push(`${where.scopeKey}:${statusesFromWhere(where).join(',')}`);
      if (!statusesFromWhere(where).includes('active')) return null;
      if (where.scopeKey === 'clinic:55') {
        return { googleConnection: { id: 101 }, scopeKey: 'clinic:55' };
      }
      if (where.scopeKey === 'group:9') {
        return { googleConnection: { id: 202 }, scopeKey: 'group:9' };
      }
      return null;
    };

    const result = await resolveGoogleConnectionForScope({
      userId: 7,
      clinicIdRaw: 55,
      assignmentScopeRaw: 'clinic',
      allowLegacyUserFallback: false,
    });
    assert.equal(result.connection.id, 101);
    assert.equal(result.scope.scopeKey, 'clinic:55');
    assert.deepEqual(lookedUp, ['clinic:55:active,reauthorization_required']);
  });
}

async function testGroupFallbackAndExplicitGroupIsolation() {
  await withGoogleResolverStubs(async () => {
    db.Clinica.findByPk = async () => ({ id_clinica: 55, grupoClinicaId: 9 });
    const lookedUp = [];
    db.GoogleConnectionAssignment.findOne = async ({ where }) => {
      lookedUp.push(where.scopeKey);
      if (where.scopeKey === 'group:9' && statusesFromWhere(where).includes('active')) {
        return { googleConnection: { id: 202 }, scopeKey: 'group:9' };
      }
      return null;
    };

    const inherited = await resolveGoogleConnectionForScope({
      userId: 7,
      clinicIdRaw: 55,
      assignmentScopeRaw: 'clinic',
      allowLegacyUserFallback: false,
    });
    assert.equal(inherited.connection.id, 202);
    assert.equal(inherited.scope.scopeKey, 'clinic:55');
    assert.equal(inherited.source, 'scope_assignment_group_fallback');
    assert.deepEqual(lookedUp, ['clinic:55', 'clinic:55', 'group:9']);

    lookedUp.length = 0;
    const explicitGroup = await resolveGoogleConnectionForScope({
      userId: 7,
      clinicIdRaw: 55,
      groupIdRaw: 9,
      assignmentScopeRaw: 'group',
      allowLegacyUserFallback: false,
    });
    assert.equal(explicitGroup.connection.id, 202);
    assert.deepEqual(lookedUp, ['group:9']);
  });
}

async function testResolverNeverPersistsLegacyAssignments() {
  await withGoogleResolverStubs(async () => {
    db.Clinica.findByPk = async () => ({ id_clinica: 55, grupoClinicaId: 9 });
    db.GoogleConnectionAssignment.findOne = async () => null;
    let writes = 0;
    db.GoogleConnectionAssignment.create = async () => { writes += 1; };
    db.ClinicGoogleAdsAccount.findAll = async () => [];
    db.ClinicWebAsset.findAll = async () => [{ googleConnectionId: 303 }];
    db.ClinicAnalyticsProperty.findAll = async () => [];
    db.ClinicBusinessLocation.findAll = async () => [];
    db.GoogleConnection.findOne = async () => null;
    db.GoogleConnection.findByPk = async (id) => ({ id });

    const result = await resolveGoogleConnectionForScope({
      userId: 7,
      clinicIdRaw: 55,
      assignmentScopeRaw: 'clinic',
      allowLegacyUserFallback: false,
      persistAssignments: true,
    });
    assert.equal(result.connection.id, 303);
    assert.equal(result.assignment, null);
    assert.equal(writes, 0, 'resolving a connection must never create an assignment');
  });
}

async function testMixedGoogleMappingsFailClosed() {
  await withGoogleResolverStubs(async () => {
    db.Clinica.findByPk = async () => ({ id_clinica: 55, grupoClinicaId: 9 });
    db.GoogleConnectionAssignment.findOne = async () => null;
    db.ClinicGoogleAdsAccount.findAll = async () => [{ googleConnectionId: 101 }];
    db.ClinicWebAsset.findAll = async () => [{ googleConnectionId: 202 }];
    db.ClinicAnalyticsProperty.findAll = async () => [];
    db.ClinicBusinessLocation.findAll = async () => [];
    db.GoogleConnection.findByPk = async () => {
      throw new Error('an ambiguous mapping must not load an arbitrary grant');
    };
    db.GoogleConnection.findAll = async () => {
      throw new Error('an ambiguous mapping must not fall back to user ownership');
    };

    const result = await resolveGoogleConnectionForScope({
      userId: 7,
      clinicIdRaw: 55,
      assignmentScopeRaw: 'clinic',
      allowLegacyUserFallback: true,
    });
    assert.equal(result.connection, null);
    assert.equal(result.source, 'legacy_mapping_google_clinic_ambiguous');
  });
}

async function testMixedMetaMappingsFailClosed() {
  const originals = {
    clinicFindByPk: db.Clinica.findByPk,
    assignmentFindOne: db.MetaConnectionAssignment.findOne,
    assetFindAll: db.ClinicMetaAsset.findAll,
    connectionFindAll: db.MetaConnection.findAll,
    connectionFindByPk: db.MetaConnection.findByPk,
  };
  try {
    db.Clinica.findByPk = async () => ({ id_clinica: 55, grupoClinicaId: 9 });
    db.MetaConnectionAssignment.findOne = async () => null;
    db.ClinicMetaAsset.findAll = async () => [
      { metaConnectionId: 301 },
      { metaConnectionId: 302 },
    ];
    db.MetaConnection.findByPk = async () => {
      throw new Error('an ambiguous mapping must not load an arbitrary grant');
    };
    db.MetaConnection.findAll = async () => {
      throw new Error('an ambiguous mapping must not fall back to user ownership');
    };

    const result = await resolveMetaConnectionForScope({
      userId: 7,
      clinicIdRaw: 55,
      assignmentScopeRaw: 'clinic',
      allowLegacyUserFallback: true,
    });
    assert.equal(result.connection, null);
    assert.equal(result.source, 'legacy_mapping_clinic_ambiguous');
  } finally {
    db.Clinica.findByPk = originals.clinicFindByPk;
    db.MetaConnectionAssignment.findOne = originals.assignmentFindOne;
    db.ClinicMetaAsset.findAll = originals.assetFindAll;
    db.MetaConnection.findAll = originals.connectionFindAll;
    db.MetaConnection.findByPk = originals.connectionFindByPk;
  }
}

async function testAmbiguousLegacyUserFailsClosed() {
  await withGoogleResolverStubs(async () => {
    db.Clinica.findByPk = async () => null;
    db.GoogleConnectionAssignment.findOne = async () => null;
    db.ClinicGoogleAdsAccount.findOne = async () => null;
    db.ClinicWebAsset.findOne = async () => null;
    db.ClinicAnalyticsProperty.findOne = async () => null;
    db.ClinicBusinessLocation.findOne = async () => null;
    db.GoogleConnection.findAll = async ({ where, limit }) => {
      assert.deepEqual(where, { userId: 7 });
      assert.equal(limit, 2);
      return [{ id: 101 }, { id: 202 }];
    };

    const result = await resolveGoogleConnectionForScope({
      userId: 7,
      allowLegacyUserFallback: true,
    });
    assert.equal(result.connection, null);
    assert.equal(result.source, 'legacy_user_ambiguous');
  });
}

async function run() {
  testExplicitScopePlanning();
  await testClinicOverrideBeforeGroupFallback();
  await testGroupFallbackAndExplicitGroupIsolation();
  await testResolverNeverPersistsLegacyAssignments();
  await testMixedGoogleMappingsFailClosed();
  await testMixedMetaMappingsFailClosed();
  await testAmbiguousLegacyUserFailsClosed();
  console.log('scope connection resolution tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
