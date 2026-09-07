'use strict';
const { hash } = require('./adapter');
const { instant } = require('./appointments-apply');
const sqlDate = value => value == null ? null : instant(value).replace('T', ' ').replace('Z', '');
async function createNewPatientsStore(connection, { groupId, readOnly = true }) {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error('NEW_PATIENT_GROUP_REQUIRED');
  const query = async (sql, values = []) => (await connection.query(sql, values))[0];
  const triggers = await query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE IN ('Pacientes','PatientCustomFields','PacienteClinicas')");
  if (triggers.length) throw new Error('PATIENT_IMPORT_SQL_TRIGGERS_REQUIRE_REVIEW');
  let inTransaction = false;
  async function captureGroup() {
    const clinics = await query('SELECT id_clinica FROM Clinicas WHERE grupoClinicaId = ? ORDER BY id_clinica', [groupId]);
    const ids = clinics.map(row => Number(row.id_clinica));
    if (!ids.includes(66) || !ids.includes(72)) throw new Error('NEW_PATIENT_GROUP_SCOPE_CHANGED');
    const patients = await query('SELECT p.id_paciente, p.public_id, p.clinica_id, p.nombre, p.apellidos, p.email, p.telefono_movil, p.telefono_secundario, p.dni, p.fecha_nacimiento, p.updatedAt FROM Pacientes p WHERE p.clinica_id IN (?) OR EXISTS (SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id = p.id_paciente AND pc.clinica_id IN (?)) ORDER BY p.id_paciente', [ids, ids]);
    const patientIds = patients.map(row => row.id_paciente);
    const fields = patientIds.length ? await query("SELECT paciente_id, CASE WHEN source_column IN ('contacto_1.csv','cliniccloud_contact_snapshot') THEN JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(value) THEN value ELSE '{}' END, '$.contact.idContacto')) ELSE TRIM(value) END AS source_contact_id, CASE WHEN source_column IN ('contacto_1.csv','cliniccloud_contact_snapshot') THEN JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(value) THEN value ELSE '{}' END, '$.contact.num')) ELSE NULL END AS history_number FROM PatientCustomFields WHERE source = 'cliniccloud' AND (clinica_id IN (?) OR paciente_id IN (?)) AND (source_column IN ('idContacto','contacto_1.csv','cliniccloud_contact_snapshot') OR field_key = 'cliniccloud_source_contact_id') ORDER BY paciente_id, id", [ids, patientIds]) : [];
    const appointmentLinks = patientIds.length ? await query("SELECT paciente_id, JSON_UNQUOTE(JSON_EXTRACT(import_metadata, '$.source_contact_id')) AS source_contact_id FROM CitasPacientes WHERE source_system = 'cliniccloud' AND (clinica_id IN (?) OR paciente_id IN (?)) GROUP BY paciente_id, JSON_UNQUOTE(JSON_EXTRACT(import_metadata, '$.source_contact_id'))", [ids, patientIds]) : [];
    return { group_id: groupId, clinic_ids: ids, captured_at: new Date().toISOString(), patients, source_links: [...fields, ...appointmentLinks].filter(row => row.source_contact_id && row.source_contact_id !== 'null') };
  }
  return {
    captureGroup,
    async transaction(callback) {
      if (readOnly || inTransaction) throw new Error('NEW_PATIENT_WRITE_TRANSACTION_REQUIRED');
      await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await connection.beginTransaction(); inTransaction = true;
      try { const result = await callback(this); await connection.commit(); return result; }
      catch (error) { await connection.rollback(); throw error; }
      finally { inTransaction = false; }
    },
    async insertPatient(operation, payload, marker) {
      if (readOnly || !inTransaction) throw new Error('NEW_PATIENT_WRITE_TRANSACTION_REQUIRED');
      const columns = ['public_id', 'nombre', 'apellidos', 'dni', 'telefono_movil', 'telefono_secundario', 'email', 'fecha_nacimiento', 'fecha_alta', 'clinica_id', 'idioma_preferido', 'paciente_conocido'];
      if (Object.keys(payload).sort().join('|') !== [...columns].sort().join('|')) throw new Error('NEW_PATIENT_COLUMN_ALLOWLIST_VIOLATION');
      const values = columns.map(key => ['fecha_alta', 'fecha_nacimiento'].includes(key) ? sqlDate(payload[key]) : payload[key]);
      const result = await query(`INSERT INTO Pacientes (${columns.map(key => `\`${key}\``).join(',')}, createdAt, updatedAt) VALUES (${columns.map(() => '?').join(',')}, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, values);
      const patientId = Number(result.insertId);
      if (!Number.isSafeInteger(patientId) || patientId <= 0 || result.affectedRows !== 1) throw new Error('NEW_PATIENT_INSERT_RESULT_INVALID');
      const fields = Object.fromEntries(['name', 'surname', 'email', 'phone', 'national_id', 'birth_date'].map(key => [key, operation.source_fields[key] || '']));
      const storedFieldsBaseline = { name: payload.nombre, surname: payload.apellidos, email: payload.email || '', phone: payload.telefono_movil || '', national_id: payload.dni || '', birth_date: payload.fecha_nacimiento?.slice(0, 10) || '' };
      const snapshot = { version: 'cliniccloud_contact_snapshot/1', source_account: marker.source_account,
        contact: { idContacto: operation.source_contact_id, num: String(operation.history_number), alta: operation.source_created.raw }, fields, stored_fields: storedFieldsBaseline,
        source_created: operation.source_created, provenance: operation.provenance,
        import: { ...marker, operation_sha256: operation.operation_sha256, primary_rule: operation.primary_rule, primary_evidence: operation.primary_evidence, automation_policy: 'hold', messages_enabled: false } };
      const entries = [
        { key: 'cliniccloud_source_contact_id', label: 'ID ClinicCloud', column: 'idContacto', type: 'text', value: String(operation.source_contact_id) },
        { key: 'cliniccloud_contact_snapshot', label: 'Datos de importación ClinicCloud', column: 'cliniccloud_contact_snapshot', type: 'json', value: JSON.stringify(snapshot) },
      ];
      for (const field of entries) await query('INSERT INTO PatientCustomFields (paciente_id, clinica_id, field_key, label, value, value_type, source, source_column, last_imported_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())',
        [patientId, payload.clinica_id, field.key, field.label, field.value, field.type, 'cliniccloud', field.column]);
      for (const clinicId of operation.memberships) await query('INSERT INTO PacienteClinicas (paciente_id, clinica_id, es_principal, createdAt, updatedAt) VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())', [patientId, clinicId, clinicId === payload.clinica_id]);
      const after = (await query('SELECT * FROM Pacientes WHERE id_paciente = ?', [patientId]))[0];
      if (!after) throw new Error('NEW_PATIENT_POST_WRITE_MISSING');
      for (const column of columns) {
        const expected = payload[column], actual = after[column];
        const equal = ['fecha_alta', 'fecha_nacimiento'].includes(column) ? (actual == null && expected == null) || (actual != null && expected != null && instant(actual) === instant(expected))
          : column === 'paciente_conocido' ? Number(actual) === Number(expected) : String(actual ?? '') === String(expected ?? '');
        if (!equal) throw new Error('NEW_PATIENT_POST_WRITE_FIELDS_MISMATCH');
      }
      const storedFields = await query('SELECT field_key, source, source_column, value FROM PatientCustomFields WHERE paciente_id = ? ORDER BY field_key', [patientId]);
      if (storedFields.length !== 2 || entries.some(field => !storedFields.some(row => row.field_key === field.key && row.source === 'cliniccloud' && row.source_column === field.column && row.value === field.value))) throw new Error('NEW_PATIENT_IDENTITY_WRITE_MISMATCH');
      const memberships = await query('SELECT clinica_id, es_principal FROM PacienteClinicas WHERE paciente_id = ? ORDER BY clinica_id', [patientId]);
      if (memberships.length !== operation.memberships.length || memberships.some((row, index) => Number(row.clinica_id) !== operation.memberships[index] || Number(row.es_principal) !== Number(Number(row.clinica_id) === Number(payload.clinica_id)))) throw new Error('NEW_PATIENT_MEMBERSHIP_WRITE_MISMATCH');
      for (const key of ['alergias', 'antecedentes', 'medicacion', 'foto']) if (after[key] != null && after[key] !== '') throw new Error('UNEXPECTED_NEW_PATIENT_CLINICAL_DATA');
      return { patient_id: patientId, after_sha256: hash({ patient: after, fields: storedFields, memberships }) };
    },
  };
}
module.exports = { createNewPatientsStore, sqlDate };
