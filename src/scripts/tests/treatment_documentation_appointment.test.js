#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Sequelize = require('sequelize');
const { createTreatmentDocumentationService, fail } = require('../../services/treatmentDocumentation.service');

function fixture() {
  const calls = [];
  const appointment = { id_cita: 100, paciente_id: 20, tratamiento_id: 30 };
  const approved = (id, kind = 'protocol') => ({ id, clinic_id: 10, version: 2, title: 'Documento ficticio', kind, status: 'approved', treatment_ids: [30],
    content: 'Contenido aprobado ficticio', source: 'Referencia ficticia', approved_by: 7, approved_at: '2026-09-07T00:00:00Z' });
  const current = [approved(1), approved(2, 'aftercare')];
  const revisions = current.map(snapshot => ({ protocol_id: snapshot.id, version: 2, snapshot }));
  const state = { appointment, current, revisions, patientClinic: 10, patientLinked: false, missingSchema: false };
  const db = {
    Sequelize,
    Clinica: { findByPk: async () => ({ id_clinica: 10, grupoClinicaId: 50 }) },
    CitaPaciente: { findOne: async ({ where }) => where.id_cita === 100 && where.clinica_id === 10 ? state.appointment : null },
    Paciente: { findByPk: async () => ({ id_paciente: 20, clinica_id: state.patientClinic }) },
    PacienteClinica: { findOne: async () => state.patientLinked ? { id: 1 } : null },
    Tratamiento: { findOne: async options => { calls.push(options); return { id_tratamiento: 30, nombre: 'Tratamiento ficticio' }; } },
    TreatmentProtocol: {
      findOne: async () => { if (state.missingSchema) throw Object.assign(new Error('private SQL text'), { original: { code: 'ER_NO_SUCH_TABLE' } }); return { id: 1 }; },
      findAndCountAll: async options => { calls.push(options); return { rows: state.current.slice(options.offset, options.offset + options.limit), count: state.current.length }; },
      count: async options => { calls.push(options); return 1; },
    },
    TreatmentProtocolRevision: { findAll: async options => { calls.push(options); return state.revisions.filter(revision => options.where[Sequelize.Op.or].some(pair => pair.protocol_id === revision.protocol_id && pair.version === revision.version)); } },
  };
  return { state, calls, service: createTreatmentDocumentationService(db) };
}

test('appointment context returns only exact approved snapshots, not mutable text or patient PII', async () => {
  const { service, state, calls } = fixture();
  state.current[0] = { ...state.current[0], content: 'Mutable text that must never be served' };
  const result = await service.forAppointment({ clinicId: 10, appointmentId: 100 });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].content, 'Contenido aprobado ficticio');
  assert.equal(result.items[1].kind, 'aftercare');
  assert.equal(result.draft_count, 1);
  assert.equal(result.context_source, 'current_approved_catalog');
  assert.equal(result.persisted_for_appointment, false);
  assert(!Object.hasOwn(result, 'patient_id'));
  assert(!Object.hasOwn(result.items[0], 'approved_by'));
  const approvalQuery = calls.find(call => call.where.status === 'approved');
  assert.equal(approvalQuery.limit, 5);
  assert.equal(approvalQuery.where.clinic_id, 10);
  assert.deepEqual(approvalQuery.attributes, ['id', 'version']);
  const draftQuery = calls.find(call => call.where.status === 'draft');
  assert(draftQuery, 'draft content is not retrieved, only counted');
});

test('approved record with missing/wrong/draft revision fails closed without leaking contents', async () => {
  const { service, state } = fixture();
  state.revisions[0].snapshot = { ...state.revisions[0].snapshot, clinic_id: 99, content: 'Cross-clinic private text' };
  state.revisions[1].snapshot = { ...state.revisions[1].snapshot, status: 'draft', content: 'Draft unsafe instructions' };
  const result = await service.forAppointment({ clinicId: 10, appointmentId: 100 });
  assert.deepEqual(result.items, []);
  assert.equal(result.unavailable_count, 2);
  assert(!JSON.stringify(result).includes('Cross-clinic'));
  assert(!JSON.stringify(result).includes('Draft unsafe'));
  state.revisions = [];
  assert.equal((await service.forAppointment({ clinicId: 10, appointmentId: 100 })).unavailable_count, 2);
});

test('patient and appointment clinic boundary, scope link, no-treatment and schema-pending are explicit', async () => {
  const { service, state } = fixture();
  await assert.rejects(service.forAppointment({ clinicId: 11, appointmentId: 100 }), { statusCode: 404 });
  await assert.rejects(service.forAppointment({ clinicId: 10, appointmentId: '100 OR 1' }), { statusCode: 400 });
  state.patientClinic = 11;
  await assert.rejects(service.forAppointment({ clinicId: 10, appointmentId: 100 }), { statusCode: 404 });
  state.patientLinked = true;
  assert.equal((await service.forAppointment({ clinicId: 10, appointmentId: 100 })).items.length, 2);
  state.missingSchema = true;
  await assert.rejects(service.forAppointment({ clinicId: 10, appointmentId: 100 }), error => error.statusCode === 503 && !error.message.includes('SQL'));
  state.appointment.tratamiento_id = null;
  assert.equal((await service.forAppointment({ clinicId: 10, appointmentId: 100 })).documentation_status, 'no_treatment');
});

test('contextual documents are bounded and paginated', async () => {
  const { service } = fixture();
  const first = await service.forAppointment({ clinicId: 10, appointmentId: 100, query: { page_size: 1 } });
  assert.equal(first.items.length, 1);
  assert.equal(first.total, 2);
  assert.equal(first.has_more, true);
  const second = await service.forAppointment({ clinicId: 10, appointmentId: 100, query: { page_size: 1, page: 1 } });
  assert.equal(second.items[0].kind, 'aftercare');
  assert.equal(second.has_more, false);
  await assert.rejects(service.forAppointment({ clinicId: 10, appointmentId: 100, query: { page_size: 11 } }), { statusCode: 400 });
});

test('HTTP contextual route demands sensitive and clinical permissions before reaching the service', async () => {
  const middleware = [], routes = new Map(), checks = [];
  let queried = false;
  const router = {
    use: fn => middleware.push(fn), get: (route, fn) => routes.set(route, fn), post: () => {}, patch: () => {},
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../../routes/treatmentDocumentation.routes.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    if (name === 'express') return { Router: () => router };
    if (name === 'express-async-handler') return require(name);
    if (name === './auth.middleware') return (req, res, next) => next();
    if (name === '../lib/access-policy') return { canUserAccessFeature: async ({ featureKey }) => { checks.push(featureKey); return featureKey !== 'patients.sensitive.view'; } };
    if (name === '../services/treatmentDocumentation.service') return { fail, createTreatmentDocumentationService: () => ({ forAppointment: async () => { queried = true; return {}; } }) };
    throw new Error(`Unexpected require ${name}`);
  } });
  const req = { method: 'GET', query: { clinic_id: '10' }, params: { id: '100' }, userData: { userId: 7 } };
  const res = { set: () => res, json: () => res };
  for (const fn of middleware.filter(fn => fn.length < 4)) await fn(req, res, error => { if (error) throw error; });
  await assert.rejects(routes.get('/for-appointment/:id')(req, res, error => { throw error; }), { statusCode: 403 });
  assert.equal(queried, false);
  for (const feature of ['appointments.view', 'patients.view', 'patients.sensitive.view', 'clinical.reports.view']) assert(checks.includes(feature));
});
