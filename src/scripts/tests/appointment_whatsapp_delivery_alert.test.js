'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
process.env.JOBS_AUTO_START = 'false';
const db = require('../../../models');
const { KIND, createAppointmentDeliveryAlerts, __testing } = require('../../services/appointmentWhatsappDeliveryAlert.service');

test.after(() => db.sequelize.close());

function fixture() {
  const at = new Date('2026-10-06T14:00:00Z');
  const appointment = { id_cita: 71, clinica_id: 72, paciente_id: 10, doctor_id: 53, created_by: 142,
    estado: 'info_enviada', inicio: '2026-10-07T10:30:00Z', fin: '2026-10-07T11:00:00Z' };
  const snapshot = { ...appointment };
  const executions = new Map([[81, { id: 81, clinic_id: 72, trigger_entity_type: 'appointment',
    trigger_entity_id: 71, trigger_type: 'appointment_created', context: { appointment: snapshot } }]]);
  const messages = new Map([[91, { id: 91, conversation_id: 101, direction: 'outbound',
    message_type: 'template', status: 'failed', createdAt: '2026-10-06T10:00:00Z',
    metadata: { source: 'automations_v2', execution_id: 81, wamid: 'accepted-wamid', wa_error: [{ code: 131026 }] } }]]);
  const conversation = { id: 101, clinic_id: 72, patient_id: 10, channel: 'whatsapp' };
  const memberships = [
    { id_usuario: 142, id_clinica: 72, rol_clinica: 'personaldeclinica', subrol_clinica: 'Administrativos', estado_invitacion: 'aceptada' },
    { id_usuario: 53, id_clinica: 72, rol_clinica: 'propietario', estado_invitacion: 'aceptada' },
    { id_usuario: 54, id_clinica: 72, rol_clinica: 'personaldeclinica', subrol_clinica: 'Auxiliares y enfermeros', estado_invitacion: 'cancelada' },
    { id_usuario: 221, id_clinica: 72, rol_clinica: 'personaldeclinica', subrol_clinica: 'Auxiliares y enfermeros', estado_invitacion: 'aceptada' },
    { id_usuario: 301, id_clinica: 72, rol_clinica: 'personaldeclinica', subrol_clinica: 'Gestoría', estado_invitacion: 'aceptada' },
    { id_usuario: 302, id_clinica: 72, rol_clinica: 'paciente', estado_invitacion: 'aceptada' },
  ];
  const users = [1, 44, 53, 54, 142, 221, 301, 302].map(id => ({ id_usuario: id, estado_cuenta: 'activo',
    email_usuario: id === 44 ? 'maria.gonzalez@modmarketing.net' : `test-${id}@example.invalid` }));
  const notifications = new Map();
  const events = [];
  let queue = Promise.resolve();
  const committed = new Set();
  const denied = new Set();
  let nextTransactionId = 0;
  const models = {
    sequelize: { transaction: async (_options, run) => {
      const current = queue.then(async () => {
        const id = ++nextTransactionId;
        const result = await run({ id, LOCK: { UPDATE: 'UPDATE' } });
        committed.add(id);
        return result;
      });
      queue = current.catch(() => {});
      return current;
    } },
    FlowExecutionV2: { findByPk: async id => executions.get(id) },
    CitaPaciente: { findByPk: async (id, options) => {
      assert.equal(options.lock, 'UPDATE', 'appointment mutex serializes every attempt');
      return id === appointment.id_cita ? appointment : null;
    } },
    Message: { findByPk: async id => messages.get(id), findAll: async ({ where }) => [...messages.values()].filter(message =>
      message.id > where.id[Op.gt] && ['delivered', 'read'].includes(message.status)
      && message.conversation_id === where.conversation_id && message.direction === 'outbound') },
    Conversation: { findByPk: async id => id === conversation.id ? conversation : null },
    UsuarioClinica: { findAll: async ({ where }) => {
      assert.equal(where.estado_invitacion, 'aceptada');
      return memberships.filter(member => member.estado_invitacion === where.estado_invitacion
        && member.id_clinica === where.id_clinica && where.rol_clinica[Op.in].includes(member.rol_clinica));
    } },
    Usuario: { findAll: async ({ where }) => users.filter(user => where.id_usuario[Op.in].includes(user.id_usuario)) },
    Paciente: { findByPk: async () => ({ nombre: 'Paciente', apellidos: 'Prueba' }) },
    Notification: {
      findAll: async ({ where }) => [...notifications.values()].filter(notification =>
        notification.dedupeKey.startsWith(where.dedupeKey[Op.like].slice(0, -1))),
      findOrCreate: async ({ where, defaults, transaction }) => {
        if (notifications.has(where.dedupeKey)) return [notifications.get(where.dedupeKey), false];
        const row = { ...defaults, id: notifications.size + 1, isRead: false, creationTransaction: transaction.id,
          update: async payload => { Object.assign(row, payload); return row; } };
        notifications.set(where.dedupeKey, row);
        return [row, true];
      },
    },
  };
  const alerts = createAppointmentDeliveryAlerts({ models, adminIds: [1, 44], now: () => at,
    canAccess: async ({ actorId, featureKey }) => !denied.has(`${actorId}:${featureKey}`),
    emitCreated: notification => { assert.ok(committed.has(notification.creationTransaction)); events.push(['created', notification.id]); },
    emitUpdated: notification => { assert.ok(committed.has(notification.creationTransaction)); events.push(['updated', notification.id]); },
  });
  const reconcile = (id = 91, extra = {}) => alerts.reconcile({ message: messages.get(id),
    mappedStatus: messages.get(id).status, clinicId: 72, ...extra });
  return { appointment, conversation, executions, messages, memberships, users, notifications, events, denied, reconcile };
}

