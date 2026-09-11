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

test('interactive Meta checks can disable retries without bypassing the shared client', async () => {
  metaClient._test.resetState();
  let calls = 0;
  const restores = [
    patchProperty(db.ApiUsageCounter, 'findOne', async () => null),
    patchProperty(axios, 'get', async () => { calls++; throw Object.assign(new Error('provider unavailable'), { response: { status: 503 } }); }),
  ];
  const previousDelay = process.env.METASYNC_REQUEST_DELAY_MS;
  process.env.METASYNC_REQUEST_DELAY_MS = '0';
  try {
    await assert.rejects(metaClient.metaGet('30/ads', { accessToken: 'test-token', maxRetries: 0 }), /provider unavailable/);
    assert.equal(calls, 1);
  } finally {
    if (previousDelay === undefined) delete process.env.METASYNC_REQUEST_DELAY_MS;
    else process.env.METASYNC_REQUEST_DELAY_MS = previousDelay;
    restores.reverse().forEach(restore => restore()); metaClient._test.resetState();
  }
});

test('page subscription writes respect the shared quota and never retry an ambiguous provider response', async () => {
  metaClient._test.resetState(); let calls = 0; let paused = true;
  const restores = [
    patchProperty(db.ApiUsageCounter, 'findOne', async () => paused ? { pauseUntil: new Date(Date.now() + 60000) } : null),
    patchProperty(axios, 'post', async (url, body, options) => {
      calls++; assert.ok(url.endsWith('/40/subscribed_apps'));
      assert.deepEqual(body, { subscribed_fields: 'messages,leadgen' }); assert.equal(options.maxRedirects, 0);
      throw Object.assign(new Error('ambiguous provider response'), { response: { status: 503 } });
    }),
  ];
  const delay = process.env.METASYNC_REQUEST_DELAY_MS; process.env.METASYNC_REQUEST_DELAY_MS = '0';
  try {
    await assert.rejects(metaClient.metaSubscribePage('40', ['messages', 'leadgen'], { accessToken: 'private' }), { code: 'META_RATE_LIMIT_PAUSED' });
    assert.equal(calls, 0); paused = false; metaClient._test.resetState();
    await assert.rejects(metaClient.metaSubscribePage('40', ['messages', 'leadgen'], { accessToken: 'private', maxRetries: 3 }), /ambiguous provider response/);
    assert.equal(calls, 1);
    assert.throws(() => metaClient.metaSubscribePage('../me', ['leadgen']), /invalid_page_subscription/);
  } finally {
    if (delay === undefined) delete process.env.METASYNC_REQUEST_DELAY_MS; else process.env.METASYNC_REQUEST_DELAY_MS = delay;
    restores.reverse().forEach(restore => restore()); metaClient._test.resetState();
  }
});

test('conversion writes use the shared pause, reject redirects and redact provider messages', async () => {
  metaClient._test.resetState(); let calls = 0; let paused = true; const logs = [];
  const counter = { usageDate: new Date().toISOString().slice(0, 10), requestCount: 0, usagePct: 0, pauseUntil: null, metadata: {},
    async update(patch) { Object.assign(this, patch); return this; }, async reload() { return this; } };
  const restores = [
    patchProperty(db.ApiUsageCounter, 'findOne', async () => paused ? { pauseUntil: new Date(Date.now() + 60000) } : null),
    patchProperty(db.ApiUsageCounter, 'findOrCreate', async () => [counter, false]),
    patchProperty(console, 'error', (...args) => logs.push(args)),
    patchProperty(axios, 'post', async (url, body, options) => {
      calls++; assert.ok(url.endsWith('/50/events')); assert.equal(options.maxRedirects, 0); assert.equal(body.data.length, 1);
      throw Object.assign(new Error('private contact in provider error'), { response: { status: 400,
        data: { error: { code: 4, type: 'private-type', fbtrace_id: 'private-trace', message: 'private-email' } } } });
    }),
  ];
  const delay = process.env.METASYNC_REQUEST_DELAY_MS; process.env.METASYNC_REQUEST_DELAY_MS = '0';
  try {
    const send = () => metaClient.metaSendConversion('50', { data: [{ event_name: 'Lead' }] }, { accessToken: 'private-token', maxRetries: 3 });
    await assert.rejects(send(), { code: 'META_RATE_LIMIT_PAUSED' }); assert.equal(calls, 0);
    paused = false; metaClient._test.resetState();
    await assert.rejects(send(), { code: 'META_RATE_LIMITED' }); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify([logs, counter]), /private/);
    assert.throws(() => metaClient.metaSendConversion('../me', { data: [{}] }, { accessToken: 'private' }), /invalid_meta_conversion_request/);
    assert.throws(() => metaClient.metaSendConversion('50', { data: [{}, {}] }, { accessToken: 'private' }), /invalid_meta_conversion_request/);
  } finally {
    if (delay === undefined) delete process.env.METASYNC_REQUEST_DELAY_MS; else process.env.METASYNC_REQUEST_DELAY_MS = delay;
    restores.reverse().forEach(restore => restore()); metaClient._test.resetState();
  }
});

test('advertising adjustments enforce deployment gates, a single field, quota and one redirect-free attempt', async () => {
  metaClient._test.resetState(); let calls = 0; let paused = true; const logs = [];
  const restores = [
    patchProperty(db.ApiUsageCounter, 'findOne', async () => paused ? { pauseUntil: new Date(Date.now() + 60000) } : null),
    patchProperty(console, 'error', (...args) => logs.push(args)),
    patchProperty(axios, 'post', async (url, body, options) => {
      calls++; assert.ok(url.endsWith('/50')); assert.deepEqual(body, { bid_amount: '900' }); assert.equal(options.maxRedirects, 0);
      throw Object.assign(new Error('private-provider-detail'), { response: { status: 503 } });
    }),
  ];
  const flags = ['CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED', 'CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED', 'METASYNC_REQUEST_DELAY_MS'];
  const previous = flags.map(name => process.env[name]);
  try {
    delete process.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED; delete process.env.CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED;
    const send = () => metaClient.metaUpdateAdvertisingResource('50', { bid_amount: '900' }, { accessToken: 'private-token', maxRetries: 3 });
    assert.throws(send, /workspace_optimization_disabled/);
    process.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED = 'true'; assert.throws(send, /workspace_optimization_disabled/);
    process.env.CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED = 'true'; process.env.METASYNC_REQUEST_DELAY_MS = '0';
    for (const patch of [{ status: 'ACTIVE' }, { daily_budget: '-1' }, { bid_amount: '900', name: 'rename' },
      { bid_constraints: { roas_average_floor: '10000', unknown: 'value' } }]) {
      assert.throws(() => metaClient.metaUpdateAdvertisingResource('50', patch, { accessToken: 'private-token' }), /invalid_meta_advertising_adjustment/);
    }
    assert.throws(() => metaClient.metaUpdateAdvertisingResource('../50', { status: 'PAUSED' }, { accessToken: 'private-token' }), /invalid_meta_advertising_adjustment/);
    await assert.rejects(send(), { code: 'META_RATE_LIMIT_PAUSED' }); assert.equal(calls, 0);
    paused = false; metaClient._test.resetState(); await assert.rejects(send()); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(logs), /private-/);
  } finally {
    flags.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    restores.reverse().forEach(restore => restore()); metaClient._test.resetState();
  }
});
