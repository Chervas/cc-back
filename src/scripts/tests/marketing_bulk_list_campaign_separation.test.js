'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __testing } = require('../../services/marketingBulkSends.service');

test('normaliza el tipo de registro y mantiene compatibilidad con campañas antiguas', () => {
  assert.equal(__testing.normalizeMassSendRecordKind('recipient_list'), 'recipient_list');
  assert.equal(__testing.normalizeMassSendRecordKind('campaign'), 'campaign');
  assert.equal(__testing.normalizeMassSendRecordKind('legacy'), 'campaign');
});

test('una lista de destinatarios no se puede preparar ni enviar directamente', () => {
  assert.throws(
    () => __testing.ensureDispatchableCampaignRecord({ criteria: { record_kind: 'recipient_list' } }),
    (error) => error.status === 409 && /dentro de una campaña/.test(error.message)
  );
  assert.doesNotThrow(() => __testing.ensureDispatchableCampaignRecord({ criteria: { record_kind: 'campaign' } }));
  assert.doesNotThrow(() => __testing.ensureDispatchableCampaignRecord({ criteria: {} }));
});

test('una campaña copia el destinatario sin reutilizar estado ni identificadores de envío', () => {
  const cloned = __testing.cloneRecipientItemForCampaign({
    id: 91,
    list_id: 42,
    paciente_id: 7,
    clinica_id: 56,
    name: 'Ana',
    phone: '+34617560236',
    email: 'ana@example.com',
    status: 'ready',
    selected: false,
    custom_fields: { ciudad: 'Madrid' },
    missing_variables: ['codigo'],
    dispatch_status: 'read',
    app_message_id: 500,
    provider_message_id: 'wamid.previous',
    conversation_id: 300,
    sent_at: new Date('2026-09-20T10:00:00Z'),
    delivered_at: new Date('2026-09-20T10:01:00Z'),
    read_at: new Date('2026-09-20T10:02:00Z'),
  }, ['whatsapp']);

  assert.equal(cloned.name, 'Ana');
  assert.equal(cloned.phone, '+34617560236');
  assert.equal(cloned.status, 'ready');
  assert.equal(cloned.selected, true);
  assert.deepEqual(cloned.custom_fields, { ciudad: 'Madrid' });
  assert.deepEqual(cloned.missing_variables, []);
  assert.equal(Object.hasOwn(cloned, 'id'), false);
  assert.equal(Object.hasOwn(cloned, 'list_id'), false);
  assert.equal(Object.hasOwn(cloned, 'dispatch_status'), false);
  assert.equal(Object.hasOwn(cloned, 'app_message_id'), false);
  assert.equal(Object.hasOwn(cloned, 'provider_message_id'), false);
  assert.equal(Object.hasOwn(cloned, 'conversation_id'), false);
  assert.equal(Object.hasOwn(cloned, 'sent_at'), false);
  assert.equal(Object.hasOwn(cloned, 'delivered_at'), false);
  assert.equal(Object.hasOwn(cloned, 'read_at'), false);
});

test('la copia recalcula los campos obligatorios según los canales de la campaña', () => {
  const cloned = __testing.cloneRecipientItemForCampaign({
    name: 'Ana',
    phone: '+34617560236',
    email: null,
    status: 'ready',
  }, ['email']);

  assert.equal(cloned.status, 'excluded_missing_required');
  assert.equal(cloned.exclusion_reason, 'missing_required');
  assert.equal(cloned.selected, false);
  assert.match(cloned.reason, /email/);
});

test('archivar una campaña sin lista separada conserva antes sus destinatarios', () => {
  assert.equal(__testing.shouldPreserveRecipientListOnArchive({
    criteria: { campaign_name: 'Campaña antigua' },
  }), true);
  assert.equal(__testing.shouldPreserveRecipientListOnArchive({
    criteria: { record_kind: 'campaign', source_list_id: 44 },
  }), false);
  assert.equal(__testing.shouldPreserveRecipientListOnArchive({
    criteria: { record_kind: 'recipient_list' },
  }), false);
  assert.equal(__testing.shouldPreserveRecipientListOnArchive({
    criteria: { record_kind: 'campaign', preserved_recipient_list_id: 45 },
  }), false);
});

test('la bienvenida se limita al lote recién importado', () => {
  const filter = { type: 'import_batch', import_batch_id: 'batch-20260924' };
  assert.equal(__testing.itemMatchesDispatchFilter({
    custom_fields: { lote_importacion: 'batch-20260924' },
  }, filter), true);
  assert.equal(__testing.itemMatchesDispatchFilter({
    custom_fields: { lote_importacion: 'batch-anterior' },
  }, filter), false);
  assert.equal(__testing.itemMatchesDispatchFilter({ custom_fields: {} }, filter), false);
});

test('la bienvenida identifica correctamente el canal de salida', () => {
  assert.equal(__testing.getWelcomeDispatchLabel(['whatsapp']), 'Bienvenida por WhatsApp');
  assert.equal(__testing.getWelcomeDispatchLabel(['email']), 'Bienvenida por email');
  assert.equal(__testing.getWelcomeDispatchLabel(['whatsapp', 'email']), 'Bienvenida por WhatsApp y email');
});
