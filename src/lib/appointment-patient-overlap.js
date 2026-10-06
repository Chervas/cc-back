'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const { formatLocal } = require('./availability-calendar');

function intersects(row, start, end) {
  return new Date(row.start) < end && new Date(row.end) > start;
}

function conflictsForPatient(rows, { start, end, appointmentId }) {
  const seen = new Set();
  return (rows || []).filter(row => {
    if (Number(row.appointment_id) === Number(appointmentId) || row.estado === 'cancelada' || !intersects(row, start, end)) return false;
    const key = row.appointment_id == null ? `${row.start}/${row.end}` : String(row.appointment_id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => +new Date(a.start) - +new Date(b.start) || Number(a.appointment_id) - Number(b.appointment_id));
}

function sourceIsProtected(row) {
  return row.source_system === 'treatment_program' || !!row.voucher_id || !!row.es_provisional
    || row.booking_nonshareable !== 0 && row.booking_nonshareable !== false
    || row.patient_overlap_protected !== 0 && row.patient_overlap_protected !== false;
}

/** Pure, bounded decision over the authoritative read made under patient locks. */
function patientOverlapDecision({ rows, previous, values, solution, timeZone, doctorNames = new Map(), reschedule = null, eligible = false, resourceContext = [] }) {
  const start = new Date(values.inicio), end = new Date(values.fin);
  const conflicts = conflictsForPatient(rows, { start, end, appointmentId: previous.id_cita });
  if (!conflicts.length) return null;
  const scoped = conflicts.filter(row => Number(row.clinic_id) === Number(values.clinica_id));
  const foreign = scoped.length !== conflicts.length;
  const canConfirm = !foreign && eligible && Number.isSafeInteger(reschedule?.actorId) && reschedule.actorId > 0
    && reschedule.actorId === Number(values.updated_by) && scoped.every(row => Number.isSafeInteger(row.appointment_id)
      && row.appointment_id > 0 && !sourceIsProtected(row));
  const details = scoped.map(row => {
    const first = formatLocal(new Date(row.start), timeZone), last = formatLocal(new Date(row.end), timeZone);
    return { appointment_id: row.appointment_id, doctor_id: row.doctor_id || null,
      doctor_name: String(doctorNames.get(Number(row.doctor_id)) || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160) || null,
      start_at: new Date(row.start).toISOString(), end_at: new Date(row.end).toISOString(),
      date_local: first.slice(0, 10), start_local: first.slice(11, 16), end_local: last.slice(11, 16),
      overlap_minutes: Math.ceil((Math.min(+end, +new Date(row.end)) - Math.max(+start, +new Date(row.start))) / 60000) };
  });
  let acknowledgement = null;
  if (canConfirm) {
    // A confirmation is a receipt for this exact proposal and conflict set,
    // not a general force flag. A concurrent/new appointment needs a new dialog.
    acknowledgement = createHash('sha256').update(JSON.stringify({ version: 1,
      actor: reschedule.actorId, appointment: Number(previous.id_cita), clinic: Number(values.clinica_id), patient: Number(values.paciente_id),
      previous_range: [new Date(previous.inicio).toISOString(), new Date(previous.fin).toISOString()],
      previous_identity: [previous.doctor_id, previous.instalacion_id, previous.tratamiento_id, previous.estado,
        previous.updated_at ? new Date(previous.updated_at).toISOString() : null],
      range: [start.toISOString(), end.toISOString()], doctor: Number(values.doctor_id), installation: Number(values.instalacion_id),
      reason: values.reschedule_reason || null, status: values.estado, resource_context: resourceContext,
      phases: solution.phases.map(phase => [phase.key, phase.installation_id, phase.doctor_ids,
        phase.start_at, phase.end_at, phase.equipment || [], phase.staff_intervals || []]),
      conflicts: scoped.map(row => [row.appointment_id, row.doctor_id, new Date(row.start).toISOString(), new Date(row.end).toISOString()]),
    })).digest('hex');
  }
  const supplied = reschedule?.acknowledgement;
  const confirmed = !!acknowledgement && typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied)
    && timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(acknowledgement, 'hex'));
  // No foreign appointment IDs, staff names, clinic names or times in payload.
  const message = foreign ? 'El paciente ya tiene otra cita en ese horario. Revisa sus citas antes de reprogramar.'
    : details.map(row => {
      const [year, month, day] = row.date_local.split('-');
      return `El paciente ya tiene otra cita${row.doctor_name ? ` con ${row.doctor_name}` : ''} el ${day}/${month}/${year} de ${row.start_local} a ${row.end_local}. Se solapa ${row.overlap_minutes} ${row.overlap_minutes === 1 ? 'minuto' : 'minutos'} con este cambio.`;
    }).join('\n') + (canConfirm ? '' : ' Revisa sus citas antes de reprogramar.');
  return { confirmed, message, can_force: false, can_confirm_patient_overlap: canConfirm,
    patient_overlap_acknowledgement: acknowledgement, patient_conflicts: foreign ? [] : details };
}

module.exports = { conflictsForPatient, patientOverlapDecision };
