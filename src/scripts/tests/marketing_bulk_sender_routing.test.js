'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const service = require('../../services/marketingBulkSends.service');

const { buildWhatsappSenderSnapshot, getRequestedWhatsappSenderOriginId } = service.__testing;

test('el remitente explicito prevalece y queda en un snapshot sin credenciales', () => {
  const list = {
    criteria: {
      sender_origin_id: 374,
      dispatch: { sender_origin_id: 396 },
    },
  };
  assert.equal(getRequestedWhatsappSenderOriginId({}, list), 396);
  assert.equal(getRequestedWhatsappSenderOriginId({ sender_origin_id: 401 }, list), 401);
  assert.equal(getRequestedWhatsappSenderOriginId({ sender_origin_id: 'invalid' }, list), null);

  const snapshot = buildWhatsappSenderSnapshot({
    originId: 396,
    phoneNumberId: '1373925869132435',
    wabaId: '1005040135934907',
    whatsapp_channel_role: 'secondary',
    originLabel: 'Atencion al paciente Propdental',
    accessToken: 'never-persist-this',
  });
  assert.deepEqual(snapshot, {
    origin_id: 396,
    phone_number_id: '1373925869132435',
    waba_id: '1005040135934907',
    role: 'secondary',
    label: 'Atencion al paciente Propdental',
  });
});

test('prueba, inicio, reanudacion y worker usan el remitente persistido', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../services/marketingBulkSends.service.js'),
    'utf8'
  );
  assert.match(source, /resolveWhatsappClinicConfigForList\(list, clinicId, body\)/);
  assert.match(source, /marketing_bulk_send_test_preflight/);
  assert.match(source, /marketing_bulk_send_start_preflight/);
  assert.match(source, /marketing_bulk_send_resume_preflight/);
  assert.match(source, /marketing_bulk_send_worker_preflight/);
  assert.match(source, /sender_origin_id: clinicConfig\.originId \|\| null/);
});
