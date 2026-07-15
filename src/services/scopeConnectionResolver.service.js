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

function buildGroupScope(scope) {
  if (!scope?.groupId) return null;
  return {
    clinicId: null,
    groupId: scope.groupId,
    assignmentScope: 'group',
    scopeId: scope.groupId,
    scopeKey: buildScopeKey('group', scope.groupId)
  };
}

function buildSharedConnectionScope(scope) {
  if (!scope) return null;
  if (scope.assignmentScope === 'group') return buildGroupScope(scope) || scope;
  if (scope.assignmentScope === 'clinic') return buildClinicScope(scope) || scope;
  return buildClinicScope(scope) || buildGroupScope(scope) || scope;
}

function buildConnectionResolutionPlan(scope) {
  if (!scope) return [];
  const clinicScope = buildClinicScope(scope);
  const groupScope = buildGroupScope(scope);
  if (scope.assignmentScope === 'group') return groupScope ? [groupScope] : [];
  if (scope.assignmentScope === 'clinic') return [clinicScope, groupScope].filter(Boolean);
  return [clinicScope, groupScope].filter(Boolean);
}

function buildAuthorizedBy(connection, fallbackUserId = null) {
  return {
    userId: parseInteger(fallbackUserId) || parseInteger(connection?.userId) || null,
    name: connection?.userName || null,
    email: connection?.userEmail || null
  };
}

