#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { readBytes, parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { buildCatalogPlan } = require('../lib/cliniccloud-import/catalog');

async function readLocalCatalog() {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  const connection = await require('mysql2/promise').createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, dateStrings: true, multipleStatements: false, ...require('../lib/databaseTlsConfig').buildDatabaseTlsOptions(process.env) });
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [clinics] = await connection.query('SELECT id_clinica, grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72)');
    if (clinics.length !== 2 || !clinics[0].grupoClinicaId || clinics[0].grupoClinicaId !== clinics[1].grupoClinicaId) throw new Error('CATALOG_CLINIC_GROUP_MISMATCH');
    const [installations] = await connection.query('SELECT id, clinica_id AS clinic_id, nombre AS name, tipo AS type, activo AS active, capacidad AS capacity FROM Instalaciones WHERE clinica_id IN (66,72) ORDER BY clinica_id,id');
    const [professionals] = await connection.query("SELECT u.id_usuario AS id, dc.clinica_id AS clinic_id, u.nombre AS name, u.apellidos AS surname, dc.activo AS active, dc.recibe_citas AS receives_appointments, uc.subrol_clinica AS subrole FROM DoctorClinicas dc JOIN Usuarios u ON u.id_usuario = dc.doctor_id LEFT JOIN UsuarioClinica uc ON uc.id_usuario = dc.doctor_id AND uc.id_clinica = dc.clinica_id WHERE dc.clinica_id IN (66,72) ORDER BY dc.clinica_id,u.id_usuario");
    const [treatments] = await connection.query('SELECT id_tratamiento AS id, clinica_id AS clinic_id, codigo AS code, nombre AS name, activo AS active, clinical_config FROM Tratamientos WHERE clinica_id IN (66,72) ORDER BY clinica_id,id_tratamiento');
    await connection.rollback();
    return { group_id: clinics[0].grupoClinicaId, installations, professionals, treatments };
  } finally { await connection.end(); }
}
async function run(args) {
  const options = parseArgs(args, ['--workbook', '--private-output', '--resource-map', '--read-local-catalog']);
  if (!options['--workbook'] || !options['--private-output']) throw new Error('WORKBOOK_AND_PRIVATE_OUTPUT_REQUIRED');
  const bytes = readBytes(options['--workbook']);
  const parsed = spawnSync('python3', ['-B', path.resolve(__dirname, '../lib/cliniccloud-import/xlsx_catalog.py'), options['--workbook']], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  if (parsed.status !== 0) throw new Error('CATALOG_WORKBOOK_READ_FAILED');
  if (options['--read-local-catalog'] && options['--read-local-catalog'] !== 'true') throw new Error('READ_LOCAL_CATALOG_MUST_BE_TRUE');
  const local = options['--read-local-catalog'] === 'true' ? await readLocalCatalog() : { installations: [], professionals: [], treatments: [] };
  const resourceMap = options['--resource-map'] ? JSON.parse(readBytes(options['--resource-map']).toString('utf8')) : {};
  const plan = buildCatalogPlan({ sheets: JSON.parse(parsed.stdout), workbookHash: hash(bytes), local, resourceMap });
  writePrivateJson(options['--private-output'], plan);
  return { plan_sha256: plan.plan_sha256, workbook_sha256: plan.workbook_sha256, summary: plan.summary, database_written: false, price_base_written: false };
}
if (require.main === module) run(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${/^[A-Z][A-Z0-9_:]+$/.test(error.message) ? error.message : 'CLINICCLOUD_CATALOG_PLAN_FAILED'}\n`); process.exitCode = 1; });
module.exports = { run };
