'use strict';

const crypto = require('node:crypto');
const { Op, fn, col, literal } = require('sequelize');
const contract = require('../lib/patientFollowUps.contract');
const {
  STATUSES, ACTIVE_STATUSES, SOURCE_DATE_SEMANTICS, domainError, positiveInteger,
  boundedText, dateOnly, normalizeValues, sourceKey, normalizeFilters, makeCursor,
  madridToday, addDays,
} = contract;

const INACTIVE_APPOINTMENT_STATUSES = ['cancelada', 'no_asistio', 'ha_acudido', 'en_atencion', 'completada'];
const plain = (row) => row?.toJSON ? row.toJSON() : row;

// Dependency injection keeps focal tests entirely offline. Default DB is loaded lazily.
function createPatientFollowUpService({ db, now = () => new Date(), noticeService = null }) {
  const { PatientFollowUp, PatientFollowUpRevision, Paciente, PacienteClinica, CitaPaciente, Tratamiento } = db;
  const notices = noticeService || require('./patientFollowUpNotices.service').createPatientFollowUpNoticeService({ db, now });
  function refreshNotices(row,transaction) {
    if(notices.supported) transaction.afterCommit?.(()=>notices.reconcileOne(row.id).catch(error=>console.warn('[follow-up notices] reconciliation deferred',error.code||error.name)));
  }

  async function patientInClinic(identifier, clinicId, transaction) {
    const text = boundedText(String(identifier ?? ''), 'patient_id', 64, true);
    const where = /^[1-9]\d*$/.test(text) ? { id_paciente: positiveInteger(text) } : { public_id: text };
    const patient = await Paciente.findOne({ where, attributes: ['id_paciente', 'public_id', 'clinica_id', 'nombre', 'apellidos'], transaction });
    const linked = patient && (Number(patient.clinica_id) === clinicId || await PacienteClinica.findOne({
      where: { paciente_id: patient.id_paciente, clinica_id: clinicId }, attributes: ['id'], transaction,
    }));
    if (!linked) throw domainError(404, 'follow_up_patient_not_found', 'Paciente no encontrado en esta clínica.');
    return patient;
  }

  async function scopedRow(publicId, clinicId, transaction, lock = false) {
    const row = await PatientFollowUp.findOne({
      where: { public_id: boundedText(publicId, 'id', 36, true), clinic_id: clinicId },
      transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!row) throw domainError(404, 'follow_up_not_found', 'Seguimiento no encontrado.');
    await patientInClinic(String(row.patient_id), clinicId, transaction);
    return row;
  }

  async function appointmentInContext(id, clinicId, patientId, transaction, { active = false, lock = false } = {}) {
    const appointment = await CitaPaciente.findOne({
      where: { id_cita: positiveInteger(id, 'appointment_id'), clinica_id: clinicId, paciente_id: patientId },
      attributes: ['id_cita', 'clinica_id', 'paciente_id', 'estado', 'inicio', 'fin', 'titulo', 'tratamiento_id', 'es_provisional'],
      transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!appointment) throw domainError(404, 'follow_up_appointment_not_found', 'Cita no encontrada en este paciente y clínica.');
    if (active && (INACTIVE_APPOINTMENT_STATUSES.includes(appointment.estado) || appointment.es_provisional)) {
      throw domainError(409, 'follow_up_appointment_inactive', 'Vincula una cita activa y confirmada como reserva, no un bloqueo provisional.');
    }
    return appointment;
  }

  async function validateTreatment(id, clinicId, transaction) {
    if (!id) return;
    const treatment = await Tratamiento.findOne({ where: { id_tratamiento: id }, transaction });
    // System/group catalog has no clinic_id; check group membership explicitly.
    let allowed = treatment && Number(treatment.clinica_id) === clinicId;
    if (treatment && treatment.origen === 'sistema' && !treatment.clinica_id) allowed = true;
    if (treatment && treatment.origen === 'grupo' && !treatment.clinica_id && treatment.grupo_clinica_id) {
      const clinic = await db.Clinica.findOne({ where: { id_clinica: clinicId, grupoClinicaId: treatment.grupo_clinica_id }, attributes: ['id_clinica'], transaction });
      allowed = !!clinic;
    }
    if (!allowed) throw domainError(404, 'follow_up_treatment_not_found', 'Tratamiento no disponible en esta clínica.');
  }

  function serialize(row, { includeClinical = false, related = {} } = {}) {
    const data = plain(row);
    const patient = related.patient;
    const appointment = related.appointment;
    return {
      id: data.public_id, clinic_id: Number(data.clinic_id), patient_id: Number(data.patient_id),
      patient_public_id: patient?.public_id || null,
      patient_name: patient ? [patient.nombre, patient.apellidos].filter(Boolean).join(' ') : null,
      treatment_id: data.treatment_id ? Number(data.treatment_id) : null,
      treatment_name: related.treatment?.nombre || null,
      operational_reason: data.operational_reason,
      clinical_notes: includeClinical ? data.clinical_notes || null : null,
      clinical_notes_redacted: !includeClinical,
      clinical_target_date: data.clinical_target_date || null,
      contact_due_date: data.contact_due_date || null,
      reminder_advance_days: data.reminder_advance_days ?? null,
      recipient_mode: data.recipient_mode || 'creator', recipient_role_ids: data.recipient_role_ids || [],
      created_by: data.created_by ? Number(data.created_by) : null,
      notice_enabled: !!data.notice_enabled,
      status: data.status, version: Number(data.version_number),
      linked_appointment_id: data.linked_appointment_id ? Number(data.linked_appointment_id) : null,
      linked_appointment_start: appointment?.inicio || null,
      linked_appointment_timezone: appointment?.inicio && related.clinic
        ? require('./clinicOpeningHours.service').resolveClinicTimeZone(related.clinic) : null,
      linked_appointment_status: appointment?.estado || null,
      linked_appointment_needs_review: data.status === 'scheduled' && (!appointment || ['cancelada', 'no_asistio'].includes(appointment.estado)),
      linked_appointment_completed: data.status === 'scheduled' && require('../lib/status-catalog').hasAttendedAppointment(appointment),
      source_kind: data.source_kind,
      source_episode_id: includeClinical ? related.report?.public_id || null : null,
      source_episode_title: includeClinical ? related.report?.title || null : null,
      source_appointment_id: data.source_appointment_id ? Number(data.source_appointment_id) : null,
      source_date: data.source_date || null,
      source_date_semantics: data.source_date_semantics,
      created_at: data.created_at, updated_at: data.updated_at,
    };
  }

  async function hydrate(rows, { includeClinical = false, transaction, actorId } = {}) {
    if (!rows.length) return [];
    const ids = (field) => [...new Set(rows.map((row) => Number(row[field])).filter(Boolean))];
    const treatmentIds = ids('treatment_id');
    const appointmentIds = ids('linked_appointment_id');
    const reportIds = includeClinical ? ids('source_report_id') : [];
    const [patients, treatments, appointments, reports, clinic] = await Promise.all([
      Paciente.findAll({ where: { id_paciente: { [Op.in]: ids('patient_id') } }, attributes: ['id_paciente', 'public_id', 'nombre', 'apellidos'], transaction }),
      treatmentIds.length ? Tratamiento.findAll({ where: { id_tratamiento: { [Op.in]: treatmentIds } }, attributes: ['id_tratamiento', 'nombre'], transaction }) : [],
      appointmentIds.length ? CitaPaciente.findAll({ where: { id_cita: { [Op.in]: appointmentIds }, clinica_id: rows[0].clinic_id }, attributes: ['id_cita', 'clinica_id', 'paciente_id', 'inicio', 'estado'], transaction }) : [],
      reportIds.length && db.AppointmentClinicalReport?.findAll ? db.AppointmentClinicalReport.findAll({
        where: { id: { [Op.in]: reportIds }, clinic_id: rows[0].clinic_id },
        attributes: ['id', 'public_id', 'patient_id', 'clinic_id', 'title'], transaction,
      }) : [],
      appointmentIds.length ? db.Clinica.findOne({ where: { id_clinica: rows[0].clinic_id },
        attributes: ['id_clinica', 'configuracion'], transaction }) : null,
    ]);
    const patientMap = new Map(patients.map((row) => [Number(row.id_paciente), row]));
    const treatmentMap = new Map(treatments.map((row) => [Number(row.id_tratamiento), row]));
    const appointmentMap = new Map(appointments.map((row) => [Number(row.id_cita), row]));
    const reportMap = new Map(reports.map(row => [Number(row.id), row]));
    const items = rows.map((row) => {
      const appointment = appointmentMap.get(Number(row.linked_appointment_id));
      const report = reportMap.get(Number(row.source_report_id));
      return serialize(row, { includeClinical, related: {
        patient: patientMap.get(Number(row.patient_id)), treatment: treatmentMap.get(Number(row.treatment_id)),
        appointment: Number(appointment?.paciente_id) === Number(row.patient_id)
          && Number(appointment?.clinica_id) === Number(row.clinic_id) ? appointment : null,
        clinic: Number(clinic?.id_clinica) === Number(row.clinic_id) ? clinic : null,
        report: Number(report?.patient_id) === Number(row.patient_id) && Number(report?.clinic_id) === Number(row.clinic_id) ? report : null,
      } });
    });
    return notices.decorate(rows,items,actorId);
  }

  async function writeRevision(row, actorId, changeType, transaction) {
    const value = plain(row);
    await PatientFollowUpRevision.create({
      follow_up_id: row.id, version_number: row.version_number, actor_id: actorId,
      change_type: changeType, snapshot: value, created_at: now(),
    }, { transaction });
  }

  async function sourceForCreation(payload, clinicId, patientId, transaction, importedSource) {
    if (importedSource) {
      const kind = boundedText(importedSource.kind, 'source_kind', 40, true);
      const namespace = boundedText(importedSource.namespace, 'source_namespace', 120, true);
      const reference = boundedText(importedSource.reference, 'source_reference', 200, true);
      const semantics = importedSource.date_semantics || 'unknown';
      if (!SOURCE_DATE_SEMANTICS.includes(semantics)) throw domainError(400, 'follow_up_invalid_source_date', 'Semántica de la fecha importada no válida.');
      return {
        source_kind: kind, source_namespace: namespace, source_reference: reference,
        source_key: sourceKey(kind, namespace, reference), source_date: dateOnly(importedSource.date, 'source_date'), source_date_semantics: semantics,
      };
    }
    if (payload.source_kind && !['manual', 'clinical_report'].includes(payload.source_kind)) {
      throw domainError(400, 'follow_up_source_reserved', 'Los orígenes importados solo se crean mediante el importador validado.');
    }
    if (['source_namespace', 'source_reference', 'source_key', 'source_date', 'source_date_semantics', 'source_report_id'].some((key) => Object.hasOwn(payload, key))) {
      throw domainError(400, 'follow_up_source_reserved', 'La procedencia se calcula en backend.');
    }
    if (payload.source_episode_id != null) {
      const publicId = boundedText(payload.source_episode_id, 'source_episode_id', 36, true);
      const report = await db.AppointmentClinicalReport.findOne({ where: { public_id: publicId, clinic_id: clinicId, patient_id: patientId },
        attributes: ['id', 'public_id', 'appointment_id'], transaction, lock: transaction.LOCK.UPDATE });
      if (!report) throw domainError(404, 'follow_up_episode_not_found', 'Episodio no encontrado en este paciente y clínica.');
      if (payload.source_appointment_id != null && Number(payload.source_appointment_id) !== Number(report.appointment_id)) {
        const relation = db.ClinicalEpisodeAppointment && await db.ClinicalEpisodeAppointment.findOne({ where: {
          appointment_id: positiveInteger(payload.source_appointment_id, 'source_appointment_id'), report_id: report.id,
          clinic_id: clinicId, patient_id: patientId }, attributes: ['appointment_id'], transaction });
        if (!relation) throw domainError(409, 'follow_up_episode_appointment_mismatch', 'La cita no pertenece a este episodio.');
      }
      return { source_kind: 'clinical_report', source_namespace: 'clinicaclick', source_reference: `episode:${report.public_id}`,
        source_key: sourceKey('clinical_report', 'clinicaclick', `episode:${report.public_id}`),
        source_report_id: report.id, source_appointment_id: payload.source_appointment_id ? Number(payload.source_appointment_id) : report.appointment_id || null,
        source_date_semantics: payload.clinical_target_date ? 'clinical_target' : 'unknown' };
    }
    if (payload.source_appointment_id != null) {
      const appointment = await appointmentInContext(payload.source_appointment_id, clinicId, patientId, transaction);
      let report = await db.AppointmentClinicalReport.findOne({ where: { appointment_id: appointment.id_cita, clinic_id: clinicId, patient_id: patientId }, attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
      if (!report && db.ClinicalEpisodeAppointment) {
        const relation = await db.ClinicalEpisodeAppointment.findOne({ where: { appointment_id: appointment.id_cita,
          clinic_id: clinicId, patient_id: patientId }, attributes: ['report_id'], transaction });
        if (relation) report = await db.AppointmentClinicalReport.findOne({ where: { id: relation.report_id, clinic_id: clinicId,
          patient_id: patientId }, attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
      }
      const reference = `appointment:${appointment.id_cita}`;
      return {
        source_kind: 'clinical_report', source_namespace: 'clinicaclick', source_reference: reference,
        source_key: sourceKey('clinical_report', 'clinicaclick', reference),
        source_appointment_id: appointment.id_cita, source_report_id: report?.id || null,
        source_date_semantics: payload.clinical_target_date ? 'clinical_target' : 'unknown',
      };
    }
    if (payload.source_kind === 'clinical_report') throw domainError(400, 'follow_up_source_required', 'Indica la cita origen del seguimiento.');
    const requestKey = boundedText(payload.idempotency_key, 'idempotency_key', 120);
    return { source_kind: 'manual', source_date_semantics: payload.clinical_target_date ? 'clinical_target' : 'unknown',
      source_key: requestKey ? sourceKey('manual', `clinic:${clinicId}:patient:${patientId}`, requestKey) : null };
  }

  async function create({ clinicId, patientIdentifier, actorId, payload, includeClinical = false, importedSource = null, transaction = null }) {
    clinicId = positiveInteger(clinicId, 'clinic_id');
    if (!includeClinical && Object.hasOwn(payload, 'clinical_notes')) throw domainError(403, 'follow_up_clinical_forbidden', 'No tienes permisos para modificar notas clínicas.');
    const values = normalizeValues(payload, { creating: true, imported: !!importedSource });
    if(notices.supported) await notices.validateRecipients(values,clinicId);
    const execute = async (tx) => {
      const patient = await patientInClinic(patientIdentifier, clinicId, tx);
      const source = await sourceForCreation(payload, clinicId, patient.id_paciente, tx, importedSource);
      if (importedSource && source.source_date) {
        if (source.source_date_semantics === 'contact_due' && !Object.hasOwn(payload, 'contact_due_date')) values.contact_due_date = source.source_date;
        if (source.source_date_semantics === 'clinical_target' && !Object.hasOwn(payload, 'clinical_target_date')) values.clinical_target_date = source.source_date;
      }
      if (source.source_key) {
        // The report lock serializes episode and legacy appointment origins.
        // Use a current read after waiting; a prior patient lookup may already
        // have established a repeatable-read snapshot before the winner committed.
        const sourceRead = { transaction: tx, ...(source.source_report_id ? { lock: tx.LOCK.UPDATE } : {}) };
        const existing = await PatientFollowUp.findOne({ where: { source_key: source.source_key }, ...sourceRead })
          || (source.source_report_id ? await PatientFollowUp.findOne({ where: { clinic_id: clinicId,
            patient_id: patient.id_paciente, source_report_id: source.source_report_id }, ...sourceRead }) : null);
        if (existing) {
          if (Number(existing.clinic_id) !== clinicId || Number(existing.patient_id) !== Number(patient.id_paciente)) {
            throw domainError(409, 'follow_up_source_conflict', 'El origen ya está vinculado a otro contexto; requiere conciliación.');
          }
          const sameValues = Object.entries(values).every(([key, value]) => JSON.stringify(existing[key] ?? null) === JSON.stringify(value ?? null));
          if (!sameValues) {
            const error = domainError(409, 'follow_up_already_exists', 'Este origen ya tiene un seguimiento con otros datos. Ábrelo para modificarlo.');
            error.details = { existing_id: existing.public_id };
            throw error;
          }
          return { item: (await hydrate([existing], { includeClinical, transaction: tx, actorId }))[0], created: false };
        }
      }
      await validateTreatment(values.treatment_id, clinicId, tx);
      if (values.status === 'scheduled' && !values.linked_appointment_id) throw domainError(400, 'follow_up_appointment_required', 'Selecciona expresamente la cita que resuelve este seguimiento.');
      if (values.linked_appointment_id) {
        if (values.status !== 'scheduled') throw domainError(400, 'follow_up_invalid_link', 'Una nueva vinculación requiere estado agendado.');
        await appointmentInContext(values.linked_appointment_id, clinicId, patient.id_paciente, tx, { active: true, lock: true });
      }
      const row = await PatientFollowUp.create({
        ...values, ...source, public_id: crypto.randomUUID(), clinic_id: clinicId,
        patient_id: patient.id_paciente, version_number: 1, created_by: actorId, updated_by: actorId,
      }, { transaction: tx });
      await writeRevision(row, actorId, importedSource ? 'imported' : 'created', tx);
      refreshNotices(row,tx);
      return { item: (await hydrate([row], { includeClinical, transaction: tx, actorId }))[0], created: true };
    };
    try {
      return transaction ? await execute(transaction) : await db.sequelize.transaction(execute);
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') {
        throw domainError(409, 'follow_up_concurrent_create', 'Otro proceso ya creó este seguimiento. Vuelve a consultarlo antes de continuar.');
      }
      throw error;
    }
  }

  async function update({ id, clinicId, actorId, payload, includeClinical = false }) {
    clinicId = positiveInteger(clinicId, 'clinic_id');
    const expectedVersion = positiveInteger(payload.expected_version, 'expected_version');
    if (!includeClinical && Object.hasOwn(payload, 'clinical_notes')) throw domainError(403, 'follow_up_clinical_forbidden', 'No tienes permisos para modificar notas clínicas.');
    const immutable = ['clinic_id', 'patient_id', 'source_kind', 'source_namespace', 'source_reference', 'source_key', 'source_appointment_id', 'source_report_id', 'source_episode_id', 'source_date', 'source_date_semantics', 'idempotency_key'];
    if (immutable.some((key) => Object.hasOwn(payload, key))) throw domainError(400, 'follow_up_immutable_source', 'No se puede cambiar paciente, clínica ni procedencia de un seguimiento.');
    const patch = normalizeValues(payload);
    if (!Object.keys(patch).length) throw domainError(400, 'follow_up_empty_patch', 'No hay cambios para guardar.');
    return db.sequelize.transaction(async (transaction) => {
      const row = await scopedRow(id, clinicId, transaction, true);
      if (Number(row.version_number) !== expectedVersion) throw domainError(409, 'follow_up_version_conflict', 'El seguimiento ha cambiado. Recarga antes de guardar.');
      if (Object.hasOwn(patch, 'treatment_id')) await validateTreatment(patch.treatment_id, clinicId, transaction);
      const oldRoles=[...new Set(row.recipient_role_ids||[])].sort((a,b)=>a-b);
      const nextRoles=Object.hasOwn(patch,'recipient_role_ids')?patch.recipient_role_ids:oldRoles;
      const recipientChanged=(patch.recipient_mode||row.recipient_mode||'creator')!==(row.recipient_mode||'creator')||JSON.stringify(nextRoles)!==JSON.stringify(oldRoles);
      if(notices.supported && recipientChanged) await notices.validateRecipients({...plain(row),...patch},clinicId);
      const advance = Object.hasOwn(patch,'reminder_advance_days') ? patch.reminder_advance_days : row.reminder_advance_days;
      const target = Object.hasOwn(patch,'clinical_target_date') ? patch.clinical_target_date : row.clinical_target_date;
      if(advance != null && (Object.hasOwn(patch,'clinical_target_date') || Object.hasOwn(patch,'reminder_advance_days'))) patch.contact_due_date = target ? addDays(target,-advance) : null;
      else if(Object.hasOwn(patch,'contact_due_date') && !Object.hasOwn(patch,'reminder_advance_days')) patch.reminder_advance_days = null;
      const nextStatus = patch.status || row.status;
      const nextAppointment = Object.hasOwn(patch, 'linked_appointment_id') ? patch.linked_appointment_id : row.linked_appointment_id;
      if (nextStatus === 'scheduled') {
        if (!nextAppointment) throw domainError(400, 'follow_up_appointment_required', 'Selecciona expresamente la cita que resuelve este seguimiento.');
        const changedLink=row.status!=='scheduled'||Number(nextAppointment)!==Number(row.linked_appointment_id)
          || Object.hasOwn(patch,'linked_appointment_id') || Object.hasOwn(patch,'status');
        await appointmentInContext(nextAppointment, clinicId, row.patient_id, transaction, { active: changedLink, lock: true });
      } else if (patch.linked_appointment_id) {
        throw domainError(400, 'follow_up_invalid_link', 'Una nueva vinculación requiere estado agendado.');
      }
      if (ACTIVE_STATUSES.includes(nextStatus) && nextAppointment) patch.linked_appointment_id = null;
      const newCycle = (Object.hasOwn(patch,'contact_due_date') && patch.contact_due_date !== row.contact_due_date)
        || ACTIVE_STATUSES.includes(nextStatus) && !ACTIVE_STATUSES.includes(row.status);
      await row.update({ ...patch, ...(newCycle ? {notice_cycle:(row.notice_cycle||1)+1}:{}), updated_by: actorId, version_number: expectedVersion + 1 }, { transaction });
      await writeRevision(row, actorId, 'updated', transaction);
      if(!ACTIVE_STATUSES.includes(nextStatus)) await notices.settleNotifications(row,transaction);
      refreshNotices(row,transaction);
      return { item: (await hydrate([row], { includeClinical, transaction, actorId }))[0] };
    });
  }

  function patientVisibilityWhere(clinicId) {
    // clinicId is a strictly parsed integer; no user string is interpolated.
    return literal(`EXISTS (SELECT 1 FROM Pacientes pfu_patient WHERE pfu_patient.id_paciente = PatientFollowUp.patient_id AND (pfu_patient.clinica_id = ${clinicId} OR EXISTS (SELECT 1 FROM PacienteClinicas pfu_link WHERE pfu_link.paciente_id = pfu_patient.id_paciente AND pfu_link.clinica_id = ${clinicId})))`);
  }
  async function clinicToday(clinicId) {
    const clinic=await db.Clinica.findOne({where:{id_clinica:clinicId},attributes:['id_clinica','configuracion']});
    return require('./patientFollowUpNotices.service').localDay(now(),require('./clinicOpeningHours.service').resolveClinicTimeZone(clinic));
  }

  async function listTable({clinicId,patientIdentifier,query,includeClinical,actorId}) {
    clinicId=positiveInteger(clinicId,'clinic_id');
    const page=Number(query.page??0),size=Number(query.page_size??25);
    if(!Number.isInteger(page)||page<0||page>10000||!Number.isInteger(size)||size<1||size>100)throw domainError(400,'follow_up_invalid_page','Paginación no válida.');
    const patient=patientIdentifier?await patientInClinic(patientIdentifier,clinicId):null;
    const filters=normalizeFilters({...query,sort:'newest',limit:size,cursor:null},clinicId,patient?.id_paciente||null);
    const sorts={contact_due:'f.contact_due_date',created_at:'f.created_at',patient_name:'CONCAT(p.nombre,\' \',p.apellidos)',reason:'f.operational_reason',clinical_target_date:'f.clinical_target_date',status:'f.status',next_notice_at:'n.next_notice_at'};
    const sort=sorts[query.sort||'next_notice_at'];
    const direction=String(query.direction||'asc').toUpperCase();
    if(!sort||!['ASC','DESC'].includes(direction))throw domainError(400,'follow_up_invalid_sort','Orden no válido.');
    const q=boundedText(query.q,'Búsqueda',150)||'';
    const replacements={clinic:clinicId,actor:Number(actorId)||0,limit:size,offset:page*size,q:'%'+q.replace(/[!%_]/g,'!$&')+'%'};
    const clauses=['f.clinic_id=:clinic','(p.clinica_id=:clinic OR EXISTS(SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id=p.id_paciente AND pc.clinica_id=:clinic))'];
    if(patient){clauses.push('f.patient_id=:patient');replacements.patient=patient.id_paciente;}
    if(filters.statuses.length){clauses.push('f.status IN (:statuses)');replacements.statuses=filters.statuses;}
    if(filters.dueBefore){clauses.push('f.contact_due_date<=:before');replacements.before=filters.dueBefore;}
    if(filters.dueAfter){clauses.push('f.contact_due_date>=:after');replacements.after=filters.dueAfter;}
    if(query.window==='undated')clauses.push('f.contact_due_date IS NULL');
    if(q)clauses.push("(CONCAT(p.nombre,' ',p.apellidos) LIKE :q ESCAPE '!' OR f.operational_reason LIKE :q ESCAPE '!')");
    const from=`FROM PatientFollowUps f JOIN Pacientes p ON p.id_paciente=f.patient_id LEFT JOIN PatientFollowUpNotices n ON n.follow_up_id=f.id AND n.user_id=:actor WHERE ${clauses.join(' AND ')}`;
    const [totalRows]=await db.sequelize.query(`SELECT COUNT(*) total ${from}`,{replacements});
    const [ids]=await db.sequelize.query(`SELECT f.id ${from} ORDER BY CASE WHEN f.status IN ('pending','contacted') THEN 0 ELSE 1 END ASC,${sort} IS NULL ASC,${sort} ${direction},f.id ${direction} LIMIT :limit OFFSET :offset`,{replacements});
    const rows=ids.length?await PatientFollowUp.findAll({where:{id:{[Op.in]:ids.map(x=>x.id)},clinic_id:clinicId}}):[];
    const byId=new Map(rows.map(row=>[Number(row.id),row]));const ordered=ids.map(x=>byId.get(Number(x.id))).filter(Boolean);
    return {items:await hydrate(ordered,{includeClinical,actorId}),summary:{total:Number(totalRows[0].total)},total:Number(totalRows[0].total),page,page_size:size,as_of_date:await clinicToday(clinicId),next_cursor:null};
  }

  async function recipientOptions({clinicId,actorId}) {return notices.recipientOptions(positiveInteger(clinicId,'clinic_id'),actorId);}
  async function noticeAction({id,clinicId,actorId,payload,includeClinical=false}) {
    const row=await scopedRow(id,positiveInteger(clinicId,'clinic_id'));
    const result=await notices.action({id:row.public_id,clinicId:Number(clinicId),actorId,action:payload?.action});
    const item=(await get({id,clinicId,actorId,includeClinical})).item;
    return {item,notice_state:result.notice_state,notification:result.notification?require('../lib/notification-dto').mapNotificationToDto(result.notification):null};
  }

  async function list({ clinicId, patientIdentifier = null, query = {}, includeClinical = false, actorId }) {
    if(query.page !== undefined || query.page_size !== undefined) return listTable({clinicId,patientIdentifier,query,includeClinical,actorId});
    clinicId = positiveInteger(clinicId, 'clinic_id');
    const today = await clinicToday(clinicId);
    const until = addDays(today, 30);
    if (query.window && !['next_30_days', 'undated'].includes(query.window)) throw domainError(400, 'follow_up_invalid_input', 'Ventana de contacto no válida.');
    const effectiveQuery = { ...query };
    if (query.window === 'next_30_days') {
      effectiveQuery.due_before = query.due_before && dateOnly(query.due_before, 'due_before') < until ? query.due_before : until;
      effectiveQuery.sort = 'contact_due';
    }
    if (query.window === 'undated' && (query.due_before || query.due_after || query.sort === 'contact_due')) throw domainError(400, 'follow_up_invalid_input', 'Sin fecha no admite intervalo de contacto.');
    const patient = patientIdentifier ? await patientInClinic(patientIdentifier, clinicId) : null;
    const filters = normalizeFilters(effectiveQuery, clinicId, patient ? Number(patient.id_paciente) : null, `patient-follow-ups:${query.window || 'all'}`);
    const where = { clinic_id: clinicId, [Op.and]: [patientVisibilityWhere(clinicId)] };
    if (patient) where.patient_id = patient.id_paciente;
    if (filters.statuses.length) where.status = { [Op.in]: filters.statuses };
    if (filters.dueAfter || filters.dueBefore) where.contact_due_date = {
      ...(filters.dueAfter ? { [Op.gte]: filters.dueAfter } : {}), ...(filters.dueBefore ? { [Op.lte]: filters.dueBefore } : {}),
    };
    if (query.window === 'undated') where.contact_due_date = null;
    if (filters.sort === 'contact_due' && !where.contact_due_date) where.contact_due_date = { [Op.ne]: null };
    const cursorCondition = !filters.afterId ? {} : (filters.sort === 'contact_due' ? {
      [Op.or]: [
        { contact_due_date: { [Op.gt]: filters.afterDate } },
        { contact_due_date: filters.afterDate, id: { [Op.gt]: filters.afterId } },
      ],
    } : { id: { [Op.lt]: filters.afterId } });
    const dateSql = db.sequelize.escape(today);
    const untilSql = db.sequelize.escape(until);
    // Summary uses identical filters but never cursor/limit. One SQL aggregation, not frontend joins.
    const [rows, totals] = await Promise.all([
      PatientFollowUp.findAll({ where: { ...where, ...cursorCondition }, order: filters.sort === 'contact_due' ? [['contact_due_date', 'ASC'], ['id', 'ASC']] : [['id', 'DESC']], limit: filters.limit + 1 }),
      PatientFollowUp.findAll({ where, attributes: [
        'status', [fn('COUNT', col('id')), 'total'],
        [fn('SUM', literal(`CASE WHEN status IN ('pending','contacted') AND contact_due_date < ${dateSql} THEN 1 ELSE 0 END`)), 'overdue'],
        [fn('SUM', literal(`CASE WHEN status IN ('pending','contacted') AND contact_due_date >= ${dateSql} AND contact_due_date <= ${untilSql} THEN 1 ELSE 0 END`)), 'due_next_30_days'],
        [fn('SUM', literal("CASE WHEN status IN ('pending','contacted') AND contact_due_date IS NULL THEN 1 ELSE 0 END")), 'without_contact_date'],
      ], group: ['status'], raw: true }),
    ]);
    const summary = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    Object.assign(summary, { total: 0, overdue: 0, due_next_30_days: 0, without_contact_date: 0 });
    for (const total of totals) {
      if (STATUSES.includes(total.status)) summary[total.status] = Number(total.total);
      summary.total += Number(total.total);
      for (const key of ['overdue', 'due_next_30_days', 'without_contact_date']) summary[key] += Number(total[key] || 0);
    }
    const page = rows.slice(0, filters.limit);
    return { items: await hydrate(page, { includeClinical, actorId }), summary, as_of_date: today,
      next_cursor: rows.length > filters.limit ? makeCursor(page[page.length - 1].id, filters.scope, filters.sort === 'contact_due' ? page[page.length - 1].contact_due_date : null) : null };
  }

  async function get({ id, clinicId, includeClinical = false, actorId }) {
    const row = await scopedRow(id, positiveInteger(clinicId, 'clinic_id'));
    return { item: (await hydrate([row], { includeClinical, actorId }))[0] };
  }

  async function getForSourceAppointment({ appointmentId, clinicId, includeClinical = false, actorId }) {
    clinicId = positiveInteger(clinicId, 'clinic_id');
    const appointment = await CitaPaciente.findOne({ where: { id_cita: positiveInteger(appointmentId, 'appointment_id'), clinica_id: clinicId }, attributes: ['id_cita', 'paciente_id'] });
    if (!appointment) throw domainError(404, 'follow_up_appointment_not_found', 'Cita no encontrada en esta clínica.');
    await patientInClinic(String(appointment.paciente_id), clinicId);
    let report = await db.AppointmentClinicalReport.findOne({ where: { appointment_id: appointment.id_cita,
      clinic_id: clinicId, patient_id: appointment.paciente_id }, attributes: ['id'] });
    if (!report && db.ClinicalEpisodeAppointment) {
      const relation = await db.ClinicalEpisodeAppointment.findOne({ where: { appointment_id: appointment.id_cita,
        clinic_id: clinicId, patient_id: appointment.paciente_id }, attributes: ['report_id'] });
      if (relation) report = await db.AppointmentClinicalReport.findOne({ where: { id: relation.report_id,
        clinic_id: clinicId, patient_id: appointment.paciente_id }, attributes: ['id'] });
    }
    const row = await PatientFollowUp.findOne({ where: {
      clinic_id: clinicId, patient_id: appointment.paciente_id,
      [Op.or]: [{ source_key: sourceKey('clinical_report', 'clinicaclick', `appointment:${appointment.id_cita}`) },
        ...(report ? [{ source_report_id: report.id }] : [])],
    } });
    return { item: row ? (await hydrate([row], { includeClinical, actorId }))[0] : null };
  }

  async function getForSourceEpisode({ episodeId, clinicId, includeClinical = false, actorId }) {
    clinicId = positiveInteger(clinicId, 'clinic_id');
    const report = await db.AppointmentClinicalReport.findOne({ where: {
      public_id: boundedText(episodeId, 'source_episode_id', 36, true), clinic_id: clinicId }, attributes: ['id', 'patient_id'] });
    if (!report) throw domainError(404, 'follow_up_episode_not_found', 'Episodio no encontrado en esta clínica.');
    await patientInClinic(String(report.patient_id), clinicId);
    const row = await PatientFollowUp.findOne({ where: { clinic_id: clinicId, patient_id: report.patient_id, source_report_id: report.id } });
    return { item: row ? (await hydrate([row], { includeClinical, actorId }))[0] : null };
  }

  async function appointmentCandidates({ id, clinicId, query = {} }) {
    clinicId = positiveInteger(clinicId, 'clinic_id');
    const row = await scopedRow(id, clinicId);
    const limit = query.limit == null ? 30 : positiveInteger(query.limit, 'limit');
    if (limit > 50) throw domainError(400, 'follow_up_invalid_input', 'El máximo es 50 citas por página.');
    const filters = normalizeFilters({ limit, cursor: query.cursor }, clinicId, Number(row.patient_id), `appointment-candidates:${row.public_id}`);
    // Stable numeric keyset; appointments are returned newest-created first. No unbounded date search.
    const appointments = await CitaPaciente.findAll({
      where: { clinica_id: clinicId, paciente_id: row.patient_id, inicio: { [Op.gte]: now() }, estado: { [Op.notIn]: INACTIVE_APPOINTMENT_STATUSES },
        [Op.or]: [{ es_provisional: false }, { es_provisional: null }],
        ...(filters.afterId ? { id_cita: { [Op.lt]: filters.afterId } } : {}) },
      attributes: ['id_cita', 'inicio', 'fin', 'titulo', 'tratamiento_id', 'estado'], order: [['id_cita', 'DESC']], limit: limit + 1,
    });
    const page = appointments.slice(0, limit);
    const clinic = page.length ? await db.Clinica.findOne({ where: { id_clinica: clinicId },
      attributes: ['id_clinica', 'configuracion'] }) : null;
    const timezone = Number(clinic?.id_clinica) === clinicId
      ? require('./clinicOpeningHours.service').resolveClinicTimeZone(clinic) : null;
    return { items: page.map((appointment) => ({ id: Number(appointment.id_cita), inicio: appointment.inicio, fin: appointment.fin,
      timezone,
      titulo: appointment.titulo || null, treatment_id: appointment.tratamiento_id ? Number(appointment.tratamiento_id) : null, status: appointment.estado })),
    next_cursor: appointments.length > limit ? makeCursor(page[page.length - 1].id_cita, filters.scope) : null };
  }

  return { create, update, list, get, getForSourceAppointment, getForSourceEpisode, appointmentCandidates, serialize, recipientOptions, noticeAction };
}

let defaultService;
const getDefault = () => defaultService || (defaultService = createPatientFollowUpService({ db: require('../../models') }));
module.exports = { createPatientFollowUpService, ...contract };
for (const method of ['create', 'update', 'list', 'get', 'getForSourceAppointment', 'getForSourceEpisode', 'appointmentCandidates', 'recipientOptions', 'noticeAction']) {
  module.exports[method] = (...args) => getDefault()[method](...args);
}
