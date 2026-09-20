'use strict';

const { normalizeBookingProfile } = require('./booking-profile');

const overlap = (start, end, interval) => start < new Date(interval.end) && new Date(interval.start) < end;

function isFree(resource, start, end) {
  return !!resource && resource.windows.some((window) => new Date(window.start) <= start && end <= new Date(window.end))
    && !(resource.busy || []).some((interval) => overlap(start, end, interval));
}

/**
 * No Cartesian product: alternatives are independent within a sequential phase.
 * ALL staff are required for the entire appointment, not merely their phase.
 * Inputs contain only schedules/occupancy, never patients or clinical notes.
 */
function solveBookingProfile({ profile: input, start, doctors, installations, clinicWindows = null, selections = {} }) {
  const profile = normalizeBookingProfile(input);
  const appointmentStart = new Date(start);
  const appointmentEnd = new Date(appointmentStart.getTime()
    + profile.phases.reduce((sum, phase) => sum + phase.duration_minutes, 0) * 60000);
  if (!Number.isFinite(appointmentStart.getTime())) return null;
  if (clinicWindows && !isFree({ windows: clinicWindows }, appointmentStart, appointmentEnd)) return null;
  let phaseStart = appointmentStart;
  const phases = [];
  const warnings = [];
  for (const phase of profile.phases) {
    const phaseEnd = new Date(phaseStart.getTime() + phase.duration_minutes * 60000);
    const selection = selections[phase.key] || {};
    const installationIds = selection.installation_id == null ? phase.installation_ids
      : phase.installation_ids.filter((id) => id === Number(selection.installation_id));
    const installationId = installationIds.find((id) => isFree(installations.get(id), phaseStart, phaseEnd));
    if (!installationId) return null;
    const staff = phase.professionals;
    let doctorIds;
    if (staff.mode === 'all') {
      if ((selection.doctor_id != null && (staff.ids.length !== 1 || Number(selection.doctor_id) !== staff.ids[0]))
        || !staff.ids.every((id) => isFree(doctors.get(id), appointmentStart, appointmentEnd))) return null;
      doctorIds = [...staff.ids];
    } else {
      const preferredFirst = [staff.preferred_id, ...staff.ids.filter((id) => id !== staff.preferred_id)].filter(Boolean);
      const eligible = selection.doctor_id == null ? preferredFirst
        : preferredFirst.filter((id) => id === Number(selection.doctor_id));
      const doctorId = eligible.find((id) => isFree(doctors.get(id), phaseStart, phaseEnd));
      if (!doctorId) return null;
      doctorIds = [doctorId];
      if (staff.preferred_id && doctorId !== staff.preferred_id) {
        warnings.push({
          code: 'NON_PREFERRED_PROFESSIONAL', phase_key: phase.key, doctor_id: doctorId,
          preferred_doctor_id: staff.preferred_id,
          preferred_available: isFree(doctors.get(staff.preferred_id), phaseStart, phaseEnd),
          // Do not say "the only one" if several alternatives actually fit.
          only_available_alternative: staff.ids.filter((id) => isFree(doctors.get(id), phaseStart, phaseEnd)).length === 1,
        });
      }
    }
    phases.push({ key: phase.key, label: phase.label, start_at: phaseStart.toISOString(), end_at: phaseEnd.toISOString(),
      installation_id: installationId, installation_name: installations.get(installationId)?.name || '',
      doctor_ids: doctorIds, doctor_names: doctorIds.map((id) => doctors.get(id)?.name || ''),
      staff_time_scope: staff.mode === 'all' ? 'appointment' : 'phase' });
    phaseStart = phaseEnd;
  }
  return { start_at: appointmentStart.toISOString(), end_at: appointmentEnd.toISOString(), phases, warnings,
    requires_priority_acknowledgement: warnings.length > 0 };
}

function occupancyForSolution(solution, installationKeys = new Map()) {
  const rows = [];
  solution.phases.forEach((phase) => {
    rows.push({ phase_key: phase.key, resource_kind: 'installation', resource_key: installationKeys.get(phase.installation_id) || `installation:${phase.installation_id}`,
      installation_id: phase.installation_id, doctor_id: null, start_at: phase.start_at, end_at: phase.end_at });
    phase.doctor_ids.forEach((doctorId) => rows.push({ phase_key: phase.key, resource_kind: 'doctor', resource_key: `doctor:${doctorId}`,
      doctor_id: doctorId, installation_id: null,
      start_at: phase.staff_time_scope === 'appointment' ? solution.start_at : phase.start_at,
      end_at: phase.staff_time_scope === 'appointment' ? solution.end_at : phase.end_at }));
  });
  // Retain phase references in the DTO; duplicate team rows need not occupy twice.
  return rows.filter((row, index) => rows.findIndex((candidate) => candidate.resource_key === row.resource_key
    && candidate.start_at === row.start_at && candidate.end_at === row.end_at) === index);
}

module.exports = { isFree, solveBookingProfile, occupancyForSolution };
