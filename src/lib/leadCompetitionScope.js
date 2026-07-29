'use strict';

const normalizeIds = (values) => Array.from(new Set((Array.isArray(values) ? values : [])
  .map((value) => Number.parseInt(String(value), 10))
  .filter((value) => Number.isInteger(value) && value > 0)));

function resolveLeadCompetitionPeerScope({
  groupClinicIds = [],
  directlyAccessibleClinicIds = [],
  manageableClinicIds = [],
  selectedClinicId = null,
  globalAdmin = false,
} = {}) {
  const groupIds = normalizeIds(groupClinicIds);
  const directIds = normalizeIds(directlyAccessibleClinicIds)
    .filter((clinicId) => groupIds.includes(clinicId));
  const manageableIds = normalizeIds(manageableClinicIds)
    .filter((clinicId) => directIds.includes(clinicId));
  const selected = Number.isInteger(Number(selectedClinicId)) && Number(selectedClinicId) > 0
    ? Number(selectedClinicId)
    : null;

  if (selected !== null && !groupIds.includes(selected)) {
    return { ready: false, reason: 'selected_clinic_forbidden', clinicIds: [] };
  }
  if (!globalAdmin && selected !== null && !directIds.includes(selected)) {
    return { ready: false, reason: 'selected_clinic_forbidden', clinicIds: directIds };
  }
  if (!globalAdmin && selected !== null && !manageableIds.includes(selected)) {
    return { ready: false, reason: 'lead_competition_forbidden', clinicIds: directIds };
  }
  if (!globalAdmin && selected === null && manageableIds.length === 0) {
    return { ready: false, reason: 'lead_competition_forbidden', clinicIds: directIds };
  }
  if (groupIds.length < 2) {
    return { ready: false, reason: 'not_enough_peer_clinics', clinicIds: groupIds };
  }

  return {
    ready: true,
    reason: null,
    clinicIds: groupIds,
  };
}

module.exports = {
  resolveLeadCompetitionPeerScope,
};
