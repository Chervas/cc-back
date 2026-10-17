'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Sequelize = require('sequelize');
const profile = require('../../lib/patient-profile-fields');
const migration = require('../../../migrations/20261012100000-add-patient-profile-and-medical-notes');

const ROOT = path.resolve(__dirname, '../../..');
const NOTES = 'FICTITIOUS_MEDICAL_NOTE';
const VALUES = Object.freeze({
  notas_medicas: `${NOTES}\n  Preserve spacing  `,
  direccion: 'Calle ficticia, 1\nPiso 2', codigo_postal: '00123',
  poblacion: 'Población ficticia', provincia: 'Provincia ficticia', pais: 'ES',
  pais_origen: 'PT', estudios: 'Otros estudios', tiene_hijos: false,
});
const keys = profile.PATIENT_PROFILE_FIELD_NAMES;

function schemaColumn(field) {
  const spec = profile.PATIENT_PROFILE_FIELD_SPECS[field];
  return { type: spec.kind === 'boolean' ? 'TINYINT(1)' : spec.kind === 'text' ? 'TEXT' : `VARCHAR(${spec.maxLength})`,
    allowNull: true, defaultValue: null };
}
function schemaFixture({ existing = {}, race = null, failure = null } = {}) {
  const state = { definition: { id_paciente: { type: 'INTEGER', allowNull: false }, ...existing }, additions: [], descriptions: 0 };
  const queryInterface = {
    async describeTable(table) { assert.equal(table, 'Pacientes'); state.descriptions++; return { ...state.definition }; },
    async addColumn(table, field, definition) {
      assert.equal(table, 'Pacientes');
      state.additions.push({ field, definition });
      if (failure) throw failure;
      if (race && race(field, state)) throw Object.assign(new Error('duplicate column'), { original: { code: 'ER_DUP_FIELDNAME' } });
      state.definition[field] = schemaColumn(field);
    },
  };
  return { state, queryInterface };
}

function controllerFixture({ denied = false, sensitive = true, row = {} } = {}) {
  const state = { saves: 0, creates: 0, relationCreates: 0, linkCreates: 0, customWrites: 0,
    transactions: 0, commits: 0, rollbacks: 0, operationalWrites: 0, observerCalls: 0, logs: [] };
  const patient = {
    id_paciente: 901, public_id: 'pac_fictitious', clinica_id: 71,
    nombre: 'Paciente ficticio', apellidos: 'Prueba', telefono_movil: null, email: null,
    antecedentes: 'Antecedente previo', alergias: 'Alergia previa', medicacion: 'Medicación previa',
    notas_paciente: 'Nota interna previa: no reclasificar',
    camposPersonalizados: [{ field_key: 'cliniccloud_history_contact_901', source: 'cliniccloud', value: 'ARCHIVE_UNCHANGED', clinica_id: 71 }],
    relaciones: [{ tipo_relacion: 'tutor_legal', es_contacto_principal: true,
      relacionado: { id_paciente: 902, nombre: 'Tutor ficticio', clinica_id: 72, ...VALUES } }],
    ...VALUES, ...row,
    async save() { state.saves++; },
    toJSON() { const { save, toJSON, ...plain } = this; return plain; },
  };
  const empty = { findAll: async () => [], findOne: async () => null, count: async () => 0 };
  const models = {
    Paciente: {
      sequelize: { escape: value => `'${String(value).replaceAll("'", "''")}'` },
      async findOne(query) { return query.where?.id_paciente ? patient : null; },
      async findAll() { return [patient]; },
      async create(values) { state.creates++; state.createdValues = values; return { id_paciente: 903, ...values }; },
    },
    Clinica: { findOne: async () => ({ id_clinica: 71, grupoClinicaId: 9 }), findAll: async () => [{ id_clinica: 71 }] },
    PacienteRelacion: { create: async () => { state.relationCreates++; } },
    PacienteClinica: { create: async () => { state.linkCreates++; } },
    CitaPaciente: empty, Usuario: empty, PatientCustomField: { create: async () => { state.customWrites++; } },
    sequelize: { async transaction() { state.transactions++; return {
      finished: false,
      async commit() { state.commits++; this.finished = true; },
      async rollback() { state.rollbacks++; this.finished = true; },
    }; } },
  };
  const dependencies = {
    '../../models': models,
    sequelize: Sequelize,
    crypto: require('node:crypto'),
    '../services/platformAudit.patientReads': { wrap: (_action, handler) => handler, track() {}, patientIds: () => [] },
    '../lib/phone': require('../../lib/phone'),
    '../lib/name': require('../../lib/name'),
    '../lib/patient-language': require('../../lib/patient-language'),
    '../lib/patient-profile-fields': profile,
    '../lib/patient-declared-origin': require('../../lib/patient-declared-origin'),
    '../lib/access-policy': {
      async assertUserCanAccessFeature() {
        if (denied) throw Object.assign(new Error('access_policy_forbidden'), { status: 403, details: { feature_key: 'patients.edit' } });
      },
      getAccessibleClinicIdsForFeature: async () => [71],
      canUserAccessFeature: async () => sensitive,
    },
    '../services/patientContact.service': { PATIENT_EVENT_TYPES: { created: 'created' }, normalizeOperationalSource: value => value,
      recordPatientOperationalEvent: async () => { state.operationalWrites++; } },
    '../services/appointmentActivity.service': {},
    '../services/marketingOptOut.service': { getActiveContactRestrictionsForPatient: async () => [], resolveWhatsappNumberRestrictionAfterChange: async () => {} },
    '../lib/cliniccloud-patient-history': require('../../lib/cliniccloud-patient-history'),
    '../services/temporaryPatientDirection.service': { observePatient: async () => { state.observerCalls++; } },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(ROOT, 'src/controllers/paciente.controller.js'), 'utf8');
  new Function('require', 'module', 'exports', 'console', source)(
    name => { assert.ok(Object.hasOwn(dependencies, name), `Unexpected offline dependency: ${name}`); return dependencies[name]; },
    module, module.exports, { log: (...args) => state.logs.push(args), warn: (...args) => state.logs.push(args), error: (...args) => state.logs.push(args) },
  );
  const invoke = async (action, body = {}) => {
    let status = 200; let result;
    const req = { userData: { userId: 501 }, params: { id: '901' }, query: { clinica_id: '71' }, body };
    const res = { status(value) { status = value; return this; }, json(value) { result = JSON.parse(JSON.stringify(value)); return this; } };
    await module.exports[action](req, res);
    return { status, body: result };
  };
  return { state, patient, controller: module.exports, invoke };
}

