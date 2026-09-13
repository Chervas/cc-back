'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { fixture, tokenMetadata, SEND_TOKEN, APP_SECRET } = require('./whatsapp-fixture.cjs');
const { verifyWhatsappGrant } = require('../src/whatsapp-credential-inspector');
const expected = () => ({ appId: '101', subjectId: '201', wabaId: '301', scopes: ['whatsapp_business_messaging'] });
test('verified WhatsApp grant projects only matching identity, scope, WABA and expiry', () => {
  const raw = tokenMetadata(); raw.data.application = 'PRIVATE_PROVIDER_LABEL'; raw.data.extra = SEND_TOKEN;
  assert.deepEqual(verifyWhatsappGrant(raw, expected()), { appId: '101', subjectId: '201', wabaId: '301', tokenType: 'SYSTEM_USER',
    scopes: ['whatsapp_business_messaging'], expiresAt: null, dataAccessExpiresAt: null });
});
const changes = {
  invalid: d => { d.is_valid = false; },
  otherApp: d => { d.app_id = '999'; },
  otherIdentity: d => { d.user_id = '999'; },
  appToken: d => { d.type = 'APP'; },
  ads: d => { d.scopes.push('ads_management'); },
  leads: d => { d.scopes.push('leads_retrieval'); },
  pages: d => { d.scopes.push('pages_manage_metadata'); },
  business: d => { d.scopes.push('business_management'); },
  managementInSender: d => { d.scopes.push('whatsapp_business_management'); },
  missingScope: d => { d.scopes = []; },
  duplicateScope: d => { d.scopes.push(d.scopes[0]); },
  missingGranularity: d => { delete d.granular_scopes; },
  noTarget: d => { delete d.granular_scopes[0].target_ids; },
  duplicateGranularity: d => { d.granular_scopes.push(d.granular_scopes[0]); },
  wrongGranularity: d => { d.granular_scopes[0].scope = 'ads_management'; },
  foreignWaba: d => { d.granular_scopes[0].target_ids = ['999']; },
  multipleWabas: d => { d.granular_scopes[0].target_ids.push('999'); },
  numberInsteadOfWaba: d => { d.granular_scopes[0].target_ids = ['401']; },
  expiredToken: d => { d.expires_at = 1; },
  expiredDataAccess: d => { d.data_access_expires_at = 1; },
  missingExpiry: d => { delete d.expires_at; },
  missingDataAccessExpiry: d => { delete d.data_access_expires_at; },
  stringExpiry: d => { d.expires_at = '0'; },
  unsafeExpiry: d => { d.expires_at = Number.MAX_SAFE_INTEGER; },
};
for (const [name, change] of Object.entries(changes)) test('provider evidence ' + name + ' cannot be replaced by stored credential claims', async t => {
  const f = fixture(t); const raw = tokenMetadata(); change(raw.data); f.inspectResponse(() => raw); let sends = 0;
  const broker = f.makeBroker(async () => { sends++; return { messaging_product: 'whatsapp', messages: [{ id: 'wamid.FORBIDDEN' }] }; });
  await assert.rejects(f.execute(broker, f.command()), e => ['scope_denied', 'oauth_identity_mismatch', 'oauth_credentials_incomplete', 'credential_revoked'].includes(e.code));
  assert.equal(sends, 0); assert.equal(f.inspections.length, 1);
  assert(f.inspections[0].candidate.every(byte => byte === 0)); assert(f.inspections[0].token.every(byte => byte === 0));
  assert.equal(f.store.db.prepare('SELECT state FROM commands').get().state, 'unknown');
  const audit = JSON.stringify(f.store.db.prepare('SELECT event FROM audit_outbox').all());
  for (const value of [SEND_TOKEN, APP_SECRET]) assert(!audit.includes(value));
});
test('inspection is performed for each use; changed permissions on the same pinned secret prevent another POST', async t => {
  const f = fixture(t); let sends = 0; const broker = f.makeBroker(async () => { sends++; return { messaging_product: 'whatsapp', messages: [{ id: 'wamid.ACCEPTED' }] }; });
  await f.execute(broker, f.command());
  f.inspectResponse(() => { const response = tokenMetadata(); response.data.scopes.push('ads_read'); return response; });
  await assert.rejects(f.execute(broker, f.command()), { code: 'oauth_credentials_incomplete' }); assert.equal(sends, 1); assert.equal(f.inspections.length, 2);
});
test('Meta invalidation is persisted and subsequent messages do not fetch credentials or probe Meta again', async t => {
  const f = fixture(t); f.inspectResponse(() => ({ data: { is_valid: false } }));
  const broker = f.makeBroker(async () => { throw Error('PROVIDER_WRITE_FORBIDDEN'); });
  await assert.rejects(f.execute(broker, f.command()), { code: 'credential_revoked' });
  const reads = f.calls.length;
  await assert.rejects(f.execute(broker, f.command()), { code: 'connection_blocked' }); assert.equal(f.calls.length, reads); assert.equal(f.inspections.length, 1);
});
test('inspection deadline/abort propagates before provider execution and wipes credentials', async t => {
  const f = fixture(t); const controller = new AbortController(); let called = false;
  f.inspectResponse(() => { controller.abort(); return tokenMetadata(); });
  await assert.rejects(f.secrets.withSecret(f.binding, async () => { called = true; return {}; }, { signal: controller.signal }), { code: 'provider_timeout' });
  assert.equal(called, false); assert(f.inspections[0].candidate.every(byte => byte === 0)); assert(f.inspections[0].token.every(byte => byte === 0));
});
test('grants for enrollment can explicitly request WhatsApp management and identity, but cannot include Ads', () => {
  const scope = ['whatsapp_business_management', 'public_profile']; const raw = tokenMetadata(true); raw.data.scopes = scope;
  assert.deepEqual(verifyWhatsappGrant(raw, { ...expected(), subjectId: '202', scopes: scope }).scopes, [...scope].sort());
  assert.throws(() => verifyWhatsappGrant(raw, { ...expected(), scopes: ['ads_read'] }), { code: 'invalid_request' });
});
