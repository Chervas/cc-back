'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
require('./fixtures/security_offline_runtime.cjs');

// Exercise the actual route stack without loading the application, DB, queues
// or provider clients. These boundaries throw if containment is bypassed.
test('legacy webhook requests are retryable and cannot reach business processing', async t => {
  const root = path.resolve(__dirname, '../../..');
  const filename = path.join(root, 'src/routes/whatsapp-webhook.routes.js');
  let businessCalls = 0;
  const forbidden = () => { businessCalls++; throw Error('business_processing_forbidden'); };
  const boundary = new Proxy({}, { get: () => forbidden });
  const fakeModels = new Proxy({}, { get: () => boundary });
  const exports = { exports: {} };
  const fakeRequire = name => {
    if (name === 'express') return express;
    if (name === 'crypto') return require('node:crypto');
    if (name === '../lib/whatsappWebhookContainment') return require('../../lib/whatsappWebhookContainment');
    if (name === '../../models') return fakeModels;
    if (name === 'sequelize') return { Op: {} };
    if (name === '../services/queue.service') return { queues: boundary };
    if (name === '../lib/whatsapp-channel-role') return { resolveWhatsappChannelRole: forbidden };
    return boundary;
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: exports, require: fakeRequire, process: { env: {} }, Buffer,
    console: { warn: forbidden, error: forbidden, log: forbidden },
  }, { filename });
  const app = express(); app.use(express.json()); app.use('/api', exports.exports);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const agent = new http.Agent();
  agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
  t.after(() => { agent.destroy(); return new Promise(resolve => server.close(resolve)); });
  for (const suffix of ['', '?clinic_id=123', '?clinic_id=123&bypass=true']) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, agent,
        path: '/api/whatsapp/webhook' + suffix, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } }, res => {
        let body = ''; res.on('data', data => { body += data; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      request.on('error', reject);
      request.end(JSON.stringify({ clinic_id: 123, entry: [{ id: 'synthetic', changes: [] }] }));
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers['retry-after'], '60');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(response.body), { error: 'whatsapp_ingress_unavailable' });
  }
  assert.equal(businessCalls, 0);
});