test('new canonical fields preserve explicit values, spacing, postal zeroes and false', () => {
  assert.deepEqual(profile.validatePatientProfileFields(VALUES), VALUES);
});

test('omitted/undefined fields do not invent ES, no children or copied medical notes', () => {
  assert.deepEqual(profile.validatePatientProfileFields({ antecedentes: 'Prior text', notas_paciente: NOTES, tiene_hijos: undefined }), {});
  assert.deepEqual(profile.validatePatientProfileFields({}), {});
  assert.deepEqual(profile.validatePatientProfileFields(Object.fromEntries(keys.map(field => [field, null]))), Object.fromEntries(keys.map(field => [field, null])));
  assert.deepEqual(profile.validatePatientProfileFields({ notas_medicas: '', pais_origen: '' }), { notas_medicas: '', pais_origen: '' });
});

test('strings, booleans and clinical text reject coercions and value leakage', () => {
  for (const value of [1, {}, [], true]) {
    assert.throws(() => profile.validatePatientProfileFields({ notas_medicas: value }), error => error.status === 400 && error.details.reason === 'string_or_null_required');
  }
  for (const value of ['false', 'true', 0, 1, {}]) {
    assert.throws(() => profile.validatePatientProfileFields({ tiene_hijos: value }), error => error.status === 400 && error.details.reason === 'boolean_or_null_required');
  }
  assert.throws(() => profile.validatePatientProfileFields({ direccion: `${NOTES}\u0000` }), error => {
    assert.equal(JSON.stringify(error.details).includes(NOTES), false);
    return error.details.reason === 'null_character_not_allowed';
  });
});

test('every text/string field enforces its Unicode character limit without truncation', () => {
  for (const [field, spec] of Object.entries(profile.PATIENT_PROFILE_FIELD_SPECS)) {
    if (spec.kind === 'boolean') continue;
    const atLimit = '🙂'.repeat(spec.maxLength);
    assert.equal(profile.validatePatientProfileFields({ [field]: atLimit })[field], atLimit);
    assert.throws(() => profile.validatePatientProfileFields({ [field]: atLimit + 'x' }), error => error.details.field === field && error.details.reason === 'maximum_length_exceeded');
  }
});

