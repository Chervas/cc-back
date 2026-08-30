'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const db = require('../../../models');
const metaClient = require('../../lib/metaClient');

function patchProperty(object, key, value) {
  const previous = object[key];
  object[key] = value;
  return () => { object[key] = previous; };
}

test('metaGet respeta la pausa persistida sin llamar a Graph', async () => {
  metaClient._test.resetState();
  let graphCalls = 0;
  const pauseUntil = new Date(Date.now() + 30 * 60 * 1000);
  const restores = [
    patchProperty(db.ApiUsageCounter, 'findOne', async () => ({ pauseUntil })),
    patchProperty(axios, 'get', async () => {
      graphCalls += 1;
      return { status: 200, data: {} };
    }),
  ];
  try {
    await assert.rejects(
      () => metaClient.metaGet('me', { accessToken: 'not-used' }),
      (error) => error.code === 'META_RATE_LIMIT_PAUSED' && error.retryable === false
    );
    assert.equal(graphCalls, 0);
  } finally {
    restores.reverse().forEach((restore) => restore());
    metaClient._test.resetState();
  }
});

test('metaGet corta el lote en el primer rate limit y persiste cooldown', async () => {
  metaClient._test.resetState();
  let graphCalls = 0;
  const counter = {
    usageDate: new Date().toISOString().slice(0, 10),
    requestCount: 0,
    usagePct: 0,
    pauseUntil: null,
    metadata: {},
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
    async reload() { return this; },
  };
  const restores = [
    patchProperty(db.ApiUsageCounter, 'findOne', async () => null),
    patchProperty(db.ApiUsageCounter, 'findOrCreate', async () => [counter, false]),
    patchProperty(axios, 'get', async () => {
      graphCalls += 1;
      const error = new Error('Application request limit reached');
      error.response = { status: 400, data: { error: { code: 4, message: 'Application request limit reached' } } };
      throw error;
    }),
  ];
  const previousDelay = process.env.METASYNC_REQUEST_DELAY_MS;
  process.env.METASYNC_REQUEST_DELAY_MS = '0';
  try {
    await assert.rejects(
      () => metaClient.metaGet('me', { accessToken: 'test-token' }),
      (error) => error.metaRateLimited === true && error.pauseUntil instanceof Date
    );
    assert.equal(graphCalls, 1);
    assert.equal(counter.usagePct, 100);
    assert.ok(new Date(counter.pauseUntil).getTime() > Date.now());
  } finally {
    if (previousDelay === undefined) delete process.env.METASYNC_REQUEST_DELAY_MS;
    else process.env.METASYNC_REQUEST_DELAY_MS = previousDelay;
    restores.reverse().forEach((restore) => restore());
    metaClient._test.resetState();
  }
});
