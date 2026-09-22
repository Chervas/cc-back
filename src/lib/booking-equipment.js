'use strict';

// Pure contracts. No ORM, timers, caches or provider calls on the ordinary path.
function equipmentError(code, message, status = 422) {
  const error = new Error(message);
  error.code = `booking_equipment_${code}`;
  error.status = error.statusCode = status;
  return error;
}
function positiveIds(value, max = 50) {
  if (!Array.isArray(value) || value.length > max || value.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw equipmentError('invalid', 'Selecciona equipos válidos.');
  }
  return [...new Set(value)];
}
function normalizeEquipmentRequirements(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8) throw equipmentError('invalid', 'Una fase admite hasta ocho equipos necesarios.');
  const used = new Set();
  return value.map(group => {
    if (!group || Object.keys(group).some(key => key !== 'equipment_ids')) throw equipmentError('invalid', 'Revisa los equipos necesarios.');
    const ids = positiveIds(group.equipment_ids, 8);
    if (!ids.length || ids.some(id => used.has(id))) throw equipmentError('invalid', 'No repitas una máquina entre requisitos de la misma fase.');
    ids.forEach(id => used.add(id));
    return { equipment_ids: ids };
  });
}
function equipmentIds(profile) {
  return [...new Set((profile?.phases || []).flatMap(phase =>
    (phase.equipment_requirements || []).flatMap(group => group.equipment_ids)))].sort((a, b) => a - b);
}
function clinicUsesEquipment(clinic) {
  return clinic?.equipment_booking_enabled === true || clinic?.equipment_booking_enabled === 1;
}
function normalizeRoomEquipmentPolicy(value) {
  if (!value || !['none', 'all', 'selected'].includes(value.mode)) throw equipmentError('policy_invalid', 'Indica si la cabina admite equipos móviles.');
  const ids = positiveIds(value.equipment_ids || []);
  if ((value.mode === 'selected') !== (ids.length > 0)) throw equipmentError('policy_invalid', 'Selecciona los equipos permitidos o cambia la opción de cabina.');
  return { mode: value.mode, equipment_ids: ids };
}
function equipmentFitsRoom(unit, room) {
  if (!unit || !room || unit.status !== 'available') return false;
  if (unit.mobility === 'fixed') return unit.fixed_resource_key === room.resource_key;
  const policy = room.equipment_policy;
  return unit.mobility === 'mobile' && !!policy && (policy.mode === 'all'
    || (policy.mode === 'selected' && policy.equipment_ids.includes(unit.id)));
}
function normalizeEquipmentUnit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw equipmentError('invalid', 'Equipo no válido.');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const family = typeof value.family_key === 'string' ? value.family_key.trim() : '';
  if (!name || name.length > 120 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(family)) throw equipmentError('invalid', 'Indica el nombre y el tipo de equipo.');
  if (!['fixed', 'mobile'].includes(value.mobility) || !['available', 'maintenance', 'unavailable'].includes(value.status)) {
    throw equipmentError('invalid', 'Revisa la movilidad y el estado del equipo.');
  }
  const aliases = value.aliases || [];
  if (!Array.isArray(aliases) || aliases.length > 12 || aliases.some(s => typeof s !== 'string' || !s.trim() || s.length > 120)) throw equipmentError('invalid', 'Revisa los nombres alternativos.');
  const minutes = value.turnaround_minutes ?? 0;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 120) throw equipmentError('invalid', 'El margen entre usos debe estar entre 0 y 120 minutos.');
  const home = value.home_installation_id ?? null;
  if ((home !== null && (!Number.isSafeInteger(home) || home < 1)) || (value.mobility === 'fixed' && !home)) throw equipmentError('invalid', 'Un equipo fijo necesita su cabina.');
  return { name, family_key: family, aliases: [...new Set(aliases.map(s => s.trim()))], mobility: value.mobility,
    status: value.status, home_installation_id: home, turnaround_minutes: minutes };
}

module.exports = { equipmentError, positiveIds, normalizeEquipmentRequirements, equipmentIds,
  clinicUsesEquipment, normalizeRoomEquipmentPolicy, equipmentFitsRoom, normalizeEquipmentUnit };
