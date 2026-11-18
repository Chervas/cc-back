'use strict';

// Per-channel intent lives in campaign criteria; existing dispatch jobs keep their own due dates.
const VERSION = 1;
const TIMEZONE = 'Europe/Madrid';
const CHANNELS = ['whatsapp', 'email'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function failure(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
const invalid = () => failure('channel_schedule_invalid', 'Revisa la programación de cada canal.');
function selectedChannels(channels) {
  return CHANNELS.filter(channel => Array.isArray(channels) && channels.includes(channel));
}
function normalizeEntry(entry) {
  if (!object(entry) || Object.keys(entry).some(key => !['mode', 'scheduled_at'].includes(key))
    || !['now', 'scheduled'].includes(entry.mode)) throw invalid();
  if (entry.mode === 'now') {
    if (entry.scheduled_at != null && entry.scheduled_at !== '') throw invalid();
    return { mode: 'now', scheduled_at: null };
  }
  const value = entry.scheduled_at;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw invalid();
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59) throw invalid();
  return { mode: 'scheduled', scheduled_at: new Date(value).toISOString() };
}
function normalizeBundle(raw, channels) {
  if (!object(raw) || raw.version !== VERSION || raw.timezone !== TIMEZONE || !object(raw.channels)
    || Object.keys(raw).some(key => !['version', 'timezone', 'channels'].includes(key))
    || Object.keys(raw.channels).some(channel => !CHANNELS.includes(channel))) throw invalid();
  const entries = {};
  for (const channel of selectedChannels(channels)) {
    if (!own(raw.channels, channel)) throw invalid();
    entries[channel] = normalizeEntry(raw.channels[channel]);
  }
  return { version: VERSION, timezone: TIMEZONE, channels: entries };
}
function legacyEntry(criteria = {}, body = {}) {
  const at = own(body, 'scheduled_at') ? body.scheduled_at : criteria.scheduled_at;
  const mode = own(body, 'schedule_mode') ? body.schedule_mode : criteria.schedule_mode || (at ? 'scheduled' : 'now');
  return normalizeEntry({ mode, scheduled_at: mode === 'scheduled' ? at : null });
}
function legacyProjection(bundle) {
  // Old WhatsApp consumers must never see the earlier email date as their due date.
  const entry = bundle.channels.whatsapp || bundle.channels.email || { mode: 'now', scheduled_at: null };
  return { schedule_mode: entry.mode, scheduled_at: entry.scheduled_at };
}
function resolveSchedules(criteria = {}, body = {}, channels = [], { requireFuture = false, now = Date.now() } = {}) {
  let bundle;
  if (own(body, 'channel_schedules')) {
    bundle = normalizeBundle(body.channel_schedules, channels);
  } else if (criteria.channel_schedules) {
    bundle = normalizeBundle(criteria.channel_schedules, channels);
    if (own(body, 'schedule_mode') || own(body, 'scheduled_at')) {
      const proposed = legacyEntry(criteria, body), expected = legacyProjection(bundle);
      if (proposed.mode !== expected.schedule_mode || proposed.scheduled_at !== expected.scheduled_at) {
        throw failure('channel_schedule_version_conflict', 'Esta campaña tiene horarios por canal. Actualiza la pantalla antes de cambiar su programación.', 409);
      }
    }
  } else {
    const entry = legacyEntry(criteria, body);
    bundle = { version: VERSION, timezone: TIMEZONE,
      channels: Object.fromEntries(selectedChannels(channels).map(channel => [channel, { ...entry }])) };
  }
  if (requireFuture) {
    const instant = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(instant)) throw invalid();
    for (const [channel, entry] of Object.entries(bundle.channels)) {
      if (entry.mode === 'scheduled' && Date.parse(entry.scheduled_at) <= instant) {
        throw failure('channel_schedule_expired', `La fecha de envío de ${channel === 'email' ? 'email' : 'WhatsApp'} ya ha pasado. Elige otra fecha antes de enviar.`, 409);
      }
    }
  }
  return bundle;
}
function persistScheduleCriteria(criteria = {}, body = {}, channels = [], { list = null, requireFuture = false, now } = {}) {
  const explicit = own(body, 'channel_schedules');
  const legacyEdit = own(body, 'schedule_mode') || own(body, 'scheduled_at');
  if (!explicit && !criteria.channel_schedules && !legacyEdit) return {};
  const bundle = resolveSchedules(criteria, body, channels, { requireFuture, ...(now === undefined ? {} : { now }) });
  if (explicit && list && (list.email_dispatch?.job_id || criteria.dispatch?.job_id)) {
    const current = resolveSchedules(criteria, {}, channels);
    if (JSON.stringify(current) !== JSON.stringify(bundle)) {
      throw failure('channel_schedule_already_queued', 'La campaña ya tiene trabajos en cola. No se ha cambiado su programación.', 409);
    }
  }
  return { ...legacyProjection(bundle), ...((explicit || criteria.channel_schedules) ? { channel_schedules: bundle } : {}) };
}
function scheduledAtFor(bundle, channel, { resume = false, now = Date.now() } = {}) {
  const entry = bundle?.channels?.[channel];
  if (!entry || entry.mode !== 'scheduled') return null;
  return resume && Date.parse(entry.scheduled_at) <= Number(now) ? null : entry.scheduled_at;
}
function campaignStatus(list, overrides = {}, fallback = list?.status) {
  if (list?.status === 'archived') return 'archived';
  if (!list?.criteria?.channel_schedules) return fallback;
  const channels = selectedChannels(list.criteria.channels || String(list.action_mode || list.channel || '').split(','));
  const states = channels.map(channel => String(overrides[channel]
    || (channel === 'email' ? list.email_dispatch?.status : list.criteria.dispatch?.status) || 'prepared'));
  if (states.some(state => ['sending', 'queued', 'waiting_next_batch', 'awaiting_delivery'].includes(state))) return 'sending';
  if (states.includes('scheduled')) return 'scheduled';
  if (states.some(state => state.startsWith('paused') || ['held_meta', 'held_quality'].includes(state))) return 'paused';
  if (states.includes('failed')) return 'failed';
  if (states.length && states.every(state => state === 'cancelled')) return 'cancelled';
  if (states.length && states.every(state => ['completed', 'cancelled'].includes(state))) return 'completed';
  return fallback;
}
module.exports = { VERSION, TIMEZONE, normalizeBundle, resolveSchedules, legacyProjection,
  persistScheduleCriteria, scheduledAtFor, campaignStatus };
