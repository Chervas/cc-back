'use strict';

function failure(code, httpStatus, message) { return Object.assign(new Error(message), { code, httpStatus }); }

async function resolveWorkspaceGroupAccountScope({ body, clinicIds, userId, findGroupClinics, hasAccess }) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, 'workspace_group_id')) return null;
  const groupId = body.workspace_group_id;
  if (!Number.isSafeInteger(groupId) || groupId <= 0 || String(body.group_id) !== String(groupId) || body.assignment_scope !== 'group') {
    throw failure('workspace_group_scope_invalid', 400, 'La cuenta debe asignarse a un grupo explícito.');
  }
  const members = [...new Set((await findGroupClinics(groupId)).map(Number))].filter(id => Number.isSafeInteger(id) && id > 0);
  if (!members.length) throw failure('workspace_group_not_found', 404, 'No se ha encontrado el grupo de clínicas.');
  if (!clinicIds.length || clinicIds.some(id => !members.includes(Number(id)))) {
    throw failure('workspace_group_clinic_mismatch', 400, 'La clínica de la cuenta no pertenece al grupo seleccionado.');
  }
  if (!await hasAccess({ userId, clinicIds: members, access: 'write' })) {
    throw failure('workspace_group_write_forbidden', 403, 'Necesitas permiso de gestión sobre todas las clínicas del grupo.');
  }
  return { assignmentScope: 'group', grupoClinicaId: groupId, clinicIds: members };
}

module.exports = { resolveWorkspaceGroupAccountScope };
