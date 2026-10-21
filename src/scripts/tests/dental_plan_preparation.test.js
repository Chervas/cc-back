'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createDentalPlanPreparationService } = require('../../services/dentalPlanPreparation.service');
const { createDentalPlansController } = require('../../controllers/dentalPlans.controller');

function fixture(overrides = {}) {
  const at = new Date('2030-01-01T10:00:00Z');
  const state = { acts: [{ id: 'a', status: 'pending', targets: [{ id: 'ta' }] }, { id: 'b', status: 'pending', targets: [{ id: 'tb' }] }],
    sessions: [{ id: 'session', status: 'reviewed', act_ids: ['a', 'b'], appointment_ids: [10], protocol_acknowledgements: [] }],
    reservations: [{ appointment_id: 10, session_id: 'session', act_ids: ['a'] }], dependencies: [], protocol_warnings: [], protocol_requirements: [], execution: [] };
  const row = { id: 1, public_id: 'owned-plan', patient_id: 5, clinic_id: 72, version_number: 4, state };
  const appointment = { id_cita: 10, paciente_id: 5, clinica_id: 72, estado: 'en_atencion', inicio: at, fin: new Date(+at + 1800000), care_schedule_start: at, arrived_at: at, care_started_at: at };
  const tx = { LOCK: { SHARE: 'SHARE' } }, reads = [], evaluators = [];
  const db = { sequelize: { transaction: async (options, body) => { reads.push('transaction'); assert.equal(options.isolationLevel, 'READ COMMITTED'); return body(tx); } },
    Paciente: { findByPk: async (id, options) => { reads.push('patient'); assert.equal(id, 5); assert.equal(options.lock, 'SHARE'); return { id_paciente: 5 }; } },
    DentalPlan: { findOne: async options => { reads.push('plan'); assert.deepEqual(options.where, { id: 1, public_id: 'owned-plan', clinic_id: 72, patient_id: 5 }); assert.equal(options.lock, 'SHARE'); return row; } },
    Clinica: { findByPk: async () => ({ configuracion: { timezone: 'Europe/Madrid' } }) },
    CitaPaciente: { findOne: async options => { assert.deepEqual(options.where, { id_cita: 10, clinica_id: 72, paciente_id: 5 }); return appointment; } } };
  const caps = { clinical_view: false, clinical_manage: false, logistics_manage: true };
  const core = { authorize: async () => { reads.push('authorize'); return caps; }, scopedPlan: async options => { reads.push('scope'); assert.equal(options.patientIdentifier, 5); return row; }, readTools: async () => ({ version: 2, evidences: [], lab_orders: [] }) };
  const allow = name => async input => { evaluators.push(name); assert.equal(input.transaction, tx); assert.equal(input.appointment.paciente_id, 5); return { allowed: true }; };
  const service = createDentalPlanPreparationService({ db, core, now: () => at, assessConsent: allow('consent'), assessPrivacy: allow('privacy'), registrationDocuments: async input => { evaluators.push('registration'); assert.equal(input.requiredOnly, true); return { required_before_first_care: false, items: [] }; }, assertProtocolConsents: async () => {}, ...overrides });
  const options = { id: row.public_id, clinicId: 72, actorId: 7, patientIdentifier: 5, query: { session_id: 'session', appointment_id: '10' } };
  return { service, options, state, row, appointment, core, db, caps, reads, evaluators };
}

test('preparation is exact-reservation scoped, uses read evaluators and shared patient→plan locks without mutation models', async () => {
  const f = fixture(); f.core.readTools = async () => ({ version: 3, lab_orders: [{ id: 'other-act-lab', act_ids: ['b'], status: 'received' }], evidences: [] });
  const result = await f.service.read(f.options);
  assert.equal(result.status, 'ready'); assert.equal(result.coverage.complete, true); assert.deepEqual(result.act_ids, ['a']); assert.equal(result.tools_version, 3);
  assert.deepEqual(f.reads.slice(0, 5), ['authorize', 'transaction', 'scope', 'patient', 'plan']);
  assert.deepEqual(f.evaluators, ['consent', 'privacy', 'registration']); assert.equal(result.capabilities.clinical_manage, false);
  assert(!JSON.stringify(result).includes('other-act-lab')); assert.equal(f.row.version_number, 4); assert.equal(f.state.execution.length, 0);
});

test('required RX and laboratory are assessed per act; reception remains a clinical pending task', async () => {
  const f = fixture(); f.state.reservations[0].act_ids = ['a', 'b'];
  f.state.protocol_requirements = [{ code: 'rx-rule', action: 'block', source_type: 'test', source_ref: 'rx', act_ids: ['a', 'b'] }, { code: 'lab-rule', action: 'block', source_type: 'laboratory', act_ids: ['a', 'b'] }];
  f.core.readTools = async () => ({ version: 4, evidences: [{ id: 'rx-a', kind: 'rx', act_ids: ['a'], clinical_status: 'approved' }], lab_orders: [{ id: 'lab-a', act_ids: ['a'], status: 'approved' }, { id: 'lab-b', act_ids: ['b'], status: 'received' }] });
  const result = await f.service.read(f.options);
  assert.equal(result.status, 'pending'); assert(result.issues.some(issue => issue.code === 'laboratory_received' && issue.responsible_role === 'clinical' && issue.action.id === 'lab-b'));
  assert(result.issues.some(issue => issue.code === 'evidence_required' && issue.act_ids.join() === 'b'));
  assert.equal(result.checks.laboratory, 'pending'); assert.equal(result.checks.evidence, 'pending'); assert.equal(result.coverage.complete, true);
  assert(!JSON.stringify(result).includes('approved by inference'));
});

