'use strict';

const { normalizeBookingProfile } = require('./booking-profile');
const { installationAllowsStaff } = require('./installation-professionals');

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
function solveBookingProfile({ profile: input, start, doctors, installations, equipment = null, clinicWindows = null, selections = {} }) {
  const profile = normalizeBookingProfile(input);
  const appointmentStart = new Date(start);
  const appointmentEnd = new Date(appointmentStart.getTime()
    + profile.phases.reduce((sum, phase) => sum + phase.duration_minutes, 0) * 60000);
  if (!Number.isFinite(appointmentStart.getTime())) return null;
  if (clinicWindows && !isFree({ windows: clinicWindows }, appointmentStart, appointmentEnd)) return null;
  let phaseStart = appointmentStart;
  const phases = [];
  const warnings = [];
  const usedEquipment = new Map();
  for (const phase of profile.phases) {
    const phaseEnd = new Date(phaseStart.getTime() + phase.duration_minutes * 60000);
    const selection = selections[phase.key] || {};
    const installationIds = selection.installation_id == null ? phase.installation_ids
      : phase.installation_ids.filter((id) => id === Number(selection.installation_id));
    const equipmentChoices = new Map();
    const requirements = phase.equipment_requirements || [];
    const freeInstallations = installationIds.filter((id) => {
      if (!isFree(installations.get(id), phaseStart, phaseEnd)) return false;
      if (!requirements.length) return true;
      if (!equipment) return false;
      const chosen = [];
      for (const group of requirements) {
        const unit = group.equipment_ids.map(eid => equipment.get(eid)).find(candidate => {
          if (!candidate || candidate.status !== 'available' || !candidate.installation_ids.has(id)) return false;
          const bufferedEnd = new Date(phaseEnd.getTime() + candidate.turnaround_minutes * 60000);
          if (candidate.busy.some(interval => overlap(phaseStart, bufferedEnd, interval))) return false;
          const previous = usedEquipment.get(candidate.id);
          return !previous || previous.resource_key === installations.get(id).resource_key
            || previous.end + candidate.turnaround_minutes * 60000 <= phaseStart.getTime();
        });
        if (!unit) return false;
        chosen.push(unit);
      }
      equipmentChoices.set(id, chosen);
      return true;
    });
    let installationId;
    const staff = phase.professionals;
    let doctorIds;
    if (staff.mode === 'all') {
      if ((selection.doctor_id != null && (staff.ids.length !== 1 || Number(selection.doctor_id) !== staff.ids[0]))
        || !staff.ids.every((id) => isFree(doctors.get(id), appointmentStart, appointmentEnd))) return null;
      doctorIds = [...staff.ids];
      installationId = freeInstallations.find(id => installationAllowsStaff(installations.get(id), doctorIds));
      if (!installationId) return null;
    } else {
      const preferredFirst = [staff.preferred_id, ...staff.ids.filter((id) => id !== staff.preferred_id)].filter(Boolean);
      const eligible = selection.doctor_id == null ? preferredFirst
        : preferredFirst.filter((id) => id === Number(selection.doctor_id));
      const fits = id => isFree(doctors.get(id), phaseStart, phaseEnd)
        && freeInstallations.some(roomId => installationAllowsStaff(installations.get(roomId), [id]));
      const doctorId = eligible.find(fits);
      if (!doctorId) return null;
      doctorIds = [doctorId];
      installationId = freeInstallations.find(id => installationAllowsStaff(installations.get(id), doctorIds));
      if (staff.preferred_id && doctorId !== staff.preferred_id) {
        warnings.push({
          code: 'NON_PREFERRED_PROFESSIONAL', phase_key: phase.key, doctor_id: doctorId,
          preferred_doctor_id: staff.preferred_id,
          preferred_available: fits(staff.preferred_id),
          // Do not say "the only one" if several alternatives actually fit.
          only_available_alternative: staff.ids.filter(fits).length === 1,
        });
      }
    }
    phases.push({ key: phase.key, label: phase.label, start_at: phaseStart.toISOString(), end_at: phaseEnd.toISOString(),
      installation_id: installationId, installation_name: installations.get(installationId)?.name || '',
      doctor_ids: doctorIds, doctor_names: doctorIds.map((id) => doctors.get(id)?.name || ''),
      staff_time_scope: staff.mode === 'all' ? 'appointment' : 'phase',
      ...(requirements.length ? { equipment: equipmentChoices.get(installationId).map(unit => ({
        id: unit.id, name: unit.name, turnaround_minutes: unit.turnaround_minutes,
      })) } : {}) });
    for (const unit of equipmentChoices.get(installationId) || []) usedEquipment.set(unit.id, {
      resource_key: installations.get(installationId).resource_key, end: phaseEnd.getTime(),
    });
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
    (phase.equipment || []).forEach(unit => rows.push({ phase_key: phase.key, resource_kind: 'equipment', resource_key: `equipment:${unit.id}`,
      installation_id: null, doctor_id: null, start_at: phase.start_at,
      end_at: new Date(new Date(phase.end_at).getTime() + unit.turnaround_minutes * 60000).toISOString() }));
  });
  // Retain phase references in the DTO; duplicate team rows need not occupy twice.
  return rows.filter((row, index) => rows.findIndex((candidate) => candidate.resource_key === row.resource_key
    && candidate.start_at === row.start_at && candidate.end_at === row.end_at) === index);
}

module.exports = { isFree, solveBookingProfile, occupancyForSolution };
