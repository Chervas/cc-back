'use strict';
// Synthetic provider metadata only: no real identifiers, credentials or I/O.
const C = require('../src/whatsapp-onboarding-contract');
const WA_SCOPES = Object.freeze(['public_profile','whatsapp_business_manage_events','whatsapp_business_management','whatsapp_business_messaging']);
function broaden(response) {
  const value = structuredClone(response);
  value.data.scopes = [...value.data.scopes, ...C.COMPANION_SCOPES].sort();
  const events = value.data.granular_scopes.find(row => row.scope === 'whatsapp_business_manage_events');
  if (events) delete events.target_ids;
  C.COMPANION_SCOPES.forEach((scope, index) => value.data.granular_scopes.push({ scope, target_ids: [String(801 + index)] }));
  return value;
}
function fixture() {
  const expected = { appId: '101', selectedWabaId: '301', scopes: [...WA_SCOPES], selectionOnly: true,
    providerGrantPolicy: C.PROVIDER_GRANT_POLICY };
  const response = broaden({ data: { is_valid: true, app_id: '101', user_id: '201', type: 'SYSTEM_USER',
    scopes: [...WA_SCOPES], expires_at: 0, data_access_expires_at: 0,
    granular_scopes: WA_SCOPES.filter(scope => scope !== 'public_profile').map(scope => ({ scope, target_ids: ['301','302'] })) } });
  return { expected, response, token: Buffer.from('FICTITIOUS_COMPANION_TOKEN'), proof: 'a'.repeat(64) };
}
module.exports = { WA_SCOPES, broaden, fixture };
