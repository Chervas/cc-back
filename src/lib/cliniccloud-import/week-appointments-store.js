'use strict';

// Operator-only SQL. No models, application bootstrap, hooks or message jobs.
const { ACCOUNT, sourceReference } = require('./week-appointments');
const { instant } = require('./appointments-apply');
const { localToUtc } = require('./adapter');
const sqlDate = value => instant(value).replace('T', ' ').replace('Z', '');
async function createWeekAppointmentsStore(connection, { groupId, readOnly = true }) {
  const query = async (sql, values = []) => (await connection.query(sql, values))[0];
  const clinics = await query('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica');
  if (clinics.length !== 2 || clinics.some(c => Number(c.grupoClinicaId) !== groupId)) throw Error('WEEK_GROUP_SCOPE_CHANGED');
  const triggers = await query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN ('CitasPacientes','PacienteClinicas')");
  if (triggers.length) throw Error('WEEK_SQL_TRIGGERS_REQUIRE_REVIEW');
  // A parent row lock prevents an old/native writer, even with profile gates
  // disabled, from inserting a duplicate for this patient during our commit.
  const fks = await query("SELECT COLUMN_NAME,REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='CitasPacientes' AND REFERENCED_TABLE_NAME IS NOT NULL");
  if (!fks.some(f => f.COLUMN_NAME === 'paciente_id' && f.REFERENCED_TABLE_NAME === 'Pacientes')) throw Error('WEEK_PATIENT_FK_REQUIRED');
  let transaction = false;
  const assertWriting = () => { if (readOnly || !transaction) throw Error('WEEK_WRITE_TRANSACTION_REQUIRED'); };
  async function validate(operation, pkg) {
    const reasons = [], assignment = operation.assignment, writing = !readOnly && transaction;
    if (pkg.group_id !== groupId || pkg.source_account !== ACCOUNT) throw Error('WEEK_GROUP_SCOPE_CHANGED');
    if (writing) await query('SELECT id_clinica FROM Clinicas WHERE id_clinica = ? LOCK IN SHARE MODE', [assignment.clinic_id]);
    let installationIds = assignment.installation_id ? [assignment.installation_id] : [];
    let canonicalInstallationId = assignment.installation_id;
    if (installationIds.length) {
      const aliases = await query('SELECT installation_id,canonical_installation_id,group_id FROM InstallationPhysicalAliases WHERE installation_id = ? OR canonical_installation_id = ?', [assignment.installation_id, assignment.installation_id]);
      if (aliases.some(a => Number(a.group_id) !== groupId)) reasons.push('PHYSICAL_ALIAS_GROUP_CONFLICT');
      const canonical = Number(aliases.find(a => Number(a.installation_id) === assignment.installation_id)?.canonical_installation_id || assignment.installation_id);
      const related = await query('SELECT installation_id,group_id FROM InstallationPhysicalAliases WHERE canonical_installation_id = ?', [canonical]);
      if (related.some(a => Number(a.group_id) !== groupId)) reasons.push('PHYSICAL_ALIAS_GROUP_CONFLICT');
      installationIds = [...new Set([canonical, ...related.map(a => Number(a.installation_id))])];
      canonicalInstallationId = canonical;
    }
    if (writing) {
      const keys = [`patient:${operation.patient_id}`, ...(assignment.doctor_id ? [`doctor:${assignment.doctor_id}`] : []),
        ...(assignment.installation_id ? [`installation:${canonicalInstallationId}`] : [])].sort();
      for (const key of keys) {
        await query('INSERT INTO AppointmentBookingResources (resource_key,resource_kind,created_at,updated_at) VALUES (?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE resource_key=VALUES(resource_key)', [key, key.split(':')[0]]);
        await query('SELECT resource_key FROM AppointmentBookingResources WHERE resource_key=? FOR UPDATE', [key]);
      }
    }
    const patients = await query(`SELECT id_paciente,clinica_id FROM Pacientes WHERE id_paciente = ?${writing ? ' FOR UPDATE' : ''}`, [operation.patient_id]);
    const patient = patients[0];
    if (!patient) reasons.push('PATIENT_NO_LONGER_EXISTS');
    if (operation.source_revision) {
      const revision = operation.source_revision;
      if (writing) await query('SELECT id_cita FROM CitasPacientes WHERE paciente_id=? FOR UPDATE', [operation.patient_id]);
      const oldSlots = await query("SELECT id_cita FROM CitasPacientes WHERE (source_system='cliniccloud' AND (source_reference IN (?,?) OR JSON_UNQUOTE(JSON_EXTRACT(import_metadata,'$.source_appointment_id'))=?)) OR (paciente_id=? AND inicio < ? AND fin > ?) LIMIT 1",
        [sourceReference(revision.original), `appointment:${revision.source_appointment_id}`, revision.source_appointment_id,
          operation.patient_id, sqlDate(localToUtc(revision.original.end_local)), sqlDate(localToUtc(revision.original.start_local))]);
      if (oldSlots.length) reasons.push('REVISED_SOURCE_ALREADY_HAS_LOCAL_VISIT');
    }
    const links = await query("SELECT DISTINCT pc.paciente_id FROM PatientCustomFields pc JOIN Clinicas c ON c.id_clinica=pc.clinica_id WHERE c.grupoClinicaId = ? AND pc.source='cliniccloud' AND (((pc.source_column='idContacto' OR pc.field_key='cliniccloud_source_contact_id') AND TRIM(pc.value)=?) OR (pc.source_column IN ('contacto_1.csv','cliniccloud_contact_snapshot') AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(pc.value) THEN pc.value ELSE '{}' END,'$.contact.idContacto'))=?))", [groupId, operation.source_contact_id, operation.source_contact_id]);
    if (links.length !== 1 || Number(links[0].paciente_id) !== operation.patient_id) reasons.push('SOURCE_PATIENT_IDENTITY_CHANGED');
    const membership = await query('SELECT id FROM PacienteClinicas WHERE paciente_id=? AND clinica_id=?', [operation.patient_id, assignment.clinic_id]);
    if (!patient || (Number(patient.clinica_id) !== assignment.clinic_id && !membership.length)) reasons.push('PATIENT_CLINIC_MEMBERSHIP_REQUIRED');
    if (assignment.doctor_id) {
      const eligible = await query('SELECT doctor_id FROM DoctorClinicas WHERE doctor_id=? AND clinica_id=? AND activo=1 AND recibe_citas=1', [assignment.doctor_id, assignment.clinic_id]);
      if (eligible.length !== 1) reasons.push('DOCTOR_NOT_OPERATIONAL_IN_CLINIC');
      if (writing) await query('SELECT id_usuario FROM Usuarios WHERE id_usuario=? FOR UPDATE', [assignment.doctor_id]);
    }
    if (assignment.installation_id) {
      const eligible = await query('SELECT id FROM Instalaciones WHERE id=? AND clinica_id=? AND activo=1', [assignment.installation_id, assignment.clinic_id]);
      if (eligible.length !== 1) reasons.push('INSTALLATION_NOT_OPERATIONAL_IN_CLINIC');
    }
    if (assignment.treatment_id) {
      const eligible = await query("SELECT id_tratamiento,clinical_config FROM Tratamientos WHERE id_tratamiento=? AND ((origen='clinica' AND clinica_id=?) OR (origen='grupo' AND grupo_clinica_id=?) OR origen='sistema')", [assignment.treatment_id, assignment.clinic_id, groupId]);
      if (eligible.length !== 1) reasons.push('TREATMENT_NOT_IN_CLINIC_SCOPE');
      else {
        const config = typeof eligible[0].clinical_config === 'string' ? JSON.parse(eligible[0].clinical_config) : eligible[0].clinical_config;
        if (config?.booking_profile) reasons.push('CONFIGURED_TREATMENT_NEEDS_CANONICAL_BOOKING');
      }
    }
    const overlaps = await query("SELECT id_cita FROM CitasPacientes WHERE paciente_id=? AND inicio < ? AND fin > ? AND (estado <> 'cancelada' OR (inicio=? AND fin=?)) LIMIT 1", [operation.patient_id, sqlDate(operation.end_utc), sqlDate(operation.start_utc), sqlDate(operation.start_utc), sqlDate(operation.end_utc)]);
    if (overlaps.length) reasons.push('CURRENT_PATIENT_SLOT_REQUIRES_RECONCILIATION');
    if (operation.status !== 'cancelada') {
      if (assignment.doctor_id) {
        const busy = await query("SELECT id_cita FROM CitasPacientes WHERE doctor_id=? AND estado <> 'cancelada' AND inicio < ? AND fin > ? LIMIT 1", [assignment.doctor_id, sqlDate(operation.end_utc), sqlDate(operation.start_utc)]);
        if (busy.length) reasons.push('CURRENT_DOCTOR_OVERLAP_REQUIRES_REVIEW');
      }
      if (installationIds.length) {
        const busy = await query("SELECT id_cita FROM CitasPacientes WHERE instalacion_id IN (?) AND estado <> 'cancelada' AND inicio < ? AND fin > ? LIMIT 1", [installationIds, sqlDate(operation.end_utc), sqlDate(operation.start_utc)]);
        if (busy.length) reasons.push('CURRENT_CABIN_OVERLAP_REQUIRES_REVIEW');
      }
      const resourceKeys = [...(assignment.doctor_id ? [`doctor:${assignment.doctor_id}`] : []), ...installationIds.map(id => `installation:${id}`)];
      if (resourceKeys.length) {
        const busy = await query("SELECT o.id FROM AppointmentBookingOccupancies o JOIN CitasPacientes c ON c.id_cita=o.appointment_id WHERE o.resource_key IN (?) AND c.estado <> 'cancelada' AND o.start_at < ? AND o.end_at > ? LIMIT 1", [resourceKeys, sqlDate(operation.end_utc), sqlDate(operation.start_utc)]);
        if (busy.length) reasons.push('CURRENT_PHASE_OVERLAP_REQUIRES_REVIEW');
      }
    }
    return { reasons: [...new Set(reasons)] };
  }
  return {
    validate,
    async findSource(reference) {
      const rows = await query('SELECT id_cita,paciente_id,import_metadata FROM CitasPacientes WHERE source_system=? AND source_reference=?', ['cliniccloud', reference]);
      if (rows.length > 1) throw Error('WEEK_SOURCE_REFERENCE_DUPLICATED');
      return rows[0] || null;
    },
    async transaction(callback) {
      if (readOnly || transaction) throw Error('WEEK_WRITE_TRANSACTION_REQUIRED');
      await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await connection.beginTransaction(); transaction = true;
      try { const result = await callback(this); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
      finally { transaction = false; }
    },
    async insert(payload) {
      assertWriting();
      const allowed = ['clinica_id','paciente_id','doctor_id','instalacion_id','tratamiento_id','titulo','nota','motivo','tipo_cita','estado','inicio','fin','source_system','source_reference','es_provisional','created_at','updated_at','import_metadata'];
      if (Object.keys(payload).length !== allowed.length || Object.keys(payload).some(k => !allowed.includes(k))) throw Error('WEEK_INSERT_COLUMNS_INVALID');
      const values = allowed.map(key => key === 'import_metadata' ? JSON.stringify(payload[key]) : ['inicio','fin','created_at','updated_at'].includes(key) ? sqlDate(payload[key]) : payload[key]);
      const result = await query(`INSERT INTO CitasPacientes (${allowed.map(k => '`' + k + '`').join(',')}) VALUES (${allowed.map(() => '?').join(',')})`, values);
      return Number(result.insertId);
    },
    async read(id) { return (await query('SELECT * FROM CitasPacientes WHERE id_cita=? AND clinica_id IN (66,72)', [id]))[0] || null; },
  };
}
module.exports = { createWeekAppointmentsStore };
