'use strict';

const db = require('../../models');
const { Op } = require('sequelize');
const {
  parseRuntimeInheritance,
  recordDeclaresRuntime,
} = require('../lib/webRuntimeInheritance');
const { isReleasedWordpressPublication } = require('../lib/webWordpressCompatibility');

class ClinicWebRuntimeMembershipError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ClinicWebRuntimeMembershipError';
    this.code = code;
    this.status = 409;
    this.details = details;
  }
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function hasOwn(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function groupIncludesClinic(groupRecord, clinicId) {
  const locations = Array.isArray(groupRecord?.config?.locations)
    ? groupRecord.config.locations
    : [];
  return locations.some((location) => (
    positiveInteger(location?.id ?? location?.clinic_id) === clinicId
  ));
}

function inheritedRuntimeState({ directRecord, groupRecord, clinicId, previousGroupId }) {
  const direct = plain(directRecord);
  const group = plain(groupRecord);
  const markerPresent = hasOwn(direct?.config, 'runtime_inheritance');
  const marker = parseRuntimeInheritance(direct?.config?.runtime_inheritance);

  if (markerPresent) {
    if (!marker || marker.type !== 'group' || marker.id !== previousGroupId) {
      return { inherited: true, reason: 'invalid_or_stale_marker' };
    }
    return { inherited: true, reason: 'explicit_group_inheritance' };
  }
  if (direct && recordDeclaresRuntime(direct)) {
    return { inherited: false, reason: 'clinic_runtime' };
  }
  if (
    previousGroupId
    && group?.assignment_scope === 'group'
    && positiveInteger(group.group_id) === previousGroupId
    && groupIncludesClinic(group, clinicId)
    && recordDeclaresRuntime(group)
  ) {
    return { inherited: true, reason: 'implicit_group_inheritance' };
  }
  return { inherited: false, reason: 'no_runtime_inheritance' };
}

async function lockedIntakeRecord(model, where, transaction) {
  if (!model?.findOne) return null;
  return model.findOne({
    where,
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });
}

/**
 * A group membership change and a web-runtime handoff are separate lifecycle
 * operations. Moving the clinic first would make inherited public intake fail
 * closed while WordPress can still serve the source artifact/HMAC. Refuse the
 * membership mutation until an explicit reconciler materializes or retires the
 * runtime; never guess a target credential inside the generic clinic PATCH.
 */
async function assertClinicWebRuntimeGroupChangeSafe({
  clinicId,
  previousGroupId,
  requestedGroupId,
  models = db,
  transaction = null,
} = {}) {
  const resolvedClinicId = positiveInteger(clinicId);
  const sourceGroupId = positiveInteger(previousGroupId);
  const targetGroupId = positiveInteger(requestedGroupId);
  if (!resolvedClinicId || sourceGroupId === targetGroupId) return { inherited: false };
  if (!models.IntakeConfig?.findOne) return { inherited: false };

  const directRecord = await lockedIntakeRecord(models.IntakeConfig, {
    assignment_scope: 'clinic',
    clinic_id: resolvedClinicId,
  }, transaction);
  const groupRecord = sourceGroupId
    ? await lockedIntakeRecord(models.IntakeConfig, {
      assignment_scope: 'group',
      group_id: sourceGroupId,
    }, transaction)
    : null;
  const state = inheritedRuntimeState({
    directRecord,
    groupRecord,
    clinicId: resolvedClinicId,
    previousGroupId: sourceGroupId,
  });
  if (!state.inherited) return state;

  throw new ClinicWebRuntimeMembershipError(
    'clinic_group_change_web_runtime_reconciliation_required',
    'Antes de cambiar esta clínica de grupo hay que materializar o retirar su medición web heredada.',
    {
      error_code: 'clinic_group_change_web_runtime_reconciliation_required',
      clinic_id: resolvedClinicId,
      previous_group_id: sourceGroupId,
      requested_group_id: targetGroupId,
      inheritance_reason: state.reason,
      next_action: 'reconcile_web_runtime_before_group_change',
    }
  );
}

/**
 * A clinic-owned publication may consume the WordPress installation of its
 * current group, but that delegation must end through the normal retirement
 * handshake. Moving or disabling the clinic first would either leave the old
 * route alive or make the alpha.8 plugin reject an unsigned disappearance.
 *
 * The clinic row is already locked by the controller. These reads deliberately
 * do not lock installation/publication rows: publication creation locks the
 * installation before the clinic and will revalidate after this transaction,
 * avoiding an inverse-lock deadlock while remaining fail-closed.
 */
async function assertClinicWordpressMembershipChangeSafe({
  clinicId,
  previousGroupId,
  requestedGroupId,
  previousActive = true,
  requestedActive = true,
  models = db,
  transaction = null,
} = {}) {
  const resolvedClinicId = positiveInteger(clinicId);
  const sourceGroupId = positiveInteger(previousGroupId);
  const targetGroupId = positiveInteger(requestedGroupId);
  const groupChanges = sourceGroupId !== targetGroupId;
  const deactivates = previousActive === true && requestedActive !== true;
  if (!resolvedClinicId || !sourceGroupId || (!groupChanges && !deactivates)) {
    return { blocked: false };
  }
  if (!models.WebWordpressInstallation?.findAll || !models.WebPublication?.findAll) {
    return { blocked: false };
  }
  const installations = await models.WebWordpressInstallation.findAll({
    where: {
      scopeType: 'group',
      grupoClinicaId: sourceGroupId,
    },
    attributes: ['id', 'status', 'reportedState'],
    transaction,
  });
  const installationIds = installations
    .map((row) => String(plain(row)?.id || '').trim())
    .filter(Boolean);
  if (!installationIds.length) return { blocked: false };
  const publications = await models.WebPublication.findAll({
    where: {
      wordpressInstallationId: { [Op.in]: installationIds },
    },
    attributes: [
      'id', 'status', 'path', 'wordpressInstallationId',
      'scopeType', 'clinicaId', 'grupoClinicaId', 'configuration',
    ],
    order: [['created_at', 'ASC'], ['id', 'ASC']],
    transaction,
  });
  const installationById = new Map(installations.map((row) => [String(plain(row).id), plain(row)]));
  const relevant = publications.filter((row) => {
    const publication = plain(row) || {};
    if (publication.scopeType === 'clinic') {
      return positiveInteger(publication.clinicaId) === resolvedClinicId;
    }
    return publication.scopeType === 'group'
      && positiveInteger(publication.grupoClinicaId) === sourceGroupId
      && positiveInteger(publication.configuration?.clinic_id ?? publication.configuration?.clinicId) === resolvedClinicId;
  });
  const unreleased = relevant.filter((row) => {
    const publication = plain(row);
    const installation = installationById.get(String(publication.wordpressInstallationId));
    return !installation || !isReleasedWordpressPublication(installation, publication);
  });
  if (!unreleased.length) return { blocked: false };
  throw new ClinicWebRuntimeMembershipError(
    'clinic_membership_wordpress_publication_retirement_required',
    'Retira primero las landings que esta clínica publica mediante el WordPress de su grupo.',
    {
      error_code: 'clinic_membership_wordpress_publication_retirement_required',
      clinic_id: resolvedClinicId,
      previous_group_id: sourceGroupId,
      requested_group_id: targetGroupId,
      requested_active: requestedActive === true,
      publication_ids: unreleased.map((row) => String(plain(row).id)),
      next_action: 'retire_inherited_wordpress_publications_before_membership_change',
    }
  );
}

module.exports = {
  ClinicWebRuntimeMembershipError,
  assertClinicWordpressMembershipChangeSafe,
  assertClinicWebRuntimeGroupChangeSafe,
  inheritedRuntimeState,
};
