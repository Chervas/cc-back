'use strict';

// Operator-only, selected empty duplicate repair. No model registry, workers,
// providers, event dispatcher or automatic replay is imported by this module.
const { createHash } = require('node:crypto');
const { normalizePhoneDigits } = require('./phone');
const { lockPatientHistoryCounter } = require('../services/patientHistoryNumber.service');
const VERSION = 'empty-patient-identity-reconciliation/1';
const EVENT = 'patient.identity_reconciled';
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const expect = (condition, code) => { if (!condition) fail(code); };
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  && !(value instanceof Date) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const identifier = value => { expect(/^[A-Za-z0-9_]+$/.test(value), 'repair_metadata_identifier_invalid'); return '`' + value + '`'; };
const rows = async (connection, sql, parameters = []) => (await connection.execute(sql, parameters))[0];
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const sqlUtcTimestamp = value => value instanceof Date ? value.getTime() : Date.parse(typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value);
function recipeValid(recipe) {
  for (const key of ['clinicId', 'canonicalPatientId', 'duplicatePatientId', 'appointmentId', 'leadId', 'conversationId',
    'failedExecutionId', 'scheduledJobId', 'executionJobId']) expect(positive(recipe?.[key]), 'repair_recipe_invalid');
  expect(recipe.canonicalPatientId !== recipe.duplicatePatientId
    && /^\d+$/.test(String(recipe.canonicalHistoryNumber)) && /^\d+$/.test(String(recipe.duplicateHistoryNumber)), 'repair_recipe_invalid');
}
async function dependencyInventory(connection, recipe) {
  const columns = await rows(connection, `SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME<>'Pacientes' AND COLUMN_NAME IN ('patient_id','paciente_id','id_paciente','id_paciente_relacionado')
    UNION SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='Pacientes' ORDER BY TABLE_NAME,COLUMN_NAME`);
  const result = [];
  for (const column of columns) {
    const table = identifier(column.TABLE_NAME), field = identifier(column.COLUMN_NAME);
    const [count] = await rows(connection, `SELECT SUM(${field}=?) AS canonical_count,SUM(${field}=?) AS duplicate_count
      FROM ${table} WHERE ${field} IN (?,?)`, [recipe.canonicalPatientId, recipe.duplicatePatientId,
      recipe.canonicalPatientId, recipe.duplicatePatientId]);
    result.push({ table: column.TABLE_NAME, column: column.COLUMN_NAME,
      canonical_count: Number(count.canonical_count || 0), duplicate_count: Number(count.duplicate_count || 0) });
  }
  return result;
}
async function snapshot(connection, recipe) {
  const { canonicalPatientId: canonical, duplicatePatientId: duplicate, appointmentId, clinicId, leadId, conversationId } = recipe;
  const patients = await rows(connection, 'SELECT * FROM Pacientes WHERE id_paciente IN (?,?) ORDER BY id_paciente', [canonical, duplicate]);
  const appointments = await rows(connection, 'SELECT * FROM CitasPacientes WHERE paciente_id IN (?,?) ORDER BY id_cita', [canonical, duplicate]);
  const [appointment] = await rows(connection, 'SELECT * FROM CitasPacientes WHERE id_cita=?', [appointmentId]);
  const [lead] = await rows(connection, 'SELECT * FROM LeadIntakes WHERE id=?', [leadId]);
  const [conversation] = await rows(connection, 'SELECT * FROM Conversations WHERE id=?', [conversationId]);
  const memberships = await rows(connection, 'SELECT * FROM PacienteClinicas WHERE paciente_id IN (?,?) ORDER BY paciente_id,clinica_id,id', [canonical, duplicate]);
  const clinics = await rows(connection, 'SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica=?', [clinicId]);
  const scope = Number(clinics[0]?.grupoClinicaId) > 0 ? 'group:' + Number(clinics[0].grupoClinicaId) : 'clinic:' + Number(clinicId);
  const [counter] = await rows(connection, 'SELECT scope_key,next_number FROM PatientHistoryCounters WHERE scope_key=?', [scope]);
  const executions = await rows(connection, 'SELECT * FROM FlowExecutionsV2 WHERE trigger_entity_type=? AND trigger_entity_id=? ORDER BY id', ['appointment', appointmentId]);
  const logs = await rows(connection, 'SELECT * FROM FlowExecutionLogsV2 WHERE flow_execution_id=? ORDER BY id', [recipe.failedExecutionId]);
  const jobs = await rows(connection, `SELECT * FROM JobRequests WHERE id IN (?,?)
    OR (created_at>=? AND (CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.appointment_id')) AS UNSIGNED)=?
      OR CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.execution_id')) AS UNSIGNED)=?)) ORDER BY id`,
  [recipe.executionJobId, recipe.scheduledJobId, appointment?.created_at || '1970-01-01', appointmentId, recipe.failedExecutionId]);
  const occupancies = await rows(connection, 'SELECT * FROM AppointmentBookingOccupancies WHERE appointment_id=? ORDER BY id', [appointmentId]);
  return { patients, appointments, appointment, lead, conversation, memberships, clinics, counter, executions, logs, jobs, occupancies,
    dependencies: await dependencyInventory(connection, recipe) };
}
function validateBefore(state, recipe) {
  const canonical = state.patients.find(p => Number(p.id_paciente) === recipe.canonicalPatientId);
  const duplicate = state.patients.find(p => Number(p.id_paciente) === recipe.duplicatePatientId);
  expect(canonical && duplicate && state.patients.length === 2, 'repair_patient_missing');
  expect([canonical, duplicate].every(p => Number(p.clinica_id) === recipe.clinicId && !p.fecha_baja), 'repair_clinic_or_retirement_changed');
  expect(String(canonical.numero_historia) === String(recipe.canonicalHistoryNumber)
    && String(duplicate.numero_historia) === String(recipe.duplicateHistoryNumber)
    && canonical.historia_scope === duplicate.historia_scope, 'repair_history_changed');
  const generated = new Set(['id_paciente', 'public_id', 'nombre', 'apellidos', 'telefono_movil', 'numero_historia',
    'historia_scope', 'clinica_id', 'fecha_alta', 'createdAt', 'updatedAt', 'idioma_preferido', 'paciente_conocido']);
  expect(Object.entries(duplicate).every(([key, value]) => generated.has(key)
    || value == null || typeof value === 'string' && value.trim() === ''), 'repair_duplicate_has_profile_data');
  expect(!duplicate.paciente_conocido && duplicate.idioma_preferido === canonical.idioma_preferido, 'repair_duplicate_has_profile_data');
  expect(normalizePhoneDigits(canonical.telefono_movil)
    && normalizePhoneDigits(canonical.telefono_movil) === normalizePhoneDigits(duplicate.telefono_movil), 'repair_contact_changed');
  const name = patient => (patient.nombre + ' ' + (patient.apellidos || '')).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
  expect(name(canonical) === name(duplicate), 'repair_name_changed');
  const appointment = state.appointment;
  expect(appointment && Number(appointment.clinica_id) === recipe.clinicId && Number(appointment.paciente_id) === recipe.duplicatePatientId
    && Number(appointment.lead_intake_id) === recipe.leadId && appointment.estado === 'pendiente'
    && !appointment.arrived_at && !appointment.care_started_at && !appointment.care_completed_at,
  'repair_appointment_changed');
  expect(state.appointments.filter(a => Number(a.paciente_id) === recipe.duplicatePatientId).length === 1, 'repair_duplicate_has_other_appointments');
  expect(!state.appointments.some(row => Number(row.paciente_id) === recipe.canonicalPatientId
    && !['cancelada', 'no_asistio'].includes(row.estado)
    && sqlUtcTimestamp(row.inicio) < sqlUtcTimestamp(appointment.fin)
    && sqlUtcTimestamp(row.fin) > sqlUtcTimestamp(appointment.inicio)), 'repair_canonical_patient_overlap');
  expect(Number(state.lead?.clinica_id) === recipe.clinicId && Number(state.lead?.call_outcome_appointment_id) === recipe.appointmentId
    && Number(state.conversation?.clinic_id) === recipe.clinicId && Number(state.conversation?.lead_id) === recipe.leadId
    && Number(state.conversation?.patient_id) === recipe.canonicalPatientId, 'repair_lead_or_conversation_changed');
  expect(state.memberships.filter(p => Number(p.paciente_id) === recipe.duplicatePatientId).length === 1
    && state.memberships.some(p => Number(p.paciente_id) === recipe.duplicatePatientId && Number(p.clinica_id) === recipe.clinicId), 'repair_membership_changed');
  for (const dependency of state.dependencies) {
    const allowed = dependency.table === 'CitasPacientes' && dependency.column === 'paciente_id'
      || dependency.table === 'PacienteClinicas' && dependency.column === 'paciente_id';
    expect(dependency.duplicate_count === (allowed ? 1 : 0), 'repair_duplicate_has_dependencies');
  }
  expect(state.counter && BigInt(state.counter.next_number) > BigInt(recipe.duplicateHistoryNumber), 'repair_history_counter_invalid');
  expect(state.executions.length === 1 && Number(state.executions[0].id) === recipe.failedExecutionId
    && state.executions[0].status === 'failed', 'repair_execution_changed');
  const scheduled = state.jobs.find(job => Number(job.id) === recipe.scheduledJobId);
  const executionJob = state.jobs.find(job => Number(job.id) === recipe.executionJobId);
  expect(state.jobs.length === 2 && scheduled?.type === 'appointment_automation_schedule_fire' && scheduled.status === 'waiting'
    && Number(json(scheduled.payload)?.appointment_id) === recipe.appointmentId && !Number(scheduled.attempts)
    && sqlUtcTimestamp(scheduled.next_run_at) > Date.now() && executionJob?.status === 'completed'
    && Number(json(executionJob.payload)?.execution_id) === recipe.failedExecutionId, 'repair_jobs_changed');
  expect(state.occupancies.every(row => ['doctor', 'installation', 'equipment'].includes(row.resource_kind)), 'repair_patient_occupancy_requires_writer');
}
async function inspectEmptyPatientReconciliation(connection, recipe) {
  recipeValid(recipe);
  const state = await snapshot(connection, recipe);
  validateBefore(state, recipe);
  const plan = { version: VERSION, recipe, snapshot: state };
  return { ...plan, sha256: digest(plan) };
}
async function applyEmptyPatientReconciliation(connection, plan, { actorUserId, authorizationRef, backupRef }) {
  recipeValid(plan?.recipe);
  const { sha256, ...unsigned } = plan;
  expect(plan.version === VERSION && /^[a-f0-9]{64}$/.test(sha256) && digest(unsigned) === sha256, 'repair_plan_hash_invalid');
  expect(positive(actorUserId) && typeof authorizationRef === 'string' && authorizationRef.trim()
    && backupRef?.sha256 && backupRef?.path, 'repair_operator_evidence_required');
  const recipe = plan.recipe;
  await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await connection.beginTransaction();
  try {
    const tx = { operator: 'empty-patient-identity-reconciliation' };
    const adapter = { query: async (sql, options) => {
      expect(options.transaction === tx, 'repair_transaction_required');
      const values = [];
      const bound = sql.replace(/:([a-zA-Z_][a-zA-Z_0-9]*)/g, (_, key) => { values.push(options.replacements[key]); return '?'; });
      return connection.execute(bound, values);
    } };
    await lockPatientHistoryCounter(adapter, recipe.clinicId, tx); // Mutex only; never allocates/increments an NHC.
    const [appointment] = await rows(connection, 'SELECT * FROM CitasPacientes WHERE id_cita=? FOR UPDATE', [recipe.appointmentId]);
    expect(appointment, 'repair_appointment_missing');
    const occupancies = await rows(connection, 'SELECT resource_key FROM AppointmentBookingOccupancies WHERE appointment_id=?', [recipe.appointmentId]);
    const keys = [...new Set([...occupancies.map(row => row.resource_key), 'patient:' + recipe.canonicalPatientId,
      'patient:' + recipe.duplicatePatientId])].sort();
    for (const key of keys) {
      expect(/^(doctor|installation|patient|equipment):[1-9]\d*$/.test(key), 'repair_resource_invalid');
      await connection.execute('INSERT INTO AppointmentBookingResources (resource_key,resource_kind,created_at,updated_at) VALUES (?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE resource_key=resource_key', [key, key.split(':')[0]]);
      await rows(connection, 'SELECT resource_key FROM AppointmentBookingResources WHERE resource_key=? FOR UPDATE', [key]);
    }
    await rows(connection, 'SELECT id_paciente FROM Pacientes WHERE id_paciente IN (?,?) ORDER BY id_paciente FOR UPDATE', [recipe.canonicalPatientId, recipe.duplicatePatientId]);
    await rows(connection, 'SELECT id FROM Conversations WHERE id=? FOR UPDATE', [recipe.conversationId]);
    await rows(connection, 'SELECT id FROM LeadIntakes WHERE id=? FOR UPDATE', [recipe.leadId]);
    await rows(connection, 'SELECT id FROM JobRequests WHERE id IN (?,?) ORDER BY id FOR UPDATE', [recipe.executionJobId, recipe.scheduledJobId]);
    await rows(connection, 'SELECT id FROM FlowExecutionsV2 WHERE id=? FOR UPDATE', [recipe.failedExecutionId]);
    const current = await snapshot(connection, recipe);
    const events = await rows(connection, `SELECT id,metadata FROM PatientOperationalEvents WHERE patient_id=? AND clinic_id=? AND event_type=?
      AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.plan_sha256'))=?`, [recipe.canonicalPatientId, recipe.clinicId, EVENT, sha256]);
    if (!current.patients.some(patient => Number(patient.id_paciente) === recipe.duplicatePatientId)) {
      expect(events.length === 1 && Number(current.appointment?.paciente_id) === recipe.canonicalPatientId
        && digest(current.jobs) === digest(plan.snapshot.jobs) && digest(current.executions) === digest(plan.snapshot.executions)
        && digest(current.logs) === digest(plan.snapshot.logs), 'repair_replay_changed');
      await connection.commit();
      return { status: 'replayed', eventId: events[0].id };
    }
    validateBefore(current, recipe);
    expect(!events.length && digest(current) === digest(plan.snapshot), 'repair_preimage_changed');
    const [operator] = await rows(connection, 'SELECT id_usuario FROM Usuarios WHERE id_usuario=?', [actorUserId]);
    expect(operator, 'repair_operator_missing');
    const [changed] = await connection.execute(`UPDATE CitasPacientes SET paciente_id=?,updated_by=?,updated_at=NOW()
      WHERE id_cita=? AND paciente_id=? AND clinica_id=? AND estado=? AND updated_at=?`, [recipe.canonicalPatientId, actorUserId,
    recipe.appointmentId, recipe.duplicatePatientId, recipe.clinicId, current.appointment.estado, current.appointment.updated_at]);
    expect(changed.affectedRows === 1, 'repair_appointment_cas_failed');
    const duplicate = current.patients.find(patient => Number(patient.id_paciente) === recipe.duplicatePatientId);
    const metadata = { version: 1, plan_sha256: sha256, authorization_ref: authorizationRef,
      canonical_patient_id: recipe.canonicalPatientId, retired_patient_id: recipe.duplicatePatientId,
      retired_public_id: duplicate.public_id, retired_history_number: String(duplicate.numero_historia),
      history_scope: duplicate.historia_scope, appointment_id: recipe.appointmentId, lead_id: recipe.leadId,
      conversation_id: recipe.conversationId, preserved_failed_execution_id: recipe.failedExecutionId,
      preserved_scheduled_job_id: recipe.scheduledJobId, backup: backupRef };
    const [audit] = await connection.execute(`INSERT INTO PatientOperationalEvents
      (patient_id,clinic_id,actor_user_id,event_type,source,metadata,occurred_at,created_at) VALUES (?,?,?,?,?,?,NOW(),NOW())`,
    [recipe.canonicalPatientId, recipe.clinicId, actorUserId, EVENT, 'operator_reconciliation', JSON.stringify(metadata)]);
    const [links] = await connection.execute('DELETE FROM PacienteClinicas WHERE paciente_id=? AND clinica_id=?', [recipe.duplicatePatientId, recipe.clinicId]);
    expect(links.affectedRows === 1, 'repair_membership_cas_failed');
    const remaining = await dependencyInventory(connection, recipe);
    expect(remaining.every(row => row.duplicate_count === 0), 'repair_new_dependency');
    const [removed] = await connection.execute('DELETE FROM Pacientes WHERE id_paciente=? AND clinica_id=? AND numero_historia=? AND updatedAt=?',
      [recipe.duplicatePatientId, recipe.clinicId, recipe.duplicateHistoryNumber, duplicate.updatedAt]);
    expect(removed.affectedRows === 1, 'repair_patient_cas_failed');
    const after = await snapshot(connection, recipe);
    const canonicalBefore = current.patients.find(patient => Number(patient.id_paciente) === recipe.canonicalPatientId);
    const canonicalAfter = after.patients.find(patient => Number(patient.id_paciente) === recipe.canonicalPatientId);
    expect(digest(canonicalAfter) === digest(canonicalBefore)
      && digest(after.appointments.filter(row => Number(row.id_cita) !== recipe.appointmentId))
        === digest(current.appointments.filter(row => Number(row.id_cita) !== recipe.appointmentId)), 'repair_canonical_history_changed');
    expect(digest(after.jobs) === digest(current.jobs) && digest(after.executions) === digest(current.executions)
      && digest(after.logs) === digest(current.logs) && digest(after.occupancies) === digest(current.occupancies)
      && digest(after.counter) === digest(current.counter) && digest(after.conversation) === digest(current.conversation)
      && digest(after.lead) === digest(current.lead), 'repair_preserved_rows_changed');
    await connection.commit();
    return { status: 'applied', eventId: audit.insertId, canonicalPatientId: recipe.canonicalPatientId,
      retiredPatientId: recipe.duplicatePatientId, appointmentId: recipe.appointmentId, sends: 0 };
  } catch (error) { await connection.rollback(); throw error; }
}
module.exports = { inspectEmptyPatientReconciliation, applyEmptyPatientReconciliation, digest, sqlUtcTimestamp, VERSION, EVENT };
