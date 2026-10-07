'use strict';

// Lists are a read scope, never a single clinic for a mutation.
function agendaClinicIds(value) {
  if (value == null || value === '' || value === 'all') return null;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  if (!parts.length || parts.some(part => !/^\d+$/.test(String(part).trim())
    || !Number.isSafeInteger(Number(part)) || Number(part) <= 0)) {
    const error = new Error('clinic_scope_invalid'); error.status = 400; throw error;
  }
  return [...new Set(parts.map(Number))];
}

async function agendaPeerClinicIds({ db, actorId, clinicIds, includePeers, authorize }) {
  if (!includePeers || clinicIds.length !== 1) return clinicIds;
  const clinic = await db.Clinica.findByPk(clinicIds[0], { attributes: ['id_clinica', 'grupoClinicaId'], raw: true });
  if (!clinic?.grupoClinicaId) return clinicIds;
  const peers = await db.Clinica.findAll({ where: { grupoClinicaId: clinic.grupoClinicaId }, attributes: ['id_clinica'], raw: true });
  const requested = peers.map(row => Number(row.id_clinica));
  const allowed = await authorize({ actorId, featureKey: 'appointments.view', clinicIds: requested });
  // Even a permissive provider must not widen this to an unrelated group.
  return [...new Set([...clinicIds, ...allowed.filter(id => requested.includes(Number(id))).map(Number)])];
}

function agendaInstallationAliases(rows, visibleInstallationIds) {
  const visible = new Set(visibleInstallationIds.map(Number));
  const groups = new Map();
  for (const row of rows) {
    const id = Number(row.installation_id), canonical = Number(row.canonical_installation_id);
    if (!visible.has(id) || !visible.has(canonical) || !row.group_id) continue;
    const key = `${row.group_id}:${canonical}`;
    const members = groups.get(key) || new Set([canonical]); members.add(id); groups.set(key, members);
  }
  const result = {};
  for (const members of groups.values()) for (const id of members) result[id] = [...members];
  return result;
}

module.exports = { agendaClinicIds, agendaPeerClinicIds, agendaInstallationAliases };