test('131026 crea el aviso naranja durable para recepción/responsable/admin, no pacientes, agencia ni Graci ajena', async () => {
  const f = fixture();
  const result = await f.reconcile();
  assert.equal(result.created, 3);
  assert.deepEqual([...f.notifications.values()].map(row => row.userId).sort((a,b) => a-b), [1, 53, 142]);
  for (const row of f.notifications.values()) {
    assert.equal(row.event, 'automation.persistent_alert');
    assert.equal(row.level, 'warning');
    assert.equal(row.message, 'El paciente no está recibiendo el WhatsApp. Llámale.');
    assert.equal(row.data.kind, KIND);
    assert.equal(row.data.displayMode, 'persistent_alert');
    assert.equal(row.data.requiresAcknowledgement, true);
    assert.equal(row.data.quickChatConversationId, 101);
    assert.equal(row.data.quickChatResponseMessageId, undefined);
  }
});

test('un permiso clínico denegado excluye al destinatario aunque sea recepción o propietario', async () => {
  const f = fixture();
  f.denied.add('142:quickchat.read_patients');
  f.denied.add('53:patients.sensitive.view');
  await f.reconcile();
  assert.deepEqual([...f.notifications.values()].map(row => row.userId), [1]);
});

test('callback repetido, inicial, seguimiento y reintento manual tienen UNA alerta por cita y destinatario', async () => {
  const f = fixture();
  const original = f.messages.get(91);
  f.messages.set(92, { ...original, id: 92, createdAt: '2026-10-06T11:00:00Z' });
  f.messages.set(93, { ...original, id: 93, createdAt: '2026-10-06T12:00:00Z',
    metadata: { ...original.metadata, manual_retry_of_message_id: 91 } });
  await Promise.all([f.reconcile(), f.reconcile(), f.reconcile(92), f.reconcile(93)]);
  assert.equal(f.notifications.size, 3);
  assert.equal(f.events.filter(([kind]) => kind === 'created').length, 3);
  assert.equal([...f.notifications.values()][0].data.failedMessageId, 93);
});

test('fallos técnicos, rechazo de plantilla, pending/retry/held, timeout ambiguo y eventos no culpan al paciente', async () => {
  for (const patch of [
    { metadata: { execution_id: 81, wa_error: [{ code: 131016 }] } },
    { metadata: { execution_id: 81, wa_error: [{ code: 132015 }] } },
    { metadata: { execution_id: 81, wa_error: [{ code: 131026 }], outbound_retry: { retrying: true } } },
    { metadata: { execution_id: 81, wa_error: [{ code: 131026 }], outbound_retry: { reason: 'delivery_unknown' } } },
    { status: 'pending' }, { status: 'sent' }, { message_type: 'event' }, { direction: 'inbound' },
    { metadata: { execution_id: 81, wa_error: [{ code: 131026 }], template_commercial: true } },
  ]) {
    const f = fixture();
    Object.assign(f.messages.get(91), patch);
    await f.reconcile();
    assert.equal(f.notifications.size, 0);
  }
});

test('scopes distintos de clínica/paciente/slot no generan un aviso; tampoco callback anterior tras reprogramar', async () => {
  for (const mutate of [f => { f.conversation.clinic_id = 66; }, f => { f.conversation.patient_id = 99; },
    f => { f.conversation.channel = 'internal'; }, f => { f.appointment.inicio = '2026-10-08T10:30:00Z'; },
    f => { f.appointment.fin = '2026-10-07T11:05:00Z'; }, f => { f.executions.get(81).clinic_id = 66; },
  ]) {
    const f = fixture(); mutate(f); await f.reconcile(); assert.equal(f.notifications.size, 0);
  }
});

