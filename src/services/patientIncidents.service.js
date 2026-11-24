'use strict';

const { QueryTypes } = require('sequelize');
const { getPhoneLookupCandidates, normalizePhoneDigits } = require('../lib/phone');

const EVENT = 'patient.incident.unwanted';
const BOOKING_STATUSES = ['cancelada', 'no_asistio', 'reprogramada', 'ha_acudido', 'en_atencion', 'completada'];
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const clinicScope = ids => [...new Set(ids.filter(positive).map(Number))];
const liveEvent = event => event?.metadata?.active === true;

function manualExpression(patientSql) {
  return `COALESCE((SELECT JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.active'))
    FROM PatientOperationalEvents e WHERE e.patient_id = ${patientSql} AND e.event_type = '${EVENT}'
    ORDER BY e.id DESC LIMIT 1), 'false') = 'true'`;
}

const appointmentHistoryDate = "CASE WHEN a.estado = 'reprogramada' THEN LEAST(a.inicio, a.updated_at) ELSE a.inicio END";

function appointmentHistorySql(scopeSql) {
  return `FROM CitasPacientes a WHERE (${scopeSql})
    AND COALESCE(a.es_provisional, 0) = 0
    AND NOT EXISTS (SELECT 1 FROM AppointmentVisitMembers avm
      WHERE avm.appointment_id = a.id_cita AND avm.role = 'prp_extraction')
    AND a.estado IN (${BOOKING_STATUSES.map(value => `'${value}'`).join(',')})
    AND ${appointmentHistoryDate} BETWEEN DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 YEAR) AND UTC_TIMESTAMP()
    AND NOT (a.estado = 'reprogramada' AND COALESCE(a.reschedule_reason, '') IN ('clinic_schedule','administrative_error'))
    ORDER BY ${appointmentHistoryDate} DESC, a.id_cita DESC`;
}

function attendanceExpression(clinicIds) {
  const ids = clinicScope(clinicIds);
  if (!ids.length) return 'FALSE';
  const from = appointmentHistorySql(`a.paciente_id = Paciente.id_paciente AND a.clinica_id IN (${ids.join(',')})`);
  const latest = `(SELECT a.estado ${from} LIMIT 1)`;
  const previous = `(SELECT a.estado ${from} LIMIT 1 OFFSET 1)`;
  return `((${latest} = 'cancelada' AND ${previous} = 'cancelada')
    OR (${latest} IN ('no_asistio','reprogramada') AND ${previous} = 'no_asistio'))`;
}

function patientFilter(value, clinicIds) {
  if (!value || value === 'all') return null;
  if (value === 'unwanted') return manualExpression('Paciente.id_paciente');
  if (value === 'attendance') return attendanceExpression(clinicIds);
  throw Object.assign(new Error('Filtro de incidencias inválido'), { status: 400, code: 'patient_incident_filter_invalid' });
}

function attendanceIncident(rows) {
  const [latest, previous] = rows;
  if (!latest || !previous) return null;
  const statuses = [previous.estado, latest.estado];
  const qualifies = statuses[0] === 'cancelada' && statuses[1] === 'cancelada'
    || statuses[0] === 'no_asistio' && ['no_asistio', 'reprogramada'].includes(statuses[1]);
  if (!qualifies) return null;
  const events = [previous, latest].map(row => ({ state: row.estado, date: new Date(row.incident_at || row.inicio).toISOString() }));
  const revision = [previous, latest].map(row => `${row.id_cita}:${row.estado}:${new Date(row.incident_at || row.inicio).getTime()}`).join('|');
  return { label: 'No suele acudir', events, revision };
}

async function attendance({ db, clinicIds, patientId, leadId, transaction }) {
  const ids = clinicScope(clinicIds);
  if (!ids.length || !positive(patientId) && !positive(leadId)) return null;
  const identities = [positive(patientId) ? 'a.paciente_id = :patientId' : '', positive(leadId) ? 'a.lead_intake_id = :leadId' : ''].filter(Boolean);
  const scope = `a.clinica_id IN (:clinicIds) AND (${identities.join(' OR ')})`;
  const rows = await db.sequelize.query(`SELECT a.id_cita, a.estado, ${appointmentHistoryDate} AS incident_at ${appointmentHistorySql(scope)} LIMIT 2`, {
    replacements: { clinicIds: ids, patientId: Number(patientId) || null, leadId: Number(leadId) || null },
    type: QueryTypes.SELECT, transaction,
  });
  return attendanceIncident(rows);
}

