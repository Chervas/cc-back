'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { grantDiagnostics } = require('../src/whatsapp-grant-diagnostics');
test('Rejected grant diagnostics distinguish simultaneous compatibility and scope failures without copying provider values', () => {
  const sensitive = 'FICTITIOUS_PRIVATE_VALUE';
  const data = { is_valid: true, type: 'SYSTEM_USER', app_id: '101', user_id: '201', expires_at: 0,
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging', 'public_profile'],
    granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['301'] }, { scope: 'whatsapp_business_messaging', target_ids: ['301'] }],
    access_token: sensitive, application: sensitive, error: { message: sensitive } };
  const d = grantDiagnostics({ data }, { appId: '101', wabaId: '301' }, Date.now());
  assert(d.includes('wa_grant_scope_profile_present')); assert(d.includes('wa_grant_data_expiry_missing'));
  assert(d.includes('wa_grant_granular_management_exact')); assert(d.includes('wa_grant_granular_messaging_exact'));
  assert(d.includes('wa_grant_scope_other_absent')); assert(d.includes('wa_grant_expiry_zero'));
  assert.equal(d.length, 17); assert(!JSON.stringify(d).includes(sensitive));
  for (const key of Object.keys(data)) {
    const result = grantDiagnostics({ data: { ...data, [key]: sensitive } }, { appId: '101', wabaId: '301' }, Date.now());
    assert(result.length <= 17); assert(!JSON.stringify(result).includes(sensitive));
    assert(result.every(value => /^wa_grant_[a-z_]+$/.test(value) && value.length < 128));
  }
  const wrong = grantDiagnostics({ data: { ...data, scopes: [...data.scopes, 'ads_management'], granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['301','999'] }], data_access_expires_at: 1 } }, { appId: '101', wabaId: '301' }, Date.now());
  assert(wrong.includes('wa_grant_scope_other_present')); assert(wrong.includes('wa_grant_granular_management_multiple'));
  assert(wrong.includes('wa_grant_granular_messaging_missing')); assert(wrong.includes('wa_grant_data_expiry_expired'));
  assert(d.includes('wa_grant_exchange_expiry_unspecified'));
  const now = 1700000000000;
  const finite = { ...data, expires_at: now / 1000 + 30 };
  assert(grantDiagnostics({ data: finite }, { appId: '101', wabaId: '301', exchangeExpiresAt: now + 60000 }, now).includes('wa_grant_exchange_expiry_consistent'));
  assert(grantDiagnostics({ data }, { appId: '101', wabaId: '301', exchangeExpiresAt: now + 60000 }, now).includes('wa_grant_exchange_expiry_conflict'));
  assert(grantDiagnostics({ data, error: sensitive }, { appId: '101', wabaId: '301' }, now).includes('wa_grant_provider_error_present'));
});