async function findSingleUserConnection(Model, userId) {
  const parsedUserId = parseInteger(userId);
  if (!parsedUserId) return { connection: null, ambiguous: false };
  const connections = await Model.findAll({
    where: { userId: parsedUserId },
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
    limit: 2,
  });
  if (connections.length === 1) {
    return { connection: connections[0], ambiguous: false };
  }
  return { connection: null, ambiguous: connections.length > 1 };
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

async function distinctConnectionIds(Model, field, where) {
  const rows = await Model.findAll({
    where,
    attributes: [field],
    group: [field],
    limit: 2,
    raw: true,
  });
  return Array.from(new Set(rows
    .map((row) => Number.parseInt(String(row?.[field] ?? ''), 10))
    .filter((id) => Number.isInteger(id) && id > 0)));
}

async function resolveSingleMappedConnection(Model, ids, source) {
  if (ids.length > 1) {
    return { connection: null, source: `${source}_ambiguous`, ambiguous: true };
  }
  if (ids.length !== 1) return { connection: null, source: null, ambiguous: false };
  const connection = await Model.findByPk(ids[0]);
  return { connection: connection || null, source: connection ? source : null, ambiguous: false };
}

async function findLegacyMetaConnectionFromMappings(scope) {
  if (scope?.clinicId) {
    const clinicConnectionIds = await distinctConnectionIds(
      ClinicMetaAsset,
      'metaConnectionId',
      { clinicaId: scope.clinicId, isActive: true }
    );
    const clinicResult = await resolveSingleMappedConnection(
      MetaConnection,
      clinicConnectionIds,
      'legacy_mapping_clinic'
    );
    if (clinicResult.connection || clinicResult.ambiguous) return clinicResult;
  }

  if (scope?.groupId) {
    const groupConnectionIds = await distinctConnectionIds(
      ClinicMetaAsset,
      'metaConnectionId',
      {
        grupoClinicaId: scope.groupId,
        assignmentScope: 'group',
        isActive: true,
      }
    );
    const groupResult = await resolveSingleMappedConnection(
      MetaConnection,
      groupConnectionIds,
      'legacy_mapping_group'
    );
    if (groupResult.connection || groupResult.ambiguous) return groupResult;
  }

  return { connection: null, source: null, ambiguous: false };
}

async function googleClinicMappingConnectionIds(clinicId) {
  const [ads, web, analytics, local] = await Promise.all([
    distinctConnectionIds(ClinicGoogleAdsAccount, 'googleConnectionId', {
      clinicaId: clinicId,
      isActive: true,
    }),
    distinctConnectionIds(ClinicWebAsset, 'googleConnectionId', {
      clinicaId: clinicId,
      isActive: true,
    }),
    distinctConnectionIds(ClinicAnalyticsProperty, 'googleConnectionId', {
      clinicaId: clinicId,
      isActive: true,
    }),
    distinctConnectionIds(ClinicBusinessLocation, 'google_connection_id', {
      clinica_id: clinicId,
      is_active: true,
    }),
  ]);
  return Array.from(new Set([...ads, ...web, ...analytics, ...local]));
}

async function findLegacyGoogleConnectionFromMappings(scope) {
  if (scope?.clinicId) {
    const clinicConnectionIds = await googleClinicMappingConnectionIds(scope.clinicId);
    const clinicResult = await resolveSingleMappedConnection(
      GoogleConnection,
      clinicConnectionIds,
      'legacy_mapping_google_clinic'
    );
    if (clinicResult.connection || clinicResult.ambiguous) return clinicResult;
  }

  if (scope?.groupId) {
    const groupConnectionIds = await distinctConnectionIds(
      ClinicGoogleAdsAccount,
      'googleConnectionId',
      {
        grupoClinicaId: scope.groupId,
        assignmentScope: 'group',
        isActive: true,
      }
    );
    const groupResult = await resolveSingleMappedConnection(
      GoogleConnection,
      groupConnectionIds,
      'legacy_mapping_google_group'
    );
    if (groupResult.connection || groupResult.ambiguous) return groupResult;
  }

  return { connection: null, source: null, ambiguous: false };
}

async function resolveMetaConnectionForScope({
  userId = null,
  clinicIdRaw = null,
  groupIdRaw = null,
  assignmentScopeRaw = null,
  allowLegacyUserFallback = true,
}) {
  const scope = await normalizeScope({ clinicIdRaw, groupIdRaw, assignmentScopeRaw });

  const requestedScope = buildSharedConnectionScope(scope) || scope;
  for (const candidateScope of buildConnectionResolutionPlan(scope)) {
    const assignment = await findMetaAssignment(candidateScope);
    if (assignment?.metaConnection) {
      const suffix = candidateScope.assignmentScope === requestedScope.assignmentScope
        ? candidateScope.assignmentScope
        : `${candidateScope.assignmentScope}_fallback`;
      return {
        connection: assignment.metaConnection,
        assignment,
        scope: requestedScope,
        source: `scope_assignment_${suffix}`
      };
    }

    const blockedAssignment = await findMetaAssignment(candidateScope, ['disconnected', 'revoked']);
    if (blockedAssignment) {
      return {
        connection: null,
        assignment: blockedAssignment,
        scope: requestedScope,
        source: `scope_assignment_${candidateScope.assignmentScope}_blocked`
      };
    }
  }

  const legacy = await findLegacyMetaConnectionFromMappings(requestedScope);
  if (legacy.connection) {
    const targetScope = requestedScope;
    return { connection: legacy.connection, assignment: null, scope: targetScope, source: legacy.source };
  }
  if (legacy.ambiguous) {
    return {
      connection: null,
      assignment: null,
      scope: requestedScope,
      source: legacy.source
    };
  }

  if (allowLegacyUserFallback && userId) {
    const { connection, ambiguous } = await findSingleUserConnection(MetaConnection, userId);
    if (connection) {
      return { connection, assignment: null, scope: requestedScope, source: 'legacy_user' };
    }
    if (ambiguous) {
      return {
        connection: null,
        assignment: null,
        scope: requestedScope,
        source: 'legacy_user_ambiguous'
      };
    }
  }

  return { connection: null, assignment: null, scope: requestedScope, source: 'none' };
}

async function resolveGoogleConnectionForScope({
  userId = null,
  clinicIdRaw = null,
  groupIdRaw = null,
  assignmentScopeRaw = null,
  allowLegacyUserFallback = true,
}) {
  const scope = await normalizeScope({ clinicIdRaw, groupIdRaw, assignmentScopeRaw });

  const requestedScope = buildSharedConnectionScope(scope) || scope;
  for (const candidateScope of buildConnectionResolutionPlan(scope)) {
    const assignment = await findGoogleAssignment(candidateScope);
    if (assignment?.googleConnection) {
      const suffix = candidateScope.assignmentScope === requestedScope.assignmentScope
        ? candidateScope.assignmentScope
        : `${candidateScope.assignmentScope}_fallback`;
      return {
        connection: assignment.googleConnection,
        assignment,
        scope: requestedScope,
        source: `scope_assignment_${suffix}`
      };
    }

    const blockedAssignment = await findGoogleAssignment(candidateScope, ['disconnected', 'revoked']);
    if (blockedAssignment) {
      return {
        connection: null,
        assignment: blockedAssignment,
        scope: requestedScope,
        source: `scope_assignment_${candidateScope.assignmentScope}_blocked`
      };
    }
  }

  const legacy = await findLegacyGoogleConnectionFromMappings(requestedScope);
  if (legacy.connection) {
    const targetScope = requestedScope;
    return { connection: legacy.connection, assignment: null, scope: targetScope, source: legacy.source };
  }
  if (legacy.ambiguous) {
    return {
      connection: null,
      assignment: null,
      scope: requestedScope,
      source: legacy.source
    };
  }

  if (allowLegacyUserFallback && userId) {
    const { connection, ambiguous } = await findSingleUserConnection(GoogleConnection, userId);
    if (connection) {
      return { connection, assignment: null, scope: requestedScope, source: 'legacy_user' };
    }
    if (ambiguous) {
      return {
        connection: null,
        assignment: null,
        scope: requestedScope,
        source: 'legacy_user_ambiguous'
      };
    }
  }

  return { connection: null, assignment: null, scope: requestedScope, source: 'none' };
}

module.exports = {
  parseInteger,
  buildScopeKey,
  normalizeScope,
  buildClinicScope,
  buildGroupScope,
  buildSharedConnectionScope,
  buildConnectionResolutionPlan,
  buildAuthorizedBy,
  findSingleUserConnection,
  upsertMetaAssignment,
  upsertGoogleAssignment,
  resolveMetaConnectionForScope,
  resolveGoogleConnectionForScope
};
