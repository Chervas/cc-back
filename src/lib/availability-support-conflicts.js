'use strict';

const { inAnyWindow, formatLocal } = require('./availability-calendar');
const { installationAllowsStaff } = require('./installation-professionals');
const cleanName = value => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160);

// Read the already-loaded snapshot. Never query per slot, disclose a patient,
// foreign appointment/clinic ID, or allow force for simultaneous support.
function supportConflictsForSlot({ additionalStaffIds = [], supportContext, start, end, clinicaId, timeZone }) {
  return additionalStaffIds.flatMap(id => {
    const person = supportContext?.doctors.get(id);
    const name = cleanName(person?.name) || 'El personal de apoyo';
    const base = { resource_type: 'staff', resource_role: 'additional_staff', resource_id: id,
      clinica_id: clinicaId, can_force: false };
    if (!inAnyWindow(person?.windows || [], start, end)) return [{ ...base, code: 'STAFF_OUT_OF_HOURS',
      details: { message: `${name}: no tiene horario disponible en esta clínica para toda la cita.` } }];
    const overlapping = (person.busy || []).filter(row => new Date(row.start) < end && new Date(row.end) > start);
    if (!overlapping.length) return [];
    const occupied = overlapping.find(row => row.diagnostic?.kind === 'other_clinic') || overlapping[0];
    const appointment = occupied.appointment_id != null || ['appointment', 'other_clinic'].includes(occupied.diagnostic?.kind);
    const otherClinic = occupied.diagnostic?.kind === 'other_clinic';
    const first = formatLocal(new Date(occupied.start), timeZone).slice(11, 16);
    const last = formatLocal(new Date(occupied.end), timeZone).slice(11, 16);
    return [{ ...base, code: appointment ? 'STAFF_OVERLAP' : 'STAFF_BLOCKED', details: {
      message: `${name}: ${otherClinic ? 'ocupado en otra clínica' : appointment ? 'ocupado con otra cita' : 'no disponible'} de ${first} a ${last}.`,
      ...(otherClinic ? { other_clinic: true } : {}),
    } }];
  });
}

function installationStaffConflicts({ inst, doctorId, additionalStaffIds = [], supportContext, clinicaId }) {
  if (!inst || installationAllowsStaff(inst, [doctorId, ...additionalStaffIds].filter(Boolean).map(Number))) return [];
  const disallowed = additionalStaffIds.filter(id => !installationAllowsStaff(inst, [id]));
  const names = disallowed.map(id => cleanName(supportContext?.doctors.get(id)?.name) || 'El personal de apoyo');
  return [{ resource_type: 'installation', resource_id: Number(inst.id), clinica_id: clinicaId,
    code: 'INSTALLATION_PROFESSIONAL_NOT_ALLOWED', can_force: false,
    details: { message: names.length
      ? `${names.join(' / ')}: no está incluido entre los profesionales permitidos de ${cleanName(inst.nombre || inst.name) || 'esta sala'}.`
      : 'El profesional seleccionado no está autorizado para utilizar esta instalación.' } }];
}

module.exports = { supportConflictsForSlot, installationStaffConflicts };
