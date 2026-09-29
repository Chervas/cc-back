'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { careState, assertCareAction } = require('../../lib/appointment-care');
const q = require('../../lib/patient-intake-questionnaire');
const now = new Date('2026-09-29T10:00:00Z');
const appointment = () => ({ estado: 'recordatorio_confirmado', paciente_id: 1, inicio: new Date('2026-09-29T09:00:00Z') });
test('arrival never changes canonical state and is not clinical completion', () => {
  const a = appointment(); const before = JSON.stringify(a);
  assert.equal(careState(a, now).can_arrive, true);
  assertCareAction(a, 'arrive', now);
  assert.equal(JSON.stringify(a), before);
});
test('future appointments, holds and terminal appointments cannot arrive', () => {
  assert.throws(() => assertCareAction({ ...appointment(), inicio: '2026-09-30T10:00:00Z' }, 'arrive', now), /hora/);
  for (const estado of ['completada', 'no_asistio', 'cancelada', 'reprogramada']) {
    assert.throws(() => assertCareAction({ ...appointment(), estado }, 'arrive', now), /no admite/);
  }
  assert.throws(() => assertCareAction({ ...appointment(), es_provisional: true }, 'arrive', now), /no admite/);
});
test('start needs arrival on the CURRENT schedule, double click is identifiable', () => {
  const a = appointment(); assert.throws(() => assertCareAction(a, 'start', now), /primero/);
  a.arrived_at = now; a.care_schedule_start = a.inicio;
  assert.equal(assertCareAction(a, 'start', now).can_start, true);
  a.care_started_at = now;
  assert.equal(assertCareAction(a, 'start', now).started_at, now);
  a.inicio = new Date('2026-09-29T12:00:00Z');
  assert.equal(careState(a, now).arrived_at, null);
  assert.throws(() => assertCareAction(a, 'start', now), /primero/);
});
const submission = () => ({ schema_version: q.VERSION, expected_version: 1, reviewed_answers: true,
  personal: { nombre: 'Paciente', apellidos: 'Ficticio', dni: '', fecha_nacimiento: '', email: '', telefono_movil: '' },
  answers: { medication: 'Declaración del paciente', pregnancy: 'unknown' } });
test('intake uses an explicit reviewed submission and a fixed schema', () => {
  const v = q.validateSubmission(submission());
  assert.equal(v.answers.medication, 'Declaración del paciente'); assert.equal(v.answers.pregnancy, 'unknown');
  assert.equal(q.suggestedSummary(v.answers).alergias, ''); // Unknown is never turned into "no allergies".
  assert.throws(() => q.validateSubmission({ ...submission(), reviewed_answers: false }), /Revisa/);
  assert.throws(() => q.validateSubmission({ ...submission(), schema_version: 'other' }), /Revisa/);
  assert.throws(() => q.validateSubmission({ ...submission(), expected_version: '1' }), /abrir/);
});
test('answers are bounded, allowlisted, not arbitrary model fields', () => {
  assert.throws(() => q.validateSubmission({ ...submission(), answers: { pregnancy: true } }), /Revisa/);
  assert.throws(() => q.validateSubmission({ ...submission(), answers: { medication: 'a'.repeat(2001) } }), /Revisa/);
  const p = submission(); p.personal.clinica_id = 900; p.answers.reviewed_by = 1;
  const parsed = q.validateSubmission(p); assert.equal(parsed.personal.clinica_id, undefined); assert.equal(parsed.answers.reviewed_by, undefined);
});
