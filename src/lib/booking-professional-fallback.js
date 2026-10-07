'use strict';

const { assessStaffAttention } = require('./booking-attention');
const ms = value => new Date(value).getTime();

/** Absence is schedule/typed absence evidence, never another appointment,
 * room incompatibility, maintenance, an untyped block or its free-text reason.
 * Flexible preparation considers the effective work, not the patient's whole
 * autonomous machine interval. Unknown schedules do not prove absence. */
function primaryAbsentForStep(resource, { start, end, policies, maxAttempts = 512 }) {
  if (!resource || !Number.isFinite(ms(start)) || !Number.isFinite(ms(end)) || ms(start) >= ms(end)) return false;
  const absences = (resource.absence_windows || []).filter(row => Number.isFinite(ms(row.start))
    && Number.isFinite(ms(row.end)) && ms(row.start) < ms(row.end));
  if (resource.schedule_verified !== true) return absences.some(row => ms(row.start) <= ms(start) && ms(row.end) >= ms(end));
  if (!Array.isArray(resource.windows) || resource.windows.some(row => !Number.isFinite(ms(row.start))
    || !Number.isFinite(ms(row.end)) || ms(row.start) >= ms(row.end))) return false;
  return assessStaffAttention({ resource: { windows: resource.windows || [], busy: absences }, start, end, policies, maxAttempts }).status === 'infeasible';
}

function professionalFallbackAllowed({ profileVersion, professionals, primary, start, end, policies, maxAttempts = 512 }) {
  if (profileVersion < 4 || professionals.mode !== 'any' || professionals.ids.length < 2) return true;
  if (professionals.fallback_when === 'unavailable') return true;
  return professionals.fallback_when === 'absence_only' && primaryAbsentForStep(primary, { start, end, policies, maxAttempts });
}

module.exports = { primaryAbsentForStep, professionalFallbackAllowed };
