'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataTypes, Op, literal } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { buildPatientNameSearch } = require('../../lib/patient-name-search');

test('real MySQL matches legacy name fields, accents, separators and initials within clinic membership', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 120000,
}, async () => withIsolatedCampaignMysql(async ({ sql, report }) => {
  const Paciente = sql.define('Paciente', {
    id_paciente: { type: DataTypes.INTEGER, primaryKey: true },
    nombre: DataTypes.STRING,
    apellidos: DataTypes.STRING,
    clinica_id: DataTypes.INTEGER,
  }, { tableName: 'Pacientes', timestamps: false, charset: 'utf8mb4', collate: 'utf8mb4_0900_ai_ci' });
  const PacienteClinica = sql.define('PacienteClinica', { paciente_id: DataTypes.INTEGER, clinica_id: DataTypes.INTEGER }, {
    tableName: 'PacienteClinicas', timestamps: false,
  });
  Paciente.hasMany(PacienteClinica, { foreignKey: 'paciente_id', as: 'clinicasVinculadas' });
  await Paciente.sync();
  await PacienteClinica.sync();
  await Paciente.bulkCreate([
    { id_paciente: 1, nombre: 'Ada', apellidos: 'Araya  del—RÍO', clinica_id: 10 },
    { id_paciente: 2, nombre: 'Marta', apellidos: '  Su\u0301arez\u00a0Castro', clinica_id: 20 },
    { id_paciente: 3, nombre: 'Marta', apellidos: 'Escudero', clinica_id: 10 },
    { id_paciente: 4, nombre: 'Marta-Suárez', apellidos: '', clinica_id: 10 },
    { id_paciente: 5, nombre: 'Marta', apellidos: 'Suárez', clinica_id: 30 },
    { id_paciente: 6, nombre: 'Ío', apellidos: 'Sanchez', clinica_id: 10 },
    { id_paciente: 7, nombre: 'Marta', apellidos: 'Suárez', clinica_id: 20 },
  ]);
  await PacienteClinica.create({ paciente_id: 2, clinica_id: 10 });

  const find = async (query, clinicIds, allowSubstring = false) => {
    const name = buildPatientNameSearch(query, sql, { allowSubstring });
    if (!name) return [];
    const rows = await Paciente.findAll({
      where: { [Op.and]: [name.where, { [Op.or]: [
        { clinica_id: { [Op.in]: clinicIds } },
        literal(`EXISTS (SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id = Paciente.id_paciente AND pc.clinica_id IN (${clinicIds.join(',')}))`),
      ] }] },
      order: [[name.rank, 'ASC'], ['id_paciente', 'ASC']],
      include: [{ model: PacienteClinica, as: 'clinicasVinculadas' }],
      limit: 10,
    });
    return rows.map(row => row.id_paciente);
  };

  assert.deepEqual(await find('  rio  ADA ', [10]), [1]);
  assert.deepEqual(await find('ÁDA  Río', [10, 20]), [1]);
  assert.deepEqual(await find('Marta S.', [10]), [2, 4]);
  assert.deepEqual(await find('MARTA   - S', [10, 20]), [2, 4, 7]);
  assert.deepEqual(await find('Marta Suarez', [10, 20]), [4, 7, 2]);
  assert.deepEqual(await find('   S  ', [10, 20]), []);
  assert.deepEqual(await find('%_!!', [10, 20]), []);
  assert.deepEqual(await find('nchez', [10], true), [6]);
  assert.deepEqual(await find('nchez', [10]), []);
  assert.deepEqual(await find('suarez castro', [10]), [2]);
  assert.deepEqual(await find('marta es', [10]), [3]);
  assert.deepEqual(await find('suarez-marta', [30]), [5]);
  report.checks.push('12 production predicates on isolated native MySQL with Sequelize includes/limit.');
}));
