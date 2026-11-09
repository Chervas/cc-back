'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { allocatePatientHistoryNumber } = require('../../services/patientHistoryNumber.service');

// Exercise the exact controller caller, not just the WhatsApp link service.
// All models, transaction storage and contacts are fictitious. In particular,
// there is deliberately no global `db` binding to mask an undeclared caller.
const controllerSource = fs.readFileSync(require.resolve('../../controllers/paciente.controller'), 'utf8');
const start = controllerSource.indexOf('exports.createPaciente = async');
const end = controllerSource.indexOf('\n/**\n * Vincula un paciente existente', start);
assert(start >= 0 && end > start, 'Patient creation controller boundary changed');
const createSource = controllerSource.slice(start, end);
const clone = value => JSON.parse(JSON.stringify(value));
const phoneKey = value => String(value || '').replace(/[^\d+]/g, '');
const emailKey = value => String(value || '').trim().toLowerCase() || null;
const existing = Object.freeze({ id_paciente: 101, nombre: 'Homónimo', apellidos: 'Ficticio',
  telefono_movil: '+447700900100', email: 'existing@example.invalid', clinica_id: 72 });
const requestBody = overrides => ({ nombre: 'Homónimo', apellidos: 'Ficticio',
  telefono_movil: '+447700900123', email: null, clinica_id: 72,
  paciente_conocido: false, creation_source: 'patient_modal', ...overrides });

function fixture({ linkFailure = null } = {}) {
  const durable = { counter: 15000, patients: [], memberships: [], events: [] };
  const state = { transactions: 0, commits: 0, rollbacks: 0, links: [], observations: [],
    duplicateChecks: [], allocationQueries: [] };
  let working;
  const transaction = {
    finished: false,
    async commit() {
      assert.equal(this.finished, false);
      Object.assign(durable, clone(working));
      this.finished = 'commit';
      state.commits++;
    },
    async rollback() {
      assert.equal(this.finished, false);
      this.finished = 'rollback';
      state.rollbacks++;
    },
  };
  const sequelize = {
    async transaction() {
      state.transactions++;
      working = clone(durable);
      return transaction;
    },
    async query(sql, options) {
      assert.equal(options.transaction, transaction, 'NHC allocation shares the creation transaction');
      state.allocationQueries.push(sql);
      if (sql.startsWith('SELECT id_clinica')) return [[{ id_clinica: 72, grupoClinicaId: 29 }]];
      if (sql.startsWith('INSERT INTO PatientHistoryCounters')) return [[], {}];
      if (sql.startsWith('SELECT next_number')) {
        assert(sql.includes('FOR UPDATE'));
        return [[{ next_number: working.counter }]];
      }
      if (sql.startsWith('UPDATE PatientHistoryCounters')) { working.counter++; return [[], {}]; }
      assert.fail('Unexpected allocator query');
    },
  };
  const models = {
    sequelize,
    Paciente: {
      async create(values, options) {
        assert.equal(options.transaction, transaction);
        const history = await allocatePatientHistoryNumber(sequelize, values.clinica_id, options.transaction);
        const patient = { id_paciente: 999001, ...values, ...history };
        working.patients.push(patient);
        return patient;
      },
    },
    PacienteClinica: {
      async create(values, options) {
        assert.equal(options.transaction, transaction);
        working.memberships.push(values);
      },
    },
  };
  const context = {
    exports: {},
    normalizePhone: value => phoneKey(value) || null,
    normalizeEmail: emailKey,
    normalizeHumanName: value => String(value || '').trim(),
    assertPatientEditAccess: async () => {},
    validatePatientProfileFields: () => ({}),
    validatePatientDeclaredOrigin: () => ({}),
    async findDuplicatePaciente(query) {
      state.duplicateChecks.push(query);
      return (query.telefono && phoneKey(query.telefono) === phoneKey(existing.telefono_movil))
        || (query.email && emailKey(query.email) === existing.email) ? existing : null;
    },
    buildPacienteDuplicadoPayloadForRequest: async (_req, args) => ({
      error: 'PACIENTE_DUPLICADO', message: 'Contacto duplicado ficticio',
      paciente: args.paciente, sameClinic: true,
    }),
    sequelize,
    Paciente: models.Paciente,
    PacienteClinica: models.PacienteClinica,
    generateUniquePacientePublicId: async () => 'pac_same_name_fictitious_only',
    languageForNewPatient: () => 'es',
    PATIENT_EVENT_TYPES: { created: 'patient.created' },
    normalizeOperationalSource: value => value,
    async recordPatientOperationalEvent(values) {
      assert.equal(values.transaction, transaction);
      working.events.push({ patientId: values.patientId, clinicId: values.clinicId, eventType: values.eventType });
    },
    sendAccessPolicyError: () => false,
    require(name) {
      if (name === '../../models') return models;
      if (name === '../services/newPatientWhatsappConversation.service') return {
        async link(values) {
          assert.equal(values.db, models, 'The linker receives the actual caller model namespace');
          assert.equal(values.transaction, transaction);
          assert.equal(values.clinicId, 72);
          assert.equal(values.patient.id_paciente, 999001);
          state.links.push(values);
          if (linkFailure) throw linkFailure;
          return null;
        },
      };
      if (name === '../services/temporaryPatientDirection.service') return {
        async observePatient(patient, actorId) {
          assert.equal(transaction.finished, 'commit', 'Existing observer stays after the atomic commit');
          assert.equal(durable.patients.length, 1);
          state.observations.push({ patientId: patient.id_paciente, actorId });
        },
      };
      assert.fail(`Unexpected dependency ${name}`);
    },
  };
  vm.runInNewContext(createSource, context, { filename: 'patient-create-controller.fixture.js' });
  async function invoke(overrides) {
    let status = 200;
    let body;
    await context.exports.createPaciente({ body: requestBody(overrides), userData: { userId: 501 } }, {
      status(value) { status = value; return this; },
      json(value) { body = clone(value); return this; },
    });
    return { status, body };
  }
  return { state, durable, invoke };
}