async function latestEvent({ db, patientId, transaction }) {
  if (!positive(patientId) || !db.PatientOperationalEvent) return null;
  return db.PatientOperationalEvent.findOne({
    where: { patient_id: patientId, event_type: EVENT },
    order: [['id', 'DESC']], raw: true, transaction,
  });
}

async function summary({ db, patientId, clinicIds, transaction }) {
  const [event, warning] = await Promise.all([
    latestEvent({ db, patientId, transaction }),
    attendance({ db, patientId, clinicIds, transaction }),
  ]);
  const active = liveEvent(event);
  const mayReadReason = active && clinicScope(clinicIds).includes(Number(event.clinic_id));
  let author = null;
  if (mayReadReason && positive(event.actor_user_id)) {
    const actor = await db.Usuario.findByPk(event.actor_user_id, { attributes: ['nombre', 'apellidos'], raw: true, transaction });
    if (actor) author = [actor.nombre, actor.apellidos].filter(Boolean).join(' ');
  }
  return {
    unwanted: active ? {
      ...(mayReadReason ? { reason: event.metadata.reason, occurred_at: event.occurred_at, author,
        review_id: event.metadata.review_id || null } : {}),
      editable_in_clinic: mayReadReason ? event.clinic_id : null,
    } : null,
    attendance: warning,
  };
}

async function setUnwanted({ db, patientId, clinicId, actorId, active, reason, reviewId, transaction }) {
  const current = await latestEvent({ db, patientId, transaction });
  if (liveEvent(current) && Number(current.clinic_id) !== Number(clinicId)) {
    throw Object.assign(new Error('La incidencia se gestiona desde la clínica que la registró.'), { status: 409, code: 'patient_incident_other_clinic' });
  }
  if (active && liveEvent(current) && current.metadata.reason === reason && (current.metadata.review_id || null) === (reviewId || null)) return;
  if (!active && !liveEvent(current)) return;
  await db.PatientOperationalEvent.create({
    patient_id: patientId, clinic_id: clinicId, actor_user_id: actorId,
    event_type: EVENT, source: reviewId ? 'google_reviews' : 'patient_record',
    metadata: { active, ...(active ? { reason, ...(reviewId ? { review_id: reviewId } : {}) } : {}) },
  }, { transaction });
}

async function unwantedRecipient({ db, clinicId, patientId, phone, email, transaction }) {
  if (!db.PatientOperationalEvent || !positive(clinicId)) return false;
  if (positive(patientId) && liveEvent(await latestEvent({ db, patientId, transaction }))) return true;
  const digits = normalizePhoneDigits(phone);
  const candidates = getPhoneLookupCandidates(digits);
  if (digits) candidates.push(`00${digits}`);
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!candidates.length && !address) return false;
  const identities = [
    ...(candidates.length ? ['telefono_movil', 'telefono_secundario'].map(field =>
      `(p.${field} IN (:phones) OR REGEXP_REPLACE(p.${field}, '[^0-9]', '') IN (:phones))`) : []),
    ...(address ? ['LOWER(p.email) = :email'] : []),
  ];
  const rows = await db.sequelize.query(`SELECT p.telefono_movil, p.telefono_secundario, p.email FROM Pacientes p
    WHERE (${identities.join(' OR ')})
      AND (p.clinica_id = :clinicId OR EXISTS (SELECT 1 FROM PacienteClinicas pc
        WHERE pc.paciente_id = p.id_paciente AND pc.clinica_id = :clinicId))
      AND ${manualExpression('p.id_paciente')}`, {
    replacements: { clinicId, phones: candidates, email: address }, type: QueryTypes.SELECT, transaction,
  });
  return rows.some(row => (digits && [row.telefono_movil, row.telefono_secundario].some(value => normalizePhoneDigits(value) === digits))
    || (address && String(row.email || '').trim().toLowerCase() === address));
}

async function assertCommercialAllowed(options) {
  if (!await unwantedRecipient(options)) return;
  throw Object.assign(new Error('El paciente tiene bloqueadas las comunicaciones comerciales.'), {
    code: 'PATIENT_INCIDENT_COMMERCIAL_BLOCK', status: 409, statusCode: 409, retryable: false,
  });
}

module.exports = { patientFilter, attendanceIncident, attendance, summary, setUnwanted, unwantedRecipient, assertCommercialAllowed };
