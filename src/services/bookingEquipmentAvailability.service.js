'use strict';

const { equipmentIds, equipmentError, clinicUsesEquipment, normalizeRoomEquipmentPolicy, equipmentFitsRoom } = require('../lib/booking-equipment');

function equipmentRuntimeEnabled(env = process.env) {
  return env.BOOKING_EQUIPMENT_ENABLED === 'true' && env.BOOKING_PROFILES_ENABLED === 'true'
    && env.BOOKING_MULTI_RESOURCE_ENABLED === 'true';
}
function assertEquipmentEnabled(clinic, enabled = equipmentRuntimeEnabled()) {
  if (!enabled || !clinicUsesEquipment(clinic)) throw equipmentError('disabled',
    'Este tratamiento necesita maquinaria. Su reserva todavía no está habilitada en esta clínica.', 409);
}

// Exactly three bulk metadata reads for a profile using equipment; ZERO for
// all other profiles, including psychology in a multidisciplinary clinic.
async function loadEquipmentContext({ db, clinic, profile, mapping, transaction = null, enabled = equipmentRuntimeEnabled() }) {
  const ids = equipmentIds(profile);
  if (!ids.length) return null;
  assertEquipmentEnabled(clinic, enabled);
  if (ids.length > 50) throw equipmentError('limit', 'Planifica menos equipos a la vez.');
  const { Op } = db.Sequelize;
  const physicalIds = [...new Set([...mapping.keys.values()].map(key => Number(key.split(':')[1])))];
  const [rows, shares, policies] = await Promise.all([
    db.BookingEquipment.findAll({ where: { id: { [Op.in]: ids } }, include: [{ model: db.Clinica, as: 'owner_clinic',
      attributes: ['id_clinica', 'grupoClinicaId'] }], transaction }),
    db.BookingEquipmentClinic.findAll({ where: { clinic_id: Number(clinic.id_clinica), equipment_id: { [Op.in]: ids } }, transaction }),
    db.BookingEquipmentRoomPolicy.findAll({ where: { installation_id: { [Op.in]: physicalIds } }, transaction }),
  ]);
  const permitted = new Set(shares.map(row => Number(row.equipment_id)));
  if (rows.length !== ids.length || rows.some(row => !permitted.has(Number(row.id)) || !row.owner_clinic
    || (Number(row.owner_clinic_id) !== Number(clinic.id_clinica)
      && (!Number(clinic.grupoClinicaId) || Number(row.group_id) !== Number(clinic.grupoClinicaId)
        || Number(row.owner_clinic.grupoClinicaId) !== Number(clinic.grupoClinicaId))))) {
    throw equipmentError('scope', 'Hay un equipo que no está autorizado para esta clínica.', 409);
  }
  const roomPolicies = new Map(policies.map(row => [Number(row.installation_id), normalizeRoomEquipmentPolicy({
    mode: row.mode, equipment_ids: row.equipment_ids || [],
  })]));
  const equipment = new Map(rows.map(row => [Number(row.id), {
    id: Number(row.id), name: row.name, family_key: row.family_key, status: row.status, mobility: row.mobility,
    turnaround_minutes: Number(row.turnaround_minutes), busy: [],
    fixed_resource_key: row.home_installation_id ? (mapping.keys.get(Number(row.home_installation_id)) || `installation:${row.home_installation_id}`) : null,
  }]));
  for (const phase of profile.phases) for (const group of phase.equipment_requirements || []) {
    if (new Set(group.equipment_ids.map(id => equipment.get(id)?.family_key)).size !== 1) {
      throw equipmentError('alternatives', 'Las unidades alternativas deben pertenecer al mismo tipo de equipo.');
    }
  }
  return { equipment, roomPolicies, keys: ids.map(id => `equipment:${id}`) };
}

function attachEquipmentContext(loaded, cabins, mapping, busy) {
  if (!loaded) return {};
  for (const [id, room] of cabins) {
    room.resource_key = mapping.keys.get(id);
    room.equipment_policy = loaded.roomPolicies.get(Number(room.resource_key.split(':')[1])) || { mode: 'none', equipment_ids: [] };
  }
  for (const [id, unit] of loaded.equipment) {
    unit.busy = busy.get(`equipment:${id}`) || [];
    // Precompute compatibility once, not once for every candidate time.
    unit.installation_ids = new Set([...cabins].filter(([, room]) => equipmentFitsRoom(unit, room)).map(([roomId]) => roomId));
  }
  return { equipment: loaded.equipment };
}

module.exports = { equipmentRuntimeEnabled, assertEquipmentEnabled, loadEquipmentContext, attachEquipmentContext };
