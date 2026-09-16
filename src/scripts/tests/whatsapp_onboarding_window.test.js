'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs');
const { webcrypto, randomUUID } = require('node:crypto');
const source = fs.readFileSync(require.resolve('../../web/whatsapp-onboarding-window'), 'utf8');
function fixture(t) {
  const messages = []; const listeners = new Map(); const script = []; let callback; let options;
  const elements = Object.fromEntries(['status','authorize','cancel'].map(id => [id, { disabled: id !== 'status', textContent: '', addEventListener: (event, fn) => { elements[id][event] = fn; } }]));
  const parent = { postMessage: (data, origin) => messages.push({ data: JSON.parse(JSON.stringify(data)), origin }) };
  const win = { crypto: webcrypto, parent, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    FB: { init: v => { win.init = v; }, login: (cb, v) => { callback = cb; options = v; } } };
  const timers = new Set(); const scheduled = []; const schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); scheduled.push({ fn, ms }); return timer; };
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const doc = { getElementById: id => elements[id], createElement: () => ({}), head: { appendChild: value => script.push(value) } };
  vm.runInNewContext(source, { window: win, document: doc, URL, Date, Uint8Array, setTimeout: schedule, clearTimeout });
  const receive = (data, origin = 'https://crm.clinicaclick.com', from = parent) => listeners.get('message')?.({ data, origin, source: from });
  receive({ type: 'cc.wa.hello' }); const nonce = messages[0].data.nonce;
  const input = { type: 'cc.wa.init', nonce, requestId: randomUUID(), expiresAt: Date.now() + 300000, mode: 'cloud_api',
    authorization: { appId: '101', configId: '201', redirectUri: 'https://app.clinicaclick.com/', state: 's'.repeat(43) } };
  const start = (v = input) => { receive(v); script.at(-1).onload(); elements.authorize.click(); };
  const finishEvent = (data = { waba_id: '301', phone_number_id: '401' }) => JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data });
  const meta = (data = finishEvent(), origin = 'https://www.facebook.com', from = {}) => receive(data, origin, from);
  return { messages, listeners, receive, input, win, parent, start, script, elements, meta, finishEvent, scheduled, code: value => callback(value), options: () => options };
}
test('Sandbox handshake accepts only the bound parent origin, nonce and exact unexpired public configuration', t => {
  const f = fixture(t);
  f.receive(f.input, 'https://other.invalid'); f.receive(f.input, 'https://crm.clinicaclick.com', {});
  for (const change of [{ nonce: 'x'.repeat(64) }, { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 1900000 }, { mode: 'ads' },
    { authorization: { ...f.input.authorization, accessToken: 'FICTITIOUS_SECRET' } }, { authorization: { ...f.input.authorization, redirectUri: 'https://app.clinicaclick.com/?token=FICTITIOUS' } }]) f.receive({ ...f.input, ...change });
  assert.equal(f.script.length, 0); f.start(); assert.equal(f.script.length, 1);
  assert.equal(f.options().response_type, 'code'); assert.equal(f.options().config_id, '201');
  assert.equal(Object.hasOwn(f.options(), 'redirect_uri'), false);
  assert.equal(f.options().extras.sessionInfoVersion, '3'); assert.equal(f.win.init.cookie, false);
  f.receive(f.input); assert.equal(f.script.length, 1); assert.equal(f.messages[0].origin, 'https://crm.clinicaclick.com');
});
test('Only this SDK callback plus validated Meta selection can produce one result; hostile origins and late events are ignored', t => {
  const f = fixture(t); f.start();
  f.meta(f.finishEvent(), 'https://www.facebook.com.evil.invalid'); f.meta(f.finishEvent(), 'https://www.facebook.com', f.parent);
  f.code({ authResponse: { code: 'FICTITIOUS_CODE' } }); assert.equal(f.messages.length, 1);
  f.meta(f.finishEvent({ waba_id: 301, phone_number_id: '401' })); assert.equal(f.messages.length, 1);
  f.meta(); assert.equal(f.messages.length, 2); assert.equal(f.messages[1].data.type, 'cc.wa.result');
  assert.equal(f.messages[1].data.requestId, f.input.requestId); assert.equal(f.messages[1].data.wabaId, '301');
  assert.equal(f.messages[1].data.code, 'FICTITIOUS_CODE'); assert(!Object.hasOwn(f.messages[1].data, 'state'));
  f.meta(); f.code({ authResponse: { code: 'FICTITIOUS_CODE_2' } }); assert.equal(f.messages.length, 2); assert.equal(f.listeners.size, 0);
});
test('Bearer responses, conflicting selections and provider errors emit only fixed failure codes', t => {
  const bearer = fixture(t); bearer.start(); bearer.code({ authResponse: { accessToken: 'FICTITIOUS_SECRET', code: 'FICTITIOUS_CODE' } });
  assert.equal(bearer.messages.at(-1).data.reason, 'authorization_incomplete'); assert(!JSON.stringify(bearer.messages).includes('FICTITIOUS'));
  const conflict = fixture(t); conflict.start(); conflict.meta(); conflict.meta(conflict.finishEvent({ waba_id: '302', phone_number_id: '402' }));
  assert.equal(conflict.messages.at(-1).data.reason, 'selection_conflict');
  const provider = fixture(t); provider.start(); provider.meta(JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', error_message: 'FICTITIOUS_SECRET' }));
  assert.equal(provider.messages.at(-1).data.reason, 'provider_error'); assert(!JSON.stringify(provider.messages).includes('FICTITIOUS'));
});
test('documented WABA-only completion is accepted only for coexistence and leaves phone resolution to the broker', t => {
  const complete = JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: '301' }, version: 3 });
  const f = fixture(t); f.start({ ...f.input, mode: 'coexistence' });
  f.meta(complete); f.code({ authResponse: { code: 'FICTITIOUS_CODE' } });
  assert.equal(f.messages.at(-1).data.type, 'cc.wa.result'); assert.equal(f.messages.at(-1).data.phoneId, null);
  const other = fixture(t); other.start(); other.meta(complete); other.code({ authResponse: { code: 'FICTITIOUS_CODE' } });
  assert.equal(other.messages.length, 1);
});
test('Coexistence is selected explicitly and cancel never emits a partial code or account', t => {
  const f = fixture(t); f.start({ ...f.input, mode: 'coexistence' });
  assert.equal(f.options().extras.featureType, 'whatsapp_business_app_onboarding');
  assert.equal(f.options().extras.sessionInfoVersion, '3');
  f.code({ authResponse: { code: 'FICTITIOUS_CODE' } }); f.elements.cancel.click();
  assert.equal(f.messages.at(-1).data.type, 'cc.wa.cancel'); assert(!JSON.stringify(f.messages).includes('FICTITIOUS_CODE'));
});
test('Partial Meta returns explain the missing half without submitting, retrying or leaking it; late completion remains single-use', t => {
  for (const first of ['code', 'selection']) {
    const f = fixture(t); f.start();
    if (first === 'code') f.code({ authResponse: { code: 'FICTITIOUS_CODE' } }); else f.meta();
    assert.match(f.elements.status.textContent, first === 'code' ? /Esperando los datos/ : /Esperando la confirmación/);
    assert.equal(f.messages.length, 1);
    const reminder = f.scheduled.find(value => value.ms === 25000); assert(reminder); reminder.fn();
    assert.match(f.elements.status.textContent, /Meta no ha devuelto todos los datos/);
    assert.equal(f.messages.length, 1); assert.equal(f.elements.cancel.disabled, false);
    assert(!f.elements.status.textContent.includes('FICTITIOUS_CODE'));
    if (first === 'code') f.meta(); else f.code({ authResponse: { code: 'FICTITIOUS_CODE' } });
    assert.equal(f.messages.length, 2); assert.equal(f.messages.at(-1).data.type, 'cc.wa.result');
    reminder.fn(); assert.match(f.elements.status.textContent, /Autorización recibida/);
    f.meta(); f.code({ authResponse: { code: 'FICTITIOUS_LATE_CODE' } }); assert.equal(f.messages.length, 2);
  }
});
