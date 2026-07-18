'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const jobRequestsService = require('../../services/jobRequests.service');

test('enqueueUnique reutiliza la transaccion de dominio como outbox atomico', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const calls = [];
  const JobRequestModel = {
    findOne: async (options) => {
      calls.push(['find', options]);
      return null;
    },
    create: async (values, options) => {
      calls.push(['create', values, options]);
      return { id: 515, ...values };
    },
  };
  const sequelizeInstance = {
    literal: (value) => ({ literal: value }),
    where: (...args) => ({ where: args }),
    transaction: async () => {
      throw new Error('no debe abrir una transaccion anidada');
    },
  };
  const result = await jobRequestsService.enqueueUniqueJobRequest({
    type: 'marketing_web.landing_published.v1',
    payload: { event_id: 'webpub:event-0001' },
    dedupeScope: 'webpub:event-0001',
    origin: 'test',
  }, { transaction, JobRequestModel, sequelizeInstance });

  assert.equal(result.created, true);
  assert.equal(result.job.id, 515);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].transaction, transaction);
  assert.equal(calls[1][2].transaction, transaction);
  assert.equal(calls[1][1].payload.__dedupe_scope, 'webpub:event-0001');
});
