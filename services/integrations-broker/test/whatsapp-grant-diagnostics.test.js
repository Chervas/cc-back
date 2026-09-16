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
  assert.equal(d.length, 23); assert(!JSON.stringify(d).includes(sensitive));
  for (const key of Object.keys(data)) {
    const result = grantDiagnostics({ data: { ...data, [key]: sensitive } }, { appId: '101', wabaId: '301' }, Date.now());
    assert(result.length <= 40); assert(!JSON.stringify(result).includes(sensitive));
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
test('Optional event grant failures and unexpected granular permissions are classified without provider values', () => {
  for (const [targets, classification] of [[undefined, 'untargeted'], [[], 'empty'], [['301','301'], 'duplicate'],
    [Array.from({length: 65}, (_, i) => String(301+i)), 'oversized'], [['301'], 'exact']]) {
    const data = { scopes: ['whatsapp_business_management','whatsapp_business_messaging','whatsapp_business_manage_events'],
      granular_scopes: [{scope:'whatsapp_business_management',target_ids:['301']},
        {scope:'whatsapp_business_messaging',target_ids:['301']},
        {scope:'whatsapp_business_manage_events',target_ids:targets}] };
    const result = grantDiagnostics({data}, {appId:'101',wabaId:'301'}, Date.now());
    assert(result.includes('wa_grant_granular_events_'+classification));
    data.granular_scopes.push({scope:'FICTITIOUS_PRIVATE_SCOPE'});
    const unknown = grantDiagnostics({data}, {appId:'101',wabaId:'301'}, Date.now());
    assert(unknown.includes('wa_grant_granular_unknown_present'));
    assert(!JSON.stringify(unknown).includes('FICTITIOUS'));
  }
});
test('Multi-asset grant diagnostics identify the selected WABA and known extra permission without accepting it', () => {
  const { verifyWhatsappGrant } = require('../src/whatsapp-credential-inspector');
  const scopes = ['whatsapp_business_management', 'whatsapp_business_messaging'];
  const expected = { appId: '101', subjectId: '201', wabaId: '301', scopes };
  const data = { is_valid: true, type: 'SYSTEM_USER', app_id: '101', user_id: '201', expires_at: 0, data_access_expires_at: 0,
    scopes: [...scopes, 'public_profile', 'business_management', 'FICTITIOUS_PRIVATE_SCOPE'],
    granular_scopes: scopes.map(scope => ({ scope, target_ids: ['301', '302'] })) };
  const result = grantDiagnostics({ data }, expected, Date.now());
  assert(result.includes('wa_grant_selected_management_present'));
  assert(result.includes('wa_grant_selected_messaging_present'));
  assert(result.includes('wa_grant_extra_business_management_present'));
  assert(!result.includes('wa_grant_extra_ads_management_present'));
  assert(result.includes('wa_grant_extra_other_present'));
  assert(!JSON.stringify(result).includes('FICTITIOUS_PRIVATE_SCOPE'));
  assert.throws(() => verifyWhatsappGrant({ data }, expected), { code: 'oauth_credentials_incomplete' });
  const onlyWhatsapp = { ...data, scopes };
  assert.throws(() => verifyWhatsappGrant({ data: onlyWhatsapp }, expected), { code: 'scope_denied' });
  const foreign = { ...data, granular_scopes: scopes.map(scope => ({ scope, target_ids: ['302', '303'] })) };
  assert(grantDiagnostics({ data: foreign }, expected).includes('wa_grant_selected_management_absent'));
  const duplicate = { ...data, granular_scopes: scopes.map(scope => ({ scope, target_ids: ['301', '301'] })) };
  assert(grantDiagnostics({ data: duplicate }, expected).includes('wa_grant_granular_management_duplicate'));
});