test('model and migration share nine nullable attributes, with no defaults', () => {
  const attributes = profile.patientProfileAttributes(Sequelize.DataTypes);
  assert.deepEqual(Object.keys(attributes), keys);
  for (const field of keys) {
    assert.equal(attributes[field].allowNull, true);
    assert.equal(Object.hasOwn(attributes[field], 'defaultValue'), false);
  }
  const modelSource = fs.readFileSync(path.join(ROOT, 'models/paciente.js'), 'utf8');
  assert.match(modelSource, /\.\.\.patientProfileAttributes\(DataTypes\)/);
  let actualAttributes;
  class OfflineModel {
    static init(fields) { actualAttributes = fields; }
  }
  const modelModule = { exports: {} };
  new Function('require', 'module', 'exports', modelSource)(name => {
    if (name === 'sequelize') return { Model: OfflineModel };
    if (name === '../src/lib/patient-profile-fields') return profile;
    assert.fail(`Unexpected model dependency: ${name}`);
  }, modelModule, modelModule.exports);
  modelModule.exports({}, Sequelize.DataTypes);
  for (const field of keys) {
    assert.equal(actualAttributes[field].allowNull, true);
    assert.equal(Object.hasOwn(actualAttributes[field], 'defaultValue'), false);
    assert.equal(actualAttributes[field].type.toString(), attributes[field].type.toString());
  }
});

test('validation rejects non-object bodies and ignores inherited properties', () => {
  for (const value of [null, [], 'text', 7]) {
    assert.throws(() => profile.validatePatientProfileFields(value), error => error.status === 400 && error.details.reason === 'object_required');
  }
  assert.deepEqual(profile.validatePatientProfileFields(Object.create({ notas_medicas: 'Inherited value' })), {});
});

test('additive migration inserts only missing columns and is idempotent', async () => {
  const f = schemaFixture();
  await migration.up(f.queryInterface, Sequelize);
  assert.deepEqual(f.state.additions.map(call => call.field), keys);
  assert.ok(f.state.additions.every(call => call.definition.allowNull === true && !Object.hasOwn(call.definition, 'defaultValue')));
  await migration.up(f.queryInterface, Sequelize);
  assert.equal(f.state.additions.length, 9);
});

test('migration resumes exact compatible partial application without changing existing columns', async () => {
  const present = keys.slice(0, 4);
  const f = schemaFixture({ existing: Object.fromEntries(present.map(field => [field, schemaColumn(field)])) });
  await migration.up(f.queryInterface, Sequelize);
  assert.deepEqual(f.state.additions.map(call => call.field), keys.slice(4));
});

test('all conflicting preexisting schema contracts are rejected before any DDL', async () => {
  for (const column of [{ type: 'TEXT', allowNull: false, defaultValue: null },
    { type: 'TEXT', allowNull: true, defaultValue: 'default-note' }, { type: 'VARCHAR(255)', allowNull: true, defaultValue: null }]) {
    const f = schemaFixture({ existing: { notas_medicas: column } });
    await assert.rejects(migration.up(f.queryInterface, Sequelize), /patient_profile_schema_conflict:notas_medicas/);
    assert.equal(f.state.additions.length, 0);
  }
});

test('duplicate-column race is accepted only after exact nullable/default/type comparison', async () => {
  const f = schemaFixture({ race(field, state) {
    if (field !== 'notas_medicas') return false;
    state.definition[field] = schemaColumn(field); return true;
  } });
  await migration.up(f.queryInterface, Sequelize);
  const bad = schemaFixture({ race(field, state) { state.definition[field] = { ...schemaColumn(field), allowNull: false }; return true; } });
  await assert.rejects(migration.up(bad.queryInterface, Sequelize), /patient_profile_schema_conflict:notas_medicas/);
  const other = schemaFixture({ failure: Object.assign(new Error('do not mask DDL failure'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }) });
  await assert.rejects(migration.up(other.queryInterface, Sequelize), /do not mask DDL failure/);
  const missing = schemaFixture({ race: () => true });
  await assert.rejects(migration.up(missing.queryInterface, Sequelize), /duplicate column/);
});

