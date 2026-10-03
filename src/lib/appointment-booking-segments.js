'use strict';
const { normalizeBookingProfile } = require('./booking-profile');
const { validStaffIntervals, normalizeAttentionPolicy } = require('./booking-attention');

// Segments are projections of ONE appointment, never independent appointments.
function bookingSegments(appointment, { includeClinicalLabels = true } = {}) {
  const booking = appointment?.import_metadata?.booking;
  if (booking?.version !== 1 || !Array.isArray(booking.phases) || !booking.phases.length || booking.phases.length > 12) return [];
  let profile;
  try { profile = normalizeBookingProfile(booking.profile); } catch { return []; }
  if (!profile || profile.phases.length !== booking.phases.length) return [];
  let previousEnd = appointment.inicio ? new Date(appointment.inicio).getTime() : null;
  for (let index = 0; index < booking.phases.length; index++) {
    const phase = booking.phases[index];
    const requirement = profile.phases[index];
    const start = new Date(phase.start_at).getTime();
    const end = new Date(phase.end_at).getTime();
    if (phase.key !== requirement.key || !Number.isFinite(start) || !Number.isFinite(end)
      || end - start !== requirement.duration_minutes * 60000 || (previousEnd !== null && start !== previousEnd)
      || !requirement.installation_ids.includes(Number(phase.installation_id)) || !Array.isArray(phase.doctor_ids)
      || phase.doctor_ids.some((id) => !requirement.professionals.ids.includes(Number(id)))
      || phase.doctor_ids.length !== (requirement.professionals.mode === 'all' ? requirement.professionals.ids.length : 1)
      || new Set(phase.doctor_ids.map(Number)).size !== phase.doctor_ids.length
      || phase.staff_time_scope !== (requirement.professionals.mode === 'all' ? 'appointment' : 'phase')) return [];
    previousEnd = end;
    if (requirement.staff_attention) {
      // MySQL JSON reorders object keys. Compare normalized contracts, not the
      // serialization returned by the driver, and fail closed on bad snapshots.
      let attention;
      try { attention = phase.staff_attention?.map(normalizeAttentionPolicy); } catch { return []; }
      if (JSON.stringify(requirement.staff_attention) !== JSON.stringify(attention)
        || !validStaffIntervals(phase, requirement.staff_attention)) return [];
    }
    if (!requirement.staff_attention && phase.staff_intervals != null) return [];
    const requirements = requirement.equipment_requirements || [];
    if ((phase.equipment != null && !Array.isArray(phase.equipment))
      || (phase.equipment?.length || 0) !== requirements.length
      || (phase.equipment || []).some((unit, i) => !unit || !requirements[i].equipment_ids.includes(unit.id)
        || !Number.isInteger(unit.turnaround_minutes) || unit.turnaround_minutes < 0 || unit.turnaround_minutes > 120)) return [];
  }
  if (appointment.fin && previousEnd !== new Date(appointment.fin).getTime()) return [];
  return booking.phases.map((phase, index) => ({
    appointment_id: Number(appointment.id_cita),
    segment_key: `${appointment.id_cita}:${phase.key}`,
    phase_key: phase.key,
    phase_index: index + 1,
    phase_count: booking.phases.length,
    label: includeClinicalLabels ? phase.label || '' : '',
    start_at: phase.start_at,
    end_at: phase.end_at,
    installation_id: phase.installation_id,
    installation_name: phase.installation_name || '',
    doctor_ids: phase.doctor_ids,
    doctor_names: phase.doctor_names || [],
    staff_time_scope: phase.staff_time_scope,
    ...(phase.staff_intervals ? { staff_intervals: phase.staff_intervals.map(interval => ({ ...interval })) } : {}),
    ...(phase.equipment?.length ? { equipment: phase.equipment.map(unit => ({ id: unit.id, name: includeClinicalLabels ? unit.name || '' : '' })) } : {}),
  }));
}

module.exports = { bookingSegments };
