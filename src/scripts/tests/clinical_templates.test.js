'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../../lib/clinical-episode-contract'), T = require('../../lib/clinical-template-contract');
const { createPatientClinicalReferenceService } = require('../../services/patientClinicalReference.service');
const definition = () => ({ ...T.builtin('estetica'), title: 'Plantilla clínica genérica' });
test('template definition preserves all eight canonical fields and safe Delta, with private text kept outside the main block', () => {
  const input = definition(); input.fields.find(field => field.key === 'private_notes').visible = true;
  input.rich_document.sections.outcome = { ops: [{ insert: 'Base genérica', attributes: { bold: true } }, { insert: '\n' }] };
  const result = T.definition(input); assert.equal(result.fields.length, 8);
  assert.equal(result.fields.find(field => field.key === 'private_notes').visible, false);
  assert.equal(result.rich_document.sections.outcome.ops[0].attributes.bold, true);
  assert.equal(T.builtin('nutricion').area_key, 'nutricion');
  const invalid = definition(); invalid.fields.pop(); assert.throws(() => T.definition(invalid), { code: 'clinical_template_invalid_fields' });
  for (const insert of [{ image: 'https://external.invalid' }, { html: '<script/>' }]) {
    const value = definition(); value.rich_document.sections.outcome = { ops: [{ insert }] }; assert.throws(() => T.definition(value), { code: 'clinical_episode_invalid_document' });
  }
});
test('unified templates persist narrative order, safe custom blocks and the optional structured form in one definition', () => {
  const key = 'custom_384e46ed-d86e-4447-836e-346d27a67982', input = definition();
  input.fields.reverse(); input.fields.splice(2, 0, { key, label: 'Exploración específica', visible: true });
  input.rich_document.sections[key] = C.plainDocument('Texto de partida');
  const result = T.definition(input);
  assert.deepEqual(result.fields.map(field => field.key), input.fields.map(field => field.key));
  assert.equal(result.rich_document.labels[key], 'Exploración específica');
  assert.equal(C.documentText(result.rich_document.sections[key]), 'Texto de partida');
  const copy = C.normalizePatch({ plan: 'Cambio desde un cliente anterior' }, { ...result, template_snapshot: result });
  assert.equal(copy.rich_document.labels[key], 'Exploración específica');
  assert.equal(C.documentText(copy.rich_document.sections[key]), 'Texto de partida');
  assert.equal(Object.hasOwn(copy, key), false, 'custom text lives only in the JSON document, never an invented SQL column');
  for (const edit of [value => value.fields.push({ ...value.fields[2] }), value => { value.fields[2].key = '__proto__'; },
    value => { value.rich_document.sections.custom_unknown = C.plainDocument('No'); }, value => { value.rich_document.sections[key] = { ops: [{ insert: { image: 'https://external.invalid' } }] }; }]) {
    const value = structuredClone(input); edit(value); assert.throws(() => T.definition(value));
  }
  const tooMany = definition(); tooMany.fields.push(...Array.from({ length: 33 }, () => ({ key: 'custom_' + require('node:crypto').randomUUID(), label: 'Bloque', visible: true })));
  assert.throws(() => T.definition(tooMany), { code: 'clinical_template_invalid_fields' });
});

test('custom document labels are bounded and cannot introduce arbitrary metadata or private SQL fields', () => {
  const key = 'custom_384e46ed-d86e-4447-836e-346d27a67982';
  const result = C.normalizePatch({ rich_document: { version: 1, sections: { [key]: C.plainDocument('Texto') }, labels: { [key]: 'Título' } }, professional_id: 8 });
  assert.equal(result.professional_id, 8); assert.equal(result.rich_document.labels[key], 'Título'); assert.equal(result[key], undefined);
  for (const labels of [{ summary: 'Otro' }, { [key]: 'x'.repeat(121) }, { [key]: '' }, { unknown: 'No' }]) {
    assert.throws(() => C.normalizePatch({ rich_document: { version: 1, sections: { [key]: C.plainDocument('Texto') }, labels } }));
  }
  assert.equal(C.normalizePatch({ professional_id: 8 }, {}, { legacy: true }).professional_id, undefined);
});
test('template controller rejects missing identity, sensitive denial and exact clinic overrides before service access', async () => {
  const { createClinicalEpisodeTemplatesController } = require('../../controllers/clinicalEpisodeTemplates.controller');
  let calls = 0;
  const controller = createClinicalEpisodeTemplatesController({ templates: { list: async () => { calls++; return { items: [] }; }, create: async () => { calls++; return { created: true }; } },
    canAccess: async ({ actorId, clinicId, featureKey }) => actorId === 7 && clinicId === 72 && featureKey !== 'clinical.reports.manage' });
  const response = () => ({ statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; }, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; } });
  for (const [handler, actor, clinic, status] of [['list', null, 72, 401], ['list', 7, 73, 403], ['create', 7, 72, 403]]) {
    const res = response(); await controller[handler]({ userData: { userId: actor }, params: {}, query: { clinic_id: clinic }, body: {} }, res);
    assert.equal(res.statusCode, status); assert.match(res.headers['Cache-Control'], /no-store/); assert.equal(calls, 0);
  }
  const res = response(); await controller.list({ userData: { userId: 7 }, params: {}, query: { clinic_id: 72 } }, res); assert.equal(calls, 1);
});
test('clinical reference updates are explicit per-field CAS, preserve unrelated patient data and reject invented metrics or partial stale writes', async () => {
  const patient = { id_paciente: 11, public_id: 'synthetic', clinica_id: 72, alergias: null, medicacion: 'Original', antecedentes: 'Previos', notas_medicas: null, peso: 82.5,
    async update(values, options) { assert.deepEqual(options.fields.sort(), Object.keys(values).sort()); Object.assign(this, values); } };
  const db = { sequelize: { transaction: work => work({ LOCK: { UPDATE: 'UPDATE' } }) }, Paciente: { findOne: async () => patient }, PacienteClinica: { findOne: async () => null } };
  const service = createPatientClinicalReferenceService({ db, canAccess: async () => true }), context = { actorId: 7, clinicId: 72, patientIdentifier: 'synthetic' };
  const result = await service.update({ ...context, payload: { changes: { alergias: 'Alergia revisada', notas_medicas: 'Nota revisada' }, expected_values: { alergias: null, notas_medicas: null } } });
  assert.equal(result.item.alergias, 'Alergia revisada'); assert.equal(patient.medicacion, 'Original'); assert.equal(patient.peso, 82.5);
  await assert.rejects(service.update({ ...context, payload: { changes: { alergias: 'No', medicacion: 'No' }, expected_values: { alergias: null, medicacion: 'Original' } } }), { code: 'clinical_reference_conflict' });
  assert.equal(patient.medicacion, 'Original');
  await assert.rejects(service.update({ ...context, payload: { changes: { peso: 20 }, expected_values: { peso: 82.5 } } }), { code: 'clinical_reference_invalid_payload' });
  assert.equal((await service.read(context)).item.notas_medicas, 'Nota revisada');
  assert.deepEqual(C.TEXT_FIELDS, ['reason','summary','findings','interventions','outcome','plan','next_steps','private_notes']);
});
