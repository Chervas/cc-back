'use strict';

async function enqueue({ db, transaction, appointmentId, clinicId, conversationId, messageId }) {
  return require('./jobRequests.service').enqueueJobRequest(
    {
      type: 'lead_assistant_appointment_created',
      origin: 'automation',
      payload: { appointmentId, clinicId, conversationId, messageId },
    },
    { transaction, JobRequestModel: db.JobRequest, sequelizeInstance: db.sequelize }
  );
}

async function dispatch(db, payload, dependencies = {}) {
  const { clinicId, appointmentId, conversationId, messageId } = payload;
  if (![clinicId, appointmentId, conversationId, messageId].every((id) => Number.isSafeInteger(id) && id > 0))
    throw Error('assistant_appointment_event_scope');
  const row = await db.CitaPaciente.findOne({ where: { id_cita: appointmentId, clinica_id: clinicId } });
  const source = row?.import_metadata?.source_quickchat_assistant;
  if (!source || source.confirmation_message_id !== messageId || source.conversation_id !== conversationId)
    return { skipped: 'source_changed' };
  const message = await db.Message.findOne({
    where: { id: messageId, conversation_id: conversationId, direction: 'inbound' },
    attributes: ['metadata'],
    raw: true,
  });
  const receipt = message?.metadata?.assistantAppointment;
  if (receipt?.id !== appointmentId || receipt.clinicId !== clinicId) return { skipped: 'receipt_changed' };
  const original = message.metadata.assistantBooking;
  if (original?.stage !== 'booked' || original.requestKey !== source.request_key)
    return { skipped: 'receipt_changed' };
  const events = dependencies.events || require('./appointmentCreatedEvents.service');
  const refresh =
    dependencies.refresh ||
    ((id, conversation, clinic) =>
      require('./socket.service').emit('message:refresh', { id, conversation_id: conversation }, [
        'clinic:' + clinic,
      ]));
  events.emitAppointmentSocketEvent('appointment:created', row);
  refresh(messageId, conversationId, clinicId);
  if (
    row.estado !== 'pendiente' ||
    +new Date(row.inicio) !== Date.parse(original.slots[original.selected].start)
  )
    return { skipped: 'appointment_changed' };
  const runtime = dependencies.runtime || require('./appointmentAutomationV2Runtime.service');
  const actor = { user_id: row.created_by, user_role: 'system' };
  await runtime.enqueueExecutionForCita(row, { ...actor, event_name: 'appointment_created' });
  if (
    !(await (dependencies.managed || require('./appointmentVisitManaged.service').current()).managedVisit(
      row
    ))
  ) {
    await runtime.syncScheduledTriggersForCita(row, actor);
  }
  await events.prepareConsent(row, actor, 'appointment_created');
  await (dependencies.direction || require('./patientDirection.service')).handleAppointmentChange({
    appointment: row,
    previousStatus: null,
    actorUserId: row.created_by,
  });
  return { processed: true };
}
module.exports = { enqueue, dispatch };