test('different contact with the same name creates a distinct patient and passes models into the transaction linker', async () => {
  const f = fixture();
  const result = await f.invoke();
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.paciente.nombre, existing.nombre);
  assert.equal(result.body.paciente.apellidos, existing.apellidos);
  assert.notEqual(result.body.paciente.id_paciente, existing.id_paciente);
  assert.equal(result.body.paciente.numero_historia, '15000');
  assert.equal(result.body.paciente.historia_scope, 'group:29');
  assert.equal(f.state.links.length, 1);
  assert.equal(f.state.commits, 1);
  assert.equal(f.state.rollbacks, 0);
  assert.equal(f.durable.counter, 15001);
  assert.equal(f.durable.patients.length, 1);
  assert.equal(f.durable.memberships.length, 1);
  assert.equal(f.durable.events.length, 1);
  assert.equal(f.state.observations.length, 1);
  assert.deepEqual(Object.keys(f.state.duplicateChecks[0]).sort(), ['clinicaId', 'email', 'scope', 'telefono']);
  assert.equal(f.state.duplicateChecks[0].scope, 'grupo');
});

for (const [kind, overrides] of [
  ['phone', { telefono_movil: existing.telefono_movil }],
  ['email', { email: existing.email.toUpperCase() }],
]) {
  test(`a matching ${kind} remains a contact duplicate and does not allocate or create anything`, async () => {
    const f = fixture();
    const result = await f.invoke(overrides);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'PACIENTE_DUPLICADO');
    assert.equal(f.state.transactions, 0);
    assert.equal(f.state.allocationQueries.length, 0);
    assert.equal(f.state.links.length, 0);
    assert.equal(f.state.observations.length, 0);
    assert.deepEqual(f.durable, { counter: 15000, patients: [], memberships: [], events: [] });
  });
}

test('a linker failure rolls back the patient, clinic membership and NHC allocation before any observer', async () => {
  const f = fixture({ linkFailure: new Error('fictitious_link_failure') });
  const result = await f.invoke();
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'fictitious_link_failure');
  assert.equal(f.state.links.length, 1);
  assert.equal(f.state.commits, 0);
  assert.equal(f.state.rollbacks, 1);
  assert.equal(f.state.observations.length, 0);
  assert.deepEqual(f.durable, { counter: 15000, patients: [], memberships: [], events: [] });
});
