'use strict';
const { randomUUID } = require('node:crypto');
const { resolveClinicTimezone, formatDateLocal } = require('../lib/availability-calendar');
const { bookingError, requireOperationalProfile, loadScopedTreatment } = require('./treatmentBookingProfile.service');
const json = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const closed = row => ['cancelada', 'no_asistio', 'completada'].includes(row.estado);
const fail = (code, message, details) => { throw bookingError(code, message, details, 409); };
function combinada(row) { return (json(row.import_metadata).booking?.profile?.phases?.length || 0) > 1; }
function eligible(row) { return !!row.paciente_id && !closed(row) && !combinada(row)
  && !row.voucher_id && !json(row.import_metadata).program_session && !row.care_started_at
  && !json(row.import_metadata).clinical_component_parent && !json(row.import_metadata).clinical_component_children; }
async function optional(read) {
  try { return await read(); } catch (error) {
    // Closed before the additive migration is installed. Never mask any other
    // SQL/runtime error or silently continue after a partially installed schema.
    if (error.original?.code === 'ER_NO_SUCH_TABLE') return null;
    throw error;
  }
}
async function membership(db, id, transaction) {
  if (!db.AppointmentPatientLinkMember) return null;
  return optional(() => db.AppointmentPatientLinkMember.findByPk(Number(id), { transaction }));
}
async function load(db, id, transaction, lock = false) {
  const member = await membership(db, id, transaction);
  if (!member) return null;
  const link = await db.AppointmentPatientLink.findByPk(member.link_id, { transaction });
  if (!link) throw new Error('patient_link_owner_missing');
  const members = await db.AppointmentPatientLinkMember.findAll({ where: { link_id: link.id }, transaction });
  const ids = members.map(row => Number(row.appointment_id)).sort((a, b) => a - b);
  const rows = [];
  for (const memberId of ids) rows.push(await db.CitaPaciente.findByPk(memberId, {
    transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) }));
  if (rows.some(row => !row || Number(row.clinica_id) !== Number(link.clinic_id) || Number(row.paciente_id) !== Number(link.patient_id))
    || !ids.includes(Number(link.owner_appointment_id))) throw new Error('patient_link_scope_invalid');
  if (lock) {
    await link.reload({ transaction, lock: transaction.LOCK.UPDATE });
    const current = await db.AppointmentPatientLinkMember.findAll({ where: { link_id: link.id }, transaction });
    if (current.length !== ids.length || current.some(row => !ids.includes(Number(row.appointment_id)))) fail('appointment_link_changed', 'La unión ha cambiado. Actualiza la agenda.');
  }
  return { link, rows: rows.sort((a, b) => +new Date(a.inicio) - +new Date(b.inicio) || a.id_cita - b.id_cita) };
}
async function follower(db, id, transaction) {
  const member = await membership(db, id, transaction);
  if (!member) return false;
  const link = await db.AppointmentPatientLink.findByPk(member.link_id, { transaction });
  if (!link) throw new Error('patient_link_owner_missing');
  return Number(link.owner_appointment_id) !== Number(id);
}
async function choiceRequired(db, values, clinic, choice, transaction) {
  if (!values.paciente_id || values.estado === 'completada') return;
  const zone = resolveClinicTimezone(clinic), day = formatDateLocal(new Date(values.inicio), zone);
  const rows = await db.CitaPaciente.findAll({ where: { clinica_id: values.clinica_id, paciente_id: values.paciente_id,
    inicio: { [db.Sequelize.Op.between]: [new Date(+new Date(values.inicio) - 86400000), new Date(+new Date(values.inicio) + 86400000)] } },
    transaction, include: [{ model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['nombre'] }] });
  const matches = rows.filter(row => !closed(row) && formatDateLocal(new Date(row.inicio), zone) === day);
  if (!matches.length || choice?.mode === 'separate' || choice?.mode === 'link') return;
  const canLinkNew = !combinada(values) && !values.voucher_id && !values.patient_link_combined;
  fail('appointment_same_day_choice_required', 'Este paciente ya tiene una cita hoy. ¿Quieres enviarle también aviso de esta cita o vincularla a la primera?', {
    appointments: matches.map(row => ({ id: row.id_cita, start_at: row.inicio, end_at: row.fin,
      treatment: row.tratamiento?.nombre || row.motivo || 'Cita', can_link: canLinkNew && eligible(row) && new Date(row.inicio) <= new Date(values.inicio),
      updated_at: row.updated_at })),
  });
}
async function linkAtBirth(db, appointment, choice, actorId, transaction) {
  if (choice?.mode !== 'link') return;
  const id = Number(choice.appointment_id);
  if (!Number.isSafeInteger(id) || id < 1 || id === Number(appointment.id_cita)) fail('appointment_link_invalid', 'Elige la cita que inicia la unión.');
  const previous = await db.CitaPaciente.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!previous || Number(previous.clinica_id) !== Number(appointment.clinica_id) || Number(previous.paciente_id) !== Number(appointment.paciente_id)
    || !eligible(previous) || !eligible(appointment) || new Date(previous.inicio) > new Date(appointment.inicio)) {
    fail('appointment_link_invalid', 'Sólo puedes vincular citas individuales abiertas del mismo paciente y clínica. Los pasos de una combinada son inseparables.');
  }
  if (!choice.updated_at || +new Date(choice.updated_at) !== +new Date(previous.updated_at)) fail('appointment_link_changed', 'La primera cita ha cambiado. Actualiza la agenda antes de vincular.');
  const clinic = await db.Clinica.findByPk(appointment.clinica_id, { transaction });
  const zone = resolveClinicTimezone(clinic);
  if (formatDateLocal(new Date(previous.inicio), zone) !== formatDateLocal(new Date(appointment.inicio), zone)) fail('appointment_link_day_invalid', 'Las citas deben ser del mismo día.');
  let group = await load(db, id, transaction, true);
  if (group?.rows.length >= 10) fail('appointment_link_limit', 'Esta unión ya tiene diez citas.');
  if (group?.rows.some(row => !eligible(row))) fail('appointment_link_closed', 'Revisa la unión: ya contiene una cita iniciada o cerrada.');
  const link = group?.link || await db.AppointmentPatientLink.create({ id: randomUUID(), clinic_id: appointment.clinica_id,
    patient_id: appointment.paciente_id, owner_appointment_id: previous.id_cita, created_by: actorId }, { transaction });
  if (!group) await db.AppointmentPatientLinkMember.create({ appointment_id: previous.id_cita, link_id: link.id }, { transaction });
  await db.AppointmentPatientLinkMember.create({ appointment_id: appointment.id_cita, link_id: link.id }, { transaction });
  if (group) await link.update({ revision: link.revision + 1 }, { transaction });
  const owner = group ? group.rows.find(row => Number(row.id_cita) === Number(link.owner_appointment_id)) : previous;
  if (['info_confirmada', 'recordatorio_confirmado'].includes(owner.estado)) await appointment.update({ estado: owner.estado }, { transaction });
}
async function decorate(db, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const ids = list.filter(Boolean).map(row => Number(row.id_cita));
  if (!ids.length || !db.AppointmentPatientLinkMember) return rows;
  const members = await optional(() => db.AppointmentPatientLinkMember.findAll({ where: { appointment_id: { [db.Sequelize.Op.in]: ids } } }));
  if (!members?.length) return rows;
  const groups = new Map();
  for (const member of members) {
    if (!groups.has(member.link_id)) groups.set(member.link_id, await load(db, member.appointment_id));
  }
  for (const row of list.filter(Boolean)) {
    const member = members.find(item => Number(item.appointment_id) === Number(row.id_cita));
    if (!member) continue;
    const group = groups.get(member.link_id);
    const projection = { id: group.link.id, owner_appointment_id: group.link.owner_appointment_id,
      revision: group.link.revision, index: group.rows.findIndex(item => Number(item.id_cita) === Number(row.id_cita)) + 1,
      count: group.rows.length, can_unlink: group.rows.every(eligible), members: group.rows.map(item => ({ appointment_id: item.id_cita,
        start_at: item.inicio, end_at: item.fin, doctor_id: item.doctor_id, installation_id: item.instalacion_id })) };
    if (row.setDataValue) row.setDataValue('appointment_link', projection); else row.appointment_link = projection;
  }
  return rows;
}
async function confirmTogether(db, appointment, status, transaction, actorId) {
  if (!['info_confirmada', 'recordatorio_confirmado', 'cancelada', 'cambio_solicitado'].includes(status)) return [];
  const group = await load(db, appointment.id_cita, transaction, true);
  if (!group || (!['cancelada', 'cambio_solicitado'].includes(status)
    && Number(group.link.owner_appointment_id) !== Number(appointment.id_cita))) return [];
  if (['cancelada', 'cambio_solicitado'].includes(status) && group.rows.some(row => row.care_started_at || row.estado === 'completada')) {
    fail('appointment_link_care_started', 'No se ha cambiado ninguna cita: una cita de esta unión ya se ha iniciado o realizado. Revisa la unión antes de cancelarla.');
  }
  const changed = [];
  for (const row of group.rows) {
    if (Number(row.id_cita) === Number(appointment.id_cita) || closed(row) || row.care_started_at || row.estado === status) continue;
    const previous = row.estado;
    const updated = await require('./appointmentBookingCommand.service').mutateAppointmentBooking({ db, transaction,
      existingAppointmentId: row.id_cita, appointmentValues: { estado: status, updated_by: actorId || null }, stateOnly: true, allowObsolete: true,
      persist: ({ values, existing }) => existing.update(values, { transaction }) });
    await require('./appointmentActivity.service').recordAppointmentStatusChange({ appointment: updated, previousStatus: previous,
      newStatus: status, actorUserId: actorId || null, source: 'agenda', metadata: { appointment_link_id: group.link.id,
        confirmation_owner_id: appointment.id_cita }, transaction });
    changed.push(updated);
  }
  return changed;
}
async function unlink(db, id, actorId) {
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const group = await load(db, id, transaction, true);
    if (!group) fail('appointment_link_missing', 'Esta cita no está vinculada a otra cita individual.');
    if (group.rows.some(row => combinada(row) || row.care_started_at || closed(row))) fail('appointment_link_closed', 'No se pueden separar citas iniciadas, cerradas ni pasos de un tratamiento combinado.');
    // The whole union is dissolved explicitly. No historical message is changed
    // or replayed; future scheduling is re-evaluated after commit by the caller.
    await db.AppointmentPatientLinkMember.destroy({ where: { link_id: group.link.id }, transaction });
    await db.AppointmentPatientLink.destroy({ where: { id: group.link.id }, transaction });
    for (const row of group.rows) await require('./appointmentActivity.service').recordAppointmentStatusChange({ appointment: row,
      previousStatus: row.estado, newStatus: row.estado, actorUserId: actorId, source: 'agenda', recordUnchanged: true,
      metadata: { action: 'appointments_unlinked', appointment_link_id: group.link.id }, transaction });
    return group.rows;
  });
}
async function moveTogether(db, selectedId, changes, options) {
  if (!await membership(db, selectedId)) return null;
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const group = await load(db, selectedId, transaction, true);
    if (!group || group.rows.some(row => !eligible(row))) fail('appointment_link_closed', 'No se ha movido ninguna cita: revisa las citas iniciadas o cerradas de la unión.');
    const selected = group.rows.find(row => Number(row.id_cita) === Number(selectedId));
    const delta = +new Date(changes.inicio) - +new Date(selected.inicio);
    if (!Number.isFinite(delta) || +new Date(changes.fin) - +new Date(changes.inicio) !== +new Date(selected.fin) - +new Date(selected.inicio)) fail('appointment_link_duration_locked', 'Mueve la unión conservando la duración de sus citas. Para cambiarla, desvincula primero.');
    const clinic = await db.Clinica.findByPk(group.link.clinic_id, { transaction });
    const profiles = [];
    for (const row of group.rows) {
      let profile = json(row.import_metadata).booking?.profile;
      if (!profile) {
        const treatment = await loadScopedTreatment({ db, treatmentId: row.tratamiento_id, clinic, transaction });
        profile = requireOperationalProfile(treatment, { allowObsolete: true });
      }
      profile ||= { version: 1, phases: [{ key: 'appointment', duration_minutes: (+new Date(row.fin) - +new Date(row.inicio)) / 60000,
        installation_ids: [Number(row.instalacion_id)], professionals: { mode: 'any', ids: [Number(row.doctor_id)] } }] };
      profiles.push(profile);
    }
    // Manual legacy reservations can change their primary room/professional.
    const selectedIndex = group.rows.indexOf(selected);
    if (!json(selected.import_metadata).booking?.profile) {
      if (changes.doctor_id != null) profiles[selectedIndex].phases[0].professionals.ids = [Number(changes.doctor_id)];
      if (changes.instalacion_id != null) profiles[selectedIndex].phases[0].installation_ids = [Number(changes.instalacion_id)];
    }
    const union = { version: Math.max(...profiles.map(profile => profile.version || 1)), phases: profiles.flatMap(profile => profile.phases) };
    // Lock all resources before any update; failures roll the entire move back.
    const { lockBookingResources, mutateAppointmentBooking } = require('./appointmentBookingCommand.service');
    const { resolveInstallationKeys, loadBookingContext } = require('./appointmentBookingAvailability.service');
    const ids = [...new Set(union.phases.flatMap(phase => phase.installation_ids))];
    const mapping = await resolveInstallationKeys({ db, clinic, installationIds: ids, transaction, enabled: true });
    const support = [...new Set(group.rows.flatMap(row => json(row.import_metadata).additional_staff?.ids || []))];
    const keys = [`patient:${group.link.patient_id}`, ...union.phases.flatMap(phase => phase.professionals.ids.map(id => `doctor:${id}`)),
      ...support.map(id => `doctor:${id}`), ...ids.map(id => mapping.keys.get(Number(id))),
      ...require('../lib/booking-equipment').equipmentIds(union).map(id => `equipment:${id}`)];
    if (new Set(keys).size > 100) fail('appointment_link_resource_limit', 'Esta unión utiliza demasiados recursos. Desvincula algunas citas antes de moverla.');
    await lockBookingResources({ db, resourceKeys: keys, transaction });
    const result = [], moved = new Set();
    for (let index = 0; index < group.rows.length; index++) {
      const row = group.rows[index], start = new Date(+new Date(row.inicio) + delta), end = new Date(+new Date(row.fin) + delta);
      const currentChanges = { inicio: start, fin: end, estado: changes.estado, reschedule_reason: changes.reschedule_reason,
        updated_by: changes.updated_by, ...(Number(row.id_cita) === Number(selectedId) ? changes : {}) };
      const context = await loadBookingContext({ db, clinic, profile: profiles[index], start, end, transaction,
        occupancyEnabled: true, patientId: group.link.patient_id, additionalStaffIds: support,
        ignoreAppointmentIds: group.rows.filter(item => !moved.has(Number(item.id_cita))).map(item => Number(item.id_cita)),
        inheritEquipmentAttention: false });
      require('./appointmentBookingCommand.service').registerPatientLinkContext(context);
      const updated = await mutateAppointmentBooking({ db, transaction, existingAppointmentId: row.id_cita,
        appointmentValues: currentChanges, preparedContext: context, allowObsolete: true,
        priorityAcknowledged: options.priorityAcknowledged, force: options.force,
        ...(Number(row.id_cita) === Number(selectedId) ? { selections: options.selections || {}, additionalStaffIds: options.additionalStaffIds } : {}),
        reschedulePatientOverlap: options.reschedulePatientOverlap,
        persist: ({ values, existing }) => existing.update(values, { transaction }) });
      result.push(updated); moved.add(Number(row.id_cita));
      await require('./appointmentActivity.service').recordAppointmentStatusChange({ appointment: updated, previousStatus: row.estado,
        newStatus: updated.estado, actorUserId: changes.updated_by, source: 'agenda', recordUnchanged: true,
        metadata: { action: 'linked_appointments_rescheduled', appointment_link_id: group.link.id }, transaction });
    }
    await group.link.update({ revision: group.link.revision + 1 }, { transaction });
    return { ownerId: Number(group.link.owner_appointment_id), selected: result.find(row => Number(row.id_cita) === Number(selectedId)), rows: result };
  });
}
async function ignoreLinkedIds(db, id, clinicId) {
  if (!id) return [];
  const group = await load(db, Number(id));
  if (!group || Number(group.link.clinic_id) !== Number(clinicId)) return [];
  return group.rows.map(row => Number(row.id_cita));
}
module.exports = { membership, load, follower, eligible, combinada, choiceRequired, linkAtBirth, decorate, confirmTogether, unlink, moveTogether, ignoreLinkedIds };
