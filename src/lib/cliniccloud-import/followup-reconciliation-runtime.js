'use strict';

const { CLINICS } = require('./primary-followups-apply');
const { normalizedRecord } = require('./followup-reconciliation');
const { connectOperatorDatabase } = require('./operator-database');
const fail = code => { throw new Error(code); };
const unique = values => [...new Set(values.map(String))];
const placeholders = values => values.map(() => '?').join(',');
const sourceId = `CASE WHEN source_column IN ('contacto_1.csv','cliniccloud_contact_snapshot') AND JSON_VALID(value)
  THEN JSON_UNQUOTE(JSON_EXTRACT(value,'$.contact.idContacto'))
  WHEN source_column='idContacto' OR field_key='cliniccloud_source_contact_id' THEN value ELSE NULL END`;
const history = `CASE WHEN source_column IN ('contacto_1.csv','cliniccloud_contact_snapshot') AND JSON_VALID(value)
  THEN JSON_UNQUOTE(JSON_EXTRACT(value,'$.contact.num')) ELSE NULL END`;

async function readDatabaseIdentity({ query, config }) {
  const [row] = await query('SELECT DATABASE() database_name,@@server_uuid server_uuid,@@hostname server_hostname', []);
  if (!config?.host || !config.database || !row || row.database_name !== config.database) fail('FOLLOWUP_DATABASE_CONFIGURATION_CHANGED');
  return { host: String(config.host), port: Number(config.port || 3306), database: row.database_name,
    server_uuid: row.server_uuid, server_hostname: row.server_hostname };
}

async function readIdentity({ query, patientIds, sourceIds, lock = false }) {
  patientIds = unique(patientIds); sourceIds = unique(sourceIds);
  if (!patientIds.length || !sourceIds.length || patientIds.length > 2000 || sourceIds.length > 2000
    || [...patientIds, ...sourceIds].some(id => !/^[1-9]\d*$/.test(id))) fail('FOLLOWUP_IDENTITY_READ_SCOPE_INVALID');
  const patients = await query(`SELECT id_paciente,clinica_id,numero_historia FROM Pacientes WHERE id_paciente IN (${placeholders(patientIds)})`, patientIds);
  const suffix = lock ? ' FOR SHARE' : '';
  const memberships = await query(`SELECT paciente_id,clinica_id FROM PacienteClinicas WHERE paciente_id IN (${placeholders(patientIds)}) AND clinica_id IN (66,72) ORDER BY paciente_id,clinica_id${suffix}`, patientIds);
  // Include every source identity on selected patients AND the entire scoped
  // reverse index for the chosen source IDs, so aliases/duplicate owners fail.
  const identities = await query(`SELECT paciente_id,source_column,${sourceId} source_contact_id,${history} history_number,
    CASE WHEN source_column='cliniccloud_contact_snapshot' THEN CASE WHEN JSON_VALID(value) THEN
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(value,'$.version'))='cliniccloud_contact_snapshot/1'
      AND JSON_UNQUOTE(JSON_EXTRACT(value,'$.source_account'))='cliniccloud-5880',0) ELSE 0 END ELSE 1 END source_snapshot_valid FROM PatientCustomFields
    WHERE clinica_id IN (66,72) AND source='cliniccloud'
      AND (source_column IN ('idContacto','contacto_1.csv','cliniccloud_contact_snapshot') OR field_key='cliniccloud_source_contact_id')
      AND (paciente_id IN (${placeholders(patientIds)}) OR ${sourceId} IN (${placeholders(sourceIds)})) ORDER BY id${suffix}`, [...patientIds, ...sourceIds]);
  return { patients, memberships, identities };
}

async function captureLive({ target, records }) {
  const normalized = records.map(normalizedRecord), patientIds = unique(normalized.map(r => r.patient_id));
  if (!normalized.length) fail('FOLLOWUP_RECONCILIATION_RECORDS_REQUIRED');
  const c = await connectOperatorDatabase(target);
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const query = async (sql, values) => (await c.query(sql, values))[0];
    const database_identity = await readDatabaseIdentity({ query, config: c.connection.config });
    const identity = await readIdentity({ query, patientIds, sourceIds: normalized.map(r => r.source_contact_id) });
    const followups = await query(`SELECT * FROM PatientFollowUps WHERE clinic_id IN (66,72) AND patient_id IN (${placeholders(patientIds)}) ORDER BY id`, patientIds);
    await c.rollback();
    return { target, database_identity, captured_at: new Date().toISOString(), clinics: CLINICS, ...identity, followups };
  } finally { await c.end(); }
}

function transactionalIdentityReader(db) {
  return async ({ patientId, sourceIds, transaction }) => readIdentity({ patientIds: [patientId], sourceIds, lock: true,
    query: async (sql, values) => db.sequelize.query(sql, { replacements: values, transaction, type: db.Sequelize.QueryTypes.SELECT }) });
}

function databaseIdentityReader(db) {
  return async ({ transaction = null } = {}) => readDatabaseIdentity({ config: db.sequelize.config,
    query: (sql, values) => db.sequelize.query(sql, { replacements: values, transaction, type: db.Sequelize.QueryTypes.SELECT }) });
}

module.exports = { readDatabaseIdentity, readIdentity, captureLive, transactionalIdentityReader, databaseIdentityReader };
