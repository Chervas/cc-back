'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  applyExplicitPatientLanguage,
  createAppointmentWithPatientLanguage,
  languageForNewPatient,
  normalizePatientLanguage,
  preferredLanguagePayload,
} = require('../../lib/patient-language');

const root = path.resolve(__dirname, '../../..');
const migration = require(path.join(root, 'migrations/20260720090000-add-patient-preferred-language.js'));

test('pacientes nuevos sin selección explícita nacen en español', () => {
  assert.equal(languageForNewPatient(undefined), 'es');
});

test('omitir idioma al agendar conserva catalán o inglés sin escribir', async () => {
  for (const idioma_preferido of ['ca', 'en']) {
    let writes = 0;
    const patient = {
      idioma_preferido,
      async update() { writes += 1; },
    };
    assert.equal(await applyExplicitPatientLanguage(patient, undefined), false);
    assert.equal(patient.idioma_preferido, idioma_preferido);
    assert.equal(writes, 0);
  }
});

test('enviar español explícitamente cambia un paciente catalán', async () => {
  const updates = [];
  const patient = {
    idioma_preferido: 'ca',
    async update(value) { updates.push(value); },
  };
  assert.equal(await applyExplicitPatientLanguage(patient, 'es'), true);
  assert.deepEqual(updates, [{ idioma_preferido: 'es' }]);
  assert.equal(patient.idioma_preferido, 'es');
});

test('la actualización explícita reenvía la transacción de la cita', async () => {
  const transaction = { id: 'appointment-language-transaction' };
  const calls = [];
  const patient = {
    idioma_preferido: 'es',
    async update(value, options) { calls.push({ value, options }); },
  };

  assert.equal(
    await applyExplicitPatientLanguage(patient, 'ca', { transaction }),
    true,
  );
  assert.deepEqual(calls, [{
    value: { idioma_preferido: 'ca' },
    options: { transaction },
  }]);
});

test('si falla el idioma, la transacción revierte la cita y no queda cita fantasma', async () => {
  const persistedAppointments = [];
  const transaction = { id: 'tx-rollback-proof' };
  const sequelize = {
    async transaction(work) {
      const before = persistedAppointments.length;
      try {
        return await work(transaction);
      } catch (error) {
        persistedAppointments.splice(before);
        throw error;
      }
    },
  };
  const AppointmentModel = {
    async create(values, options) {
      assert.deepEqual(options, { transaction });
      const appointment = { id: 99, ...values };
      persistedAppointments.push(appointment);
      return appointment;
    },
  };
  const patient = {
    idioma_preferido: 'es',
    async update() { throw new Error('patient_language_write_failed'); },
  };

  await assert.rejects(
    createAppointmentWithPatientLanguage({
      sequelize,
      AppointmentModel,
      appointmentValues: { paciente_id: 7 },
      patient,
      requestedLanguage: 'ca',
    }),
    /patient_language_write_failed/,
  );
  assert.deepEqual(persistedAppointments, []);
});

test('repetir el mismo idioma no genera una escritura concurrente innecesaria', async () => {
  let writes = 0;
  const patient = {
    idioma_preferido: 'en',
    async update() { writes += 1; },
  };
  assert.equal(await applyExplicitPatientLanguage(patient, 'en'), false);
  assert.equal(writes, 0);
});

test('solo se aceptan locales canónicos y la API dispone de etiqueta', () => {
  assert.equal(normalizePatientLanguage(' CA '), 'ca');
  assert.deepEqual(preferredLanguagePayload('ca'), {
    idioma_preferido: 'ca',
    idioma_preferido_label: 'Catalán',
  });
  assert.throws(() => normalizePatientLanguage('cat'), /unsupported_patient_language/);
  assert.throws(() => normalizePatientLanguage(null), /unsupported_patient_language/);
});

test('modelo, migración y endpoints mantienen el contrato extremo a extremo', () => {
  const model = fs.readFileSync(path.join(root, 'models/paciente.js'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'migrations/20260720090000-add-patient-preferred-language.js'), 'utf8');
  const patients = fs.readFileSync(path.join(root, 'src/controllers/paciente.controller.js'), 'utf8');
  const appointments = fs.readFileSync(path.join(root, 'src/controllers/citas.controller.js'), 'utf8');

  assert.match(model, /idioma_preferido:[\s\S]*DataTypes\.ENUM\('es', 'ca', 'en'\)[\s\S]*defaultValue: 'es'[\s\S]*isIn: \[\['es', 'ca', 'en'\]\]/);
  assert.match(migration, /addColumn\('Pacientes', 'idioma_preferido'/);
  assert.match(migration, /Sequelize\.ENUM\('es', 'ca', 'en'\)/);
  assert.match(migration, /allowNull: false/);
  assert.match(migration, /defaultValue: 'es'/);
  assert.match(patients, /fieldsToUpdate = \[[^\]]*'idioma_preferido'/);
  assert.match(appointments, /normalizePatientLanguage\(datosPaciente\.idioma_preferido, \{ optional: true \}\)/);
  assert.match(appointments, /idioma_preferido: 'es'/);

  assert.match(appointments, /createAppointmentWithPatientLanguage\(\{/);
  assert.match(appointments, /sequelize: db\.sequelize/);
  assert.match(appointments, /AppointmentModel: CitaPaciente/);
  assert.match(appointments, /requestedLanguage: datosPaciente\.idioma_preferido/);
});

test('la migración es idempotente y limita el dominio en base de datos', async () => {
  const added = [];
  const removed = [];
  const queryInterface = {
    async describeTable() { return {}; },
    async addColumn(table, column, definition) {
      added.push({ table, column, definition });
    },
    async removeColumn(table, column) { removed.push({ table, column }); },
  };
  const Sequelize = {
    ENUM: (...values) => ({ type: 'ENUM', values }),
  };

  await migration.up(queryInterface, Sequelize);
  assert.equal(added.length, 1);
  assert.equal(added[0].table, 'Pacientes');
  assert.equal(added[0].column, 'idioma_preferido');
  assert.deepEqual(added[0].definition.type, {
    type: 'ENUM',
    values: ['es', 'ca', 'en'],
  });
  assert.equal(added[0].definition.allowNull, false);
  assert.equal(added[0].definition.defaultValue, 'es');

  queryInterface.describeTable = async () => ({ idioma_preferido: {} });
  await migration.up(queryInterface, Sequelize);
  assert.equal(added.length, 1);
  await migration.down(queryInterface);
  assert.deepEqual(removed, [{ table: 'Pacientes', column: 'idioma_preferido' }]);
});
