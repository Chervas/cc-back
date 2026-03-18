'use strict';

const db = require('../../models');
const { Op } = require('sequelize');

const Clinica = db.Clinica;
const MetaConnection = db.MetaConnection;
const GoogleConnection = db.GoogleConnection;
const MetaConnectionAssignment = db.MetaConnectionAssignment;
const GoogleConnectionAssignment = db.GoogleConnectionAssignment;
const ClinicMetaAsset = db.ClinicMetaAsset;
const ClinicGoogleAdsAccount = db.ClinicGoogleAdsAccount;
const ClinicWebAsset = db.ClinicWebAsset;
const ClinicAnalyticsProperty = db.ClinicAnalyticsProperty;
const ClinicBusinessLocation = db.ClinicBusinessLocation;

function parseInteger(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function buildScopeKey(scope, id) {
  if (!scope || !id) return null;
  return `${scope}:${id}`;
}

async function normalizeScope({ clinicIdRaw, groupIdRaw, assignmentScopeRaw }) {
  const clinicId = parseInteger(clinicIdRaw);
  let groupId = parseInteger(groupIdRaw);
  let assignmentScope = String(assignmentScopeRaw || '').trim().toLowerCase();

  if (assignmentScope !== 'clinic' && assignmentScope !== 'group') {
    assignmentScope = groupId && !clinicId ? 'group' : 'clinic';
  }

  if (clinicId && !groupId) {
    const clinic = await Clinica.findByPk(clinicId, {
      attributes: ['id_clinica', 'grupoClinicaId'],
      raw: true
    });
    if (clinic?.grupoClinicaId) {
      groupId = Number(clinic.grupoClinicaId) || null;
    }
  }

  if (assignmentScope === 'group' && !groupId && clinicId) {
    const clinic = await Clinica.findByPk(clinicId, {
      attributes: ['id_clinica', 'grupoClinicaId'],
      raw: true
    });
    if (clinic?.grupoClinicaId) {
      groupId = Number(clinic.grupoClinicaId) || null;
    }
  }

  const scopeId = assignmentScope === 'group' ? groupId : clinicId;
  return {
    clinicId,
    groupId,
    assignmentScope,
    scopeId,
    scopeKey: buildScopeKey(assignmentScope, scopeId)
  };
}

function buildClinicScope(scope) {
  if (!scope?.clinicId) return null;
  return {
    clinicId: scope.clinicId,
    groupId: scope.groupId || null,
    assignmentScope: 'clinic',
    scopeId: scope.clinicId,
    scopeKey: buildScopeKey('clinic', scope.clinicId)
  };
}

function buildSharedConnectionScope(scope) {
  if (!scope) return null;
  if (scope.groupId) {
    return {
      clinicId: null,
      groupId: scope.groupId,
      assignmentScope: 'group',
      scopeId: scope.groupId,
      scopeKey: buildScopeKey('group', scope.groupId)
    };
  }
  return buildClinicScope(scope) || scope;
}

function buildAuthorizedBy(connection, fallbackUserId = null) {
  return {
    userId: parseInteger(fallbackUserId) || parseInteger(connection?.userId) || null,
    name: connection?.userName || null,
    email: connection?.userEmail || null
  };
}

async function upsertMetaAssignment({ connection, scope, authorizedByUserId = null }) {
  if (!connection?.id || !scope?.scopeKey) return null;
  const authorizedBy = buildAuthorizedBy(connection, authorizedByUserId);
  const values = {
    scopeKey: scope.scopeKey,
    assignmentScope: scope.assignmentScope,
    clinicaId: scope.assignmentScope === 'clinic' ? scope.clinicId : null,
    grupoClinicaId: scope.groupId || null,
    metaConnectionId: connection.id,
    status: 'active',
    authorizedByUserId: authorizedBy.userId,
    authorizedByName: authorizedBy.name,
    authorizedByEmail: authorizedBy.email,
    connectedAt: connection.updatedAt || connection.createdAt || new Date(),
    lastValidatedAt: new Date(),
    lastErrorCode: null,
    lastErrorMessage: null
  };

  const existing = await MetaConnectionAssignment.findOne({ where: { scopeKey: scope.scopeKey } });
  if (existing) {
    await existing.update(values);
    return existing;
  }
  return MetaConnectionAssignment.create(values);
}

async function upsertGoogleAssignment({ connection, scope, authorizedByUserId = null }) {
  if (!connection?.id || !scope?.scopeKey) return null;
  const authorizedBy = buildAuthorizedBy(connection, authorizedByUserId);
  const values = {
    scopeKey: scope.scopeKey,
    assignmentScope: scope.assignmentScope,
    clinicaId: scope.assignmentScope === 'clinic' ? scope.clinicId : null,
    grupoClinicaId: scope.groupId || null,
    googleConnectionId: connection.id,
    status: 'active',
    authorizedByUserId: authorizedBy.userId,
    authorizedByName: authorizedBy.name,
    authorizedByEmail: authorizedBy.email,
    connectedAt: connection.updatedAt || connection.createdAt || new Date(),
    lastValidatedAt: new Date(),
    lastErrorCode: null,
    lastErrorMessage: null
  };

  const existing = await GoogleConnectionAssignment.findOne({ where: { scopeKey: scope.scopeKey } });
  if (existing) {
    await existing.update(values);
    return existing;
  }
  return GoogleConnectionAssignment.create(values);
}

async function findMetaAssignment(scope, statuses = ['active', 'reauthorization_required']) {
  if (!scope?.scopeKey) return null;
  return MetaConnectionAssignment.findOne({
    where: {
      scopeKey: scope.scopeKey,
      status: { [Op.in]: statuses }
    },
    include: [{ model: MetaConnection, as: 'metaConnection' }]
  });
}

async function findGoogleAssignment(scope, statuses = ['active', 'reauthorization_required']) {
  if (!scope?.scopeKey) return null;
  return GoogleConnectionAssignment.findOne({
    where: {
      scopeKey: scope.scopeKey,
      status: { [Op.in]: statuses }
    },
    include: [{ model: GoogleConnection, as: 'googleConnection' }]
  });
}

async function findLegacyMetaConnectionFromMappings(scope) {
  if (scope?.clinicId) {
    const clinicAsset = await ClinicMetaAsset.findOne({
      where: { clinicaId: scope.clinicId, isActive: true },
      order: [['updatedAt', 'DESC'], ['id', 'DESC']],
      include: [{ model: MetaConnection, as: 'metaConnection' }]
    });
    if (clinicAsset?.metaConnection) {
      return { connection: clinicAsset.metaConnection, source: 'legacy_mapping_clinic' };
    }
  }

  if (scope?.groupId) {
    const groupAsset = await ClinicMetaAsset.findOne({
      where: { grupoClinicaId: scope.groupId, assignmentScope: 'group', isActive: true },
      order: [['updatedAt', 'DESC'], ['id', 'DESC']],
      include: [{ model: MetaConnection, as: 'metaConnection' }]
    });
    if (groupAsset?.metaConnection) {
      return { connection: groupAsset.metaConnection, source: 'legacy_mapping_group' };
    }
  }

  return { connection: null, source: null };
}

async function findLegacyGoogleConnectionFromMappings(scope) {
  const clinicId = scope?.clinicId || null;
  if (!clinicId) {
    return { connection: null, source: null };
  }

  const searches = [
    ClinicGoogleAdsAccount.findOne({
      where: { clinicaId: clinicId, isActive: true },
      order: [['updated_at', 'DESC'], ['id', 'DESC']],
      include: [{ model: GoogleConnection, as: 'googleConnection' }]
    }).then((row) => row?.googleConnection ? { connection: row.googleConnection, source: 'legacy_mapping_google_ads' } : null),
    ClinicWebAsset.findOne({
      where: { clinicaId: clinicId, isActive: true },
      order: [['updated_at', 'DESC'], ['id', 'DESC']],
      include: [{ model: GoogleConnection, as: 'connection' }]
    }).then((row) => row?.connection ? { connection: row.connection, source: 'legacy_mapping_search_console' } : null),
    ClinicAnalyticsProperty.findOne({
      where: { clinicaId: clinicId, isActive: true },
      order: [['updated_at', 'DESC'], ['id', 'DESC']],
      include: [{ model: GoogleConnection, as: 'connection' }]
    }).then((row) => row?.connection ? { connection: row.connection, source: 'legacy_mapping_analytics' } : null),
    ClinicBusinessLocation.findOne({
      where: { clinica_id: clinicId, is_active: true },
      order: [['updated_at', 'DESC'], ['id', 'DESC']],
      include: [{ model: GoogleConnection, as: 'googleConnection' }]
    }).then((row) => row?.googleConnection ? { connection: row.googleConnection, source: 'legacy_mapping_local' } : null)
  ];

  const resolved = await Promise.all(searches);
  return resolved.find(Boolean) || { connection: null, source: null };
}

async function resolveMetaConnectionForScope({ userId = null, clinicIdRaw = null, groupIdRaw = null, assignmentScopeRaw = null, allowLegacyUserFallback = true }) {
  const scope = await normalizeScope({ clinicIdRaw, groupIdRaw, assignmentScopeRaw });

  const clinicScope = buildClinicScope(scope);
  const sharedScope = buildSharedConnectionScope(scope);

  if (sharedScope?.assignmentScope === 'group') {
    const groupAssignment = await findMetaAssignment(sharedScope);
    if (groupAssignment?.metaConnection) {
      return { connection: groupAssignment.metaConnection, assignment: groupAssignment, scope: sharedScope, source: 'scope_assignment_group' };
    }

    const blockedGroupAssignment = await findMetaAssignment(sharedScope, ['disconnected', 'revoked']);
    if (blockedGroupAssignment) {
      return { connection: null, assignment: blockedGroupAssignment, scope: sharedScope, source: 'scope_assignment_group_blocked' };
    }

    if (clinicScope) {
      const clinicAssignment = await findMetaAssignment(clinicScope);
      if (clinicAssignment?.metaConnection) {
        const assignment = await upsertMetaAssignment({ connection: clinicAssignment.metaConnection, scope: sharedScope, authorizedByUserId: userId });
        return { connection: clinicAssignment.metaConnection, assignment, scope: sharedScope, source: 'promoted_clinic_assignment_group' };
      }
    }
  } else if (clinicScope) {
    const clinicAssignment = await findMetaAssignment(clinicScope);
    if (clinicAssignment?.metaConnection) {
      return { connection: clinicAssignment.metaConnection, assignment: clinicAssignment, scope: clinicScope, source: 'scope_assignment_clinic' };
    }

    const blockedClinicAssignment = await findMetaAssignment(clinicScope, ['disconnected', 'revoked']);
    if (blockedClinicAssignment) {
      return { connection: null, assignment: blockedClinicAssignment, scope: clinicScope, source: 'scope_assignment_clinic_blocked' };
    }
  }

  const legacy = await findLegacyMetaConnectionFromMappings(scope);
  if (legacy.connection) {
    const targetScope = sharedScope || clinicScope || scope;
    const assignment = await upsertMetaAssignment({ connection: legacy.connection, scope: targetScope, authorizedByUserId: userId });
    return { connection: legacy.connection, assignment, scope: targetScope, source: legacy.source };
  }

  if (allowLegacyUserFallback && userId) {
    const connection = await MetaConnection.findOne({ where: { userId } });
    if (connection) {
      return { connection, assignment: null, scope: sharedScope || clinicScope || scope, source: 'legacy_user' };
    }
  }

  return { connection: null, assignment: null, scope: sharedScope || clinicScope || scope, source: 'none' };
}

async function resolveGoogleConnectionForScope({ userId = null, clinicIdRaw = null, groupIdRaw = null, assignmentScopeRaw = null, allowLegacyUserFallback = true }) {
  const scope = await normalizeScope({ clinicIdRaw, groupIdRaw, assignmentScopeRaw });

  const clinicScope = buildClinicScope(scope);
  const sharedScope = buildSharedConnectionScope(scope);

  if (sharedScope?.assignmentScope === 'group') {
    const groupAssignment = await findGoogleAssignment(sharedScope);
    if (groupAssignment?.googleConnection) {
      return { connection: groupAssignment.googleConnection, assignment: groupAssignment, scope: sharedScope, source: 'scope_assignment_group' };
    }

    const blockedGroupAssignment = await findGoogleAssignment(sharedScope, ['disconnected', 'revoked']);
    if (blockedGroupAssignment) {
      return { connection: null, assignment: blockedGroupAssignment, scope: sharedScope, source: 'scope_assignment_group_blocked' };
    }

    if (clinicScope) {
      const clinicAssignment = await findGoogleAssignment(clinicScope);
      if (clinicAssignment?.googleConnection) {
        const assignment = await upsertGoogleAssignment({ connection: clinicAssignment.googleConnection, scope: sharedScope, authorizedByUserId: userId });
        return { connection: clinicAssignment.googleConnection, assignment, scope: sharedScope, source: 'promoted_clinic_assignment_group' };
      }
    }
  } else if (clinicScope) {
    const clinicAssignment = await findGoogleAssignment(clinicScope);
    if (clinicAssignment?.googleConnection) {
      return { connection: clinicAssignment.googleConnection, assignment: clinicAssignment, scope: clinicScope, source: 'scope_assignment_clinic' };
    }

    const blockedClinicAssignment = await findGoogleAssignment(clinicScope, ['disconnected', 'revoked']);
    if (blockedClinicAssignment) {
      return { connection: null, assignment: blockedClinicAssignment, scope: clinicScope, source: 'scope_assignment_clinic_blocked' };
    }
  }

  const legacy = await findLegacyGoogleConnectionFromMappings(scope);
  if (legacy.connection) {
    const targetScope = sharedScope || clinicScope || scope;
    const assignment = await upsertGoogleAssignment({ connection: legacy.connection, scope: targetScope, authorizedByUserId: userId });
    return { connection: legacy.connection, assignment, scope: targetScope, source: legacy.source };
  }

  if (allowLegacyUserFallback && userId) {
    const connection = await GoogleConnection.findOne({ where: { userId } });
    if (connection) {
      return { connection, assignment: null, scope: sharedScope || clinicScope || scope, source: 'legacy_user' };
    }
  }

  return { connection: null, assignment: null, scope: sharedScope || clinicScope || scope, source: 'none' };
}

module.exports = {
  parseInteger,
  buildScopeKey,
  normalizeScope,
  buildClinicScope,
  buildSharedConnectionScope,
  buildAuthorizedBy,
  upsertMetaAssignment,
  upsertGoogleAssignment,
  resolveMetaConnectionForScope,
  resolveGoogleConnectionForScope
};