test('sent no cierra aviso, delivered/read posterior SÍ; éxito de consentimiento no oculta datos de cita fallidos', async () => {
  const f = fixture();
  await f.reconcile();
  f.executions.set(82, { ...f.executions.get(81), id: 82, trigger_type: 'consent_required' });
  f.messages.set(92, { ...f.messages.get(91), id: 92, createdAt: '2026-10-06T11:00:00Z',
    metadata: { ...f.messages.get(91).metadata, execution_id: 82 } });
  await f.reconcile(92);
  assert.equal(f.notifications.size, 3, 'consentimiento y cita no crean dos avisos');
  f.messages.get(92).status = 'delivered';
  await f.reconcile(92);
  assert.equal([...f.notifications.values()][0].isRead, false, 'no prueba recepción de los datos');
  const success = { ...f.messages.get(91), id: 93, status: 'sent', createdAt: '2026-10-06T12:00:00Z' };
  f.messages.set(93, success);
  await f.reconcile(93);
  assert.equal([...f.notifications.values()][0].isRead, false);
  success.status = 'read';
  await f.reconcile(93);
  assert.equal([...f.notifications.values()][0].isRead, true);
  assert.equal([...f.notifications.values()][0].data.delivery_alert_resolved_message_id, 93);
  await f.reconcile(91);
  assert.equal([...f.notifications.values()][0].isRead, true, 'callback fallido antiguo no reaparece');
});

test('revalidación antes de alerta: intento posterior ya entregado impide reaparecer fallo anterior', async () => {
  const f = fixture();
  f.messages.set(94, { ...f.messages.get(91), id: 94, status: 'delivered', createdAt: '2026-10-06T12:00:00Z' });
  await f.reconcile();
  assert.equal(f.notifications.size, 0);
});

test('confirmación preexistente no oculta un consentimiento no entregado; terminal sí resuelve la llamada', async () => {
  const f = fixture();
  f.appointment.estado = 'recordatorio_confirmado';
  f.executions.get(81).trigger_type = 'consent_required';
  await f.reconcile();
  assert.equal(f.notifications.size, 3);
  f.appointment.estado = 'completada';
  await f.reconcile();
  assert.ok([...f.notifications.values()].every(row => row.isRead));
});

test('datos o recordatorios ya confirmados no reaparecen por un callback fallido atrasado', async () => {
  const f = fixture();
  await f.reconcile();
  f.appointment.estado = 'info_confirmada';
  await f.reconcile();
  assert.ok([...f.notifications.values()].every(row => row.isRead));
  const confirmed = fixture();
  confirmed.appointment.estado = 'recordatorio_confirmado';
  confirmed.executions.get(81).trigger_type = 'appointment_reminder_window';
  await confirmed.reconcile();
  assert.equal(confirmed.notifications.size, 0);
});

test('confirmación previa y callback atrasado de recordatorio no ocultan un consentimiento nuevo fallido', async () => {
  const f = fixture();
  await f.reconcile();
  f.appointment.estado = 'recordatorio_confirmado';
  f.executions.set(82, { ...f.executions.get(81), id: 82, trigger_type: 'consent_required' });
  f.messages.set(92, { ...f.messages.get(91), id: 92, createdAt: '2026-10-06T11:00:00Z',
    metadata: { ...f.messages.get(91).metadata, execution_id: 82 } });
  await f.reconcile(92);
  await f.reconcile(91);
  const notification = [...f.notifications.values()][0];
  assert.equal(notification.isRead, false);
  assert.deepEqual(Object.keys(notification.data.deliveryFailureGroups), ['consent']);
});

test('acuse explícito no se reinicia por el mismo fallo/reintento; Graci solo recibe una cita creada por ella', async () => {
  const f = fixture();
  f.appointment.created_by = 44;
  await f.reconcile();
  assert.ok([...f.notifications.values()].some(row => row.userId === 44));
  for (const row of f.notifications.values()) row.isRead = true;
  await f.reconcile();
  assert.ok([...f.notifications.values()].every(row => row.isRead));
});

test('error API final estructurado 131026 también sirve, no una cadena con el número ni timeout unknown', () => {
  assert.equal(__testing.definitiveRecipientFailure({ status: 'failed', metadata: { error: { error: { code: 131026 } } } }), true);
  assert.equal(__testing.definitiveRecipientFailure({ status: 'failed', metadata: { error: 'falló 131026' } }), false);
});
