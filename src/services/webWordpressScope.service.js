'use strict';

/**
 * Current, row-backed authorization for sharing a group-owned WordPress with
 * one of its clinics. A publication never gains a durable right merely
 * because the clinic belonged to the group when it was created.
 */

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function resourceScope(resource) {
  const value = plain(resource) || {};
  const type = String(value.scopeType ?? value.scope_type ?? '').trim().toLowerCase();
  if (type === 'clinic') {
    const id = positiveInteger(value.clinicaId ?? value.clinica_id ?? value.scopeId ?? value.scope_id);
    return id ? { type, id } : null;
  }
  if (type === 'group') {
    const id = positiveInteger(value.grupoClinicaId ?? value.grupo_clinica_id ?? value.groupId ?? value.group_id ?? value.scopeId ?? value.scope_id);
    return id ? { type, id } : null;
  }
  return null;
}

function exactScopeMatch(installation, scope) {
  const source = resourceScope(installation);
  return Boolean(source && scope && source.type === scope.type && source.id === positiveInteger(scope.id));
}

function activeClinic(value) {
  return [true, 1, '1'].includes(value);
}

function materializedClinicId(publication) {
  const value = plain(publication) || {};
  const configuration = value.configuration;
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return null;
  return positiveInteger(configuration.clinic_id ?? configuration.clinicId);
}

function publicationAuthorizationSortKey(publication) {
  const value = plain(publication) || {};
  const scope = resourceScope(value);
  const clinicId = scope?.type === 'group' ? materializedClinicId(value) : scope?.id;
  return [
    String(clinicId || 0).padStart(12, '0'),
    scope?.type || '',
    String(scope?.id || 0).padStart(12, '0'),
    String(value.id || ''),
  ].join(':');
}

async function clinicMembership(clinicId, { models, transaction = null, lock = false } = {}) {
  if (!models?.Clinica?.findByPk) return null;
  const options = {
    attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica'],
    ...(transaction ? { transaction } : {}),
    ...(transaction && lock && transaction.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
  };
  const clinic = plain(await models.Clinica.findByPk(positiveInteger(clinicId), options));
  if (!clinic) return null;
  return {
    clinic_id: positiveInteger(clinic.id_clinica ?? clinic.id),
    group_id: positiveInteger(clinic.grupoClinicaId ?? clinic.grupo_clinica_id),
    active: activeClinic(clinic.estado_clinica),
  };
}

async function wordpressInstallationScopeAuthorization(
  installation,
  scope,
  { models, transaction = null, lockClinic = false } = {}
) {
  const normalizedScope = scope && ['clinic', 'group'].includes(String(scope.type))
    ? { type: String(scope.type), id: positiveInteger(scope.id) }
    : null;
  const sourceScope = resourceScope(installation);
  if (!normalizedScope?.id || !sourceScope) {
    return { allowed: false, inheritedFromGroup: false, sourceScope: null, reason: 'invalid_scope' };
  }
  if (exactScopeMatch(installation, normalizedScope)) {
    return { allowed: true, inheritedFromGroup: false, sourceScope, reason: 'exact_scope' };
  }
  if (normalizedScope.type !== 'clinic' || sourceScope.type !== 'group') {
    return { allowed: false, inheritedFromGroup: false, sourceScope: null, reason: 'scope_mismatch' };
  }
  const membership = await clinicMembership(normalizedScope.id, {
    models,
    transaction,
    lock: lockClinic,
  });
  const allowed = Boolean(
    membership?.active
    && membership.clinic_id === normalizedScope.id
    && membership.group_id === sourceScope.id
  );
  return {
    allowed,
    inheritedFromGroup: allowed,
    sourceScope: allowed ? sourceScope : null,
    reason: allowed ? 'active_group_membership' : 'group_membership_revoked',
  };
}

async function filterAuthorizedWordpressPublications(
  installation,
  publications,
  { models, transaction = null, lockClinics = false } = {}
) {
  const rows = Array.isArray(publications) ? publications : [];
  const result = [];
  // Stable scope order prevents two registry builders from taking clinic locks
  // in opposite order when a group owns several clinic publications.
  const sorted = [...rows].sort((left, right) => (
    publicationAuthorizationSortKey(left).localeCompare(publicationAuthorizationSortKey(right))
  ));
  for (const publication of sorted) {
    const scope = resourceScope(publication);
    const authorization = await wordpressInstallationScopeAuthorization(installation, scope, {
      models,
      transaction,
      lockClinic: lockClinics,
    });
    if (!authorization.allowed) continue;
    if (scope?.type === 'group') {
      // A group project is always compiled for one concrete clinic. Exact
      // installation scope is not enough: legacy/manual drift must not keep
      // serving that clinic after it leaves the group or becomes inactive.
      const clinicId = materializedClinicId(publication);
      if (!clinicId) continue;
      const membership = await clinicMembership(clinicId, {
        models,
        transaction,
        lock: lockClinics,
      });
      if (!membership?.active || membership.group_id !== scope.id) continue;
    }
    result.push(publication);
  }
  return result;
}

module.exports = {
  clinicMembership,
  exactScopeMatch,
  filterAuthorizedWordpressPublications,
  materializedClinicId,
  resourceScope,
  wordpressInstallationScopeAuthorization,
};
