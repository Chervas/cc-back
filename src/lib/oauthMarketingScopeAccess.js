'use strict';

function scopeError(code, message, httpStatus) {
  const error = new Error(message || code);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function positiveId(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function marketingScopeInputFromRequest(req = {}) {
  const query = req.query || {};
  const body = req.body || {};
  return {
    clinicIdRaw: query.clinic_id
      ?? query.clinicId
      ?? query.clinica_id
      ?? query.clinicaId
      ?? body.clinic_id
      ?? body.clinicId
      ?? body.clinica_id
      ?? body.clinicaId
      ?? null,
    groupIdRaw: query.group_id
      ?? query.groupId
      ?? body.group_id
      ?? body.groupId
      ?? null,
    assignmentScopeRaw: query.assignment_scope
      ?? query.assignmentScope
      ?? body.assignment_scope
      ?? body.assignmentScope
      ?? null,
  };
}

async function authorizeRequestedMarketingConnectionScope({
  userId,
  clinicIdRaw = null,
  groupIdRaw = null,
  assignmentScopeRaw = null,
  access = 'read',
  findClinicGroupId,
  findGroupClinicIds,
  authorizeClinicIds,
}) {
  const clinicId = positiveId(clinicIdRaw);
  let groupId = positiveId(groupIdRaw);
  const rawAssignmentScope = String(assignmentScopeRaw || '').trim().toLowerCase();
  const hasAnyRawScope = clinicIdRaw !== null && clinicIdRaw !== undefined && clinicIdRaw !== ''
    || groupIdRaw !== null && groupIdRaw !== undefined && groupIdRaw !== ''
    || assignmentScopeRaw !== null && assignmentScopeRaw !== undefined && assignmentScopeRaw !== '';

  if (!hasAnyRawScope) return { requested: false, clinicIds: [] };
  if ((clinicIdRaw !== null && clinicIdRaw !== undefined && clinicIdRaw !== '' && !clinicId)
    || (groupIdRaw !== null && groupIdRaw !== undefined && groupIdRaw !== '' && !groupId)) {
    throw scopeError('marketing_connection_scope_invalid', 'El scope de clínica o grupo no es válido.', 400);
  }
  if (rawAssignmentScope && rawAssignmentScope !== 'clinic' && rawAssignmentScope !== 'group') {
    throw scopeError('marketing_connection_scope_invalid', 'El tipo de scope solicitado no es válido.', 400);
  }
  const assignmentScope = rawAssignmentScope
    || (groupId && !clinicId ? 'group' : 'clinic');

  if (assignmentScope === 'group' && !groupId && clinicId) {
    groupId = positiveId(await findClinicGroupId(clinicId));
  }

  let clinicIds;
  if (assignmentScope === 'clinic') {
    if (!clinicId) {
      throw scopeError('marketing_connection_scope_invalid', 'Debes indicar una clínica válida.', 400);
    }
    if (groupId) {
      const clinicGroupId = positiveId(await findClinicGroupId(clinicId));
      if (clinicGroupId !== groupId) {
        throw scopeError(
          'marketing_connection_scope_mismatch',
          'La clínica indicada no pertenece al grupo solicitado.',
          400
        );
      }
    }
    clinicIds = [clinicId];
  } else if (groupId) {
    clinicIds = Array.from(new Set((await findGroupClinicIds(groupId))
      .map(positiveId)
      .filter(Boolean)));
    if (!clinicIds.length) {
      throw scopeError('marketing_connection_group_not_found', 'El grupo indicado no contiene clínicas válidas.', 400);
    }
    if (clinicId && !clinicIds.includes(clinicId)) {
      throw scopeError(
        'marketing_connection_scope_mismatch',
        'La clínica indicada no pertenece al grupo solicitado.',
        400
      );
    }
  } else {
    throw scopeError('marketing_connection_scope_invalid', 'Debes indicar una clínica o un grupo válido.', 400);
  }

  const allowed = await authorizeClinicIds({
    userId,
    clinicIds,
    access: access === 'write' ? 'write' : 'read',
  });
  if (!allowed) {
    throw scopeError(
      access === 'write' ? 'marketing_connection_scope_write_forbidden' : 'marketing_connection_scope_forbidden',
      access === 'write'
        ? 'No tienes permisos para modificar las conexiones de este scope.'
        : 'No tienes permisos para consultar las conexiones de este scope.',
      403
    );
  }

  return { requested: true, clinicIds, clinicId, groupId, assignmentScope };
}

module.exports = {
  authorizeRequestedMarketingConnectionScope,
  marketingScopeInputFromRequest,
  positiveId,
};
