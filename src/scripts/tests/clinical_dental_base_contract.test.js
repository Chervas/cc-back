'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../../lib/clinical-episode-contract');
const T = require('../../lib/clinical-template-contract');
const Catalog = require('../../lib/clinical-template-catalog-contract');
const A = require('../../lib/medical-area-contracts');
const { exposeRevision, contractHash } = require('../../services/medicalAreaContracts.service');
const { compareAreaContracts } = require('../../lib/medical-area-adoption-review');
const clone = value => JSON.parse(JSON.stringify(value));

test('Dental episode and template retain their explicit area without a General fallback', () => {
  assert.equal(C.normalizePatch({ template_key: 'dental', appointment_ids: [9, 10] }).template_key, 'dental');
  const item = T.builtin('dental');
  assert.equal(item.id, 'builtin:dental');
  assert.equal(item.title, 'Dental');
  assert.equal(item.area_key, 'dental');
  assert.equal(item.version, 1);
  assert.equal(item.fields.length, 8);
  assert.equal(item.fields.find(field => field.key === 'private_notes').visible, false);
  const snapshot = clone(item); delete snapshot.sha256;
  assert.equal(item.sha256, C.hash(snapshot));
  assert.equal(T.builtins().filter(item => item.area_key === 'dental').length, 1);
  assert.throws(() => C.normalizePatch({ template_key: 'unknown-area' }), { code: 'clinical_episode_invalid_template' });
  assert.equal(T.builtin('unknown-area'), null);
});

test('Dental templates use the existing versioned catalogue contract and preserve the other area definitions', () => {
  const definition = T.definition({ ...T.builtin('dental'), title: 'Consulta dental de la clínica' });
  const source = Catalog.definition({ kind: 'standard', all_medical_areas: false, medical_area_codes: ['dental'], definition });
  assert.equal(source.definition.area_key, 'dental');
  assert.deepEqual(source.medical_area_codes, ['dental']);
  assert.equal(source.kind, 'standard');
  for (const area of ['general', 'estetica', 'capilar', 'nutricion']) {
    const item = T.builtin(area);
    assert.equal(item.id, 'builtin:' + area);
    assert.equal(item.area_key, area);
    assert.equal(item.fields.length, 8);
  }
});

test('Dental entry defaults identify real History while remaining closed until explicit area publication/adoption', () => {
  const base = A.getBaseContractForArea('dental');
  assert.equal(base.code, 'dental');
  assert.equal(base.patient_workspace.route, 'historia-clinica');
  assert.equal(base.appointment_action.route, 'historia-clinica');
  assert.equal(base.patient_workspace.enabled, false);
  assert.equal(base.appointment_action.enabled, false);
  assert.equal(base.appointment_action.requiresProfile, false);
  assert.equal(base.appointment_action.label, 'Abrir episodio dental');
  assert.equal(base.profile.supportsPiece, true);
  assert.equal(base.profile.supportsLaboratory, true);
  assert(base.protocol_rules.some(rule => rule.code === 'dental-lab-before-prosthesis'));
  assert.deepEqual(base.nutrition_measurement_profile_options, []);
  assert.notEqual(base.appointment_action.label, A.getBaseContractForArea('general').appointment_action.label);
});

test('reading a published legacy Dental revision preserves its exact route and hash after new code defaults', () => {
  const legacy = clone(A.getBaseContractForArea('dental'));
  legacy.patient_workspace = { enabled: false, route: 'tratamientos', labelKey: 'patients.detail.tabs.treatments', label: 'Tratamientos', icon: 'heroicons_outline:clipboard-document-list' };
  legacy.appointment_action = clone(A.getBaseContractForArea('general').appointment_action);
  const stored = { id: 17, code: 'dental', revision_number: 1, contract_json: legacy, content_hash: contractHash(legacy) };
  const before = JSON.stringify(stored);
  const read = exposeRevision(stored);
  assert.equal(read.patient_workspace.route, 'tratamientos');
  assert.equal(read.appointment_action.route, null);
  assert.equal(read.appointment_action.enabled, false);
  assert.equal(read.revision.hash, stored.content_hash);
  assert.equal(JSON.stringify(stored), before);
  assert.equal(A.getBaseContractForArea('dental').patient_workspace.route, 'historia-clinica');
});

test('Dental activation is a reviewable new revision and cannot silently relocate an existing active workspace', () => {
  const before = clone(A.getBaseContractForArea('dental'));
  before.patient_workspace.route = 'tratamientos';
  const target = A.normalizeContractPayload('dental', { ...before,
    patient_workspace: { ...before.patient_workspace, enabled: true, route: 'historia-clinica', labelKey: null, label: 'Historia clínica' },
    appointment_action: { ...A.getBaseContractForArea('dental').appointment_action, enabled: true },
  });
  const review = compareAreaContracts(before, target);
  assert.equal(review.compatible, true);
  assert(review.changes.some(change => change.key === 'patient_workspace'));
  assert(review.changes.some(change => change.key === 'appointment_action'));
  before.patient_workspace.enabled = true;
  const activeMove = compareAreaContracts(before, target);
  assert.equal(activeMove.compatible, false);
  assert(activeMove.blockers.some(blocker => blocker.code === 'clinical_access:patient_workspace'));
});
