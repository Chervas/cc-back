'use strict';
const { createHash } = require('node:crypto');
// New drafts/versions only. The pinned DOCX renderer remains byte-for-byte
// unchanged so historical signatures can still be independently verified.
const CORRECTIONS = Object.freeze([
  ['a continuación que tratamiento', 'a continuación qué tratamiento'],
  ['las pruebas médicas solicitas', 'las pruebas médicas solicitadas'],
  ['se trataran amparados', 'se tratarán amparados'],
  ['para informado sobre nuestros servicios', 'para informarle sobre nuestros servicios'],
  ['hospital, esté también', 'hospital, este también'],
  ['¿Cómo he obtenidos sus datos personales?', '¿Cómo he obtenido sus datos personales?'],
  ['derechos y como obtener', 'derechos y cómo obtener'],
].map(pair => Object.freeze(pair)));
const hash = value => createHash('sha256').update(value).digest('hex');
function correctDraft(draft) {
  const source = String(draft.body_html || '');
  const corrected = CORRECTIONS.reduce((html, [from, to]) => html.split(from).join(to), source);
  if (corrected === source) return draft;
  return { ...draft, body_html: corrected, body_json: { ...draft.body_json, registration_privacy: {
    ...draft.body_json.registration_privacy,
    orthographic_revision: { schema_version: 'cc-registration-orthography/v1',
      original_html_sha256: hash(source), corrected_html_sha256: hash(corrected) },
  } } };
}
module.exports = { CORRECTIONS, correctDraft };
