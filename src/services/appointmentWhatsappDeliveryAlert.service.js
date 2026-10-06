'use strict';

const { createHash } = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { ADMIN_USER_IDS } = require('../config/notifications.config');
const { isTemporaryQuickChatFocusUser } = require('../lib/temporary-quickchat-focus');
const realtime = require('./notificationsRealtime.service');

const KIND = 'appointment_whatsapp_delivery_failed';
const RESOLVED_STATES = new Set(['completada', 'no_asistio', 'cancelada']);
const RECEPTION_SUBROLES = new Set(['Administrativos', 'Recepción / Comercial ventas']);
// Only an explicit recipient-undeliverable answer is a reason to ask reception
// to call. A timeout, pacing/quality hold, or configuration error is NOT proof
// that the patient cannot receive WhatsApp. Expand only with proven semantics.
const RECIPIENT_UNDELIVERABLE_CODES = new Set(['131026']);
const object = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; }
  catch (_) { return {}; }
};
const integer = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const millis = value => value ? new Date(value).getTime() : NaN;
const same = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

function definitiveRecipientFailure(message, status = {}) {
  const metadata = object(message?.metadata);
  const retry = object(metadata.outbound_retry);
  if (message?.status !== 'failed' || retry.retrying === true || retry.reason === 'delivery_unknown'
    || metadata.delivery_unknown === true || metadata.post_acceptance_error) return false;
  const errors = [...(Array.isArray(status.errors) ? status.errors : []),
    ...(Array.isArray(metadata.wa_error) ? metadata.wa_error : []),
    ...(Array.isArray(metadata.wa_status?.errors) ? metadata.wa_status.errors : [])];
  const sendError = object(metadata.error);
  const nested = object(sendError.error?.error || sendError.error);
  if (nested.code) errors.push(nested);
  return errors.some(error => RECIPIENT_UNDELIVERABLE_CODES.has(String(error?.code || '')));
}

function scopeFromExecution(execution, appointment) {
  if (!execution || !appointment || !same(execution.clinic_id, appointment.clinica_id)) return null;
  const context = object(execution.context);
  const snapshot = object(context.appointment || context.cita);
  const appointmentId = integer(execution.trigger_entity_type === 'appointment' ? execution.trigger_entity_id
    : snapshot.id_cita || snapshot.id);
  if (appointmentId !== integer(appointment.id_cita)
    || !same(snapshot.paciente_id || snapshot.patient_id, appointment.paciente_id)
    || !same(snapshot.clinica_id || snapshot.clinic_id, appointment.clinica_id)
    || !Number.isFinite(millis(snapshot.inicio))
    || millis(snapshot.inicio) !== millis(appointment.inicio)
    || (snapshot.fin && millis(snapshot.fin) !== millis(appointment.fin))) return null;
  const slot = hash(`${appointment.clinica_id}:${appointment.id_cita}:${millis(appointment.inicio)}:${millis(appointment.fin)}`);
  const trigger = String(execution.trigger_type || '');
  const purpose = trigger === 'consent_required' ? 'consent'
    : ['before_appointment', 'appointment_reminder_window'].includes(trigger) ? 'reminder'
      : ['appointment_created', 'appointment_rescheduled'].includes(trigger) ? 'appointment_details'
        : 'appointment_response';
  return { slot, purpose };
}

function eligibleRecipient(membership, user, appointment, adminIds) {
  const userId = integer(user?.id_usuario);
  if (!userId || user.estado_cuenta !== 'activo') return false;
  // The temporary focused account must never receive alerts about somebody
  // else's appointments, even if it is also configured as a global admin.
  if (isTemporaryQuickChatFocusUser({ userId, email: user.email_usuario })
    && userId !== integer(appointment.created_by)) return false;
  if (adminIds.includes(userId)) return true;
  if (!membership || !same(membership.id_clinica, appointment.clinica_id)
    || membership.estado_invitacion !== 'aceptada') return false;
  if (membership.rol_clinica === 'propietario') return true;
  if (membership.rol_clinica !== 'personaldeclinica' || membership.subrol_clinica === 'Gestoría') return false;
  return RECEPTION_SUBROLES.has(membership.subrol_clinica)
    || userId === integer(appointment.created_by) || userId === integer(appointment.doctor_id);
}

