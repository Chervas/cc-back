'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../../../models');
const service = require('../../services/marketingBulkSends.service');

test('el estado de una prueba de email queda limitado a su campaña y ámbito', async (t) => {
  let messageListId = 815;
  t.mock.method(db.MarketingPatientList, 'findByPk', async () => ({
    id: 815,
    objective_id: 'mass_sends',
    clinica_id: 63,
    clinic_ids: [],
  }));
  t.mock.method(db.EmailMessage, 'findOne', async ({ where }) => {
    assert.deepEqual(where, {
      public_id: 'em_test-status',
      related_type: 'marketing_bulk_send_test',
    });
    return {
      public_id: 'em_test-status',
      status: 'delivered',
      last_event_type: 'delivery',
      last_error_code: null,
      last_error_message: null,
      sent_at: new Date('2026-09-24T07:22:01Z'),
      delivered_at: new Date('2026-09-24T07:22:00Z'),
      updated_at: new Date('2026-09-24T07:22:01Z'),
      metadata: { list_id: messageListId, item_id: 823244 },
      recipient_email_envelope: 'must-not-be-exposed',
    };
  });

  const scope = { scope: 'clinic', clinicIds: [63], groupId: null };
  const status = await service.getEmailTestStatus(scope, 815, 'em_test-status');
  assert.equal(status.status, 'delivered');
  assert.equal(status.provider_status, 'delivery');
  assert.equal(status.email_message_id, 'em_test-status');
  assert.equal(Object.hasOwn(status, 'recipient_email_envelope'), false);

  messageListId = 999;
  await assert.rejects(
    service.getEmailTestStatus(scope, 815, 'em_test-status'),
    (error) => error?.status === 404
  );
});
