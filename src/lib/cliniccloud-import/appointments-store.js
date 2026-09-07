'use strict';

// Direct SQL adapter: no app/models, ORM hooks, Redis, workers or job services.
const { hash } = require('./adapter');
const { instant } = require('./appointments-apply');
const sqlDate = value => instant(value).replace('T', ' ').replace('Z', '');

async function createAppointmentStore(connection, clinicIds, { readOnly = true } = {}) {
  if (!Array.isArray(clinicIds) || !clinicIds.length || clinicIds.length > 20 || clinicIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('INVALID_CLINIC_SCOPE');
  const query = async (sql, values = []) => (await connection.query(sql, values))[0];
  const clinics = await query('SELECT id_clinica, grupoClinicaId FROM Clinicas WHERE id_clinica IN (?) ORDER BY id_clinica', [clinicIds]);
  if (clinics.length !== new Set(clinicIds).size || !clinics[0]?.grupoClinicaId || new Set(clinics.map(row => row.grupoClinicaId)).size !== 1) throw new Error('CLINICS_MUST_BELONG_TO_ONE_GROUP');
  const triggers = await query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'CitasPacientes'");
  if (triggers.length) throw new Error('APPOINTMENT_SQL_TRIGGERS_REQUIRE_REVIEW');
  const schemaHash = hash('metadata-only-scoped-guards-v2');
  let inTransaction = false;
  let preparedIdentities = null;
  async function read(id, lock = false) {
    if (lock && (readOnly || !inTransaction)) throw new Error('ROW_LOCK_REQUIRES_WRITE_TRANSACTION');
    const rows = await query(`SELECT * FROM CitasPacientes WHERE id_cita = ? AND clinica_id IN (?)${lock ? ' FOR UPDATE' : ''}`, [id, clinicIds]);
    return rows[0] || null;
  }
  async function inspect(id, sourceContactId, lock = false) {
    const row = await read(id, lock);
    if (!row) return { row: null, context: {} };
    const patient = (await query('SELECT id_paciente, clinica_id FROM Pacientes WHERE id_paciente = ?', [row.paciente_id]))[0];
    const membership = patient && Number(patient.clinica_id) !== Number(row.clinica_id)
      ? await query('SELECT id FROM PacienteClinicas WHERE paciente_id = ? AND clinica_id = ?', [row.paciente_id, row.clinica_id]) : [];
    const identities = readOnly && preparedIdentities ? [...(preparedIdentities.get(String(sourceContactId)) || [])].map(paciente_id => ({ paciente_id }))
      : await query("SELECT DISTINCT paciente_id FROM PatientCustomFields WHERE clinica_id IN (?) AND source = 'cliniccloud' AND (((source_column = 'idContacto' OR field_key = 'cliniccloud_source_contact_id') AND TRIM(value) = ?) OR (source_column = 'contacto_1.csv' AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(value) THEN value ELSE '{}' END, '$.contact.idContacto')) = ?)) ORDER BY paciente_id", [clinicIds, String(sourceContactId), String(sourceContactId)]);
    const doctor = await query('SELECT u.id_usuario FROM Usuarios u WHERE u.id_usuario = ? AND EXISTS (SELECT 1 FROM UsuarioClinica uc WHERE uc.id_usuario = u.id_usuario AND uc.id_clinica = ?)', [row.doctor_id, row.clinica_id]);
    const installation = await query('SELECT id FROM Instalaciones WHERE id = ? AND clinica_id = ?', [row.instalacion_id, row.clinica_id]);
    const treatment = await query("SELECT id_tratamiento FROM Tratamientos WHERE id_tratamiento = ? AND ((origen = 'clinica' AND clinica_id = ?) OR (origen = 'grupo' AND grupo_clinica_id = ?) OR origen = 'sistema')", [row.tratamiento_id, row.clinica_id, clinics[0].grupoClinicaId]);
    const overlaps = await query('SELECT id_cita FROM CitasPacientes WHERE paciente_id = ? AND id_cita <> ? AND inicio < ? AND fin > ? AND estado NOT IN (\'cancelada\',\'no_asistio\')', [row.paciente_id, id, row.fin, row.inicio]);
    const jobs = await query("SELECT id FROM JobRequests WHERE status IN ('pending','queued','running','waiting') AND (JSON_UNQUOTE(JSON_EXTRACT(payload, '$.appointment_id')) = ? OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.cita_id')) = ? OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$.citaId')) = ?)", [String(id), String(id), String(id)]);
    // These are the only dependencies consulted: no clinical/economic COUNT
    // scans, since metadata-only HOLD never changes their state or relations.
    const flows = await query('SELECT id FROM AppointmentFlowInstances WHERE cita_id = ? LIMIT 1', [id]);
    const conversations = await query('SELECT id FROM ConversationAutomationStates WHERE clinic_id = ? AND appointment_id = ? LIMIT 1', [row.clinica_id, id]);
    return { row, context: { schema_sha256: schemaHash, clinic_scope: clinicIds.includes(Number(row.clinica_id)),
      patient_scope: Boolean(patient && (Number(patient.clinica_id) === Number(row.clinica_id) || membership.length)),
      patient_primary_clinic_id: patient?.clinica_id || null, identity_unique: identities.length === 1 && Number(identities[0].paciente_id) === Number(row.paciente_id),
      doctor_scope: doctor.length === 1, installation_scope: installation.length === 1, treatment_scope: treatment.length === 1,
      overlap_count: overlaps.length, active_job_count: jobs.length,
      automation_count: flows.length + conversations.length } };
  }
  return {
    inspect, read,
    async prepareIdentities(sourceIds) {
      if (!readOnly || inTransaction) throw new Error('IDENTITY_CACHE_READ_ONLY_PREPARATION_REQUIRED');
      preparedIdentities = new Map();
      if (!sourceIds.length) return;
      const rows = await query("SELECT DISTINCT paciente_id, CASE WHEN source_column = 'contacto_1.csv' THEN JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(value) THEN value ELSE '{}' END, '$.contact.idContacto')) ELSE TRIM(value) END AS source_contact_id FROM PatientCustomFields WHERE clinica_id IN (?) AND source = 'cliniccloud' AND (((source_column = 'idContacto' OR field_key = 'cliniccloud_source_contact_id') AND TRIM(value) IN (?)) OR (source_column = 'contacto_1.csv' AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(value) THEN value ELSE '{}' END, '$.contact.idContacto')) IN (?)))", [clinicIds, sourceIds.map(String), sourceIds.map(String)]);
      for (const row of rows) {
        if (!preparedIdentities.has(String(row.source_contact_id))) preparedIdentities.set(String(row.source_contact_id), new Set());
        preparedIdentities.get(String(row.source_contact_id)).add(Number(row.paciente_id));
      }
    },
    async transaction(callback) {
      if (readOnly || inTransaction) throw new Error('WRITE_TRANSACTION_NOT_ENABLED');
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.beginTransaction(); inTransaction = true;
      try { const result = await callback(this); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
      finally { inTransaction = false; }
    },
    async update(id, patch, previous) {
      if (readOnly || !inTransaction) throw new Error('WRITE_TRANSACTION_NOT_ENABLED');
      if (Object.keys(patch).sort().join(',') !== 'import_metadata,updated_at') throw new Error('WRITE_COLUMNS_NOT_ALLOWED');
      const result = await query('UPDATE CitasPacientes SET import_metadata = ?, updated_at = ? WHERE id_cita = ? AND clinica_id = ? AND source_system = ? AND source_reference = ? AND estado = ? AND inicio = ? AND fin = ? AND updated_at = ?',
        [JSON.stringify(patch.import_metadata), sqlDate(patch.updated_at), id, previous.clinica_id, 'cliniccloud', previous.source_reference, previous.estado, sqlDate(previous.inicio), sqlDate(previous.fin), sqlDate(previous.updated_at)]);
      if (result.affectedRows !== 1) throw new Error('APPOINTMENT_COMPARE_AND_SWAP_FAILED');
    },
  };
}
module.exports = { createAppointmentStore, sqlDate };
