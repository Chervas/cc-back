'use strict';
require('./offline-guard.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ready, ACCOUNT, PAGE, rawEvent, acceptPayload } = require('./meta-marketing-leads-fixture.cjs');
const L = require('../src/meta-marketing-leads-contract');
const F = require('../src/meta-marketing-lead-form-response');
const ANSWER = 'FICTITIOUS_PRIVATE_FORM_ANSWER';
async function setup(t, { organic = false } = {}) {
  const r = await ready(t);
  const receipt = (await r.execute('receiptAccept', acceptPayload(rawEvent(organic ? null : '603')))).data.receipts[0];
  if (organic) { r.state.adId = null; r.state.organic = true; }
  r.payload = { adAccountAssetRef: ACCOUNT, receiptRef: receipt.receiptRef, responseVersion: 2 };
  return r;
}

test('explicit response v2 preserves owned structured answers and paid identity without persisting answers in the broker', async t => {
  const r = await setup(t);
  r.state.formQuestions = [{ id: '111', key: 'nombre', type: 'FULL_NAME', label: 'Nombre y apellidos' },
    { key: 'telefono', type: 'PHONE', label: 'Teléfono' },
    { key: 'consulta', type: 'CUSTOM', label: '¿Qué información necesitas?' },
    { key: 'sin_responder', type: 'CUSTOM' }, { key: 'vacía', type: 'CUSTOM', label: '' }];
  r.state.leadFields = [{ name: 'nombre', values: ['FICTITIOUS CONTACT'] }, { name: 'telefono', values: ['+34600000000'] },
    { name: 'consulta', values: [ANSWER, 'Segunda opción\nSegunda línea'] }, { name: 'vacía', values: [''] }];
  const data = (await r.execute('receiptRead', r.payload)).data;
  assert.deepEqual(data.identity, { account_id: '301', campaign_id: '601', ad_id: '603', adset_id: '602' });
  assert.equal(data.recipientClinicId, 71);
  assert.deepEqual(data.lead.field_data, [{ name: 'full_name', values: ['FICTITIOUS CONTACT'] }, { name: 'phone_number', values: ['+34600000000'] }]);
  assert.deepEqual(data.form_response, { version: 2, formId: '702', name: 'Formulario ficticio', fields: [
    { key: 'nombre', type: 'FULL_NAME', label: 'Nombre y apellidos', values: ['FICTITIOUS CONTACT'] },
    { key: 'telefono', type: 'PHONE', label: 'Teléfono', values: ['+34600000000'] },
    { key: 'consulta', type: 'CUSTOM', label: '¿Qué información necesitas?', values: [ANSWER, 'Segunda opción\nSegunda línea'] },
    { key: 'sin_responder', type: 'CUSTOM', label: 'sin_responder', values: [] },
    { key: 'vacía', type: 'CUSTOM', label: '', values: [''] },
  ] });
  assert.equal(r.state.calls.length, 9);
  assert.equal(r.state.calls.find(c => c.path === '/v24.0/702').fields, 'id,name,page_id,status,questions{key,type,label}');
  const beforeContact = r.state.calls.findIndex(c => c.path === '/v24.0/603');
  assert(beforeContact < r.state.calls.findIndex(c => c.fields?.includes('field_data')));
  for (let i = 1; i < r.state.calls.length; i++) assert(r.state.calls[i].at - r.state.calls[i - 1].at >= 1000);
  const journal = JSON.stringify(r.current.store.db.prepare('SELECT * FROM commands').all())
    + JSON.stringify(r.current.store.db.prepare('SELECT * FROM audit_outbox').all())
    + JSON.stringify(r.current.store.db.prepare('SELECT * FROM meta_marketing_lead_receipts').all());
  for (const value of [ANSWER, 'FICTITIOUS CONTACT', 'Segunda línea', '¿Qué información necesitas?']) assert(!journal.includes(value));
  assert.equal(r.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_lead_receipts').get().n, 1);
});

test('old receipt payload keeps contact-only DTO and v2 cannot be smuggled into its response', async t => {
  const r = await setup(t);
  const { responseVersion, ...legacy } = r.payload;
  const data = (await r.execute('receiptRead', legacy)).data;
  assert(!Object.hasOwn(data, 'form_response'));
  assert(!JSON.stringify(data).includes('NEVER_RETURN'));
  assert.equal(r.state.calls.find(c => c.path === '/v24.0/702').fields, 'id,name,page_id,status,questions{key,type}');
  assert.throws(() => L.validateResponse(L.OPERATIONS.receiptRead, { ...data, form_response: { version: 2 } }, legacy), { code: 'provider_failed' });
  assert.throws(() => L.validateResponse(L.OPERATIONS.receiptRead, data, r.payload), { code: 'provider_failed' });
});

test('v2 organic receipt retains explicit route, empty arrays and known Meta provenance without inventing an Ad', async t => {
  const r = await setup(t, { organic: true });
  r.state.formQuestions = [{ key: 'phone_number', type: 'PHONE' }, { key: 'optional', type: 'CUSTOM' }];
  r.state.leadFields = [{ name: 'phone_number', values: ['+34600000000'] }, { name: 'optional', values: [] }];
  const data = (await r.execute('receiptRead', r.payload)).data;
  assert.equal(data.identity, null); assert.equal(data.lead.ad_id, null); assert.equal(data.lead.is_organic, true);
  assert.equal(data.recipientClinicId, 71); assert.deepEqual(data.form_response.fields[1].values, []);
  assert.equal(r.state.calls.length, 8);
});

test('unknown, malformed or duplicate answer rows fail closed instead of silently dropping v2 form data', async t => {
  for (const fields of [[{ name: 'NOT_A_QUESTION', values: [ANSWER] }],
    [{ name: 'medical_condition', values: [ANSWER] }, { name: 'medical_condition', values: [ANSWER] }],
    [{ name: 'medical_condition', values: [ANSWER], unrequested: true }],
    [{ name: 'medical_condition', values: [123] }], [{ name: 'medical_condition', values: ['bad\u0000answer'] }],
    [{ name: 'medical_condition', values: Array.from({ length: 51 }, () => ANSWER) }],
    [{ name: 'medical_condition', values: ['x'.repeat(4097)] }]]) {
    const r = await setup(t); r.state.leadFields = fields;
    await assert.rejects(r.execute('receiptRead', r.payload), { code: 'provider_failed' });
  }
});

test('question labels are bounded provider metadata and missing labels use only the exact field key', () => {
  assert.deepEqual(F.questions([{ key: 'literal_key', type: 'CUSTOM' }]), [{ key: 'literal_key', type: 'CUSTOM', label: 'literal_key' }]);
  assert.deepEqual(F.questions([{ key: 'literal_key', type: 'CUSTOM', label: null }]), [{ key: 'literal_key', type: 'CUSTOM', label: 'literal_key' }]);
  for (const value of [undefined, null, [{ key: 'x', type: 'CUSTOM', label: 3 }], [{ key: 'x', type: 'CUSTOM', label: 'x'.repeat(513) }],
    [{ key: 'x', type: 'CUSTOM', label: 'bad\nlabel' }], [{ key: 'x', type: 'CUSTOM', options: [] }],
    [{ key: 'x', type: 'CUSTOM' }, { key: 'x', type: 'CUSTOM' }], [{ key: 'x', type: 'custom' }],
    [{ key: 'x', type: 'CUSTOM', id: 'bad' }], [{ key: 'x'.repeat(257), type: 'CUSTOM' }],
    Array.from({ length: 101 }, (_, i) => ({ key: String(i), type: 'CUSTOM' }))]) {
    assert.throws(() => F.questions(value), { code: 'provider_failed' });
  }
});

test('an explicitly empty owned form returns an empty response without manufacturing fields or contacts', async t => {
  const r = await setup(t, { organic: true }); r.state.formQuestions = []; r.state.leadFields = [];
  const data = (await r.execute('receiptRead', r.payload)).data;
  assert.deepEqual(data.form_response, { version: 2, formId: '702', name: 'Formulario ficticio', fields: [] });
  assert.deepEqual(data.lead.field_data, []); assert.equal(data.identity, null);
});

test('question or form mismatch fails before reading any contact or custom answer', async t => {
  for (const mutate of [r => { r.state.formPage = '999'; },
    r => { r.state.formQuestions = [{ key: 'x', type: 'CUSTOM', access_token: 'UNREQUESTED' }]; },
    r => { r.state.formQuestions = undefined; }]) {
    const r = await setup(t); mutate(r);
    await assert.rejects(r.execute('receiptRead', r.payload), error => ['provider_failed', 'scope_denied'].includes(error.code));
    assert(!r.state.calls.some(c => c.fields?.includes('field_data')));
  }
});

test('response v2 remains bounded by a private 64KiB form budget and exact form identity', async t => {
  const response = { version: 2, formId: '702', name: 'Fictitious', fields: [] };
  assert.deepEqual(F.validateFormResponse(response, '702'), response);
  assert.throws(() => F.validateFormResponse(response, '999'), { code: 'provider_failed' });
  assert.throws(() => F.validateFormResponse({ ...response, url: 'https://example.invalid' }, '702'), { code: 'provider_failed' });
  const r = await setup(t);
  r.state.formQuestions = Array.from({ length: 16 }, (_, i) => ({ key: 'custom_' + i, type: 'CUSTOM' }));
  r.state.leadFields = r.state.formQuestions.map(q => ({ name: q.key, values: ['x'.repeat(4096)] }));
  await assert.rejects(r.execute('receiptRead', r.payload), { code: 'provider_failed' });
});

test('responseVersion negotiation rejects other versions and authority extras before any provider read', () => {
  const base = { adAccountAssetRef: ACCOUNT, receiptRef: randomUUID() };
  L.validate(L.OPERATIONS.receiptRead, base); L.validate(L.OPERATIONS.receiptRead, { ...base, responseVersion: 2 });
  for (const version of [1, 3, '2', null, false]) assert.throws(() => L.validate(L.OPERATIONS.receiptRead, { ...base, responseVersion: version }), { code: 'invalid_request' });
  assert.throws(() => L.validate(L.OPERATIONS.receiptRead, { ...base, responseVersion: 2, formId: '702' }), { code: 'invalid_request' });
});

test('v2 keeps receipt expiry, route and revocation fences and shares provider cooldown', async t => {
  const expired = await setup(t);
  expired.current.store.db.prepare('UPDATE meta_marketing_lead_receipts SET expires_at=? WHERE id=?').run(expired.f.now(), expired.payload.receiptRef);
  await assert.rejects(expired.execute('receiptRead', expired.payload), { code: 'meta_lead_receipt_review_required' });
  assert.equal(expired.state.calls.length, 0);
  const routed = await setup(t); routed.config.pairs[0].recipientClinicId = 72;
  await assert.rejects(routed.execute('receiptRead', routed.payload), { code: 'meta_lead_receipt_review_required' });
  assert.equal(routed.state.calls.length, 0);
  const revoked = await setup(t); let changed = false;
  revoked.state.before = url => { if (!changed && url.pathname === '/v24.0/702') {
    changed = true; revoked.current.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)')
      .run('clinic:71', revoked.f.binding.connectionRef, PAGE, randomUUID(), revoked.f.now());
  } };
  await assert.rejects(revoked.execute('receiptRead', revoked.payload), { code: 'asset_revoked' });
  assert(!revoked.state.calls.some(c => c.fields?.includes('field_data')));
  const limited = await setup(t); limited.state.status = 429;
  await assert.rejects(limited.execute('receiptRead', limited.payload), error => error.code === 'rate_limited' && error.retryAfterMs === 7200000);
  const calls = limited.state.calls.length;
  assert.equal(calls, 2); // Credential validation, then the first Page read gets 429.
  await assert.rejects(limited.execute('receiptRead', limited.payload), error => error.code === 'rate_limited' && error.retryAfterMs > 0);
  assert.equal(limited.state.calls.length, calls);
});
