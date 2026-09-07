'use strict';

const crypto = require('node:crypto');

const STATUSES = Object.freeze(['pending', 'contacted', 'scheduled', 'closed', 'cancelled']);
const ACTIVE_STATUSES = Object.freeze(['pending', 'contacted']);
const SOURCE_DATE_SEMANTICS = Object.freeze(['clinical_target', 'contact_due', 'unknown']);

function domainError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function positiveInteger(value, field = 'id') {
  if (!/^[1-9]\d*$/.test(String(value ?? '')) || !Number.isSafeInteger(Number(value))) {
    throw domainError(400, 'follow_up_invalid_input', `${field} no es válido.`);
  }
  return Number(value);
}

function boundedText(value, field, max, required = false) {
  if (value != null && typeof value !== 'string') {
    throw domainError(400, 'follow_up_invalid_input', `${field} debe ser texto.`);
  }
  const text = (value || '').replace(/\r\n/g, '\n').trim();
  if (text.length > max || (required && !text)) {
    throw domainError(400, 'follow_up_invalid_input', `${field} debe tener entre ${required ? 1 : 0} y ${max} caracteres.`);
  }
  return text || null;
}

function dateOnly(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw domainError(400, 'follow_up_invalid_date', `${field} requiere una fecha AAAA-MM-DD.`);
  }
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value < '1900-01-01') {
    throw domainError(400, 'follow_up_invalid_date', `${field} no es una fecha válida.`);
  }
  return value;
}

function madridToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function addDays(date, days) {
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

// Calendar month, clipped to month end (31 March -> 28/29 February), not 30 days.
function previousMonth(date) {
  const [year, month, day] = dateOnly(date, 'clinical_target_date').split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month - 1, 0, 12)).getUTCDate();
  return new Date(Date.UTC(year, month - 2, Math.min(day, lastDay), 12)).toISOString().slice(0, 10);
}

function normalizeValues(payload, { creating = false, imported = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw domainError(400, 'follow_up_invalid_input', 'El seguimiento no es válido.');
  }
  const values = {};
  if (creating || Object.hasOwn(payload, 'operational_reason')) {
    values.operational_reason = boundedText(payload.operational_reason, 'Motivo', 500, true);
  }
  if (Object.hasOwn(payload, 'clinical_notes')) values.clinical_notes = boundedText(payload.clinical_notes, 'Notas clínicas', 10000);
  for (const key of ['clinical_target_date', 'contact_due_date']) {
    if (creating || Object.hasOwn(payload, key)) values[key] = dateOnly(payload[key], key);
  }
  for (const key of ['treatment_id', 'linked_appointment_id']) {
    if (Object.hasOwn(payload, key)) values[key] = payload[key] == null ? null : positiveInteger(payload[key], key);
  }
  if (creating || Object.hasOwn(payload, 'status')) {
    values.status = payload.status ?? 'pending';
    if (!STATUSES.includes(values.status)) throw domainError(400, 'follow_up_invalid_status', 'Estado de seguimiento no válido.');
  }
  if (creating && !imported && values.clinical_target_date && !Object.hasOwn(payload, 'contact_due_date')) {
    values.contact_due_date = previousMonth(values.clinical_target_date);
  }
  return values;
}

function sourceKey(kind, namespace, reference) {
  return crypto.createHash('sha256').update(JSON.stringify([kind, namespace, reference])).digest('hex');
}

function normalizeFilters(query, clinicId, patientId = null, namespace = 'patient-follow-ups') {
  const statusInput = query.status == null || query.status === '' ? [] : String(query.status).split(',');
  const statuses = [...new Set(statusInput)].sort();
  if (statuses.some((status) => !STATUSES.includes(status))) throw domainError(400, 'follow_up_invalid_status', 'Filtro de estado no válido.');
  const dueBefore = dateOnly(query.due_before, 'due_before');
  const dueAfter = dateOnly(query.due_after, 'due_after');
  if (dueBefore && dueAfter && dueBefore < dueAfter) throw domainError(400, 'follow_up_invalid_date', 'El intervalo de contacto no es válido.');
  const limit = query.limit == null ? 30 : positiveInteger(query.limit, 'limit');
  if (limit > 100) throw domainError(400, 'follow_up_invalid_input', 'El máximo es 100 seguimientos por página.');
  const sort = query.sort || 'newest';
  if (!['newest', 'contact_due'].includes(sort)) throw domainError(400, 'follow_up_invalid_input', 'Orden no válido.');
  const scope = sourceKey('page', namespace, JSON.stringify({ clinicId, patientId, statuses, dueBefore, dueAfter, sort }));
  let afterId = null;
  let afterDate = null;
  if (query.cursor) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (cursor.v !== 1 || cursor.scope !== scope) throw new Error();
      afterId = positiveInteger(cursor.id);
      if (sort === 'contact_due') {
        afterDate = dateOnly(cursor.date, 'cursor.date');
        if (!afterDate) throw new Error();
      }
    } catch {
      throw domainError(400, 'follow_up_invalid_cursor', 'La página no corresponde a estos filtros.');
    }
  }
  return { statuses, dueBefore, dueAfter, limit, scope, afterId, afterDate, sort };
}

function makeCursor(id, scope, date = null) {
  return Buffer.from(JSON.stringify({ v: 1, id: positiveInteger(id), scope, ...(date ? { date } : {}) })).toString('base64url');
}

module.exports = {
  STATUSES, ACTIVE_STATUSES, SOURCE_DATE_SEMANTICS, domainError, positiveInteger,
  boundedText, dateOnly, madridToday, addDays, previousMonth, normalizeValues,
  sourceKey, normalizeFilters, makeCursor,
};