test('migration detects schema drift between additions and stops instead of overwriting', async () => {
  const f = schemaFixture();
  const add = f.queryInterface.addColumn;
  f.queryInterface.addColumn = async (...args) => {
    await add(...args);
    f.state.definition.notas_medicas = { ...schemaColumn('notas_medicas'), defaultValue: 'Unexpected default' };
  };
  await assert.rejects(migration.up(f.queryInterface, Sequelize), /patient_profile_schema_conflict:notas_medicas/);
  assert.equal(f.state.additions.length, 1);
});

test('migration refuses destructive rollback and contains no backfill/import rewrites', async () => {
  await assert.rejects(migration.down(), /rollback_requires_explicit_data_preservation/);
  const source = fs.readFileSync(path.join(ROOT, 'migrations/20261012100000-add-patient-profile-and-medical-notes.js'), 'utf8');
  assert.doesNotMatch(source, /(?:removeColumn|changeColumn|sequelize\.query|PatientCustomFields|UPDATE\s+Pacientes|DROP\s+COLUMN)/);
});

test('PATCH persists four clinical fields distinctly and leaves legacy/imported data untouched', async () => {
  const f = controllerFixture();
  const archive = JSON.stringify(f.patient.camposPersonalizados); const relations = JSON.stringify(f.patient.relaciones);
  const response = await f.invoke('updatePaciente', { ...VALUES, antecedentes: 'Antecedentes editados', notas_medicas: 'Notas médicas nuevas' });
  assert.equal(response.status, 200); assert.equal(f.state.saves, 1);
  assert.equal(f.patient.antecedentes, 'Antecedentes editados'); assert.equal(f.patient.notas_medicas, 'Notas médicas nuevas');
  assert.equal(f.patient.alergias, 'Alergia previa'); assert.equal(f.patient.medicacion, 'Medicación previa');
  assert.equal(f.patient.notas_paciente, 'Nota interna previa: no reclasificar');
  assert.equal(JSON.stringify(f.patient.camposPersonalizados), archive); assert.equal(JSON.stringify(f.patient.relaciones), relations);
  assert.equal(f.state.customWrites, 0); assert.equal(f.state.linkCreates, 0); assert.equal(f.state.relationCreates, 0);
});

test('PATCH omission preserves all new profile values and explicit null clears only requested fields', async () => {
  const f = controllerFixture();
  assert.equal((await f.invoke('updatePaciente', { nombre: 'Nombre nuevo' })).status, 200);
  for (const field of keys) assert.equal(f.patient[field], VALUES[field]);
  assert.equal((await f.invoke('updatePaciente', { notas_medicas: null, tiene_hijos: null })).status, 200);
  assert.equal(f.patient.notas_medicas, null); assert.equal(f.patient.tiene_hijos, null);
  assert.equal(f.patient.pais_origen, 'PT'); assert.equal(f.patient.antecedentes, 'Antecedente previo');
});

test('declared acquisition source uses stable explicit codes without overwriting legacy or platform provenance', async () => {
  const f = controllerFixture({ row: { como_nos_conocio: 'recomendación', procedencia: 42 } });
  assert.equal((await f.invoke('updatePaciente', { como_nos_conocio_codigo: 'family_friend' })).status, 200);
  assert.equal(f.patient.como_nos_conocio_codigo, 'family_friend'); assert.equal(f.patient.como_nos_conocio, 'recomendación'); assert.equal(f.patient.procedencia, 42);
  const before = f.state.saves;
  assert.equal((await f.invoke('updatePaciente', { nombre: 'Must not save', como_nos_conocio_codigo: 'invented_campaign' })).status, 400);
  assert.equal(f.state.saves, before); assert.equal(f.patient.nombre, 'Paciente ficticio');
  assert.equal((await f.invoke('createPaciente', { nombre: 'Paciente nuevo', clinica_id: 71, email: 'fictitious@example.invalid', como_nos_conocio_codigo: 'invented_campaign' })).status, 400);
  assert.equal(f.state.creates + f.state.transactions, 0);
});

test('invalid mixed PATCH rejects atomically before any model mutation or write', async () => {
  const f = controllerFixture(); const before = JSON.stringify(f.patient);
  const response = await f.invoke('updatePaciente', { nombre: 'Must not change', antecedentes: 'Must not change', notas_medicas: NOTES, codigo_postal: 'x'.repeat(33) });
  assert.equal(response.status, 400); assert.equal(response.body.details.field, 'codigo_postal');
  assert.equal(JSON.stringify(f.patient), before); assert.equal(f.state.saves, 0);
  assert.equal(JSON.stringify(response.body).includes(NOTES), false); assert.equal(f.state.logs.length, 0);
});

