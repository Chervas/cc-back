'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { fixture, template } = require('./whatsapp-authorized-fixture.cjs'); const { TOKEN, APP } = require('./whatsapp-onboarding-fixture.cjs');
const C = require('../src/whatsapp-authorized-contract'); const E = require('../src/whatsapp-onboarding-contract');
const { main, createReviewHttp, projectTemplate } = require('../src/whatsapp-authorized-review');
function writeConfig(f) {
  const definition = structuredClone(f.definition); definition.expiresAt = f.f.binding.expiresAt - 1000;
  const policy = structuredClone(f.policy); policy.connections[0].expiresAt = definition.expiresAt;
  const config = { cohort: C.COHORT, enabled: true, listenAddress: '127.0.0.1', port: 19095,
    stateFile: path.join(f.f.dir, 'review-must-not-create.sqlite'), enrollmentStateFile: f.f.filename,
    enrollmentConfigFile: path.join(f.f.dir, 'review-enrollment.json'), tlsKeyFile: path.join(f.f.dir, 'unused.key'),
    tlsCertFile: path.join(f.f.dir, 'unused.crt'), policy, authorizations: [definition] };
  const enrollment = { cohort: E.COHORT, enabled: true, listenAddress: '127.0.0.1', port: 19094, stateFile: f.f.filename,
    tlsKeyFile: config.tlsKeyFile, tlsCertFile: config.tlsCertFile, policy: f.f.policy };
  fs.writeFileSync(config.enrollmentConfigFile, JSON.stringify(enrollment), { mode: 0o600 });
  const filename = path.join(f.f.dir, 'review-authorized.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  return { filename, config };
}
function reviewFixture(f, overrides = {}) {
  const { filename, config } = writeConfig(f); const calls = []; let opened = 0; let closed = 0;
  const http = async request => {
    calls.push({ action: request.action, id: request.id, ...(request.after ? { after: request.after } : {}) });
    assert.notEqual(request.action, 'send'); assert.equal(request.json, undefined);
    if (overrides.http) return overrides.http(request);
    if (request.action === 'review_phone') return { id: '401', status: 'CONNECTED', code_verification_status: 'VERIFIED', quality_rating: 'GREEN',
      is_on_biz_app: true, platform_type: 'CLOUD_API', display_phone_number: 'PRIVATE_NUMBER', verified_name: 'PRIVATE_NAME' };
    if (request.action === 'review_subscriptions') return { data: [{ whatsapp_business_api_data: { id: f.registry.review(f.binding).metadata.appId,
      name: 'PRIVATE_APP_NAME', link: 'https://private.invalid/' } }] };
    if (request.action === 'review_templates') return { data: [template()] };
    return f.http(request);
  };
  const run = () => main(filename, f.binding.connectionRef, { now: f.f.now, http, awsFactory: async () => {
    opened++; return { secrets: f.f.aws, close() { closed++; }, sink: { write() { throw Error('Review must not write audit'); } } };
  } });
  return { run, calls, config, filename, get opened() { return opened; }, get closed() { return closed; } };
}
test('CLI reviews disabled candidate with fresh grant proof and GET metadata without enabling, writing or leaking', async t => {
  const f = await fixture(t, { enabled: false }); const r = reviewFixture(f); const before = f.f.snapshot(); const puts = f.f.state.puts;
  const result = await r.run();
  assert.equal(result.status, 'reviewed_not_activated'); assert.equal(result.sendEnabled, false); assert.equal(result.appSubscribed, true);
  assert.equal(result.phone.id, '401'); assert.equal(result.phone.status, 'CONNECTED'); assert.equal(result.phone.isOnBizApp, true);
  assert.deepEqual(result.templates, [{ id: '901', name: 'appointment_qa', language: 'es', status: 'APPROVED', compatible: true, contentDigest: C.templateDigest(template()) }]);
  for (const action of ['inspect','waba_owner','phones','review_phone','review_subscriptions','review_templates']) assert(r.calls.some(c => c.action === action));
  assert.equal(r.opened, 1); assert.equal(r.closed, 1); assert.equal(fs.existsSync(r.config.stateFile), false);
  assert.equal(f.f.state.puts, puts); assert.equal(f.f.snapshot(), before);
  assert.throws(() => f.registry.assert(f.binding), { code: 'connection_blocked' });
  for (const text of [TOKEN, APP, 'PRIVATE_NUMBER','PRIVATE_NAME','PRIVATE_APP_NAME','https://private.invalid/','FICTITIOUS_IMAGE_HANDLE','Cita {{1}}']) {
    assert(!JSON.stringify(result).includes(text));
  }
  for (const token of f.f.state.heldTokens) assert(token.every(v => v === 0));
});
test('review bypasses only the enabled flag; expiry, scope, candidate and enrollment checks still block', async t => {
  for (const mutation of ['expired','scope','candidate','enrollment']) {
    await t.test(mutation, async t => {
      const f = await fixture(t, { enabled: false }); const r = reviewFixture(f);
      if (mutation === 'expired') f.f.state.clock = r.config.authorizations[0].expiresAt;
      if (mutation === 'scope') f.blockScope();
      if (mutation === 'candidate') f.f.current.store.db.prepare('UPDATE whatsapp_onboarding_flows SET secret_digest=? WHERE id=?').run('0'.repeat(64), f.definition.authorizationId);
      if (mutation === 'enrollment') {
        const v = JSON.parse(fs.readFileSync(r.config.enrollmentConfigFile)); v.policy.connections[0].whatsappOnboarding.configId = '999';
        fs.writeFileSync(r.config.enrollmentConfigFile, JSON.stringify(v));
      }
      await assert.rejects(r.run()); assert.equal(r.opened, 0); assert.equal(r.calls.length, 0); assert.equal(fs.existsSync(r.config.stateFile), false);
    });
  }
});
test('revocation during metadata review stops before another GET and closes resources', async t => {
  const f = await fixture(t, { enabled: false }); const r = reviewFixture(f, { http: async request => {
    if (request.action === 'review_phone') { f.blockScope(); return { id: '401' }; } return f.http(request);
  } });
  await assert.rejects(r.run(), { code: 'asset_revoked' }); assert.equal(r.closed, 1);
  assert(!r.calls.some(c => c.action === 'review_templates' || c.action === 'review_subscriptions'));
});
test('pagination uses only validated cursors and never follows bearer-bearing URLs', async t => {
  const f = await fixture(t, { enabled: false }); const r = reviewFixture(f, { http: async request => {
    if (request.action === 'review_phone') return { id: '401' };
    if (request.action === 'review_subscriptions') return { data: [] };
    if (request.action === 'review_templates') return request.after
      ? { data: [{ ...template(), id: '902', name: 'appointment_qa_second' }] }
      : { data: [template()], paging: { next: 'https://foreign.invalid/?access_token=PRIVATE_TOKEN', cursors: { after: 'cursor_2' } } };
    return f.http(request);
  } });
  const result = await r.run(); assert.equal(result.appSubscribed, false); assert.equal(result.templates.length, 2);
  assert.deepEqual(r.calls.filter(c => c.action === 'review_templates'), [
    { action: 'review_templates', id: '301' }, { action: 'review_templates', id: '301', after: 'cursor_2' }]);
  assert(!JSON.stringify(result).includes('PRIVATE_TOKEN')); assert.equal(result.phone.status, null);
});
test('unsupported template shape is listed with no send digest, without returning private text', () => {
  const value = { ...template(), components: [{ type: 'BODY', text: 'PRIVATE_BODY' }, { type: 'HEADER', format: 'DOCUMENT' }] };
  const result = projectTemplate(value); assert.equal(result.contentDigest, null); assert.equal(result.compatible, false);
  assert(!JSON.stringify(result).includes('PRIVATE_BODY'));
});
function httpFixture({ status = 200, response = { data: [] }, headers = {} } = {}) {
  const calls = [];
  const request = (options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => { calls.push({ options, body }); queueMicrotask(() => { const res = new PassThrough();
      res.statusCode = status; res.headers = { 'content-type': 'application/json', ...headers }; callback(res); res.end(JSON.stringify(response)); }); };
    return req;
  };
  return { calls, request };
}
const input = () => ({ action: 'review_templates', id: '301', token: Buffer.from(TOKEN), proof: 'a'.repeat(64), signal: undefined });
test('review transport allows only fixed GET paths and refuses sends, mutations and URL overrides', async () => {
  const f = httpFixture(); const http = createReviewHttp({ request: f.request });
  for (const action of ['review_phone','review_subscriptions','review_templates']) await http({ ...input(), action });
  for (const call of f.calls) {
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.hostname, 'graph.facebook.com'); assert.equal(call.options.rejectUnauthorized, true);
    assert.equal(call.body, undefined); assert(!call.options.path.includes(TOKEN));
  }
  assert.equal(new URL('https://graph.facebook.com' + f.calls[2].options.path).pathname, '/v24.0/301/message_templates');
  for (const change of [{ action: 'send' }, { action: 'template' }, { action: 'subscribe' }, { json: {} }, { id: '../301' },
    { method: 'POST' }, { url: 'https://foreign.invalid' }, { after: 'https://foreign.invalid' }, { proof: undefined }]) {
    await assert.rejects(http({ ...input(), ...change }), { code: 'invalid_request' });
  }
  assert.equal(f.calls.length, 3);
});
test('review HTTP redirects, compressed responses and credential failures stay fixed and never retry', async () => {
  for (const settings of [{ status: 302, headers: { location: 'https://foreign.invalid' } }, { headers: { 'content-encoding': 'gzip' } },
    { response: { error: { code: 190, message: TOKEN } } }]) {
    const f = httpFixture(settings); await assert.rejects(createReviewHttp({ request: f.request })(input()), error => {
      assert(!error.stack.includes(TOKEN)); assert(['provider_failed','credential_revoked'].includes(error.code)); return true;
    }); assert.equal(f.calls.length, 1);
  }
});
