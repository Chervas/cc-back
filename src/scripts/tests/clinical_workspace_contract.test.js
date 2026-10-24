'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../../lib/clinical-episode-contract');
const { medicationItems } = require('../../services/patientClinicalMedication.service');
const { createMaterialValidator } = require('../../services/clinicalEpisodeMaterials.service');

test('manual diagnoses keep stable identity and descriptive notes without accepting invented codes', () => {
  const diagnosis = { id: crypto.randomUUID(), label: 'Orientación registrada', notes: 'Observación del profesional' };
  const before = JSON.stringify(diagnosis);
  assert.deepEqual(C.normalizePatch({ diagnoses: [diagnosis] }).diagnoses, [diagnosis]);
  assert.equal(JSON.stringify(diagnosis), before);
  assert.deepEqual(C.normalizePatch({ diagnoses: [] }).diagnoses, []);
  assert.equal(Object.hasOwn(C.normalizePatch({ summary: 'Otro cambio' }, { diagnoses: [diagnosis] }), 'diagnoses'), false);
  for (const diagnoses of [null, {}, [diagnosis, diagnosis], [{ ...diagnosis, code: 'INVENTED' }], [{ ...diagnosis, label: '' }], [{ ...diagnosis, id: 'unstable-id' }], Array(51).fill(diagnosis)]) {
    assert.throws(() => C.normalizePatch({ diagnoses }), { code: 'clinical_diagnoses_invalid' });
  }
  assert.throws(() => C.normalizePatch({ diagnoses: [{ ...diagnosis, notes: 'x'.repeat(2001) }] }), { statusCode: 400 });
});

test('medication stores name, dose, frequency and optional instructions as separate text without interpretation', () => {
  const item = { id: crypto.randomUUID(), name: 'Referencia ficticia', dose: 'Dosis indicada', frequency: 'Según revisión', instructions: 'Observaciones' };
  const before = JSON.stringify(item);
  assert.deepEqual(medicationItems([item]), [item]);
  assert.equal(JSON.stringify(item), before);
  assert.deepEqual(medicationItems([{ id: item.id, name: item.name }]), [{ id: item.id, name: item.name, dose: '', frequency: '', instructions: '' }]);
  for (const input of [null, {}, [item, item], [{ ...item, name: '' }], [{ ...item, prescription: true }], [{ ...item, dose: 2 }], [{ ...item, id: 'not-a-uuid' }], Array(101).fill(item)]) {
    assert.throws(() => medicationItems(input), { statusCode: 400 });
  }
  assert.throws(() => medicationItems([{ ...item, frequency: 'x'.repeat(201) }]), { statusCode: 400 });
});

test('photo roles are explicit, scope checked and conflicting duplicates fail before being silently discarded', async () => {
  const photo = { public_id: 'private-photo', purpose: 'clinical_attachment', content_type: 'image/png', sha256: 'a'.repeat(64), original_filename: 'Imagen.png' };
  const db = { ClinicalPrivateAsset: { findOne: async ({ where }) => where.patient_id === 11 && where.clinic_id === 72 && where.public_id === photo.public_id ? photo : null } };
  const validate = createMaterialValidator({ db, canAccess: async () => true });
  const context = { patientId: 11, clinicId: 72, actorId: 7 };
  assert.equal((await validate({ ...context, refs: [{ kind: 'attachment', id: photo.public_id, phase: 'before' }] }))[0].phase, 'before');
  assert.equal((await validate({ ...context, refs: [{ kind: 'attachment', id: photo.public_id }, { kind: 'attachment', id: photo.public_id, phase: 'other' }] })).length, 1);
  await assert.rejects(validate({ ...context, refs: [{ kind: 'attachment', id: photo.public_id, phase: 'before' }, { kind: 'attachment', id: photo.public_id, phase: 'after' }] }), { code: 'clinical_material_phase_conflict' });
  await assert.rejects(validate({ ...context, clinicId: 73, refs: [{ kind: 'attachment', id: photo.public_id }] }), { code: 'clinical_material_not_found' });
  await assert.rejects(validate({ ...context, refs: [{ kind: 'drawing', id: photo.public_id, phase: 'before' }] }), { code: 'clinical_material_phase_invalid' });
  photo.content_type = 'application/pdf';
  await assert.rejects(validate({ ...context, refs: [{ kind: 'attachment', id: photo.public_id, phase: 'after' }] }), { code: 'clinical_material_phase_invalid' });
  const denied = createMaterialValidator({ db, canAccess: async () => false });
  await assert.rejects(denied({ ...context, refs: [{ kind: 'attachment', id: photo.public_id }] }), { code: 'clinical_material_forbidden' });
});
