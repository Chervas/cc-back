'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  evaluateWhatsappServiceWindow,
  extractWhatsappPhoneNumberId,
} = require('../../services/whatsappServiceWindow.service');

const NOW = '2026-07-27T16:30:00.000Z';
const CURRENT_PHONE = '107845898629239';
const PREVIOUS_PHONE = '1128272900359750';

function inbound({ at, phoneNumberId, metadata = {} }) {
  return {
    direction: 'inbound',
    sent_at: at,
    metadata: phoneNumberId
      ? { ...metadata, phoneId: phoneNumberId }
      : metadata,
  };
}

test('abre la ventana cuando el paciente respondió al número remitente activo', () => {
  const result = evaluateWhatsappServiceWindow({
    activePhoneNumberId: CURRENT_PHONE,
    conversationLastInboundAt: '2026-07-27T16:04:00.000Z',
    now: NOW,
    messages: [
      inbound({ at: '2026-07-27T16:04:00.000Z', phoneNumberId: CURRENT_PHONE }),
    ],
  });

  assert.equal(result.open, true);
  assert.equal(result.phoneNumberId, CURRENT_PHONE);
  assert.equal(result.matchedBy, 'message_phone_number_id');
  assert.equal(result.legacyFallbackUsed, false);
});

test('no reutiliza para el número nuevo una respuesta recibida por el número anterior', () => {
  const result = evaluateWhatsappServiceWindow({
    activePhoneNumberId: CURRENT_PHONE,
    conversationLastInboundAt: '2026-07-27T16:04:00.000Z',
    now: NOW,
    messages: [
      inbound({ at: '2026-07-27T16:04:00.000Z', phoneNumberId: PREVIOUS_PHONE }),
    ],
  });

  assert.equal(result.open, false);
  assert.equal(result.phoneNumberId, CURRENT_PHONE);
  assert.equal(result.lastInboundAt, null);
  assert.equal(result.matchedBy, 'different_phone_number_id');
  assert.equal(result.legacyFallbackUsed, false);
});

test('mantiene compatibilidad con mensajes históricos que no guardaban el remitente', () => {
  const result = evaluateWhatsappServiceWindow({
    activePhoneNumberId: CURRENT_PHONE,
    conversationLastInboundAt: '2026-07-27T16:04:00.000Z',
    now: NOW,
    messages: [
      inbound({ at: '2026-07-27T16:04:00.000Z' }),
    ],
  });

  assert.equal(result.open, true);
  assert.equal(result.matchedBy, 'legacy_conversation_timestamp');
  assert.equal(result.legacyFallbackUsed, true);
});

test('cierra la ventana cuando la respuesta del remitente activo supera 24 horas', () => {
  const result = evaluateWhatsappServiceWindow({
    activePhoneNumberId: CURRENT_PHONE,
    conversationLastInboundAt: '2026-07-26T16:29:59.000Z',
    now: NOW,
    messages: [
      inbound({ at: '2026-07-26T16:29:59.000Z', phoneNumberId: CURRENT_PHONE }),
    ],
  });

  assert.equal(result.open, false);
  assert.equal(result.matchedBy, 'no_recent_inbound');
});

test('reconoce las claves de remitente usadas por webhook y transportes', () => {
  assert.equal(extractWhatsappPhoneNumberId({ phoneId: CURRENT_PHONE }), CURRENT_PHONE);
  assert.equal(extractWhatsappPhoneNumberId({ phoneNumberId: CURRENT_PHONE }), CURRENT_PHONE);
  assert.equal(extractWhatsappPhoneNumberId({ phone_number_id: CURRENT_PHONE }), CURRENT_PHONE);
  assert.equal(
    extractWhatsappPhoneNumberId(JSON.stringify({ phone_id: CURRENT_PHONE })),
    CURRENT_PHONE
  );
});
