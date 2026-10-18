'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { packetFor } = require('../../lib/socket-payload');
const { mapNotificationToDto } = require('../../lib/notification-dto');
const notification = () => ({ id: 19, event: 'automation.persistent_alert', clinicaId: 72, isRead: false,
  data: { trigger_type: 'patient.mobile_verification_requested', request_event_id: 5, patientId: 104,
    clinicId: 999, displayMode: 'persistent_alert', requiresAcknowledgement: true, resolved: false,
    quickChatConversationId: 2, reply_token: 'PRIVATE', phone: 'PRIVATE', snapshot_hash: 'PRIVATE',
    link: 'https://evil.invalid/?secret=PRIVATE', providerResponse: { token: 'PRIVATE' } } });

test('modular review DTO projects only its closed domain fields and a reconstructed scoped patient link', () => {
  const source = notification(), before = structuredClone(source);
  const dto = mapNotificationToDto(source);
  for (const event of ['notification:created', 'notification:updated']) {
    const { body } = packetFor(event, dto);
    assert.equal(body.event, 'automation.persistent_alert');
    assert.deepEqual(body.data, { trigger_type: 'patient.mobile_verification_requested', request_event_id: 5,
      patientId: 104, clinicId: 72, displayMode: 'persistent_alert', requiresAcknowledgement: true, resolved: false });
    assert.equal(body.link, '/pacientes/detalle/104/datos-personales?clinic_id=72');
    assert(!JSON.stringify(body).includes('PRIVATE')); assert(!Object.hasOwn(body.data, 'quickChatConversationId'));
  }
  assert.deepEqual(source, before);
});

test('resolved review updates preserve closure without making another pending alert', () => {
  const source = notification(); source.isRead = true;
  Object.assign(source.data, { requiresAcknowledgement: false, resolved: true });
  const { body } = packetFor('notification:updated', mapNotificationToDto(source));
  assert.equal(body.read, true); assert.equal(body.data.requiresAcknowledgement, false); assert.equal(body.data.resolved, true);
});

test('ordinary notifications and invalid mobile scopes cannot add domain fields or arbitrary URL queries', () => {
  for (const patch of [{ event: 'unrelated' }, { clinicaId: null },
    ...[null, true, 0, -1, 'foreign'].map(request_event_id => ({ data: { ...notification().data, request_event_id } })),
    { data: { ...notification().data, patientId: null } },
    { data: { ...notification().data, trigger_type: 'appointment_reminder_window' } }]) {
    const source = { ...notification(), ...patch };
    const { body } = packetFor('notification:created', mapNotificationToDto(source));
    assert.equal(body.link, null); assert(!Object.hasOwn(body.data, 'request_event_id'));
    assert(!Object.hasOwn(body.data, 'displayMode')); assert(!JSON.stringify(body).includes('PRIVATE'));
  }
});
