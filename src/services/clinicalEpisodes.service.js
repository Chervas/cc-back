'use strict';

const crypto = require('node:crypto');
const { Op, literal, where: sqlWhere } = require('sequelize');
const C = require('../lib/clinical-episode-contract');
const F = require('../lib/clinical-form-contract');
const { requireExpectedVersion, assertCurrentVersion } = require('../lib/clinical-report-version');
const plain = row => row?.toJSON ? row.toJSON() : row;
const SORT_DATE = literal('COALESCE(`AppointmentClinicalReport`.`occurred_at`, (SELECT `inicio` FROM `CitasPacientes` WHERE `id_cita` = `AppointmentClinicalReport`.`appointment_id`), `AppointmentClinicalReport`.`created_at`)');

function createClinicalEpisodeService({ db, now = () => new Date(), validateMaterialRefs, canAccess } = {}) {
  const { AppointmentClinicalReport: Report, AppointmentClinicalReportRevision: Revision,
    ClinicalEpisodeAppointment: Link, CitaPaciente: Appointment, Paciente: Patient } = db;
  const forms=require('./clinicalEpisodeForms.service').createClinicalEpisodeFormsService({db,now,...(canAccess?{canAccess}:{})});
  const services = require('./clinicalEpisodeServiceContext.service').createService({ db, ...(canAccess ? { canAccess } : {}) });
  const serviceContextSupported = !Report.rawAttributes || Object.hasOwn(Report.rawAttributes, 'service_ref');

  async function patientInClinic(identifier, clinicId, transaction, lock = false) {
    const raw = String(identifier ?? '');
    if (!raw || raw.length > 80) throw C.error(400, 'clinical_episode_invalid_patient', 'Selecciona un paciente válido.');
    const patient = await Patient.findOne({ where: /^[1-9]\d*$/.test(raw)
      ? { id_paciente: C.integer(raw, 'patient_id') } : { public_id: raw }, transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    const member = patient && (Number(patient.clinica_id) === clinicId || db.PacienteClinica && await db.PacienteClinica.findOne({
      where: { paciente_id: patient.id_paciente, clinica_id: clinicId }, attributes: ['id'], transaction,
    }));
    if (!member) throw C.error(404, 'clinical_episode_patient_not_found', 'Paciente no encontrado en esta clínica.');
    return patient;
  }

  async function loadAppointment(id, transaction, lock = false) {
    const appointment = await Appointment.findByPk(C.integer(id, 'appointment_id'), { transaction,
      ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!appointment) throw C.error(404, 'appointment_not_found', 'Cita no encontrada.');
    return appointment;
  }

  async function findForAppointment(appointment, transaction, lock = false) {
    const opts = { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) };
    let row = await Report.findOne({ where: { appointment_id: appointment.id_cita }, ...opts });
    if (!row && Link) {
      const link = await Link.findOne({ where: { appointment_id: appointment.id_cita,
        clinic_id: appointment.clinica_id, patient_id: appointment.paciente_id }, ...opts });
      if (link) row = await Report.findOne({ where: { id: link.report_id }, ...opts });
    }
    if (row && (Number(row.clinic_id) !== Number(appointment.clinica_id) || Number(row.patient_id) !== Number(appointment.paciente_id))) {
      throw C.error(409, 'clinical_episode_appointment_scope_changed', 'La cita ya no coincide con el paciente y clínica del episodio.');
    }
    return row;
  }

  async function scopedRow(publicId, clinicId, transaction, lock = false) {
    if (typeof publicId !== 'string' || !publicId || publicId.length > 80) throw C.error(400, 'clinical_episode_invalid_identifier', 'El episodio no es válido.');
    const row = await Report.findOne({ where: { public_id: publicId, clinic_id: C.integer(clinicId, 'clinic_id') }, transaction,
      ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!row) throw C.error(404, 'clinical_episode_not_found', 'Episodio no encontrado.');
    await patientInClinic(String(row.patient_id), Number(row.clinic_id), transaction);
    return row;
  }

  async function linkedIds(row, transaction) {
    const links = Link ? await Link.findAll({ where: { report_id: row.id, clinic_id: row.clinic_id, patient_id: row.patient_id },
      order: [['appointment_id', 'ASC']], transaction }) : [];
    return [...new Set([...(row.appointment_id ? [Number(row.appointment_id)] : []), ...links.map(link => Number(link.appointment_id))])];
  }

  async function hydrate(rows, transaction) {
    if (!rows.length) return [];
    const reportIds = rows.map(row => row.id);
    const links = Link ? await Link.findAll({ where: { report_id: { [Op.in]: reportIds } }, transaction }) : [];
    const ids = [...new Set([...rows.map(row => Number(row.appointment_id)), ...links.map(link => Number(link.appointment_id))].filter(Boolean))];
    const treatmentIds = [...new Set(rows.map(row => Number(row.treatment_id)).filter(Boolean))];
    const professionalIds = [...new Set(rows.map(row => Number(row.professional_id)).filter(Boolean))];
    const [appointments, treatments, professionals] = await Promise.all([
      ids.length ? Appointment.findAll({ where: { id_cita: { [Op.in]: ids } }, transaction }) : [],
      treatmentIds.length && db.Tratamiento ? db.Tratamiento.findAll({ where: { id_tratamiento: { [Op.in]: treatmentIds } }, attributes: ['id_tratamiento', 'nombre'], transaction }) : [],
      professionalIds.length && db.Usuario ? db.Usuario.findAll({ where: { id_usuario: { [Op.in]: professionalIds } }, attributes: ['id_usuario', 'nombre', 'apellidos'], transaction }) : [],
    ]);
    const apptMap = new Map(appointments.map(row => [Number(row.id_cita), plain(row)]));
    const treatmentMap = new Map(treatments.map(row => [Number(row.id_tratamiento), plain(row)]));
    const professionalMap = new Map(professionals.map(row => [Number(row.id_usuario), plain(row)]));
    const clinicRows = appointments.length && db.Clinica?.findByPk ? await Promise.all([...new Set(rows.map(row => Number(row.clinic_id)))].map(id => db.Clinica.findByPk(id, { attributes: ['id_clinica', 'configuracion'], transaction }))) : [];
    const clinics = new Map(clinicRows.filter(Boolean).map(row => [Number(row.id_clinica), row]));
    const consumables = await require('../lib/clinical-episode-consumables').snapshots(db, rows, transaction);
    return rows.map(row => {
      const value = plain(row), treatment = treatmentMap.get(Number(value.treatment_id)), professional = professionalMap.get(Number(value.professional_id));
      const requested = [...new Set([...(value.appointment_id ? [Number(value.appointment_id)] : []), ...links
        .filter(link => String(link.report_id) === String(value.id) && Number(link.clinic_id) === Number(value.clinic_id) && Number(link.patient_id) === Number(value.patient_id))
        .map(link => Number(link.appointment_id))])];
      const related = requested.map(id => apptMap.get(id)).filter(appointment => appointment
        && Number(appointment.clinica_id) === Number(value.clinic_id) && Number(appointment.paciente_id) === Number(value.patient_id));
      const primary = related.find(appointment => Number(appointment.id_cita) === Number(value.appointment_id));
      const title = value.title || treatment?.nombre || primary?.titulo || 'Episodio clínico';
      let linkReview;
      if (related.length) {
        const timezone = require('./clinicOpeningHours.service').resolveClinicTimeZone(clinics.get(Number(value.clinic_id)));
        const civil = date => { const parsed = new Date(date); return date && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(parsed) : null; };
        const day = civil(value.occurred_at || primary?.inicio || value.created_at);
        const different = related.filter(appointment => !day || civil(appointment.inicio) !== day).map(appointment => Number(appointment.id_cita));
        if (different.length) linkReview = { required: true, code: 'legacy_cross_day_links', timezone, appointment_ids: different };
      }
      return {
        id: value.public_id, clinic_id: Number(value.clinic_id), patient_id: Number(value.patient_id),
        appointment_id: primary ? Number(primary.id_cita) : null,
        appointment_ids: related.map(appointment => Number(appointment.id_cita)),
        appointments: related.map(appointment => ({ id: Number(appointment.id_cita), start: appointment.inicio, end: appointment.fin,
          status: appointment.estado, title: appointment.titulo || null, treatment_id: appointment.tratamiento_id ? Number(appointment.tratamiento_id) : null,
          professional_id: appointment.doctor_id ? Number(appointment.doctor_id) : null })),
        ...(linkReview ? { appointment_link_review: linkReview } : {}),
        title, occurred_at: value.occurred_at || primary?.inicio || value.created_at,
        template_key: value.template_key || 'general', template_snapshot: value.template_snapshot || null, template_default_origin: value.template_default_origin || null,
        form_data:value.form_data||null, diagnoses:value.diagnoses||[], rich_document: C.richDocument(value), material_refs: value.material_refs || [],
        treatment_id: value.treatment_id ? Number(value.treatment_id) : null, treatment_name: treatment?.nombre || primary?.titulo || null,
        service_ref: require('./clinicalEpisodeServiceContext.service').identity(value.service_ref), service_title: value.service_ref?.title || null, service_area_key: value.service_ref?.area_key || null,
        professional_id: value.professional_id ? Number(value.professional_id) : null,
        professional_name: professional ? [professional.nombre, professional.apellidos].filter(Boolean).join(' ').trim() || null : null,
        appointment_start: primary?.inicio || null, appointment_end: primary?.fin || null, appointment_status: primary?.estado || null,
        status: value.status, version: Number(value.version_number), consumables: consumables.get(String(value.id)) || [],
        ...Object.fromEntries(C.TEXT_FIELDS.map(key => [key, value[key] || null])),
        finalized_at: value.finalized_at || null, created_at: value.created_at, updated_at: value.updated_at,
      };
    });
  }

  async function selectedAppointments(ids, { clinicId, patientId, reportId, transaction, existingIds = [], occurredAt }) {
    const rows = [];
    for (const id of [...ids].sort((a, b) => a - b)) {
      const appointment = await loadAppointment(id, transaction, true);
      if (Number(appointment.clinica_id) !== clinicId || Number(appointment.paciente_id) !== Number(patientId)) {
        throw C.error(404, 'clinical_episode_appointment_not_found', 'Una de las citas no pertenece a este paciente y clínica.');
      }
      const existing = await findForAppointment(appointment, transaction, true);
      if (existing && String(existing.id) !== String(reportId)) throw C.error(409, 'clinical_episode_appointment_linked', 'Una de las citas ya tiene un episodio. Abre ese episodio para continuar.', { episode_id: existing.public_id, appointment_id: id });
      if (!existingIds.includes(id) && ['no_asistio', 'reprogramada'].includes(appointment.estado)) throw C.error(409, 'clinical_episode_attendance_confirmation_required', 'Confirma y corrige la asistencia de esta cita antes de registrar el episodio.', { appointment_id: id, status: appointment.estado });
      rows.push(appointment);
    }
    if (rows.some(row => !existingIds.includes(Number(row.id_cita)))) {
      const clinic = await db.Clinica.findByPk(clinicId, { transaction });
      const timezone = require('./clinicOpeningHours.service').resolveClinicTimeZone(clinic);
      const civil = value => { const at = new Date(value); if (!value || !Number.isFinite(at.getTime())) throw C.error(409, 'clinical_episode_appointment_date_invalid', 'Revisa la fecha del episodio y de sus citas.'); return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(at); };
      const day = civil(occurredAt || rows[0]?.inicio);
      if (rows.some(row => !existingIds.includes(Number(row.id_cita)) && civil(row.inicio) !== day)) throw C.error(409, 'clinical_episode_appointment_day_mismatch', 'Solo se pueden añadir citas del mismo día que el episodio, según la hora de la clínica.');
    }
    return ids.map(id => rows.find(row => Number(row.id_cita) === id));
  }

  async function replaceLinks(row, ids, actorId, transaction) {
    if (!Link) {
      if (ids.length > 1) throw C.error(503, 'clinical_episode_schema_pending', 'Los episodios están pendientes de habilitación técnica.');
      return;
    }
    await Link.destroy({ where: { report_id: row.id }, transaction });
    if (ids.length) await Link.bulkCreate(ids.map(id => ({ appointment_id: id, report_id: row.id,
      clinic_id: row.clinic_id, patient_id: row.patient_id, created_by: actorId })), { transaction });
  }

  async function materialValues(payload, row, actorId, transaction) {
    if (!C.has(payload, 'material_refs')) return {};
    const validator = validateMaterialRefs || require('./clinicalEpisodeMaterials.service').validateMaterialRefs;
    return { material_refs: await validator({ refs: payload.material_refs, patientId: Number(row.patient_id), clinicId: Number(row.clinic_id), actorId, transaction }) };
  }
  async function templateValues(payload, clinicId, transaction, previous = {}) {
    if (!C.has(payload, 'template_ref')) return {};
    const snapshot = await require('./clinicalEpisodeTemplates.service').createClinicalEpisodeTemplateService({ db }).resolveReference(payload.template_ref, clinicId, transaction,
      { allowArchivedId: previous.template_snapshot?.id });
    return { template_snapshot: snapshot, ...(snapshot ? { template_key: snapshot.area_key } : {}) };
  }

  function narrativeValues(normalized, previous, selectedTemplate) {
    if (!normalized.rich_document && selectedTemplate === undefined) return {};
    const document = C.richDocument({ ...previous, ...normalized });
    const fields = [...(previous.template_snapshot?.fields || []), ...(selectedTemplate?.fields || [])];
    const retained = C.richDocument(previous), labels = { ...(retained.labels || {}) };
    for (const field of fields) if (C.CUSTOM_SECTION_KEY.test(field.key)) labels[field.key] = field.label;
    for (const key of Object.keys(document.sections).filter(key => C.CUSTOM_SECTION_KEY.test(key))) {
      if (!retained.sections[key] && !fields.some(field => field.key === key)) throw C.error(400, 'clinical_episode_invalid_document', 'El apartado propio no está definido en la plantilla del episodio.');
      if (!labels[key]) throw C.error(400, 'clinical_episode_invalid_document', 'El apartado propio necesita un título de su plantilla.');
    }
    // Labels come from immutable template snapshots, never an arbitrary client
    // label. Orphaned text remains readable after changing templates.
    document.labels = Object.fromEntries(Object.keys(document.sections).filter(key => C.CUSTOM_SECTION_KEY.test(key)).map(key => [key, labels[key]]));
    if (!Object.keys(document.labels).length) delete document.labels;
    return { rich_document: document };
  }

  async function validateProfessional(id, clinicId, transaction) {
    if (id === undefined) return;
    const professionalId = C.integer(id, 'professional_id');
    if (!db.Usuario || !db.UsuarioClinica || !db.DoctorClinica) throw C.error(503, 'clinical_episode_professional_unavailable', 'No se pudo comprobar el profesional de esta clínica.');
    const lock = transaction ? { lock: transaction.LOCK.SHARE } : {};
    const [user, membership, doctor] = await Promise.all([
      db.Usuario.findByPk(professionalId, { attributes: ['id_usuario', 'estado_cuenta'], transaction, ...lock }),
      db.UsuarioClinica.findOne({ where: { id_usuario: professionalId, id_clinica: clinicId,
        rol_clinica: { [Op.in]: ['personaldeclinica', 'propietario', 'agencia'] }, subrol_clinica: 'Doctores',
        [Op.or]: [{ estado_invitacion: 'aceptada' }, { estado_invitacion: null }] }, transaction, ...lock }),
      db.DoctorClinica.findOne({ where: { doctor_id: professionalId, clinica_id: clinicId, activo: true }, transaction, ...lock }),
    ]);
    if (!user || user.estado_cuenta !== 'activo' || !membership || !doctor) throw C.error(400, 'clinical_episode_professional_invalid', 'Selecciona un profesional activo de esta clínica.');
  }

  async function professionals({ id, clinicId }) {
    const row = await scopedRow(id, clinicId);
    clinicId = Number(row.clinic_id);
    if (!db.Usuario || !db.UsuarioClinica || !db.DoctorClinica) throw C.error(503, 'clinical_episode_professional_unavailable', 'No se pudieron consultar los profesionales de esta clínica.');
    const doctors = await db.DoctorClinica.findAll({ where: { clinica_id: clinicId, activo: true }, attributes: ['doctor_id'], limit: 1001, order: [['doctor_id', 'ASC']] });
    if (doctors.length > 1000) throw C.error(400, 'clinical_episode_professional_limit', 'La clínica tiene demasiados profesionales para esta selección.');
    const ids = [...new Set(doctors.map(doctor => Number(doctor.doctor_id)))];
    if (!ids.length) return { items: [] };
    const [memberships, users] = await Promise.all([
      db.UsuarioClinica.findAll({ where: { id_usuario: { [Op.in]: ids }, id_clinica: clinicId,
        rol_clinica: { [Op.in]: ['personaldeclinica', 'propietario', 'agencia'] }, subrol_clinica: 'Doctores',
        [Op.or]: [{ estado_invitacion: 'aceptada' }, { estado_invitacion: null }] }, attributes: ['id_usuario'] }),
      db.Usuario.findAll({ where: { id_usuario: { [Op.in]: ids }, estado_cuenta: 'activo' }, attributes: ['id_usuario', 'nombre', 'apellidos'] }),
    ]);
    const members = new Set(memberships.map(member => Number(member.id_usuario)));
    return { items: users.filter(user => members.has(Number(user.id_usuario))).map(user => ({ id: Number(user.id_usuario),
      name: [user.nombre, user.apellidos].filter(Boolean).join(' ').trim() || `Profesional ${user.id_usuario}` })).sort((a, b) => a.name.localeCompare(b.name, 'es')) };
  }

  function confirmFutureAppointments(appointments, payload) {
    if (payload.future_appointment_confirmed === true) return;
    const { careState } = require('../lib/appointment-care');
    const future = appointments.filter(appointment => {
      const start = new Date(appointment.inicio).getTime();
      const care = careState(appointment, now());
      return Number.isFinite(start) && start > now().getTime() && !care?.started_at && !care?.completed_at;
    });
    if (future.length) throw C.error(409, 'clinical_episode_future_appointment_confirmation_required', 'Esta cita es futura y todavía no se ha iniciado la atención. Confirma si quieres preparar un borrador anticipado; esto no registra asistencia ni inicia la cita.', { appointment_ids: future.map(appointment => Number(appointment.id_cita)) });
  }

  async function revision(row, actorId, changeType, transaction, receipt = {}) {
    const value = plain(row), appointmentIds = await linkedIds(row, transaction);
    const snapshot = {
      public_id: value.public_id, clinic_id: Number(value.clinic_id), patient_id: Number(value.patient_id),
      appointment_id: value.appointment_id ? Number(value.appointment_id) : null, appointment_ids: appointmentIds,
      treatment_id: value.treatment_id ? Number(value.treatment_id) : null, professional_id: value.professional_id ? Number(value.professional_id) : null,
      service_ref: value.service_ref || null,
      title: value.title || null, occurred_at: value.occurred_at || null, template_key: value.template_key || 'general', template_snapshot: value.template_snapshot || null,
      template_default_origin: value.template_default_origin || null,
      status: value.status, version: Number(value.version_number), form_data:value.form_data||null, diagnoses:value.diagnoses||[], rich_document: C.richDocument(value), material_refs: value.material_refs || [],
      consumables: (await require('../lib/clinical-episode-consumables').snapshots(db, [row], transaction)).get(String(row.id)) || [],
      ...Object.fromEntries(C.TEXT_FIELDS.map(key => [key, value[key] || null])), finalized_at: value.finalized_at,
    };
    await Revision.create({ report_id: row.id, version_number: row.version_number, status: row.status,
      snapshot, change_type: changeType, actor_id: actorId, ...receipt }, { transaction });
  }

  async function get({ id, clinicId, transaction }) {
    return { item: (await hydrate([await scopedRow(id, clinicId, transaction)], transaction))[0] };
  }

  async function getForAppointment({ appointmentId, clinicId = null }) {
    const appointment = await loadAppointment(appointmentId);
    if (clinicId !== null && Number(appointment.clinica_id) !== C.integer(clinicId, 'clinic_id')) throw C.error(404, 'appointment_not_found', 'Cita no encontrada.');
    await patientInClinic(String(appointment.paciente_id), Number(appointment.clinica_id));
    const row = await findForAppointment(appointment);
    return { item: row ? (await hydrate([row]))[0] : null };
  }

  async function list({ patientIdentifier, clinicId, query = {} }) {
    clinicId = C.integer(clinicId, 'clinic_id');
    const patient = await patientInClinic(patientIdentifier, clinicId);
    const limit = query.limit === undefined ? 30 : C.integer(query.limit, 'limit');
    if (limit > 100) throw C.error(400, 'clinical_episode_invalid_limit', 'Solicita como máximo 100 episodios.');
    const filters = { clinic_id: clinicId, patient_id: patient.id_paciente };
    if (query.status) {
      if (!['draft', 'final'].includes(query.status)) throw C.error(400, 'clinical_episode_invalid_status', 'El estado no es válido.');
      filters.status = query.status;
    }
    if (query.appointment_id !== undefined) {
      const id = C.integer(query.appointment_id, 'appointment_id');
      const appointment = await loadAppointment(id);
      if (Number(appointment.clinica_id) !== clinicId || Number(appointment.paciente_id) !== Number(patient.id_paciente)) throw C.error(404, 'appointment_not_found', 'Cita no encontrada.');
      const links = Link ? await Link.findAll({ where: { appointment_id: id, clinic_id: clinicId, patient_id: patient.id_paciente }, attributes: ['report_id'] }) : [];
      filters[Op.or] = [{ appointment_id: id }, ...(links.length ? [{ id: { [Op.in]: links.map(link => link.report_id) } }] : [])];
    }
    const scope = C.hash([clinicId, Number(patient.id_paciente), query.status || null, query.appointment_id ? Number(query.appointment_id) : null]);
    const cursor = C.decodeCursor(query.cursor);
    if (cursor) {
      if (cursor.scope !== scope) throw C.error(400, 'clinical_episode_invalid_cursor', 'La página no corresponde a esta búsqueda.');
      const date = C.timestamp(cursor.date, 'cursor'), id = C.integer(cursor.id, 'cursor');
      filters[Op.and] = [{ [Op.or]: [sqlWhere(SORT_DATE, Op.lt, date), { [Op.and]: [sqlWhere(SORT_DATE, Op.eq, date), { id: { [Op.lt]: id } }] }] }];
    }
    const rows = await Report.findAll({ where: filters, attributes: { include: [[SORT_DATE, 'episode_sort_at']] },
      order: [[SORT_DATE, 'DESC'], ['id', 'DESC']], limit: limit + 1 });
    const page = rows.slice(0, limit), last = page[page.length - 1];
    return { items: await hydrate(page), next_cursor: rows.length > limit && last
      ? C.encodeCursor({ scope, date: new Date(plain(last).episode_sort_at || last.occurred_at || last.created_at).toISOString(), id: Number(last.id) }) : null };
  }

  async function create({ patientIdentifier, clinicId, actorId, payload }) {
    clinicId = C.integer(clinicId, 'clinic_id'); actorId = C.integer(actorId, 'actor_id');
    const expected = requireExpectedVersion(payload);
    if (expected !== 0) throw C.error(409, 'clinical_report_version_conflict', 'El episodio nuevo debe comenzar en la versión inicial.', { expected_version: expected, current_version: 0 });
    if (C.has(payload,'use_template_default') && typeof payload.use_template_default !== 'boolean') throw C.error(400,'clinical_template_default_invalid','Revisa la elección de plantilla.');
    if (C.has(payload,'template_default_origin')) throw C.error(400,'clinical_template_default_invalid','El origen de la plantilla lo registra el sistema.');
    if (payload.use_template_default === true && payload.template_ref != null && (!C.object(payload.template_ref)
      || Object.keys(payload.template_ref).some(key => !['id','version'].includes(key)) || typeof payload.template_ref.id !== 'string')) throw C.error(400,'clinical_template_reference_invalid','Selecciona una versión válida de la plantilla.');
    const key = C.idempotencyKey(payload.idempotency_key, true), normalized = C.normalizePatch(payload), ids = normalized.appointment_ids || [];
    delete normalized.appointment_ids;
    const requestHash = C.hash({ values: normalized, appointment_ids: ids, material_refs: payload.material_refs || [], template_ref: payload.template_ref,form_data:payload.form_data,clinical_reference_update:payload.clinical_reference_update,
      ...(C.has(payload,'use_template_default') ? {use_template_default:payload.use_template_default} : {}) });
    return db.sequelize.transaction(async transaction => {
      const patient = await patientInClinic(patientIdentifier, clinicId, transaction, true);
      const creationKey = C.hash([clinicId, Number(patient.id_paciente), key]);
      const existing = await Report.findOne({ where: { creation_key: creationKey }, transaction });
      if (existing) {
        if (existing.creation_payload_hash !== requestHash) throw C.error(409, 'clinical_episode_idempotency_conflict', 'Esta solicitud ya creó un episodio con otros datos.', { episode_id: existing.public_id });
        return { item: (await hydrate([existing], transaction))[0], created: false, replayed: true };
      }
      const appointments = await selectedAppointments(ids, { clinicId, patientId: patient.id_paciente, transaction, occurredAt: normalized.occurred_at });
      confirmFutureAppointments(appointments, payload);
      await validateProfessional(normalized.professional_id, clinicId, transaction);
      const primary = appointments[0];
      const materials = await materialValues(payload, { patient_id: patient.id_paciente, clinic_id: clinicId }, actorId, transaction);
      const serviceContext = serviceContextSupported ? await services.values({ payload, primary, appointments, patientId: patient.id_paciente, clinicId, actorId, transaction, creating: true }) : {};
      let template, formInput=payload.form_data;
      if (payload.use_template_default === true) {
        const resolved=await require('./clinicalTemplateDefaults.service').createService({db,...(canAccess?{canAccess}:{})}).resolveInitial({clinicId,patientId:Number(patient.id_paciente),actorId,payload,appointments,serviceContext,transaction});
        if (!resolved.item && payload.template_ref) throw C.error(409,resolved.reason==='not_first'?'clinical_template_default_not_first':'clinical_template_default_changed',
          'La recomendación de plantilla ha cambiado. Actualiza la consulta o elige una plantilla manualmente.',{applied:false,reason:resolved.reason});
        if (resolved.item) {
          const chosen=resolved.item;
          if (payload.template_ref && (payload.template_ref.id!==chosen.template_ref.id || C.integer(payload.template_ref.version)!==chosen.template_ref.version)) throw C.error(409,'clinical_template_default_changed',
            'La preferencia de primera consulta ha cambiado. Revísala antes de crear el episodio.',{applied:false});
          template={template_snapshot:chosen.template,template_key:chosen.template.area_key,template_default_origin:{preference_id:chosen.preference_id,preference_version:chosen.preference_version,
            treatment_id:chosen.treatment_id,template_ref:chosen.template_ref,scope:chosen.scope,service_ref:chosen.service_ref,
            criterion:chosen.scope==='service'?'first_episode_for_service':'first_episode_for_patient_clinic_treatment'}};
          const base=C.richDocument({rich_document:chosen.template.rich_document}), sections={...base.sections};
          for (const field of Object.keys(sections)) {
            if (C.has(payload.rich_document?.sections||{},field)) sections[field]=normalized.rich_document.sections[field];
            else if (C.has(payload,field) && C.TEXT_FIELDS.includes(field)) sections[field]=C.plainDocument(normalized[field]);
          }
          // Extra sections explicitly supplied by the doctor are validated by
          // narrativeValues against this immutable template as usual.
          for (const field of Object.keys(payload.rich_document?.sections||{})) sections[field]=normalized.rich_document.sections[field];
          Object.assign(normalized,C.normalizePatch({rich_document:{...base,sections}}));
          if (formInput===undefined && chosen.template.form_schema) formInput={version:1,instances:[{id:crypto.randomUUID(),template_ref:chosen.template_ref,answers:{}}]};
        }
      }
      template ||= await templateValues(payload, clinicId, transaction);
      const narrative = narrativeValues(normalized, {}, template.template_snapshot);
      const row = await Report.create({
        public_id: crypto.randomUUID(), clinic_id: clinicId, patient_id: patient.id_paciente,
        appointment_id: primary?.id_cita || null, treatment_id: primary?.tratamiento_id || null,
        professional_id: primary?.doctor_id || actorId, title: primary?.titulo || 'Episodio clínico',
        occurred_at: primary?.inicio || now(), template_key: 'general',
        ...normalized, ...materials, ...template, ...narrative, ...serviceContext, creation_key: creationKey, creation_payload_hash: requestHash,
        status: 'draft', version_number: 1, created_by: actorId, updated_by: actorId,
      }, { transaction });
      if(formInput!==undefined||C.has(payload,'clinical_reference_update')){
        let data=await forms.normalize({input:formInput,previous:null,row,transaction});
        data=await forms.applyReference({input:payload.clinical_reference_update,data,row,actorId,transaction,idempotencyKey:key,nextVersion:1});
        await row.update({form_data:data},{transaction});
      }
      await replaceLinks(row, ids, actorId, transaction);
      await revision(row, actorId, 'created', transaction);
      return { item: (await hydrate([row], transaction))[0], created: true };
    });
  }

  async function updateRow({ row, actorId, payload, mode, transaction, legacy = false }) {
    const expected = requireExpectedVersion(payload), normalized = C.normalizePatch(payload, plain(row), { legacy });
    const key = C.idempotencyKey(payload.idempotency_key), requestHash = C.hash({ mode, expected_version: expected,
      values: C.normalizePatch(payload, {}, { legacy }), material_refs: payload.material_refs, template_ref: payload.template_ref,form_data:payload.form_data,clinical_reference_update:payload.clinical_reference_update });
    if(legacy&&(C.has(payload,'form_data')||C.has(payload,'clinical_reference_update')))throw F.invalid('Abre el episodio para actualizar sus formularios.');
    if (key) {
      const mutationKey = C.hash(key);
      const prior = await Revision.findOne({ where: { report_id: row.id, mutation_key: mutationKey }, transaction });
      if (prior) {
        if (prior.request_hash !== requestHash) throw C.error(409, 'clinical_episode_idempotency_conflict', 'La solicitud ya se utilizó con otros datos.');
        return { item: (await hydrate([row], transaction))[0], replayed: true };
      }
    }
    assertCurrentVersion(expected, row);
    if (row.status === 'final' && mode !== 'reopen') {
      if (mode === 'finalize' && !Object.keys(normalized).length && !C.has(payload, 'material_refs') && !C.has(payload, 'template_ref')&&!C.has(payload,'form_data')&&!C.has(payload,'clinical_reference_update')) return { item: (await hydrate([row], transaction))[0], replayed: true };
      throw C.error(409, 'clinical_report_final', 'El episodio está cerrado. Reábrelo antes de modificarlo.');
    }
    if (mode === 'reopen' && row.status !== 'final') {
      if (Object.keys(normalized).length || C.has(payload, 'material_refs') || C.has(payload, 'template_ref')||C.has(payload,'form_data')||C.has(payload,'clinical_reference_update')) throw C.error(409, 'clinical_episode_not_final', 'El episodio ya está abierto. Guarda los cambios como borrador.');
      return { item: (await hydrate([row], transaction))[0], replayed: true };
    }
    const oldIds = await linkedIds(row, transaction), ids = normalized.appointment_ids;
    let contextAppointments;
    delete normalized.appointment_ids;
    if (ids) {
      contextAppointments = await selectedAppointments(ids, { clinicId: Number(row.clinic_id), patientId: row.patient_id, reportId: row.id, transaction, existingIds: oldIds, occurredAt: normalized.occurred_at || row.occurred_at || row.created_at });
      normalized.appointment_id = ids.includes(Number(row.appointment_id)) ? row.appointment_id : ids[0] || null;
    }
    if (!legacy && serviceContextSupported) {
      const contextPayload = { ...payload };
      if (ids && JSON.stringify([...oldIds].sort((a, b) => a - b)) === JSON.stringify([...ids].sort((a, b) => a - b))) delete contextPayload.appointment_ids;
      const contextChanged = C.has(contextPayload, 'service_ref') || C.has(contextPayload, 'treatment_id') || C.has(contextPayload, 'appointment_ids');
      if (contextChanged) {
        const primaryId = normalized.appointment_id === undefined ? row.appointment_id : normalized.appointment_id;
        const primary = primaryId ? await loadAppointment(primaryId, transaction) : null;
        contextAppointments ||= oldIds.length ? await Appointment.findAll({ where: { id_cita: { [Op.in]: oldIds }, clinica_id: row.clinic_id, paciente_id: row.patient_id }, transaction }) : [];
        Object.assign(normalized, await services.values({ payload: contextPayload, previous: plain(row), primary, appointments: contextAppointments, patientId: Number(row.patient_id), clinicId: Number(row.clinic_id), actorId, transaction }));
      }
    }
    Object.assign(normalized, await materialValues(payload, row, actorId, transaction));
    if (!legacy) {
      if (normalized.professional_id !== undefined && normalized.professional_id !== Number(row.professional_id)) await validateProfessional(normalized.professional_id, Number(row.clinic_id), transaction);
      const selected = await templateValues(payload, Number(row.clinic_id), transaction, plain(row));
      Object.assign(normalized, selected, narrativeValues(normalized, plain(row), selected.template_snapshot));
    } else Object.assign(normalized, narrativeValues(normalized, plain(row), undefined));
    if (!legacy && !C.has(payload, 'template_ref') && normalized.template_key && row.template_snapshot
      && row.template_snapshot.area_key !== normalized.template_key) normalized.template_snapshot = null;
    if(C.has(payload,'form_data')||mode==='finalize')normalized.form_data=await forms.normalize({input:payload.form_data,previous:row.form_data,row:{...plain(row),...normalized},transaction,final:mode==='finalize'});
    const combined = { ...plain(row), ...normalized };
    if (mode === 'finalize' && !C.TEXT_FIELDS.filter(key => key !== 'private_notes').some(key => combined[key])
      && !Object.entries(C.richDocument(combined).sections).some(([key, value]) => C.CUSTOM_SECTION_KEY.test(key) && C.documentText(value).trim())
      && !combined.material_refs?.length&&!combined.diagnoses?.length&&!F.hasContent(combined.form_data)) {
      throw C.error(400, 'clinical_report_empty', 'Añade contenido clínico o material de esta consulta antes de cerrar el episodio.');
    }
    if(C.has(payload,'clinical_reference_update'))normalized.form_data=await forms.applyReference({input:payload.clinical_reference_update,data:combined.form_data,row,actorId,transaction,idempotencyKey:key});
    await row.update({ ...normalized, status: mode === 'finalize' ? 'final' : 'draft', version_number: Number(row.version_number) + 1,
      finalized_at: mode === 'finalize' ? now() : null, finalized_by: mode === 'finalize' ? actorId : null, updated_by: actorId }, { transaction });
    if (ids && JSON.stringify(oldIds) !== JSON.stringify(ids)) await replaceLinks(row, ids, actorId, transaction);
    await revision(row, actorId, mode === 'finalize' ? 'finalized' : mode === 'reopen' ? 'reopened' : 'edited', transaction,
      key ? { mutation_key: C.hash(key), request_hash: requestHash } : {});
    return { item: (await hydrate([row], transaction))[0], replayed: false };
  }

  async function saveInTransaction({id,clinicId,actorId,payload,mode='save',transaction}){
    if(!transaction)throw Error('clinical_episode_transaction_required');
    const current=await scopedRow(id,clinicId,transaction);
    await patientInClinic(String(current.patient_id),Number(current.clinic_id),transaction,true);
    return updateRow({row:await scopedRow(id,clinicId,transaction,true),actorId,payload,mode,transaction});
  }
  async function save({ id, clinicId, actorId, payload, mode = 'save' }) {
    if (!['save', 'finalize', 'reopen'].includes(mode)) throw C.error(400, 'clinical_episode_invalid_action', 'La acción no es válida.');
    C.integer(actorId, 'actor_id'); requireExpectedVersion(payload);
    return db.sequelize.transaction(async transaction => {
      return saveInTransaction({id,clinicId,actorId,payload,mode,transaction});
    });
  }

  async function revisions({ id, clinicId, query = {} }) {
    const row = await scopedRow(id, clinicId), limit = query.limit === undefined ? 25 : C.integer(query.limit, 'limit');
    if (limit > 100) throw C.error(400, 'clinical_episode_invalid_limit', 'Solicita como máximo 100 versiones.');
    const cursor = C.decodeCursor(query.cursor), filter = { report_id: row.id };
    if (cursor) {
      if (cursor.episode !== row.public_id) throw C.error(400, 'clinical_episode_invalid_cursor', 'La página no corresponde a este episodio.');
      filter.version_number = { [Op.lt]: C.integer(cursor.version, 'cursor') };
    }
    const rows = await Revision.findAll({ where: filter, order: [['version_number', 'DESC']], limit: limit + 1 });
    const page = rows.slice(0, limit);
    const authorIds = [...new Set(page.map(row => Number(row.actor_id)).filter(Boolean))];
    const authors = authorIds.length && db.Usuario ? await db.Usuario.findAll({ where: { id_usuario: { [Op.in]: authorIds } }, attributes: ['id_usuario', 'nombre', 'apellidos'] }) : [];
    const authorNames = new Map(authors.map(user => [Number(user.id_usuario), [user.nombre, user.apellidos].filter(Boolean).join(' ').trim() || null]));
    return { items: page.map(revision => ({ version: Number(revision.version_number), status: revision.status,
      change_type: revision.change_type, actor_id: revision.actor_id ? Number(revision.actor_id) : null,
      actor_name: authorNames.get(Number(revision.actor_id)) || null,
      created_at: revision.created_at, snapshot: revision.snapshot })), next_cursor: rows.length > limit
      ? C.encodeCursor({ episode: row.public_id, version: Number(page[page.length - 1].version_number) }) : null };
  }

  // Compatibility surface for agenda clients. It reads/writes the same row,
  // including secondary appointments, and never copies historical narratives.
  async function getLegacy({ appointmentId }) {
    const appointment = await loadAppointment(appointmentId), row = await findForAppointment(appointment);
    await patientInClinic(String(appointment.paciente_id), Number(appointment.clinica_id));
    if (row) return (await hydrate([row]))[0];
    return { id: null, clinic_id: Number(appointment.clinica_id), patient_id: Number(appointment.paciente_id),
      appointment_id: Number(appointment.id_cita), appointment_ids: [Number(appointment.id_cita)], appointments: [],
      treatment_id: appointment.tratamiento_id ? Number(appointment.tratamiento_id) : null,
      professional_id: appointment.doctor_id ? Number(appointment.doctor_id) : null,
      treatment_name: appointment.titulo || null, appointment_start: appointment.inicio, appointment_end: appointment.fin,
      appointment_status: appointment.estado, title: appointment.titulo || 'Episodio clínico', occurred_at: appointment.inicio,
      template_key: 'general', rich_document: C.richDocument({ reason: appointment.motivo }), material_refs: [], status: 'draft', version: 0,
      ...Object.fromEntries(C.TEXT_FIELDS.map(key => [key, key === 'reason' ? appointment.motivo || null : null])),
      finalized_at: null, created_at: null, updated_at: null };
  }

  async function saveLegacy({ appointmentId, actorId, payload, finalize = false }) {
    requireExpectedVersion(payload);
    return db.sequelize.transaction(async transaction => {
      const current = await loadAppointment(appointmentId, transaction);
      await patientInClinic(String(current.paciente_id), Number(current.clinica_id), transaction, true);
      const appointment = await loadAppointment(appointmentId, transaction, true);
      let row = await findForAppointment(appointment, transaction, true);
      if (row) return (await updateRow({ row, actorId, payload, mode: finalize ? 'finalize' : payload.reopen ? 'reopen' : 'save', transaction, legacy: true })).item;
      assertCurrentVersion(requireExpectedVersion(payload), null);
      confirmFutureAppointments([appointment], payload);
      const values = C.normalizePatch(payload, {}, { legacy: true });
      Object.assign(values, narrativeValues(values, {}, undefined));
      if (!C.TEXT_FIELDS.some(key => values[key])) throw C.error(400, 'clinical_report_empty', 'Añade al menos un dato clínico al informe.');
      if (finalize && !C.TEXT_FIELDS.filter(key => key !== 'private_notes').some(key => values[key])) throw C.error(400, 'clinical_report_empty', 'Añade contenido clínico antes de cerrar el informe.');
      row = await Report.create({ public_id: crypto.randomUUID(), clinic_id: appointment.clinica_id, patient_id: appointment.paciente_id,
        appointment_id: appointment.id_cita, treatment_id: appointment.tratamiento_id || null, professional_id: appointment.doctor_id || actorId,
        ...values, status: finalize ? 'final' : 'draft', version_number: 1,
        finalized_at: finalize ? now() : null, finalized_by: finalize ? actorId : null, created_by: actorId, updated_by: actorId }, { transaction });
      await replaceLinks(row, [Number(appointment.id_cita)], actorId, transaction);
      await revision(row, actorId, 'created', transaction);
      return (await hydrate([row], transaction))[0];
    });
  }

  async function listLegacy({ patientIdentifier, clinicId }) {
    const patient = await patientInClinic(patientIdentifier, C.integer(clinicId, 'clinic_id'));
    const rows = await Report.findAll({ where: { clinic_id: Number(clinicId), patient_id: patient.id_paciente }, order: [['updated_at', 'DESC'], ['id', 'DESC']] });
    return hydrate(rows);
  }
  return { get, getForAppointment, list, create, save, saveInTransaction, revisions, professionals, treatmentOptions: services.treatmentOptions, getLegacy, saveLegacy, listLegacy };
}

const lazy = () => createClinicalEpisodeService({ db: require('../../models') });
module.exports = { createClinicalEpisodeService, ...Object.fromEntries(['get', 'getForAppointment', 'list', 'create', 'save', 'revisions', 'professionals', 'treatmentOptions', 'getLegacy', 'saveLegacy', 'listLegacy']
  .map(name => [name, (...args) => lazy()[name](...args)])) };
