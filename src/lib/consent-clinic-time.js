'use strict';

const { resolveClinicTimezone } = require('./availability-calendar');

// SQL/API instants are UTC unless they carry an explicit offset. Avoid the
// host's timezone when a database string has no offset. Calendar dates (DOB)
// are handled separately and are never shifted across a day boundary.
function instant(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) {
    return new Date(value.replace(' ', 'T') + 'Z');
  }
  return new Date(value);
}
function formatDateTime(value, timeZone) {
  if (!value) return '';
  const date = instant(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString('es-ES', { timeZone: resolveClinicTimezone({ time_zone: timeZone }),
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatDateOnly(value, timeZone) {
  if (!value) return '';
  const date = instant(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleDateString('es-ES', { timeZone: resolveClinicTimezone({ time_zone: timeZone }),
    day: '2-digit', month: '2-digit', year: 'numeric' });
}
function calendarDate(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T| )/.exec(value);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    const display = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
    if (display) return `${display[3]}-${display[2]}-${display[1]}`;
  }
  const date = instant(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}
function formatCalendarDate(value) {
  const date = calendarDate(value);
  return date ? date.split('-').reverse().join('/') : value ? String(value) : '';
}
function localCalendarDate(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: resolveClinicTimezone({ time_zone: timeZone }),
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant(value));
  const part = key => parts.find(item => item.type === key)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function isMinor(birthValue, { now = new Date(), timeZone } = {}) {
  const birth = calendarDate(birthValue);
  if (!birth) return false;
  const today = localCalendarDate(now, timeZone);
  let age = Number(today.slice(0, 4)) - Number(birth.slice(0, 4));
  if (today.slice(5) < birth.slice(5)) age--;
  return age < 18;
}
function documentTimezone(document) {
  const doc = document?.toJSON ? document.toJSON() : document;
  let snapshot = doc?.snapshot_json;
  if (typeof snapshot === 'string') { try { snapshot = JSON.parse(snapshot); } catch { snapshot = {}; } }
  // Display current clinic time; a detached historical document retains its
  // frozen clinic zone. Neither path rewrites its signed context or legal body.
  return resolveClinicTimezone(doc?.clinica || snapshot?.context?.clinica);
}
module.exports = { resolveClinicTimezone, formatDateTime, formatDateOnly, formatCalendarDate,
  calendarDate, localCalendarDate, isMinor, documentTimezone };