test('a protocol-only gap for B is not cleared by A, while explicit whole-session evidence covers both', async () => {
  const f = fixture(); f.state.reservations[0].act_ids = ['a', 'b'];
  f.state.protocol_requirements = [{ code: 'rx-rule', action: 'block', source_type: 'test', source_ref: 'rx', act_ids: ['a', 'b'] }];
  const tools = { version: 2, evidences: [{ id: 'rx-a', kind: 'rx', act_ids: ['a'], clinical_status: 'approved' }], lab_orders: [] }; f.core.readTools = async () => tools;
  let result = await f.service.read(f.options); assert.equal(result.status, 'pending'); assert(result.issues.some(issue => issue.code === 'evidence_required' && issue.act_ids.join() === 'b'));
  tools.evidences[0].session_ids = ['session']; result = await f.service.read(f.options); assert.equal(result.status, 'ready');
});

test('configuration/read failures are unknown and sanitized; tools unavailable never masquerades as historical zero', async () => {
  const f = fixture({ assessPrivacy: async () => { throw Error('SELECT /private secret clinical-data'); } }); f.core.readTools = async () => { throw Error('DB private secret'); };
  const result = await f.service.read(f.options);
  assert.equal(result.status, 'unknown'); assert.equal(result.coverage.complete, false); assert.equal(result.tools_version, null);
  assert(result.coverage.unknown_codes.includes('materials_unavailable')); assert(result.coverage.unknown_codes.includes('privacy_required_unavailable'));
  assert(!JSON.stringify(result).includes('secret')); assert(!JSON.stringify(result).includes('/private')); assert(!JSON.stringify(result).includes('SELECT'));
});

test('canonical document evidence and arrival are required; reviewing the session alone never marks preparation ready', async () => {
  const f = fixture({ assessConsent: async () => ({ allowed: false }) }); f.appointment.care_started_at = null; f.appointment.arrived_at = null; f.appointment.estado = 'pendiente'; f.state.sessions[0].status = 'pending';
  const result = await f.service.read(f.options); assert.equal(result.status, 'pending');
  for (const code of ['session_review_required', 'clinical_consent_required', 'care_arrival_required']) assert(result.issues.some(issue => issue.code === code));
  assert.equal(result.checks.documents, 'pending'); assert.equal(result.checks.care, 'pending');
});

test('no selected reservation reports start/document coverage unknown and keeps independent consultation possible', async () => {
  const f = fixture(); delete f.options.query.appointment_id; f.state.sessions[0].appointment_ids = []; f.state.reservations = [];
  const result = await f.service.read(f.options); assert.equal(result.appointment_id, null); assert.equal(result.status, 'unknown'); assert.equal(result.coverage.complete, false); assert(result.issues.some(issue => issue.code === 'appointment_start_not_evaluated' && issue.severity === 'unknown'));
});

test('mismatched/absorbed scopes and historical query reject before a misleading projection; ACL denial precedes DB', async () => {
  const f = fixture(); await assert.rejects(f.service.read({ ...f.options, query: { session_id: 'session', appointment_id: '99' } }), { code: 'dental_reservation_scope_invalid' });
  f.state.sessions[0].status = 'absorbed'; await assert.rejects(f.service.read(f.options), { code: 'dental_session_not_found' });
  await assert.rejects(f.service.read({ ...f.options, query: { ...f.options.query, version: '1' } }), { code: 'dental_preparation_current_only' });
  const denied = fixture(); denied.core.authorize = async () => { throw Object.assign(Error('forbidden'), { code: 'dental_forbidden', statusCode: 403 }); };
  await assert.rejects(denied.service.read(denied.options), { code: 'dental_forbidden' }); assert.equal(denied.reads.length, 0);
});

test('preparation HTTP preserves requested scope and read-only cache policy; no auth reaches no evaluator', async () => {
  const res = () => ({ code: 200, set() { return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  let calls = 0, seen; const controller = createDentalPlansController({ preparations: { read: async input => { calls++; seen = input; return { status: 'unknown' }; } } });
  const request = { params: { id: 'owned-plan' }, query: { clinic_id: '72', patient_id: '5', session_id: 'session', appointment_id: '10' }, body: {}, userData: { userId: 7 } };
  const response = res(); await controller.preparation(request, response); assert.equal(calls, 1); assert.equal(seen.patientIdentifier, 5); assert.equal(seen.query.appointment_id, '10'); assert.equal(response.body.status, 'unknown');
  const denied = res(); await controller.preparation({ ...request, userData: null }, denied); assert.equal(denied.code, 401); assert.equal(calls, 1);
});
