'use strict';
// Bounded classifications for a rejected provider response. Never return its
// values, identifiers, names, tokens, arbitrary keys or error text.
const id = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
// Fixed names only. Unrecognized provider strings never enter audit output.
const extraScopes = Object.freeze(['business_management', 'ads_management', 'ads_read', 'leads_retrieval',
  'pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_ads',
  'pages_messaging', 'pages_read_user_content', 'pages_manage_engagement', 'instagram_basic',
  'instagram_manage_messages', 'instagram_manage_insights', 'instagram_manage_comments', 'instagram_content_publish',
  'email', 'whatsapp_business_manage_events', 'catalog_management']);
function grantDiagnostics(response, expected, now) {
  const data = response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['wa_grant_data_invalid'];
  const scopes = data.scopes;
  const scopeShape = Array.isArray(scopes) && scopes.length <= 128 && scopes.every(s => typeof s === 'string') && new Set(scopes).size === scopes.length;
  const has = scope => scopeShape && scopes.includes(scope);
  const required = ['whatsapp_business_management', 'whatsapp_business_messaging'];
  const granular = data.granular_scopes;
  const granularShape = Array.isArray(granular) && granular.length <= 128 && granular.every(r => r && typeof r === 'object' && !Array.isArray(r))
    && new Set(granular.map(r => r.scope)).size === granular.length;
  const target = scope => {
    if (!granularShape) return 'invalid';
    const entry = granular.find(r => r.scope === scope);
    if (!entry) return 'missing';
    if (!Array.isArray(entry.target_ids) || entry.target_ids.some(v => !id(v))) return 'invalid';
    if (entry.target_ids.length === 0) return 'empty';
    if (new Set(entry.target_ids).size !== entry.target_ids.length) return 'duplicate';
    if (entry.target_ids.length !== 1) return 'multiple';
    return entry.target_ids[0] === expected.wabaId ? 'exact' : 'foreign';
  };
  const selected = scope => {
    if (!granularShape) return 'unknown';
    const targets = granular.find(r => r.scope === scope)?.target_ids;
    if (!Array.isArray(targets) || targets.some(v => !id(v))) return 'unknown';
    return targets.includes(expected.wabaId) ? 'present' : 'absent';
  };
  const expiry = value => value === undefined ? 'missing'
    : !Number.isSafeInteger(value) || value < 0 || value > Math.floor(Number.MAX_SAFE_INTEGER / 1000) ? 'invalid'
      : value === 0 ? 'zero' : value * 1000 <= now ? 'expired' : 'future';
  const values = {
    provider_error: response.error ? 'present' : 'absent',
    valid: data.is_valid === true ? 'yes' : data.is_valid === false ? 'no' : 'missing',
    app: data.app_id === expected.appId ? 'match' : data.app_id === undefined ? 'missing' : 'mismatch',
    subject: id(data.user_id) ? 'valid' : data.user_id === undefined ? 'missing' : 'invalid',
    type: data.type === 'SYSTEM_USER' ? 'system_user' : data.type === 'USER' ? 'user' : data.type === undefined ? 'missing' : 'other',
    scope_shape: scopeShape ? 'valid' : 'invalid',
    scope_management: has(required[0]) ? 'present' : 'missing',
    scope_messaging: has(required[1]) ? 'present' : 'missing',
    scope_profile: has('public_profile') ? 'present' : 'absent',
    scope_other: scopeShape && scopes.some(s => ![...required, 'public_profile'].includes(s)) ? 'present' : 'absent',
    granular_shape: granularShape ? 'valid' : 'invalid',
    granular_management: target(required[0]), granular_messaging: target(required[1]),
    granular_other: granularShape && granular.some(r => !required.includes(r.scope)) ? 'present' : 'absent',
    expiry: expiry(data.expires_at), data_expiry: expiry(data.data_access_expires_at),
    exchange_expiry: expected.exchangeExpiresAt == null ? 'unspecified'
      : expiry(data.expires_at) === 'future' && data.expires_at * 1000 <= expected.exchangeExpiresAt ? 'consistent' : 'conflict',
    selected_management: selected(required[0]), selected_messaging: selected(required[1]),
    extra_other: !scopeShape ? 'unknown'
      : scopes.some(s => ![...required, 'public_profile', ...extraScopes].includes(s)) ? 'present' : 'absent',
  };
  return [...Object.entries(values).map(([key, value]) => 'wa_grant_' + key + '_' + value),
    ...extraScopes.filter(has).map(scope => 'wa_grant_extra_' + scope + '_present')];
}
module.exports = { grantDiagnostics };
