'use strict';
const C = require('./clinical-episode-contract'), T = require('./clinical-template-contract');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function key(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{2,79}$/.test(value)) throw C.error(400, 'clinical_catalog_key_invalid', 'Usa un identificador de entre 3 y 80 letras, números o guiones.');
  return value;
}
function definition(payload) {
  if (!object(payload)) throw C.error(400, 'clinical_catalog_invalid', 'Revisa la plantilla del catálogo.');
  const codes = payload.medical_area_codes;
  if (typeof payload.all_medical_areas !== 'boolean' || !Array.isArray(codes) || codes.length > 80
    || codes.some(code => typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(code))
    || new Set(codes).size !== codes.length || (payload.all_medical_areas ? codes.length !== 0 : codes.length === 0))
    throw C.error(400, 'clinical_catalog_areas_invalid', 'Selecciona áreas médicas reales o indica que la plantilla sirve para todas.');
  if (!['initial', 'standard'].includes(payload.kind)) throw C.error(400, 'clinical_catalog_kind_invalid', 'Indica si es una historia inicial o una consulta habitual.');
  const definition = T.definition(payload.definition);
  if (definition.form_schema) definition.form_schema = { ...definition.form_schema, kind: payload.kind };
  return { definition, kind: payload.kind, all_medical_areas: payload.all_medical_areas, medical_area_codes: [...codes].sort() };
}
function selections(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 40) throw C.error(400, 'clinical_catalog_selection_invalid', 'Selecciona como máximo 40 plantillas clínicas.');
  const result = value.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'version'].includes(key)) || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id))
      throw C.error(400, 'clinical_catalog_selection_invalid', 'La selección de plantillas no es válida.');
    return { id: item.id, version: C.integer(item.version, 'version') };
  });
  if (new Set(result.map(item => `${item.id}:${item.version}`)).size !== result.length) throw C.error(400, 'clinical_catalog_selection_invalid', 'Hay una plantilla repetida.');
  return result;
}
module.exports = { key, definition, selections };
