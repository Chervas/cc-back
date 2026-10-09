'use strict';
const { randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { resolveClinicTimezone, formatDateLocal } = require('../lib/availability-calendar');
const { bookingError, requireOperationalProfile, loadScopedTreatment } = require('./treatmentBookingProfile.service');
const json = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const { hasAttendedAppointment } = require('../lib/status-catalog');
const closed = row => ['cancelada', 'no_asistio', 'completada'].includes(row.estado);
const fail = (code, message, details) => { throw bookingError(code, message, details, 409); };
function combinada(row) { return (json(row.import_metadata).booking?.profile?.phases?.length || 0) > 1; }
function eligible(row) { return !!row.paciente_id && !closed(row) && !hasAttendedAppointment(row) && !combinada(row)
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
  if (!values.paciente_id || hasAttendedAppointment(values)) return;
  const zone = resolveClinicTimezone(clinic), day = formatDateLocal(new Date(values.inicio), zone);
  const rows = await db.CitaPaciente.findAll({ where: { clinica_id: values.clinica_id, paciente_id: values.paciente_id,
    inicio: { [db.Sequelize.Op.between]: [new Date(+new Date(values.inicio) - 86400000), new Date(+new Date(values.inicio) + 86400000)] } },
    transaction, include: [{ model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['nombre'] }] });
  const matches = rows.filter(row => !closed(row) && !hasAttendedAppointment(row) && formatDateLocal(new Date(row.inicio), zone) === day);
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
  if (['cancelada', 'cambio_solicitado'].includes(status) && group.rows.some(row => row.care_started_at || hasAttendedAppointment(row))) {
    fail('appointment_link_care_started', 'No se ha cambiado ninguna cita: una cita de esta unión ya se ha iniciado o realizado. Revisa la unión antes de cancelarla.');
  }
  const changed = [];
  for (const row of group.rows) {
    if (Number(row.id_cita) === Number(appointment.id_cita) || closed(row) || hasAttendedAppointment(row) || row.care_started_at || row.estado === status) continue;
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
    if (group.rows.some(row => combinada(row) || row.care_started_at || hasAttendedAppointment(row) || closed(row))) fail('appointment_link_closed', 'No se pueden separar citas iniciadas, cerradas ni pasos de un tratamiento combinado.');
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
async function resolveRequestTogether(db, appointment, action, nextStatus, transaction, actorId) {
  if (action === 'cancel') return confirmTogether(db, appointment, 'cancelada', transaction, actorId);
  const group = await load(db, appointment.id_cita, transaction, true);
  if (!group) return [];
  const events = db.PatientOperationalEvent ? await db.PatientOperationalEvent.findAll({ where: {
    clinic_id: group.link.clinic_id, patient_id: group.link.patient_id, event_type: 'appointment.status_changed' },
    order: [['occurred_at', 'DESC'], ['id', 'DESC']], limit: 100, transaction, raw: true }) : [];
  const changed = [];
  for (const row of group.rows) {
    if (row.id_cita === appointment.id_cita || row.estado !== 'cambio_solicitado') continue;
    const prior = events.find(event => Number(json(event.metadata).appointment_id) === Number(row.id_cita)
      && json(event.metadata).new_status === 'cambio_solicitado');
    const status = json(prior?.metadata).previous_status || nextStatus;
    const saved = await require('./appointmentBookingCommand.service').mutateAppointmentBooking({ db, transaction,
      existingAppointmentId: row.id_cita, appointmentValues: { estado: status, updated_by: actorId }, stateOnly: true, allowObsolete: true,
      persist: ({ values, existing }) => existing.update(values, { transaction }) });
    await require('./appointmentActivity.service').recordAppointmentStatusChange({ appointment: saved,
      previousStatus: 'cambio_solicitado', newStatus: status, actorUserId: actorId, source: 'agenda',
      metadata: { appointment_link_id: group.link.id, resolution: action }, transaction });
    changed.push(saved);
  }
  return changed;
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
    const profiles = [], treatments = [];
    for (const row of group.rows) {
      const treatment = await loadScopedTreatment({ db, treatmentId: row.tratamiento_id, clinic, transaction });
      treatments.push(treatment);
      let profile = json(row.import_metadata).booking_restriction_confirmation?.original_profile || json(row.import_metadata).booking?.profile;
      if (!profile) {
        profile = requireOperationalProfile(treatment, { allowObsolete: true });
      }
      profile ||= { version: 1, phases: [{ key: 'appointment', duration_minutes: (+new Date(row.fin) - +new Date(row.inicio)) / 60000,
        installation_ids: row.instalacion_id ? [Number(row.instalacion_id)] : [], professionals: { mode: 'any', ids: [Number(row.doctor_id)] } }] };
      profiles.push(profile);
    }
    // Manual legacy reservations can change their primary room/professional.
    const selectedIndex = group.rows.indexOf(selected);
    if (!json(selected.import_metadata).booking?.profile) {
      if (changes.doctor_id != null) profiles[selectedIndex].phases[0].professionals.ids = [Number(changes.doctor_id)];
      if (changes.instalacion_id != null) profiles[selectedIndex].phases[0].installation_ids = [Number(changes.instalacion_id)];
    }
    const manual = options.restrictionConfirmation?.actorId === Number(changes.updated_by)
      && Number.isSafeInteger(options.restrictionConfirmation?.actorId) && options.restrictionConfirmation.actorId > 0;
    const { restrictionReadProfile, assessment, restrictionErrorDetails } = require('../lib/booking-restriction-confirmation');
    const choices = profiles.map((profile, index) => {
      const row = group.rows[index], selectedRow = Number(row.id_cita) === Number(selectedId), snapshot = json(row.import_metadata).booking;
      let selections = snapshot?.phases ? Object.fromEntries(snapshot.phases.map(step => [step.key, {
        installation_id: step.installation_id, ...(profile.phases.find(phase => phase.key === step.key)?.professionals.mode === 'any'
          ? { doctor_id: step.doctor_ids[0] } : {}),
      }])) : { [profile.phases[0].key]: { doctor_id: row.doctor_id, installation_id: row.instalacion_id } };
      if (selectedRow && Object.keys(options.selections || {}).length) selections = options.selections;
      else if (selectedRow && profile.phases.length === 1) selections = { [profile.phases[0].key]: {
        ...selections[profile.phases[0].key], ...(changes.doctor_id != null ? { doctor_id: changes.doctor_id } : {}),
        ...(changes.instalacion_id != null ? { installation_id: changes.instalacion_id } : {}),
      } };
      return selections;
    });
    const readProfiles = manual ? profiles.map((profile, index) => restrictionReadProfile(profile, { selections: choices[index] })) : profiles;
    const doctorOnlyProfiles = profiles.map(profile => profile.version === 1 && profile.phases.length === 1
      && profile.phases[0].installation_ids.length === 0 && profile.phases[0].professionals.mode === 'any'
      && profile.phases[0].professionals.ids.length === 1);
    const union = { version: Math.max(...readProfiles.map(profile => profile.version || 1)), phases: readProfiles.flatMap(profile => profile.phases) };
    // Lock all resources before any update; failures roll the entire move back.
    const { lockBookingResources, mutateAppointmentBooking } = require('./appointmentBookingCommand.service');
    const { resolveInstallationKeys, loadBookingContext } = require('./appointmentBookingAvailability.service');
    const ids = [...new Set([...union.phases.flatMap(phase => phase.installation_ids),
      ...group.rows.flatMap(row => [Number(row.instalacion_id), ...((json(row.import_metadata).booking?.phases || []).map(phase => Number(phase.installation_id)))]).filter(id => id > 0)])];
    const mapping = await resolveInstallationKeys({ db, clinic, installationIds: ids, transaction, enabled: true });
    const previousOccupancies = await db.AppointmentBookingOccupancy.findAll({ where: {
      appointment_id: { [db.Sequelize.Op.in]: group.rows.map(row => Number(row.id_cita)) } }, transaction });
    const rowSupports = group.rows.map(row => Number(row.id_cita) === Number(selectedId) && options.additionalStaffIds !== undefined
      ? require('../lib/appointment-additional-staff').normalizeAdditionalStaff(options.additionalStaffIds)
      : json(row.import_metadata).additional_staff?.ids || []);
    const support = [...new Set(rowSupports.flat())];
    const keys = [`patient:${group.link.patient_id}`, ...previousOccupancies.map(row => row.resource_key),
      ...group.rows.flatMap(row => [Number(row.doctor_id), ...(json(row.import_metadata).additional_staff?.ids || [])]).filter(id => id > 0).map(id => `doctor:${id}`),
      ...union.phases.flatMap(phase => phase.professionals.ids.map(id => `doctor:${id}`)),
      ...support.map(id => `doctor:${id}`), ...ids.map(id => mapping.keys.get(Number(id))),
      ...require('../lib/booking-equipment').equipmentIds(union).map(id => `equipment:${id}`)];
    if (new Set(keys).size > 100) fail('appointment_link_resource_limit', 'Esta unión utiliza demasiados recursos. Desvincula algunas citas antes de moverla.');
    await lockBookingResources({ db, resourceKeys: keys, transaction });
    // A single receipt covers ALL independently linked reservations. Rolling
    // back after the first warning must not trap the UI in a per-member loop.
    // Read once per member, under the group's lexical resource locks, and pin
    // both external evidence and the proposed earlier members of this move.
    const prepared = [], virtual = [];
    if (manual) {
      const { occupancyForSolution, solveBookingProfile } = require('../lib/booking-profile-solver');
      for (let index = 0; index < group.rows.length; index++) {
        const row = group.rows[index], start = new Date(+new Date(row.inicio) + delta), end = new Date(+new Date(row.fin) + delta);
        const context = await loadBookingContext({ db, clinic, profile: readProfiles[index], start, end, transaction,
          occupancyEnabled: true, patientId: group.link.patient_id, additionalStaffIds: rowSupports[index],
          ignoreAppointmentIds: group.rows.map(item => Number(item.id_cita)), inheritEquipmentAttention: false, includeDiagnosticLabels: true });
        for (const prior of virtual) {
          for (const occupancy of prior.occupancies) {
            const resource = occupancy.resource_kind === 'doctor' ? context.doctors.get(occupancy.doctor_id)
              : occupancy.resource_kind === 'installation' ? [...context.installations.entries()]
                .find(([id, room]) => (room.resource_key || mapping.keys.get(Number(id))) === occupancy.resource_key)?.[1]
                : context.equipment?.get(Number(occupancy.resource_key.split(':')[1]));
            if (resource) resource.busy.push({ start: occupancy.start_at, end: occupancy.end_at, appointment_id: prior.id,
              diagnostic: { kind: 'appointment', treatment_name: prior.treatmentName } });
          }
          context.patientBusy.push({ start: prior.solution.start_at, end: prior.solution.end_at, appointment_id: prior.id, clinic_id: Number(group.link.clinic_id) });
        }
        const decision = assessment({ profile: profiles[index], context, start, selections: choices[index], additionalStaffIds: rowSupports[index],
          doctorOnly: doctorOnlyProfiles[index],
          canonicalSolution: doctorOnlyProfiles[index] ? null : solveBookingProfile({ profile: profiles[index], ...context, start, selections: choices[index] }),
          clinicId: Number(group.link.clinic_id), clinicName: clinic.nombre_clinica, treatmentId: row.tratamiento_id,
          treatmentName: treatments[index]?.nombre || '', patientId: group.link.patient_id, appointmentId: row.id_cita,
          actorId: options.restrictionConfirmation.actorId, previous: row.toJSON ? row.toJSON() : row });
        prepared.push({ context, decision });
        if (decision.solution) virtual.push({ id: Number(row.id_cita), solution: decision.solution, treatmentName: treatments[index]?.nombre || '',
          occupancies: occupancyForSolution(decision.solution, mapping.keys) });
      }
      const warnings = prepared.filter(item => item.decision.restrictions.length);
      if (warnings.length && prepared.every(item => item.decision.solution && (!item.decision.restrictions.length || item.decision.canConfirm))) {
        const receipt = createHash('sha256').update(JSON.stringify({ schema: 'linked-booking-restrictions/1',
          actor: options.restrictionConfirmation.actorId, group: String(group.link.id), revision: group.link.revision,
          selected: Number(selectedId), delta, members: group.rows.map((row, index) => [Number(row.id_cita), prepared[index].decision.acknowledgement]) })).digest('hex');
        const supplied = options.restrictionConfirmation.acknowledgement;
        if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)
          || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(receipt, 'hex'))) {
          const selectedDecision = prepared[selectedIndex].decision;
          fail('booking_restriction_confirmation_required', 'Las citas vinculadas se moverán juntas. Revisa todas las restricciones y confirma el movimiento completo.', {
            ...restrictionErrorDetails(selectedDecision), can_confirm_restrictions: true, booking_restriction_acknowledgement: receipt,
            booking_restrictions: warnings.flatMap(item => item.decision.restrictions), linked_appointments: group.rows.length,
          });
        }
      }
    }
    const result = [], moved = new Set();
    for (let index = 0; index < group.rows.length; index++) {
      const row = group.rows[index], start = new Date(+new Date(row.inicio) + delta), end = new Date(+new Date(row.fin) + delta);
      const currentChanges = { inicio: start, fin: end, estado: changes.estado, reschedule_reason: changes.reschedule_reason,
        updated_by: changes.updated_by, ...(Number(row.id_cita) === Number(selectedId) ? changes : {}) };
      const context = prepared[index]?.context || await loadBookingContext({ db, clinic, profile: profiles[index], start, end, transaction,
        occupancyEnabled: true, patientId: group.link.patient_id, additionalStaffIds: support,
        ignoreAppointmentIds: group.rows.filter(item => !moved.has(Number(item.id_cita))).map(item => Number(item.id_cita)),
        inheritEquipmentAttention: false });
      require('./appointmentBookingCommand.service').registerPatientLinkContext(context);
      const updated = await mutateAppointmentBooking({ db, transaction, existingAppointmentId: row.id_cita,
        appointmentValues: currentChanges, preparedContext: context, allowObsolete: true,
        priorityAcknowledged: options.priorityAcknowledged, force: options.force,
        ...(manual ? { selections: choices[index], restrictionConfirmation: { actorId: options.restrictionConfirmation.actorId,
          acknowledgement: prepared[index].decision.acknowledgement } } : {}),
        ...(Number(row.id_cita) === Number(selectedId) ? { ...(!manual ? { selections: options.selections || {} } : {}),
          expectedPlanSha256: options.expectedPlanSha256, additionalStaffIds: options.additionalStaffIds } : {}),
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
module.exports = { membership, load, follower, eligible, combinada, choiceRequired, linkAtBirth, decorate, confirmTogether, resolveRequestTogether, unlink, moveTogether, ignoreLinkedIds };
