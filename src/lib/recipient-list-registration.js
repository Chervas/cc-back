'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { normalizePhoneDigits } = require('./phone');
const { normalizeHumanName } = require('./name');
const { allocatePatientHistoryNumber } = require('../services/patientHistoryNumber.service');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const chunks = (rows, size = 200) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

function planRecipientRegistration({ list, rows, patients, memberships }) {
  const clinicId = Number(list.clinica_id);
  const criteria = parse(list.criteria);
  const importedSource = list.source === 'imported_file' || (list.source === 'saved_recipient_list' && !!criteria.import_file_name);
  if (!clinicId || list.objective_id !== 'mass_sends' || !importedSource
    || list.status === 'archived' || criteria.record_kind !== 'recipient_list' || criteria.review_request) throw Error('RECIPIENT_SOURCE_REQUIRED');
  const clinics = new Map(patients.map(p => [Number(p.id_paciente), new Set([Number(p.clinica_id)])]));
  for (const m of memberships) clinics.get(Number(m.paciente_id))?.add(Number(m.clinica_id));
  const byPhone = new Map();
  for (const p of patients) for (const raw of [p.telefono_movil, p.telefono_secundario]) {
    const phone = normalizePhoneDigits(raw);
    if (!phone) continue;
    if (!byPhone.has(phone)) byPhone.set(phone, new Map());
    byPhone.get(phone).set(Number(p.id_paciente), p);
  }
  const repeated = new Map();
  for (const row of rows) {
    const key = normalizePhoneDigits(row.phone);
    if (key) repeated.set(key, (repeated.get(key) || 0) + 1);
  }
  const operations = rows.map(row => {
    const base = { itemId: Number(row.id), patientId: Number(row.paciente_id) || null };
    if (Number(row.clinica_id) !== clinicId) return { ...base, action: 'review', reason: 'foreign_item' };
    const phone = normalizePhoneDigits(row.phone);
    if (!phone) return { ...base, action: 'review', reason: 'invalid_phone' };
    if (repeated.get(phone) > 1) return { ...base, action: 'review', reason: 'duplicate_source_phone' };
    const matches = [...(byPhone.get(phone)?.values() || [])];
    const local = matches.filter(p => clinics.get(Number(p.id_paciente))?.has(clinicId));
    if (local.length > 1) return { ...base, action: 'review', reason: 'ambiguous_phone' };
    if (local.length === 1) {
      const patient = local[0];
      if (patient.fecha_baja) return { ...base, action: 'review', reason: 'inactive_patient' };
      if (base.patientId && base.patientId !== Number(patient.id_paciente)) return { ...base, action: 'review', reason: 'saved_link_mismatch' };
      return { ...base, patientId: Number(patient.id_paciente), action: base.patientId ? 'preserve' : 'link' };
    }
    if (base.patientId) return { ...base, action: 'review', reason: 'saved_link_mismatch' };
    if (matches.length) return { ...base, action: 'review', reason: 'another_group_clinic' };
    const custom = parse(row.custom_fields);
    const nombre = normalizeHumanName(custom.nombre || custom.nombre_paciente || row.name);
    const apellidos = normalizeHumanName(custom.apellidos || custom.apellido || '');
    if (!nombre || nombre.length > 255 || apellidos.length > 255) return { ...base, action: 'review', reason: 'invalid_name' };
    return { ...base, action: 'create', nombre, apellidos, phone: `+${phone}` };
  });
  const plan = { version: 1, clinicId, listId: Number(list.id), sourceSha256: digest(rows), operations };
  return { ...plan, sha256: digest(plan), counts: operations.reduce((out, op) => {
    const key = op.reason || op.action; out[key] = (out[key] || 0) + 1; return out;
  }, {}) };
}

