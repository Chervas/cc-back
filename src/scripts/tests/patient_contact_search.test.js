'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const db = require('../../../models');
const { patientFixture } = require('./fixtures/patient_read.fixture');
const {
  buildFastPatientSearchWhere,
  classifyContactSearchQuery,
  normalizeOperationalSource,
} = require('../../services/patientContact.service');

const { Op } = db.Sequelize;

function collectLikePatterns(value, patterns = []) {
  if (!value || typeof value !== 'object') return patterns;
  for (const key of Reflect.ownKeys(value)) {
    if (key === Op.like) patterns.push(value[key]);
    else collectLikePatterns(value[key], patterns);
  }
  return patterns;
}

test('clasifica teléfonos, emails y nombres sin confundir nombres numéricos cortos', () => {
  assert.equal(classifyContactSearchQuery('+34 654 695 552'), 'phone');
  assert.equal(classifyContactSearchQuery('0033 612345678'), 'phone');
  assert.equal(classifyContactSearchQuery('ana@example.com'), 'email');
  assert.equal(classifyContactSearchQuery('María 2'), 'name');
});

test('la búsqueda telefónica usa candidatos exactos indexables', () => {
  const search = buildFastPatientSearchWhere('654 695 552');
  assert.equal(search.queryType, 'phone');
  const candidates = search.where.telefono_movil[Op.in];
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.includes('34654695552'));
  assert.ok(candidates.includes('654695552'));
  assert.equal(collectLikePatterns(search.where).length, 0);
});

test('las iniciales junto al nombre siguen siendo un criterio y la puntuación sola no busca pacientes', () => {
  const search = buildFastPatientSearchWhere('María L');
  assert.equal(search.queryType, 'name');
  assert.equal(search.where[Op.and].length, 2);
  assert.match(search.where[Op.and][1].val, /LIKE '% L%' ESCAPE '!'/);
  assert.equal(buildFastPatientSearchWhere('%_!').where, null);
});

test('el ámbito múltiple intersecta permiso nominal y sensible sin adoptar la primera clínica', async () => {
  for (const filter of ['70,71,72', 'all']) {
    const f = patientFixture({ allowed: [70, 71], sensitiveAllowed: [71, 72] });
    const contact = await f.invoke('searchPatientContactTargets', { query: { q: 'Marta G', clinica_id: filter, scope: 'grupo' } });
    assert.equal(contact.status, 200);
    assert.deepEqual(f.state.contactSearchInput.clinicIds, [71]);
    assert.equal(f.state.contactSearchInput.selectedClinicId, null);
    assert.deepEqual(contact.body.items[0].patient.clinicasVinculadas.map(link => link.clinica_id), [71]);
    const list = await f.invoke('searchPacientes', { query: { q: 'Marta G', clinica_id: filter } });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body[0].clinicasVinculadas.map(link => link.clinica_id), [71]);
  }
  const f = patientFixture({ allowed: [71], sensitiveAllowed: [71] });
  assert.equal((await f.invoke('searchPatientContactTargets', { query: { q: 'Marta G', clinica_id: '72', scope: 'grupo' } })).status, 403);
  assert.equal(f.state.contactSearchInput, undefined);
  assert.equal((await f.invoke('searchPacientes', { query: { q: 'Marta G', clinica_id: '71,abc' } })).status, 400);
});

test('el origen de auditoría falla a un valor canónico', () => {
  assert.equal(normalizeOperationalSource('header_search'), 'header_search');
  assert.equal(normalizeOperationalSource('QUICK CHAT'), 'quick_chat');
  assert.equal(normalizeOperationalSource('untrusted-source'), 'patient_modal');
});

test('the native QuickChat entrypoint imports its canonical audit-source normalizer', () => {
  const controller = fs.readFileSync(require.resolve('../../controllers/conversation.controller'), 'utf8');
  assert.match(controller, /const\s*\{[^}]*startPatientWhatsappConversation,[^}]*normalizeOperationalSource,[^}]*\}\s*=\s*require\('\.\.\/services\/patientContact\.service'\)/);
});

test('NHC digits use exact identifiers while a full phone remains searchable', () => {
  for (const number of ['1', '00123', '14526']) {
    const result = buildFastPatientSearchWhere(number);
    assert.equal(result.queryType, 'history_number');
    assert.equal(result.where.numero_historia, number.replace(/^0+/, ''));
  }
  const numeric = buildFastPatientSearchWhere('654695552');
  assert.equal(numeric.where[Op.or][0].numero_historia, '654695552');
  assert.ok(numeric.where[Op.or][1].telefono_movil[Op.in].includes('654695552'));
});
