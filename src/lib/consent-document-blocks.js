'use strict';

// Explicit, versioned document composition. Nothing here interprets a free-form
// answer as a patient-profile change or as permission to send communications.
const SCHEMA = 'cc-document-blocks/v1';
const choices = require('./consent-document-choices');
const object = raw => { if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return {}; } }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; };
const record = raw => raw && typeof raw === 'object' && !Array.isArray(raw);
const own = (raw, key) => Object.prototype.hasOwnProperty.call(raw || {}, key);
const plain = row => row?.toJSON ? row.toJSON() : row;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fail = (code, message, statusCode = 400, field = null) => Object.assign(new Error(message),
  { code, statusCode, details: { reason_code: code, ...(field ? { field } : {}) } });
const schemaError = () => fail('consent_document_blocks_invalid', 'Revisa los bloques de la plantilla.');
const KEYS = ['nombre', 'apellidos', 'dni', 'fecha_nacimiento', 'compania', 'direccion', 'codigo_postal', 'ciudad', 'provincia', 'telefono', 'telefono2', 'email'];
const TYPES = new Set(['text', 'textarea', 'email', 'tel', 'number', 'date', 'select', 'yes_no', 'checkbox']);
const validId = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
function keys(raw, allowed, required = allowed) {
  return record(raw) && Object.keys(raw).every(key => allowed.includes(key)) && required.every(key => own(raw, key));
}
function label(raw, max = 250) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max || /[\u0000-\u001f\u007f<>]/u.test(raw)) throw schemaError();
  return raw.trim();
}
function cleanHtml(raw) {
  if (typeof raw !== 'string' || raw.length > 250000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(raw)
    || /<\s*(?:script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|link|meta|base)\b/i.test(raw)) throw schemaError();
  // Content is an editor fragment, not a stylesheet or an executable page.
  // Strip all attributes, including events/URLs/styles; retain semantic weight.
  const allowed = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'span', 'div', 'a']);
  return raw.replace(/<!--[\s\S]*?-->/g, '').replace(/<\s*(\/?)\s*([a-zA-Z][\w:-]*)\b[^>]*>/g,
    (_all, closing, tag) => allowed.has(tag.toLowerCase()) ? `<${closing ? '/' : ''}${tag.toLowerCase()}>` : '');
}
function validate(raw, { purpose = 'other', body = {} } = {}) {
  if (!keys(raw, ['schema_version', 'blocks']) || raw.schema_version !== SCHEMA || !Array.isArray(raw.blocks)
    || !raw.blocks.length || raw.blocks.length > 60) throw schemaError();
  const ids = new Set(), fieldKeys = new Set(); let totalFields = 0;
  const blocks = raw.blocks.map(block => {
    if (!record(block) || !validId(block.id) || ids.has(block.id)) throw schemaError();
    ids.add(block.id);
    if (block.type === 'text') {
      if (!keys(block, ['id', 'type', 'html'])) throw schemaError();
      return { id: block.id, type: block.type, html: cleanHtml(block.html) };
    }
    if (block.type === 'patient_data') {
      if (!keys(block, ['id', 'type', 'fields']) || !Array.isArray(block.fields) || !block.fields.length
        || block.fields.some(key => !KEYS.includes(key)) || new Set(block.fields).size !== block.fields.length) throw schemaError();
      return { id: block.id, type: block.type, fields: [...block.fields] };
    }
    if (block.type === 'fields') {
      if (!keys(block, ['id', 'type', 'title', 'fields'], ['id', 'type', 'fields']) || !Array.isArray(block.fields)
        || !block.fields.length || block.fields.length > 30) throw schemaError();
      const fields = block.fields.map(field => {
        if (!keys(field, ['key', 'type', 'label', 'required', 'options', 'min', 'max', 'max_length'], ['key', 'type', 'label', 'required'])
          || !validId(field.key) || fieldKeys.has(field.key) || !TYPES.has(field.type) || typeof field.required !== 'boolean') throw schemaError();
        fieldKeys.add(field.key); totalFields++;
        const result = { key: field.key, type: field.type, label: label(field.label), required: field.required };
        if (own(field, 'max_length')) {
          if (!['text', 'textarea', 'email', 'tel'].includes(field.type) || !Number.isInteger(field.max_length)
            || field.max_length < 1 || field.max_length > (field.type === 'textarea' ? 10000 : 2000)) throw schemaError();
          result.max_length = field.max_length;
        }
        for (const bound of ['min', 'max']) if (own(field, bound)) {
          if (field.type !== 'number' || !Number.isFinite(field[bound]) || Math.abs(field[bound]) > 1e12) throw schemaError();
          result[bound] = field[bound];
        }
        if (result.min != null && result.max != null && result.min > result.max) throw schemaError();
        if (field.type === 'select') {
          if (!Array.isArray(field.options) || !field.options.length || field.options.length > 40) throw schemaError();
          result.options = field.options.map(option => {
            if (!keys(option, ['value', 'label'])) throw schemaError();
            return { value: label(option.value, 150), label: label(option.label) };
          });
          if (new Set(result.options.map(option => option.value)).size !== result.options.length) throw schemaError();
        } else if (own(field, 'options')) throw schemaError();
        return result;
      });
      return { id: block.id, type: block.type, ...(own(block, 'title') ? { title: label(block.title) } : {}), fields };
    }
    if (['decisions', 'signature'].includes(block.type) && keys(block, ['id', 'type'])) return { id: block.id, type: block.type };
    throw schemaError();
  });
  if (totalFields > 100 || blocks.filter(block => block.type === 'patient_data').length > 1
    || blocks.filter(block => block.type === 'decisions').length > 1
    || blocks.filter(block => block.type === 'signature').length !== 1 || blocks.at(-1).type !== 'signature') throw schemaError();
  if (blocks.some(block => block.type === 'patient_data') && !['data_protection', 'other'].includes(purpose)) throw schemaError();
  if (blocks.some(block => block.type === 'decisions')) choices.validateForm(body.consent_form);
  else if (own(body, 'consent_form')) throw schemaError();
  if (purpose === 'data_protection') {
    const personal = blocks.find(block => block.type === 'patient_data');
    if (!personal || KEYS.some(key => !personal.fields.includes(key)) || !blocks.some(block => block.type === 'decisions')) throw schemaError();
  }
  if (JSON.stringify(blocks).length > 450000) throw schemaError();
  return { schema_version: SCHEMA, blocks };
}
function versionBlocks(version, template = {}, statusCode = 409) {
  const body = object(version?.body_json);
  if (!own(body, 'document_blocks')) return null;
  try { return validate(body.document_blocks, { purpose: template.purpose, body }); }
  catch (error) { error.statusCode = statusCode; throw error; }
}
function normalizeVersion(version, template) {
  const blocks = versionBlocks(version, template, 400);
  return blocks ? { ...version, body_json: { ...object(version.body_json), document_blocks: blocks } } : version;
}
function documentBlocks(document) {
  const snapshot = object(plain(document)?.snapshot_json);
  return versionBlocks(object(snapshot.version), object(snapshot.template));
}
function replaceVariables(html, context) {
  return html.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key) => escape(key.split('.').reduce(
    (node, part) => node && own(node, part) ? node[part] : '', context) ?? ''));
}
function renderVersion(version, context, { answers = {}, choiceEvidence = null } = {}) {
  const body = object(version.body_json), definition = versionBlocks(version);
  if (!definition) return null;
  const personal = require('./consent-document-personal-data'), values = personal.contextValues(context);
  const fieldValue = field => {
    if (!own(answers, field.key)) return '—';
    const value = answers[field.key];
    if (field.type === 'yes_no') return value === 'yes' ? 'Sí' : 'No';
    if (field.type === 'checkbox') return value ? 'Sí' : 'No';
    if (field.type === 'select') return field.options.find(option => option.value === value)?.label || value;
    if (field.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
    return value;
  };
  return '<section class="consent-document-blocks" data-document-block-schema="' + SCHEMA + '">' + definition.blocks.map(block => {
    const attr = ' data-document-block-id="' + escape(block.id) + '"';
    if (block.type === 'text') return '<section' + attr + '>' + replaceVariables(block.html, context) + '</section>';
    if (block.type === 'patient_data') return '<section class="consent-patient-identity"' + attr + '><h3>Datos del paciente</h3><dl>'
      + block.fields.map(key => { const field = personal.FIELDS.find(field => field.key === key); let value = values[key];
        if (key === 'fecha_nacimiento' && value) value = value.split('-').reverse().join('/');
        return '<div><dt>' + escape(field.label) + '</dt><dd>' + escape(value || '—') + '</dd></div>'; }).join('') + '</dl></section>';
    if (block.type === 'fields') return '<section class="consent-custom-fields"' + attr + '>' + (block.title ? '<h3>' + escape(block.title) + '</h3>' : '')
      + '<dl>' + block.fields.map(field => '<div><dt>' + escape(field.label) + '</dt><dd>' + escape(fieldValue(field)) + '</dd></div>').join('') + '</dl></section>';
    if (block.type === 'decisions') return '<section class="consent-document-decisions"' + attr + '><h3>Autorizaciones</h3><ul>'
      + choices.validateForm(body.consent_form).fields.map(field => '<li><p>' + escape(field.label) + '</p><p><strong>'
        + (choiceEvidence?.answers?.[field.key] === 'yes' ? '☑ Sí · ☐ No' : choiceEvidence?.answers?.[field.key] === 'no' ? '☐ Sí · ☑ No' : '☐ Sí · ☐ No')
        + '</strong></p></li>').join('') + '</ul></section>';
    return ''; // The actual signature/receipt is emitted by the document shell.
  }).join('\n') + '</section>';
}
function validateAnswerMap(payload, documents) {
  if (!own(payload, 'document_block_answers')) return;
  const map = payload.document_block_answers, ids = new Set(documents.map(doc => String(plain(doc).id)));
  if (!record(map) || Object.keys(map).length > 100 || Object.keys(map).some(id => !/^[1-9]\d*$/.test(id) || !ids.has(id))) {
    throw fail('consent_document_block_answers_scope_invalid', 'Las respuestas no corresponden a los documentos seleccionados.');
  }
}
function answerEvidence(document, payload = {}, now = new Date()) {
  const doc = plain(document), definition = documentBlocks(doc), fields = definition?.blocks.filter(block => block.type === 'fields').flatMap(block => block.fields) || [];
  const supplied = own(payload.document_block_answers, String(doc.id));
  if (!fields.length) {
    if (supplied) throw fail('consent_document_block_answers_unexpected', 'Este documento no incluye preguntas adicionales.');
    return null;
  }
  const entry = payload.document_block_answers?.[String(doc.id)];
  if (!supplied || !keys(entry, ['snapshot_hash', 'answers']) || !record(entry.answers)
    || Object.keys(entry.answers).some(key => !fields.some(field => field.key === key))) {
    throw fail('consent_document_block_answers_required', 'Revisa las preguntas del documento.');
  }
  if (entry.snapshot_hash !== doc.snapshot_hash || doc.snapshot_hash !== choices.choiceSnapshotHash(object(doc.snapshot_json), doc.snapshot_html || '')) {
    throw fail('consent_document_block_answers_changed', 'El documento ha cambiado. Vuelve a revisarlo antes de continuar.', 409);
  }
  const answers = {};
  for (const field of fields) {
    const value = entry.answers[field.key];
    if (!own(entry.answers, field.key) || value === '' || value == null) {
      if (field.required) throw fail('consent_document_block_answer_required', `Completa «${field.label}».`, 400, field.key);
      continue;
    }
    let valid = true;
    if (field.type === 'checkbox') valid = typeof value === 'boolean' && (!field.required || value === true);
    else if (field.type === 'number') valid = typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12
      && (field.min == null || value >= field.min) && (field.max == null || value <= field.max);
    else {
      valid = typeof value === 'string' && value.length <= (field.max_length || (field.type === 'textarea' ? 10000 : 2000))
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
      if (valid && field.type !== 'textarea') valid = !/[\r\n]/.test(value);
      if (valid && field.type === 'yes_no') valid = ['yes', 'no'].includes(value);
      if (valid && field.type === 'select') valid = field.options.some(option => option.value === value);
      if (valid && field.type === 'email') valid = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value);
      if (valid && field.type === 'tel') valid = /^\+?[\d ()/.\-]{5,40}$/u.test(value);
      if (valid && field.type === 'date') { const date = new Date(value + 'T00:00:00Z'); valid = /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }
    }
    if (!valid) throw fail('consent_document_block_answer_invalid', `Revisa «${field.label}».`, 400, field.key);
    if (typeof value === 'string' && !value.trim()) { if (field.required) throw fail('consent_document_block_answer_required', `Completa «${field.label}».`, 400, field.key); continue; }
    answers[field.key] = typeof value === 'string' ? value.trim() : value;
  }
  return { schema_version: SCHEMA, answers, answered_at: now.toISOString(), snapshot_hash_before_answers: doc.snapshot_hash };
}
function payloadForDocument(document, payload) {
  if (!own(payload, 'document_block_answers')) return payload;
  const id = String(plain(document).id), map = payload.document_block_answers;
  return { ...payload, document_block_answers: own(map, id) ? { [id]: map[id] } : {} };
}
function publicFields(document) {
  const doc = plain(document), definition = documentBlocks(doc);
  if (!definition) return {};
  const snapshot = object(doc.snapshot_json), evidence = object(snapshot.document_block_answers);
  const closed = ['signed', 'completed'].includes(doc.status) && evidence.schema_version === SCHEMA
    && doc.snapshot_hash === choices.choiceSnapshotHash(snapshot, doc.snapshot_html || '');
  return { document_blocks: { schema_version: SCHEMA, blocks: definition.blocks.map(block => block.type === 'text'
    ? { ...block, html: replaceVariables(block.html, snapshot.context || {}) } : block) },
  document_block_answers: closed ? evidence.answers : null };
}
module.exports = { SCHEMA, KEYS, validate, versionBlocks, documentBlocks, normalizeVersion, renderVersion,
  validateAnswerMap, answerEvidence, payloadForDocument, publicFields, escape, object };