async function captureRecipientRegistration(connection, { clinicId, listId, lock = false }) {
  const q = async (sql, args = []) => (await connection.query(sql, args))[0];
  const clinic = (await q(`SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica=?${lock ? ' FOR UPDATE' : ''}`, [clinicId]))[0];
  if (!clinic) throw Error('RECIPIENT_CLINIC_NOT_FOUND');
  const clinicIds = Number(clinic.grupoClinicaId) > 0
    ? (await q('SELECT id_clinica FROM Clinicas WHERE grupoClinicaId=?', [clinic.grupoClinicaId])).map(r => Number(r.id_clinica)) : [clinicId];
  const list = (await q(`SELECT * FROM MarketingPatientLists WHERE id=? AND clinica_id=?${lock ? ' FOR UPDATE' : ''}`, [listId, clinicId]))[0];
  if (!list) throw Error('RECIPIENT_LIST_NOT_FOUND');
  const rows = await q(`SELECT * FROM MarketingPatientListItems WHERE list_id=? ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [listId]);
  const patients = await q(`SELECT p.id_paciente,p.clinica_id,p.telefono_movil,p.telefono_secundario,p.fecha_baja FROM Pacientes p
    WHERE p.clinica_id IN (?) OR EXISTS(SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id=p.id_paciente AND pc.clinica_id IN (?)) ORDER BY p.id_paciente`, [clinicIds, clinicIds]);
  const memberships = await q('SELECT paciente_id,clinica_id FROM PacienteClinicas WHERE clinica_id IN (?) ORDER BY paciente_id,clinica_id', [clinicIds]);
  return { clinic, list, rows, patients, memberships, plan: planRecipientRegistration({ list, rows, patients, memberships }) };
}

async function applyRecipientRegistration(connection, { clinicId, listId, expectedSha256, actorId, beforeCommit, sourceSystem = 'gesden' }) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '') || !Number.isSafeInteger(actorId) || actorId <= 0
    || typeof beforeCommit !== 'function') throw Error('RECIPIENT_APPROVAL_AND_PRIVATE_JOURNAL_REQUIRED');
  if (!['gesden','cliniccloud','other','unknown'].includes(sourceSystem)) throw Error('RECIPIENT_SOURCE_SYSTEM_INVALID');
  const q = async (sql, args = []) => (await connection.query(sql, args))[0];
  const locks = await q('SELECT GET_LOCK(?,0) AS acquired', [`cc-recipient-registration:${clinicId}`]);
  if (Number(locks[0].acquired) !== 1) throw Error('RECIPIENT_REGISTRATION_BUSY');
  let started = false;
  try {
    const triggers = await q(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()
      AND EVENT_OBJECT_TABLE IN ('Pacientes','PacienteClinicas','PatientCustomFields','PatientOperationalEvents','MarketingPatientListItems')`);
    if (triggers.length) throw Error('RECIPIENT_REGISTRATION_TRIGGERS_REQUIRE_REVIEW');
    await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await connection.beginTransaction(); started = true;
    const snapshot = await captureRecipientRegistration(connection, { clinicId, listId, lock: true });
    const { plan, rows } = snapshot;
    if (plan.sha256 !== expectedSha256) throw Error('RECIPIENT_SOURCE_OR_IDENTITY_CHANGED');
    const creates = plan.operations.filter(op => op.action === 'create');
    const links = plan.operations.filter(op => op.action === 'link').map(op => ({ itemId: op.itemId, patientId: op.patientId }));
    const newPatients = [];
    const adapter = { query: (sql, options) => connection.query({ sql, namedPlaceholders: true }, options.replacements) };
    const historyBefore = await q('SELECT * FROM PatientHistoryCounters WHERE scope_key=? FOR UPDATE', [Number(snapshot.clinic.grupoClinicaId) > 0 ? `group:${snapshot.clinic.grupoClinicaId}` : `clinic:${clinicId}`]);
    if (creates.length) {
      const history = await allocatePatientHistoryNumber(adapter, clinicId, {});
      const first = BigInt(history.numero_historia);
      if (creates.length > 1) await q('UPDATE PatientHistoryCounters SET next_number=next_number+? WHERE scope_key=?', [creates.length - 1, history.historia_scope]);
      for (let index = 0; index < creates.length; index++) newPatients.push({ ...creates[index], publicId: `pac_${randomBytes(10).toString('hex')}`, history: String(first + BigInt(index)), historyScope: history.historia_scope });
      for (const batch of chunks(newPatients)) await q(`INSERT INTO Pacientes
        (public_id,nombre,apellidos,telefono_movil,clinica_id,numero_historia,historia_scope,fecha_alta,idioma_preferido,paciente_conocido,createdAt,updatedAt)
        VALUES ${batch.map(() => "(?,?,?,?,?,?,?,UTC_TIMESTAMP(),'es',FALSE,UTC_TIMESTAMP(),UTC_TIMESTAMP())").join(',')}`,
      batch.flatMap(p => [p.publicId,p.nombre,p.apellidos,p.phone,clinicId,p.history,p.historyScope]));
      for (const batch of chunks(newPatients)) {
        const inserted = await q('SELECT id_paciente,public_id FROM Pacientes WHERE public_id IN (?)', [batch.map(p => p.publicId)]);
        const byPublicId = new Map(inserted.map(p => [p.public_id,Number(p.id_paciente)]));
        for (const patient of batch) {
          patient.patientId = byPublicId.get(patient.publicId);
          if (!patient.patientId) throw Error('RECIPIENT_INSERT_NOT_VERIFIED');
          links.push({ itemId: patient.itemId, patientId: patient.patientId });
        }
        await q(`INSERT INTO PacienteClinicas (paciente_id,clinica_id,es_principal,createdAt,updatedAt) VALUES
          ${batch.map(() => '(?,?,TRUE,UTC_TIMESTAMP(),UTC_TIMESTAMP())').join(',')}`, batch.flatMap(p => [p.patientId,clinicId]));
        await q(`INSERT INTO PatientCustomFields (paciente_id,clinica_id,field_key,label,value,value_type,source,source_column,last_imported_at,created_at,updated_at) VALUES
          ${batch.map(() => "(?,?,?,?,?,'json',?,'recipient_list',UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())").join(',')}`,
        batch.flatMap(p => [p.patientId,clinicId,sourceSystem === 'gesden' ? 'gesden_recipient_source' : 'recipient_list_source',sourceSystem === 'gesden' ? 'Origen Gesden' : 'Origen del listado',JSON.stringify({ version:1,list_id:listId,item_id:p.itemId,
          source_system:sourceSystem, original_fields:parse(rows.find(r => Number(r.id) === p.itemId).custom_fields), messages_enabled:false,consent_granted:false,appointments_created:false }),sourceSystem]));
        await q(`INSERT INTO PatientOperationalEvents (patient_id,clinic_id,actor_user_id,event_type,source,channel,metadata,occurred_at,created_at) VALUES
          ${batch.map(() => "(?,?,?,'patient.created','patient_list',NULL,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())").join(',')}`,
        batch.flatMap(p => [p.patientId,clinicId,actorId,JSON.stringify({ source_system:sourceSystem,list_id:listId,item_id:p.itemId,registration_sha256:plan.sha256,automation_activated:false })]));
      }
    }
    for (const batch of chunks(links)) {
      const result = await q(`UPDATE MarketingPatientListItems SET paciente_id=CASE id ${batch.map(() => 'WHEN ? THEN ?').join(' ')} END,
        updated_at=UTC_TIMESTAMP() WHERE list_id=? AND clinica_id=? AND paciente_id IS NULL AND id IN (?)`,
      [...batch.flatMap(p => [p.itemId,p.patientId]),listId,clinicId,batch.map(p => p.itemId)]);
      if (result.affectedRows !== batch.length) throw Error('RECIPIENT_LINK_COMPARE_AND_SET_FAILED');
    }
    const after = await captureRecipientRegistration(connection, { clinicId, listId });
    if (after.plan.operations.some(op => ['create','link'].includes(op.action))) throw Error('RECIPIENT_POST_WRITE_INCOMPLETE');
    const changed = new Set(links.map(p => p.itemId));
    for (const row of after.rows) {
      const previous = rows.find(r => Number(r.id) === Number(row.id));
      const strip = value => Object.fromEntries(Object.entries(value).filter(([k]) => changed.has(Number(value.id)) ? !['paciente_id','updated_at'].includes(k) : true));
      if (digest(strip(row)) !== digest(strip(previous))) throw Error('RECIPIENT_UNEXPECTED_SOURCE_MUTATION');
    }
    const result = { clinicId,listId,planSha256:plan.sha256,created:newPatients.length,linkedExisting:links.length-newPatients.length,
      counts:after.plan.counts,newPatientIds:newPatients.map(p => p.patientId),links,historyBefore,sourceSha256After:digest(after.rows),messagesSent:0 };
    await beforeCommit({ snapshot,result,newPatients });
    await connection.commit(); started = false;
    return result;
  } finally {
    if (started) await connection.rollback();
    await q('SELECT RELEASE_LOCK(?)', [`cc-recipient-registration:${clinicId}`]);
  }
}

module.exports = { planRecipientRegistration,captureRecipientRegistration,applyRecipientRegistration };
