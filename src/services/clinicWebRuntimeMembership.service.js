'use strict';

const db = require('../../models');
const {
  parseRuntimeInheritance,
  recordDeclaresRuntime,
} = require('../lib/webRuntimeInheritance');

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

module.exports = {
  ClinicWebRuntimeMembershipError,
  assertClinicWebRuntimeGroupChangeSafe,
  inheritedRuntimeState,
};
