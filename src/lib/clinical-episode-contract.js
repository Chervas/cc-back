'use strict';

const crypto = require('node:crypto');
const TEXT_FIELDS = Object.freeze(['reason', 'summary', 'findings', 'interventions', 'outcome', 'plan', 'next_steps', 'private_notes']);
const TEMPLATE_KEYS = Object.freeze(['general', 'estetica', 'capilar', 'nutricion']);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function error(statusCode, code, message, details) {
  return Object.assign(new Error(message), { statusCode, code, ...(details ? { details } : {}) });
}
function integer(value, field = 'id') {
  if (!(typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw error(400, 'clinical_episode_invalid_identifier', `El campo ${field} no es válido.`, { field });
  }
  return Number(value);
}
function text(value, field, max = 20000) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.includes('\0') || Array.from(value).length > max
    || Buffer.byteLength(value, 'utf8') > 65535) {
    throw error(400, 'clinical_episode_invalid_text', `Revisa el campo ${field}.`, { field });
  }
  return value.replace(/\r\n/g, '\n').trim() || null;
}
function timestamp(value, field = 'occurred_at') {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw error(400, 'clinical_episode_invalid_date', 'Indica una fecha y hora válidas.', { field });
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || (second || 0) > 59) {
    throw error(400, 'clinical_episode_invalid_date', 'Indica una fecha y hora válidas.', { field });
  }
  return new Date(value).toISOString();
}
function appointmentIds(value) {
  if (!Array.isArray(value) || value.length > 50) throw error(400, 'clinical_episode_invalid_appointments', 'Selecciona como máximo 50 citas.');
  const ids = value.map(id => integer(id, 'appointment_ids'));
  if (new Set(ids).size !== ids.length) throw error(400, 'clinical_episode_duplicate_appointment', 'Hay una cita repetida.');
  return ids;
}
function idempotencyKey(value, required = false) {
  if (value === undefined && !required) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(value)) {
    throw error(400, 'clinical_episode_idempotency_required', 'Vuelve a intentar la operación con una clave de solicitud válida.');
  }
  return value;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function plainDocument(value) {
  const source = value || '';
  return { ops: [{ insert: source.endsWith('\n') ? source : source + '\n' }] };
}
function documentText(document) {
  return document.ops.map(operation => operation.insert).join('').replace(/\n$/, '');
}
// The document uses the same small Quill Delta vocabulary as the native H3
// editor. No HTML, embeds, remote images, links, arbitrary formats or actions.
function safeDocument(value) {
  if (!object(value) || Object.keys(value).some(key => key !== 'ops') || !Array.isArray(value.ops) || value.ops.length > 2500) {
    throw error(400, 'clinical_episode_invalid_document', 'El documento clínico no es válido.');
  }
  const ops = value.ops.map(operation => {
    if (!object(operation) || typeof operation.insert !== 'string' || operation.insert.includes('\0')
      || Object.keys(operation).some(key => !['insert', 'attributes'].includes(key))) {
      throw error(400, 'clinical_episode_invalid_document', 'El documento contiene un formato no permitido.');
    }
    const out = { insert: operation.insert.replace(/\r\n/g, '\n') };
    if (operation.attributes !== undefined) {
      if (!object(operation.attributes) || Object.keys(operation.attributes).some(key => !['bold', 'italic', 'list'].includes(key))) {
        throw error(400, 'clinical_episode_invalid_document', 'El formato del texto no está permitido.');
      }
      const attributes = {};
      for (const key of ['bold', 'italic']) if (has(operation.attributes, key)) {
        if (operation.attributes[key] !== true) throw error(400, 'clinical_episode_invalid_document', 'El formato del texto no es válido.');
        attributes[key] = true;
      }
      if (has(operation.attributes, 'list')) {
        if (!['bullet', 'ordered'].includes(operation.attributes.list)) throw error(400, 'clinical_episode_invalid_document', 'El formato de lista no es válido.');
        attributes.list = operation.attributes.list;
      }
      if (Object.keys(attributes).length) out.attributes = attributes;
    }
    return out;
  });
  if (!ops.length || !ops[ops.length - 1].insert.endsWith('\n')) ops.push({ insert: '\n' });
  const document = { ops };
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > 256000) throw error(413, 'clinical_episode_document_too_large', 'El documento es demasiado extenso.');
  return document;
}
function richDocument(row = {}) {
  const saved = row.rich_document;
  return { version: 1, sections: Object.fromEntries(TEXT_FIELDS.map(key => [key,
    saved?.version === 1 && saved.sections?.[key] ? saved.sections[key] : plainDocument(row[key])])) };
}
function normalizePatch(payload, previous = {}, { legacy = false } = {}) {
  if (!object(payload)) throw error(400, 'clinical_episode_invalid_payload', 'Los datos del episodio no son válidos.');
  const values = {}, document = richDocument(previous);
  let documentChanged = false;
  if (has(payload, 'rich_document')) {
    if (!object(payload.rich_document) || payload.rich_document.version !== 1 || !object(payload.rich_document.sections)
      || Object.keys(payload.rich_document).some(key => !['version', 'sections'].includes(key))) throw error(400, 'clinical_episode_invalid_document', 'El documento clínico no es válido.');
    for (const [key, section] of Object.entries(payload.rich_document.sections)) {
      if (!TEXT_FIELDS.includes(key)) throw error(400, 'clinical_episode_invalid_document', 'Hay una sección no permitida.');
      const normalized = safeDocument(section), extracted = text(documentText(normalized), key, key === 'reason' ? 500 : 20000);
      if (has(payload, key) && text(payload[key], key, key === 'reason' ? 500 : 20000) !== extracted) throw error(400, 'clinical_episode_document_conflict', 'El texto y su formato no coinciden.', { field: key });
      document.sections[key] = normalized;
      values[key] = extracted;
      documentChanged = true;
    }
  }
  for (const key of TEXT_FIELDS) {
    if (!has(payload, key) || has(values, key)) continue;
    const max = key === 'reason' ? 500 : 20000;
    const value = legacy && payload[key] != null ? String(payload[key]).replace(/\r\n/g, '\n').trim().slice(0, max) || null : text(payload[key], key, max);
    values[key] = value;
    if ((previous[key] ?? null) !== value) {
      document.sections[key] = plainDocument(value);
      documentChanged = true;
    }
  }
  if (documentChanged) values.rich_document = document;
  if (!legacy) {
    if (has(payload, 'title')) values.title = text(payload.title, 'title', 255);
    if (has(payload, 'occurred_at')) values.occurred_at = timestamp(payload.occurred_at);
    if (has(payload, 'template_key')) {
      if (!TEMPLATE_KEYS.includes(payload.template_key)) throw error(400, 'clinical_episode_invalid_template', 'Selecciona una plantilla válida.');
      values.template_key = payload.template_key;
    }
    if (has(payload, 'appointment_ids')) values.appointment_ids = appointmentIds(payload.appointment_ids);
  }
  return values;
}
function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(value) {
  if (!value) return null;
  try {
    if (typeof value !== 'string' || value.length > 400 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const result = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!object(result)) throw Error();
    return result;
  } catch { throw error(400, 'clinical_episode_invalid_cursor', 'La página solicitada no es válida.'); }
}
module.exports = { TEXT_FIELDS, TEMPLATE_KEYS, error, integer, text, timestamp, appointmentIds, idempotencyKey,
  hash, plainDocument, documentText, safeDocument, richDocument, normalizePatch, encodeCursor, decodeCursor, has };
