'use strict';

// Per-planning-request patient preferences, not treatment rules or a permission
// override. Only excluded clinic-local days are hard constraints.
const { domainError } = require('./treatmentPrograms.contract');
const { civilLocal } = require('./program-reschedule');
const { addDays } = require('./personal-schedule-recurring');
const invalid = () => { throw domainError(400, 'program_booking_preferences_invalid', 'Revisa las preferencias de días, hora y profesional.'); };
function normalizePreferences(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['exclude_weekdays', 'prefer_after_minutes', 'keep_professional'].includes(key))) invalid();
  const excluded = value.exclude_weekdays ?? [];
  if (!Array.isArray(excluded) || excluded.length > 7 || excluded.some(day => !Number.isInteger(day) || day < 0 || day > 6)
    || new Set(excluded).size !== excluded.length || value.prefer_after_minutes != null
      && (!Number.isInteger(value.prefer_after_minutes) || value.prefer_after_minutes < 0 || value.prefer_after_minutes > 1439)
    || value.keep_professional != null && typeof value.keep_professional !== 'boolean') invalid();
  const normalized = { ...(excluded.length ? { exclude_weekdays: excluded.slice().sort((a,b)=>a-b) } : {}),
    ...(value.prefer_after_minutes != null ? { prefer_after_minutes: value.prefer_after_minutes } : {}),
    ...(value.keep_professional ? { keep_professional: true } : {}) };
  return Object.keys(normalized).length ? normalized : null;
}
function allowedInterval(preferences, start, end, timeZone) {
  if (!preferences?.exclude_weekdays?.length) return true;
  const first = civilLocal(start, timeZone).slice(0,10), last = civilLocal(new Date(+new Date(end)-1), timeZone).slice(0,10);
  if (last < first || !Number.isFinite(+new Date(start)) || !Number.isFinite(+new Date(end))) return false;
  for (let day=first, count=0; day<=last; day=addDays(day,1), count++) {
    if (count > 3 || preferences.exclude_weekdays.includes(new Date(day+'T12:00:00Z').getUTCDay())) return false;
  }
  return true;
}
function assertAllowed(preferences, rows, timeZone) {
  const invalidRow=rows.find(row=>!allowedInterval(preferences,row.start_at,row.end_at,timeZone));
  if (invalidRow) throw domainError(409,'program_booking_preference_conflict',
    'Una cita coincide con un día excluido por el paciente. Revisa la propuesta o sus preferencias antes de confirmar.', {key:invalidRow.key});
}
function minuteOfDay(start,timeZone) { const local=civilLocal(start,timeZone); return Number(local.slice(11,13))*60+Number(local.slice(14,16)); }
function timeWarning(preferences, solution, timeZone) {
  return preferences?.prefer_after_minutes != null && minuteOfDay(solution.start_at,timeZone)<preferences.prefer_after_minutes
    ? [{code:'program_preference_time_fallback',message:'No se ha podido mantener la hora preferida en esta propuesta.'}] : [];
}
module.exports={normalizePreferences,allowedInterval,assertAllowed,minuteOfDay,timeWarning};
