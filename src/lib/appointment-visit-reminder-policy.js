'use strict';

// No template lookup, clock, bootstrap or send. The normalized configuration
// below comes from the EXISTING appointment automation selector, never HTTP.
const v = require('./appointment-visit-communication');
const calendar = require('./availability-calendar');
const SCHEMA = 'appointment-visit-reminder-binding/1';
const KEYS = ['schedule_moment', 'schedule_time_mode', 'custom_time', 'exclude_if_booked_day_before',
  'exclude_if_booked_same_day', 'exclude_if_not_confirmed', 'only_if_not_confirmed'];
const fail = suffix => v.fail('runtime_reminder_' + suffix);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
function policy(value) {
  if (!exact(value, KEYS) || !['day_before', 'same_day'].includes(value.schedule_moment)
    || !['custom', 'one_hour_before'].includes(value.schedule_time_mode)
    || KEYS.slice(3).some(key => typeof value[key] !== 'boolean') || value.only_if_not_confirmed
    || value.schedule_time_mode === 'one_hour_before' && (value.schedule_moment !== 'same_day' || value.custom_time !== null)
    || value.schedule_time_mode === 'custom' && !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.custom_time)) fail('policy_unsupported');
  return v.clone(value);
}
function binding({ templateVersionId, stageKey, schedulePolicy, fireGraceMs }) {
  const normalized = policy(schedulePolicy);
  if (!v.positiveId(templateVersionId) || stageKey !== 'attendance_' + normalized.schedule_moment
    || !Number.isInteger(fireGraceMs) || fireGraceMs <= 0 || fireGraceMs > 86400000) fail('binding_invalid');
  return { schema: SCHEMA, template_version_id: templateVersionId, stage_key: stageKey,
    schedule_policy: normalized, fire_grace_ms: fireGraceMs };
}
function normalizeBinding(value) {
  if (!exact(value, ['schema', 'template_version_id', 'stage_key', 'schedule_policy', 'fire_grace_ms']) || value.schema !== SCHEMA) fail('binding_invalid');
  return binding({ templateVersionId: value.template_version_id, stageKey: value.stage_key,
    schedulePolicy: value.schedule_policy, fireGraceMs: value.fire_grace_ms });
}
function normalizeBindings(values) {
  if (!Array.isArray(values) || values.length > 2) fail('bindings_invalid');
  const rows = values.map(normalizeBinding).sort((a,b) => a.stage_key.localeCompare(b.stage_key));
  if (new Set(rows.map(row => row.stage_key)).size !== rows.length) fail('bindings_ambiguous');
  return rows;
}
function selectedBinding(enrollment, templateVersionId, stageKey) {
  const found = normalizeBindings(enrollment.reminder_bindings).find(row => row.template_version_id === templateVersionId && row.stage_key === stageKey);
  if (!found) fail('stage_not_selected');
  return found;
}
function addDays(date, days) {
  const next = new Date(date + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + days); return next.toISOString().slice(0, 10);
}
function scheduledBounds(raw, startAt, zone) {
  const selected = normalizeBinding(raw), config = selected.schedule_policy;
  const start = v.instant(startAt);
  if (!calendar.isValidTimeZone(zone)) fail('window_invalid');
  const date = calendar.formatDateLocal(new Date(start), zone);
  const target = config.schedule_moment === 'day_before' ? addDays(date, -1) : date;
  const at = config.schedule_time_mode === 'one_hour_before' ? Date.parse(start) - 3600000
    : +calendar.localDateTimeToUtc(target, config.custom_time + ':00', zone);
  const cutoff = config.schedule_moment === 'day_before' ? +calendar.localDateTimeToUtc(date, '00:00:00', zone) : Date.parse(start);
  if (config.schedule_moment === 'same_day' && at < +calendar.localDateTimeToUtc(date, '00:00:00', zone)) fail('window_policy_unsupported');
  const ends = Math.min(cutoff, at + selected.fire_grace_ms, Date.parse(start));
  return { selected, date, at, ends };
}
function window({ enrollment, startAt, binding: raw, anchorAt }) {
  const { selected, date, at, ends } = scheduledBounds(raw, startAt, enrollment.time_zone), config = selected.schedule_policy;
  const anchor = v.instant(anchorAt), booked = calendar.formatDateLocal(new Date(v.instant(enrollment.reminder_booked_at)), enrollment.time_zone);
  if (config.exclude_if_booked_same_day && booked === date
    || config.exclude_if_booked_day_before && booked === addDays(date, -1)) fail('booking_window_excluded');
  // New booking/movement after the configured instant never manufactures a
  // retroactive reminder. Restart can discover an ALREADY frozen due intent.
  if (!Number.isFinite(at) || at >= ends || at <= Date.parse(anchor)) fail('window_not_future');
  return v.normalizeWindow({ key: config.schedule_moment + ':' + date, starts_at: new Date(at), ends_at: new Date(ends) });
}
module.exports = { SCHEMA, policy, binding, normalizeBinding, normalizeBindings, selectedBinding, scheduledBounds, window };
