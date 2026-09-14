'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const vm = require('node:vm'); const fs = require('node:fs'); const http = require('node:http'); const express = require('express');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
test('legacy mutation containment cannot intercept the separate provider webhook or invoke signup callbacks', async t => {
  let businessCalls = 0; let authCalls = 0;
  const exported = { exports: {} };
  const fakeRequire = name => {
    if (name === 'express') return express;
    if (name === './auth.middleware') return (req, res, next) => { authCalls++; return req.get('authorization') === 'Bearer FICTITIOUS' ? next() : res.sendStatus(401); };
    if (name === '../lib/metaQuarantineHttp') return require('../../lib/metaQuarantineHttp');
    if (name === '../controllers/whatsapp.controller') return new Proxy({}, { get: () => (_req, res) => { businessCalls++; res.sendStatus(204); } });
    throw Error('unexpected_test_dependency');
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../routes/whatsapp.routes'), 'utf8'), { module: exported, require: fakeRequire });
  const app = express(); app.use('/api/whatsapp', exported.exports);
  app.post('/api/whatsapp/webhook', require('../../lib/whatsappWebhookContainment'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const agent = new http.Agent(); agent.createConnection = connectionForTestServer(server);
  t.after(() => { agent.destroy(); return new Promise(resolve => server.close(resolve)); });
  const send = (path, auth) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, path, method: 'POST',
      headers: auth ? { authorization: 'Bearer FICTITIOUS' } : {} }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, retry: res.headers['retry-after'] }));
    }); req.on('error', reject); req.end();
  });
  for (const path of ['/api/whatsapp/webhook', '/api/whatsapp/webhook/', '/api/whatsapp/WEBHOOK']) {
    const webhook = await send(path); assert.equal(webhook.status, 503); assert.equal(webhook.retry, '60'); assert.equal(authCalls, 0);
  }
  for (const path of ['/api/whatsapp/embedded-signup/callback','/api/whatsapp/messages','/api/whatsapp/templates']) {
    assert.equal((await send(path, true)).status, 503); assert.equal((await send(path, false)).status, 401);
  }
  assert.equal(businessCalls, 0);
});
