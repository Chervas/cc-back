'use strict';

// Private CRM form data. This projection is returned only to an explicit v2
// receipt reader; it must never become a journal, job or reporting payload.
const { fail } = require('./errors');
const M = require('./meta-marketing-contract');
const LIMITS = Object.freeze({ fields: 100, key: 256, label: 512, type: 64, values: 50, value: 4096, bytes: 65536 });
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const string = (value, max, { empty = false, multiline = false } = {}) => typeof value === 'string'
  && (empty || value.length > 0) && value.length <= max
  && !(multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value);
const type = value => string(value, LIMITS.type) && /^[A-Z][A-Z0-9_]*$/.test(value);
const bad = () => fail('provider_failed');

function questions(value) {
  if (!Array.isArray(value) || value.length > LIMITS.fields) bad();
  const seen = new Set();
  return value.map(question => {
    const keys = ['key', 'type', ...(Object.hasOwn(question || {}, 'id') ? ['id'] : []),
      ...(Object.hasOwn(question || {}, 'label') ? ['label'] : [])].sort().join(',');
    if (!exact(question, keys) || !string(question.key, LIMITS.key) || !type(question.type)
      || seen.has(question.key) || Object.hasOwn(question, 'id') && !M.graphId(question.id)
      || Object.hasOwn(question, 'label') && question.label !== null && !string(question.label, LIMITS.label, { empty: true })) bad();
    seen.add(question.key);
    return { key: question.key, label: question.label === undefined || question.label === null ? question.key : question.label, type: question.type };
  });
}

function validateFormResponse(value, expectedFormId) {
  if (!exact(value, 'version,formId,name,fields') || value.version !== 2 || !M.graphId(value.formId)
    || value.formId !== expectedFormId || !string(value.name, 256) || !Array.isArray(value.fields)
    || value.fields.length > LIMITS.fields) bad();
  const seen = new Set();
  for (const field of value.fields) {
    if (!exact(field, 'key,label,type,values') || !string(field.key, LIMITS.key)
      || !string(field.label, LIMITS.label, { empty: true }) || !type(field.type) || seen.has(field.key)
      || !Array.isArray(field.values) || field.values.length > LIMITS.values
      || field.values.some(answer => !string(answer, LIMITS.value, { empty: true, multiline: true }))) bad();
    seen.add(field.key);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.bytes) bad();
  return structuredClone(value);
}

function projectFormResponse({ formId, name, definition, rows }) {
  // Definition is a closed projection of the exact, owned form. Field keys from
  // another form or an unobserved question must not be silently accepted.
  definition = questions(definition);
  if (!Array.isArray(rows) || rows.length > LIMITS.fields) bad();
  const allowed = new Map(definition.map(question => [question.key, question]));
  const answers = new Map();
  for (const row of rows) {
    if (!exact(row, 'name,values') || !allowed.has(row.name) || answers.has(row.name)
      || !Array.isArray(row.values) || row.values.length > LIMITS.values
      || row.values.some(answer => !string(answer, LIMITS.value, { empty: true, multiline: true }))) bad();
    answers.set(row.name, [...row.values]);
  }
  // Include unanswered questions explicitly; retain [] and [""] as distinct.
  return validateFormResponse({ version: 2, formId, name,
    fields: definition.map(question => ({ ...question, values: answers.get(question.key) || [] })) }, formId);
}

module.exports = { LIMITS, questions, validateFormResponse, projectFormResponse };
