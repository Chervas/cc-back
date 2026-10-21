'use strict';
const C = require('./clinical-episode-contract');
const F = require('./clinical-form-contract');
const { FORM_PRESET_KEYS, formPreset } = require('./clinical-form-presets');
const AREAS = ['general', 'estetica', 'capilar', 'nutricion'];
const LABELS = { reason: 'Motivo de consulta', summary: 'Resumen de la consulta', findings: 'Hallazgos y valoración', interventions: 'Actuación', outcome: 'Evolución', plan: 'Plan y seguimiento', next_steps: 'Próximos pasos', private_notes: 'Notas privadas' };
const AREA_LABELS = { general: 'General', estetica: 'Estética', capilar: 'Capilar', nutricion: 'Nutrición' };
function definition(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw C.error(400, 'clinical_template_invalid', 'Revisa la plantilla.');
  const title = C.text(payload.title, 'title', 160), description = C.text(payload.description || null, 'description', 1000);
  if (!title || !AREAS.includes(payload.area_key)) throw C.error(400, 'clinical_template_invalid', 'Indica nombre y área de la plantilla.');
  const fields = payload.fields;
  if (!Array.isArray(fields) || fields.length !== 8 || new Set(fields.map(field => field?.key)).size !== 8
    || fields.some(field => !C.TEXT_FIELDS.includes(field?.key) || typeof field.visible !== 'boolean' || !C.text(field.label, 'label', 120))) {
    throw C.error(400, 'clinical_template_invalid_fields', 'La plantilla debe conservar las ocho secciones clínicas.');
  }
  const rich = C.normalizePatch({ rich_document: payload.rich_document || { version: 1, sections: {} } });
  return { title, description, area_key: payload.area_key, fields: C.TEXT_FIELDS.map(key => {
    const field = fields.find(item => item.key === key); return { key, label: C.text(field.label, 'label', 120), visible: key === 'private_notes' ? false : field.visible };
  }), rich_document: C.richDocument(rich), ...(Object.hasOwn(payload,'form_schema')?{form_schema:F.schema(payload.form_schema)}:{}) };
}
function builtin(area) {
  const preset=formPreset(area);
  if(preset){const value=definition({...preset,fields:C.TEXT_FIELDS.map(key=>({key,label:LABELS[key],visible:['outcome','interventions','plan'].includes(key)})),rich_document:{version:1,sections:{}}});const snapshot={id:`builtin:${area}`,clinic_id:null,version:1,...value,builtin:true};return{...snapshot,sha256:C.hash(snapshot)};}
  if (!AREAS.includes(area)) return null;
  const value = definition({ title: AREA_LABELS[area], area_key: area, fields: C.TEXT_FIELDS.map(key => ({ key, label: LABELS[key], visible: ['outcome', 'interventions', 'plan'].includes(key) })),
    rich_document: { version: 1, sections: { outcome: C.plainDocument('Evolución y cambios desde la última visita:'), interventions: C.plainDocument('Actuaciones de esta consulta:'), plan: C.plainDocument('Plan y seguimiento acordados:') } } });
  const snapshot = { id: `builtin:${area}`, clinic_id: null, version: 1, ...value, builtin: true };
  return { ...snapshot, sha256: C.hash(snapshot) };
}
module.exports = { AREAS, LABELS, FORM_PRESET_KEYS, definition, builtin, builtins:()=>AREAS.map(builtin) };