test('deprecated notes alias and arbitrary custom-field payload cannot rewrite medical/archive data', async () => {
  const f = controllerFixture(); const before = JSON.stringify(f.patient);
  const response = await f.invoke('updatePaciente', { notas: 'Ignored old alias', camposPersonalizados: [{ field_key: 'overwrite', value: NOTES }], historia_scope: 'unexpected' });
  assert.equal(response.status, 200); assert.equal(JSON.stringify(f.patient), before);
  assert.equal(f.state.customWrites, 0);
});

test('patient edit permission denial wins without clinical/profile mutations', async () => {
  for (const action of ['updatePaciente', 'createPaciente']) {
    const f = controllerFixture({ denied: true }); const before = JSON.stringify(f.patient);
    const response = await f.invoke(action, { nombre: 'Must not change', clinica_id: 71, email: 'fictitious@example.invalid', notas_medicas: NOTES, tiene_hijos: 'invalid' });
    assert.equal(response.status, 403); assert.equal(JSON.stringify(f.patient), before);
    assert.equal(f.state.saves + f.state.creates + f.state.transactions, 0);
    assert.equal(JSON.stringify(response.body).includes(NOTES), false);
  }
});

test('CREATE persists explicitly supplied canonical fields in the patient transaction, not custom variables', async () => {
  const f = controllerFixture();
  const response = await f.invoke('createPaciente', { nombre: 'Paciente nuevo', apellidos: 'Ficticio', clinica_id: 71, email: 'fictitious@example.invalid', ...VALUES });
  assert.equal(response.status, 201); assert.equal(f.state.creates, 1); assert.equal(f.state.commits, 1);
  for (const field of keys) assert.equal(f.state.createdValues[field], VALUES[field]);
  assert.equal(f.state.customWrites, 0); assert.equal(f.state.relationCreates, 0);
});

test('CREATE omission does not copy clinical/legacy/archive notes or invent demographics', async () => {
  const f = controllerFixture();
  assert.equal((await f.invoke('createPaciente', { nombre: 'Paciente nuevo', clinica_id: 71, email: 'fictitious@example.invalid' })).status, 201);
  for (const field of keys) assert.equal(Object.hasOwn(f.state.createdValues, field), false);
});

test('invalid CREATE is rejected before opening a transaction or creating any row', async () => {
  const f = controllerFixture();
  const response = await f.invoke('createPaciente', { nombre: 'Paciente nuevo', clinica_id: 71, email: 'fictitious@example.invalid', notas_medicas: NOTES, tiene_hijos: 'false' });
  assert.equal(response.status, 400); assert.equal(f.state.transactions + f.state.creates + f.state.linkCreates + f.state.operationalWrites, 0);
  assert.equal(JSON.stringify(response.body).includes(NOTES), false);
});

test('sensitive-denied patient list redacts every new canonical field', async () => {
  const f = controllerFixture({ sensitive: false });
  const response = await f.invoke('getAllPacientes');
  assert.equal(response.status, 200); assert.equal(response.body[0].privacy_redacted, true);
  for (const field of keys) assert.equal(response.body[0][field], null);
  assert.equal(JSON.stringify(response.body).includes(NOTES), false);
});

test('cross-clinic guardian payload redacts the new fields without deleting the relationship', () => {
  const f = controllerFixture();
  const payload = f.controller.__patientClinicScopeContract.restrictPacientePayloadToClinics(f.patient, [71]);
  assert.equal(payload.relaciones.length, 1); assert.equal(payload.relaciones[0].tipo_relacion, 'tutor_legal');
  assert.equal(payload.relaciones[0].relacionado.privacy_redacted, true);
  for (const field of keys) assert.equal(payload.relaciones[0].relacionado[field], null);
});

test('medical notes are not added to marketing patient variables or imported archive mappings', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/services/marketingBulkSends.service.js'), 'utf8');
  const start = source.indexOf('function buildPatientVariableFields(');
  const block = source.slice(start, source.indexOf('function patientMatchesItem(', start));
  assert.doesNotMatch(block, /notas_medicas|patientProfileAttributes|PATIENT_PROFILE/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src/lib/cliniccloud-patient-history.js'), 'utf8'), /notas_medicas/);
});
