'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const db = require('../../../models');
const postImport = require('../../services/whatsappFreshPostImport.service');

test.after(async () => {
  await db.sequelize.close();
});

test('el reconciliador no registra dos veces 131042 y conserva otros fallos', async () => {
  const message = {
    id: 701,
    status: 'failed',
    metadata: {
      phone_number_id: 'phone-test',
      waba_id: 'waba-test',
      wa_error: [{ code: 131042 }],
    },
  };
  const genericFailures = [];
  let paymentHandled = true;
  const dependencies = {
    findMessage: async () => message,
    reconcilePayment: async () => ({ handled: paymentHandled }),
    recordHealthFailure: async (input) => {
      genericFailures.push(input);
      return { recorded: true };
    },
    materializeLeadStatus: async () => null,
    materializePatientDirection: async () => null,
    materializeBulkStatus: async () => null,
    materializeDeliveryGovernance: async () => null,
  };

  const paymentFailure = await postImport.reconcileDeliveryStatus({
    clinicId: 56,
    messageId: message.id,
    status: 'failed',
    ...dependencies,
  });
  assert.equal(paymentFailure.reconciled, true);
  assert.equal(genericFailures.length, 0);

  paymentHandled = false;
  message.metadata.wa_error = [{ code: 131031 }];
  const otherFailure = await postImport.reconcileDeliveryStatus({
    clinicId: 56,
    messageId: message.id,
    status: 'failed',
    ...dependencies,
  });
  assert.equal(otherFailure.reconciled, true);
  assert.equal(genericFailures.length, 1);
  assert.equal(genericFailures[0].messageId, message.id);
});