function createAppointmentDeliveryAlerts({ models = db, emitCreated = realtime.emitNotificationCreated,
  emitUpdated = realtime.emitNotificationUpdated, adminIds = ADMIN_USER_IDS, now = () => new Date(),
  canAccess = (...args) => require('../lib/access-policy').canUserAccessFeature(...args) } = {}) {
  async function reconcile({ message, status = {}, mappedStatus, clinicId } = {}) {
    const metadata = object(message?.metadata);
    const messageId = integer(message?.id);
    const executionId = integer(metadata.execution_id);
    if (!messageId || !executionId || message.direction !== 'outbound' || message.message_type === 'event'
      || metadata.template_commercial === true || metadata.communication_scope === 'marketing'
      || metadata.flow_domain === 'marketing'
      || metadata.list_id || !['failed', 'delivered', 'read'].includes(mappedStatus)) {
      return { applied: false, reason: 'not_operational_appointment_delivery' };
    }
    // Do not touch DB on generic Meta account/configuration failures.
    if (mappedStatus === 'failed' && !definitiveRecipientFailure(message, status)) {
      return { applied: false, reason: 'not_recipient_undeliverable' };
    }
    const events = [];
    const outcome = await models.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const execution = await models.FlowExecutionV2.findByPk(executionId, { transaction, raw: true });
      const context = object(execution?.context);
      const snapshot = object(context.appointment || context.cita);
      const appointmentId = integer(execution?.trigger_entity_type === 'appointment'
        ? execution.trigger_entity_id : snapshot.id_cita || snapshot.id);
      if (!appointmentId || !integer(execution?.clinic_id)
        || (clinicId && !same(execution.clinic_id, clinicId))) return { applied: false, reason: 'execution_scope_mismatch' };
      // Every notification for this appointment is serialized through the
      // same row. Repeated callbacks, follow-ups and manual retries cannot
      // create multiple orange overlays or race a later delivered callback.
      const appointment = await models.CitaPaciente.findByPk(appointmentId, {
        transaction, lock: transaction.LOCK.UPDATE, raw: true,
      });
      const scope = scopeFromExecution(execution, appointment);
      if (!scope) return { applied: false, reason: 'appointment_slot_changed' };
      const persisted = await models.Message.findByPk(messageId, { transaction, raw: true });
      if (!persisted || !same(object(persisted.metadata).execution_id, executionId)
        || persisted.direction !== 'outbound' || persisted.message_type === 'event'
        || (mappedStatus === 'failed' && !definitiveRecipientFailure(persisted, status))
        || (mappedStatus !== 'failed' && !['delivered', 'read'].includes(persisted.status))) {
        return { applied: false, reason: 'persisted_delivery_changed' };
      }
      const conversation = await models.Conversation.findByPk(persisted.conversation_id, { transaction, raw: true });
      if (!conversation || conversation.channel !== 'whatsapp'
        || !same(conversation.clinic_id, appointment.clinica_id)
        || !same(conversation.patient_id, appointment.paciente_id)) {
        return { applied: false, reason: 'conversation_scope_mismatch' };
      }
      const keyPrefix = `appointment-whatsapp:${appointment.clinica_id}:${appointment.id_cita}:${scope.slot}:`;
      const existing = await models.Notification.findAll({
        where: { dedupeKey: { [Op.like]: `${keyPrefix}%` } }, transaction,
      });
      let supersedingDelivery = null;
      if (mappedStatus === 'failed') {
        const laterMessages = await models.Message.findAll({ where: {
          conversation_id: conversation.id, direction: 'outbound', status: { [Op.in]: ['delivered', 'read'] },
          id: { [Op.gt]: messageId },
        }, attributes: ['id', 'metadata', 'message_type', 'createdAt', 'sent_at'],
        transaction, order: [['id', 'DESC']], limit: 100, raw: true });
        for (const later of laterMessages) {
          const laterMetadata = object(later.metadata);
          if (later.message_type === 'event' || laterMetadata.template_commercial === true
            || laterMetadata.communication_scope === 'marketing' || laterMetadata.flow_domain === 'marketing' || laterMetadata.list_id
            || !integer(laterMetadata.execution_id)) continue;
          const laterExecution = await models.FlowExecutionV2.findByPk(integer(laterMetadata.execution_id), { transaction, raw: true });
          const laterScope = scopeFromExecution(laterExecution, appointment);
          if (laterScope?.slot === scope.slot && laterScope.purpose === scope.purpose) {
            supersedingDelivery = later; break;
          }
        }
      }
      const terminalResolved = RESOLVED_STATES.has(appointment.estado) || appointment.es_provisional === true
        || millis(appointment.fin) < now().getTime();
      const confirmationResolved = scope.purpose !== 'consent'
        && ['info_confirmada', 'recordatorio_confirmado'].includes(appointment.estado);
      const resolved = terminalResolved || confirmationResolved;
      if (resolved || mappedStatus !== 'failed' || supersedingDelivery) {
        const deliveredMessage = supersedingDelivery || persisted;
        let updated = 0;
        for (const notification of existing) {
          const data = object(notification.data);
          const groups = { ...object(data.deliveryFailureGroups) };
          const failed = groups[scope.purpose];
          if (!resolved && (!failed || millis(deliveredMessage.createdAt || deliveredMessage.created_at || deliveredMessage.sent_at)
            < millis(failed.messageCreatedAt))) continue;
          if (terminalResolved) Object.keys(groups).forEach(key => delete groups[key]);
          else if (confirmationResolved) Object.keys(groups).filter(key => key !== 'consent').forEach(key => delete groups[key]);
          else delete groups[scope.purpose];
          const allResolved = !Object.keys(groups).length;
          await notification.update({
            ...(allResolved ? { isRead: true, readAt: now() } : {}),
            data: { ...data, deliveryFailureGroups: groups,
              ...(allResolved ? { delivery_alert_resolved_at: now().toISOString(),
                delivery_alert_resolved_reason: resolved ? 'appointment_resolved' : 'whatsapp_delivered',
                delivery_alert_resolved_message_id: resolved ? null : deliveredMessage.id } : {}) },
          }, { transaction });
          events.push(['updated', notification]); updated++;
        }
        return { applied: true, created: 0, updated, resolved };
      }
      const memberships = await models.UsuarioClinica.findAll({
        where: { id_clinica: appointment.clinica_id, estado_invitacion: 'aceptada',
          rol_clinica: { [Op.in]: ['propietario', 'personaldeclinica'] } }, transaction, raw: true,
      });
      const candidateIds = [...new Set([...adminIds, ...memberships.map(row => integer(row.id_usuario))].filter(Boolean))];
      const users = candidateIds.length ? await models.Usuario.findAll({
        where: { id_usuario: { [Op.in]: candidateIds }, estado_cuenta: 'activo' },
        attributes: ['id_usuario', 'email_usuario', 'estado_cuenta'], transaction, raw: true,
      }) : [];
      const patient = await models.Paciente.findByPk(appointment.paciente_id, {
        attributes: ['nombre', 'apellidos'], transaction, raw: true,
      });
      const name = [patient?.nombre, patient?.apellidos].filter(Boolean).join(' ').trim() || 'Paciente de la cita';
      let createdCount = 0;
      for (const user of users) {
        const membership = memberships.find(row => same(row.id_usuario, user.id_usuario));
        if (!eligibleRecipient(membership, user, appointment, adminIds)) continue;
        // Direct user-room delivery and /notifications do not repeat clinical
        // access checks; custom clinic-level denials must be honored here.
        const access = await Promise.all(['appointments.view', 'patients.sensitive.view', 'quickchat.read_patients']
          .map(featureKey => canAccess({ actorId: user.id_usuario, featureKey, clinicId: appointment.clinica_id })));
        if (!access.every(Boolean)) continue;
        const dedupeKey = `${keyPrefix}${user.id_usuario}`;
        const [notification, created] = await models.Notification.findOrCreate({ where: { dedupeKey }, transaction,
          defaults: { userId: user.id_usuario, role: membership?.rol_clinica || 'admin',
            subrole: membership?.subrol_clinica || '', category: 'whatsapp', event: 'automation.persistent_alert',
            title: name.slice(0, 255), message: 'El paciente no está recibiendo el WhatsApp. Llámale.',
            icon: 'heroicons_outline:phone-arrow-up-right', level: 'warning', clinicaId: appointment.clinica_id,
            dedupeKey, data: { source: 'appointment_whatsapp_delivery', kind: KIND,
              clinicId: appointment.clinica_id, appointmentId: appointment.id_cita, patientId: appointment.paciente_id,
              trigger_entity_type: 'appointment', trigger_entity_id: appointment.id_cita,
              appointmentSlot: scope.slot, appointmentStart: new Date(appointment.inicio).toISOString(),
              appointmentEnd: new Date(appointment.fin).toISOString(), quickChatConversationId: conversation.id,
              displayMode: 'persistent_alert', requiresAcknowledgement: true,
              link: `/pacientes/detalle/${appointment.paciente_id}`, useRouter: true } } });
        const data = object(notification.data);
        const groups = { ...object(data.deliveryFailureGroups) };
        const previous = groups[scope.purpose];
        // A late callback for an older attempt cannot overwrite the anchor of
        // a newer attempt. Acknowledgement never causes a retry to re-alert.
        if (!previous || integer(previous.messageId) <= messageId) {
          groups[scope.purpose] = { messageId, executionId,
            messageCreatedAt: new Date(persisted.createdAt || persisted.created_at || persisted.sent_at).toISOString(),
            providerErrorCode: '131026' };
          const reopen = notification.isRead && data.delivery_alert_resolved_reason === 'whatsapp_delivered';
          await notification.update({ data: { ...data, deliveryFailureGroups: groups,
            failedMessageId: messageId, execution_id: executionId,
            ...(reopen ? { delivery_alert_resolved_reason: null, delivery_alert_resolved_at: null } : {}) },
            ...(reopen ? { isRead: false, readAt: null } : {}) }, { transaction });
          events.push([created ? 'created' : 'updated', notification]);
        }
        if (created) createdCount++;
      }
      return { applied: true, created: createdCount, recipients: users.length };
    });
    // Never emit an alert before its durable transaction commits.
    for (const [event, notification] of events) (event === 'created' ? emitCreated : emitUpdated)(notification);
    return outcome;
  }
  return { reconcile };
}

module.exports = {
  KIND, createAppointmentDeliveryAlerts,
  reconcileAppointmentWhatsappDelivery: createAppointmentDeliveryAlerts().reconcile,
  __testing: { definitiveRecipientFailure, eligibleRecipient, scopeFromExecution },
};
